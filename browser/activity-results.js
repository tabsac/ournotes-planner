import * as cloud from './cloud-api.js';
import {ACTIVITY_MODEL} from './activity-model.js';
export function canonical(x) {return JSON.stringify(sort(x));}
function sort(x) {if(Array.isArray(x)) return x.map(sort); if(x && typeof x==='object') return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])); return x;}
export async function fingerprint(inputs) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({model:ACTIVITY_MODEL,inputs}))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function valid(a) {return !!(a?.kind==='activity' && a.schema_version===1 && a.model===ACTIVITY_MODEL && /^[a-f0-9]{64}$/.test(a.fingerprint) && a.actual_inputs && a.display?.members && a.display?.snaps && (a.result?.plans?.event_pt && a.result?.plans?.shop_pt || a.result?.search?.complete===true && ["challenge_score","challenge_skip","cp","event_pt","shop_pt"].includes(a.result?.goal?.id) && Array.isArray(a.result?.recommendations) && a.result.recommendations.length>0 && a.result.recommendations.every(r=>r.member_ids?.length===5&&r.snap_ids?.length===5&&Number.isFinite(r.target_value))));}
export function createActivityStore(database,scope) {
 const owner=()=>cloud.token() && cloud.currentAccount()?.id || 'local';
 const key=who=>'activity:'+who;
 const read=who=>new Promise((resolve,reject)=>{const r=database.transaction('state').objectStore('state').get(key(who));r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});
 const write=(who,rows)=>new Promise((resolve,reject)=>{const tx=database.transaction('state','readwrite');tx.objectStore('state').put(rows,key(who));tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});
 let chain=Promise.resolve();
 function status(text,error=false) {let el=document.getElementById('activitySaveStatus');if(!el){el=document.createElement('div');el.id='activitySaveStatus';el.className='notice';el.setAttribute('role','status');document.getElementById('browserLoading').after(el);}el.className='notice'+(error?' error':'');el.textContent=text;}
 async function remote(who,hash) {
  if(who==='local'||owner()!==who||!cloud.isConfigured()) return null;
  const rows=await cloud.listResults();
  if(owner()!==who) return null;
  const row=rows.find(r=>r.kind==='activity' && r.summary==='activity:'+hash);
  if(!row) return null;
  const value=await cloud.getResult(row.id);
  if(owner()!==who || !valid(value.payload) || value.payload.fingerprint!==hash) return null;
  return value;
 }
 async function upload(who,a) {
  if(owner()!==who||who==='local'||!cloud.isConfigured()) return;
  const existing=await remote(who,a.fingerprint);
  if(owner()!==who) return;
  if(existing) await cloud.updateResult(existing.id,{payload:a,version:existing.version});
  else await cloud.createResult({title:'活动组卡 · '+(a.result.goal?.label ? a.result.goal.label+' · ' : '')+(a.actual_inputs.name||'我的卡库'),summary:'activity:'+a.fingerprint,payload:a});
  if(owner()===who) status('计算结果已保存到云端；可发送 /on活动组卡 查看图片。');
 }
 async function save(who,a) {
  chain=chain.catch(()=>{}).then(async()=>{
   let localSaved=true;
   try {const rows=await read(who);await write(who,[a,...rows.filter(r=>r.fingerprint!==a.fingerprint)].slice(0,12));}
   catch {localSaved=false;status('计算已完成，但本地保存失败。请导出本次结果。',true);}
   if(who==='local'){if(localSaved) status('计算结果已保存在本机。登录网页账号后再次点击计算，可保存到云端。');return;}
   try{await upload(who,a);}catch{if(owner()===who) status(localSaved?'计算结果已保存在本机，云端保存未完成。请联网后点击“重试保存”。':'本地和云端保存均未完成，请先导出本次结果。',true);}
  });return chain;
 }
 async function lookup(inputs,who=owner()) {
  const hash=await fingerprint(inputs);
  let a;try{a=(await read(who)).find(a=>valid(a)&&a.fingerprint===hash);}catch{}
  if(!a && who!=='local') try{a=(await read('local')).find(a=>valid(a)&&a.fingerprint===hash);}catch{}
  if(!a) try{a=(await remote(who,hash))?.payload;}catch{}
  if(owner()!==who||!a||canonical(a.actual_inputs)!==canonical(inputs))return null;
  return a;
 }
 const store={owner,lookup,
  async accept(a){const who=owner();const inputs=window.PlannerActivity.current();if(!valid(a)||a.fingerprint!==await fingerprint(inputs)||canonical(a.actual_inputs)!==canonical(inputs)) throw Error('此方案与当前卡库、设置或模型不一致。请先恢复对应卡库与设置，再取回。');if(owner()!==who)throw Error('登录账号已改变，请重新取回。');if(!window.PlannerActivity.install(a))throw Error('请等待当前计算完成后再取回。');await save(who,{...a,savedAt:new Date().toISOString()});return true;},
  async complete(inputs,result,who) {const catalog=window.PlannerActivity.catalog();const rows=result.goal?result.recommendations:Object.values(result.plans).flatMap(p=>[p.normal,p.challenge]);const mids=new Set(rows.flatMap(r=>r.member_ids));const sids=new Set(rows.flatMap(r=>r.snap_ids));const display={members:catalog.members.filter(c=>mids.has(c.id)),snaps:catalog.snaps.filter(c=>sids.has(c.id)),songs:catalog.songs.map(c=>({id:c.id,title:c.title})),source:catalog.source};const a={kind:'activity',schema_version:1,model:ACTIVITY_MODEL,fingerprint:await fingerprint(inputs),savedAt:new Date().toISOString(),computedAt:new Date().toISOString(),actual_inputs:inputs,result,display};await save(who,a);return a;},
  async reuse(a,who=owner()){status('已恢复相同输入的计算结果，无需重新计算。');return save(who,{...a,savedAt:new Date().toISOString()});},
  async restore(){const inputs=window.PlannerActivity?.current();if(!inputs)return;const a=await lookup(inputs);if(a && canonical(window.PlannerActivity.current())===canonical(inputs)&&window.PlannerActivity.install(a)) {status('已恢复上次计算结果；输入变化后请重新计算。');}},
  async retry(){const inputs=window.PlannerActivity?.current();const a=inputs&&await lookup(inputs);if(a) await save(owner(),{...a,savedAt:new Date().toISOString()});else status('当前输入没有已完成的结果，请先完成计算。');}
 };
 cloud.onAuthChange(()=>{void store.restore();});
 return store;
}
