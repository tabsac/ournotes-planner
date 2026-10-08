"""Run the unchanged planner oracle in a private browser Python worker."""
import hashlib
import json
from pathlib import Path
import sys
import types
import time
import sqlite3

import cp_model as browser_cp
from js import browser_cancelled, browser_progress, browser_persist

for name in ("ortools", "ortools.sat", "ortools.sat.python"):
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
sys.modules["ortools.sat.python.cp_model"] = browser_cp
sys.modules["ortools.sat.python"].cp_model = browser_cp

import planner_core as p
import solver_search as ss
import activity_goals
import team_options
team_options.install(p, ss)
from search_cache import SearchCache, digest


class BrowserData(p.Data):
    def fingerprint(self):
        # Different adapters/solver builds cannot reuse each other's proofs.
        native = super().fingerprint()
        bridge = [hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  hashlib.sha256(Path(browser_cp.__file__).read_bytes()).hexdigest(),
                  hashlib.sha256(Path(team_options.__file__).read_bytes()).hexdigest(),
                  hashlib.sha256(Path(activity_goals.__file__).read_bytes()).hexdigest()]
        return digest({"native": native, "browser": bridge, "solver": "or-tools-wasm-0.9.1"})


class BrowserCache(SearchCache):
    def put(self, key, rows, visited, **metadata):
        saved = super().put(key, rows, visited, **metadata)
        if saved:
            browser_persist(bool(metadata.get("proven")))
        return saved

    def checkpoint(self, request, **metadata):
        super().checkpoint(request, **metadata)
        progress = (metadata.get("completed_steps", 0), metadata.get("completed_sheets", 0))
        force = progress != getattr(self, "_last_saved_progress", None)
        self._last_saved_progress = progress
        browser_persist(force)

    def mark_status(self, job_id, status):
        super().mark_status(job_id, status)
        browser_persist(True)


def native_solve(self, cm):
    """Same strict proof contract; browser workers provide cancellation/compute."""
    self.check()
    self.add_hint(cm)
    self.save()
    solver = self.cp.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 19471
    status = solver.solve(cm)
    self.check()
    self.stats["solver_calls"] += 1
    if status != self.cp.OPTIMAL:
        raise p.InputError("浏览器求解器未能完成最优证明，已完成步骤会保留。请恢复输入继续计算。")
    self.hint = self.selected_hint(solver)
    return solver


ss.Search.native_solve = native_solve


upstream_save = ss.Search.save


def browser_save(self, status="running"):
    """重启不许把「本作业已保存的进度」抹掉。

    求解桥是「重启 + 记忆化」：每次 NeedSolve 之后 Python 会**从头重跑**，
    于是 self.prepared_keys / self.step_keys / self.completed 都从零重建。
    如果取消正好落在 await 求解期间，重启后的 run() 会在 build() 的第一次
    check() 就退出 —— 那次 save("cancelled") 会写下空进度，
    可那些证明其实还在缓存里、恢复时也照样复用
    （验收用例 check_lifecycle.cjs 的 saved_steps / saved_sheets 就是这么挂掉的）。

    这里把上一个检查点里**属于同一个作业（run_id）**的进度并回来，并且只影响
    写出去的内容，不动内存里的活状态（否则重走时会重复计数）。
    交出去之前 SearchCache.last_checkpoint() 会逐个 key 回查缓存、
    已经不存在的会被剔掉，所以并回来只会更接近事实，不会凭空多报。
    """
    if not self.cache:
        return upstream_save(self, status)
    previous = self.cache.last_checkpoint() or {}
    if previous.get("job_id") != self.run_id:
        return upstream_save(self, status)
    join = lambda live, saved: list(dict.fromkeys(list(live) + list(saved or [])))
    live = (self.prepared_keys, self.step_keys, self.completed)
    self.prepared_keys = join(self.prepared_keys, previous.get("keys"))
    self.step_keys = join(self.step_keys, previous.get("step_keys"))
    self.completed = max(self.completed, int(previous.get("completed_steps") or 0))
    try:
        return upstream_save(self, status)
    finally:
        self.prepared_keys, self.step_keys, self.completed = live


ss.Search.save = browser_save
data = BrowserData()
cache = BrowserCache("/state")


def restore_cache():
    """Discard an unreadable computation cache, preserving the UI's inventory."""
    global cache
    try:
        restored = BrowserCache("/state")
        with restored.connection() as db:
            if db.execute("PRAGMA quick_check(1)").fetchall() != [("ok",)]:
                raise sqlite3.DatabaseError("Invalid resume cache")
        cache = restored
        return False
    except sqlite3.DatabaseError:
        for name in ("search-v1.sqlite3", "search-v1.sqlite3-journal"):
            (Path("/state") / name).unlink(missing_ok=True)
        cache = BrowserCache("/state")
        return True


def bootstrap():
    checkpoint = cache.last_checkpoint()
    if checkpoint:
        checkpoint["active_job_id"] = None
        if checkpoint["status"] == "complete":
            checkpoint = None
        elif checkpoint["status"] == "running":
            checkpoint["status"] = "interrupted"
    catalog = data.catalog()
    for kind in ("members", "snaps"):
        for card in catalog[kind]:
            if isinstance(card.get("thumbnail"), str):
                card["thumbnail"] = card["thumbnail"].lstrip("/")
    return {"catalog": catalog, "demo": p.demo_profile(), "calibration": p.calibration(data),
            "token": "browser-local", "resume": checkpoint}


def invoke(method, raw, job_id=None):
    body = json.loads(raw) if raw else {}
    if method == "bootstrap":
        return json.dumps(bootstrap(), ensure_ascii=False)
    if method == "check-growth":
        return json.dumps(p.growth_issues(activity_goals.prepare(body), data), ensure_ascii=False)
    if method == "import-account":
        # 账号包在浏览器里解密后，只把 _player 这一段送进来；主数据表在 Python 侧，
        # 所以 exp->等级 的换算复用与官方公式同一份表。
        import account_import
        import account_scores
        player = body.get("player")
        if not isinstance(player, dict):
            raise p.InputError("账号包内容无法识别，没有找到玩家数据。")
        profile, report = account_import.build_profile(player, data)
        # 成绩数据单独一路返回，不塞进 profile：profile 要过配队程序的 normalizeImport
        # 校验，加字段风险大。前端把它挂在账号面板上画 B25。
        try:
            scores = account_scores.build_scores(player, data)
        except Exception as exc:                     # 成绩坏了不能连累导入
            scores = {"available": False, "entries": [], "songs": {}, "stats": {},
                      "notes": ["成绩数据解析失败：%s" % exc]}
        return json.dumps({"profile": profile, "report": report, "scores": scores},
                          ensure_ascii=False)
    if method == "deck-batch":
        import deck_local
        return json.dumps(deck_local.invoke(body,job_id),ensure_ascii=False,allow_nan=False)
    if method != "optimize":
        raise p.InputError("找不到此操作。")
    begin = time.monotonic()

    def progress(**changes):
        changes.setdefault("elapsed_seconds", round(time.monotonic() - begin, 1))
        browser_progress(json.dumps(changes, ensure_ascii=False))

    try:
        body = team_options.configure(body, p, data)
        if body.get("settings", {}).get("goal", "budget") == "budget":
            result = p.optimize(body, progress=progress, cancelled=lambda: bool(browser_cancelled()),
                            data=data, cache=cache, run_id=job_id)
        else:
            result = activity_goals.optimize(body, p, data, progress=progress, cancelled=lambda: bool(browser_cancelled()), cache=cache, run_id=job_id)
        if browser_cancelled():
            raise p.Cancelled()
        cache.mark_status(job_id, "complete")
        return json.dumps({"status": "complete", "result": result}, ensure_ascii=False, allow_nan=False)
    except p.Cancelled:
        cache.mark_status(job_id, "cancelled")
        return json.dumps({"status": "cancelled"})
    except Exception:
        cache.mark_status(job_id, "error")
        raise
