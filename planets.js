import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $ = id => document.getElementById(id);
const STEP_MINUTES = 5;
const SEARCH_DAYS = 30;
const JUPITER_RADIUS_AU = 71492 / 149597870.7;

const planets = [
  {key:'Jupiter', label:'Giove', body:Astronomy.Body.Jupiter, opposition:true},
  {key:'Venus', label:'Venere', body:Astronomy.Body.Venus, opposition:false},
  {key:'Mars', label:'Marte', body:Astronomy.Body.Mars, opposition:true},
  {key:'Saturn', label:'Saturno', body:Astronomy.Body.Saturn, opposition:true}
];

const pad = n => String(n).padStart(2,'0');
const dateInput = $('date');
const now = new Date();
const lastDay = addDays(now, SEARCH_DAYS - 1);
dateInput.min = localDateString(now);
dateInput.max = localDateString(lastDay);
dateInput.value = localDateString(now);

$('geoButton').addEventListener('click', () => {
  if (!navigator.geolocation) return showMessage('Geolocalizzazione non disponibile in questo browser.');
  navigator.geolocation.getCurrentPosition(p => {
    $('latitude').value = p.coords.latitude.toFixed(5);
    $('longitude').value = p.coords.longitude.toFixed(5);
    if (Number.isFinite(p.coords.altitude)) $('elevation').value = Math.round(p.coords.altitude);
    hideMessage();
  }, () => showMessage('Posizione non acquisita. Inserisci manualmente le coordinate.'));
});

$('calculateButton').addEventListener('click', renderAll);
$('todayButton').addEventListener('click', () => {
  dateInput.value = localDateString(new Date());
  renderAll();
});
$('jupiterUpdate').addEventListener('click', () => {
  const value = $('jupiterTime').value;
  if (value) renderJupiter(new Date(value));
});

function readObserver(){
  const lat = Number($('latitude').value);
  const lon = Number($('longitude').value);
  const height = Number($('elevation').value);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(height)) {
    showMessage('Controlla latitudine, longitudine e quota.');
    return null;
  }
  return new Astronomy.Observer(lat, lon, height);
}

async function renderAll(){
  const obs = readObserver();
  if (!obs) return;
  const day = dateFromLocalString(dateInput.value);
  if (!day) return showMessage('Seleziona una data valida.');
  hideMessage();
  $('calculateButton').disabled = true;
  $('planetCards').className = 'planet-loading';
  $('planetCards').textContent = 'Calcolo della visibilità giornaliera…';
  $('summary30').className = 'planet-loading';
  $('summary30').textContent = 'Calcolo della panoramica dei prossimi 30 giorni…';
  try {
    await breathe();
    $('planetCards').className = 'planet-grid';
    $('planetCards').innerHTML = planets.map(p => planetCard(p, day, obs)).join('');
    await breathe();
    const summary = [];
    for (const planet of planets) {
      summary.push(calculate30Days(planet, day, obs));
      await breathe();
    }
    $('summary30').className = 'planet-summary';
    $('summary30').innerHTML = summary.map(summaryCard).join('');
    const jupiterBest = bestUseful(sampleDay(Astronomy.Body.Jupiter, day, obs));
    const jupiterDate = jupiterBest ? jupiterBest.time : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 22, 0, 0, 0);
    $('jupiterTime').value = localDateTimeString(jupiterDate);
    renderJupiter(jupiterDate);
  } catch (error) {
    $('planetCards').className = 'planet-error';
    $('planetCards').textContent = `Errore di calcolo: ${error.message || error}`;
  } finally {
    $('calculateButton').disabled = false;
  }
}

function altitude(body, date, obs){
  const eq = Astronomy.Equator(body, date, obs, true, true);
  return Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal').altitude;
}

function sampleDay(body, day, obs){
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const samples = [];
  for (let minute=0; minute<=1440; minute+=STEP_MINUTES) {
    const time = new Date(start.getTime() + minute*60000);
    const planetAlt = altitude(body, time, obs);
    const sunAlt = altitude(Astronomy.Body.Sun, time, obs);
    samples.push({
      time,
      planetAlt,
      sunAlt,
      above: planetAlt > 0,
      useful: planetAlt > 10 && sunAlt < -6
    });
  }
  return samples;
}

function ranges(samples, property){
  const output = [];
  let start = null;
  let last = null;
  for (const sample of samples) {
    if (sample[property] && start === null) start = sample.time;
    if (!sample[property] && start !== null) {
      output.push([start, last || sample.time]);
      start = null;
    }
    if (sample[property]) last = sample.time;
  }
  if (start !== null) output.push([start, last]);
  return output;
}

function bestUseful(samples){
  const useful = samples.filter(s => s.useful);
  if (!useful.length) return null;
  return useful.reduce((best, sample) => sample.planetAlt > best.planetAlt ? sample : best);
}

function rangesText(list){
  if (!list.length) return 'Nessuna';
  return list.map(([from,to]) => `${formatTime(from)}–${formatTime(to)}`).join(' · ');
}

function eventInfo(planet, startDate){
  if (!planet.opposition) {
    const event = Astronomy.SearchMaxElongation(Astronomy.Body.Venus, startDate);
    const visibility = String(event.visibility || '').toLowerCase().includes('morning') ? 'mattutina' : 'serale';
    return {
      title:'Opposizione',
      value:'Non applicabile',
      note:`Prossima massima elongazione: ${formatDateTime(event.time.date)} · ${event.elongation.toFixed(1)}° · ${visibility}`
    };
  }
  const event = Astronomy.SearchRelativeLongitude(planet.body, 0, startDate);
  return {
    title:'Prossima opposizione',
    value:formatDateTime(event.date),
    note:'Istante astronomico calcolato'
  };
}

function planetCard(planet, day, obs){
  const samples = sampleDay(planet.body, day, obs);
  const above = ranges(samples, 'above');
  const useful = ranges(samples, 'useful');
  const best = bestUseful(samples);
  const event = eventInfo(planet, day);
  return `<article class="planet-card">
    <div class="planet-head">
      <h3>${planet.label}</h3>
      <span class="planet-status ${useful.length ? 'good' : 'bad'}">${useful.length ? 'OSSERVABILE' : 'NESSUNA FINESTRA UTILE'}</span>
    </div>
    <div class="planet-metrics">
      <div class="planet-metric wide"><span>Sopra l’orizzonte (&gt;0°)</span><strong>${rangesText(above)}</strong></div>
      <div class="planet-metric wide"><span>Finestra osservativa utile</span><strong>${rangesText(useful)}</strong></div>
      <div class="planet-metric"><span>Massima altezza utile</span><strong>${best ? best.planetAlt.toFixed(1)+'°' : '—'}</strong></div>
      <div class="planet-metric"><span>Ora massima altezza</span><strong>${best ? formatTime(best.time) : '—'}</strong></div>
      <div class="planet-metric wide"><span>${event.title}</span><strong>${event.value}</strong><div class="planet-note">${event.note}</div></div>
    </div>
  </article>`;
}

function calculate30Days(planet, startDay, obs){
  let usefulDays = 0;
  let best = null;
  for (let i=0; i<SEARCH_DAYS; i++) {
    const day = addDays(startDay, i);
    const dailyBest = bestUseful(sampleDay(planet.body, day, obs));
    if (dailyBest) {
      usefulDays++;
      if (!best || dailyBest.planetAlt > best.planetAlt) best = {...dailyBest, day};
    }
  }
  return {planet, usefulDays, best};
}

function summaryCard(item){
  const detail = item.best
    ? `Picco: ${item.best.planetAlt.toFixed(1)}° il ${item.best.day.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit'})} alle ${formatTime(item.best.time)}`
    : 'Nessuna finestra secondo il criterio adottato';
  return `<div class="planet-summary-item"><span>${item.planet.label}</span><strong>${item.usefulDays}/30 giorni utili</strong><div class="planet-note">${detail}</div></div>`;
}

function renderJupiter(date){
  try {
    const info = Astronomy.JupiterMoons(date);
    const jupiterVector = Astronomy.GeoVector(Astronomy.Body.Jupiter, date, true);
    const rightAscension = Math.atan2(jupiterVector.y, jupiterVector.x);
    const east = {x:-Math.sin(rightAscension), y:Math.cos(rightAscension), z:0};
    const moons = [
      ['Io', info.io],
      ['Europa', info.europa],
      ['Ganimede', info.ganymede],
      ['Callisto', info.callisto]
    ].map(([name, vector]) => ({
      name,
      eastRj:(vector.x*east.x + vector.y*east.y + vector.z*east.z) / JUPITER_RADIUS_AU
    }));
    const percentPerRj = 44/30;
    const dots = moons.map(moon => {
      const left = Math.max(4, Math.min(96, 50 - moon.eastRj*percentPerRj));
      return `<div class="jupiter-moon" style="left:${left}%"><span>${moon.name}</span></div>`;
    }).join('');
    $('jupiterMoons').className = 'jupiter-wrap';
    $('jupiterMoons').innerHTML = `<div class="jupiter-chart">
      <div class="jupiter-axis"></div>
      <div class="jupiter-direction jupiter-east">E</div>
      <div class="jupiter-direction jupiter-west">O</div>
      <div class="jupiter-disc" title="Giove"></div>${dots}
    </div>
    <div class="jupiter-side">
      <div class="planet-metric"><span>Istante rappresentato</span><strong>${formatDateTime(date)}</strong></div>
      <div class="jupiter-legend">${moons.map(m => `<div><b>${m.name}</b><br>${Math.abs(m.eastRj).toFixed(1)} Rj ${m.eastRj >= 0 ? 'E' : 'O'}</div>`).join('')}</div>
      <div class="planet-note">Schema geometrico della disposizione Est–Ovest sul cielo, ricavato dalle posizioni jovicentriche delle quattro lune galileiane. Non simula rotazione o eventuale specchiatura dell’immagine del DWARF 3.</div>
    </div>`;
  } catch (error) {
    $('jupiterMoons').className = 'planet-error';
    $('jupiterMoons').textContent = `Errore nel calcolo delle lune di Giove: ${error.message || error}`;
  }
}

function addDays(date, days){
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()+days, date.getHours(), date.getMinutes(), 0, 0);
}
function localDateString(date){
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}
function localDateTimeString(date){
  return `${localDateString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function dateFromLocalString(value){
  if (!value) return null;
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(x => !Number.isFinite(x))) return null;
  return new Date(parts[0], parts[1]-1, parts[2], 0, 0, 0, 0);
}
function formatTime(date){
  return date.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
}
function formatDateTime(date){
  return date.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
}
function breathe(){
  return new Promise(resolve => setTimeout(resolve,0));
}
function showMessage(text){
  $('message').textContent = text;
  $('message').classList.remove('hidden');
}
function hideMessage(){
  $('message').classList.add('hidden');
}

renderAll();
