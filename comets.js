import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $ = id => document.getElementById(id);
const DATA_URL = './data/comets.json';
const SEARCH_DAYS = 30;
const STEP_MINUTES = 15;
const MAG_LIMIT = 12;
const ALT_LIMIT = 20;
const MIN_WINDOW_MINUTES = 20;
const GAUSSIAN_K = 0.01720209895;   // rad/day, Gaussian gravitational constant

let cometCatalog = [];
let cacheMeta = null;
let running = false;
let renderedWindows = [];
let lastFocusedElement = null;

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
$('results').addEventListener('click', event => {
  const button = event.target.closest('[data-comet-settings]');
  if (!button) return;
  const index = Number(button.dataset.cometSettings);
  const entry = renderedWindows[index];
  if (entry) openCometSettingsModal(entry,button);
});
$('cometSettingsClose').addEventListener('click', closeCometSettingsModal);
$('cometSettingsModal').addEventListener('click', event => {
  if (event.target.hasAttribute('data-close-comet-modal')) closeCometSettingsModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('cometSettingsModal').classList.contains('hidden')) closeCometSettingsModal();
});

function readObserver(){
  const lat = Number($('latitude').value);
  const lon = Number($('longitude').value);
  const elevation = Number($('elevation').value);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(elevation)) {
    showMessage('Controlla latitudine, longitudine e quota.');
    return null;
  }
  return new Astronomy.Observer(lat, lon, elevation);
}

function julianDate(date){
  return date.getTime()/86400000 + 2440587.5;
}

function normAngleRad(x){
  const tau = 2*Math.PI;
  x %= tau;
  if (x > Math.PI) x -= tau;
  if (x < -Math.PI) x += tau;
  return x;
}

function solveElliptic(M,e){
  M = normAngleRad(M);
  let E = e < 0.8 ? M : Math.sign(M || 1)*Math.PI;
  for (let n=0;n<30;n++) {
    const f = E - e*Math.sin(E) - M;
    const fp = 1 - e*Math.cos(E);
    const d = f/fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

function solveHyperbolic(M,e){
  let H = Math.asinh(M/Math.max(e,1.000001));
  for (let n=0;n<40;n++) {
    const f = e*Math.sinh(H) - H - M;
    const fp = e*Math.cosh(H) - 1;
    const d = f/fp;
    H -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return H;
}

function solveParabolic(B){
  let D = Math.cbrt(3*B);
  if (!Number.isFinite(D)) D = 0;
  for (let n=0;n<30;n++) {
    const f = D + D*D*D/3 - B;
    const fp = 1 + D*D;
    const d = f/fp;
    D -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return D;
}

function cometHeliocentricEcliptic(comet,date){
  const dt = julianDate(date) - comet.tp;
  const e = comet.e;
  const q = comet.q;
  let r, nu;

  if (e < 0.999999) {
    const a = q/(1-e);
    if (!(a > 0)) return null;
    const M = GAUSSIAN_K*dt/Math.pow(a,1.5);
    const E = solveElliptic(M,e);
    r = a*(1-e*Math.cos(E));
    nu = 2*Math.atan2(Math.sqrt(1+e)*Math.sin(E/2), Math.sqrt(1-e)*Math.cos(E/2));
  } else if (e > 1.000001) {
    const a = q/(e-1);
    if (!(a > 0)) return null;
    const M = GAUSSIAN_K*dt/Math.pow(a,1.5);
    const H = solveHyperbolic(M,e);
    r = a*(e*Math.cosh(H)-1);
    const factor = Math.sqrt((e+1)/(e-1));
    nu = 2*Math.atan(factor*Math.tanh(H/2));
  } else {
    const B = GAUSSIAN_K*dt/(Math.sqrt(2)*Math.pow(q,1.5));
    const D = solveParabolic(B);
    nu = 2*Math.atan(D);
    r = q*(1+D*D);
  }

  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(nu)) return null;

  const rad = Math.PI/180;
  const O = comet.om*rad;
  const wv = comet.w*rad + nu;
  const inc = comet.i*rad;
  const cO=Math.cos(O), sO=Math.sin(O), cw=Math.cos(wv), sw=Math.sin(wv), ci=Math.cos(inc), si=Math.sin(inc);
  return {
    x:r*(cO*cw - sO*sw*ci),
    y:r*(sO*cw + cO*sw*ci),
    z:r*(sw*si),
    r
  };
}

function subtractVectors(a,b,date){
  return new Astronomy.Vector(a.x-b.x,a.y-b.y,a.z-b.z,new Astronomy.AstroTime(date));
}

function vectorLength(v){
  return Math.hypot(v.x,v.y,v.z);
}

function angularSeparation(v1,v2){
  const n1=vectorLength(v1), n2=vectorLength(v2);
  if (!(n1>0) || !(n2>0)) return 180;
  const c=(v1.x*v2.x+v1.y*v2.y+v1.z*v2.z)/(n1*n2);
  return Math.acos(Math.max(-1,Math.min(1,c)))*180/Math.PI;
}

function cometTopocentric(comet,date,observer){
  const helioEcl = cometHeliocentricEcliptic(comet,date);
  if (!helioEcl) return null;

  const eclVector = new Astronomy.Vector(helioEcl.x,helioEcl.y,helioEcl.z,new Astronomy.AstroTime(date));
  const helioEqj = Astronomy.RotateVector(Astronomy.Rotation_ECL_EQJ(),eclVector);
  const earth = Astronomy.HelioVector(Astronomy.Body.Earth,date);
  const geocentric = subtractVectors(helioEqj,earth,date);
  const observerVector = Astronomy.ObserverVector(date,observer,false);
  const topocentric = subtractVectors(geocentric,observerVector,date);
  const horizontalVector = Astronomy.RotateVector(Astronomy.Rotation_EQJ_HOR(date,observer),topocentric);
  const horizontal = Astronomy.HorizonFromVector(horizontalVector,null);
  const azimuth = (Math.atan2(-horizontalVector.y,horizontalVector.x)*180/Math.PI + 360)%360;
  const delta = vectorLength(topocentric);
  const predictedMag = comet.M1 + 5*Math.log10(delta) + comet.K1*Math.log10(helioEcl.r);

  return {topocentric,altitude:horizontal.lat,azimuth,delta,r:helioEcl.r,predictedMag,observerVector};
}

function sunAltitude(date,observer){
  const eq = Astronomy.Equator(Astronomy.Body.Sun,date,observer,true,true);
  return Astronomy.Horizon(date,observer,eq.ra,eq.dec,'normal').altitude;
}

function moonContext(date,observer,cometVector,observerVector){
  const moonGeo = Astronomy.GeoMoon(date);
  const moonTopo = subtractVectors(moonGeo,observerVector,date);
  const moonHorVec = Astronomy.RotateVector(Astronomy.Rotation_EQJ_HOR(date,observer),moonTopo);
  const moonHor = Astronomy.HorizonFromVector(moonHorVec,null);
  const illumination = Astronomy.Illumination(Astronomy.Body.Moon,date).phase_fraction*100;
  return {
    altitude:moonHor.lat,
    separation:angularSeparation(cometVector,moonTopo),
    illumination
  };
}

function samplePoint(comet,date,observer){
  if (sunAltitude(date,observer) >= -18) return null;
  const c = cometTopocentric(comet,date,observer);
  if (!c || !Number.isFinite(c.predictedMag) || c.predictedMag > MAG_LIMIT || c.altitude < ALT_LIMIT) return null;
  const moon = moonContext(date,observer,c.topocentric,c.observerVector);
  const moonPenalty = moon.altitude <= 0 ? 0 : (moon.illumination/100)*Math.max(0,(90-moon.separation)/90)*30;
  const score = c.altitude*1.15 + (MAG_LIMIT-c.predictedMag)*8 - moonPenalty;
  return {...c,date,moon,score};
}

function nightStart(baseDay,offset){
  return new Date(baseDay.getFullYear(),baseDay.getMonth(),baseDay.getDate()+offset,12,0,0,0);
}

function bestWindowForNight(comet,start,observer){
  const end = new Date(start.getTime()+24*3600000);
  const segments=[];
  let current=[];

  for (let t=start.getTime();t<=end.getTime();t+=STEP_MINUTES*60000) {
    const point = samplePoint(comet,new Date(t),observer);
    if (point) current.push(point);
    else if (current.length) {segments.push(current);current=[];}
  }
  if (current.length) segments.push(current);

  let best=null;
  for (const segment of segments) {
    const duration=segment.length*STEP_MINUTES;
    if (duration < MIN_WINDOW_MINUTES) continue;
    const peak=segment.reduce((a,b)=>b.score>a.score?b:a);
    const candidate={
      peak,
      start:segment[0].date,
      end:new Date(segment[segment.length-1].date.getTime()+STEP_MINUTES*60000),
      duration,
      score:peak.score
    };
    if (!best || candidate.score>best.score) best=candidate;
  }
  return best;
}

function qualityFor(window){
  const p=window.peak, moon=p.moon;
  const moonFriendly=moon.altitude<=0 || moon.illumination<40 || moon.separation>=60;
  if (p.altitude>=30 && p.predictedMag<=10.5 && moonFriendly) return {label:'Buona',className:'good'};
  if (p.altitude>=25 && p.predictedMag<=11.5 && (moon.altitude<=0 || moon.separation>=40 || moon.illumination<60)) return {label:'Discreta',className:'fair'};
  return {label:'Difficile',className:'hard'};
}

function settingsFor(window){
  const possibleFrames=Math.floor(window.duration*60/15);
  const frames=Math.max(75,Math.min(100,possibleFrames));
  return {exposure:15,gain:80,frames,integrationMin:frames*15/60};
}

function pad(n){return String(n).padStart(2,'0');}
function dayText(d){return d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});}
function timeText(d){return `${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function durationText(minutes){return `${Math.floor(minutes/60)}h ${pad(Math.round(minutes%60))}m`;}
function azimuthText(az){
  const dirs=['N','NE','E','SE','S','SO','O','NO'];
  return `${az.toFixed(0)}° ${dirs[Math.round(az/45)%8]}`;
}
function moonText(moon){
  if (moon.altitude<=0) return `<strong>Luna sotto orizzonte</strong><small>fase ${moon.illumination.toFixed(0)}%</small>`;
  return `<strong>${moon.illumination.toFixed(0)}% · sep. ${moon.separation.toFixed(0)}°</strong><small>alt. Luna ${moon.altitude.toFixed(0)}°</small>`;
}
function integrationText(min){return min<60?`${Math.round(min)} min`:`${Math.floor(min/60)}h ${pad(Math.round(min%60))}m`;}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

function renderResults(comets){
  const flat=[];
  for (const item of comets) for (let i=0;i<item.windows.length;i++) flat.push({comet:item.comet,window:item.windows[i],rank:i+1});
  renderedWindows=flat;
  if (!flat.length) {
    $('results').className='comets-empty';
    $('results').innerHTML='<strong>Nessuna cometa soddisfa i criteri selezionati nei prossimi 30 giorni.</strong><br>Questo non significa che non esistano comete osservabili: significa che nessuna candidata della cache supera contemporaneamente magnitudine ≤12, altezza ≥20°, buio astronomico e finestra minima richiesta.';
    return;
  }
  $('results').className='comets-table-wrap';
  $('results').innerHTML=`<table class="comets-table"><thead><tr>
    <th>Cometa</th><th>Giorno</th><th>Ora migliore</th><th>Altezza</th><th>Azimut</th><th>Mag. prev.</th><th>Luna</th><th>Qualità</th><th>Finestra utile</th>
  </tr></thead><tbody>${flat.map(({comet,window,rank},index)=>{
    const p=window.peak,q=qualityFor(window);
    return `<tr>
      <td class="comet-name"><button class="comet-name-button" type="button" data-comet-settings="${index}" aria-label="Apri settaggi DWARF 3 per ${escapeHtml(comet.name||comet.designation)}, finestra ${rank}">${escapeHtml(comet.name||comet.designation)}</button><small>${escapeHtml(comet.designation)} · finestra ${rank}/3</small></td>
      <td class="comet-time">${dayText(p.date)}</td>
      <td class="comet-time">≈ ${timeText(p.date)}</td>
      <td class="comet-number">${p.altitude.toFixed(1)}°</td>
      <td class="comet-number">${azimuthText(p.azimuth)}</td>
      <td class="comet-number">${p.predictedMag.toFixed(1)}</td>
      <td class="comet-moon">${moonText(p.moon)}</td>
      <td><span class="comet-quality ${q.className}">${q.label}</span></td>
      <td class="comet-time">${timeText(window.start)}–${timeText(window.end)}<small style="display:block;color:var(--muted)">${durationText(window.duration)}</small></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function openCometSettingsModal(entry,trigger){
  const {comet,window,rank}=entry;
  const p=window.peak;
  const q=qualityFor(window);
  const s=settingsFor(window);
  const cometName=comet.name||comet.designation;
  const moonSummary=p.moon.altitude<=0
    ? `Luna sotto l’orizzonte · fase ${p.moon.illumination.toFixed(0)}%`
    : `Luna ${p.moon.illumination.toFixed(0)}% · separazione ${p.moon.separation.toFixed(0)}° · alt. ${p.moon.altitude.toFixed(0)}°`;

  $('cometSettingsTitle').textContent=`${cometName} · finestra ${rank}/3`;
  $('cometSettingsBody').innerHTML=`
    <div class="comets-settings-context">
      <span>${dayText(p.date)}</span><span>≈ ${timeText(p.date)}</span><span>alt. ${p.altitude.toFixed(1)}°</span><span>mag. prev. ${p.predictedMag.toFixed(1)}</span><span>${q.label}</span>
    </div>
    <div class="comets-settings-grid">
      <div><span>Modalità</span><strong>Deep Sky · Manual</strong></div>
      <div><span>ISO</span><strong>n/a</strong><small>DWARF 3 utilizza il Gain</small></div>
      <div><span>Esposizione</span><strong>${s.exposure} s</strong></div>
      <div><span>Gain</span><strong>${s.gain}</strong></div>
      <div><span>Numero frame</span><strong>${s.frames}</strong></div>
      <div><span>Integrazione stimata</span><strong>${integrationText(s.integrationMin)}</strong></div>
      <div><span>Finestra utile</span><strong>${timeText(window.start)}–${timeText(window.end)}</strong><small>${durationText(window.duration)}</small></div>
      <div><span>Azimut al picco</span><strong>${azimuthText(p.azimuth)}</strong></div>
      <div><span>Dark frame</span><strong>Coerenti</strong><small>stessa esposizione e Gain; temperatura il più possibile vicina</small></div>
      <div><span>Verifica target</span><strong>Star Atlas</strong><small>ricontrolla posizione e tracking poco prima della ripresa</small></div>
    </div>
    <div class="comets-settings-reason"><strong>Luna:</strong> ${moonSummary}. Il numero di frame è limitato alla specifica finestra osservativa; esposizione e Gain restano sul preset prudente concordato per le comete.</div>`;

  lastFocusedElement=trigger||document.activeElement;
  $('cometSettingsModal').classList.remove('hidden');
  document.body.classList.add('comets-modal-open');
  $('cometSettingsClose').focus();
}

function closeCometSettingsModal(){
  $('cometSettingsModal').classList.add('hidden');
  document.body.classList.remove('comets-modal-open');
  if (lastFocusedElement?.focus) lastFocusedElement.focus();
}

async function calculate(){
  if (running) return;
  const observer=readObserver();
  if (!observer) return;
  if (!cometCatalog.length) return showMessage('Catalogo comete non ancora disponibile. Riprova dopo l’aggiornamento automatico dei dati JPL.');
  hideMessage();
  closeCometSettingsModal();
  running=true;
  $('calculateButton').disabled=true;
  $('summary').classList.add('hidden');
  $('results').className='comets-loading';
  $('results').innerHTML='<div>Calcolo delle finestre osservative…</div><div class="comets-progress"><span id="cometsProgressText">Preparazione</span><div class="comets-progress-track"><div id="cometsProgressBar" class="comets-progress-bar"></div></div></div>';

  try {
    const today=new Date();
    const baseDay=new Date(today.getFullYear(),today.getMonth(),today.getDate(),12,0,0,0);
    const found=[];

    for (let i=0;i<cometCatalog.length;i++) {
      const comet=cometCatalog[i];
      const windows=[];
      try {
        for (let d=0;d<SEARCH_DAYS;d++) {
          const w=bestWindowForNight(comet,nightStart(baseDay,d),observer);
          if (w) windows.push(w);
        }
      } catch (error) {
        console.warn('Cometa ignorata per errore di propagazione',comet.designation,error);
      }
      windows.sort((a,b)=>b.score-a.score);
      if (windows.length) found.push({comet,windows:windows.slice(0,3),bestScore:windows[0].score});

      if (i%2===0) {
        const percent=Math.round((i+1)*100/cometCatalog.length);
        const text=$('cometsProgressText'),bar=$('cometsProgressBar');
        if (text) text.textContent=`${i+1}/${cometCatalog.length} candidate`;
        if (bar) bar.style.width=`${percent}%`;
        await breathe();
      }
    }

    found.sort((a,b)=>b.bestScore-a.bestScore);
    const totalWindows=found.reduce((sum,item)=>sum+item.windows.length,0);
    $('summary').classList.remove('hidden');
    $('summary').innerHTML=`<span><strong>${found.length}</strong> comete fotografabili</span><span><strong>${totalWindows}</strong> migliori finestre</span><span>Periodo: <strong>30 giorni</strong></span><span>Passo calcolo: <strong>${STEP_MINUTES} min</strong></span>`;
    renderResults(found);
  } catch (error) {
    renderedWindows=[];
    $('results').className='comets-error';
    $('results').textContent=`Errore di calcolo: ${error.message}`;
  } finally {
    running=false;
    $('calculateButton').disabled=false;
  }
}

async function loadCatalog(){
  try {
    const response=await fetch(`${DATA_URL}?v=${Date.now()}`,{cache:'no-store'});
    if (!response.ok) throw new Error(`cache non disponibile (${response.status})`);
    const data=await response.json();
    cacheMeta=data;
    cometCatalog=(data.objects||[]).map(o=>({
      ...o,
      epoch:Number(o.epoch),e:Number(o.e),q:Number(o.q),i:Number(o.i),om:Number(o.om),w:Number(o.w),tp:Number(o.tp),M1:Number(o.M1),K1:Number(o.K1)
    })).filter(o=>[o.epoch,o.e,o.q,o.i,o.om,o.w,o.tp,o.M1,o.K1].every(Number.isFinite));

    if (data.generated_at) {
      const d=new Date(data.generated_at);
      $('dataAge').textContent=`Dati JPL: ${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}`;
    } else {
      $('dataAge').textContent='Dati JPL: inizializzazione necessaria';
    }

    if (!cometCatalog.length) {
      $('results').className='comets-empty';
      $('results').textContent='La pagina è pronta, ma la cache JPL non è ancora stata popolata dall’aggiornamento automatico.';
      return;
    }
    await calculate();
  } catch (error) {
    $('results').className='comets-error';
    $('results').textContent=`Impossibile caricare il catalogo comete: ${error.message}`;
  }
}

function showMessage(text){$('message').textContent=text;$('message').classList.remove('hidden');}
function hideMessage(){$('message').classList.add('hidden');}
function breathe(){return new Promise(resolve=>setTimeout(resolve,0));}

loadCatalog();
