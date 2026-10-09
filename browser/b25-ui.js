/**
 * B25 成绩卡 —— 独立页签
 *
 * 数据来自账号包导入（account_ui 那边的 renderB25 已经拆到这里）：
 * account_ui 导入成功后调用 saveScores() 存进 localStorage，本页读它渲染。
 * 这样换页签、刷新页面都不会丢，也不用重新导一次包。
 *
 * 换算规则：AP 算原值，FULL COMBO 算原值 − fcPenalty，最后取平均。
 */
import * as cloud from "./cloud-api.js";
import {renderB25} from "./b25-renderer.mjs";

const STORE_KEY = "ournotes-b25-v1";
const EVENT = "ournotes-b25-updated";

const DIFF_LABEL = {easy: "EASY", normal: "NORMAL", hard: "HARD", expert: "EXPERT"};

/* --------------------------------------------------------------- 评级档位 */

let extrasPromise = null;

/** 评级档位 / 玩家等级表（static-data/b25-extra.json）。取不到就返回 null，页面照常显示。 */
function loadExtras() {
    if (!extrasPromise) {
        extrasPromise = fetch("./static-data/b25-extra.json")
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
    }
    return extrasPromise;
}

/**
 * 由总评级门槛表算出牌子与星级。
 * 表来自 master 包的 MasterLiveTotalHighScoreRating：
 *   _rating 门槛、_grade 0 铜 / 1 银 / 2 金、_step 0~5 星
 * 实测：银牌最低 105500、金牌最低 211000。
 */
function medalFor(rating, extras) {
    const tiers = extras?.total_rating_tiers;
    if (!tiers || !tiers.length) return null;
    let hit = tiers[0];
    for (const tier of tiers) {
        if (rating >= tier[0]) hit = tier;
        else break;
    }
    const grade = hit[1];
    const names = {0: "铜牌", 1: "银牌", 2: "金牌"};
    // 下一档还差多少
    const next = tiers.find(t => t[0] > rating);
    return {
        grade,
        step: hit[2],
        key: extras?.source?.medal_grades?.[grade] ?? "bronze",
        name: names[grade] ?? `等级 ${grade}`,
        threshold: hit[0],
        next: next ? next[0] : null,
        toNext: next ? next[0] - rating : 0,
    };
}

/** 玩家等级：MasterPlayerRank 的 _exp 门槛表。 */
function rankFor(exp, extras) {
    const table = extras?.player_rank;
    if (!table || !table.length) return null;
    let rank = table[0][0];
    for (const [r, need] of table) {
        if (exp >= need) rank = r;
        else break;
    }
    return rank;
}

/** 牌子图标：手绘 SVG（铜/银/金 + 星星）。真图标在游戏 UI 图集里，暂时自己画。 */
function medalSvg(medal) {
    if (!medal) return "";
    // 硬币放大到 44，星星下移到 y=48，viewBox 拉高到 78x66 免得挤在一起
    const stars = Array.from({length: 6}, (_, i) =>
        `<image href="./ui-images/star.webp" x="${2 + i * 12}" y="48" width="12" height="12"`
        + ` class="b25-star${i < medal.step ? "" : " b25-star-off"}"/>`).join("");
    return `<svg class="b25-medal" viewBox="0 0 78 66" width="78" height="66" aria-hidden="true">
  <image href="./ui-images/grade-${esc(medal.key)}.webp" x="0" y="0" width="44" height="44" class="b25-grade"/>
  ${stars}
</svg>`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const int = v => Number(v || 0).toLocaleString("en-US");
/** 平均值之类，最多两位小数。 */
const num = v => (Math.round(Number(v) * 100) / 100).toFixed(2).replace(/\.00$/, "");
/** 谱面等级专用：1~2 位带小数，例如 24.7 / 27 / 20.5。 */
const lvl = v => (v == null || v === "") ? "-" : String(Number(Number(v).toFixed(2)));

function key() {
    const scope = window.Planner?.scope;
    const suffix = window.PlannerGameAccounts?.uid ? ':'+(window.PlannerGameAccounts.owner)+':'+window.PlannerGameAccounts.uid : '';
    return (scope ? `${STORE_KEY}:${scope}` : STORE_KEY)+suffix;
}

/** 存档。只留渲染要用的字段。 */
export function saveScores(scores, meta = {}) {
    if (!scores || !scores.available || !scores.entries?.length) return null;
    const record = {
        savedAt: new Date().toISOString(),
        playerName: meta.playerName || "",
        accountId: meta.accountId || "",
        source: meta.source || "",
        stats: scores.stats || {},
        player: scores.player || {},
        fcPenalty: scores.fc_penalty ?? 1,
        scale: scores.scale || {},
        verified: !!scores.verified,
        notes: scores.notes || [],
        entries: scores.entries,
    };
    try {
        localStorage.setItem(key(), JSON.stringify(record));
    } catch (error) {
        console.warn("B25 成绩无法写入本地存储：", error);
    }
    window.dispatchEvent(new CustomEvent(EVENT, {detail: record}));
    return record;
}

export function loadScores() {
    try {
        const raw = localStorage.getItem(key());
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed?.entries?.length ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * 直接装一份**完整的 record**（云端取回来的就是这种形状）。
 * 和 saveScores 的区别：saveScores 收的是 Python 侧的成绩对象、还要 meta；
 * 这里收的是已经存过档的 record，原样落地（只补 savedAt）。
 */
export function saveRecord(record) {
    if (!record || !Array.isArray(record.entries) || !record.entries.length) return null;
    const uid=window.PlannerGameAccounts?.uid;
    if(uid && String(record.accountId || '')!==uid) throw Error('请先切换到这份成绩对应的游戏账号');
    const next = {...record, savedAt: record.savedAt || new Date().toISOString()};
    try {
        localStorage.setItem(key(), JSON.stringify(next));
    } catch (error) {
        console.warn("B25 成绩无法写入本地存储：", error);
    }
    window.dispatchEvent(new CustomEvent(EVENT, {detail: next}));
    return next;
}

export function clearScores() {
    try { localStorage.removeItem(key()); } catch { /* 忽略 */ }
    window.dispatchEvent(new CustomEvent(EVENT, {detail: null}));
}

export function hasScores() {
    return !!loadScores();
}
function jacketUrl(entry) {
    return "./jacket-images/" + (entry.jacket || "placeholder.webp");
}

/* ------------------------------------------------------------------ 卡片 */

function cardHtml(entry, index) {
    const fcBadge = entry.ap
        ? '<span class="b25-badge b25-badge-ap">ALL PERFECT</span>'
        : entry.fc ? '<span class="b25-badge b25-badge-fc">FULL COMBO</span>' : "";
    // 难度做成和 FC/AP 一样的构造（圆角矩形底 + 彩色字），字体字号不变，靠右
    const diffBadge = `<span class="b25-badge b25-badge-diff b25-diff-${esc(entry.difficulty)}">${
        esc(DIFF_LABEL[entry.difficulty] || entry.difficulty)}</span>`;
    const level = entry.level == null ? "-" : lvl(entry.level);
    const base = entry.level_base == null ? "" : `定数 ${entry.level_base}`;
    return `<article class="b25-card">
  <div class="b25-card-top">
    <span class="b25-rank">${index + 1}</span>
    ${diffBadge}
  </div>
  <img class="b25-jacket" src="${esc(jacketUrl(entry))}" alt="" loading="eager" decoding="async"
       width="120" height="120" data-fallback="1">
    <div class="b25-title-row">
      <div class="b25-title" title="${esc(entry.name)}${esc(base)}">${esc(entry.name)}</div>
      ${fcBadge}
    </div>
    <div class="b25-values"><b>${lvl(entry.value)}</b><span> \u2192 </span><i>${lvl(entry.counted)}</i></div>
</article>`;
}
function emptyHtml() {
    return `<div class="panel b25-empty">
  <h3>还没有成绩数据</h3>
  <p>导入游戏账号包后，即可生成 B25 成绩卡：</p>
  <ol>
    <li>去「<a href="#account" data-goto="account">账号包导入</a>」页，按页面上的教程取一次包</li>
    <li>把账号包拖进去，识别成功后成绩会自动存到这里</li>
  </ol>
  <p class="b25-dim">成绩默认保存在当前浏览器；登录后可选择保存到云端。</p>
</div>`;
}

export function displayScoreNotes(record) {
    const notes = [];
    for (const raw of record.notes || []) {
        const n = String(raw);
        if (/查不到谱面等级|缺少谱面等级/.test(n)) {
            const count = n.match(/有 (\d+) 首/);
            notes.push(`有 ${count?.[1] || "部分"} 首乐曲缺少谱面等级，未参与 B25 排名。`);
        } else if (/领过 FC 奖励|FC 奖励状态/.test(n)) {
            notes.push("部分乐曲的 FC 奖励状态与成绩记录不一致，请重新导入最新账号包核对。");
        } else if (!/^(选曲来源|只统计 FC|排名只看|右上角的 HIGH|Rating =|B25 从|HIGH SCORE RATING 为|FC \/ AP 状态)/.test(n)) {
            notes.push(n);
        }
    }
    if (!record.verified) notes.push("FC / AP 状态由导入记录识别，仅供参考。");
    return [...new Set(notes)];
}

/* ------------------------------------------------------------------ 页面 */

export function mountB25(root) {
    if (!root) return;
    // 云端面板在「取回」之后会被整块重建，用它把提示语带过去
    let cloudFlash = "";

    function headerHtml(record, extras) {
        const stats = record.stats || {};
        const info = record.player || {};
        const rank = rankFor(info.exp ?? 0, extras);
        const total = stats.total_rating ?? 0;
        const medal = medalFor(total, extras);
        const avatarId = info.avatar_card_id || info.favorite_card_id;
        const avatar = avatarId ? `./card-images/members-${esc(String(avatarId))}.webp` : "";
        return `<div class="b25-head">
    <div class="b25-user">
      ${avatar ? `<img class="b25-avatar" src="${avatar}" alt="" data-fallback="1">`
               : '<span class="b25-avatar b25-avatar-empty"></span>'}
      <div class="b25-user-text">
        <div class="b25-user-name">${esc(record.playerName || info.name || "（未命名）")}</div>
        <div class="b25-user-sub">
          ${rank != null ? `<span class="b25-rank-chip">RANK ${rank}</span>` : ""}
          ${record.accountId ? `ID <code>${esc(record.accountId)}</code>` : ""}
        </div>
        <div class="b25-user-sub">共 ${stats.total_songs ?? stats.count ?? record.entries.length} 首有记录
          　FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}</div>
      </div>
    </div>
    <div class="b25-hsr">
      ${medalSvg(medal)}
      <div class="b25-hsr-text">
        <span class="b25-hsr-label">HIGH SCORE RATING</span>
        <b class="b25-hsr-value">${int(total)}</b>
      </div>
    </div>
    <div class="b25-rating">
      <span>Rating</span>
      <strong>${num(stats.rating_avg)}</strong>
      <span class="b25-rating-hint">${stats.count || record.entries.length} 首等级平均</span>
    </div>
  </div>`;
    }
    /**
     * B25 页上的**窄条**：只显示登录态 + 「存到云端」+ 「去账号页」。
     * 登录/注册/绑定 QQ/卡库同步都在「账号」页（cloud-ui.js），这里不重复。
     * **没启用云端（公开镜像站）时一个请求都不发**，只显示一句提示。
     */
    function mountCloudBar(extras) {
        const host = root.querySelector("#cloudBar");
        if (!host) return;
        const account = cloud.currentAccount();
        const configured = cloud.isConfigured();
        const record = loadScores();
        host.innerHTML = `
<div class="b25-cloud-bar">
  <span class="cloud-dim">云端：${!configured ? "未启用，请使用 on.tabsac.com"
        : account ? `已登录 ${esc(account.username || "")}` : "未登录"}</span>
  <button id="cloudBarUpload" type="button" ${!configured || !account || !record ? "disabled" : ""}>把这张卡存到云端</button>
  <button id="cloudBarGoto" type="button">管理云端成绩与卡库</button>
  <span id="cloudBarState" class="cloud-dim"></span>
</div>`;

        const state = host.querySelector("#cloudBarState");
        if (cloudFlash) { state.textContent = cloudFlash; cloudFlash = ""; }
        host.querySelector("#cloudBarGoto").addEventListener("click", () => {
            document.querySelector('.tabs button[data-tab="cloud"]')?.click();
        });
        const upload = host.querySelector("#cloudBarUpload");
        if (upload) {
            upload.addEventListener("click", async () => {
                const current = loadScores();
                if (!current) return;
                upload.disabled = true;
                state.textContent = "正在上传…";
                try {
                    const body = {
                        title: `B25 成绩 · ${current.playerName || current.player?.name || "（未命名）"}`,
                        summary: `Rating ${current.stats?.rating_avg ?? "-"} · ${current.stats?.count ?? current.entries.length} 首`,
                        payload: current,
                    };
                    const result = await cloud.saveLinkedResult({which: "b25", ...body});
                    if (result?.conflict) {
                        state.textContent = "另一端改过这条成绩卡，去账号页刷新后再存";
                        return;
                    }
                    cloud.setLinkedResult({...cloud.linkedResult("b25"), savedAt: current.savedAt}, "b25");
                    state.textContent = (result?.localNotice || "已存到云端");
                } catch (error) {
                    state.textContent = cloud.describeError(error);
                } finally {
                    upload.disabled = false;
                }
            });
        }
    }

    function render(extras) {
        const record = loadScores();
        if (!record) {
            root.innerHTML = emptyHtml() + '<div id="cloudBar"></div>';
            bindGoto();
            mountCloudBar(extras);
            return;
        }

        const notes = displayScoreNotes(record).map(n => `<li>${esc(n)}</li>`).join("");
        root.innerHTML = `
<div class="b25-panel">
  ${headerHtml(record, extras)}
  <div class="b25-grid">${record.entries.map(cardHtml).join("")}</div>
  <p class="b25-note">AP 按谱面等级计入，FC 按谱面等级减 ${esc(String(record.fcPenalty))} 计入。
     仅统计 FC / AP 成绩，选取计入值最高的 ${record.stats?.count || record.entries.length} 首计算平均 Rating；同值时按谱面等级、乐曲 ID 排序。</p>
  ${notes ? `<div class="notice"><b>成绩识别说明</b><ul>${notes}</ul></div>` : ""}
  <div class="b25-actions">
    <button id="b25Download" type="button" class="primary">下载图片（PNG）</button>
    <button id="b25Clear" type="button">清除成绩</button>
    <span id="b25State" class="b25-dl-state"></span>
  </div>
  <div id="cloudBar"></div>
</div>`;

        root.querySelectorAll("img[data-fallback]").forEach(img => {
            img.addEventListener("error", () => {
                if (!img.dataset.done) {
                    img.dataset.done = "1";
                    img.src = "./jacket-images/placeholder.webp";
                }
            });
        });

        // 云端窄条：没启用云端时一个请求都不发（登录/绑定/卡库都在「账号」页）
        mountCloudBar(extras);

        const state = root.querySelector("#b25State");
        root.querySelector("#b25Download").addEventListener("click", (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            state.textContent = "正在生成图片…";
            exportB25(record, extras)
                .then(() => { state.textContent = "已开始下载。"; })
                .catch(error => { state.textContent = "生成失败：" + (error?.message || error); })
                .finally(() => { button.disabled = false; });
        });
        root.querySelector("#b25Clear").addEventListener("click", () => {
            if (window.confirm("清除本机保存的 B25 成绩？账号包里的原始数据不受影响，随时可以重新导入。")) {
                clearScores();
                state.textContent = "已清除。";
            }
        });
    }

    function bindGoto() {
        root.querySelectorAll("[data-goto]").forEach(el => {
            el.addEventListener("click", (event) => {
                event.preventDefault();
                const target = el.dataset.goto;
                document.querySelectorAll(".tab-page").forEach(p => p.hidden = p.id !== target);
                document.querySelectorAll(".tabs button").forEach(b =>
                    b.classList.toggle("active", b.dataset.tab === target));
                history.replaceState(null, "", "#" + target);
            });
        });
    }

    window.addEventListener(EVENT, () => render(extras));
    window.addEventListener("storage", (event) => { if (event.key === key()) render(extras); });
    // 从「账号」页取回云端成绩卡后，这一页也要重画，并把提示语带过来
    window.addEventListener("ournotes-cloud-card-loaded", (event) => {
        cloudFlash = String(event.detail || "");
        render(extras);
    });
    let extras = null;
    render(null);
    loadExtras().then(value => { extras = value; render(extras); });
}

/* --------------------------------------------------------------- 图片导出 */

function loadImage(src) {
    return new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

let fontPromise = null;
export function prepareB25Font() {
    if (!fontPromise) {
        fontPromise = new FontFace("OurNotesB25", 'url("./static-data/b25-font.ttf")').load()
            .then(font => { document.fonts.add(font); });
    }
    return fontPromise;
}
export async function renderB25Canvas(record, extras) {
    await prepareB25Font();
    return renderB25(record, extras, {
        createCanvas(width, height) {
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            return canvas;
        },
        loadImage,
    });
}
export async function exportB25(record, extras) {
    const canvas = await renderB25Canvas(record, extras);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("浏览器没有生成 PNG");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `ournotes-b25-${stamp}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

