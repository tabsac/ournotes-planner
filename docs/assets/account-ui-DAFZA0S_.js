const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./account-adb-Dm1qtQyP.js","./index-DeVEFOJ2.js","./index-hc-suH92.css","./b25-ui-Dd_8luhz.js"])))=>i.map(i=>d[i]);
import{_ as W}from"./index-DeVEFOJ2.js";import{saveScores as q}from"./b25-ui-Dd_8luhz.js";const M=F("b50b23a5fd628c3dc386f7488f81d6b0450b8c89671574f55a3ad815f10b8e30"),R=F("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6"),O=64,I=32;function F(n){const e=new Uint8Array(n.length/2);for(let r=0;r<e.length;r++)e[r]=parseInt(n.substr(r*2,2),16);return e}const L=new Uint8Array([99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22]),j=new Uint8Array(256);for(let n=0;n<256;n++)j[L[n]]=n;const J=[1,2,4,8,16,32,64,128,27,54,108,216,171,77,154];function Z(n){const e=J.slice();for(;e.length<n;){const r=e[e.length-1];let t=r<<1&255;r&128&&(t^=27),e.push(t)}return e}function y(n){const e=new Uint8Array(256);for(let r=0;r<256;r++){let t=r,s=n,o=0;for(;s;)s&1&&(o^=t),t=(t<<1^(t&128?283:0))&255,s>>=1;e[r]=o&255}return e}const k=y(9),A=y(11),B=y(13),P=y(14),N=y(2),E=y(3),D={4:[0,1,2,3],6:[0,1,2,3],8:[0,1,3,4]};class X{constructor(e,r=256){if(this.Nb=r/32,this.Nk=e.length/4,!D[this.Nb])throw new Error("不支持的分组长度 "+r);if(![4,6,8].includes(this.Nk))throw new Error("不支持的密钥长度");this.Nr=Math.max(this.Nb,this.Nk)+6,this.block=this.Nb*4,this.roundKeys=this.expand(e)}expand(e){const{Nb:r,Nk:t,Nr:s}=this,o=[];for(let a=0;a<t;a++)o.push([e[4*a],e[4*a+1],e[4*a+2],e[4*a+3]]);const d=r*(s+1),p=Z(Math.floor(d/t)+2);for(let a=t;a<d;a++){let c=o[a-1].slice();a%t===0?(c=[c[1],c[2],c[3],c[0]].map(i=>L[i]),c[0]^=p[a/t-1]):t>6&&a%t===4&&(c=c.map(i=>L[i])),o.push([0,1,2,3].map(i=>o[a-t][i]^c[i]))}const u=[];for(let a=0;a<=s;a++){const c=new Uint8Array(this.block);for(let i=0;i<r;i++)for(let l=0;l<4;l++)c[4*i+l]=o[a*r+i][l];u.push(c)}return u}decryptBlock(e){const r=this.Nb,t=Uint8Array.from(e),s=D[r],o=a=>{for(let c=0;c<t.length;c++)t[c]^=a[c]},d=()=>{const a=new Uint8Array(t.length);for(let c=0;c<4;c++){const i=s[c];for(let l=0;l<r;l++)a[4*((l+i)%r)+c]=t[4*l+c]}t.set(a)},p=()=>{for(let a=0;a<t.length;a++)t[a]=j[t[a]]},u=()=>{for(let a=0;a<r;a++){const c=4*a,i=t[c],l=t[c+1],x=t[c+2],f=t[c+3];t[c]=P[i]^A[l]^B[x]^k[f],t[c+1]=k[i]^P[l]^A[x]^B[f],t[c+2]=B[i]^k[l]^P[x]^A[f],t[c+3]=A[i]^B[l]^k[x]^P[f]}};o(this.roundKeys[this.Nr]);for(let a=this.Nr-1;a>0;a--)d(),p(),o(this.roundKeys[a]),u();return d(),p(),o(this.roundKeys[0]),t}decryptCbc(e,r){const t=new Uint8Array(e.length-e.length%this.block);let s=r;for(let o=0;o+this.block<=e.length;o+=this.block){const d=e.subarray(o,o+this.block),p=this.decryptBlock(d);for(let u=0;u<this.block;u++)t[o+u]=p[u]^s[u];s=d}return t}encryptBlock(e){const r=this.Nb,t=Uint8Array.from(e),s=D[r],o=a=>{for(let c=0;c<t.length;c++)t[c]^=a[c]},d=()=>{for(let a=0;a<t.length;a++)t[a]=L[t[a]]},p=()=>{const a=new Uint8Array(t.length);for(let c=0;c<4;c++){const i=s[c];for(let l=0;l<r;l++)a[4*((l-i+r)%r)+c]=t[4*l+c]}t.set(a)},u=()=>{for(let a=0;a<r;a++){const c=4*a,i=t[c],l=t[c+1],x=t[c+2],f=t[c+3];t[c]=N[i]^E[l]^x^f,t[c+1]=i^N[l]^E[x]^f,t[c+2]=i^l^N[x]^E[f],t[c+3]=E[i]^l^x^N[f]}};o(this.roundKeys[0]);for(let a=1;a<this.Nr;a++)d(),p(),u(),o(this.roundKeys[a]);return d(),p(),o(this.roundKeys[this.Nr]),t}}function G(n){if(!n||n.length<O+I)return!1;for(let e=0;e<32;e++)if(n[e]!==M[e])return!1;return!0}function Q(n,e=I){if(!n.length)return null;const r=n[n.length-1];if(r===0||r>e||r>n.length)return null;for(let t=n.length-r;t<n.length;t++)if(n[t]!==r)return null;return n.subarray(0,n.length-r)}function V(n){if(!G(n))return null;const e=n.subarray(O);if(e.length%I!==0)return null;const r=n.subarray(32,64);let t;try{t=new X(R,256).decryptCbc(e,r)}catch{return null}const s=Q(t);if(!s)return null;let o;try{o=new TextDecoder("utf-8",{fatal:!0}).decode(s)}catch{return null}const d=o.trim();if(!d.startsWith("{"))return null;try{return{json:tt(d),plain:s}}catch{return null}}function $(n){return!n||typeof n!="object"?null:n._player&&typeof n._player=="object"?n._player:null}const Y=/:\s*(\d{16,})(?=\s*[,}\]])/g;function tt(n){return JSON.parse(n.replace(Y,': "$1"'))}const C="ONPKG1:";function et(n){const e=atob(n),r=new Uint8Array(e.length);for(let t=0;t<e.length;t++)r[t]=e.charCodeAt(t);return r}async function nt(n){const e=new Blob([n]).stream().pipeThrough(new DecompressionStream("gzip"));return new TextDecoder().decode(await new Response(e).arrayBuffer())}function K(n){const e=t=>typeof t=="number"&&Number.isFinite(t)?t:0;return{player:{_name:typeof n.name=="string"?n.name:"",_accountid:e(n.aid),_memberCards:(n.m||[]).map(t=>({_masterId:e(t[0]),_exp:e(t[1]),_awakeCount:e(t[2])||1,_rank:e(t[3])||1,_liveSkillLevel:e(t[4])||1,_performanceSkillLevel:e(t[5])||1})),_supportCards:(n.s||[]).map(t=>({_masterId:e(t[0]),_exp:e(t[1]),_rank:e(t[2])||1,_duplicateCount:e(t[3])})),_characters:(n.c||[]).map(t=>({_masterId:e(t[0]),_exp:e(t[1])})),_characterFriendships:(n.f||[]).map(t=>({_pair:{_masterCharacterIdA:e(t[0]),_masterCharacterIdB:e(t[1])},_exp:e(t[2])})),_items:(n.i||[]).map(t=>({_masterItemId:e(t[0]),_amount:e(t[1])})),_bandItems:(n.b||[]).map(t=>({_masterId:e(t[0]),_level:e(t[1])}))},source:"手机取包工具"}}async function rt(n){const e=String(n||"").trim();if(!e)return null;if(e.startsWith(C)){const t=e.slice(C.length).replace(/\s+/g,"");let s;try{s=JSON.parse(await nt(et(t)))}catch{throw new Error("这段文本解不开，可能复制时被截断了。请重新复制完整的一段（以 ONPKG1: 开头）。")}return K(s)}const r=e.indexOf("{");if(r>=0){let t;try{t=JSON.parse(e.slice(r))}catch{return null}const s=$(t);if(s)return{player:s,source:"粘贴的 JSON"};if(Array.isArray(t.m)&&Array.isArray(t.c))return{...K(t),source:"粘贴的紧凑 JSON"}}return null}function at(n,e){const r=[];let t=0;for(const o of n){if(t++,e&&e(t,n.length,o.name),!o.bytes||o.bytes.length<O+I||o.bytes.length>64*1024*1024)continue;const d=V(o.bytes);d&&r.push({name:o.name,json:d.json})}const s=r.find(o=>$(o.json));return s?{name:s.name,player:$(s.json),all:r}:r.length?{name:null,player:null,all:r}:null}function T(n){let e="";for(const r of n)e+=r.toString(16).padStart(2,"0");return e}T(M),T(R);function m(n,e){return n.getUint16(e,!0)}function w(n,e){return n.getUint32(e,!0)}function ot(n){const e=Math.min(n.byteLength,65557);for(let r=n.byteLength-22;r>=n.byteLength-e&&!(r<0);r--)if(w(n,r)===101010256)return r;return-1}async function ct(n){const e=new DecompressionStream("deflate-raw"),r=new Blob([n]).stream().pipeThrough(e);return new Uint8Array(await new Response(r).arrayBuffer())}async function it(n,e){const r=new DataView(n.buffer,n.byteOffset,n.byteLength),t=ot(r);if(t<0)throw new Error("这不是一个 ZIP 压缩包（找不到目录结尾标记）。");const s=m(r,t+10);let o=w(r,t+16);const d=[];for(let p=0;p<s&&w(r,o)===33639248;p++){const u=m(r,o+8),a=m(r,o+10),c=w(r,o+20),i=m(r,o+28),l=m(r,o+30),x=m(r,o+32),f=w(r,o+42),b=new TextDecoder("utf-8").decode(n.subarray(o+46,o+46+i));if(u&1)throw new Error("压缩包带有密码保护，无法读取："+b);if(!b.endsWith("/")){const g=m(r,f+26),h=m(r,f+28),v=f+30+g+h,U=n.subarray(v,v+c);let S;if(a===0)S=U;else if(a===8)S=await ct(U);else throw new Error(`压缩包里有不支持的压缩方式（method=${a}）：${b}`);d.push({name:b,bytes:S}),e&&e(b,S.length)}o+=46+i+l+x}return d}function st(n){return n&&n.length>4&&n[0]===80&&n[1]===75&&(n[2]===3||n[2]===5||n[2]===7)}const H="com.bilibili.sirius.official",yt=`/sdcard/Android/data/${H}/files`,_=n=>String(n??"").replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e]);async function lt(n,e){const r=Array.from(n||[]),t=[];for(const s of r){if(!s||!s.size)continue;e(`读取 ${s.name}…`);const o=new Uint8Array(await s.arrayBuffer());if(st(o)){e(`解压 ${s.name}…`);const d=await it(o,p=>e(`解压 ${p}…`));for(const p of d)t.push({name:p.name,bytes:p.bytes})}else t.push({name:s.name,bytes:o})}return t}function z(n,e,r){const t=r==="members"?e.members:e.snaps,s=new Map(t.map(u=>[u.id,u])),o=n.inventory[r].map(u=>({row:u,card:s.get(u.id)})).filter(u=>u.card),d=u=>(u.card.rarity||0)*1e5+(u.row.level||0);if(r==="snaps")return o.sort((u,a)=>d(a)-d(u)).slice(0,5).map(u=>u.row.id);const p=new Map;for(const u of o){const a=u.card.character_id;(!p.has(a)||d(u)>d(p.get(a)))&&p.set(a,u)}return Array.from(p.values()).sort((u,a)=>d(a)-d(u)).slice(0,5).map(u=>u.row.id)}function dt(){try{const e=window.PlannerAccount?.current?.();if(e?.settings?.normal&&e?.settings?.challenge)return JSON.parse(JSON.stringify(e.settings))}catch{}const n=[100056,100063,100109].map(e=>({song_id:e,difficulty:"expert"}));return{boost_budget:20,boost_per_live:4,starting_cp:0,challenge_cp:200,normal:{song_id:100109,difficulty:"expert",method:"ap",sheets:n},challenge:{song_id:100109,difficulty:"expert",method:"ap",sheets:n}}}function ut(n,e,r){const t=new Set(n.inventory.members.map(d=>d.id)),s=new Set(n.inventory.snaps.map(d=>d.id)),o={candidate_member_ids:z(n,r,"members").filter(d=>t.has(d)),candidate_snap_ids:z(n,r,"snaps").filter(d=>s.has(d))};return{schema_version:1,name:e?.player_name?`${e.player_name} 的账号包`:"账号包导入",profile:n,settings:dt(),...o,account_import:{account_id:e?.account_id??null,member_count:e?.member_count??n.inventory.members.length,snap_count:e?.snap_count??n.inventory.snaps.length,character_count:e?.character_count??n.character_ranks.length,character_total_rank:n.character_total_rank,warnings:e?.warnings||[]}}}function xt(n,e){if(!e||!n?.available){const t=(n?.notes||[]).map(s=>`<li>${_(s)}</li>`).join("");return t?`<div class="notice"><b>B25 成绩：取不到</b><ul>${t}</ul></div>`:""}const r=n.stats||{};return`<div class="b25-teaser">
  <div>
    <b>B25 成绩已保存</b>
    <span class="b25-teaser-line">共 ${r.count} 首　FC ${r.fc_count} / AP ${r.ap_count}
      　Rating <b>${(Math.round(r.rating_avg*100)/100).toFixed(2)}</b>
      <span class="b25-teaser-note">（谱面等级平均）</span></span>
  </div>
  <a href="#b25" class="button-link primary" data-goto="b25">去 B25 成绩页看图 / 导出</a>
</div>`}function ft(n){n&&n.querySelectorAll("[data-goto]").forEach(e=>{e.addEventListener("click",r=>{r.preventDefault();const t=e.dataset.goto;document.querySelectorAll(".tab-page").forEach(s=>s.hidden=s.id!==t),document.querySelectorAll(".tabs button").forEach(s=>s.classList.toggle("active",s.dataset.tab===t)),history.replaceState(null,"","#"+t)})})}function gt(n){if(!n)return;n.innerHTML=`
<div class="panel">
  <div class="section-kicker">一键导入 / 全部在浏览器本地完成</div>
  <h2>从游戏账号包导入卡库</h2>
  <p>账号包是游戏保存在手机里的账号数据文件（加密的）。本页在你的浏览器里解密并读出卡牌、等级、觉醒与特训，
     再把结果填进「我的卡库」，省掉逐张手填。文件不会上传到任何服务器。</p>

  <div class="account-actions">
    <a class="button-link primary" href="./downloads/ournotes-取包工具.zip" download>① 下载电脑取包工具（安卓 · 推荐）</a>
    <a class="button-link" href="./downloads/ournotes-box.apk" download>下载手机端 App（安卓 · 需「无线调试」）</a>
  </div>
  <p class="tiny muted">取包工具是免安装的 Windows 小工具（已内置 adb，不用 root、不用装驱动），
     解压后双击 <code>取包.bat</code>，它会自动找到手机上的账号包并打成 zip，把那个 zip 拖回本页即可。
     详见 <a href="./downloads/取包工具-使用说明.txt" target="_blank" rel="noopener">使用说明</a>。</p>

  <div class="account-actions">
    <button id="accountPickFiles" type="button">选择文件 / zip</button>
    <button id="accountPickDir" type="button">选择游戏文件夹</button>
    <button id="accountAdb" type="button">浏览器直连手机（部分机型可用）</button>
  </div>

  <div id="accountDrop" class="account-drop">
    <strong>把账号包文件、或整个文件夹压缩成的 zip，拖到这里</strong>
    <span>支持：单个账号包文件、包含账号包的文件夹、zip 压缩包</span>
  </div>

  <div class="account-paste">
    <label for="accountPaste"><b>或者：粘贴手机端 App（Shizuku）生成的那段文本</b>
      <span class="muted">（只有走「手机端 App」那条路才会有这个 —— 那段文字不到 1 KB，用微信/QQ 发到电脑上复制粘贴即可，不用传文件）</span></label>
    <textarea id="accountPaste" rows="4" spellcheck="false"
      placeholder="以 ONPKG1: 开头的一小段文字，粘贴到这里"></textarea>
    <button id="accountPasteGo" type="button" class="primary">导入粘贴的文本</button>
  </div>

  <details class="account-help">
    <summary><b>第一次用？点开看取包教程</b>（安卓 / iOS，含连不上手机的排查）</summary>
    <div id="accountHelpBody"></div>
  </details>

  <div id="accountStatus" class="notice" hidden></div>
  <div id="accountReport" hidden></div>
</div>`;const e=i=>n.querySelector("#"+i),r=(i,l="")=>{const x=e("accountStatus");x.hidden=!i,x.textContent=i||"",x.className="notice "+l},t=e("accountReport"),s=document.createElement("input");s.type="file",s.multiple=!0,s.hidden=!0;const o=document.createElement("input");o.type="file",o.multiple=!0,o.webkitdirectory=!0,o.hidden=!0,n.append(s,o);async function d(i){t.hidden=!0;try{const l=await lt(i,x=>r(x));if(!l.length){r("没有读到任何文件。","error");return}await p(l)}catch(l){r("读取失败："+(l?.message||l),"error")}}async function p(i){r(`正在识别账号包（${i.length} 个文件）…`);const l=i.filter(f=>G(f.bytes));if(!l.length){r("这些文件里没有找到账号包。（账号包是游戏保存在手机里的数据文件，不是截图、也不是抓包记录。）","error");return}const x=at(l,(f,b,g)=>r(`解密 ${f}/${b}：${g}…`));if(!x||!x.player){r("找到了疑似账号包，但里面没有玩家数据。可能选错了目录。","error");return}r("解密成功，正在按当前主数据换算等级…"),await u(x.player,x.name)}async function u(i,l){const f=await(await window.plannerFetch("/api/account-import",{method:"POST",body:JSON.stringify({player:i})})).json();if(f.error){r("换算失败："+f.error,"error");return}r(""),a(f,l)}function a(i,l){const{profile:x,report:f}=i,b=(f.warnings||[]).map(h=>`<li>${_(h)}</li>`).join("");t.hidden=!1,t.innerHTML=`
<div class="panel account-report">
  <h3>识别结果</h3>
  <p class="account-source">来源文件：<code>${_(l)}</code>　玩家：<b>${_(f.player_name||"（未命名）")}</b>
     ${f.account_id_text?`　ID：<code>${_(f.account_id_text)}</code>`:""}</p>
  <table class="account-summary">
    <tbody>
      <tr><th>成员卡</th><td>${x.inventory.members.length} 张</td></tr>
      <tr><th>留影卡（Snap）</th><td>${x.inventory.snaps.length} 张</td></tr>
      <tr><th>角色</th><td>${x.character_ranks.length} 位，总角色等级 ${x.character_total_rank}</td></tr>
      <tr><th>乐队道具</th><td>${x.facilities.length} 项</td></tr>
      <tr><th>T.G.W CARD 等级</th><td>${x.tgw_card_rank}</td></tr>
    </tbody>
  </table>
  ${b?`<div class="notice"><b>注意：</b><ul>${b}</ul></div>`:""}
  <div id="accountB25" class="account-b25-slot"></div>
  <p>导入后会替换当前的「我的卡库」。候选卡池默认取每位角色最强的一张（成员卡 5 张）和 5 张留影卡，
     导入后可以在「我的卡库」里勾选更多。</p>
  <div class="account-actions">
    <button id="accountApply" type="button" class="primary">合并进卡库</button>
    <button id="accountDiscard" type="button">取消</button>
  </div>
</div>`;const g=q(i.scores,{playerName:f.player_name,accountId:f.account_id_text||f.account_id,source:l});t.querySelector("#accountB25").innerHTML=xt(i.scores,g),ft(t.querySelector("#accountB25")),t.querySelector("#accountApply").addEventListener("click",()=>{try{const h=window.PlannerAccount.catalog(),v=ut(x,f,h);window.PlannerAccount.apply(v,"账号包已导入，请核对实际养成后计算。")}catch(h){r("导入失败："+(h?.message||h),"error")}}),t.querySelector("#accountDiscard").addEventListener("click",()=>{t.hidden=!0,r("")})}e("accountPickFiles").addEventListener("click",()=>s.click()),e("accountPickDir").addEventListener("click",()=>o.click()),s.addEventListener("change",()=>d(s.files)),o.addEventListener("change",()=>d(o.files)),e("accountPasteGo").addEventListener("click",async()=>{t.hidden=!0;try{r("正在解析粘贴的文本…");const i=await rt(e("accountPaste").value);if(!i){r("认不出这段文本。请确认复制的是取包工具生成的那一整段（以 ONPKG1: 开头）。","error");return}r("解析成功，正在按当前主数据换算等级…"),await u(i.player,i.source)}catch(i){r("导入失败："+(i?.message||i),"error")}});const c=e("accountDrop");for(const i of["dragenter","dragover"])c.addEventListener(i,l=>{l.preventDefault(),c.classList.add("over")});for(const i of["dragleave","drop"])c.addEventListener(i,()=>c.classList.remove("over"));c.addEventListener("drop",i=>{i.preventDefault();const l=i.dataTransfer?.files;l?.length&&d(l)}),e("accountAdb").addEventListener("click",async i=>{const l=i.currentTarget;l.disabled=!0;try{const{readAccountFromDevice:x}=await pt(),f=await x(b=>r(b));if(!f.length){r("没有从手机里读到账号包文件。","error");return}await p(f)}catch(x){r("读取手机失败："+(x?.message||x),"error")}finally{l.disabled=!1}}),e("accountHelpBody").innerHTML=bt()}async function pt(){const n="ournotes-account-adb-reloaded";try{return await W(()=>import("./account-adb-Dm1qtQyP.js"),__vite__mapDeps([0,1,2,3]),import.meta.url)}catch(e){const r=String(e?.message||e);throw/dynamically imported module|Importing a module script failed/i.test(r)&&!sessionStorage.getItem(n)&&(sessionStorage.setItem(n,"1"),location.reload(),await new Promise(()=>{})),e}}function bt(){return`
<p><b>账号包是什么</b>：游戏保存在手机里的账号数据文件，路径是</p>
<pre>Android/data/${H}/files/&lt;一串64位十六进制&gt;/</pre>
<p>里面有三个文件，都是加密的，本页负责解密。目录名和文件名都是内容哈希、会随版本变，
   所以本页不靠文件名认，而是逐个尝试解密，取能解出玩家数据的那一份。</p>

<h4>安卓：电脑取包工具（推荐）</h4>
<ol>
  <li>下载并解压 <a href="./downloads/ournotes-取包工具.zip" download>ournotes-取包工具.zip</a>（免安装，已内置 adb）</li>
  <li>手机上打开开发者选项里的 <b>USB 调试</b>，并且把
      <b>「『仅充电』模式下允许 ADB 调试」</b>也打开（不少华为手机默认关着，不开的话电脑上根本不会出现 ADB 接口）</li>
  <li>用数据线连到电脑，手机弹出「允许 USB 调试吗？」时勾选<b>始终允许</b>再点允许</li>
  <li>双击解压出来的 <code>取包.bat</code>，它会自动找到手机上的账号包，打包成 <code>账号包.zip</code> 并帮你打开所在文件夹</li>
  <li>把 <code>账号包.zip</code> 拖回本页</li>
</ol>
<p>为什么推荐它：内置了 adb，不需要 root，也不需要装驱动或手机助手，更不受浏览器对 USB 设备的限制。
   详细排查见压缩包里的「使用说明.txt」。</p>

<h4>连不上手机？按顺序排查</h4>
<p><b>手机端</b></p>
<ol>
  <li>「USB 调试」确认已打开，<b>「『仅充电』模式下允许 ADB 调试」也要打开</b>。</li>
  <li>下拉通知栏，把 USB 用途从「仅充电」改成<b>传输文件</b>。</li>
  <li>开发者选项里点一次<b>撤销 USB 调试授权</b>，拔掉数据线重插，再看手机屏幕有没有新的授权弹窗。</li>
</ol>
<p><b>线材与接口</b></p>
<ol start="4">
  <li>换一根线。很多线只能充电、不能传数据，这是最常见的原因。</li>
  <li>换一个 USB 口。台式机优先插主板后面板的口，别用前面板或 USB Hub。</li>
</ol>
<p><b>驱动</b></p>
<ol start="6">
  <li>最省事的办法：装一次手机厂商的 PC 助手（华为手机助手等），让它把 USB 驱动装好，
      装完<b>关掉它</b>再运行取包工具（它可能占用手机连接）。</li>
  <li>如果你以前用 Zadig 之类的工具给这台手机换过驱动（比如为了试 WebUSB），
      必须先把那些驱动删干净 —— 否则 Windows 里连 ADB 接口都不会出现，插上手机也没反应。</li>
</ol>

<h4>如果以前用 Zadig / libusbK 改过驱动</h4>
<p>这类工具会把手机的<b>复合设备父节点</b>整个绑到 WinUSB 或 libusbK 上，
   于是 USB 复合设备不再展开、ADB 接口在 Windows 里直接消失。而且删掉一个之后，
   libusbK 的通用驱动（<code>drv_device.inf</code> 之类，匹配面很宽）会立刻接手，需要一起清掉。</p>
<ol>
  <li><b>拔掉手机</b>（占用中的驱动删不掉）</li>
  <li>设备管理器 → 找到带手机名的项（通常在「通用串行总线设备」或「libusbK Usb Devices」下）
      → 右键卸载设备 → 勾选<b>删除此设备的驱动程序软件</b></li>
  <li>设备管理器 → 查看 → <b>显示隐藏的设备</b>，把灰色的残留节点也删掉</li>
  <li>以管理员身份运行 PowerShell，先看有哪些：<code>pnputil /enum-drivers</code>，
      再删掉 Provider 是 <code>libwdi</code> / <code>libusbK</code>、且原始名称属于这台手机的那些：
      <code>pnputil /delete-driver oemXX.inf /uninstall /force</code></li>
  <li>重新插上手机，系统会重新枚举成正常的 USB 复合设备</li>
</ol>
<p class="muted">取包工具的压缩包里带了一个自动做这件事的脚本：<code>清理手机驱动.bat</code>
   （双击即可，会自己申请管理员权限）。它会先判断哪些驱动确实属于这台手机、
   哪些是别的设备在用的（比如某些鼠标接收器也是 libwdi 装的），不会误删。</p>

<h4>安卓：手机端 App（Shizuku）—— 适合有「无线调试」的机型</h4>
<ol>
  <li>装 <a href="https://shizuku.rikka.app/" target="_blank" rel="noopener">Shizuku</a></li>
  <li>开发者选项里打开<b>无线调试</b>，在 Shizuku 里按提示「通过无线调试启动」完成配对</li>
  <li>装 <a href="./downloads/ournotes-box.apk" download>ournotes-box.apk</a>，打开后读取账号包</li>
  <li>它会显示一段以 <code>ONPKG1:</code> 开头的文字（不到 1 KB），复制后用微信/QQ 发到电脑，
      粘到本页下面的文本框即可</li>
</ol>
<p><b>华为等机型请注意</b>：这条路依赖「无线调试」。部分厂商把它从开发者选项里去掉了，
   Shizuku 就无法在手机上自行启动，这类机型请用上面的电脑取包工具。</p>

<h4>其它情况</h4>
<p><b>安卓 10 及更早</b>：系统还没限制 <code>Android/data</code>，直接用手机自带的文件管理器进上面那个目录，
   把 64 位十六进制命名的文件夹压缩成 zip 传到电脑，再用本页「选择文件」。</p>
<p><b>iOS</b>：iOS 拿不到应用沙盒，游戏接口也有证书绑定（普通抓包工具抓不到）。
   可用的办法是用「爱思助手」或 iMazing 连接 iPhone，在应用列表里找到 Our Notes，
   导出它的「文档(Documents)」目录，再回本页「选择文件」选择导出的内容。</p>

<h4>「浏览器直连手机」按钮为什么经常用不了</h4>
<p>那个按钮走浏览器的 WebUSB，不用装任何东西，但限制很硬：
   <b>Chrome 会直接拒绝带有「大容量存储」接口的设备</b>。而很多手机（尤其华为）一插上电脑就会虚拟出一个光驱，
   用来弹出提示让你装厂商 PC 助手 —— 于是这些机型上这个按钮<b>必然用不了，换什么驱动都没用</b>。
   能用就用，用不了就走电脑取包工具。</p>`}export{yt as ANDROID_FILES_DIR,H as ANDROID_PACKAGE,ut as buildImportPayload,gt as mountAccountImport};
