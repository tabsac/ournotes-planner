const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./profile-cloud-D6BwRiUu.js","./cloud-api-DmgkH7B7.js"])))=>i.map(i=>d[i]);
import{_ as Z}from"./index-Bj_mem9l.js";import{l as b,i as L,t as q,c as Q,o as tt,r as et,b as nt,O as E,e as ot,d as it,g as dt,C as h,a as y,f as ct,h as at,j as lt,m as S,k as st,n as ut,p as rt,q as pt,s as ft,u as mt}from"./cloud-api-DmgkH7B7.js";import{onProfileSyncChange as bt,profileSyncState as M,push as T,pull as _,listCloudProfiles as vt}from"./profile-cloud-D6BwRiUu.js";import{attachProfileCloud as kt}from"./profile-cloud-D6BwRiUu.js";const d=l=>String(l??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]),ht=3e3,yt=600*1e3;function g(l){if(!l)return"";const c=new Date(Number(l)*1e3);if(Number.isNaN(c.getTime()))return"";const p=$=>String($).padStart(2,"0");return`${c.getFullYear()}-${p(c.getMonth()+1)}-${p(c.getDate())} ${p(c.getHours())}:${p(c.getMinutes())}`}function R(l){return l?g(Math.floor(l/1e3)):""}async function wt(l){try{if(navigator.clipboard?.writeText)return await navigator.clipboard.writeText(l),!0}catch{}try{const c=document.createElement("textarea");c.value=l,c.setAttribute("readonly",""),c.style.position="fixed",c.style.opacity="0",document.body.append(c),c.select();const p=document.execCommand("copy");return c.remove(),p}catch{return!1}}function gt(l){const c=l.stats||{},p=[];return c.rating_avg!=null&&p.push(`Rating ${c.rating_avg}`),c.count&&p.push(`${c.count} 首`),(c.fc_count!=null||c.ap_count!=null)&&p.push(`FC ${c.fc_count??"-"} / AP ${c.ap_count??"-"}`),p.join(" · ")}function xt(l,c={}){if(!l)return;const{getCardRecord:p,onCardLoaded:$}=c,n={view:"login",configured:L(),account:Q(),checking:L()&&!!q(),results:null,cardLinked:b("b25"),profiles:null,busy:!1,message:"",error:!1,bind:null,profileSync:M()};l.innerHTML=`
<div class="cloud-panel-open">
  <div class="cloud-head">
    <h3>云端账号</h3>
    <span class="cloud-dim" id="cloudServerLine"></span>
  </div>

  <section id="cloudAuthBox" class="cloud-card"></section>
  <section id="cloudAccountBox" class="cloud-card" hidden></section>
  <section id="cloudResultsBox" class="cloud-card" hidden></section>
  <section id="cloudProfileBox" class="cloud-card" hidden></section>
  <p class="cloud-msg" id="cloudMsg"></p>
</div>
<div class="cloud-overlay" id="cloudBindOverlay" hidden>
  <div class="cloud-dialog" role="dialog" aria-modal="true">
    <h3>绑定 QQ</h3>
    <div id="cloudBindBody"></div>
    <div class="cloud-dialog-actions">
      <button type="button" id="cloudBindClose">关闭</button>
    </div>
  </div>
</div>`;const o=t=>l.querySelector("#"+t),s=(t,e=!1)=>{n.message=t||"",n.error=e};function f(){n.configured=L(),n.account=Q(),n.profileSync=M();const t=nt();if(o("cloudServerLine").textContent=n.configured?t?.source==="build"?`同源 ${t.base||location.origin}`:`自定义 ${t.base||location.origin}`:"未启用（这个站点没有后端）",!n.configured)o("cloudAuthBox").hidden=!1,o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0,o("cloudAuthBox").innerHTML=`
              <p>这个站点没有连接后端，云端账号与同步不可用。<b>计算、卡库、导出都照常用。</b></p>
              <p class="cloud-dim">官方站点：<a href="${E}" target="_blank" rel="noopener">${d(E)}</a></p>`;else if(n.checking)o("cloudAuthBox").hidden=!1,o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0,o("cloudAuthBox").innerHTML='<p class="cloud-dim">正在校验登录态…</p>';else if(!n.account)o("cloudAuthBox").hidden=!1,(n.renderedAuth!==n.view||!o("cloudUsername"))&&I(),o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0;else{n.renderedAuth=null,o("cloudAuthBox").hidden=!0,o("cloudAccountBox").hidden=!1,o("cloudResultsBox").hidden=!1,o("cloudProfileBox").hidden=!1;const e=`${n.account.id||""}|${n.account.username||""}|${n.account.qq||""}`;(n.renderedAccount!==e||!o("cloudChangePwGo"))&&N(),n.renderedAccount=e,H(),O()}o("cloudMsg").textContent=n.message,o("cloudMsg").classList.toggle("cloud-error",!!n.error),n.bind&&Y(),x()}function I(){const t=n.view==="register";n.renderedAuth=n.view,o("cloudAuthBox").innerHTML=`
          <div class="cloud-tabs">
            <button type="button" class="${t?"":"active"}" data-cloud-view="login">登录</button>
            <button type="button" class="${t?"active":""}" data-cloud-view="register">注册</button>
          </div>
          <div class="cloud-line">
            <span class="cloud-label">用户名</span>
            <input id="cloudUsername" class="cloud-input" type="text" autocomplete="username"
                   spellcheck="false" placeholder="3–24 位字母数字 _ . -">
          </div>
          <div class="cloud-line">
            <span class="cloud-label">密码</span>
            <input id="cloudPassword" class="cloud-input" type="password" autocomplete="${t?"new-password":"current-password"}"
                   placeholder="至少 8 位">
            <button id="cloudSubmit" type="button" class="primary">${t?"注册并登录":"登录"}</button>
          </div>
          <p class="cloud-dim">${t?"注册后会直接登录；账号只用来在本站保存/取回你自己的结果。":"忘记密码目前需要找管理员（以后会支持用已绑定的 QQ 自助重置）。"}</p>`,l.querySelectorAll("[data-cloud-view]").forEach(i=>i.addEventListener("click",()=>{n.view!==i.dataset.cloudView&&(n.view=i.dataset.cloudView,s(""),f())})),o("cloudSubmit").addEventListener("click",()=>t?A():P());for(const i of["cloudUsername","cloudPassword"])o(i).addEventListener("keydown",a=>{a.key==="Enter"&&(t?A():P())})}function N(){const t=n.account||{},e=t.qq?String(t.qq):"";o("cloudAccountBox").innerHTML=`
          <div class="cloud-account-row">
            <div>
              <div class="cloud-account-name">${d(t.username||"（未命名）")}</div>
              <div class="cloud-dim">注册于 ${d(g(t.createdAt))||"—"}
                ${e?`· 已绑定 QQ <code>${d(e)}</code>`:"· 未绑定 QQ"}</div>
            </div>
            <div class="cloud-account-actions">
              ${e?'<button type="button" id="cloudUnbind">解绑 QQ</button>':'<button type="button" id="cloudBind" class="primary">绑定 QQ</button>'}
              <button type="button" id="cloudChangePw">修改密码</button>
              <button type="button" id="cloudLogout">退出登录</button>
            </div>
          </div>
          <div id="cloudChangePwBox" hidden class="cloud-inline-form">
            <input id="cloudOldPw" class="cloud-input" type="password" placeholder="原密码" autocomplete="current-password">
            <input id="cloudNewPw" class="cloud-input" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password">
            <button type="button" id="cloudChangePwGo" class="primary">确认修改</button>
            <span class="cloud-dim">改完所有设备都要重新登录</span>
          </div>`,o("cloudLogout").addEventListener("click",U);const i=o("cloudBind");i&&i.addEventListener("click",()=>V());const a=o("cloudUnbind");a&&a.addEventListener("click",W),o("cloudChangePw").addEventListener("click",()=>{const m=o("cloudChangePwBox");m.hidden=!m.hidden}),o("cloudChangePwGo").addEventListener("click",D)}function H(){const t=n.results;o("cloudResultsBox").innerHTML=`
          <div class="cloud-head">
            <h4>云端结果</h4>
            <div class="cloud-account-actions">
              <button type="button" id="cloudUploadCard">存当前成绩卡</button>
              <button type="button" id="cloudRefresh">刷新列表</button>
            </div>
          </div>
          ${t?t.length?`<ul class="cloud-items">${t.map(e=>`
              <li class="cloud-item">
                <div class="cloud-item-main">
                  <b>${d(e.title||"(无标题)")}</b>
                  <span class="cloud-dim">${d(g(e.createdAt))}
                    ${e.size?`· ${Math.max(1,Math.round(e.size/1024))} KB`:""}
                    ${n.cardLinked&&n.cardLinked.id===e.id?"· 本机关联":""}</span>
                  ${e.summary?`<span class="cloud-item-sum">${d(e.summary)}</span>`:""}
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-load="${d(e.id)}">取回</button>
                  <button type="button" data-cloud-delete="${d(e.id)}">删除</button>
                </div>
              </li>`).join("")}</ul>`:'<p class="cloud-dim">云端还没有内容。</p>':'<p class="cloud-dim">点「刷新列表」看云端存了什么。</p>'}
          <p class="cloud-note">只上传<b>展示用结果</b>（成绩卡 / 卡库）——上传前会自动剔除鉴权类字段，
            服务器只存不算。</p>`,o("cloudUploadCard").addEventListener("click",j),o("cloudRefresh").addEventListener("click",()=>r(async()=>{await v(),s("列表已刷新")})),l.querySelectorAll("[data-cloud-load]").forEach(e=>e.addEventListener("click",()=>G(e.dataset.cloudLoad))),l.querySelectorAll("[data-cloud-delete]").forEach(e=>e.addEventListener("click",()=>K(e.dataset.cloudDelete)))}function O(){const t=n.profileSync||{},e=b("profile"),i={off:"未启用",idle:"未同步",dirty:"有改动待上传",syncing:"正在同步…",synced:"已同步",conflict:"冲突（别的设备改过）",error:"同步失败"}[t.mode]||t.mode,a=t.mode!=="conflict"?"":`
          <div class="cloud-conflict">
            <b>云端那份卡库被别的设备改过</b>（服务端返回 409，没有自动合并）。
            <div class="cloud-account-actions">
              <button type="button" id="cloudConflictPull" class="primary">用云端覆盖本机</button>
              <button type="button" id="cloudConflictKeep">保留本机（另存为新的一份）</button>
            </div>
            <p class="cloud-dim">「用云端覆盖」会先拉回云端那份再装进本页（计算中会拒绝）；
              「保留本机」会另建一条云端记录，之后以本机为准。</p>
          </div>`,m=n.profiles;o("cloudProfileBox").innerHTML=`
          <div class="cloud-head">
            <h4>个人卡库同步</h4>
            <div class="cloud-account-actions">
              <button type="button" id="cloudProfilePush" class="primary">立即上传卡库</button>
              <button type="button" id="cloudProfileList">云端卡库列表</button>
            </div>
          </div>
          <p class="cloud-dim">状态：<b>${d(i)}</b>${t.at?` · 上次成功 ${d(R(t.at))}`:""}
            ${t.error?` · ${d(t.error)}`:""}${t.detail?` · ${d(t.detail)}`:""}</p>
          ${a}
          <div id="cloudProfileListBox">${m?m.length?`<ul class="cloud-items">${m.map(u=>`
              <li class="cloud-item">
                <div class="cloud-item-main">
                  <b>${d(u.title||"")}</b>
                  <span class="cloud-dim">${d(g(u.createdAt))}${u.summary?` · ${d(u.summary)}`:""}
                    ${e&&e.id===u.id?" · 本机关联":""}</span>
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-profile="${d(u.id)}">恢复到本机</button>
                </div>
              </li>`).join("")}</ul>`:'<p class="cloud-dim">云端还没有卡库。</p>':""}</div>
          <p class="cloud-note">卡库会随每次编辑自动上传（改动合并后延迟几秒），失败不影响本地使用。</p>`,o("cloudProfilePush").addEventListener("click",()=>r(async()=>{const u=await T();s(u?.notice||u?.localNotice||"卡库已上传")}));const w=o("cloudConflictPull");w&&w.addEventListener("click",()=>r(async()=>{if(!e?.id)throw new h("no_link","本机没有关联云端卡库，先刷新列表再恢复");if(!window.confirm("用云端那份覆盖本机卡库？本机当前养成会被替换。"))return;const u=await _(e.id);s(`已用云端那份覆盖本机（${u?.name||""}）`)}));const C=o("cloudConflictKeep");C&&C.addEventListener("click",()=>r(async()=>{y(null,"profile");const u=await T();s("已把本机卡库另存为云端新的一份"+(u?.localNotice?"；"+u.localNotice:""))})),o("cloudProfileList").addEventListener("click",()=>r(async()=>{n.profiles=await vt(),s(n.profiles.length?`云端有 ${n.profiles.length} 份卡库`:"云端还没有卡库")})),l.querySelectorAll("[data-cloud-profile]").forEach(u=>u.addEventListener("click",()=>r(async()=>{if(!window.confirm("用云端这份卡库覆盖本机卡库？本机当前养成会被替换。"))return;const X=await _(u.dataset.cloudProfile);s(`已恢复卡库「${X?.name||""}」`)})))}function x(){const t=document.getElementById("cloudBadge");if(!t)return;if(!n.configured){t.textContent="云端未启用",t.dataset.state="off";return}if(!n.account){t.textContent="登录",t.dataset.state="out";return}const e=n.profileSync||{};t.textContent=e.mode==="syncing"?`${n.account.username} · 同步中`:e.mode==="error"?`${n.account.username} · 同步失败`:n.account.username,t.dataset.state="in"}function P(){const t=o("cloudUsername")?.value||"",e=o("cloudPassword")?.value||"";return r(async()=>{const i=await st(t,e);await k(i,"已登录")})}function A(){const t=o("cloudUsername")?.value||"",e=o("cloudPassword")?.value||"";return r(async()=>{const i=await ut(t,e);await k(i,"注册成功，已登录")})}function U(){return r(async()=>{await rt(),n.results=null,n.profiles=null,n.view="login",s("已退出登录（本机卡库与计算结果都还在）")})}function D(){const t=o("cloudOldPw")?.value||"",e=o("cloudNewPw")?.value||"";return r(async()=>{await pt(t,e),n.results=null,n.profiles=null,n.view="login",s("密码已修改：所有设备都需要用新密码重新登录")})}async function k(t,e){s(e+(t?.qq?"":"（还没绑定 QQ，绑了以后找密码/找人都方便）")),await Z(()=>import("./profile-cloud-D6BwRiUu.js"),__vite__mapDeps([0,1]),import.meta.url).then(i=>i.onAuthChanged(t)).catch(()=>{}),await v()}async function v(){n.results=await lt(),n.cardLinked=b("b25")}function j(){return r(async()=>{const t=p?.();if(!t)throw new h("empty","本机还没有成绩卡：先去「账号包导入」导一次游戏账号包");const e={title:`B25 成绩 · ${t.playerName||t.player?.name||"（未命名）"}`,summary:gt(t),payload:t},i=await ft({which:"b25",...e});if(i?.conflict)throw new h("conflict","另一端改过这条成绩卡，先刷新列表再存");y({...b("b25"),savedAt:t.savedAt},"b25"),s(F("成绩卡已存到云端",i)),await v()})}function F(t,e){const i=[t];e?.localNotice&&i.push(e.localNotice);const a=e?.stripped?.length;return a&&i.push(`服务器剔除了 ${a} 项敏感字段（${e.stripped.slice(0,2).join("、")}…）`),i.join("；")}function G(t){return r(async()=>{const e=await dt(t),i=e?.payload;if(!i||!Array.isArray(i.entries)||!i.entries.length)throw new h("empty","这条结果不是成绩卡（没有卡片数据）");$?.(i,`已取回「${e.title||t}」`),y({id:t,version:e.version??1,savedAt:i.savedAt},"b25"),s(`已取回「${e.title||t}」`),await v()})}function K(t){return window.confirm("删除云端这条结果？本机数据不受影响。")?r(async()=>{await ct(t),b("b25")?.id===t&&y(null,"b25"),b("profile")?.id===t&&y(null,"profile"),await v(),s("已删除")}):Promise.resolve()}function V(){n.bind={qq:"",code:"",hint:"",status:"input",startedAt:0,attempts:0,timer:null},o("cloudBindOverlay").hidden=!1,f()}function z(){n.bind?.timer&&clearInterval(n.bind.timer),n.bind=null,o("cloudBindOverlay").hidden=!0,f()}function Y(){const t=n.bind,e=o("cloudBindBody");if(!e)return;const i=n.account||{};if(t.status==="input"){e.innerHTML=`
              <p>请填你<b>自己的 QQ 号</b>（绑定后这个 QQ 就代表你）。</p>
              <div class="cloud-line">
                <span class="cloud-label">QQ 号</span>
                <input id="cloudBindQq" class="cloud-input" type="text" inputmode="numeric" placeholder="5–12 位数字"
                       value="${d(t.qq||"")}">
                <button type="button" id="cloudBindStart" class="primary">生成绑定码</button>
              </div>`;const a=o("cloudBindQq");a.addEventListener("input",()=>{t.qq=a.value}),o("cloudBindStart").addEventListener("click",B),a.addEventListener("keydown",m=>{m.key==="Enter"&&B()});return}if(t.status==="waiting"){const a=ot(t.code);e.innerHTML=`
              <p>照这三步做（<b>必须用 QQ ${d(t.qq)} 发送</b>）：</p>
              <ol class="cloud-steps">
                <li>复制这串码：<b class="cloud-code">${d(t.code)}</b></li>
                <li>打开 QQ，在群里（或私聊机器人）发送：<code>${d(a)}</code>
                    <button type="button" id="cloudCopyCmd">一键复制命令</button></li>
                <li>发完回到这里，页面会自动刷新状态（每 3 秒查一次）</li>
              </ol>
              <p class="cloud-dim">${d(t.hint||"")}<br>
                码 10 分钟内有效、只能用一次；发错 QQ 不会消耗码，本人再发一次仍然有效。</p>
              <p class="cloud-dim" id="cloudBindProgress">等待中…（已等 ${Math.round(t.attempts*3)} 秒）</p>`,o("cloudCopyCmd").addEventListener("click",async m=>{const w=await wt(a);m.currentTarget.textContent=w?"已复制 ✓":"复制失败，请手动选",setTimeout(()=>{m.currentTarget.textContent="一键复制命令"},2e3)});return}if(t.status==="done"){e.innerHTML=`<p>绑定成功：<b>${d(i.qq||t.qq)}</b> 已绑到账号「${d(i.username||"")}」。</p>
              <p class="cloud-dim">以后忘密码可以找管理员用这个 QQ 核实身份。</p>`;return}if(t.status==="expired"){e.innerHTML=`<p>码过期了，重新生成一个吧。</p>
              <button type="button" id="cloudBindAgain" class="primary">重新生成</button>`,o("cloudBindAgain").addEventListener("click",B);return}e.innerHTML=`<p class="cloud-error-text">${d(t.error||"绑定失败")}</p>
          <button type="button" id="cloudBindAgain" class="primary">重新开始</button>`,o("cloudBindAgain").addEventListener("click",()=>{n.bind={...t,status:"input",error:""},f()})}function B(){const t=o("cloudBindQq")?.value||n.bind?.qq||"";return r(async()=>{const e=await at(t);n.bind={qq:String(t).trim(),code:String(e?.code??""),hint:e?.hint||"",status:"waiting",startedAt:Date.now(),attempts:0,timer:null},s("绑定码已生成，去 QQ 里发命令"),J()})}function J(){const t=n.bind;t&&(t.timer&&clearInterval(t.timer),t.timer=setInterval(async()=>{const e=n.bind;if(!e||e.status!=="waiting")return;if(Date.now()-e.startedAt>yt){clearInterval(e.timer),e.status="expired",f();return}e.attempts+=1;try{if((await S())?.qq){clearInterval(e.timer),e.status="done",s("绑定成功"),f();return}}catch(a){if(a instanceof h&&a.status===401){clearInterval(e.timer),e.status="error",e.error="登录过期了，请重新登录后再绑定",f();return}}const i=o("cloudBindProgress");i&&(i.textContent=`等待中…（已等 ${Math.round(e.attempts*3)} 秒）`)},ht))}function W(){return window.confirm("解绑 QQ？解绑后这个 QQ 不再关联你的账号。")?r(async()=>{await mt(),await S(),s("已解绑 QQ")}):Promise.resolve()}async function r(t){n.busy=!0;try{await t()}catch(e){s(it(e),!0)}finally{n.busy=!1,f()}}l.querySelector("#cloudBindClose").addEventListener("click",z),tt(()=>f()),bt(t=>{n.profileSync=t,x();const e=o("cloudProfileBox");if(e&&!e.hidden){const i=e.querySelector("p.cloud-dim");if(i){const a={off:"未启用",idle:"未同步",dirty:"有改动待上传",syncing:"正在同步…",synced:"已同步",conflict:"冲突（别的设备改过）",error:"同步失败"}[t.mode]||t.mode;i.innerHTML=`状态：<b>${d(a)}</b>${t.at?` · 上次成功 ${d(R(t.at))}`:""}${t.error?` · ${d(t.error)}`:""}${t.detail?` · ${d(t.detail)}`:""}`}}}),n.configured&&q()?et().then(t=>{t&&s(`已登录 ${t.username}`)}).catch(()=>{}).finally(()=>{n.checking=!1,f()}):(n.checking=!1,f())}export{kt as attachProfileCloud,xt as mountCloudPanel};
