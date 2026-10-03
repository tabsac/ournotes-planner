/**
 * 用数据线（WebUSB / WebADB）在浏览器里直接读取手机上的账号包。
 *
 * 为什么需要它：Android 11 起系统禁止普通应用访问 `Android/data`，连「所有文件访问权限」
 * 也不行；只有 adb 的 shell 用户（uid 2000，属于 ext_data_rw 组）能读。浏览器通过 WebUSB
 * 直接跟手机的 adbd 对话，就等于自己当了一次 adb —— 不用 root、不用装软件，
 * 数据也完全不经过任何服务器。
 *
 * 前提：手机开「USB 调试」，电脑用 Chrome / Edge，且没有别的 adb 程序（Android Studio 等）
 * 占着设备 —— USB 接口同一时间只能被一个程序占用。
 */
import {Adb, AdbDaemonTransport, LinuxFileType} from "@yume-chan/adb";
import {AdbDaemonWebUsbDeviceManager} from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {ANDROID_FILES_DIR} from "./account-ui.js";

/** 这些目录是资源/缓存，里面有上 GB 的素材包，绝不能读。 */
const SKIP_DIRS = new Set([
    "EncryptedBundles", "Addressables", "Master", "RemoteCatalog",
    "il2cpp", "Unity", "UnityCache", "cache", "tmp",
]);

const MAX_FILE = 8 * 1024 * 1024;      // 单个文件上限
const MAX_TOTAL = 32 * 1024 * 1024;    // 累计上限
const MAX_FILES = 24;

function joinPath(dir, name) {
    return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

async function readAll(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
        }
    } finally {
        try { reader.releaseLock?.(); } catch { /* 忽略 */ }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

async function listDir(sync, path) {
    try {
        return await sync.readdir(path);
    } catch {
        return [];
    }
}

async function walk(sync, dir, out, budget, onStatus, depth = 0) {
    if (depth > 2 || budget.files >= MAX_FILES || budget.total >= MAX_TOTAL) return;
    const entries = await listDir(sync, dir);
    for (const entry of entries) {
        if (budget.files >= MAX_FILES || budget.total >= MAX_TOTAL) return;
        if (entry.name === "." || entry.name === "..") continue;
        const full = joinPath(dir, entry.name);
        if (entry.type === LinuxFileType.Directory) {
            if (SKIP_DIRS.has(entry.name)) continue;
            if (/^[0-9a-f]{64}$/i.test(entry.name) || depth === 0) {
                await walk(sync, full, out, budget, onStatus, depth + 1);
            }
            continue;
        }
        const size = Number(entry.size ?? 0);
        if (!size || size > MAX_FILE || budget.total + size > MAX_TOTAL) continue;
        onStatus(`读取 ${full.replace(ANDROID_FILES_DIR, "…")}（${Math.round(size / 1024)} KB）…`);
        try {
            const bytes = await readAll(sync.read(full));
            out.push({name: entry.name, bytes});
            budget.files += 1;
            budget.total += bytes.length;
        } catch {
            // 单个文件读失败不影响整体（可能被占用或权限不足）
        }
    }
}

/**
 * 连接手机并读取账号包候选文件。
 * @param {(text: string) => void} onStatus
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readAccountFromDevice(onStatus) {
    const status = onStatus || (() => {});
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager || !navigator.usb) {
        throw new Error("这个浏览器不支持 WebUSB。请用电脑上的 Chrome 或 Edge 打开本页（手机浏览器、微信/QQ 内置浏览器都不行）。");
    }

    status("请在弹出的列表里选择你的手机…");
    const device = await manager.requestDevice();
    if (!device) {
        throw new Error("没有选择手机。如果在列表里看到了手机、但「连接」按钮是灰的，"
            + "说明 USB 接口被别的程序占用，或者驱动不对（Chrome 只认 WinUSB 驱动，不认 libusbK 这类旧驱动）。"
            + "请先关掉 Android Studio 和各类手机助手，拔插一次数据线再试；仍不行就按下方帮助里的说明用 Zadig 换成 WinUSB。");
    }

    status(`正在连接 ${device.name || device.serial}…`);
    let connection;
    try {
        connection = await device.connect();
    } catch (error) {
        const name = error?.name || "";
        if (name.includes("Busy")) {
            throw new Error("手机被另一个程序占用了。请关掉 Android Studio、其它 adb 工具或手机助手后重试。");
        }
        throw new Error("无法连接手机：" + (error?.message || error) +
            "。请确认已在开发者选项里打开「USB 调试」，并在手机弹出的提示里点「允许」。");
    }

    const adb = new Adb(await AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore: new AdbWebCredentialStore("OurNotes 配队网页版"),
    }));

    try {
        // 确认手机上装了这个游戏，顺便给出更清楚的报错
        status("正在检查手机上的游戏…");
        const listing = await adb.subprocess.noneProtocol.spawnWaitText(
            ["ls", "/sdcard/Android/data"]);
        if (!listing.includes("com.bilibili.sirius.official")) {
            throw new Error("这台手机上没找到 Our Notes 的安装数据（com.bilibili.sirius.official）。请确认游戏已在这台手机上安装并登录过。");
        }

        const sync = await adb.sync();
        try {
            const out = [];
            const budget = {files: 0, total: 0};
            status("正在读取账号文件…");
            await walk(sync, ANDROID_FILES_DIR, out, budget, status);
            return out;
        } finally {
            try { await sync.dispose(); } catch { /* 忽略 */ }
        }
    } finally {
        try { await adb.close(); } catch { /* 忽略 */ }
    }
}
