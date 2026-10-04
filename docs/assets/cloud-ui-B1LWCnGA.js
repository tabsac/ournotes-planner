const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./profile-cloud-B8IXuQjA.js","./cloud-api-kz2f7Efr.js"])))=>i.map(i=>d[i]);
import{_ as K}from"./index-iLj6deQn.js";import{l as b,i as $,t as P,c as q,o as Y,r as J,b as W,O as C,e as X,d as Z,g as tt,C as h,a as v,f as et,h as nt,j as ot,m as Q,k as dt,n as it,p as ct,q as at,s as st,u as lt}from"./cloud-api-kz2f7Efr.js";import{onProfileSyncChange as ut,profileSyncState as k,push as rt,listCloudProfiles as pt,pull as ft}from"./profile-cloud-B8IXuQjA.js";import{attachProfileCloud as xt}from"./profile-cloud-B8IXuQjA.js";const c=s=>String(s??"").replace(/[&<>"']/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[a]),mt=3e3,bt=600*1e3;function y(s){if(!s)return"";const a=new Date(Number(s)*1e3);if(Number.isNaN(a.getTime()))return"";const u=g=>String(g).padStart(2,"0");return`${a.getFullYear()}-${u(a.getMonth()+1)}-${u(a.getDate())} ${u(a.getHours())}:${u(a.getMinutes())}`}function E(s){return s?y(Math.floor(s/1e3)):""}async function ht(s){try{if(navigator.clipboard?.writeText)return await navigator.clipboard.writeText(s),!0}catch{}try{const a=document.createElement("textarea");a.value=s,a.setAttribute("readonly",""),a.style.position="fixed",a.style.opacity="0",document.body.append(a),a.select();const u=document.execCommand("copy");return a.remove(),u}catch{return!1}}function vt(s){const a=s.stats||{},u=[];return a.rating_avg!=null&&u.push(`Rating ${a.rating_avg}`),a.count&&u.push(`${a.count} 首`),(a.fc_count!=null||a.ap_count!=null)&&u.push(`FC ${a.fc_count??"-"} / AP ${a.ap_count??"-"}`),u.join(" · ")}function $t(s,a={}){if(!s)return;const{getCardRecord:u,onCardLoaded:g}=a,n={view:"login",configured:$(),account:q(),checking:$()&&!!P(),results:null,cardLinked:b("b25"),profiles:null,busy:!1,message:"",error:!1,bind:null,profileSync:k()};s.innerHTML=`
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
</div>`;const o=t=>s.querySelector("#"+t),l=(t,e=!1)=>{n.message=t||"",n.error=e};function p(){n.configured=$(),n.account=q(),n.profileSync=k();const t=W();if(o("cloudServerLine").textContent=n.configured?t?.source==="build"?`同源 ${t.base||location.origin}`:`自定义 ${t.base||location.origin}`:"未启用（这个站点没有后端）",!n.configured)o("cloudAuthBox").hidden=!1,o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0,o("cloudAuthBox").innerHTML=`
              <p>这个站点没有连接后端，云端账号与同步不可用。<b>计算、卡库、导出都照常用。</b></p>
              <p class="cloud-dim">官方站点：<a href="${C}" target="_blank" rel="noopener">${c(C)}</a></p>`;else if(n.checking)o("cloudAuthBox").hidden=!1,o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0,o("cloudAuthBox").innerHTML='<p class="cloud-dim">正在校验登录态…</p>';else if(!n.account)o("cloudAuthBox").hidden=!1,(n.renderedAuth!==n.view||!o("cloudUsername"))&&S(),o("cloudAccountBox").hidden=!0,o("cloudResultsBox").hidden=!0,o("cloudProfileBox").hidden=!0;else{n.renderedAuth=null,o("cloudAuthBox").hidden=!0,o("cloudAccountBox").hidden=!1,o("cloudResultsBox").hidden=!1,o("cloudProfileBox").hidden=!1;const e=`${n.account.id||""}|${n.account.username||""}|${n.account.qq||""}`;(n.renderedAccount!==e||!o("cloudChangePwGo"))&&M(),n.renderedAccount=e,T(),_()}o("cloudMsg").textContent=n.message,o("cloudMsg").classList.toggle("cloud-error",!!n.error),n.bind&&F(),B()}function S(){const t=n.view==="register";n.renderedAuth=n.view,o("cloudAuthBox").innerHTML=`
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
          <p class="cloud-dim">${t?"注册后会直接登录；账号只用来在本站保存/取回你自己的结果。":"忘记密码目前需要找管理员（以后会支持用已绑定的 QQ 自助重置）。"}</p>`,s.querySelectorAll("[data-cloud-view]").forEach(d=>d.addEventListener("click",()=>{n.view!==d.dataset.cloudView&&(n.view=d.dataset.cloudView,l(""),p())})),o("cloudSubmit").addEventListener("click",()=>t?x():L());for(const d of["cloudUsername","cloudPassword"])o(d).addEventListener("keydown",i=>{i.key==="Enter"&&(t?x():L())})}function M(){const t=n.account||{},e=t.qq?String(t.qq):"";o("cloudAccountBox").innerHTML=`
          <div class="cloud-account-row">
            <div>
              <div class="cloud-account-name">${c(t.username||"（未命名）")}</div>
              <div class="cloud-dim">注册于 ${c(y(t.createdAt))||"—"}
                ${e?`· 已绑定 QQ <code>${c(e)}</code>`:"· 未绑定 QQ"}</div>
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
          </div>`,o("cloudLogout").addEventListener("click",R);const d=o("cloudBind");d&&d.addEventListener("click",()=>D());const i=o("cloudUnbind");i&&i.addEventListener("click",V),o("cloudChangePw").addEventListener("click",()=>{const f=o("cloudChangePwBox");f.hidden=!f.hidden}),o("cloudChangePwGo").addEventListener("click",I)}function T(){const t=n.results;o("cloudResultsBox").innerHTML=`
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
                  <b>${c(e.title||"(无标题)")}</b>
                  <span class="cloud-dim">${c(y(e.createdAt))}
                    ${e.size?`· ${Math.max(1,Math.round(e.size/1024))} KB`:""}
                    ${n.cardLinked&&n.cardLinked.id===e.id?"· 本机关联":""}</span>
                  ${e.summary?`<span class="cloud-item-sum">${c(e.summary)}</span>`:""}
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-load="${c(e.id)}">取回</button>
                  <button type="button" data-cloud-delete="${c(e.id)}">删除</button>
                </div>
              </li>`).join("")}</ul>`:'<p class="cloud-dim">云端还没有内容。</p>':'<p class="cloud-dim">点「刷新列表」看云端存了什么。</p>'}
          <p class="cloud-note">只上传<b>展示用结果</b>（成绩卡 / 卡库）——上传前会自动剔除鉴权类字段，
            服务器只存不算。</p>`,o("cloudUploadCard").addEventListener("click",H),o("cloudRefresh").addEventListener("click",()=>r(async()=>{await m(),l("列表已刷新")})),s.querySelectorAll("[data-cloud-load]").forEach(e=>e.addEventListener("click",()=>O(e.dataset.cloudLoad))),s.querySelectorAll("[data-cloud-delete]").forEach(e=>e.addEventListener("click",()=>U(e.dataset.cloudDelete)))}function _(){const t=n.profileSync||{},e={off:"未启用",idle:"未同步",dirty:"有改动待上传",syncing:"正在同步…",synced:"已同步",conflict:"冲突（别的设备改过）",error:"同步失败"}[t.mode]||t.mode,d=n.profiles;o("cloudProfileBox").innerHTML=`
          <div class="cloud-head">
            <h4>个人卡库同步</h4>
            <div class="cloud-account-actions">
              <button type="button" id="cloudProfilePush" class="primary">立即上传卡库</button>
              <button type="button" id="cloudProfileList">云端卡库列表</button>
            </div>
          </div>
          <p class="cloud-dim">状态：<b>${c(e)}</b>${t.at?` · 上次成功 ${c(E(t.at))}`:""}
            ${t.error?` · ${c(t.error)}`:""}${t.detail?` · ${c(t.detail)}`:""}</p>
          <div id="cloudProfileListBox">${d?d.length?`<ul class="cloud-items">${d.map(i=>`
              <li class="cloud-item">
                <div class="cloud-item-main">
                  <b>${c(i.title||"")}</b>
                  <span class="cloud-dim">${c(y(i.createdAt))}${i.summary?` · ${c(i.summary)}`:""}</span>
                </div>
                <div class="cloud-item-actions">
                  <button type="button" data-cloud-profile="${c(i.id)}">恢复到本机</button>
                </div>
              </li>`).join("")}</ul>`:'<p class="cloud-dim">云端还没有卡库。</p>':""}</div>
          <p class="cloud-note">卡库会随每次编辑自动上传（改动合并后延迟几秒），失败不影响本地使用。</p>`,o("cloudProfilePush").addEventListener("click",()=>r(async()=>{const i=await rt();l(i?.notice||i?.localNotice||"卡库已上传")})),o("cloudProfileList").addEventListener("click",()=>r(async()=>{n.profiles=await pt(),l(n.profiles.length?`云端有 ${n.profiles.length} 份卡库`:"云端还没有卡库")})),s.querySelectorAll("[data-cloud-profile]").forEach(i=>i.addEventListener("click",()=>r(async()=>{if(!window.confirm("用云端这份卡库覆盖本机卡库？本机当前养成会被替换。"))return;const f=await ft(i.dataset.cloudProfile);l(`已恢复卡库「${f?.name||""}」`)})))}function B(){const t=document.getElementById("cloudBadge");if(!t)return;if(!n.configured){t.textContent="云端未启用",t.dataset.state="off";return}if(!n.account){t.textContent="登录",t.dataset.state="out";return}const e=n.profileSync||{};t.textContent=e.mode==="syncing"?`${n.account.username} · 同步中`:e.mode==="error"?`${n.account.username} · 同步失败`:n.account.username,t.dataset.state="in"}function L(){const t=o("cloudUsername")?.value||"",e=o("cloudPassword")?.value||"";return r(async()=>{const d=await dt(t,e);await A(d,"已登录")})}function x(){const t=o("cloudUsername")?.value||"",e=o("cloudPassword")?.value||"";return r(async()=>{const d=await it(t,e);await A(d,"注册成功，已登录")})}function R(){return r(async()=>{await ct(),n.results=null,n.profiles=null,n.view="login",l("已退出登录（本机卡库与计算结果都还在）")})}function I(){const t=o("cloudOldPw")?.value||"",e=o("cloudNewPw")?.value||"";return r(async()=>{await at(t,e),n.results=null,n.profiles=null,n.view="login",l("密码已修改：所有设备都需要用新密码重新登录")})}async function A(t,e){l(e+(t?.qq?"":"（还没绑定 QQ，绑了以后找密码/找人都方便）")),await K(()=>import("./profile-cloud-B8IXuQjA.js"),__vite__mapDeps([0,1]),import.meta.url).then(d=>d.onAuthChanged(t)).catch(()=>{}),await m()}async function m(){n.results=await ot(),n.cardLinked=b("b25")}function H(){return r(async()=>{const t=u?.();if(!t)throw new h("empty","本机还没有成绩卡：先去「账号包导入」导一次游戏账号包");const e={title:`B25 成绩 · ${t.playerName||t.player?.name||"（未命名）"}`,summary:vt(t),payload:t},d=await st({which:"b25",...e});if(d?.conflict)throw new h("conflict","另一端改过这条成绩卡，先刷新列表再存");v({...b("b25"),savedAt:t.savedAt},"b25"),l(N("成绩卡已存到云端",d)),await m()})}function N(t,e){const d=[t];e?.localNotice&&d.push(e.localNotice);const i=e?.stripped?.length;return i&&d.push(`服务器剔除了 ${i} 项敏感字段（${e.stripped.slice(0,2).join("、")}…）`),d.join("；")}function O(t){return r(async()=>{const e=await tt(t),d=e?.payload;if(!d||!Array.isArray(d.entries)||!d.entries.length)throw new h("empty","这条结果不是成绩卡（没有卡片数据）");g?.(d,`已取回「${e.title||t}」`),v({id:t,version:e.version??1,savedAt:d.savedAt},"b25"),l(`已取回「${e.title||t}」`),await m()})}function U(t){return window.confirm("删除云端这条结果？本机数据不受影响。")?r(async()=>{await et(t),b("b25")?.id===t&&v(null,"b25"),b("profile")?.id===t&&v(null,"profile"),await m(),l("已删除")}):Promise.resolve()}function D(){n.bind={qq:"",code:"",hint:"",status:"input",startedAt:0,attempts:0,timer:null},o("cloudBindOverlay").hidden=!1,p()}function j(){n.bind?.timer&&clearInterval(n.bind.timer),n.bind=null,o("cloudBindOverlay").hidden=!0,p()}function F(){const t=n.bind,e=o("cloudBindBody");if(!e)return;const d=n.account||{};if(t.status==="input"){e.innerHTML=`
              <p>请填你<b>自己的 QQ 号</b>（绑定后这个 QQ 就代表你）。</p>
              <div class="cloud-line">
                <span class="cloud-label">QQ 号</span>
                <input id="cloudBindQq" class="cloud-input" type="text" inputmode="numeric" placeholder="5–12 位数字"
                       value="${c(t.qq||"")}">
                <button type="button" id="cloudBindStart" class="primary">生成绑定码</button>
              </div>`;const i=o("cloudBindQq");i.addEventListener("input",()=>{t.qq=i.value}),o("cloudBindStart").addEventListener("click",w),i.addEventListener("keydown",f=>{f.key==="Enter"&&w()});return}if(t.status==="waiting"){const i=X(t.code);e.innerHTML=`
              <p>照这三步做（<b>必须用 QQ ${c(t.qq)} 发送</b>）：</p>
              <ol class="cloud-steps">
                <li>复制这串码：<b class="cloud-code">${c(t.code)}</b></li>
                <li>打开 QQ，在群里（或私聊机器人）发送：<code>${c(i)}</code>
                    <button type="button" id="cloudCopyCmd">一键复制命令</button></li>
                <li>发完回到这里，页面会自动刷新状态（每 3 秒查一次）</li>
              </ol>
              <p class="cloud-dim">${c(t.hint||"")}<br>
                码 10 分钟内有效、只能用一次；发错 QQ 不会消耗码，本人再发一次仍然有效。</p>
              <p class="cloud-dim" id="cloudBindProgress">等待中…（已等 ${Math.round(t.attempts*3)} 秒）</p>`,o("cloudCopyCmd").addEventListener("click",async f=>{const z=await ht(i);f.currentTarget.textContent=z?"已复制 ✓":"复制失败，请手动选",setTimeout(()=>{f.currentTarget.textContent="一键复制命令"},2e3)});return}if(t.status==="done"){e.innerHTML=`<p>绑定成功：<b>${c(d.qq||t.qq)}</b> 已绑到账号「${c(d.username||"")}」。</p>
              <p class="cloud-dim">以后忘密码可以找管理员用这个 QQ 核实身份。</p>`;return}if(t.status==="expired"){e.innerHTML=`<p>码过期了，重新生成一个吧。</p>
              <button type="button" id="cloudBindAgain" class="primary">重新生成</button>`,o("cloudBindAgain").addEventListener("click",w);return}e.innerHTML=`<p class="cloud-error-text">${c(t.error||"绑定失败")}</p>
          <button type="button" id="cloudBindAgain" class="primary">重新开始</button>`,o("cloudBindAgain").addEventListener("click",()=>{n.bind={...t,status:"input",error:""},p()})}function w(){const t=o("cloudBindQq")?.value||n.bind?.qq||"";return r(async()=>{const e=await nt(t);n.bind={qq:String(t).trim(),code:String(e?.code??""),hint:e?.hint||"",status:"waiting",startedAt:Date.now(),attempts:0,timer:null},l("绑定码已生成，去 QQ 里发命令"),G()})}function G(){const t=n.bind;t&&(t.timer&&clearInterval(t.timer),t.timer=setInterval(async()=>{const e=n.bind;if(!e||e.status!=="waiting")return;if(Date.now()-e.startedAt>bt){clearInterval(e.timer),e.status="expired",p();return}e.attempts+=1;try{if((await Q())?.qq){clearInterval(e.timer),e.status="done",l("绑定成功"),p();return}}catch(i){if(i instanceof h&&i.status===401){clearInterval(e.timer),e.status="error",e.error="登录过期了，请重新登录后再绑定",p();return}}const d=o("cloudBindProgress");d&&(d.textContent=`等待中…（已等 ${Math.round(e.attempts*3)} 秒）`)},mt))}function V(){return window.confirm("解绑 QQ？解绑后这个 QQ 不再关联你的账号。")?r(async()=>{await lt(),await Q(),l("已解绑 QQ")}):Promise.resolve()}async function r(t){n.busy=!0;try{await t()}catch(e){l(Z(e),!0)}finally{n.busy=!1,p()}}s.querySelector("#cloudBindClose").addEventListener("click",j),Y(()=>p()),ut(t=>{n.profileSync=t,B();const e=o("cloudProfileBox");if(e&&!e.hidden){const d=e.querySelector("p.cloud-dim");if(d){const i={off:"未启用",idle:"未同步",dirty:"有改动待上传",syncing:"正在同步…",synced:"已同步",conflict:"冲突（别的设备改过）",error:"同步失败"}[t.mode]||t.mode;d.innerHTML=`状态：<b>${c(i)}</b>${t.at?` · 上次成功 ${c(E(t.at))}`:""}${t.error?` · ${c(t.error)}`:""}${t.detail?` · ${c(t.detail)}`:""}`}}}),n.configured&&P()?J().then(t=>{t&&l(`已登录 ${t.username}`)}).catch(()=>{}).finally(()=>{n.checking=!1,p()}):(n.checking=!1,p())}export{xt as attachProfileCloud,$t as mountCloudPanel};
