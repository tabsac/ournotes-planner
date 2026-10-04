/**
 * B25 成绩卡 —— 独立页签
 *
 * 数据来自账号包导入（account_ui 那边的 renderB25 已经拆到这里）：
 * account_ui 导入成功后调用 saveScores() 存进 localStorage，本页读它渲染。
 * 这样换页签、刷新页面都不会丢，也不用重新导一次包。
 *
 * 换算规则：AP 算原值，FULL COMBO 算原值 − fcPenalty，最后取平均。
 */
import {mountCloudPanel} from "./cloud-ui.js";

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
    return scope ? `${STORE_KEY}:${scope}` : STORE_KEY;
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
  <p>B25 成绩卡需要从游戏账号包里读。步骤很短：</p>
  <ol>
    <li>去「<a href="#account" data-goto="account">账号包导入</a>」页，按页面上的教程取一次包</li>
    <li>把账号包拖进去，识别成功后成绩会自动存到这里</li>
  </ol>
  <p class="b25-dim">成绩只存在你这台电脑的浏览器里，不会上传到任何地方。</p>
</div>`;
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
     * 挂云端面板。**空状态也要挂** —— 换设备的人第一眼就是空的，
     * 得能在那儿登录、把云端那张卡取回来。
     */
    function mountCloud(extras) {
        const host = root.querySelector("#cloudPanel");
        if (!host) return;
        const flash = cloudFlash;
        cloudFlash = "";
        try {
            mountCloudPanel(host, {
                initialMessage: flash,
                getRecord: () => loadScores(),
                // 取回后卡片要整块重画（云端面板也会被重建），提示语得跟着带过去。
                // ⚠️ 这里**不要**自己再 render 一次：saveRecord 已经派发 EVENT → render，
                //    多画一次会把刚带过去的提示语吃掉（第二次挂载时 flash 已消费）。
                onRecordLoaded: (payload, note) => {
                    cloudFlash = note || "";
                    saveRecord(payload);
                },
            });
        } catch (error) {
            console.warn("云端面板挂载失败（不影响本地卡片）：", error);
        }
    }

    function render(extras) {
        const record = loadScores();
        if (!record) {
            root.innerHTML = emptyHtml() + '<div id="cloudPanel"></div>';
            bindGoto();
            mountCloud(extras);
            return;
        }

        const notes = (record.notes || []).map(n => `<li>${esc(n)}</li>`).join("");
        root.innerHTML = `
<div class="b25-panel">
  ${headerHtml(record, extras)}
  <div class="b25-grid">${record.entries.map(cardHtml).join("")}</div>
  <p class="b25-note">每首歌显示的是<b>实际计入 Rating 的值</b>：AP 的歌显示谱面等级原值（<b>AP 记原值</b>），
     FC 的歌显示「原值 → 计入值」（计入值 = 原值 − ${esc(String(record.fcPenalty))}）。
     <b>只统计 FC / AP 的谱面，「完成」无论什么难度都不计入</b>（所以卡片上每首至少有一张 FC/AP）。
     Rating = 这 ${record.stats?.count || record.entries.length} 首计入值的平均。
     选曲和名次<b>只看计入值、不看分数</b>：从账号包里打过并留下记录的乐曲中
     取计入值最高的 ${record.stats?.count || record.entries.length} 首，同值时原值高的在前，再同按乐曲 ID 排。</p>
  ${notes ? `<div class="notice"><b>关于 FC / AP 的可靠性</b><ul>${notes}</ul></div>` : ""}
  <div class="b25-actions">
    <button id="b25Download" type="button" class="primary">下载图片（PNG）</button>
    <button id="b25Clear" type="button">清除成绩</button>
    <span id="b25State" class="b25-dl-state"></span>
  </div>
  <div id="cloudPanel"></div>
</div>`;

        root.querySelectorAll("img[data-fallback]").forEach(img => {
            img.addEventListener("error", () => {
                if (!img.dataset.done) {
                    img.dataset.done = "1";
                    img.src = "./jacket-images/placeholder.webp";
                }
            });
        });

        // 云端同步（可选）：没配服务器地址时它一个请求都不发
        mountCloud(extras);

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

/** 按当前字体把文字裁到指定宽度，超出部分用省略号（canvas 没有 text-overflow）。 */
function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(cut + "…").width > maxWidth) cut = cut.slice(0, -1);
    return cut + "…";
}

/** 按宽度折行（最多 maxLines 行，最后一行放不下才省略）。canvas 没有自动换行。 */
function wrapText(ctx, text, maxWidth, maxLines) {
    const chars = [...String(text)];
    const lines = [];
    let cur = "";
    for (const ch of chars) {
        const next = cur + ch;
        if (ctx.measureText(next).width <= maxWidth || !cur) {
            cur = next;
        } else {
            lines.push(cur);
            cur = ch;
            if (lines.length === maxLines) break;
        }
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines) {
        const last = lines[maxLines - 1];
        const rest = chars.slice(lines.join("").length);
        if (rest.length && ctx.measureText(last).width > maxWidth - 12) {
            lines[maxLines - 1] = fitText(ctx, last, maxWidth);
        }
    }
    return lines.length ? lines : [""];
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** 画牌子（canvas 版，和页面上那个 SVG 一致：圆牌 + 高音谱号 + 星星）。 */
let starImage = null;
let gradeImages = null;

function drawMedal(ctx, medal, x, y) {
    // 牌子直接用游戏原图（grade-bronze / silver / gold），不用再染色
    const brand = gradeImages && gradeImages[medal.key];
    if (brand) {
        // 牌子宽度 = 星条上「第2颗星左沿 → 第5颗星右沿」= 56px，再左移 2px 微调
        // 星条起点 x+2，间距 14：星2左沿 = x+16，星5右沿 = x+72
        ctx.drawImage(brand, x + 14, y, 56, 56);
    } else {
        ctx.fillStyle = "#c98a52";
        ctx.fillRect(x, y, 30, 30);
    }
    // 星级：6 个星位，亮起 medal.step 个（同样用游戏原图）
    for (let i = 0; i < 6; i++) {
        const sx = x + 2 + i * 14, sy = y + 60;
        if (!starImage) continue;
        if (i < medal.step) {
            ctx.drawImage(starImage, sx, sy, 14, 14);
        } else {
            ctx.save();
            ctx.globalAlpha = 0.32;
            ctx.drawImage(starImage, sx, sy, 14, 14);
            ctx.restore();
        }
    }
}
/** 手绘 PNG：不引第三方库（网页是离线静态站，CSP 只允许 'self'）。 */
export async function exportB25(record, extras) {
    const entries = record.entries;
    const COLUMNS = 5;                 // 5 列：25 首正好排成 5×5（一屏一张，和游戏里那张卡一样）
    const PAD = 44, GAP = 18;
    // 卡高必须容得下：徽章行(38) + 封面(184) + 曲名(30) + 数值(28) + 脚注(20) + 下边距
    const CARD_W = 268, CARD_H = 348;
    const HEAD = 144, FOOT = 96;   // 160 x 0.9（head 整体再缩 0.9）
    const rows = Math.ceil(entries.length / COLUMNS);
    const width = PAD * 2 + CARD_W * COLUMNS + GAP * (COLUMNS - 1);
    const height = HEAD + rows * CARD_H + (rows - 1) * GAP + FOOT;

    const scale = 1.5;                 // 2 倍会到 9 MB，1.5 倍够清晰又便于分享
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.textBaseline = "top";

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#12121a");
    bg.addColorStop(1, "#1d1b2e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const stats = record.stats || {};
    const info = record.player || {};
    // 牌子上的星星用游戏里导出的真图标
    if (!starImage) starImage = await loadImage("./ui-images/star.webp");
    if (!gradeImages) {
        gradeImages = {};
        for (const k of ["bronze", "silver", "gold"]) {
            gradeImages[k] = await loadImage(`./ui-images/grade-${k}.webp`);
        }
    }

    // ---- 头部：用户信息（左，放大）+ 牌子与最高分（紧挨着）+ Rating（最右），同一行 ----
    // head 整体再缩 0.9 倍：左上角钉在 PAD 不动，右边缘靠 HRIGHT 补偿回来，
    // 这样头部内容和卡片网格左右对齐，不会在一侧留出空档。
    const HS = 0.9;
    const HT = PAD * (1 - HS);
    const HUP = 5;                       // head 整体再上移 5px
    const HRIGHT = (width - PAD - HT) / HS;
    ctx.save();
    ctx.translate(HT, HT - HUP);
    ctx.scale(HS, HS);
    const avatarSize = 104;   // 116 x 0.9
    const avatarId2 = info.avatar_card_id || info.favorite_card_id;
    const avatar = avatarId2 ? await loadImage(`./avatar-images/avatar-${avatarId2}.webp`) : null;
    if (avatar) {
        ctx.save();
        roundRect(ctx, PAD, PAD, avatarSize, avatarSize, 16);
        ctx.clip();
        // 和网页一致：整张卡**等比缩放**填进方形框（不裁切、不变形），居中显示。
        // 之前用的 cover 会裁成正方形，所以只看到脸；网页上能看到肩膀，就是整张缩进去的。
        const _sw = avatar.naturalWidth, _sh = avatar.naturalHeight;
        const _k = Math.min(avatarSize / _sw, avatarSize / _sh);
        const _dw = _sw * _k, _dh = _sh * _k;
        ctx.drawImage(avatar, PAD + (avatarSize - _dw) / 2, PAD + (avatarSize - _dh) / 2, _dw, _dh);
        ctx.restore();
    } else {
        ctx.fillStyle = "rgba(255,255,255,.08)";
        roundRect(ctx, PAD, PAD, avatarSize, avatarSize, 16);
        ctx.fill();
    }

    const left = PAD + avatarSize + 16;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 29px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(record.playerName || info.name || "（未命名）", left, PAD + 14);

    const rank = rankFor(info.exp ?? 0, extras);
    const subY = PAD + 56;    // 62 x 0.9
    let chipX = left;
    if (rank != null) {
        const chip = `RANK ${rank}`;
        ctx.font = "bold 15px system-ui, sans-serif";
        const cw = ctx.measureText(chip).width + 26;
        ctx.fillStyle = "rgba(118,103,222,.28)";
        roundRect(ctx, chipX, subY - 2, cw, 24, 9);
        ctx.fill();
        ctx.fillStyle = "#bdb2ff";
        ctx.fillText(chip, chipX + 10, subY + 2);
        chipX += cw + 10;
    }
    if (record.accountId) {
        ctx.fillStyle = "#a5a3bf";
        ctx.font = "15px system-ui, 'Microsoft YaHei', sans-serif";
        ctx.fillText(`ID ${record.accountId}`, chipX, subY + 4);
    }
    ctx.fillStyle = "#a5a3bf";
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(`共 ${stats.total_songs ?? stats.count} 首有记录`
        + `　FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}`, left, subY + 32);

    // ---- 右侧：Rating 在最右，牌子+最高分紧挨它的左边（不要留空档） ----
    const ratingText = `${stats.count || entries.length} 首等级平均`;
    ctx.textAlign = "right";
    ctx.fillStyle = "#a5a3bf";
    ctx.font = "15px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText("Rating", HRIGHT, PAD + 4);
    ctx.fillStyle = "#ffd66b";
    ctx.font = "bold 56px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(num(stats.rating_avg), HRIGHT, PAD + 32);
    ctx.fillStyle = "#8f8da8";
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(ratingText, HRIGHT, PAD + 92);
    const ratingLeft = HRIGHT - Math.max(ctx.measureText(ratingText).width, 120);
    ctx.textAlign = "left";

    const total = stats.total_rating ?? 0;
    const medal = medalFor(total, extras);
    // 牌子的位置要和网页一致：紧贴用户信息块的右侧（不是按 Rating 反推）。
    // 网页上是 flex 的 20px 间距，这里按用户文字的实际宽度量出来。
    // 框高必须包住：硬币(34) + 间距 + 星星(12)，从 hsrY+8 起算到 hsrY+68，再留 12 下边距
    const hsrW = 250, hsrH = 90;
    ctx.font = "bold 29px system-ui, 'Microsoft YaHei', sans-serif";
    const _wName = ctx.measureText(record.playerName || info.name || "（未命名）").width;
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";   // 和实际绘制字号一致，否则量出来偏大
    const _wCounts = ctx.measureText(`共 ${stats.total_songs ?? stats.count} 首有记录`
        + `　FC ${stats.fc_count ?? "-"} / AP ${stats.ap_count ?? "-"}`).width;
    // 最宽的一行其实是「RANK 芯片 + ID」，必须一起量，否则盒子会压到 ID
    ctx.font = "bold 15px system-ui, sans-serif";
    const _chipW = (rank != null) ? ctx.measureText(`RANK ${rank}`).width + 26 + 10 : 0;
    ctx.font = "15px system-ui, 'Microsoft YaHei', sans-serif";
    const _idW = record.accountId ? ctx.measureText(`ID ${record.accountId}`).width : 0;
    const userW = Math.max(_wName, _chipW + _idW, _wCounts, 130);
    const hsrX = left + userW + 8;   // 紧贴个人信息，只留几像素
    const hsrY = PAD + 6;   // 原 PAD + 16，整体上移 10px
    ctx.fillStyle = "rgba(118,103,222,.14)";
    roundRect(ctx, hsrX, hsrY, hsrW, hsrH, 12);
    ctx.fill();
    if (medal) drawMedal(ctx, medal, hsrX + 16, hsrY + 7);
    ctx.fillStyle = "#c8c4e6";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("HIGH SCORE RATING", hsrX + hsrW - 16, hsrY + 22.5);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 25px system-ui, sans-serif";
    ctx.fillText(int(total), hsrX + hsrW - 16, hsrY + 46);
    ctx.textAlign = "left";
    ctx.restore();   // 结束 head 的 0.9 倍缩放

    // ---- 卡片 ----
    const images = await Promise.all(entries.map(e => loadImage(jacketUrl(e))));
    const DIFF_FILL = {
        expert: ["rgba(255,107,107,.20)", "#ff6b6b"],
        hard: ["rgba(255,214,107,.20)", "#ffd66b"],
        normal: ["rgba(126,224,168,.20)", "#7ee0a8"],
        easy: ["rgba(127,198,255,.20)", "#7fc6ff"],
    };

    entries.forEach((entry, index) => {
        const col = index % COLUMNS;
        const row = Math.floor(index / COLUMNS);
        const x = PAD + col * (CARD_W + GAP);
        const y = HEAD + row * (CARD_H + GAP);

        ctx.fillStyle = "rgba(255,255,255,.06)";
        roundRect(ctx, x, y, CARD_W, CARD_H, 14);
        ctx.fill();

        // 顶行：序号 + 难度徽章 + FC/AP 徽章
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.fillText(String(index + 1), x + 12, y + 13);

        /** 画一个徽章；rightAlign 时贴卡片右边。size 同时决定字号和内边距。 */
        const drawBadge = (text, fill, color, size, rightAlign) => {
            ctx.font = `bold ${size}px system-ui, sans-serif`;
            const w = ctx.measureText(text).width + size * 1.4;
            const h = size * 1.9;
            const bx = rightAlign ? x + CARD_W - 12 - w : x + 12;
            ctx.fillStyle = fill;
            roundRect(ctx, bx, y + 10, w, h, size * 0.75);
            ctx.fill();
            ctx.fillStyle = color;
            ctx.fillText(text, bx + size * 0.7, y + 10 + size * 0.42);
        };
        // 难度徽章靠右（规格：难度靠右）
        const diff = DIFF_FILL[entry.difficulty] || ["rgba(255,255,255,.14)", "#cfcee0"];
        drawBadge(DIFF_LABEL[entry.difficulty] || entry.difficulty, diff[0], diff[1], 11, true);
        // 封面
        const art = CARD_W - 24;
        const image = images[index];
        if (image) {
            ctx.save();
            roundRect(ctx, x + 12, y + 38, art, art, 10);
            ctx.clip();
            ctx.drawImage(image, x + 12, y + 38, art, art);
            ctx.restore();
        } else {
            ctx.fillStyle = "rgba(255,255,255,.10)";
            roundRect(ctx, x + 12, y + 38, art, art, 10);
            ctx.fill();
        }

        // 曲名
        // 曲名行：曲名在左，FC/AP 徽章贴右边、放大 1.5 倍、上端与曲名齐平
        // 曲名一行（放不下就省略）；FC/AP 徽章能并排就并排，
        // 放不下先缩小，再放不下就挪到曲名下面单独一行。
        // 曲名：一行，字号从 15 自动缩到 10，尽量把全名显示出来
        // 曲名：一行，字号从 15 自动缩到 10，尽量显示全名
        const titleY = y + 38 + art + 8;
        let titleSize = 15;
        ctx.font = `bold ${titleSize}px system-ui, 'Microsoft YaHei', sans-serif`;
        while (titleSize > 10 && ctx.measureText(String(entry.name)).width > art) {
            titleSize -= 1;
            ctx.font = `bold ${titleSize}px system-ui, 'Microsoft YaHei', sans-serif`;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillText(fitText(ctx, String(entry.name), art), x + 12, titleY);

        // 数值行：左边「原值 -> 计入值」，右边 FC/AP 徽章（12px）
        const vy = titleY + titleSize + 14;
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillStyle = entry.ap ? "#7ee0a8" : entry.fc ? "#7fc6ff" : "#e7e6f2";
        const first = lvl(entry.value);
        ctx.fillText(first, x + 12, vy);
        let vx = x + 12 + ctx.measureText(first).width + 7;
        ctx.fillStyle = "#8f8da8";
        ctx.font = "15px system-ui, sans-serif";
        ctx.fillText("\u2192", vx, vy + 4);
        vx += ctx.measureText("\u2192").width + 7;
        ctx.fillStyle = "#cfcee0";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillText(lvl(entry.counted), vx, vy);

        const fcText = entry.ap ? "ALL PERFECT" : entry.fc ? "FULL COMBO" : "";
        if (fcText) {
            const fcSize = 12;
            ctx.font = `bold ${fcSize}px system-ui, sans-serif`;
            const bw = ctx.measureText(fcText).width + fcSize * 1.4;
            const bx = x + CARD_W - 12 - bw;
            const by = vy + 1;
            ctx.fillStyle = entry.ap ? "rgba(255,138,190,.20)" : "rgba(127,198,255,.18)";
            roundRect(ctx, bx, by, bw, fcSize * 1.9, fcSize * 0.75);
            ctx.fill();
            ctx.fillStyle = entry.ap ? "#ff8abe" : "#7fc6ff";
            ctx.fillText(fcText, bx + fcSize * 0.7, by + fcSize * 0.42);
        }

    });

    // ---- 页脚 ----
    ctx.fillStyle = "#7c7a95";
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    const footY = height - FOOT + 22;
    ctx.fillText("AP 记谱面等级原值；FC 记「原值 − " + (record.fcPenalty ?? 1) + "」。"
        + "只统计 FC / AP，「完成」不计入。"
        + "Rating = 卡片这 " + entries.length + " 首计入值的平均，排名不看分数。", PAD, footY);
    ctx.fillText("选曲：账号包里游玩记录（打过就有、只增不减）中计入值最高的 25 首；"
        + "同值时原值高的在前，再同按乐曲 ID 排。", PAD, footY + 22);
    ctx.fillStyle = "#6a6880";
    ctx.fillText("牌子档位来自 MasterLiveTotalHighScoreRating（银 105500 / 金 211000）。"
        + "FC / AP 依据账号包 ClearedStatus 推断，未经官方确认，仅供参考。　Our Notes 配队助手",
        PAD, footY + 44);

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

