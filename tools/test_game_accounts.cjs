const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('../browser/node_modules/playwright');
const base=path.join(__dirname,'../browser');
const html=`<!doctype html><meta charset="utf-8"><meta name="ournotes-api-base" content=""><link rel="stylesheet" href="/site-shell.css"><div class="profilebar"></div><button id="siteMenuToggle" class="site-menu-toggle" aria-expanded="false"><span class="site-menu-lines"><i></i><i></i><i></i></span></button><nav class="tabs" id="siteMenu" hidden><button data-tab="plan">组卡</button></nav><div id="gameAccountsRoot"></div><script type="module">
import {mountGameAccounts} from '/game-accounts.js';import {mountSiteShell} from '/site-shell.js';import {createProfileStorage} from '/profile-storage.js';import * as cloud from '/cloud-api.js';import {saveRecord,loadScores} from '/b25-ui.js';
window.Planner={scope:'/'};let state={schema_version:1,name:'manual',profile:{inventory:{members:[],snaps:[]}}};let busy=false;
const storage=createProfileStorage('ournotes-browser-planner-v1-profile:/',()=>{},()=>{});storage.load();
window.PlannerProfile={document:()=>structuredClone(state),empty:()=>({schema_version:1,name:'empty',profile:{inventory:{members:[],snaps:[]}}}),canInstall:()=>!busy,storage,install:doc=>{if(busy)return false;state=structuredClone(doc);return storage.save(JSON.stringify(state));}};
const db=await new Promise(resolve=>{const r=indexedDB.open('test-state',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);});mountSiteShell();await mountGameAccounts(db);
window.test={cloud,saveRecord,loadScores,state:()=>state,busy:value=>busy=value,doc:(uid,name)=>({schema_version:1,name,account_import:{account_id_text:uid,account_id:uid},profile:{inventory:{members:[{id:1}],snaps:[]}}}),write:doc=>window.PlannerProfile.install(doc)};window.ready=true;
</script>`;
let accounts=[],results=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');const send=x=>res.end(JSON.stringify(x));
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
 if(url.pathname==='/api/game-accounts'){
  let b={};if(req.method!=='GET'){let raw='';for await(const c of req)raw+=c;b=JSON.parse(raw);}
  if(req.method==='POST'){const uid=b.document.account_import.account_id_text;if(!accounts.some(a=>a.uid===uid))accounts.push({uid,name:b.document.name});}
  if(req.method==='PUT')accounts=b.order.map(uid=>accounts.find(a=>a.uid===uid));return send(accounts);
 }
 if(url.pathname.startsWith('/api/game-accounts/')&&req.method==='DELETE'){accounts=accounts.filter(a=>a.uid!==url.pathname.split('/').pop());return send({deleted:0});}
 if(url.pathname==='/api/results')return send(results);
 const file=path.join(base,url.pathname.slice(1));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)){res.statusCode=404;return send({error:'not_found'});}
 res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
 assert.equal(await page.locator('[data-select]').count(),0);
 await page.locator('#siteMenuToggle').click();assert.equal(await page.locator('#siteMenu').isVisible(),true);await page.waitForTimeout(250);assert.equal(await page.locator('.site-menu-lines').evaluate(el=>getComputedStyle(el).transform),'matrix(0, 1, -1, 0, 0, 0)');await page.keyboard.press('Escape');await page.locator('#siteMenu').waitFor({state:'hidden'});assert.equal(await page.locator('#siteMenu').isVisible(),false);
 const ball=await page.locator('#siteMenuToggle').boundingBox();
 await page.mouse.move(ball.x+26,ball.y+26);await page.mouse.down();await page.mouse.move(300,110,{steps:8});await page.mouse.up();
 assert.equal(await page.locator('#siteMenu').isVisible(),false,'drag must not open menu');
 const moved=await page.locator('#siteMenuToggle').boundingBox();assert(moved.y<200&&moved.x>200);
 await page.locator('#siteMenuToggle').click();const menuBox=await page.locator('#siteMenu').boundingBox();assert(menuBox.x>=0&&menuBox.x+menuBox.width<=390);
 assert.equal(await page.locator('#siteMenu').evaluate(e=>e.getAnimations().length),1,'opening should animate');await page.keyboard.press('Escape');
 await page.locator('#siteMenu').waitFor({state:'hidden'});
 const free=await page.locator('#siteMenuToggle').boundingBox();await page.mouse.move(free.x+26,free.y+26);await page.mouse.down();await page.mouse.move(389,220,{steps:8});await page.mouse.up();
 assert.equal(await page.locator('#siteMenuToggle').getAttribute('data-docked'),'right');await page.waitForTimeout(400);
 await page.locator('#siteMenuToggle').click();await page.waitForTimeout(260);const drawer=await page.locator('#siteMenu').boundingBox();assert(drawer.x+drawer.width===390&&drawer.height===844,'docked menu is a full-height sidebar');
 await page.keyboard.press('Escape');assert.equal(await page.locator('#siteMenu').evaluate(e=>e.getAnimations().length),1,'closing animates');await page.locator('#siteMenu').waitFor({state:'hidden'});
 await page.locator('#siteMenuToggle').click();await page.keyboard.press('Escape');await page.locator('#siteMenuToggle').click();await page.waitForTimeout(300);assert.equal(await page.locator('#siteMenu').isVisible(),true,'interrupted close cannot hide reopened menu');await page.keyboard.press('Escape');await page.locator('#siteMenu').waitFor({state:'hidden'});
 const u='744532239894985508',v='744532239894985509';
 await page.evaluate(uid=>window.PlannerGameAccounts.importPackage(window.test.doc(uid,'First')),u);
 await page.evaluate(()=>window.test.saveRecord({accountId:window.PlannerGameAccounts.uid,entries:[{song_id:1}]}));
 await page.evaluate(uid=>window.PlannerGameAccounts.importPackage(window.test.doc(uid,'Second')),v);
 assert.equal(await page.locator('[data-select]').count(),2);assert.equal(await page.evaluate(()=>window.test.loadScores()),null);
 await page.evaluate(uid=>window.PlannerGameAccounts.importPackage(window.test.doc(uid,'Second updated')),v);assert.equal(await page.locator('[data-select]').count(),2);
 await page.locator('[data-select="'+u+'"]').click();assert.equal(await page.evaluate(()=>window.test.state().name),'First');assert.equal(await page.evaluate(()=>window.test.loadScores().accountId),u);
 await page.locator('[data-up="'+v+'"]').click();assert.equal(await page.locator('[data-select]').first().getAttribute('data-select'),v);
 await page.locator('[data-remove="'+u+'"]').click();assert.equal(await page.locator('#deleteGameAccount').isVisible(),true);const symmetry=await page.locator('.game-delete-actions').evaluate(e=>{const r=e.getBoundingClientRect(),a=e.children[0].getBoundingClientRect(),b=e.children[1].getBoundingClientRect();return Math.abs((a.x+a.width/2)+(b.x+b.width/2)-(2*r.x+r.width));});assert(symmetry<1);await page.locator('#deleteGameAccount button[value=no]').click();assert.equal(await page.locator('[data-select]').count(),2);
 await page.locator('[data-remove="'+u+'"]').click();await page.locator('#deleteGameAccount button[value=yes]').click();await page.waitForFunction(uid=>window.PlannerGameAccounts.uid!==uid,u);assert.equal(await page.locator('[data-select]').count(),1);assert.equal(await page.evaluate(()=>window.test.loadScores()),null);
 await page.evaluate(()=>window.test.busy(true));const blocked=await page.evaluate(async uid=>{try{await window.PlannerGameAccounts.importPackage(window.test.doc(uid,'Blocked'));return false;}catch{return true;}},u);assert.equal(blocked,true);await page.evaluate(()=>window.test.busy(false));
 await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await page.evaluate(()=>window.PlannerGameAccounts.uid),v);assert.equal(await page.evaluate(()=>window.test.state().name),'Second updated');
 // Changing website accounts clears game data before any new cloud lookup.
 await page.evaluate(()=>{localStorage.setItem('ournotes-cloud-token','test');localStorage.setItem('ournotes-cloud-account',JSON.stringify({id:'owner-two',username:'two'}));});
 await page.evaluate(()=>window.PlannerGameAccounts.syncIdentity());assert.equal(await page.evaluate(()=>window.PlannerGameAccounts.uid),'');assert.equal(await page.evaluate(()=>window.test.state().profile.inventory.members.length),0);
 await page.evaluate(uid=>{
   const original=window.fetch;window.fetch=(url,options)=>String(url).includes('/api/game-accounts')&&options?.method==='POST'?new Promise(resolve=>window.releaseRegister=()=>resolve(new Response('[]',{headers:{'Content-Type':'application/json'}}))):original(url,options);
   window.pendingImport=window.PlannerGameAccounts.importPackage(window.test.doc(uid,'Old owner')).then(()=>false,()=>true);
 },u);
 await page.waitForFunction(()=>window.releaseRegister);
 await page.evaluate(()=>{localStorage.setItem('ournotes-cloud-account',JSON.stringify({id:'owner-three',username:'three'}));});await page.evaluate(()=>window.PlannerGameAccounts.syncIdentity());await page.evaluate(()=>window.releaseRegister());assert.equal(await page.evaluate(()=>window.pendingImport),true);assert.equal(await page.locator('[data-select]').count(),0);
 await page.evaluate(async()=>{
  window.test.busy(true);localStorage.setItem('ournotes-cloud-account',JSON.stringify({id:'owner-four',username:'four'}));
  const switching=window.PlannerGameAccounts.syncIdentity();await new Promise(r=>setTimeout(r,50));
  if(window.PlannerGameAccounts.owner!=='owner-three')throw Error('Changed identity before the running calculation ended');
  window.test.busy(false);await switching;
 });assert.equal(await page.evaluate(()=>window.PlannerGameAccounts.owner),'owner-four');
 assert.deepEqual(errors,[]);console.log('PASS: mobile menu rotation/Escape, package-only creation, exact UID dedup, account/B25 isolation, ordering, deletion cancel/confirm, busy guard, reload, website-user isolation, in-flight import ownership and deferred identity switch');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
