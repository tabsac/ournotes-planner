const http=require('http'),fs=require('fs'),path=require('path');
const base=path.join(__dirname,'../browser');
const doc=n=>({schema_version:1,name:'synthetic',profile:{inventory:{members:[{id:n}],snaps:[]}}});
let remote=doc(1),version=1,posts=0,puts=0;
const html=`<!doctype html><meta charset="utf-8"><meta name="ournotes-api-base" content=""><h1>隔离冲突 UI 回归（模拟数据）</h1><button id="makeConflict">制造两端冲突</button><div><button id="cloudBadge">账号</button></div><div id="cloudRoot"></div><pre id="evidence"></pre><script type="module">
import {attachProfileCloud,reconcile} from './profile-cloud.js';import {mountCloudPanel} from './cloud-ui.js';
localStorage.clear();localStorage.setItem('ournotes-cloud-token','synthetic');localStorage.setItem('ournotes-cloud-account',JSON.stringify({id:'test',username:'synthetic'}));let local=${JSON.stringify(doc(1))};
localStorage.setItem('ournotes-cloud-profile',JSON.stringify({id:'a',accountId:'test',version:1,fingerprint:JSON.stringify(local)}));
attachProfileCloud({getDocument:()=>structuredClone(local),installDocument:x=>{local=structuredClone(x);return true;}});mountCloudPanel(document.getElementById('cloudRoot'));
document.getElementById('makeConflict').onclick=async()=>{local=${JSON.stringify(doc(2))};await fetch('/test-mutate',{method:'POST'});await reconcile();};
setInterval(async()=>{let c=await (await fetch('/test-counters')).json();document.getElementById('evidence').textContent=JSON.stringify({...c,localMember:local.profile.inventory.members[0].id});},300);
</script>`;
http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
 const send=x=>res.end(JSON.stringify(x));
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
 if(['/cloud-api.js','/profile-cloud.js','/cloud-ui.js'].includes(url.pathname)){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(base,url.pathname.slice(1))));}
 if(url.pathname==='/api/me')return send({id:'test',username:'synthetic',created_at:1});
 if(url.pathname==='/test-mutate'){version++;remote=doc(version+2);return send({ok:true});}
 if(url.pathname==='/test-counters')return send({posts,puts,remoteMember:remote.profile.inventory.members[0].id,version});
 if(url.pathname==='/api/results'&&req.method==='GET')return send([{id:'a',title:'个人卡库 · synthetic',version}]);
 if(['/api/results/a','/api/results/new'].includes(url.pathname)&&req.method==='GET')return send({id:url.pathname.split('/').pop(),title:'个人卡库 · synthetic',version,payload:{kind:'profile',document:remote}});
 if(url.pathname.startsWith('/api/results')&&['POST','PUT'].includes(req.method)){let data='';for await(const x of req)data+=x;let b=JSON.parse(data);if(req.method==='POST')posts++;else puts++;remote=b.payload.document;version++;return send({id:req.method==='POST'?'new':'a',version});}
 res.statusCode=404;send({error:'not_found'});
}).listen(8766,'127.0.0.1',()=>console.log('isolated UI test at http://127.0.0.1:8766/'));
