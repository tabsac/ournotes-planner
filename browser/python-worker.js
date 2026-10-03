import {version as browserVersion} from './package.json';

let pyodide, cancel, started = 0, lastPersist = 0, lastProgress = {};
const decoder = new TextDecoder();
let ready;

self.browser_cancelled = () => cancel ? Atomics.load(cancel, 0) !== 0 : cancelRequested;
self.browser_progress = raw => {
  lastProgress = JSON.parse(raw);
  self.postMessage({type: 'progress', changes: lastProgress});
};
self.browser_persist = force => {
  const now = performance.now();
  if (!force && now - lastPersist < 500) return;
  lastPersist = now;
  const bytes = pyodide.FS.readFile('/state/search-v1.sqlite3');
  self.postMessage({type: 'persist', bytes: bytes.buffer}, [bytes.buffer]);
};
// ---- 外层求解驱动（不依赖 SharedArrayBuffer）----------------------------------
// 本文件本身就是 Worker，可以直接 await。于是把「同步阻塞等求解」改成
// 「await 求解 + 重跑」，SAB 就不需要了。
// Python 侧 cp_model.CpSolver.solve 会调 browser_solve_cached 查缓存；
// 查不到就抛 NeedSolve 并留下 pending_solve，这里解完写进缓存、再重跑一次 invoke。
const solveCache = new Map();
let solverWorker = null, solveSeq = 0;
// 没有 SharedArrayBuffer 时的取消通道：主线程 postMessage 进来，置这个标志。
// 本 Worker 在 await 求解时事件循环是空的，所以收得到。
let cancelRequested = false;
let abortSolve = null;

function getSolverWorker() {
    if (!solverWorker) {
        solverWorker = new Worker(new URL('./solver-worker.js', import.meta.url), {type: 'module'});
    }
    return solverWorker;
}

function solveAsync(raw) {
    const worker = getSolverWorker(), id = ++solveSeq;
    return new Promise((resolve, reject) => {
        const finish = (value, failure) => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            abortSolve = null;
            failure ? reject(failure) : resolve(value);
        };
        const onMessage = event => {
            if (!event.data || event.data.id !== id) return;
            finish(event.data.value);
        };
        const onError = error => finish(null, new Error('求解进程出错：' + error.message));
        abortSolve = () => finish({cancelled: true});
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({raw, id});
    });
}

/** 收到取消：置标志、掐掉正在跑的求解进程、让 await 着的求解立刻返回「已取消」。 */
function cancelNow() {
    cancelRequested = true;
    solverWorker?.terminate();
    solverWorker = null;
    const abort = abortSolve;
    abortSolve = null;
    if (abort) abort();
}

self.browser_solve_cached = key => {
    // 已取消就直接回「取消」，让重跑的那次 invoke 一路 unwind，
    // 而不用再解一次模型、也不会把取消结果写进缓存。
    if (cancelRequested) return '{"cancelled":true}';
    return solveCache.has(key) ? JSON.stringify(solveCache.get(key)) : '';
};

/** 读出并清空 Python 侧留下的待解请求；没有则返回 null。 */
function takePendingSolve() {
    const text = String(pyodide.runPython(
        'import cp_model; k = cp_model.pending_solve.pop("key", ""); '
        + 'r = cp_model.pending_solve.pop("raw", ""); k + "\\u0000" + r'));
    const cut = text.indexOf('\u0000');
    if (cut < 0) return null;
    const key = text.slice(0, cut), raw = text.slice(cut + 1);
    return (key && raw) ? {key, raw} : null;
}

self.browser_solve = raw => {
  const count = JSON.parse(raw).model.variables.length;
  const shared = new SharedArrayBuffer(Math.max(1048576, count * 32 + 4096));
  const control = new Int32Array(shared, 0, 2);
  self.postMessage({type: 'solve', raw, shared});
  let lastHeartbeat = 0;
  while (!Atomics.load(control, 0)) {
    if (self.browser_cancelled()) return '{"cancelled":true}';
    Atomics.wait(control, 0, 0, 250);
    if (performance.now() - lastHeartbeat >= 1000) {
      lastHeartbeat = performance.now();
      self.postMessage({type: 'progress', changes: {...lastProgress,
        elapsed_seconds: Math.round((performance.now() - started) / 100) / 10}});
    }
  }
  return decoder.decode(new Uint8Array(shared, 8, Atomics.load(control, 1)).slice());
};

async function initialize({baseURL, stored}) {
  self.postMessage({type: 'loading', text: '正在下载并准备计算组件，首次打开请稍候…'});
  const indexURL = baseURL + 'vendor/pyodide/';
  const {loadPyodide} = await import(/* @vite-ignore */ indexURL + 'pyodide.mjs');
  pyodide = await loadPyodide({indexURL});
  self.postMessage({type: 'loading', text: '正在核对游戏数据与公式…'});
  const response = await fetch(baseURL + 'planner-runtime.zip?v=' + encodeURIComponent(browserVersion));
  if (!response.ok) throw new Error('计算资料加载失败，请刷新网页。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  pyodide.unpackArchive(bytes, 'zip', {extractDir: '/planner'});
  pyodide.FS.mkdirTree('/state');
  if (stored) pyodide.FS.writeFile('/state/search-v1.sqlite3', new Uint8Array(stored));
  pyodide.runPython("import sys; sys.path.insert(0, '/planner'); import browser_runtime");
  self.postMessage({type: 'loading', text: ''});
}

self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'initialize') {
    ready = initialize(message);
    try {await ready; self.postMessage({type: 'reply', id: message.id, value: true});}
    catch (error) {self.postMessage({type: 'reply', id: message.id, error: error.message});}
    return;
  }
  // 取消走消息通道：必须放在 await ready 之前，否则计算中收不到。
  if (message.type === 'cancel') {cancelNow(); return;}
  try {
    await ready;
    cancelRequested = false;                 // 每条新请求都从「没取消」开始
    if (message.method === 'restore-state') {
      try {pyodide.FS.unlink('/state/search-v1.sqlite3');} catch {}
      if (message.stored) pyodide.FS.writeFile('/state/search-v1.sqlite3', new Uint8Array(message.stored));
      const cacheReset = pyodide.runPython('browser_runtime.restore_cache()');
      self.postMessage({type: 'reply', id: message.id, value: {cacheReset}});
      return;
    }
    if (message.cancel) cancel = new Int32Array(message.cancel);
    if (message.method === 'optimize') {started = performance.now(); lastProgress = {};}
    pyodide.globals.set('_browser_method', message.method);
    pyodide.globals.set('_browser_body', JSON.stringify(message.body || {}));
    pyodide.globals.set('_browser_job_id', message.jobId || null);
    // 外层驱动循环：Python 抛「需要求解」就 await 解掉、写缓存、重跑一次。
    let raw;
    for (let round = 0; ; round++) {
        try {
            raw = pyodide.runPython('browser_runtime.invoke(_browser_method, _browser_body, _browser_job_id)');
            break;
        } catch (error) {
            const pending = takePendingSolve();
            if (!pending) throw error;          // 不是 NeedSolve，原样抛出
            if (round >= 80) throw new Error('求解驱动未收敛（超过 80 轮）：' + error.message);
            self.postMessage({type: 'progress', changes: {stage: '精确求解中…', solver_round: round + 1}});
            const value = await solveAsync(pending.raw);
            if (value && value.error) throw new Error(value.error);
            // 取消结果不进缓存：否则以后正常的那次运行会命中「已取消」。
            if (value && value.cancelled) { solveCache.delete(pending.key); continue; }
            solveCache.set(pending.key, value);
        }
    }
    self.postMessage({type: 'reply', id: message.id, value: JSON.parse(raw)});
  } catch (error) {
    self.postMessage({type: 'reply', id: message.id, error: error.message});
  }
};
