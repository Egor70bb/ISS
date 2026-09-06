import * as Astronomy from 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/+esm';

const $=id=>document.getElementById(id);
const DATA_URL='./data/aircraft-flights.json';
const OVERPASS_ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
const OSRM_TABLE='https://router.project-osrm.org/table/v1/driving';
const DEG=Math.PI/180, EARTH_KM=6371.0088, AU_KM=149597870.7, MOON_RADIUS_KM=1737.4;
const BODY_RADIUS={sun:0.2666,moon:0.2725};
const VALID_FLIGHT=/^[A-Z][A-Z0-9]{1,2}[0-9]{2,5}[A-Z]?$/i;
const SAFE_HIGHWAYS=new Set(['residential','service','unclassified','living_street','tertiary']);
const ACCESS_QUERY_RADIUS_M=1200;
const LOGISTICS_BATCH_SIZE=6;
const OVERPASS_TIMEOUT_MS=9000;
const OSRM_TIMEOUT_MS=8000;

const ORIGINS={
  TRS:{label:"Terzo d'Aquileia · Comune",lat:45.800267,lon:13.346367},
  LIN:{label:'Piazzale Loreto · Milano',lat:45.486231,lon:9.216767}
};
const AIRPORTS={
  TRS:{name:'Ronchi dei Legionari',iata:'TRS',icao:'LIPQ',lat:45.827862,lon:13.466672,elev:12,runways:[
    {label:'09',heading:89.4,threshold:[45.827953,13.449911],far:[45.827764,13.485969],preference:1},
    {label:'27',heading:269.4,threshold:[45.827764,13.485969],far:[45.827953,13.449911],preference:1}
  ]},
  LIN:{name:'Milano Linate',iata:'LIN',icao:'LIML',lat:45.445099,lon:9.276740,elev:108,runways:[
    {label:'35',heading:354.3,threshold:[45.434306,9.278228],far:[45.456214,9.275867],preference:1.35,preferred:true},
    {label:'17',heading:174.3,threshold:[45.456214,9.275867],far:[45.434306,9.278228],preference:.7}
  ]}
};

let flightData=null;
let calculationSerial=0;
const accessCache=new Map();
const routeCache=new Map();

for(const id of ['calculateButton','airport','days','bodyFilter','movementFilter','roadDistanceFilter','originDistanceFilter']){
  const el=$(id); if(el) el.addEventListener(id==='calculateButton'?'click':'change',calculate);
}

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
function fetchWithTimeout(url,options={},timeoutMs=8000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return fetch(url,{...options,signal:controller.signal}).finally(()=>clearTimeout(timer));
}
function bodyHorizontal(bodyKey,date,lat,lon,elev){
  const observer=new Astronomy.Observer(lat,lon,elev);
  const body=bodyKey==='sun'?Astronomy.Body.Sun:Astronomy.Body.Moon;
  const eq=Astronomy.Equator(body,date,observer,true,true);
  const hor=Astronomy.Horizon(date,observer,eq.ra,eq.dec,'normal');
  let illum=100,diameterArcmin=null;
  if(bodyKey==='moon'){
    illum=Astronomy.Illumination(Astronomy.Body.Moon,date).phase_fraction*100;
    const moon=Astronomy.GeoMoon(date),distanceAu=Math.hypot(moon.x,moon.y,moon.z);
    if(Number.isFinite(distanceAu)&&distanceAu>0) diameterArcmin=2*Math.atan(MOON_RADIUS_KM/(distanceAu*AU_KM))*180/Math.PI*60;
  }
  return {alt:hor.altitude,az:hor.azimuth,illum,diameterArcmin};
}
function theoreticalSpot(airport,runway,flight,bodyKey,dKm){
  const base=new Date(flight.expected_iso||flight.scheduled_iso); if(!Number.isFinite(base.getTime())) return null;
  const arrival=flight.movement==='arrival'; let eventTime,planeGround,planeAlt;
  if(arrival){
    const seconds=dKm*1000/72; eventTime=addMinutes(base,-5-seconds/60);
    planeGround=destination(runway.threshold[0],runway.threshold[1],normBearing(runway.heading+180),dKm);
    planeAlt=airport.elev+dKm*1000*Math.tan(rad(3));
  }else{
    const seconds=dKm*1000/95; eventTime=addMinutes(base,12+seconds/60);
    planeGround=destination(runway.far[0],runway.far[1],runway.heading,dKm);
    planeAlt=airport.elev+70+dKm*1000*Math.tan(rad(4));
  }
  let spot={lat:airport.lat,lon:airport.lon}; let body=bodyHorizontal(bodyKey,eventTime,spot.lat,spot.lon,airport.elev);
  const minAlt=5; if(body.alt<minAlt||body.alt>78||(bodyKey==='moon'&&body.illum<10)) return null;
  for(let i=0;i<3;i++){
    const h=Math.max(20,planeAlt-airport.elev),groundRange=h/Math.tan(rad(body.alt));
    if(!Number.isFinite(groundRange)||groundRange<100||groundRange>25000) return null;
    spot=destination(planeGround.lat,planeGround.lon,normBearing(body.az+180),groundRange/1000);
    body=bodyHorizontal(bodyKey,eventTime,spot.lat,spot.lon,airport.elev); if(body.alt<minAlt||body.alt>78) return null;
  }
  const h=Math.max(20,planeAlt-airport.elev),groundRange=h/Math.tan(rad(body.alt)),slant=Math.hypot(h,groundRange);
  const airportDist=distanceKm({lat:airport.lat,lon:airport.lon},spot); if(airportDist<.8||airportDist>16) return null;
  const angularRadius=bodyKey==='moon'&&Number.isFinite(body.diameterArcmin)?body.diameterArcmin/120:BODY_RADIUS[bodyKey];
  const halfWidth=Math.max(8,slant*Math.tan(rad(angularRadius)));
  const bodyAltScore=Math.max(0,30-Math.abs(body.alt-30));
  const distanceScore=Math.max(0,25-Math.abs(airportDist-6)*3),movementScore=arrival?16:5,moonScore=bodyKey==='moon'?Math.min(10,body.illum/10):8;
  const score=bodyAltScore+distanceScore+movementScore+moonScore+runway.preference*8;
  return {bodyKey,eventTime,spot,body,planeAlt,airportDist,halfWidth,score,dKm,runway,flight,logisticsState:'pending'};
}
function candidatesForFlight(airport,flight,bodyKey){
  const out=[]; for(const runway of airport.runways){
    let best=null; for(let d=.8;d<=10;d+=.4){const c=theoreticalSpot(airport,runway,flight,bodyKey,d);if(c&&(!best||c.score>best.score))best=c}
    if(best) out.push(best);
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,2);
}
function confidence(c){
  if(c.flight.movement==='arrival'&&c.runway.preferred)return{label:'Medio-alta',cls:'high',unc:'±8–12 min'};
  if(c.flight.movement==='arrival')return{label:'Media',cls:'medium',unc:'±10–15 min'};
  return{label:'Bassa',cls:'low',unc:'±15–25 min'};
}
function moonVisibility(body){if(body.alt>=30&&body.illum>=40)return'Alta';if(body.alt>=20&&body.illum>=25)return'Buona';if(body.alt>=10&&body.illum>=15)return'Discreta';return'Bassa'}
function moonBodyHtml(c){
  const diameter=Number.isFinite(c.body.diameterArcmin)?`${c.body.diameterArcmin.toFixed(1)}′`:'—',visibility=moonVisibility(c.body);
  return `<span class="aircraft-moon-hover" tabindex="0" aria-label="Dettagli Luna: diametro apparente ${diameter}, illuminazione ${c.body.illum.toFixed(0)}%, altezza ${c.body.alt.toFixed(1)} gradi, visibilità ${visibility}">🌙 Luna<span class="aircraft-moon-tooltip" role="tooltip"><strong>Luna al transito</strong><span>Diametro apparente <b>${diameter}</b></span><span>Illuminazione <b>${c.body.illum.toFixed(0)}%</b></span><span>Altezza <b>${c.body.alt.toFixed(1)}°</b></span><span>Visibilità <b>${visibility}</b></span><small>Visibilità = stima geometrica da altezza e fase, non meteo.</small></span></span>`;
}
function bodyHtml(c){return c.bodyKey==='sun'?'☀️ Sole':moonBodyHtml(c)}
function movementLabel(v){return v==='arrival'?'Arrivo':'Partenza'}
function dtText(d){return d.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
function timeText(d){return d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}
function dayKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function dayLabel(d){const s=d.toLocaleDateString('it-IT',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});return s.charAt(0).toUpperCase()+s.slice(1)}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function candidateKey(c){return `${c.flight.flight}|${c.flight.movement}|${c.runway.label}|${c.bodyKey}|${c.eventTime.toISOString()}|${c.spot.lat.toFixed(5)}|${c.spot.lon.toFixed(5)}`}
function routePoint(c){return c.access?.point||c.spot}
function routeKey(code,p){return `${code}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`}
function eventMapsUrl(c){return `https://www.google.com/maps/search/?api=1&query=${c.spot.lat.toFixed(6)},${c.spot.lon.toFixed(6)}`}
function accessMapsUrl(c){if(!c.access)return null;const p=c.access.point;return `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`}
function directionsUrl(code,c){const o=ORIGINS[code],p=routePoint(c);return `https://www.google.com/maps/dir/?api=1&origin=${o.lat.toFixed(6)},${o.lon.toFixed(6)}&destination=${p.lat.toFixed(6)},${p.lon.toFixed(6)}&travelmode=driving`}

function pointSegmentNearest(origin,a,b){
  const mLat=111320,mLon=111320*Math.cos(rad(origin.lat)); const ax=(a.lon-origin.lon)*mLon,ay=(a.lat-origin.lat)*mLat,bx=(b.lon-origin.lon)*mLon,by=(b.lat-origin.lat)*mLat;
  const vx=bx-ax,vy=by-ay,den=vx*vx+vy*vy; let t=den?-(ax*vx+ay*vy)/den:0; t=Math.max(0,Math.min(1,t));
  const x=ax+t*vx,y=ay+t*vy; return {distanceM:Math.hypot(x,y),point:{lat:a.lat+t*(b.lat-a.lat),lon:a.lon+t*(b.lon-a.lon)}};
}
function featureNearest(origin,element){
  const geom=Array.isArray(element.geometry)?element.geometry.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)):[];
  if(!geom.length&&Number.isFinite(element.lat)&&Number.isFinite(element.lon))return{distanceM:distanceKm(origin,{lat:element.lat,lon:element.lon})*1000,point:{lat:element.lat,lon:element.lon}};
  if(!geom.length)return null;if(geom.length===1)return{distanceM:distanceKm(origin,geom[0])*1000,point:{lat:geom[0].lat,lon:geom[0].lon}};
  let best=null;for(let i=1;i<geom.length;i++){const r=pointSegmentNearest(origin,geom[i-1],geom[i]);if(!best||r.distanceM<best.distanceM)best=r}return best;
}
function usableFeature(element){
  const t=element.tags||{},access=(t.access||'').toLowerCase(); if(access==='private'||access==='no')return false;
  if(t.amenity==='parking')return true;if(!SAFE_HIGHWAYS.has(t.highway))return false;
  if(t.highway==='service'&&t.service==='driveway'&&!['yes','permissive'].includes(access))return false;return true;
}
function featureLabel(element){
  const t=element.tags||{};if(t.amenity==='parking')return{type:'parking',label:t.name||'Parcheggio mappato OSM'};
  const road=t.name||t.ref||({residential:'Strada residenziale',service:'Strada di servizio',unclassified:'Strada locale',living_street:'Zona residenziale',tertiary:'Strada locale/terziaria'}[t.highway]||'Strada');return{type:'road',label:road};
}
function buildOverpassQuery(candidates){
  const around=candidates.map(c=>{const lat=c.spot.lat.toFixed(6),lon=c.spot.lon.toFixed(6);return `way(around:${ACCESS_QUERY_RADIUS_M},${lat},${lon})["highway"~"^(residential|service|unclassified|living_street|tertiary)$"]["access"!~"^(private|no)$"];\nnwr(around:${ACCESS_QUERY_RADIUS_M},${lat},${lon})["amenity"="parking"]["access"!~"^(private|no)$"];`}).join('\n');
  return `[out:json][timeout:8];(${around});out geom tags;`;
}
async function fetchOverpass(query){
  let lastError=null;
  for(const endpoint of OVERPASS_ENDPOINTS){
    try{
      const r=await fetchWithTimeout(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:`data=${encodeURIComponent(query)}`},OVERPASS_TIMEOUT_MS);
      if(!r.ok)throw new Error(`HTTP ${r.status}`);const data=await r.json();if(!Array.isArray(data.elements))throw new Error('risposta OSM non valida');return data.elements.filter(usableFeature);
    }catch(e){lastError=e}
  }
  throw lastError||new Error('Overpass non disponibile');
}
function chooseNearestAccess(c,elements){
  let best=null;for(const el of elements){const near=featureNearest(c.spot,el);if(!near||near.distanceM>ACCESS_QUERY_RADIUS_M)continue;const meta=featureLabel(el),preference=near.distanceM-(meta.type==='parking'?10:0);if(!best||preference<best.preference)best={...meta,point:near.point,distanceM:near.distanceM,preference,osmId:`${el.type||'way'}/${el.id}`}}return best;
}
async function enrichAccessBatch(batch){
  let ok=true;const pending=batch.filter(c=>!accessCache.has(candidateKey(c)));
  if(pending.length){
    try{const elements=await fetchOverpass(buildOverpassQuery(pending));for(const c of pending){c.accessUnknown=false;accessCache.set(candidateKey(c),chooseNearestAccess(c,elements))}}
    catch(_){ok=false;for(const c of pending)c.accessUnknown=true}
  }
  for(const c of batch)if(accessCache.has(candidateKey(c))){c.access=accessCache.get(candidateKey(c));c.accessUnknown=false}
  return ok;
}
async function enrichDrivingBatch(code,batch){
  const origin=ORIGINS[code],missing=batch.filter(c=>!routeCache.has(routeKey(code,routePoint(c))));
  if(missing.length){
    const coords=[origin,...missing.map(routePoint)].map(p=>`${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    try{
      const r=await fetchWithTimeout(`${OSRM_TABLE}/${coords}?sources=0&annotations=distance,duration`,{},OSRM_TIMEOUT_MS);if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const data=await r.json(),distances=data.distances?.[0],durations=data.durations?.[0];if(!Array.isArray(distances)||!Array.isArray(durations))throw new Error('tabella OSRM non valida');
      missing.forEach((c,j)=>{const d=distances[j+1],t=durations[j+1];if(Number.isFinite(d))routeCache.set(routeKey(code,routePoint(c)),{distanceKm:d/1000,durationMin:Number.isFinite(t)?t/60:null,fallback:false})});
    }catch(_){for(const c of missing){const p=routePoint(c);routeCache.set(routeKey(code,p),{distanceKm:distanceKm(origin,p),durationMin:null,fallback:true})}}
  }
  for(const c of batch)c.driving=routeCache.get(routeKey(code,routePoint(c)))||null;
}
function roadBand(c){if(c.logisticsState==='pending')return'pending';if(c.accessUnknown||!c.access)return'far';if(c.access.distanceM<=100)return'near';if(c.access.distanceM<=500)return'mid';return'far'}
function roadBandLabel(c){const b=roadBand(c);if(b==='pending')return'In verifica…';if(c.accessUnknown)return'Non verificato';if(!c.access)return`> ${ACCESS_QUERY_RADIUS_M} m / non rilevato`;return b==='near'?'≤ 100 m':b==='mid'?'101–500 m':'> 500 m'}
function matchesFilters(c,roadFilter,originFilter,code){
  if(c.logisticsState==='pending')return true;
  if(roadFilter!=='all'&&roadBand(c)!==roadFilter)return false;
  if(originFilter!=='all'){const d=c.driving?.distanceKm??distanceKm(ORIGINS[code],routePoint(c));if(d>Number(originFilter))return false}return true;
}
function accessHtml(c){
  if(c.logisticsState==='pending')return `<span class="aircraft-logistics-pending">⏳ In verifica…</span><small>La geometria è già calcolata.</small>`;
  if(c.accessUnknown)return `<span class="aircraft-access-band far">? Non verificato</span><small>OSM non ha risposto entro il timeout.</small>`;
  if(!c.access)return `<span class="aircraft-access-band far">&gt; ${ACCESS_QUERY_RADIUS_M} m / non rilevato</span><small>Nessuna strada/parcheggio utile rilevato entro ${ACCESS_QUERY_RADIUS_M} m.</small>`;
  const icon=c.access.type==='parking'?'🅿️':'🛣️',band=roadBand(c),url=accessMapsUrl(c);
  return `<span class="aircraft-access ${c.access.type}">${icon} ${escapeHtml(c.access.label)}</span><span class="aircraft-access-band ${band}">${roadBandLabel(c)}</span><strong>${c.access.distanceM.toFixed(0)} m dal punto teorico</strong>${url?`<a class="aircraft-map" href="${url}" target="_blank" rel="noopener">Apri accesso ↗</a>`:''}`;
}
function drivingHtml(code,c){
  const o=ORIGINS[code];if(c.logisticsState==='pending')return `<span class="aircraft-logistics-pending">⏳ In calcolo…</span><small>da ${escapeHtml(o.label)}</small>`;
  const d=c.driving;if(!d)return `<span>—</span><small>da ${escapeHtml(o.label)}</small>`;
  const main=d.fallback?`≈ ${d.distanceKm.toFixed(1)} km linea d'aria`:`${d.distanceKm.toFixed(1)} km${Number.isFinite(d.durationMin)?` · ${Math.round(d.durationMin)} min`:''}`;
  const target=c.access?'fino al punto auto più vicino':'verso il punto teorico',note=d.fallback?`fallback · ${target}`:`da ${o.label} · ${target}`;
  return `<strong>${main}</strong><small>${escapeHtml(note)}</small><a class="aircraft-map" href="${directionsUrl(code,c)}" target="_blank" rel="noopener">Indicazioni auto ↗</a>`;
}
function progressHtml(done,total,osmOk,finished=false){
  const pct=total?Math.round(done/total*100):100,status=finished?'Verifica logistica completata':`Verifica logistica: ${done}/${total} eventi`;
  const note=!osmOk?' · OSM parziale: alcuni eventi possono risultare non verificati':'';
  return `<div class="aircraft-progress" role="status"><div class="aircraft-progress-head"><strong>${status}</strong><span>${pct}%${note}</span></div><div class="aircraft-progress-track"><span style="width:${pct}%"></span></div>${finished?'<small>Gli eventi geometrici sono stati mostrati subito; i dati logistici sono ora completi o marcati come fallback/non verificati.</small>':'<small>Gli eventi sono già consultabili mentre strada/parcheggio e distanza auto vengono completati.</small>'}</div>`;
}
function render(candidates,allCandidates,flightCount,bucket,days,code,osmOk,progress={done:0,total:0,finished:false}){
  $('summary').classList.remove('hidden');
  const roadFilter=$('roadDistanceFilter').selectedOptions[0]?.textContent||'Tutti',originFilter=$('originDistanceFilter').selectedOptions[0]?.textContent||'Tutte';
  $('summary').innerHTML=`<span><strong>${flightCount}</strong> movimenti analizzati</span><span><strong>${allCandidates.length}</strong> eventi geometrici totali</span><span><strong>${candidates.length}</strong> mostrati dai filtri</span><span>Strada/parcheggio: <strong>${escapeHtml(roadFilter)}</strong></span><span>Distanza partenza: <strong>${escapeHtml(originFilter)}</strong></span><span>Origine: <strong>${escapeHtml(ORIGINS[code].label)}</strong></span><span>OSM: <strong>${osmOk?'OK':'parziale/non disponibile'}</strong></span><span>Feed: <strong>${escapeHtml(bucket.status||'—')}</strong></span>`;
  if(!allCandidates.length){$('results').className='aircraft-empty';$('results').innerHTML='<strong>Nessun evento geometrico candidato nel periodo selezionato.</strong>';return}
  if(!candidates.length&&progress.finished){$('results').className='aircraft-empty';$('results').innerHTML=`${progressHtml(progress.done,progress.total,osmOk,true)}<strong>Nessun evento con questi filtri.</strong><br>Esistono eventi geometrici, ma nessuno soddisfa i filtri logistici selezionati.`;return}
  let lastDay='';
  const rows=candidates.map(c=>{
    const cf=confidence(c),f=c.flight,bodyCls=c.bodyKey==='sun'?'sun':'moon',key=dayKey(c.eventTime),separator=key!==lastDay?`<tr class="aircraft-day-row"><td colspan="13">${dayLabel(c.eventTime)}</td></tr>`:'';lastDay=key;
    return `${separator}<tr class="${c.logisticsState==='pending'?'aircraft-row-pending':''}"><td class="aircraft-body ${bodyCls}">${bodyHtml(c)}</td><td class="aircraft-time">${dtText(c.eventTime)}</td><td class="aircraft-flight"><strong>${escapeHtml(f.flight||'—')}</strong><small>${escapeHtml(f.route||'')} ${escapeHtml(f.airline||'')}</small></td><td>${movementLabel(f.movement)}</td><td class="aircraft-time">${timeText(new Date(f.expected_iso||f.scheduled_iso))}</td><td class="aircraft-time"><strong>≈ ${timeText(c.eventTime)}</strong><small>${cf.unc}</small></td><td><strong>RWY ${c.runway.label}</strong>${c.runway.preferred?'<small>preferenziale</small>':''}</td><td class="aircraft-num">${c.body.alt.toFixed(1)}°${c.bodyKey==='moon'?`<small>fase ${c.body.illum.toFixed(0)}%</small>`:''}</td><td class="aircraft-access-cell">${accessHtml(c)}</td><td class="aircraft-spot"><strong>${c.spot.lat.toFixed(5)}, ${c.spot.lon.toFixed(5)}</strong><small>${c.airportDist.toFixed(1)} km dall’aeroporto · modello ${f.movement==='arrival'?'finale 3°':'salita 4°'}</small><a class="aircraft-map" href="${eventMapsUrl(c)}" target="_blank" rel="noopener">Apri punto teorico ↗</a></td><td class="aircraft-drive">${drivingHtml(code,c)}</td><td class="aircraft-num">±${Math.round(c.halfWidth)} m</td><td><span class="aircraft-confidence ${cf.cls}">${cf.label}</span></td></tr>`;
  }).join('');
  $('results').className='aircraft-results-live';
  $('results').innerHTML=`${progressHtml(progress.done,progress.total,osmOk,progress.finished)}<div class="aircraft-table-wrap"><table class="aircraft-table"><thead><tr><th>Corpo</th><th>Data / evento</th><th>Volo</th><th>Movimento</th><th>Orario volo</th><th>Transito stimato</th><th>Pista ipotizzata</th><th>Alt. corpo</th><th>Distanza strada/parcheggio</th><th>Punto teorico</th><th>Distanza dal punto di partenza</th><th>Fascia</th><th>Confidenza</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function calculate(){
  if(!flightData)return;const serial=++calculationSerial;
  const code=$('airport').value,days=Number($('days').value),bodyFilter=$('bodyFilter').value,movement=$('movementFilter').value,roadFilter=$('roadDistanceFilter').value,originFilter=$('originDistanceFilter').value;
  const airport=AIRPORTS[code],bucket=flightData.airports?.[code];if(!bucket)return renderEmpty('Dati voli non disponibili per questo aeroporto.');
  const start=new Date(),end=new Date(start.getTime()+days*86400000);
  let flights=(bucket.flights||[]).filter(f=>{const t=new Date(f.expected_iso||f.scheduled_iso);return t>=start&&t<end&&VALID_FLIGHT.test(f.flight||'')&&(movement==='both'||f.movement===movement)});
  const dedupe=new Map();for(const f of flights){const key=`${f.movement}|${f.scheduled_iso}|${f.flight||''}`;if(!dedupe.has(key))dedupe.set(key,f)}flights=[...dedupe.values()];
  if(!flights.length&&/non disponibil|ultimo dato valido/i.test(bucket.status||''))return renderEmpty(`Feed voli non disponibile per ${AIRPORTS[code].name}: nessun movimento da analizzare. ${bucket.status||''}`);
  const bodies=bodyFilter==='both'?['sun','moon']:[bodyFilter],geometric=[];
  for(const flight of flights)for(const body of bodies)geometric.push(...candidatesForFlight(airport,flight,body));geometric.sort((a,b)=>a.eventTime-b.eventTime||b.score-a.score);
  if(!geometric.length){render([],[],flights.length,bucket,days,code,true,{done:0,total:0,finished:true});return}

  let osmOk=true,done=0;const total=geometric.length;
  render(geometric,geometric,flights.length,bucket,days,code,osmOk,{done,total,finished:false});
  await new Promise(r=>setTimeout(r,0));
  for(let i=0;i<geometric.length;i+=LOGISTICS_BATCH_SIZE){
    if(serial!==calculationSerial)return;const batch=geometric.slice(i,i+LOGISTICS_BATCH_SIZE);
    const batchOsmOk=await enrichAccessBatch(batch);if(!batchOsmOk)osmOk=false;if(serial!==calculationSerial)return;
    await enrichDrivingBatch(code,batch);if(serial!==calculationSerial)return;
    for(const c of batch)c.logisticsState='done';done=Math.min(total,i+batch.length);
    const filtered=geometric.filter(c=>matchesFilters(c,roadFilter,originFilter,code));
    render(filtered,geometric,flights.length,bucket,days,code,osmOk,{done,total,finished:done>=total});
    await new Promise(r=>setTimeout(r,0));
  }
}
function renderEmpty(text){$('summary').classList.add('hidden');$('results').className='aircraft-empty';$('results').textContent=text}
async function load(){
  try{const r=await fetch(`${DATA_URL}?v=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);flightData=await r.json();if(flightData.generated_at){const d=new Date(flightData.generated_at);$('dataAge').textContent=`Dati voli: ${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})`}calculate()}
  catch(e){$('results').className='aircraft-error';$('results').textContent=`Impossibile caricare gli orari voli: ${e.message}`}
}
load();
