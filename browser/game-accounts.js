import * as cloud from './cloud-api.js';
import {clearScores, loadScores} from './b25-ui.js';

export function packageUid(doc) {
  const value = doc?.account_import?.account_id_text ?? doc?.account_import?.account_id;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('账号 UID 精度不完整，请重新取包');
  const uid = String(value ?? '');
  return /^\d{1,30}$/.test(uid) ? uid : '';
}
const copy = value => structuredClone(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function mountGameAccounts(database) {
  const bridge = window.PlannerProfile;
  const root = document.getElementById('gameAccountsRoot');
  const prefix = 'ournotes-game-accounts-v1:'+(window.Planner.scope || 'default')+':';
  const base = 'ournotes-browser-planner-v1-profile:'+window.Planner.scope;
  let registry = {accounts:[],active:''}, registryText=null, chain=Promise.resolve(), message='', syncingPromise=null, syncTarget='';
  const owner = () => cloud.token() && cloud.currentAccount()?.id || 'local';
  const manager = window.PlannerGameAccounts = {
    owner:owner(),uid:'',switching:false,calculating:false,
    importPackage, syncIdentity, clearB25:clearScores,
  };
  function persist() {
    const key=prefix+manager.owner;
    if (localStorage.getItem(key)!==registryText) throw Error('另一标签页已更新账号列表，请刷新后操作');
    registryText=JSON.stringify(registry);localStorage.setItem(key,registryText);
  }
  function load() {
    registryText=localStorage.getItem(prefix+manager.owner);
    registry=registryText ? JSON.parse(registryText) : {accounts:[],active:''};
    if(!Array.isArray(registry.accounts)) throw Error('本地账号列表损坏，请先导出数据');
  }
  const storageKey=uid=>base+':'+manager.owner+':'+(uid || 'unassigned');
  function announce() {
    window.dispatchEvent(new CustomEvent('ournotes-game-account-changed',{detail:manager.uid}));
    window.dispatchEvent(new CustomEvent('ournotes-b25-updated',{detail:loadScores()}));
    window.dispatchEvent(new Event('ournotes-activity-inputs-installed'));
    render();
  }
  function available() {
    if(manager.switching || manager.cacheSwitching || !bridge.canInstall()) throw Error('正在计算、切换或本页数据已过期，请稍后操作或刷新网页');
  }
  async function select(uid,{document:doc,quiet=false}={}) {
    available();
    const account=registry.accounts.find(a=>a.uid===uid);
    if(uid&&!account) throw Error('账号不存在，请刷新列表');
    const previous={uid:manager.uid,key:storageKey(manager.uid),document:bridge.document()};
    manager.switching=true;
    try {
      manager.uid=uid;
      const stored=bridge.storage.select(storageKey(uid));
      const next=doc || (stored&&JSON.parse(stored)) || account?.document || bridge.empty();
      if(uid&&packageUid(next)!==uid) throw Error('卡库 UID 与所选账号不一致');
      if(!bridge.install(next)) throw Error('当前无法切换卡库');
      if(account) account.document=bridge.document();
      registry.active=uid;
      if(account?.remote) {
        cloud.setLinkedResult({id:account.remote.id,version:account.remote.version,
          fingerprint:JSON.stringify(cloud.preparePayload(bridge.document()).payload)},'profile');
        delete account.remote;
      }
      persist();
    } catch(error) {
      manager.uid=previous.uid;bridge.storage.select(previous.key);bridge.install(previous.document);throw error;
    } finally {manager.switching=false;}
    announce();
    if(!quiet) await import('./profile-cloud.js').then(m=>m.onAuthChanged(cloud.currentAccount()));
  }
  async function importPackage(doc) {
    available();
    const requestedOwner=manager.owner;
    const uid=packageUid(doc);
    if(!uid) throw Error('账号包缺少 UID，无法建立游戏账号');
    // The server registration is the only path that clears a deletion tombstone.
    // Keep local import usable offline, but report pending registration explicitly.
    let pending=false;
    if(cloud.token()&&cloud.isConfigured()) {
      try {await cloud.registerGameAccount(doc);} catch(error) {
        if(!['network','timeout','not_configured'].includes(error.code)) throw error;
        pending=true;
      }
    }
    if(owner()!==requestedOwner || manager.owner!==requestedOwner) throw Error('登录已变化，请重新导入');
    const existed=registry.accounts.find(a=>a.uid===uid);
    if(!existed) registry.accounts.push({uid,name:doc.name,document:copy(doc),pending});
    else Object.assign(existed,{name:doc.name,pending});
    await select(uid,{document:doc,quiet:true});
    message=pending?'已保存在本机，联网后会登记并同步。':'账号包已导入；相同 UID 更新原账号。';render();
    await import('./profile-cloud.js').then(async m=>{await m.onAuthChanged(cloud.currentAccount());m.noteLocalSave();});
  }
  async function sync() {
    const changedOwner=manager.owner!==owner();
    if(changedOwner) {
      const deadline=Date.now()+20000;
      while(!bridge.canInstall() || manager.calculating || manager.cacheSwitching) {
        if(Date.now()>deadline)throw Error('正在结束上一账号的计算，请稍后刷新账号列表');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      available();manager.owner=owner();load();
      // Selection is reset before entering a different website user's data scope.
      manager.uid='';bridge.storage.select(storageKey(''));
      manager.switching=true;
      try { if(!bridge.install(bridge.empty())) throw Error('无法清空上一登录账号的数据，请刷新'); }
      finally {manager.switching=false;}
    }
    if(cloud.token()&&cloud.isConfigured()) {
      const captured=manager.owner;
      for(const a of registry.accounts.filter(a=>a.pending)) {
        await cloud.registerGameAccount(a.document);a.pending=false;
      }
      const remote=await cloud.gameAccounts();
      if(owner()!==captured) throw Error('登录已变化');
      const results=await cloud.listResults();
      const next=[];
      for(const a of remote) {
        const local=registry.accounts.find(x=>x.uid===a.uid);
        if(local) {next.push({...local,name:a.name});continue;}
        const item=results.filter(r=>r.kind==='profile'&&r.gameUid===a.uid).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
        if(!item) {next.push({uid:a.uid,name:a.name,document:{...bridge.empty(),name:a.name,account_import:{account_id_text:a.uid,account_id:a.uid}}});continue;}
        const value=await cloud.getResult(item.id);
        if(owner()!==captured) throw Error('登录已变化');
        next.push({uid:a.uid,name:a.name,document:value.payload.document,remote:item});
      }
      registry.accounts=next;
    }
    const uid=registry.accounts.some(a=>a.uid===registry.active)?registry.active:(registry.accounts[0]?.uid||'');
    const selected=registry.accounts.find(a=>a.uid===uid);
    if(!changedOwner && manager.uid===uid && !selected?.remote){persist();render();return;}
    await select(uid,{quiet:true});
  }
  function syncIdentity() {
    if(syncingPromise && syncTarget===owner())return syncingPromise;
    syncTarget=owner();
    chain=chain.catch(()=>{}).then(async()=>{
      try {await sync();} catch(error) {message='账号列表同步失败：'+error.message;render();throw error;}
    });
    const current=chain.finally(()=>{if(syncingPromise===current)syncingPromise=null;});
    syncingPromise=current;return current;
  }
  async function reorder(uid,delta) {
    available();const requestedOwner=manager.owner,revision=registryText;
    const order=registry.accounts.map(a=>a.uid),i=order.indexOf(uid),j=i+delta;
    if(j<0||j>=order.length)return;
    [order[i],order[j]]=[order[j],order[i]];
    if(cloud.token()&&cloud.isConfigured()) await cloud.reorderGameAccounts(order);
    if(manager.owner!==requestedOwner || owner()!==requestedOwner || registryText!==revision)throw Error('账号列表已变化，请刷新后排序');
    registry.accounts=order.map(id=>registry.accounts.find(a=>a.uid===id));persist();render();
  }
  async function remove(uid) {
    available();
    const requestedOwner=manager.owner;
    const dialog=document.getElementById('deleteGameAccount');
    dialog.querySelector('[data-delete-name]').textContent=registry.accounts.find(a=>a.uid===uid)?.name||uid;
    const approved=await new Promise(resolve=>{
      dialog.returnValue='';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'),{once:true});dialog.showModal();
    });
    if(!approved)return;
    if(manager.owner!==requestedOwner || owner()!==requestedOwner)throw Error('登录已变化，已取消删除');
    available();
    if(cloud.token()&&cloud.isConfigured()) await cloud.deleteGameAccount(uid);
    const deletedOwner=requestedOwner;
    if(owner()!==deletedOwner || manager.owner!==deletedOwner) throw Error('登录已变化，请刷新');
    registry.accounts=registry.accounts.filter(a=>a.uid!==uid);persist();
    localStorage.removeItem(storageKey(uid));
    const legacy=localStorage.getItem(base);
    if(legacy&&packageUid(JSON.parse(legacy))===uid) localStorage.removeItem(base);
    const legacyB25=localStorage.getItem('ournotes-b25-v1:'+window.Planner.scope);
    if(legacyB25&&String(JSON.parse(legacyB25).accountId)===uid)localStorage.removeItem('ournotes-b25-v1:'+window.Planner.scope);
    for(const k of ['ournotes-b25-v1:'+window.Planner.scope+':'+deletedOwner+':'+uid,'ournotes-cloud-profile:'+deletedOwner+':'+uid,'ournotes-cloud-result:'+deletedOwner+':'+uid])localStorage.removeItem(k);
    await new Promise((resolve,reject)=>{
      const tx=database.transaction('state','readwrite'),store=tx.objectStore('state');
      for(const k of ['activity:','deck-batches:'])store.delete(k+deletedOwner+':game:'+uid);
      // Legacy resumable caches were shared. Clear their disposable computation
      // cache on deletion; other account libraries and result records are retained.
      store.delete('cache');store.delete('cache:'+deletedOwner+':game:'+uid);
      tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
    });
    if(manager.uid===uid)await select(registry.accounts[0]?.uid||'',{quiet:true});
    else persist();
    message='已删除这个游戏账号及对应数据。';render();
    await import('./profile-cloud.js').then(m=>m.onAuthChanged(cloud.currentAccount()));
  }
  function render() {
    root.innerHTML=`<div class="game-accounts-header"><h3>游戏账号</h3><a href="#account" class="button secondary">上传账号包</a></div><p class="muted">上传新的 UID 时新增账号；同一个 UID 更新已有数据。切换账号后，卡库、成绩和计算记录分别保存。</p><div class="game-account-list">${registry.accounts.map((a,i)=>`<article class="game-account ${a.uid===manager.uid?'selected':''}"><div><strong>${esc(a.name||'游戏账号')}</strong><p>UID ${esc(a.uid)}${a.uid===manager.uid?' · 当前使用':''}</p>${a.pending?'<p>待同步</p>':''}</div><div class="actions"><button class="secondary" data-select="${a.uid}" ${a.uid===manager.uid?'disabled':''}>切换</button><button class="secondary" data-up="${a.uid}" aria-label="上移账号" ${i===0?'disabled':''}>↑</button><button class="secondary" data-down="${a.uid}" aria-label="下移账号" ${i===registry.accounts.length-1?'disabled':''}>↓</button><button class="danger" data-remove="${a.uid}">删除</button></div></article>`).join('')||'<p>还没有游戏账号。上传账号包后会自动添加。</p>'}</div><p role="status">${esc(message)}</p>`;
    root.querySelectorAll('[data-select],[data-up],[data-down],[data-remove]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try {if(button.dataset.select)await select(button.dataset.select);else if(button.dataset.up)await reorder(button.dataset.up,-1);else if(button.dataset.down)await reorder(button.dataset.down,1);else await remove(button.dataset.remove);}
      catch(error){message=error.message;render();}
      finally{if(button.isConnected)button.disabled=false;}
    });
  }
  load();
  const legacy=bridge.document();let uid='';
  try {uid=packageUid(legacy);} catch {message='旧卡库 UID 精度不完整，已保留卡库；请重新上传账号包来添加游戏账号。';}
  let oldLink=null;
  try {oldLink=JSON.parse(localStorage.getItem('ournotes-cloud-profile')||'null');} catch { /* No usable ownership evidence. */ }
  if(!registryText && manager.owner!=='local' && oldLink?.accountId!==manager.owner) {
    // A former shared slot has no trustworthy ownership without its old link.
    // Preserve it for guests, rather than claiming it for whichever user logs in.
    if(!localStorage.getItem(prefix+'local'))localStorage.setItem(prefix+'local',JSON.stringify({accounts:uid?[{uid,name:legacy.name,document:legacy}]:[],active:uid}));
    if(!uid)localStorage.setItem(base+':local:unassigned',JSON.stringify(legacy));
    uid='';localStorage.setItem(storageKey(''),JSON.stringify(bridge.empty()));
  }
  if(!registryText&&uid) {
    // Preserve the old single-library slot as an untouched migration backup.
    registry.accounts=[{uid,name:legacy.name,document:legacy,pending:manager.owner!=='local'}];registry.active=uid;
    const oldB25=localStorage.getItem('ournotes-b25-v1:'+window.Planner.scope);
    if(oldB25&&String(JSON.parse(oldB25).accountId)===uid)localStorage.setItem('ournotes-b25-v1:'+window.Planner.scope+':'+manager.owner+':'+uid,oldB25);
    persist();
  }
  if(!registryText&&!uid&&!localStorage.getItem(storageKey('')))localStorage.setItem(storageKey(''),JSON.stringify(legacy));
  window.addEventListener('ournotes-profile-saved',event=>{
    if(manager.switching)return;
    const a=registry.accounts.find(a=>a.uid===manager.uid);
    if(a) {a.document=JSON.parse(event.detail);a.name=a.document.name;persist();render();}
  });
  window.addEventListener('storage',event=>{
    if(event.key===prefix+manager.owner&&event.newValue!==registryText){message='另一标签页已更新账号列表，请刷新本页。';manager.switching=true;render();}
  });
  window.addEventListener('online',()=>{
    void syncIdentity().then(()=>import('./profile-cloud.js')).then(m=>m.noteLocalSave()).catch(()=>{});
  });
  await select(registry.active||'',{quiet:true});
  // Cloud UI validates the login session before synchronizing the account list.
  render();return manager;
}
