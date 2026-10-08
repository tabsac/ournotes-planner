const fs=require('fs'), vm=require('vm'), assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'../browser/profile-cloud.js'),'utf8').replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/cloud-api.js";/,'').replace(/export /g,'');
const doc=n=>({name:'test',profile:{inventory:{members:[n],snaps:[]}}});
async function fixture(){
 let local=doc(1),remote=doc(1),link={id:'a',version:1,fingerprint:JSON.stringify(doc(1))},account={id:'one'},saves=0,profiles=[],installable=true,resolver=null;
 const timers=[];
 const c={CloudError:class extends Error{},currentAccount:()=>account,token:()=>account?'token-'+account.id:null,isConfigured:()=>true,linkedResult:()=>link,setLinkedResult:x=>link=x,preparePayload:x=>({payload:x}),listResults:async()=>profiles,getResult:async()=>({id:'a',version:2,payload:{document:structuredClone(remote)}}),saveLinkedResult:async ({payload})=>{saves++;if(resolver)await new Promise(r=>resolver=r);remote=structuredClone(payload.document);link={...link,version:3};return {id:'a',version:3};},setTimeout:f=>(timers.push(f),timers.length),clearTimeout:()=>{},setInterval:()=>1,window:{addEventListener:()=>{}},Date,JSON,Set};
 vm.createContext(c);vm.runInContext(source,c);
 c.attachProfileCloud({getDocument:()=>structuredClone(local),installDocument:x=>{if(!installable)return false;local=structuredClone(x);c.noteLocalSave();return true;}});
 return {c,timers,get local(){return local},set local(x){local=x},set remote(x){remote=x},get link(){return link},set link(x){link=x},set profiles(x){profiles=x},get saves(){return saves},set account(x){account=x},set installable(x){installable=x},hold(){resolver=true},release(){resolver()}};
}
(async()=>{
 let f=await fixture();f.remote=doc(2);await f.c.reconcile();assert.equal(f.local.profile.inventory.members[0],2);assert.equal(f.timers.length,0);assert.equal(f.c.profileSyncState().mode,'synced');
 f=await fixture();f.local=doc(3);await f.c.reconcile();assert.equal(f.c.profileSyncState().mode,'dirty');assert.equal(f.timers.length,1);await f.c.push();assert.equal(f.link.fingerprint,JSON.stringify(doc(3)));
 f=await fixture();f.local=doc(3);f.remote=doc(2);await f.c.reconcile();assert.equal(f.c.profileSyncState().mode,'conflict');assert.equal(f.saves,0);f.c.noteLocalSave();assert.equal(f.timers.length,0);
 f=await fixture();f.remote=doc(2);f.installable=false;await f.c.reconcile();assert.equal(f.local.profile.inventory.members[0],1);f.installable=true;await f.c.reconcile();assert.equal(f.local.profile.inventory.members[0],2);
 f=await fixture();f.hold();const pending=f.c.push();f.local=doc(4);f.c.noteLocalSave();f.release();await pending;assert.equal(f.c.profileSyncState().mode,'dirty');assert.equal(f.link.fingerprint,JSON.stringify(doc(1)));assert.ok(f.timers.length>=1);
 f=await fixture();f.hold();const old=f.c.push();f.account={id:'two'};f.release();await old;assert.notEqual(f.c.profileSyncState().mode,'synced');
 f=await fixture();f.link=null;f.local={profile:{inventory:{members:[],snaps:[]}}};f.profiles=[{id:'a',title:'个人卡库 · test'}];await f.c.onAuthChanged({id:'one'});assert.equal(f.local.profile.inventory.members[0],1);assert.equal(f.saves,0);assert.equal(f.c.profileSyncState().mode,'synced');
 f=await fixture();f.link=null;f.profiles=[{id:'a',title:'个人卡库 · test'}];await f.c.onAuthChanged({id:'one'});assert.equal(f.c.profileSyncState().mode,'conflict');assert.equal(f.c.profileSyncState().restoreId,'a');await assert.rejects(()=>f.c.push());assert.equal(f.saves,0);await f.c.keepLocalAsNew();assert.equal(f.saves,1);
 f=await fixture();f.link=null;f.local={profile:{inventory:{members:[],snaps:[]}}};f.profiles=[{id:'a',title:'个人卡库 · one'},{id:'b',title:'个人卡库 · two'}];await f.c.reconcile();assert.equal(f.c.profileSyncState().mode,'conflict');assert.equal(f.c.profileSyncState().profiles.length,2);assert.equal(f.saves,0);
 f=await fixture();f.link.fingerprint=undefined;f.local={profile:{inventory:{members:[],snaps:[]}}};await f.c.reconcile();assert.equal(f.c.profileSyncState().mode,'synced');assert.equal(f.saves,0);
 console.log('PASS 10 sync regressions: remote pull, offline upload, conflict, busy install, edits during upload, account switch');
})().catch(e=>{console.error(e);process.exitCode=1});
