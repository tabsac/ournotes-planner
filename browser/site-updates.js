// Compare the actual loaded entry with the atomically published HTML, not a
// mutable digest fetched after boot. Never replace a running solver's data.
export function mountSiteUpdates(checkData, {interval = 60000, idle = 10000} = {}) {
  const entry = document.querySelector('script[type="module"][src]')?.src;
  if (!entry) return;
  let checking = false, target = '', lastInteraction = Date.now();
  for (const name of ['pointerdown', 'keydown', 'input']) {
    document.addEventListener(name, () => { lastInteraction = Date.now(); }, {passive: true});
  }
  function ready() {
    const accounts = window.PlannerGameAccounts;
    return !document.hidden && Date.now() - lastInteraction >= idle
      && window.PlannerProfile?.canInstall()
      && !accounts?.switching && !accounts?.calculating && !accounts?.cacheSwitching
      && !document.querySelector('dialog[open]')
      && !document.activeElement?.matches('input,textarea,select,[contenteditable=true]')
      && ![...document.querySelectorAll('#cloudAuthBox:not([hidden]) input:not([type=checkbox]):not([type=radio])')].some(input => input.value)
      && !document.querySelector('#accountImportRoot button:disabled');
  }
  function install() {
    if (!target || !ready()) return;
    // Query busts stale HTML caches; the page hash and local account data survive.
    const url = new URL(location.href);
    url.searchParams.set('_siteUpdate', new URL(target).pathname.split('/').pop());
    location.replace(url.href);
  }
  if (new URL(location.href).searchParams.has('_siteUpdate')) {
    const clean = new URL(location.href); clean.searchParams.delete('_siteUpdate');
    history.replaceState(history.state, '', clean.href);
  }
  async function check() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const url = new URL('./index.html', location.href);
      const response = await fetch(url, {cache: 'no-store', credentials: 'same-origin'});
      if (!response.ok) return;
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const src = doc.querySelector('script[type="module"][src]')?.getAttribute('src');
      const next = src && new URL(src, url).href;
      target = next && new URL(next).origin === location.origin && next !== entry ? next : '';
      let notice = document.getElementById('siteUpdateNotice');
      if (target) {
        if (!notice) {
          notice = document.createElement('div'); notice.id = 'siteUpdateNotice';
          notice.className = 'notice'; notice.setAttribute('role', 'status');
          notice.textContent = '网页已有更新，当前计算和账号操作结束后会自动更新。';
          document.getElementById('browserLoading')?.after(notice);
        }
        install();
      } else { notice?.remove(); await checkData?.(); }
    } catch { /* Offline or interrupted deployment: keep the working page. */ }
    finally {checking = false;}
  }
  setTimeout(check, 4000);
  setInterval(check, interval);
  setInterval(install, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  window.addEventListener('online', check);
  return {check};
}
