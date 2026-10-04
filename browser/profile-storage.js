// A stale tab may export its inputs, but must not overwrite a newer library.
//
// 云端同步（可选）：`setProfileCloudSync()` 注册一个回调，**本地写成功之后**才调用，
// 用来把卡库推到服务器（见 profile-cloud.js）。它**不参与**本地保存的成败：
// 云端挂了也不能影响编辑卡库。
let cloudSync = null;

export function setProfileCloudSync(hook) {
  cloudSync = typeof hook === 'function' ? hook : null;
}

export function createProfileStorage(key, onConflict, onError) {
  let previous = null, stale = false;
  function conflict() {
    if (!stale) {stale = true; onConflict();}
  }
  window.addEventListener('storage', event => {
    if ((event.key === key || event.key === null) && event.newValue !== previous) conflict();
  });
  return {
    get outOfDate() {return stale;},
    load() {
      try {previous = localStorage.getItem(key); return previous;}
      catch {onError(); return null;}
    },
    save(value) {
      if (stale) return false;
      try {
        // Also catch a change whose storage event has not reached this tab yet.
        if (localStorage.getItem(key) !== previous) {conflict(); return false;}
        localStorage.setItem(key, value); previous = value;
        if (cloudSync) { try {cloudSync(value);} catch { /* 同步失败不影响本地保存 */ } }
        return true;
      } catch {onError(); return false;}
    },
  };
}
