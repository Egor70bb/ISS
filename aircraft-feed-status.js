const FEED_URL='./data/aircraft-flights.json';
const AIRPORT_LABEL={TRS:'Ronchi dei Legionari',LIN:'Milano Linate'};
let feedPayload=null;

function minutesAgo(iso){
  if(!iso) return null;
  const t=new Date(iso).getTime();
  if(!Number.isFinite(t)) return null;
  return Math.max(0,Math.round((Date.now()-t)/60000));
}
function formatStamp(iso){
  if(!iso) return '—';
  const d=new Date(iso);
  if(!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function selectedBucket(){
  const code=document.getElementById('airport')?.value;
  return {code,bucket:feedPayload?.airports?.[code]};
}
function updateAge(){
  if(!feedPayload) return;
  const el=document.getElementById('dataAge');
  if(!el) return;
  const {code,bucket}=selectedBucket();
  if(!bucket) return;
  const iso=bucket.updated_at||feedPayload.generated_at;
  const age=minutesAgo(iso);
  const stale=age!==null&&age>75;
  el.textContent=`Feed ${AIRPORT_LABEL[code]||code}: ${formatStamp(iso)}${age===null?'':` · ${age} min fa`}${stale?' ⚠️':''}`;
  el.title=bucket.status||'';
}
function explainEmptyFeed(){
  if(!feedPayload) return;
  const {code,bucket}=selectedBucket();
  if(!bucket||Array.isArray(bucket.flights)&&bucket.flights.length) return;
  const status=String(bucket.status||'');
  if(!/non disponibil|ultimo dato valido|fallback/i.test(status)) return;
  const results=document.getElementById('results');
  const summary=document.getElementById('summary');
  if(!results) return;
  const marker=`${code}|${status}`;
  if(results.dataset.feedExplained===marker) return;
  const text=(results.textContent||'').toLowerCase();
  if(!text.includes('nessun')&&!text.includes('0')&&!text.includes('completato')) return;
  if(summary) summary.classList.add('hidden');
  results.dataset.feedExplained=marker;
  results.className='aircraft-error';
  results.innerHTML=`<strong>Feed voli ${AIRPORT_LABEL[code]||code} non disponibile.</strong><br>Nessun movimento è disponibile da analizzare: quindi “0 eventi” non è un risultato geometrico. Stato feed: ${status.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}.`;
}
function refresh(){updateAge();setTimeout(explainEmptyFeed,80);}

async function loadFeedStatus(){
  try{
    const r=await fetch(`${FEED_URL}?status=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) return;
    feedPayload=await r.json();
    refresh();
    const results=document.getElementById('results');
    if(results) new MutationObserver(()=>refresh()).observe(results,{childList:true,subtree:true,characterData:true});
    document.getElementById('airport')?.addEventListener('change',()=>{if(results)delete results.dataset.feedExplained;refresh();});
    document.getElementById('calculateButton')?.addEventListener('click',()=>{if(results)delete results.dataset.feedExplained;setTimeout(refresh,120);});
    setInterval(updateAge,60000);
  }catch(_){/* aircraft.js mostra già gli errori principali */}
}

document.readyState==='loading'?document.addEventListener('DOMContentLoaded',loadFeedStatus):loadFeedStatus();
