const baseURL = new URL('./', location.href);
const scope = baseURL.pathname;
const loading = document.getElementById('browserLoading');
const loadError = document.getElementById('loadError');

function showLoading(text) {
  loading.hidden = !text;
  loading.textContent = text;
}

async function ensureIsolation() {
  const flag = 'ournotes-isolation-reload:' + scope;
  if (crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
    sessionStorage.removeItem(flag);
    return;
  }
  if (!isSecureContext || !('serviceWorker' in navigator)) {
    throw new Error('请通过 HTTPS 网页打开；本地预览需使用 localhost 地址。建议使用近期的 Chrome 或 Edge。');
  }
  showLoading('正在准备首次运行，页面会自动刷新一次…');
  await navigator.serviceWorker.register(new URL('service-worker.js', baseURL), {scope});
  // ⚠️ `ready` 也必须加上限：它等的是「这个 scope 下有 active 的 worker」，
  //    而实测在手机 WebView 上，**只要 worker 是新装的（例如刚被 unregister 过），这一句就永远不 resolve**
  //    —— 页面于是永远停在上面那句「正在准备首次运行，页面会自动刷新一次…」，没有任何报错、也没有重试。
  //    第 14 轮只给 `controllerchange` 加了上限（见下），漏了这里。超时就当没有 Service Worker 继续，
  //    理由与下面相同：求解已经不依赖跨源隔离，最坏只是少一层加速。
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (!navigator.serviceWorker.controller) {
    // 注册后本页不一定马上被接管。实测手机 WebView 上会一直等不到 controllerchange，
    // 页面就永远停在「正在准备首次运行」。加个上限：超时就当没有隔离继续，
    // 因为求解器（打过 pthread 池补丁后）已经不依赖跨源隔离了，最坏只是少一层加速。
    await Promise.race([
      new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true})),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
  if (sessionStorage.getItem(flag)) {
    // SharedArrayBuffer 不再是完整搜索的前提：求解桥已经改成 await 驱动
    // （见 python-worker.js 的 solveAsync / cp_model.py 的 NeedSolve），
    // 所以拿不到跨源隔离也照常启动 —— 多数手机自带浏览器就是这种情况。
    // 唯一会退回较慢通道的是「取消」：改用 postMessage 通知计算进程。
    console.warn('未能启用跨源隔离：完整搜索不受影响，取消信号改走消息通道。');
    return;
  }
  sessionStorage.setItem(flag, '1');
  location.reload();
  await new Promise(() => {});
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ournotes-browser-state:' + scope, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器无法打开本地续算存储，请允许此网站保存数据。'));
  });
}

async function start() {
  await ensureIsolation();
  const database = await openDatabase();
  const readCache = () => new Promise((resolve, reject) => {
    const request = database.transaction('state').objectStore('state').get('cache');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  const writeCache = bytes => new Promise((resolve, reject) => {
    const tx = database.transaction('state', 'readwrite');
    tx.objectStore('state').put(bytes, 'cache');
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('续算存储空间不足。'));
  });
  const worker = new Worker(new URL('./python-worker.js', import.meta.url), {type: 'module'});
  const pending = new Map();
  let sequence = 0, job = null, solver = null, bridge = null, sharedCancel = null;
  let persisted = Promise.resolve(), releaseLock = null;
  let workerFailure = null;
  function failBridge(error) {
    if (!bridge) return;
    const control = new Int32Array(bridge, 0, 2);
    if (Atomics.load(control, 0)) return;
    const bytes = new TextEncoder().encode(JSON.stringify({error: error.message || String(error)}));
    new Uint8Array(bridge, 8, bytes.length).set(bytes);
    Atomics.store(control, 1, bytes.length);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  }
  function terminateSolver() {
    solver?.terminate();
    solver = null;
    bridge = null;
  }
  function storageError(error) {
    let panel = document.getElementById('browserStorageError');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'browserStorageError'; panel.className = 'notice error'; panel.setAttribute('role', 'status');
      loading.after(panel);
    }
    panel.textContent = '本次续算资料未能保存在浏览器：' + error.message + ' 请导出卡库和计算结果。';
  }
  async function restoreCache() {
    const restored = await rpc('restore-state', {}, {stored: await readCache()});
    if (restored.cacheReset) {
      storageError(new Error('旧续算缓存损坏，已跳过；个人卡库仍保留，请重新计算。'));
    }
  }
  worker.onmessage = ({data}) => {
    if (data.type === 'loading') {showLoading(data.text); return;}
    if (data.type === 'persist') {
      persisted = persisted.then(() => writeCache(data.bytes)).catch(storageError);
      return;
    }
    if (data.type === 'progress') {
      if (job?.status === 'running') Object.assign(job, data.changes);
      return;
    }
    if (data.type === 'solve') {
      bridge = data.shared;
      if (sharedCancel && Atomics.load(new Int32Array(sharedCancel), 0)) return;
      if (!solver) {
        solver = new Worker(new URL('./solver-worker.js', import.meta.url), {type: 'module'});
        solver.onerror = error => {failBridge(new Error('计算组件运行中断：' + error.message)); terminateSolver();};
      }
      solver.postMessage({raw: data.raw, shared: data.shared});
      return;
    }
    if (data.type === 'reply') {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (waiting) data.error ? waiting.reject(new Error(data.error)) : waiting.resolve(data.value);
    }
  };
  worker.onerror = error => {
    workerFailure = new Error('浏览器计算进程中断，请导出卡库后刷新网页重试。' + (error.message || ''));
    for (const waiting of pending.values()) waiting.reject(workerFailure);
    pending.clear();
    terminateSolver();
    worker.terminate();
    loadError.hidden = false; loadError.textContent = workerFailure.message;
  };
  window.addEventListener('pagehide', () => {
    if (sharedCancel) Atomics.store(new Int32Array(sharedCancel), 0, 1);
    terminateSolver(); worker.terminate();
    releaseLock?.();
  });
  function rpc(method, body, extras = {}) {
    if (workerFailure) return Promise.reject(workerFailure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      try {worker.postMessage({type: 'invoke', id, method, body, ...extras});}
      catch (error) {pending.delete(id); reject(error);}
    });
  }
  async function lockCache() {
    if (!navigator.locks) throw new Error('此浏览器不支持可靠的续算存储。请使用近期 Chrome 或 Edge。');
    await new Promise((resolve, reject) => {
      navigator.locks.request('ournotes-search:' + scope, {ifAvailable: true}, lock => {
        if (!lock) {reject(new Error('这个网址的另一个标签页正在计算，请先完成或取消那次计算。')); return;}
        return new Promise(release => {releaseLock = release; resolve();});
      }).catch(reject);
    });
  }
  async function optimize(body) {
    if (job?.status === 'running') throw new Error('已有一次计算在运行，请等待或先取消。');
    await lockCache();
    try {
      await persisted;
      await restoreCache();
      // 取消标志首选 SharedArrayBuffer：Python 在同步计算中也能读到它。
      // 手机自带浏览器没有 SAB，于是退回 postMessage 通道（见 python-worker.js
      // 顶部的 type:'cancel' 分支）—— 计算进程在 await 求解时事件循环是空的，
      // 能及时收到；取消的只是「求解中途」这一个代价最高的阶段。
      sharedCancel = typeof SharedArrayBuffer === 'undefined' ? null : new SharedArrayBuffer(4);
      job = {id: crypto.randomUUID(), status: 'running', stage: '核对实际养成与数据', done: 0, total: 1};
      const id = job.id;
      rpc('optimize', body, {jobId: id, cancel: sharedCancel}).then(async value => {
        await persisted;
        Object.assign(job, value, {stage: value.status === 'complete' ? '计算完成' : '计算已取消'});
      }).catch(async error => {
        await persisted;
        const message = error.message.trim().split('\n').at(-1);
        Object.assign(job, {status: 'error', error: message});
      }).finally(() => {
        terminateSolver(); sharedCancel = null; releaseLock?.(); releaseLock = null;
      });
      return {job_id: id};
    } catch (error) {releaseLock?.(); releaseLock = null; throw error;}
  }
  async function request(path, options = {}) {
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === '/api/bootstrap') return rpc('bootstrap');
    if (path === '/api/check-growth') return rpc('check-growth', body);
    if (path === '/api/account-import') return rpc('import-account', body);
    if (path === '/api/optimize') return optimize(body);
    if (path === `/api/jobs/${job?.id}/cancel`) {
      if (sharedCancel) Atomics.store(new Int32Array(sharedCancel), 0, 1);
      else worker.postMessage({type: 'cancel'});
      terminateSolver();
      return {requested: true};
    }
    if (path === `/api/jobs/${job?.id}`) return {...job};
    throw new Error('找不到此操作。');
  }
  window.Planner = {scope, request};
  window.plannerFetch = async (path, options = {}) => {
    try {return new Response(JSON.stringify(await request(path, options)), {headers: {'Content-Type': 'application/json'}});}
    catch (error) {return new Response(JSON.stringify({error: error.message}), {status: 400, headers: {'Content-Type': 'application/json'}});}
  };
  const id = ++sequence;
  await new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({type: 'initialize', id, baseURL: baseURL.href, stored: null});
  });
  await restoreCache();
  await import('./generated-app.js');
  const {mountAccountImport} = await import('./account-ui.js');
  mountAccountImport(document.getElementById('accountImportRoot'));
  const {mountB25, loadScores, saveRecord} = await import('./b25-ui.js');
  mountB25(document.getElementById('b25Root'));

  // ---- 云端账号 / 结果 / 卡库同步（可选功能；没配后端就一个请求都不发） ----
  const profileCloud = await import('./profile-cloud.js');
  const {setProfileCloudSync} = await import('./profile-storage.js');
  const profileBridge = window.PlannerProfile;
  if (profileBridge) {
    profileCloud.attachProfileCloud({
      getDocument: () => profileBridge.document(),
      installDocument: document => profileBridge.install(document),
    });
    // 本地卡库写成功后通知云端（延迟合并推送；失败只改状态，不阻塞编辑）
    setProfileCloudSync(() => profileCloud.noteLocalSave());
  }
  const {mountCloudPanel} = await import('./cloud-ui.js');
  mountCloudPanel(document.getElementById('cloudRoot'), {
    getCardRecord: () => loadScores(),
    onCardLoaded: (record, note) => { saveRecord(record); window.dispatchEvent(new CustomEvent('ournotes-cloud-card-loaded', {detail: note || ''})); },
  });
  const cloudBadge = document.getElementById('cloudBadge');
  if (cloudBadge) {
    cloudBadge.addEventListener('click', () => {
      document.querySelector('.tabs button[data-tab="cloud"]')?.click();
    });
  }
}

start().catch(error => {
  showLoading(''); loadError.hidden = false;
  loadError.textContent = '网页未能加载：' + error.message;
});
