/**
 * 极简 ZIP 读取器 —— 只做「把压缩包里的文件读出来」这一件事。
 *
 * 为什么不用现成的库：这里只需要支持两种最常见的存储方式
 *   - 0 = 不压缩（STORE）
 *   - 8 = deflate，交给浏览器原生的 DecompressionStream('deflate-raw')
 * 浏览器原生解压，不用额外依赖，也不用把几百 KB 的库塞进静态站点。
 * 不支持加密 ZIP（会明确报错，而不是给出错误的数据）。
 */

function u16(view, off) { return view.getUint16(off, true); }
function u32(view, off) { return view.getUint32(off, true); }

function findEndOfCentralDirectory(view) {
    const max = Math.min(view.byteLength, 65557);
    for (let i = view.byteLength - 22; i >= view.byteLength - max; i--) {
        if (i < 0) break;
        if (u32(view, i) === 0x06054b50) return i;
    }
    return -1;
}

async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读取 ZIP 里的所有条目。
 * @param {Uint8Array} bytes
 * @param {(name:string, size:number)=>void} [onProgress]
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(bytes, onProgress) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(view);
    if (eocd < 0) throw new Error("这不是一个 ZIP 压缩包（找不到目录结尾标记）。");

    const count = u16(view, eocd + 10);
    let pointer = u32(view, eocd + 16);
    const entries = [];

    for (let i = 0; i < count; i++) {
        if (u32(view, pointer) !== 0x02014b50) break;
        const flags = u16(view, pointer + 8);
        const method = u16(view, pointer + 10);
        const compressedSize = u32(view, pointer + 20);
        const nameLength = u16(view, pointer + 28);
        const extraLength = u16(view, pointer + 30);
        const commentLength = u16(view, pointer + 32);
        const localOffset = u32(view, pointer + 42);
        const name = new TextDecoder("utf-8").decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

        if (flags & 0x1) throw new Error("压缩包带有密码保护，无法读取：" + name);
        if (!name.endsWith("/")) {
            // 本地头里的 name/extra 长度可能与中央目录不同，必须以本地头为准
            const localNameLength = u16(view, localOffset + 26);
            const localExtraLength = u16(view, localOffset + 28);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const raw = bytes.subarray(dataStart, dataStart + compressedSize);
            let data;
            if (method === 0) data = raw;
            else if (method === 8) data = await inflateRaw(raw);
            else throw new Error(`压缩包里有不支持的压缩方式（method=${method}）：${name}`);
            entries.push({name, bytes: data});
            if (onProgress) onProgress(name, data.length);
        }
        pointer += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** 判断一段字节是不是 ZIP。 */
export function looksLikeZip(bytes) {
    return bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
        && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
