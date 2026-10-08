/**
 * 账号包解包器 —— 纯前端，无依赖。
 *
 * 明日方舟… 不，BanG Dream! Our Notes（`com.bilibili.sirius.official`）把玩家的账号数据
 * 以三个文件保存在 Application.persistentDataPath 下，格式与 assets/Master/*.bin 相同：
 *
 *   1. 前 64 字节 = A1(32B) ‖ IV(32B)，明文写在文件里（salt 与 IV 都不保密）
 *   2. 其余部分 = Rijndael-256-CBC 密文
 *        KEY = 固定常量（客户端里的 Fwk.UnityCipher.RijndaelEncryption）
 *        IV  = 文件头 [32:64]
 *   3. 去掉 PKCS#7 填充（按 32 字节对齐）
 *   4. 明文是纯 JSON，**不再 gzip**（主数据才 gzip）
 *
 * 密码是 Rijndael 的 **256 位分组**（Nb=8, Nk=8），不是 AES —— AES 只是 Nb=4 的特例，
 * 所以这里必须自己实现，标准 WebCrypto / 任何 AES 库都解不出来。
 */

const A1 = hexToBytes("b50b23a5fd628c3dc386f7488f81d6b0450b8c89671574f55a3ad815f10b8e30");
const PACKAGE_KEY = hexToBytes("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6");

const HEADER_SIZE = 64;
const BLOCK_SIZE = 32;

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

/* ------------------------------------------------------------------ 表 */

const SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);

const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;

const RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d,0x9a];

function extendRcon(n) {
    const r = RCON.slice();
    while (r.length < n) {
        const prev = r[r.length - 1];
        let next = (prev << 1) & 0xff;
        if (prev & 0x80) next ^= 0x1b;
        r.push(next);
    }
    return r;
}

/** 逆 MixColumns 用的乘法表（9/11/13/14），做成查表省掉逐位乘法。 */
function mulTable(n) {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let a = i, b = n, r = 0;
        while (b) {
            if (b & 1) r ^= a;
            a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
            b >>= 1;
        }
        t[i] = r & 0xff;
    }
    return t;
}
const M9 = mulTable(9), M11 = mulTable(11), M13 = mulTable(13), M14 = mulTable(14);
const M2 = mulTable(2), M3 = mulTable(3);

/** ShiftRows 的行偏移随分组宽度变化（Nb=8 时是 [0,1,3,4]）。 */
const SHIFTS = {4: [0, 1, 2, 3], 6: [0, 1, 2, 3], 8: [0, 1, 3, 4]};

/* -------------------------------------------------------------- Rijndael */

class Rijndael {
    constructor(key, blockBits = 256) {
        this.Nb = blockBits / 32;
        this.Nk = key.length / 4;
        if (!SHIFTS[this.Nb]) throw new Error("不支持的分组长度 " + blockBits);
        if (![4, 6, 8].includes(this.Nk)) throw new Error("不支持的密钥长度");
        this.Nr = Math.max(this.Nb, this.Nk) + 6;
        this.block = this.Nb * 4;
        this.roundKeys = this.expand(key);
    }

    expand(key) {
        const {Nb, Nk, Nr} = this;
        const w = [];
        for (let i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
        const total = Nb * (Nr + 1);
        const rcon = extendRcon(Math.floor(total / Nk) + 2);
        for (let i = Nk; i < total; i++) {
            let t = w[i - 1].slice();
            if (i % Nk === 0) {
                t = [t[1], t[2], t[3], t[0]].map(b => SBOX[b]);
                t[0] ^= rcon[i / Nk - 1];
            } else if (Nk > 6 && i % Nk === 4) {
                t = t.map(b => SBOX[b]);
            }
            w.push([0, 1, 2, 3].map(j => w[i - Nk][j] ^ t[j]));
        }
        const rks = [];
        for (let r = 0; r <= Nr; r++) {
            const rk = new Uint8Array(this.block);
            for (let c = 0; c < Nb; c++) for (let j = 0; j < 4; j++) rk[4 * c + j] = w[r * Nb + c][j];
            rks.push(rk);
        }
        return rks;
    }

    decryptBlock(block) {
        const Nb = this.Nb;
        const s = Uint8Array.from(block);
        const shifts = SHIFTS[Nb];

        const addKey = rk => { for (let i = 0; i < s.length; i++) s[i] ^= rk[i]; };
        const invShiftRows = () => {
            const out = new Uint8Array(s.length);
            for (let r = 0; r < 4; r++) {
                const off = shifts[r];
                for (let c = 0; c < Nb; c++) out[4 * ((c + off) % Nb) + r] = s[4 * c + r];
            }
            s.set(out);
        };
        const invSubBytes = () => { for (let i = 0; i < s.length; i++) s[i] = INV_SBOX[s[i]]; };
        const invMixColumns = () => {
            for (let c = 0; c < Nb; c++) {
                const i = 4 * c;
                const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
                s[i]     = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
                s[i + 1] = M9[a0]  ^ M14[a1] ^ M11[a2] ^ M13[a3];
                s[i + 2] = M13[a0] ^ M9[a1]  ^ M14[a2] ^ M11[a3];
                s[i + 3] = M11[a0] ^ M13[a1] ^ M9[a2]  ^ M14[a3];
            }
        };

        addKey(this.roundKeys[this.Nr]);
        for (let r = this.Nr - 1; r > 0; r--) {
            invShiftRows(); invSubBytes(); addKey(this.roundKeys[r]); invMixColumns();
        }
        invShiftRows(); invSubBytes(); addKey(this.roundKeys[0]);
        return s;
    }

    /** CBC 解密。data 必须是 block 的整数倍（多余尾部按原版实现丢弃）。 */
    decryptCbc(data, iv) {
        const out = new Uint8Array(data.length - (data.length % this.block));
        let prev = iv;
        for (let i = 0; i + this.block <= data.length; i += this.block) {
            const blk = data.subarray(i, i + this.block);
            const dec = this.decryptBlock(blk);
            for (let j = 0; j < this.block; j++) out[i + j] = dec[j] ^ prev[j];
            prev = blk;
        }
        return out;
    }

    encryptBlock(block) {
        const Nb = this.Nb;
        const s = Uint8Array.from(block);
        const shifts = SHIFTS[Nb];
        const addKey = rk => { for (let i = 0; i < s.length; i++) s[i] ^= rk[i]; };
        const subBytes = () => { for (let i = 0; i < s.length; i++) s[i] = SBOX[s[i]]; };
        const shiftRows = () => {
            const out = new Uint8Array(s.length);
            for (let r = 0; r < 4; r++) {
                const off = shifts[r];
                for (let c = 0; c < Nb; c++) out[4 * ((c - off + Nb) % Nb) + r] = s[4 * c + r];
            }
            s.set(out);
        };
        const mixColumns = () => {
            for (let c = 0; c < Nb; c++) {
                const i = 4 * c;
                const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
                s[i]     = M2[a0] ^ M3[a1] ^ a2 ^ a3;
                s[i + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3;
                s[i + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3];
                s[i + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3];
            }
        };
        addKey(this.roundKeys[0]);
        for (let r = 1; r < this.Nr; r++) { subBytes(); shiftRows(); mixColumns(); addKey(this.roundKeys[r]); }
        subBytes(); shiftRows(); addKey(this.roundKeys[this.Nr]);
        return s;
    }
}

/* ------------------------------------------------------------ 账号包 API */

/** 判断一个文件是不是账号包（前 32 字节是 A1）。 */
export function looksLikePackage(bytes) {
    if (!bytes || bytes.length < HEADER_SIZE + BLOCK_SIZE) return false;
    for (let i = 0; i < 32; i++) if (bytes[i] !== A1[i]) return false;
    return true;
}

function stripPkcs7(buf, block = BLOCK_SIZE) {
    if (!buf.length) return null;
    const n = buf[buf.length - 1];
    if (n === 0 || n > block || n > buf.length) return null;
    for (let i = buf.length - n; i < buf.length; i++) if (buf[i] !== n) return null;
    return buf.subarray(0, buf.length - n);
}

/**
 * 解密一个账号包文件。
 * @returns {{json: object, plain: Uint8Array} | null} 失败返回 null（不抛）
 */
export function decryptPackage(bytes) {
    if (!looksLikePackage(bytes)) return null;
    const body = bytes.subarray(HEADER_SIZE);
    if (body.length % BLOCK_SIZE !== 0) return null;
    const iv = bytes.subarray(32, 64);
    let plain;
    try {
        plain = new Rijndael(PACKAGE_KEY, 256).decryptCbc(body, iv);
    } catch {
        return null;
    }
    const stripped = stripPkcs7(plain);
    if (!stripped) return null;
    let text;
    try {
        text = new TextDecoder("utf-8", {fatal: true}).decode(stripped);
    } catch {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
        return {json: parsePreservingInt64(trimmed), plain: stripped};
    } catch {
        return null;
    }
}

/** 从一份解密结果里取出玩家数据（`_player`）。 */
export function extractPlayer(data) {
    if (!data || typeof data !== "object") return null;
    if (data._player && typeof data._player === "object") return data._player;
    return null;
}

/**
 * 解析账号包里的 JSON，同时保住 int64 精度。
 *
 * 账号包里的 `_accountid` 是 int64（实测 7445432298994985508），
 * 它比 JS 的安全整数上限 2^53-1 大，直接 `JSON.parse` 会被四舍五入成
 * `7445432298994986000` —— 而且是在**进入 Python 之前**就已经错了，
 * 所以 Python 侧再怎么 `str()` 也救不回来。
 *
 * JSON.parse 的 reviver 拿到的已经是舍入后的 Number，救不了，只能在文本层先把
 * 这些超长整数字面量加上引号。只匹配「冒号 + 16 位以上数字 + 分隔符」，
 * 命中的就是 ID 类字段；分数、等级这些都只有个位数到 9 位数，不会被碰到。
 * 字符串里的数字前面不是冒号，也不会被误伤。
 */
const BIG_INT = /:\s*(\d{16,})(?=\s*[,}\]])/g;

export function parsePreservingInt64(text) {
    return JSON.parse(text.replace(BIG_INT, ': "$1"'));
}

/* ------------------------------------------------- 手机 App 生成的紧凑文本 */

/** 与 App 端 `AccountPackage.PREFIX` 保持一致。 */
export const COMPACT_PREFIX = "ONPKG1:";

function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/**
 * 把 App 输出的紧凑格式还原成与游戏 `_player` 相同的形状，
 * 后面的映射（Python 侧的 account_import）就能原样复用，不必写第二套逻辑。
 */
export function expandCompact(compact) {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const player = {
        _name: typeof compact.name === "string" ? compact.name : "",
        _accountid: typeof compact.aid === "string" && /^\d+$/.test(compact.aid) ? compact.aid : num(compact.aid),
        _memberCards: (compact.m || []).map(r => ({
            _masterId: num(r[0]), _exp: num(r[1]), _awakeCount: num(r[2]) || 1,
            _rank: num(r[3]) || 1, _liveSkillLevel: num(r[4]) || 1,
            _performanceSkillLevel: num(r[5]) || 1,
        })),
        _supportCards: (compact.s || []).map(r => ({
            _masterId: num(r[0]), _exp: num(r[1]), _rank: num(r[2]) || 1,
            _duplicateCount: num(r[3]),
        })),
        _characters: (compact.c || []).map(r => ({_masterId: num(r[0]), _exp: num(r[1])})),
        _characterFriendships: (compact.f || []).map(r => ({
            _pair: {_masterCharacterIdA: num(r[0]), _masterCharacterIdB: num(r[1])}, _exp: num(r[2]),
        })),
        _items: (compact.i || []).map(r => ({_masterItemId: num(r[0]), _amount: num(r[1])})),
        _bandItems: (compact.b || []).map(r => ({_masterId: num(r[0]), _level: num(r[1])})),
    };
    if (Object.hasOwn(compact, "dg")) player._degrees = compact.dg;
    if (Object.hasOwn(compact, "st")) player._stamps = compact.st;
    if (Object.hasOwn(compact, "lr")) player._liveMusicResults = compact.lr;
    if (Object.hasOwn(compact, "hr")) player._topHighScoreRatings = compact.hr;
    const channelLabels = {"com.bilibili.sirius.official":"国际版（官网）", "com.bilibili.sirius":"国际版（Google Play）", "com.bushiroad.sirius":"日服"};
    return {player, packageId: channelLabels[compact.pkg] ? compact.pkg : null,
        source: "手机取包工具" + (channelLabels[compact.pkg] ? ` · ${channelLabels[compact.pkg]}` : "")};
}

/**
 * 解析用户粘贴进来的文本。支持两种：
 *   1. App 生成的 `ONPKG1:` 紧凑文本（推荐）
 *   2. 直接粘贴账号包的 JSON（某些情况下用户可能自己解出来）
 * @returns {Promise<{player: object, source: string} | null>}
 */
export async function decodePastedText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;

    if (trimmed.startsWith(COMPACT_PREFIX)) {
        const b64 = trimmed.slice(COMPACT_PREFIX.length).replace(/\s+/g, "");
        let compact;
        try {
            compact = parsePreservingInt64(await gunzip(base64ToBytes(b64)));
        } catch (error) {
            throw new Error("这段文本解不开，可能复制时被截断了。请重新复制完整的一段（以 ONPKG1: 开头）。");
        }
        return expandCompact(compact);
    }

    const brace = trimmed.indexOf("{");
    if (brace >= 0) {
        let obj;
        try {
            obj = JSON.parse(trimmed.slice(brace));
        } catch {
            return null;
        }
        const player = extractPlayer(obj);
        if (player) return {player, source: "粘贴的 JSON"};
        if (Array.isArray(obj.m) && Array.isArray(obj.c)) {
            return {...expandCompact(obj), source: "粘贴的紧凑 JSON"};
        }
    }
    return null;
}

/**
 * 在一批候选文件里找出含 `_player` 的那一份。
 *
 * 目录名与文件名都是内容哈希、会随版本变，所以**不能硬编码文件名** ——
 * 一律逐个尝试解密，取解出来带 `_player` 的那个。
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} entries
 * @param {(done:number,total:number,name:string)=>void} [onProgress]
 * @returns {{name: string, player: object, all: Array}|null}
 */
export function findPlayerPackage(entries, onProgress) {
    const candidates = [];
    let done = 0;
    for (const entry of entries) {
        done++;
        if (onProgress) onProgress(done, entries.length, entry.name);
        if (!entry.bytes || entry.bytes.length < HEADER_SIZE + BLOCK_SIZE) continue;
        if (entry.bytes.length > 64 * 1024 * 1024) continue;
        const got = decryptPackage(entry.bytes);
        if (!got) continue;
        candidates.push({name: entry.name, json: got.json});
    }
    const withPlayer = candidates.find(c => extractPlayer(c.json));
    if (!withPlayer) return candidates.length ? {name: null, player: null, all: candidates} : null;
    return {name: withPlayer.name, player: extractPlayer(withPlayer.json), all: candidates};
}

/* ------------------------------------------------------------- 自检向量 */

/** FIPS-197 已知答案（AES = Nb=4 的特例），用来保证移植没错。 */
export function selfTest() {
    const vectors = [
        ["000102030405060708090a0b0c0d0e0f",
         "00112233445566778899aabbccddeeff", "69c4e0d86a7b0430d8cdb78070b4c55a"],
        ["000102030405060708090a0b0c0d0e0f1011121314151617",
         "00112233445566778899aabbccddeeff", "dda97ca4864cdfe06eaf70a0ec0d7191"],
        ["000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
         "00112233445566778899aabbccddeeff", "8ea2b7ca516745bfeafc49904b496089"],
    ];
    const results = [];
    for (const [keyHex, ptHex, ctHex] of vectors) {
        const r = new Rijndael(hexToBytes(keyHex), 128);
        const enc = toHex(r.encryptBlock(hexToBytes(ptHex)));
        const dec = toHex(r.decryptBlock(hexToBytes(ctHex)));
        results.push({encOk: enc === ctHex, decOk: dec === ptHex, enc, dec, want: ctHex});
    }
    // Nb=8 的自洽（加密再解密）
    const r8 = new Rijndael(hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), 256);
    const pt = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
    const ct = new Uint8Array(64);
    for (let i = 0; i < 64; i += 32) ct.set(r8.encryptBlock(pt.subarray(i, i + 32)), i);
    const back = new Uint8Array(64);
    for (let i = 0; i < 64; i += 32) back.set(r8.decryptBlock(ct.subarray(i, i + 32)), i);
    return {
        knownAnswers: results,
        knownAnswersOk: results.every(r => r.encOk && r.decOk),
        nb8RoundTrip: toHex(back) === toHex(pt),
    };
}

export function toHex(bytes) {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

export const PACKAGE_CONSTANTS = {A1: toHex(A1), PACKAGE_KEY: toHex(PACKAGE_KEY), HEADER_SIZE, BLOCK_SIZE};
