// lib/zipwrite.js — 写 ZIP（不压缩：MP3 本来就压不动），每章一个 MP3 时打成一个包下载
//
// 一个文件一个文件地流式写，不把整个包读进内存；CRC32 先读一遍文件算出来。超过 4 GB 的包不支持（ZIP64）。

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { once } from 'node:events'

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(buf, crc = 0) {
  let c = ~crc >>> 0
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

async function fileCrc(file) {
  let c = 0
  for await (const chunk of createReadStream(file)) c = crc32(chunk, c)
  return c
}

/** DOS 时间（ZIP 里的修改时间） */
function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * @param {string} out 输出的 ZIP 路径
 * @param {{ name: string, file: string }[]} entries 包里的文件名（可以有中文）和磁盘上的文件
 */
export async function writeZip(out, entries) {
  const ws = createWriteStream(out)
  const write = async (buf) => { if (!ws.write(buf)) await once(ws, 'drain') }
  const central = []
  let offset = 0
  const { time, date } = dosTime()
  for (const e of entries) {
    const size = (await stat(e.file)).size
    if (offset + size > 0xffffffff) throw new Error('打包后超过 4 GB，请改成一个文件或者分几次导出')
    const crc = await fileCrc(e.file)
    const name = Buffer.from(e.name, 'utf8')
    // 文件名是 UTF-8（标志位 11），再附一份 Info-ZIP 的 Unicode 路径扩展字段，老一些的解压工具也认中文名
    const up = Buffer.alloc(9 + name.length)
    up.writeUInt16LE(0x7075, 0); up.writeUInt16LE(5 + name.length, 2); up.writeUInt8(1, 4); up.writeUInt32LE(crc32(name), 5); name.copy(up, 9)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(0, 8)
    loc.writeUInt16LE(time, 10); loc.writeUInt16LE(date, 12)
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(size, 18); loc.writeUInt32LE(size, 22)
    loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(up.length, 28)
    await write(loc)
    await write(name)
    await write(up)
    for await (const chunk of createReadStream(e.file)) await write(chunk)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(size, 20); cen.writeUInt32LE(size, 24)
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(up.length, 30); cen.writeUInt32LE(offset, 42)
    central.push(cen, name, up)
    offset += 30 + name.length + up.length + size
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16)
  await write(cenBuf)
  await write(end)
  ws.end()
  await once(ws, 'close')
}
