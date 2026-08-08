import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@6.0.1/+esm';
import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $ = id => document.getElementById(id);
const TLE_URL = './data/iss.tle';
const SEARCH_DAYS = 30;
const MOON_RADIUS_DEG = 0.2725;
let cancelled = false;

const form = $('searchForm');
const progressWrap = $('progressWrap');
const progressBar = $('progressBar');
const progressText = $('progressText');
const progressPercent = $('progressPercent');
const results = $('results');
const summary = $('summary');
const emptyState = $('emptyState');
const message = $('message');

$('geoButton').addEventListener('click', () => {
  if (!navigator.geolocation) return showMessage('Geolocalizzazione non disponibile in questo browser.');
  navigator.geolocation.getCurrentPosition(p => {
    $('latitude').value = p.coords.latitude.toFixed(5);
    $('longitude').value = p.coords.longitude.toFixed(5);
    if (Number.isFinite(p.coords.altitude)) $('elevation').value = Math.round(p.coords.altitude);
  }, () => showMessage('Posizione non acquisita. Inserisci manualmente le coordinate.'));
});

$('stopButton').addEventListener('click', () => { cancelled = true; });

form.addEventListener('submit', async event => {
  event.preventDefault();
  const observer = readObserver();
  if (!observer) return;
  cancelled = false;
  setRunning(true);
  results.innerHTML = '';
  emptyState.classList.add('hidden');
  summary.classList.add('hidden');
  message.classList.add('hidden');

  try {
    updateProgress(1, 'Scaricamento dell’orbita ISS aggiornata…');
    const tle = await fetchTle();
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    const events = await findTransits(satrec, observer);
    if (cancelled) throw new Error('Ricerca interrotta.');
    renderResults(events, observer, tle.epochLabel);
  } catch (error) {
    showMessage(error.message || 'Impossibile completare il calcolo.');
    emptyState.classList.remove('hidden');
  } finally {
    setRunning(false);
  }
});

function readObserver(){
  const lat = Number($('latitude').value), lon = Number($('longitude').value);
  const height = Number($('elevation').value), radius = Number($('radius').value);
  if (!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lon)||lon < -180||lon > 180) {
    showMessage('Controlla latitudine e longitudine.'); return null;
  }
  return {lat, lon, height, radius};
}

async function fetchTle(){
  let response;
  try { response = await fetch(`${TLE_URL}?v=${Date.now()}`, {cache:'no-store'}); }
  catch { throw new Error('Non riesco a scaricare l’orbita ISS aggiornata. Controlla la connessione e riprova.'); }
  if (!response.ok) throw new Error(`Dati orbitali ISS non disponibili (errore ${response.status}).`);
  const lines = (await response.text()).trim().split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const line1 = lines.find(x=>x.startsWith('1 '));
  const line2 = lines.find(x=>x.startsWith('2 '));
  if (!line1 || !line2) throw new Error('Dati orbitali ISS non riconosciuti.');
  return {line1,line2,epochLabel:tleEpoch(line1).toLocaleString('it-IT',{dateStyle:'medium',timeStyle:'medium'})};
}

function tleEpoch(line1){
  const yy=Number(line1.slice(18,20)), day=Number(line1.slice(20,32));
  const year=yy<57?2000+yy:1900+yy;
  return new Date(Date.UTC(year,0,1)+(day-1)*86400000);
}

async function findTransits(satrec, observer){
  const start = new Date();
  const endMs = start.getTime()+SEARCH_DAYS*86400000;
  const passWindows=[];
  const candidates=[];
  const coarseStep=20000;
  let passStart=null;
  const total=Math.ceil((endMs-start.getTime())/coarseStep);

  for(let i=0,t=start.getTime();t<=endMs;t+=coarseStep,i++){
    if(cancelled) break;
    const data=geometry(satrec,new Date(t),observer.lat,observer.lon,observer.height);
    const above=data && data.issAlt>-5;
    if(above && passStart===null) passStart=Math.max(start.getTime(),t-coarseStep);
    if(!above && passStart!==null){passWindows.push([passStart,Math.min(endMs,t+coarseStep)]);passStart=null;}
    if(i%900===0){updateProgress(4+Math.round(70*i/total),`Analisi orbitale: giorno ${Math.min(SEARCH_DAYS,Math.floor(i*coarseStep/86400000)+1)} di ${SEARCH_DAYS}`);await breathe();}
  }
  if(passStart!==null) passWindows.push([passStart,endMs]);

  const searchReach=MOON_RADIUS_DEG+(observer.radius/360)*57.2958+0.12;
  for(let i=0;i<passWindows.length;i++){
    if(cancelled) break;
    const [from,to]=passWindows[i];
    let last=null,falling=false;
    for(let t=from;t<=to;t+=500){
      const g=geometry(satrec,new Date(t),observer.lat,observer.lon,observer.height);
      if(g && g.moonAlt>-2){
        if(last && g.sep<last.sep) falling=true;
        if(last && falling && g.sep>last.sep){
          const refined=refineTime(satrec,observer,last.time-750,last.time+750,25);
          if(refined && refined.sep<searchReach && !candidates.some(c=>Math.abs(c.time-refined.time)<90000)) candidates.push(refined);
          falling=false;
        }
        last=g;
      }
    }
    if(i%8===0){updateProgress(74+Math.round(10*i/Math.max(1,passWindows.length)),'Verifica ravvicinata dei passaggi sopra l’orizzonte…');await breathe();}
  }

  const events=[];
  for(let i=0;i<candidates.length;i++){
    if(cancelled) break;
    updateProgress(85+Math.round(12*i/Math.max(1,candidates.length)),'Ricerca della fascia migliore entro il raggio scelto…');
    const best=optimizeLocation(satrec,observer,candidates[i]);
    if(best.sep<=MOON_RADIUS_DEG) events.push(best);
    await breathe();
  }
  updateProgress(100,'Calcolo completato');
  return dedupe(events).sort((a,b)=>a.time-b.time);
}

function geometry(satrec,date,lat,lon,heightM){
  const pv=satellite.propagate(satrec,date);
  if(!pv.position) return null;
  const gmst=satellite.gstime(date);
  const ecf=satellite.eciToEcf(pv.position,gmst);
  const look=satellite.ecfToLookAngles({latitude:satellite.degreesToRadians(lat),longitude:satellite.degreesToRadians(lon),height:heightM/1000},ecf);
  const issAlt=satellite.radiansToDegrees(look.elevation), issAz=norm(satellite.radiansToDegrees(look.azimuth));
  const obs=new Astronomy.Observer(lat,lon,heightM);
  const eq=Astronomy.Equator(Astronomy.Body.Moon,date,obs,true,true);
  const hor=Astronomy.Horizon(date,obs,eq.ra,eq.dec,'normal');
  const sep=angularSeparation(issAlt,issAz,hor.altitude,hor.azimuth);
  const moonPhase=Astronomy.MoonPhase(date);
  const moonIllumination=(1-Math.cos(moonPhase*Math.PI/180))/2*100;
  return {time:date.getTime(),sep,issAlt,issAz,moonAlt:hor.altitude,moonAz:hor.azimuth,ra:eq.ra,dec:eq.dec,moonIllumination,distanceKm:Math.sqrt(ecf.x*ecf.x+ecf.y*ecf.y+ecf.z*ecf.z)};
}

function refineTime(satrec,observer,from,to,step){
  let best=null;
  for(let t=from;t<=to;t+=step){
    const g=geometry(satrec,new Date(t),observer.lat,observer.lon,observer.height);
    if(g && (!best||g.sep<best.sep)) best=g;
  }
  return best;
}

function optimizeLocation(satrec,observer,candidate){
  let best={...candidate,lat:observer.lat,lon:observer.lon,offsetKm:0};
  const radius=observer.radius;
  const steps=radius===0?0:10;
  for(let iy=-steps;iy<=steps;iy++) for(let ix=-steps;ix<=steps;ix++){
    const east=steps?radius*ix/steps:0, north=steps?radius*iy/steps:0;
    const dist=Math.hypot(east,north); if(dist>radius) continue;
    const lat=observer.lat+north/111.32;
    const lon=observer.lon+east/(111.32*Math.cos(observer.lat*Math.PI/180));
    for(let dt=-2500;dt<=2500;dt+=100){
      const g=geometry(satrec,new Date(candidate.time+dt),lat,lon,observer.height);
      if(g && g.sep<best.sep) best={...g,lat,lon,offsetKm:dist};
    }
  }
  const before=geometry(satrec,new Date(best.time-100),best.lat,best.lon,observer.height);
  const after=geometry(satrec,new Date(best.time+100),best.lat,best.lon,observer.height);
  const angularSpeed=before&&after?angularSeparation(before.issAlt,before.issAz,after.issAlt,after.issAz)/0.2:1;
  const halfChord=Math.sqrt(Math.max(0,MOON_RADIUS_DEG**2-best.sep**2));
  return {...best,durationEstimate:Math.max(.05,2*halfChord/Math.max(.01,angularSpeed))};
}

function angularSeparation(a1,z1,a2,z2){
  const r=Math.PI/180;
  const c=Math.sin(a1*r)*Math.sin(a2*r)+Math.cos(a1*r)*Math.cos(a2*r)*Math.cos((z1-z2)*r);
  return Math.acos(Math.max(-1,Math.min(1,c)))/r;
}

function dedupe(items){
  const out=[];
  for(const item of items) if(!out.some(x=>Math.abs(x.time-item.time)<120000)) out.push(item);
  return out;
}

function renderResults(events,observer,epoch){
  summary.classList.remove('hidden');
  summary.innerHTML=`<strong>${events.length}</strong> transiti geometrici trovati entro ${observer.radius} km · TLE aggiornato al ${epoch}.`;
  if(!events.length){
    emptyState.classList.remove('hidden');
    emptyState.innerHTML='<div class="moon">☾</div><h3>Nessun transito lunare trovato</h3><p>Non risultano attraversamenti del disco entro il raggio e il periodo selezionati. Riprova nei prossimi giorni: i dati orbitali vengono aggiornati.</p>';
    return;
  }
  results.innerHTML=events.map((e,i)=>eventCard(e,i)).join('');
}

function eventCard(e,index){
  const date=new Date(e.time), days=(e.time-Date.now())/86400000, confirm=days<=14;
  const time=date.toLocaleString('it-IT',{weekday:'long',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
  const maps=`https://www.google.com/maps/search/?api=1&query=${e.lat.toFixed(6)},${e.lon.toFixed(6)}`;
  const calendar=icsLink(e,index);
  return `<article class="event"><div class="event-head"><div><h3>Transito lunare #${index+1}</h3><div class="event-time">${capitalize(time)}</div></div><span class="badge ${confirm?'confirm':'plan'}">${confirm?'DA CONFERMARE 24 H PRIMA':'PRELIMINARE'}</span></div><div class="metrics"><div class="metric"><span>Distanza</span><strong>${e.offsetKm.toFixed(2)} km</strong></div><div class="metric"><span>Altezza Luna</span><strong>${e.moonAlt.toFixed(1)}°</strong></div><div class="metric"><span>Azimut</span><strong>${e.moonAz.toFixed(1)}°</strong></div><div class="metric"><span>Illuminazione Luna</span><strong>${e.moonIllumination.toFixed(0)}%</strong></div><div class="metric"><span>Durata stimata</span><strong>${e.durationEstimate.toFixed(2)} s</strong></div><div class="metric"><span>Declinazione</span><strong>${signed(e.dec)}°</strong></div><div class="metric"><span>Ascensione retta</span><strong>${e.ra.toFixed(3)} h</strong></div><div class="metric"><span>Coordinate migliori</span><strong>${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}</strong></div><div class="metric"><span>Distanza dal centro</span><strong>${e.sep.toFixed(3)}°</strong></div></div><div class="event-actions"><a href="${maps}" target="_blank" rel="noopener">Apri punto su Google Maps</a><a href="${calendar}" download="transito-iss-luna-${index+1}.ics">Aggiungi al calendario</a></div>${dwarfEventCard(e)}</article>`;
}

function dwarfEventCard(e){
  const bright=e.moonIllumination>=70, medium=e.moonIllumination>=30;
  const exposure=bright?'1/250 s':medium?'1/125 s':'1/60 s';
  const quality=e.moonAlt>=20&&e.moonIllumination>=30?'Buona':e.moonAlt>=10?'Discreta':'Difficile';
  const qualityClass=quality==='Buona'?'':'quality-low';
  return `<details class="dwarf-event"><summary>Scheda di ripresa DWARF 3 per questo evento</summary><div class="capture-content"><div class="capture-grid"><div><span>Video</span><strong>1080p · 60 fps</strong></div><div><span>Esposizione iniziale</span><strong>${exposure}</strong></div><div><span>Gain</span><strong>0</strong></div><div><span>Filtro</span><strong>VIS</strong></div><div><span>Avvio video</span><strong>−45 secondi</strong></div><div><span>Fine video</span><strong>+20 secondi</strong></div><div><span>Moon Track</span><strong>Attivo</strong></div><div><span>Condizione stimata</span><strong class="${qualityClass}">${quality}</strong></div></div><ol class="capture-steps"><li>Arriva almeno 20 minuti prima e colloca il treppiede alle coordinate migliori indicate.</li><li>Centra l’intero disco lunare nel teleobiettivo, usa AF e controlla la nitidezza dei crateri.</li><li>Attiva <strong>Moon Track</strong>, poi passa a <strong>Video 1080p/60 fps</strong>.</li><li>Imposta VIS, Gain 0 e prova l’esposizione proposta; riducila se le zone chiare risultano bruciate.</li><li>Avvia la registrazione 45 secondi prima dell’ora prevista e non toccare più il telescopio.</li></ol><div class="capture-warning">L’esposizione è un punto di partenza: nuvole sottili, foschia e fase lunare richiedono una prova sul posto. Conferma sempre orario e coordinate il giorno stesso.</div></div></details>`;
}

function icsLink(e,index){
  const start=new Date(e.time-15*60000),end=new Date(e.time+5*60000),fmt=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const body=`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:iss-lunar-${e.time}-${index}@local\r\nDTSTAMP:${fmt(new Date())}\r\nDTSTART:${fmt(start)}\r\nDTEND:${fmt(end)}\r\nSUMMARY:Possibile transito ISS davanti alla Luna\r\nDESCRIPTION:Ricontrollare previsione e TLE il giorno dell'evento.\r\nLOCATION:${e.lat.toFixed(6)},${e.lon.toFixed(6)}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  return URL.createObjectURL(new Blob([body],{type:'text/calendar'}));
}

function setRunning(on){
  $('searchButton').disabled=on;$('stopButton').classList.toggle('hidden',!on);progressWrap.classList.toggle('hidden',!on);
  if(!on && !cancelled) setTimeout(()=>progressWrap.classList.add('hidden'),700);
}
function updateProgress(percent,text){progressBar.style.width=`${percent}%`;progressPercent.textContent=`${percent}%`;progressText.textContent=text;}
function showMessage(text){message.textContent=text;message.classList.remove('hidden');}
function breathe(){return new Promise(resolve=>setTimeout(resolve,0));}
function norm(x){return (x%360+360)%360;}
function signed(x){return `${x>=0?'+':''}${x.toFixed(2)}`;}
function capitalize(x){return x.charAt(0).toUpperCase()+x.slice(1);}
