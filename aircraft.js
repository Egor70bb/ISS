import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $=id=>document.getElementById(id);
const DATA_URL='./data/aircraft-flights.json';
const DEG=Math.PI/180;
const EARTH_KM=6371.0088;
const BODY_RADIUS={sun:0.2666,moon:0.2725};

const AIRPORTS={
  TRS:{name:'Ronchi dei Legionari',iata:'TRS',icao:'LIPQ',lat:45.827862,lon:13.466672,elev:12,
    runways:[
      {label:'09',heading:89.4,threshold:[45.827953,13.449911],far:[45.827764,13.485969],preference:1},
      {label:'27',heading:269.4,threshold:[45.827764,13.485969],far:[45.827953,13.449911],preference:1}
    ]},
  LIN:{name:'Milano Linate',iata:'LIN',icao:'LIML',lat:45.445099,lon:9.276740,elev:108,
    runways:[
      {label:'36',heading:354.3,threshold:[45.434306,9.278228],far:[45.456214,9.275867],preference:1.35,preferred:true},
      {label:'18',heading:174.3,threshold:[45.456214,9.275867],far:[45.434306,9.278228],preference:.7}
    ]}
};

let flightData=null;
$('calculateButton').addEventListener('click',calculate);
$('airport').addEventListener('change',calculate);
$('days').addEventListener('change',calculate);
$('bodyFilter').addEventListener('change',calculate);
$('movementFilter').addEventListener('change',calculate);

function rad(v){return v*DEG} function deg(v){return v/DEG}
function normBearing(v){return (v%360+360)%360}
function destination(lat,lon,bearing,dKm){
  const a=dKm/EARTH_KM,br=rad(bearing),p1=rad(lat),l1=rad(lon);
  const p2=Math.asin(Math.sin(p1)*Math.cos(a)+Math.cos(p1)*Math.sin(a)*Math.cos(br));
  const l2=l1+Math.atan2(Math.sin(br)*Math.sin(a)*Math.cos(p1),Math.cos(a)-Math.sin(p1)*Math.sin(p2));
  return {lat:deg(p2),lon:((deg(l2)+540)%360)-180};
}
function distanceKm(a,b){
  const p1=rad(a.lat),p2=rad(b.lat),dp=p2-p1,dl=rad(b.lon-a.lon);
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*EARTH_KM*Math.asin(Math.min(1,Math.sqrt(h)));
}
function addMinutes(date,min){return new Date(date.getTime()+min*60000)}
function bodyHorizontal(bodyKey,date,lat,lon,elev){
  const observer=new Astronomy.Observer(lat,lon,elev);
  const body=bodyKey==='sun'?Astronomy.Body.Sun:Astronomy.Body.Moon;
  const eq=Astronomy.Equator(body,date,observer,true,true);
  const hor=Astronomy.Horizon(date,observer,eq.ra,eq.dec,'normal');
  let illum=100;
  if(bodyKey==='moon') illum=Astronomy.Illumination(Astronomy.Body.Moon,date).phase_fraction*100;
  return {alt:hor.altitude,az:hor.azimuth,illum};
}
function theoreticalSpot(airport,runway,flight,bodyKey,dKm){
  const base=new Date(flight.expected_iso||flight.scheduled_iso);
  if(!Number.isFinite(base.getTime())) return null;
  const arrival=flight.movement==='arrival';
  let eventTime,planeGround,planeAlt;
  if(arrival){
    const seconds=dKm*1000/72;
    eventTime=addMinutes(base,-5-seconds/60);
    planeGround=destination(runway.threshold[0],runway.threshold[1],normBearing(runway.heading+180),dKm);
    planeAlt=airport.elev+dKm*1000*Math.tan(rad(3));
  }else{
    const seconds=dKm*1000/95;
    eventTime=addMinutes(base,12+seconds/60);
    planeGround=destination(runway.far[0],runway.far[1],runway.heading,dKm);
    planeAlt=airport.elev+70+dKm*1000*Math.tan(rad(4));
  }
  let spot={lat:airport.lat,lon:airport.lon};
  let body=bodyHorizontal(bodyKey,eventTime,spot.lat,spot.lon,airport.elev);
  const minAlt=bodyKey==='sun'?5:5;
  if(body.alt<minAlt || body.alt>78 || (bodyKey==='moon'&&body.illum<10)) return null;
  for(let i=0;i<3;i++){
    const h=Math.max(20,planeAlt-airport.elev);
    const groundRange=h/Math.tan(rad(body.alt));
    if(!Number.isFinite(groundRange)||groundRange<100||groundRange>25000) return null;
    spot=destination(planeGround.lat,planeGround.lon,normBearing(body.az+180),groundRange/1000);
    body=bodyHorizontal(bodyKey,eventTime,spot.lat,spot.lon,airport.elev);
    if(body.alt<minAlt||body.alt>78) return null;
  }
  const h=Math.max(20,planeAlt-airport.elev);
  const groundRange=h/Math.tan(rad(body.alt));
  const slant=Math.hypot(h,groundRange);
  const airportDist=distanceKm({lat:airport.lat,lon:airport.lon},spot);
  if(airportDist<.8||airportDist>16) return null;
  const halfWidth=Math.max(8,slant*Math.tan(rad(BODY_RADIUS[bodyKey])));
  const bodyAltScore=Math.max(0,30-Math.abs(body.alt-30));
  const distanceScore=Math.max(0,25-Math.abs(airportDist-6)*3);
  const movementScore=arrival?16:5;
  const moonScore=bodyKey==='moon'?Math.min(10,body.illum/10):8;
  const score=bodyAltScore+distanceScore+movementScore+moonScore+runway.preference*8;
  return {bodyKey,eventTime,spot,body,planeAlt,airportDist,halfWidth,score,dKm,runway,flight};
}
function candidatesForFlight(airport,flight,bodyKey){
  const out=[];
  for(const runway of airport.runways){
    let best=null;
    for(let d=.8;d<=10;d+=.4){
      const c=theoreticalSpot(airport,runway,flight,bodyKey,d);
      if(c&&(!best||c.score>best.score)) best=c;
    }
    if(best) out.push(best);
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,2);
}
function confidence(c){
  if(c.flight.movement==='arrival'&&c.runway.preferred) return {label:'Medio-alta',cls:'high',unc:'±8–12 min'};
  if(c.flight.movement==='arrival') return {label:'Media',cls:'medium',unc:'±10–15 min'};
  return {label:'Bassa',cls:'low',unc:'±15–25 min'};
}
function bodyLabel(k){return k==='sun'?'☀️ Sole':'🌙 Luna'}
function movementLabel(v){return v==='arrival'?'Arrivo':'Partenza'}
function dtText(d){return d.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
function timeText(d){return d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function mapsUrl(c){return `https://www.google.com/maps/search/?api=1&query=${c.spot.lat.toFixed(6)},${c.spot.lon.toFixed(6)}`}
function dateStartLocal(){const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate(),0,0,0,0)}

function calculate(){
  if(!flightData) return;
  const code=$('airport').value,days=Number($('days').value),bodyFilter=$('bodyFilter').value,movement=$('movementFilter').value;
  const airport=AIRPORTS[code],bucket=flightData.airports?.[code];
  if(!bucket){return renderEmpty('Dati voli non disponibili per questo aeroporto.');}
  const start=dateStartLocal(),end=new Date(start.getTime()+days*86400000);
  let flights=(bucket.flights||[]).filter(f=>{
    const t=new Date(f.expected_iso||f.scheduled_iso);
    return t>=start&&t<end&&(movement==='both'||f.movement===movement);
  });
  const dedupe=new Map();
  for(const f of flights){const key=`${f.movement}|${f.scheduled_iso}|${f.route||''}`;if(!dedupe.has(key)) dedupe.set(key,f)}
  flights=[...dedupe.values()];
  const bodies=bodyFilter==='both'?['sun','moon']:[bodyFilter];
  const candidates=[];
  for(const flight of flights) for(const body of bodies) candidates.push(...candidatesForFlight(airport,flight,body));
  candidates.sort((a,b)=>b.score-a.score);
  render(candidates.slice(0,24),flights.length,bucket,days);
}
function render(candidates,flightCount,bucket,days){
  $('summary').classList.remove('hidden');
  $('summary').innerHTML=`<span><strong>${flightCount}</strong> movimenti analizzati</span><span><strong>${candidates.length}</strong> candidati mostrati</span><span>Orizzonte: <strong>${days} gg</strong></span><span>Feed: <strong>${escapeHtml(bucket.status||'—')}</strong></span>`;
  if(!candidates.length){
    $('results').className='aircraft-empty';
    const extra=flightCount?`Sono stati analizzati ${flightCount} movimenti, ma nessuno produce un punto teorico entro 16 km con Sole/Luna sufficientemente alti.`:'La cache non contiene movimenti nel periodo selezionato.';
    $('results').innerHTML=`<strong>Nessun evento candidato.</strong><br>${extra}`;return;
  }
  $('results').className='aircraft-table-wrap';
  $('results').innerHTML=`<table class="aircraft-table"><thead><tr><th>Corpo</th><th>Data / evento</th><th>Volo</th><th>Movimento</th><th>Orario volo</th><th>Transito stimato</th><th>Pista ipotizzata</th><th>Alt. corpo</th><th>Punto teorico</th><th>Fascia</th><th>Confidenza</th></tr></thead><tbody>${candidates.map(c=>{
    const cf=confidence(c),f=c.flight,bodyCls=c.bodyKey==='sun'?'sun':'moon';
    return `<tr><td class="aircraft-body ${bodyCls}">${bodyLabel(c.bodyKey)}</td><td class="aircraft-time">${dtText(c.eventTime)}</td><td class="aircraft-flight"><strong>${escapeHtml(f.flight||'—')}</strong><small>${escapeHtml(f.route||'')} ${escapeHtml(f.airline||'')}</small></td><td>${movementLabel(f.movement)}</td><td class="aircraft-time">${timeText(new Date(f.expected_iso||f.scheduled_iso))}</td><td class="aircraft-time"><strong>≈ ${timeText(c.eventTime)}</strong><small>${cf.unc}</small></td><td><strong>RWY ${c.runway.label}</strong>${c.runway.preferred?'<small>preferenziale</small>':''}</td><td class="aircraft-num">${c.body.alt.toFixed(1)}°${c.bodyKey==='moon'?`<small>fase ${c.body.illum.toFixed(0)}%</small>`:''}</td><td class="aircraft-spot"><strong>${c.spot.lat.toFixed(5)}, ${c.spot.lon.toFixed(5)}</strong><small>${c.airportDist.toFixed(1)} km dall’aeroporto · modello ${f.movement==='arrival'?'finale 3°':'salita 4°'}</small><a class="aircraft-map" href="${mapsUrl(c)}" target="_blank" rel="noopener">Apri in Google Maps ↗</a></td><td class="aircraft-num">±${Math.round(c.halfWidth)} m</td><td><span class="aircraft-confidence ${cf.cls}">${cf.label}</span></td></tr>`;
  }).join('')}</tbody></table>`;
}
function renderEmpty(text){$('summary').classList.add('hidden');$('results').className='aircraft-empty';$('results').textContent=text}
async function load(){
  try{
    const r=await fetch(`${DATA_URL}?v=${Date.now()}`,{cache:'no-store'});if(!r.ok) throw new Error(`HTTP ${r.status}`);
    flightData=await r.json();
    if(flightData.generated_at){const d=new Date(flightData.generated_at);$('dataAge').textContent=`Dati voli: ${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}`}
    calculate();
  }catch(e){$('results').className='aircraft-error';$('results').textContent=`Impossibile caricare gli orari voli: ${e.message}`}
}
load();
