const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('../browser/node_modules/playwright');
let version=1,bundled=1;
const base=path.join(__dirname,'../browser');
const html=()=>`<meta name="ournotes-api-base" content=""><div id="browserLoading"></div><script type="module" src="/entry-${version}.js"></script>`;
const server=http.createServer((req,res)=>{
 const p=new URL(req.url,'http://localhost').pathname;
 res.setHeader('Content-Type','application/json');
 if(p==='/'||p==='/index.html'){res.setHeader('Content-Type','text/html');return res.end(html());}
 if(p.startsWith('/entry-')){res.setHeader('Content-Type','text/javascript');return res.end(`import {mountSiteUpdates} from '/site-updates.js';import {checkRemoteData,remoteDataState} from '/remote-data.js';window.busy=true;window.PlannerProfile={canInstall:()=>!window.busy};window.updates=mountSiteUpdates(()=>{}, {interval:999999,idle:0});window.data={checkRemoteData,remoteDataState};window.ready=true;`);}
 if(p==='/static-data/snapshot-digest.json')return res.end(JSON.stringify({songs:bundled,songsById:bundled===1?{'1':'1/1|1/1|1/1|1/1'}:{'1':'1/1|1/1|1/1|1/1','2':'1/1|1/1|1/1|1/1'},event:{id:bundled,startAt:'',endAt:''}}));
 if(p==='/data/version.json')return res.end(JSON.stringify({contentDigests:{songs:'same'}}));
 if(p==='/data/songs.json')return res.end(JSON.stringify({songs:[1,2].map(id=>({id,charts:['EASY','NORMAL','HARD','EXPERT'].map(name=>({name,level:1,combo:1}))}))}));
 if(p==='/data/events.json')return res.end(JSON.stringify({currentEventId:2,events:[{id:2,startAt:'',endAt:''}]}));
 const file=path.join(base,p.slice(1));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end('{}');}
 res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/#plan');await page.waitForFunction(()=>window.ready);
  await page.evaluate(()=>window.data.checkRemoteData());assert.equal(await page.evaluate(()=>window.data.remoteDataState().event.matches),false);
  bundled=2;await page.evaluate(()=>window.data.checkRemoteData());assert.equal(await page.evaluate(()=>window.data.remoteDataState().event.matches),true);assert.equal(await page.evaluate(()=>window.data.remoteDataState().songs.matches),true,'new bundle must invalidate old comparison despite unchanged remote content');
  await page.evaluate(()=>localStorage.setItem('keep-account','saved'));version=2;
  await page.evaluate(()=>window.updates.check());assert.equal(await page.locator('#siteUpdateNotice').count(),1);
  await page.waitForTimeout(2200);assert.equal(await page.locator('script[src="/entry-1.js"]').count(),1,'running calculation must postpone refresh');
  await page.evaluate(()=>window.busy=false);await page.waitForFunction(()=>!!document.querySelector('script[src="/entry-2.js"]'));await page.waitForFunction(()=>window.ready);
  assert.equal(await page.evaluate(()=>localStorage.getItem('keep-account')),'saved');assert.equal(new URL(page.url()).hash,'#plan');
  await page.evaluate(()=>{window.busy=false;});await page.evaluate(()=>window.updates.check());await page.waitForTimeout(2100);assert.equal(await page.locator('#siteUpdateNotice').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: stale comparison invalidation, busy deferral, actual automatic navigation, local data/hash preservation and no refresh loop');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
