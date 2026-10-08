/**
 * 「导入账号包」界面。
 *
 * 三条入口，最终都汇到同一个解包流程：
 *   1. 用数据线自动读取（安卓，WebUSB/WebADB）—— 非 root 也能读 Android/data
 *   2. 选择文件 / 选择整个文件夹 / 拖拽（含 zip 压缩包）
 *   3. 任意来源的账号包都能拖进来
 *
 * 解密与解析全部在浏览器里完成，账号数据不上传任何服务器。
 */
import {stickerCollection} from "./account-collection.js";
import {GAME_CHANNELS} from "./account-channels.js";
import {findPlayerPackage, looksLikePackage, decodePastedText, extractPlayer} from "./account-package.js";
import {readZip, looksLikeZip} from "./account-zip.js";
import {saveScores} from "./b25-ui.js";

export const ANDROID_PACKAGE = "com.bilibili.sirius.official";
export const ANDROID_FILES_DIR = `/sdcard/Android/data/${ANDROID_PACKAGE}/files`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

/* ------------------------------------------------------------ 文件收集 */

async function collectFromFiles(fileList, onStatus) {
    const files = Array.from(fileList || []);
    const entries = [];
    for (const file of files) {
        if (!file || !file.size) continue;
        onStatus(`读取 ${file.name}…`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (looksLikeZip(bytes)) {
            onStatus(`解压 ${file.name}…`);
            const inner = await readZip(bytes, (name) => onStatus(`解压 ${name}…`));
            for (const e of inner) entries.push({name: e.name, bytes: e.bytes});
        } else {
            entries.push({name: file.name, bytes});
        }
    }
    return entries;
}

/* -------------------------------------------------------------- 转换 */

function pickCandidates(profile, catalog, kind) {
    const table = kind === "members" ? catalog.members : catalog.snaps;
    const byId = new Map(table.map(c => [c.id, c]));
    const rows = profile.inventory[kind]
        .map(r => ({row: r, card: byId.get(r.id)}))
        .filter(x => x.card);
    const strength = x => ((x.card.rarity || 0) * 100000) + (x.row.level || 0);

    if (kind === "snaps") {
        return rows.sort((a, b) => strength(b) - strength(a)).slice(0, 5).map(x => x.row.id);
    }
    // 成员卡：每个角色只留一张最强的，再取最强的 5 个角色 —— 正好满足「至少 5 位不同角色」
    const perCharacter = new Map();
    for (const x of rows) {
        const cid = x.card.character_id;
        if (!perCharacter.has(cid) || strength(x) > strength(perCharacter.get(cid))) perCharacter.set(cid, x);
    }
    return Array.from(perCharacter.values())
        .sort((a, b) => strength(b) - strength(a))
        .slice(0, 5)
        .map(x => x.row.id);
}

function currentSettings() {
    try {
        const state = window.PlannerAccount?.current?.();
        if (state?.settings?.normal && state?.settings?.challenge) return JSON.parse(JSON.stringify(state.settings));
    } catch { /* 忽略，用默认 */ }
    const sheets = [100056, 100063, 100109].map(id => ({song_id: id, difficulty: "expert"}));
    return {
        boost_budget: 20, boost_per_live: 4, starting_cp: 0, challenge_cp: 200,
        normal: {song_id: 100109, difficulty: "expert", method: "ap", sheets},
        challenge: {song_id: 100109, difficulty: "expert", method: "ap", sheets},
    };
}

export function buildImportPayload(profile, report, catalog) {
    const ownedMembers = new Set(profile.inventory.members.map(r => r.id));
    const ownedSnaps = new Set(profile.inventory.snaps.map(r => r.id));
    const candidates = {
        candidate_member_ids: pickCandidates(profile, catalog, "members").filter(id => ownedMembers.has(id)),
        candidate_snap_ids: pickCandidates(profile, catalog, "snaps").filter(id => ownedSnaps.has(id)),
    };
    return {
        schema_version: 1,
        name: report?.player_name ? `${report.player_name} 的账号包` : "账号包导入",
        profile,
        settings: currentSettings(),
        ...candidates,
        account_import: {
            account_id: report?.account_id ?? null,
            member_count: report?.member_count ?? profile.inventory.members.length,
            snap_count: report?.snap_count ?? profile.inventory.snaps.length,
            character_count: report?.character_count ?? profile.character_ranks.length,
            character_total_rank: profile.character_total_rank,
            warnings: report?.warnings || [],
            sticker_collection_known: profile.inventory.stickers?.known === true,
        },
    };
}

/* ---------------------------------------------------------------- 界面 */

/** 账号页里只放一张「已存好」的摘要，完整卡片在「B25 成绩」页。 */
function b25TeaserHtml(scores, saved) {
    if (!saved || !scores?.available) {
        const notes = (scores?.notes || []).map(n => `<li>${esc(n)}</li>`).join("");
        return notes ? `<div class="notice"><b>B25 成绩：取不到</b><ul>${notes}</ul></div>` : "";
    }
    const stats = scores.stats || {};
    return `<div class="b25-teaser">
  <div>
    <b>${saved.pending ? "B25 成绩预览（导入后保存）" : "B25 成绩已保存"}</b>
    <span class="b25-teaser-line">共 ${stats.count} 首　FC ${stats.fc_count} / AP ${stats.ap_count}
      　Rating <b>${(Math.round(stats.rating_avg * 100) / 100).toFixed(2)}</b>
      <span class="b25-teaser-note">（谱面等级平均）</span></span>
  </div>
  <a href="#b25" class="button-link primary" data-goto="b25">查看 B25 成绩 / 下载图片</a>
</div>`;
}

function bindB25Teaser(container) {
    if (!container) return;
    container.querySelectorAll("[data-goto]").forEach(el => {
        el.addEventListener("click", (event) => {
            event.preventDefault();
            const tab = el.dataset.goto;
            document.querySelectorAll(".tab-page").forEach(p => p.hidden = p.id !== tab);
            document.querySelectorAll(".tabs button").forEach(b =>
                b.classList.toggle("active", b.dataset.tab === tab));
            history.replaceState(null, "", "#" + tab);
        });
    });
}

export function mountAccountImport(root) {    if (!root) return;
    root.innerHTML = `
<div class="panel">
  <div class="section-kicker">一键导入 / 全部在浏览器本地完成</div>
  <h2>从游戏账号包导入卡库</h2>
  <p>账号包是游戏保存在手机里的账号数据文件（加密的）。本页在你的浏览器里解密并读出卡牌、等级、觉醒与特训，
     再把结果填进「我的卡库」，省掉逐张手填。文件不会上传到任何服务器。</p>

  <div class="account-actions">
    <a class="button-link primary" href="./downloads/ournotes-取包工具.zip" download>① 下载电脑取包工具（安卓 · 推荐）</a>
    <a class="button-link" href="./downloads/ournotes-box.apk" download>下载手机端 App（安卓 · 需「无线调试」）</a>
  </div>
  <p class="tiny muted">取包工具是免安装的 Windows 小工具（已内置 adb，不用 root、不用装驱动），
     解压后双击 <code>取包.bat</code>，它会自动找到手机上的账号包并打成 zip，把那个 zip 拖回本页即可。
     详见 <a href="./downloads/取包工具-使用说明.txt" target="_blank" rel="noopener">使用说明</a>。</p>

  <div class="account-actions">
    <button id="accountPickFiles" type="button">选择文件 / zip</button>
    <button id="accountPickDir" type="button">选择游戏文件夹</button>
    <label>游戏版本 <select id="accountGameVersion"><option value="">自动识别（只安装一个版本时）</option>${GAME_CHANNELS.map(c=>`<option value="${c.packageId}">${c.label}</option>`).join("")}</select></label>
    <button id="accountAdb" type="button">浏览器直连手机（部分机型可用）</button>
  </div>

  <div id="accountDrop" class="account-drop">
    <strong>把账号包文件、或整个文件夹压缩成的 zip，拖到这里</strong>
    <span>支持：单个账号包文件、包含账号包的文件夹、zip 压缩包</span>
  </div>

  <div class="account-paste">
    <label for="accountPaste"><b>或者：粘贴手机端 App（Shizuku）生成的那段文本</b>
      <span class="muted">（在手机端 App 中复制导入文本，再粘贴到这里；也可发送到电脑后导入）</span></label>
    <textarea id="accountPaste" rows="4" spellcheck="false"
      placeholder="粘贴手机端 App 生成的 ONPKG1: 导入文本"></textarea>
    <button id="accountPasteGo" type="button" class="primary">导入粘贴的文本</button>
  </div>

  <details class="account-help">
    <summary><b>第一次用？点开看取包教程</b>（安卓 / iOS，含连不上手机的排查）</summary>
    <div id="accountHelpBody"></div>
  </details>

  <div id="accountStatus" class="notice" hidden></div>
  <div id="accountReport" hidden></div>
</div>`;

    const $ = id => root.querySelector("#" + id);
    const status = (text, type = "") => {
        const el = $("accountStatus");
        el.hidden = !text;
        el.textContent = text || "";
        el.className = "notice " + type;
    };
    const report = $("accountReport");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.multiple = true;
    dirInput.webkitdirectory = true;
    dirInput.hidden = true;
    root.append(fileInput, dirInput);

    let pending = null;

    async function handleFiles(list) {
        report.hidden = true;
        pending = null;
        try {
            const entries = await collectFromFiles(list, t => status(t));
            if (!entries.length) { status("没有读到任何文件。", "error"); return; }
            await unpack(entries);
        } catch (error) {
            status("读取失败：" + (error?.message || error), "error");
        }
    }

    async function unpack(entries) {
        status(`正在识别账号包（${entries.length} 个文件）…`);
        const candidates = entries.filter(e => looksLikePackage(e.bytes));
        if (!candidates.length) {
            status("这些文件里没有找到账号包。（账号包是游戏保存在手机里的数据文件，不是截图、也不是抓包记录。）", "error");
            return;
        }
        const found = findPlayerPackage(candidates, (d, t, n) => status(`解密 ${d}/${t}：${n}…`));
        if (!found || !found.player) {
            status("找到了疑似账号包，但里面没有玩家数据。可能选错了目录。", "error");
            return;
        }
        const accounts = found.all.map(c => ({name: c.name, player: extractPlayer(c.json)})).filter(c => c.player);
        if (accounts.length > 1) {
            report.hidden = false;
            status("找到多个账号，请选择要预览的账号；确认导入前不会修改卡库和成绩。");
            report.innerHTML = `<div class="notice"><b>选择账号</b><p>不同游戏版本或历史文件可能包含不同账号。</p>${accounts.map((c, i) => `<button type="button" data-account-choice="${i}">${esc(c.player._name || "未命名")} · ${esc(c.player._accountid || "未知账号")} · 成员卡 ${c.player._memberCards?.length || 0} 张</button>`).join(" ")}</div>`;
            report.querySelectorAll("[data-account-choice]").forEach(button => button.addEventListener("click", async () => {
                const selected = accounts[Number(button.dataset.accountChoice)];
                report.querySelectorAll("button").forEach(b => b.disabled = true);
                await importPlayer(selected.player, selected.name);
            }));
            return;
        }
        status("解密成功，正在按当前主数据换算等级…");
        await importPlayer(found.player, found.name);
    }

    /** 拿到 `_player` 之后的所有步骤：换算 -> 报告 -> 等用户确认合并。 */
    async function importPlayer(player, sourceLabel) {
        if (!player || !Array.isArray(player._memberCards) || !player._memberCards.length) {
            status("这份数据没有成员卡，可能读取了新号、空存档或错误文件。未修改当前卡库和成绩，请核对游戏昵称与 UID。", "error");
            return;
        }
        const response = await window.plannerFetch("/api/account-import", {
            method: "POST",
            body: JSON.stringify({player}),
        });
        const payload = await response.json();
        if (payload.error) { status("换算失败：" + payload.error, "error"); return; }
        if (!payload.profile?.inventory?.members?.length) {
            status("账号中的成员卡无法按当前游戏数据识别，可能是游戏版本或服务器数据不匹配。未修改当前卡库和成绩，请反馈所选版本。", "error");
            return;
        }
        payload.profile.inventory.stickers = stickerCollection(player);
        payload.report.sticker_collection = payload.profile.inventory.stickers;
        pending = payload;
        status("");
        showReport(payload, sourceLabel);
    }

    function showReport(payload, fileName) {
        const {profile, report: info} = payload;
        const warnings = (info.warnings || []).map(w => `<li>${esc(w)}</li>`).join("");
        report.hidden = false;
        report.innerHTML = `
<div class="panel account-report">
  <h3>识别结果</h3>
  <p class="account-source">来源文件：<code>${esc(fileName)}</code>　玩家：<b>${esc(info.player_name || "（未命名）")}</b>
     ${info.account_id_text ? `　ID：<code>${esc(info.account_id_text)}</code>` : ""}</p>
  <table class="account-summary">
    <tbody>
      <tr><th>贴纸收藏</th><td>${profile.inventory.stickers?.known ? `${profile.inventory.stickers.counts.filter(r => r.count > 0).length} 种（随卡库保存）` : "账号包未提供收藏信息"}</td></tr>
      <tr><th>成员卡</th><td>${profile.inventory.members.length} 张</td></tr>
      <tr><th>留影卡（Snap）</th><td>${profile.inventory.snaps.length} 张</td></tr>
      <tr><th>角色</th><td>${profile.character_ranks.length} 位，总角色等级 ${profile.character_total_rank}</td></tr>
      <tr><th>乐队道具</th><td>${profile.facilities.length} 项</td></tr>
      <tr><th>T.G.W CARD 等级</th><td>${profile.tgw_card_rank}</td></tr>
    </tbody>
  </table>
  ${warnings ? `<div class="notice"><b>注意：</b><ul>${warnings}</ul></div>` : ""}
  <div id="accountB25" class="account-b25-slot"></div>
  <p>导入后会替换当前的「我的卡库」。候选卡池默认取每位角色最强的一张（成员卡 5 张）和 5 张留影卡，
     导入后可以在「我的卡库」里勾选更多。</p>
  <div class="account-actions">
    <button id="accountApply" type="button" class="primary">合并进卡库</button>
    <button id="accountDiscard" type="button">取消</button>
  </div>
</div>`;
        // 成绩不在这一页展开，存下来交给「B25 成绩」页渲染（那边刷新页面也不会丢）
        const saved = {pending: true};
        report.querySelector("#accountB25").innerHTML = b25TeaserHtml(payload.scores, saved);
        bindB25Teaser(report.querySelector("#accountB25"));
        report.querySelector("#accountApply").addEventListener("click", () => {
            try {
                const catalog = window.PlannerAccount.catalog();
                const wrapper = buildImportPayload(profile, info, catalog);
                window.PlannerAccount.apply(wrapper, "账号包已导入，请核对实际养成后计算。");
                const saved = saveScores(payload.scores, {
            playerName: info.player_name,
            accountId: info.account_id_text || info.account_id,
            source: fileName,
        });
                report.querySelector("#accountB25").innerHTML = b25TeaserHtml(payload.scores, saved);
                bindB25Teaser(report.querySelector("#accountB25"));
            } catch (error) {
                status("导入失败：" + (error?.message || error), "error");
            }
        });
        report.querySelector("#accountDiscard").addEventListener("click", () => {
            pending = null; report.hidden = true; status("");
        });
    }

    $("accountPickFiles").addEventListener("click", () => fileInput.click());
    $("accountPickDir").addEventListener("click", () => dirInput.click());
    fileInput.addEventListener("change", () => handleFiles(fileInput.files));
    dirInput.addEventListener("change", () => handleFiles(dirInput.files));

    $("accountPasteGo").addEventListener("click", async () => {
        report.hidden = true;
        pending = null;
        try {
            status("正在解析粘贴的文本…");
            const decoded = await decodePastedText($("accountPaste").value);
            if (!decoded) {
                status("认不出这段文本。请确认复制的是取包工具生成的那一整段（以 ONPKG1: 开头）。", "error");
                return;
            }
            status("解析成功，正在按当前主数据换算等级…");
            await importPlayer(decoded.player, decoded.source);
        } catch (error) {
            status("导入失败：" + (error?.message || error), "error");
        }
    });

    const drop = $("accountDrop");
    for (const type of ["dragenter", "dragover"]) {
        drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add("over"); });
    }
    for (const type of ["dragleave", "drop"]) {
        drop.addEventListener(type, () => drop.classList.remove("over"));
    }
    drop.addEventListener("drop", e => {
        e.preventDefault();
        const items = e.dataTransfer?.files;
        if (items?.length) handleFiles(items);
    });

    $("accountAdb").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const {readAccountFromDevice} = await loadAdbModule();
            const entries = await readAccountFromDevice(t => status(t), $("accountGameVersion").value);
            if (!entries.length) { status("没有从手机里读到账号包文件。", "error"); return; }
            await unpack(entries);
        } catch (error) {
            status("读取手机失败：" + (error?.message || error), "error");
        } finally {
            button.disabled = false;
        }
    });

    $("accountHelpBody").innerHTML = helpHtml();
}

/**
 * 懒加载 WebADB 模块（它比较大，只有真用的时候才下载）。
 *
 * 站点每次更新都会换掉 chunk 的文件名。停在旧页面的用户点这个按钮时，会去请求一个
 * 已经不存在的文件，报「Failed to fetch dynamically imported module」。这里遇到
 * 这种情况就自动刷新一次页面（用 sessionStorage 防止无限刷新）。
 */
async function loadAdbModule() {
    const flag = "ournotes-account-adb-reloaded";
    try {
        return await import("./account-adb.js");
    } catch (error) {
        const message = String(error?.message || error);
        if (/dynamically imported module|Importing a module script failed/i.test(message)
            && !sessionStorage.getItem(flag)) {
            sessionStorage.setItem(flag, "1");
            location.reload();
            await new Promise(() => {});   // 等页面刷新，不再往下走
        }
        throw error;
    }
}

/* ----------------------------------------------------------- 帮助文本 */

function helpHtml() {
    return `
<p><b>无需改名：</b>工具按实际安装版本读取。不要给文件或文件夹添加 .official，也不要重命名、移动、删除游戏数据目录。</p>
<p>可识别国际版官网、Google Play 国际版与日服的安装包。国际版已验证取包解密；日服的真实账号解密与卡库换算仍待验证。</p>
<p><b>账号包是什么</b>：游戏保存在手机里的账号数据文件，路径是</p>
<pre>${GAME_CHANNELS.map(c => `Android/data/${c.packageId}/files/`).join("\n")}</pre>
<p>里面有三个文件，都是加密的，本页负责解密。目录名和文件名都是内容哈希、会随版本变，
   所以本页不靠文件名认，而是逐个尝试解密，取能解出玩家数据的那一份。</p>

<h4>安卓：电脑取包工具（推荐）</h4>
<ol>
  <li>下载并解压 <a href="./downloads/ournotes-取包工具.zip" download>ournotes-取包工具.zip</a>（免安装，已内置 adb）</li>
  <li>手机上打开开发者选项里的 <b>USB 调试</b>，并且把
      <b>「『仅充电』模式下允许 ADB 调试」</b>也打开（不少华为手机默认关着，不开的话电脑上根本不会出现 ADB 接口）</li>
  <li>用数据线连到电脑，手机弹出「允许 USB 调试吗？」时勾选<b>始终允许</b>再点允许</li>
  <li>双击解压出来的 <code>取包.bat</code>，它会自动找到手机上的账号包，打包成带时间标记的 <code>账号包-日期时间.zip</code> 并帮你打开所在文件夹</li>
  <li>把本次生成的账号包 zip 拖回本页</li>
</ol>
<p>为什么推荐它：内置了 adb，不需要 root，也不需要装驱动或手机助手，更不受浏览器对 USB 设备的限制。
   详细排查见压缩包里的「使用说明.txt」。</p>

<h4>连不上手机？按顺序排查</h4>
<p><b>手机端</b></p>
<ol>
  <li>「USB 调试」确认已打开，<b>「『仅充电』模式下允许 ADB 调试」也要打开</b>。</li>
  <li>下拉通知栏，把 USB 用途从「仅充电」改成<b>传输文件</b>。</li>
  <li>开发者选项里点一次<b>撤销 USB 调试授权</b>，拔掉数据线重插，再看手机屏幕有没有新的授权弹窗。</li>
</ol>
<p><b>线材与接口</b></p>
<ol start="4">
  <li>换一根线。很多线只能充电、不能传数据，这是最常见的原因。</li>
  <li>换一个 USB 口。台式机优先插主板后面板的口，别用前面板或 USB Hub。</li>
</ol>
<p><b>驱动</b></p>
<ol start="6">
  <li>最省事的办法：装一次手机厂商的 PC 助手（华为手机助手等），让它把 USB 驱动装好，
      装完<b>关掉它</b>再运行取包工具（它可能占用手机连接）。</li>
  <li>如果你以前用 Zadig 之类的工具给这台手机换过驱动（比如为了试 WebUSB），
      必须先把那些驱动删干净 —— 否则 Windows 里连 ADB 接口都不会出现，插上手机也没反应。</li>
</ol>

<h4>如果以前用 Zadig / libusbK 改过驱动</h4>
<p>这类工具会把手机的<b>复合设备父节点</b>整个绑到 WinUSB 或 libusbK 上，
   于是 USB 复合设备不再展开、ADB 接口在 Windows 里直接消失。而且删掉一个之后，
   libusbK 的通用驱动（<code>drv_device.inf</code> 之类，匹配面很宽）会立刻接手，需要一起清掉。</p>
<ol>
  <li><b>拔掉手机</b>（占用中的驱动删不掉）</li>
  <li>设备管理器 → 找到带手机名的项（通常在「通用串行总线设备」或「libusbK Usb Devices」下）
      → 右键卸载设备 → 勾选<b>删除此设备的驱动程序软件</b></li>
  <li>设备管理器 → 查看 → <b>显示隐藏的设备</b>，把灰色的残留节点也删掉</li>
  <li>以管理员身份运行 PowerShell，先看有哪些：<code>pnputil /enum-drivers</code>，
      再删掉 Provider 是 <code>libwdi</code> / <code>libusbK</code>、且原始名称属于这台手机的那些：
      <code>pnputil /delete-driver oemXX.inf /uninstall /force</code></li>
  <li>重新插上手机，系统会重新枚举成正常的 USB 复合设备</li>
</ol>
<p class="muted">取包工具的压缩包里带了一个自动做这件事的脚本：<code>清理手机驱动.bat</code>
   （双击即可，会自己申请管理员权限）。它会先判断哪些驱动确实属于这台手机、
   哪些是别的设备在用的（比如某些鼠标接收器也是 libwdi 装的），不会误删。</p>

<h4>安卓：手机端 App（Shizuku）—— 适合有「无线调试」的机型</h4>
<ol>
  <li>装 <a href="https://shizuku.rikka.app/" target="_blank" rel="noopener">Shizuku</a></li>
  <li>开发者选项里打开<b>无线调试</b>，在 Shizuku 里按提示「通过无线调试启动」完成配对</li>
  <li>装 <a href="./downloads/ournotes-box.apk" download>ournotes-box.apk</a>，打开后读取账号包</li>
  <li>它会显示一段以 <code>ONPKG1:</code> 开头的文字（不到 1 KB），复制后用微信/QQ 发到电脑，
      粘到本页下面的文本框即可</li>
</ol>
<p><b>华为等机型请注意</b>：这条路依赖「无线调试」。部分厂商把它从开发者选项里去掉了，
   Shizuku 就无法在手机上自行启动，这类机型请用上面的电脑取包工具。</p>

<h4>其它情况</h4>
<p><b>安卓 10 及更早</b>：系统还没限制 <code>Android/data</code>，直接用手机自带的文件管理器进上面那个目录，
   把 64 位十六进制命名的文件夹压缩成 zip 传到电脑，再用本页「选择文件」。</p>
<p><b>iOS</b>：iOS 拿不到应用沙盒，游戏接口也有证书绑定（普通抓包工具抓不到）。
   可用的办法是用「爱思助手」或 iMazing 连接 iPhone，在应用列表里找到 Our Notes，
   导出它的「文档(Documents)」目录，再回本页「选择文件」选择导出的内容。</p>

<h4>「浏览器直连手机」按钮为什么经常用不了</h4>
<p>那个按钮走浏览器的 WebUSB，不用装任何东西，但限制很硬：
   <b>Chrome 会直接拒绝带有「大容量存储」接口的设备</b>。而很多手机（尤其华为）一插上电脑就会虚拟出一个光驱，
   用来弹出提示让你装厂商 PC 助手 —— 于是这些机型上这个按钮<b>必然用不了，换什么驱动都没用</b>。
   能用就用，用不了就走电脑取包工具。</p>`;
}
