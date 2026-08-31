import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $ = id => document.getElementById(id);
const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/messier.json';
const NAMES_URL = 'https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/dsonames.json';
const STEP_MINUTES = 5;
const SEARCH_DAYS = 30;

const TYPE_NAMES = {
  g:'Galassia', s:'Galassia spirale', s0:'Galassia lenticolare', sd:'Galassia nana',
  i:'Galassia irregolare', e:'Galassia ellittica', oc:'Ammasso aperto', gc:'Ammasso globulare',
  dn:'Nebulosa oscura', bn:'Nebulosa brillante', sfr:'Regione di formazione stellare',
  rn:'Nebulosa a riflessione', en:'Nebulosa a emissione', pn:'Nebulosa planetaria',
  snr:'Resto di supernova', ds:'Stella doppia', as:'Asterismo', mw:'Nube della Via Lattea',
  pos:'Oggetto / campo stellare'
};

let catalog = [];
let rows = [];

const pad = n => String(n).padStart(2,'0');
const localDateString = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDaysLocal = (d,n) => new Date(d.getFullYear(),d.getMonth(),d.getDate()+n,d.getHours(),d.getMinutes(),d.getSeconds(),0);
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const durationText = minutes => minutes <= 0 ? '—' : `${Math.floor(minutes/60)}h ${pad(Math.round(minutes%60))}m`;

const now = new Date();
const lastDay = addDaysLocal(now, SEARCH_DAYS - 1);
$('date').min = localDateString(now);
$('date').max = localDateString(lastDay);
$('date').value = localDateString(now);

$('geoButton').addEventListener('click', () => {
  if (!navigator.geolocation) return showMessage('Geolocalizzazione non disponibile in questo browser.');
  navigator.geolocation.getCurrentPosition(p => {
    $('latitude').value = p.coords.latitude.toFixed(5);
    $('longitude').value = p.coords.longitude.toFixed(5);
    if (Number.isFinite(p.coords.altitude)) $('elevation').value = Math.round(p.coords.altitude);
    hideMessage();
  }, () => showMessage('Posizione non acquisita. Inserisci manualmente le coordinate.'));
});

$('calculateButton').addEventListener('click', calculate);
$('todayButton').addEventListener('click', () => {
  $('date').value = localDateString(new Date());
  calculate();
});
$('search').addEventListener('input', () => rows.length && renderTable());
$('usefulOnly').addEventListener('change', () => rows.length && renderTable());

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

function selectedNightStart(){
  const value = $('date').value;
  if (!value) return null;
  const [year,month,day] = value.split('-').map(Number);
  return new Date(year, month-1, day, 12, 0, 0, 0);
}

function formatEvent(date,start){
  if (!date) return '—';
  const nextDay = localDateString(date) !== localDateString(start);
  return `${clock(date)}${nextDay ? ' (+1)' : ''}`;
}

function raFromGeoJsonLongitude(lon){
  const degrees = lon < 0 ? lon + 360 : lon;
  return degrees / 15;
}

function vectorJ2000(raHours,decDegrees,date){
  const rad = Math.PI/180;
  const ra = raHours * 15 * rad;
  const dec = decDegrees * rad;
  const cosDec = Math.cos(dec);
  return new Astronomy.Vector(
    cosDec*Math.cos(ra),
    cosDec*Math.sin(ra),
    Math.sin(dec),
    new Astronomy.AstroTime(date)
  );
}

function objectAltitude(object,date,observer){
  const rotation = Astronomy.Rotation_EQJ_HOR(date,observer);
  const horizontal = Astronomy.RotateVector(rotation,vectorJ2000(object.ra,object.dec,date));
  return Astronomy.HorizonFromVector(horizontal,null).lat;
}

function sunAltitude(date,observer){
  const eq = Astronomy.Equator(Astronomy.Body.Sun,date,observer,true,true);
  return Astronomy.Horizon(date,observer,eq.ra,eq.dec,'normal').altitude;
}

function interpolateCrossing(a,b,target){
  const y1 = a.alt-target;
  const y2 = b.alt-target;
  const fraction = Math.abs(y2-y1) < 1e-12 ? 0.5 : (-y1)/(y2-y1);
  const bounded = Math.max(0,Math.min(1,fraction));
  return new Date(a.time.getTime()+bounded*(b.time-a.time));
}

function analyzeObject(object,start,end,observer,sunSamples){
  const samples = sunSamples.map(s => {
    const alt = objectAltitude(object,s.time,observer);
    return {time:s.time,alt,sunAlt:s.sunAlt,above:alt>0,useful:alt>10 && s.sunAlt<-18};
  });

  const minAlt = Math.min(...samples.map(x=>x.alt));
  const maxAlt = Math.max(...samples.map(x=>x.alt));
  const circumpolar = minAlt > 0;
  const neverRises = maxAlt <= 0;
  let rise = null;
  let set = null;

  if (!circumpolar && !neverRises) {
    for (let i=1;i<samples.length;i++) {
      if (!samples[i-1].above && samples[i].above && !rise) rise = interpolateCrossing(samples[i-1],samples[i],0);
      if (samples[i-1].above && !samples[i].above && !set) set = interpolateCrossing(samples[i-1],samples[i],0);
    }
  }

  let maxIndex = 0;
  for (let i=1;i<samples.length;i++) if (samples[i].alt > samples[maxIndex].alt) maxIndex = i;
  const culmination = samples[maxIndex];

  let usefulMinutes = 0;
  for (let i=1;i<samples.length;i++) {
    if (samples[i-1].useful && samples[i].useful) usefulMinutes += STEP_MINUTES;
    else if (samples[i-1].useful !== samples[i].useful) usefulMinutes += STEP_MINUTES/2;
  }

  return {
    ...object,
    geometricVisible: !neverRises,
    usefulVisible: usefulMinutes > 0,
    circumpolar,
    riseText: circumpolar ? 'Circumpolare' : neverRises ? 'Non sorge' : formatEvent(rise,start),
    setText: circumpolar ? 'Circumpolare' : neverRises ? 'Non tramonta' : formatEvent(set,start),
    culminationText: formatEvent(culmination.time,start),
    maxAltitude: culmination.alt,
    usefulMinutes
  };
}

function extractCatalog(data,names){
  const result = [];
  for (const feature of data.features || []) {
    const properties = feature.properties || {};
    const messierId = String(feature.id || properties.name || '');
    const match = messierId.match(/^M\s*0*([0-9]{1,3})$/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (number < 1 || number > 110) continue;

    const lon = Number(feature.geometry?.coordinates?.[0]);
    const dec = Number(feature.geometry?.coordinates?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(dec)) continue;

    const designation = String(properties.desig || '').trim();
    const translated = designation && names[designation] ? names[designation] : {};
    const commonName = translated.it || properties.alt || translated.name || '';

    result.push({
      number,
      id:`M${number}`,
      designation,
      name:commonName,
      type:TYPE_NAMES[String(properties.type || '').toLowerCase()] || String(properties.type || '—'),
      magnitude:Number(properties.mag),
      ra:raFromGeoJsonLongitude(lon),
      dec
    });
  }
  result.sort((a,b)=>a.number-b.number);
  return result;
}

function nameCell(row){
  const primary = row.name || row.designation || row.id;
  const secondary = row.designation && row.designation !== primary ? row.designation : '';
  return `<strong>${escapeHtml(primary)}</strong>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ''}`;
}

function renderTable(){
  const query = $('search').value.trim().toLowerCase();
  const usefulOnly = $('usefulOnly').checked;
  const visibleRows = rows.filter(row => {
    const haystack = `${row.id} ${row.designation} ${row.name} ${row.type}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!usefulOnly || row.usefulVisible);
  });

  $('count').textContent = `${visibleRows.length} / ${rows.length} oggetti`;
  $('tableArea').className = 'messier-table-wrap';
  $('tableArea').innerHTML = `<table class="messier-table">
    <thead><tr>
      <th>Messier</th><th>Nome</th><th>Tipo</th><th>Vis. geom.</th><th>Vis. utile</th>
      <th>Sorge</th><th>Culmina</th><th>Alt. max</th><th>Tramonta</th><th>Durata utile</th>
    </tr></thead>
    <tbody>${visibleRows.map(row => `<tr>
      <td class="messier-number">${row.id}</td>
      <td class="messier-name">${nameCell(row)}</td>
      <td class="messier-type">${escapeHtml(row.type)}${Number.isFinite(row.magnitude) ? `<small>mag ${row.magnitude.toFixed(1)}</small>` : ''}</td>
      <td><span class="${row.geometricVisible?'messier-yes':'messier-no'}">${row.geometricVisible?'SÌ':'NO'}</span></td>
      <td><span class="${row.usefulVisible?'messier-yes':'messier-no'}">${row.usefulVisible?'SÌ':'NO'}</span></td>
      <td class="messier-time">${row.riseText}</td>
      <td class="messier-time">${row.culminationText}</td>
      <td class="messier-time">${row.maxAltitude.toFixed(1)}°</td>
      <td class="messier-time">${row.setText}</td>
      <td class="messier-time">${durationText(row.usefulMinutes)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function calculate(){
  const observer = readObserver();
  const start = selectedNightStart();
  if (!observer || !start) return showMessage('Seleziona una data valida.');
  hideMessage();
  const end = addDaysLocal(start,1);
  $('calculateButton').disabled = true;
  $('tableArea').className = 'messier-loading';
  $('tableArea').textContent = 'Calcolo di M1–M110…';
  $('summary').classList.add('hidden');

  try {
    const sunSamples = [];
    for (let time=start.getTime();time<=end.getTime();time+=STEP_MINUTES*60000) {
      const date = new Date(time);
      sunSamples.push({time:date,sunAlt:sunAltitude(date,observer)});
    }

    rows = [];
    for (let i=0;i<catalog.length;i++) {
      rows.push(analyzeObject(catalog[i],start,end,observer,sunSamples));
      if (i % 10 === 0) {
        $('tableArea').textContent = `Calcolo ${Math.min(i+1,110)}/110…`;
        await breathe();
      }
    }

    const usefulCount = rows.filter(x=>x.usefulVisible).length;
    const circumpolarCount = rows.filter(x=>x.circumpolar).length;
    $('summary').classList.remove('hidden');
    $('summary').innerHTML = `<span><strong>${rows.length}</strong> oggetti</span><span><strong>${usefulCount}</strong> con visibilità utile</span><span><strong>${circumpolarCount}</strong> circumpolari</span><span>Risoluzione: <strong>${STEP_MINUTES} min</strong></span>`;
    renderTable();
  } catch (error) {
    $('tableArea').className = 'messier-error';
    $('tableArea').textContent = `Errore di calcolo: ${error.message}`;
  } finally {
    $('calculateButton').disabled = false;
  }
}

async function loadCatalog(){
  try {
    const catalogResponse = await fetch(CATALOG_URL);
    if (!catalogResponse.ok) throw new Error(`catalogo non disponibile (${catalogResponse.status})`);
    const data = await catalogResponse.json();

    let names = {};
    try {
      const namesResponse = await fetch(NAMES_URL);
      if (namesResponse.ok) names = await namesResponse.json();
    } catch {
      names = {};
    }

    catalog = extractCatalog(data,names);
    if (catalog.length !== 110) throw new Error(`riconosciuti ${catalog.length} oggetti invece di 110`);
    await calculate();
  } catch (error) {
    $('tableArea').className = 'messier-error';
    $('tableArea').textContent = `Impossibile caricare il catalogo Messier: ${error.message}`;
  }
}

function escapeHtml(value){
  return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function showMessage(text){$('message').textContent=text;$('message').classList.remove('hidden');}
function hideMessage(){$('message').classList.add('hidden');}
function breathe(){return new Promise(resolve=>setTimeout(resolve,0));}

loadCatalog();
