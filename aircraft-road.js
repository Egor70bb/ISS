const OSRM_TABLE='https://router.project-osrm.org/table/v1/driving';
const ROUTE_TIMEOUT_MS=4000;
const ROUTE_BATCH_SIZE=40;

const ORIGINS={
  TRS:{label:"Terzo d'Aquileia",lat:45.800267,lon:13.346367},
  LIN:{label:'Piazzale Loreto · Milano',lat:45.486231,lon:9.216767}
};

let routeGeneration=0;
let debounceTimer=null;
let activeControllers=[];

function escapeHtml(v){
  return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function pointFromRow(row){
  const text=row.querySelector('.aircraft-spot strong')?.textContent||'';
  const m=text.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if(!m) return null;
  const lat=Number(m[1]),lon=Number(m[2]);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}

function routeLabel(code){
  return ORIGINS[code]?.label||'origine';
}

function setConfidenceHelp(root=document){
  root.querySelectorAll('.aircraft-confidence').forEach(el=>{
    const label=el.textContent.trim();
    let text='Confidenza = robustezza qualitativa della previsione geometrica, non probabilità matematica del transito.';
    if(label==='Medio-alta') text+=' Arrivo su pista preferenziale: traiettoria relativamente più prevedibile.';
    else if(label==='Media') text+=' Arrivo: finale relativamente prevedibile, ma pista effettiva e vettoramento possono cambiare.';
    else if(label==='Bassa') text+=' Partenza: salita iniziale e vettoramento ATC rendono la traiettoria più variabile.';
    el.title=text;
    el.setAttribute('aria-label',`${label}. ${text}`);
  });
}

function setRoadHeader(){
  document.querySelectorAll('.aircraft-table th').forEach(th=>{
    if(th.textContent.trim()==='Distanza origine') th.textContent='Distanza stradale';
  });
}

function markPending(item,code){
  const link=item.cell.querySelector('a.aircraft-map')?.outerHTML||'';
  item.link=link;
  item.cell.dataset.roadState='busy';
  item.cell.innerHTML=`<strong>⏳ calcolo…</strong><small>stradale da ${escapeHtml(routeLabel(code))}</small>${link}`;
}

function markUnavailable(item,code){
  item.cell.dataset.roadState='error';
  item.cell.innerHTML=`<strong>—</strong><small>distanza stradale non disponibile</small>${item.link||''}`;
}

function markResult(item,code,distanceM,durationS){
  item.cell.dataset.roadState='done';
  const km=distanceM/1000;
  const mins=Number.isFinite(durationS)?Math.round(durationS/60):null;
  item.cell.innerHTML=`<strong>${km.toFixed(1)} km${mins!==null?` · ${mins} min`:''}</strong><small>stradali da ${escapeHtml(routeLabel(code))}</small>${item.link||''}`;
}

async function fetchBatch(code,batch,generation){
  const origin=ORIGINS[code];
  if(!origin) return;
  const coords=[origin,...batch.map(x=>x.point)].map(p=>`${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const controller=new AbortController();
  activeControllers.push(controller);
  const timer=setTimeout(()=>controller.abort(),ROUTE_TIMEOUT_MS);
  try{
    const r=await fetch(`${OSRM_TABLE}/${coords}?sources=0&annotations=distance,duration`,{signal:controller.signal});
    if(generation!==routeGeneration) return;
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    const distances=data.distances?.[0],durations=data.durations?.[0];
    if(!Array.isArray(distances)||!Array.isArray(durations)) throw new Error('risposta routing non valida');
    batch.forEach((item,i)=>{
      const d=distances[i+1],t=durations[i+1];
      if(Number.isFinite(d)) markResult(item,code,d,t);
      else markUnavailable(item,code);
    });
  }catch(_){
    if(generation!==routeGeneration) return;
    batch.forEach(item=>markUnavailable(item,code));
  }finally{
    clearTimeout(timer);
    activeControllers=activeControllers.filter(c=>c!==controller);
  }
}

async function updateRoadDistances(){
  clearTimeout(debounceTimer);
  const results=document.getElementById('results');
  const airport=document.getElementById('airport');
  if(!results||!airport) return;
  const code=airport.value;
  if(!ORIGINS[code]) return;

  const rows=[...results.querySelectorAll('tbody tr:not(.aircraft-day-row)')];
  const items=[];
  for(const row of rows){
    const cell=row.querySelector('.aircraft-drive');
    if(!cell||cell.dataset.roadState) continue;
    const point=pointFromRow(row);
    if(!point) continue;
    items.push({row,cell,point,link:''});
  }
  if(!items.length){
    setRoadHeader();
    setConfidenceHelp(results);
    return;
  }

  const generation=++routeGeneration;
  activeControllers.forEach(c=>c.abort());
  activeControllers=[];
  setRoadHeader();
  setConfidenceHelp(results);
  items.forEach(item=>markPending(item,code));

  for(let i=0;i<items.length;i+=ROUTE_BATCH_SIZE){
    if(generation!==routeGeneration) return;
    await fetchBatch(code,items.slice(i,i+ROUTE_BATCH_SIZE),generation);
  }
}

function scheduleUpdate(){
  clearTimeout(debounceTimer);
  debounceTimer=setTimeout(updateRoadDistances,60);
}

const results=document.getElementById('results');
if(results){
  new MutationObserver(scheduleUpdate).observe(results,{childList:true,subtree:true});
}
for(const id of ['airport','days','bodyFilter','movementFilter','calculateButton']){
  document.getElementById(id)?.addEventListener(id==='calculateButton'?'click':'change',()=>{
    routeGeneration++;
    activeControllers.forEach(c=>c.abort());
    activeControllers=[];
    scheduleUpdate();
  });
}

scheduleUpdate();
