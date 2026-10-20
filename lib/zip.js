// lib/zip.js — 读 ZIP 包（EPUB、DOCX 都是 ZIP）：只读中央目录，支持「存储」和「deflate」两种压缩
//
// 不引第三方库：EPUB / DOCX 用不到 ZIP64、加密、分卷这些。

import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50

/**
 * @param {Buffer} buf 整个 ZIP 文件
 * @returns {{ names: string[], has(name): boolean, read(name): Buffer|null, text(name): string|null }}
 */
export function openZip(buf) {
  // 文件尾的目录结束记录：从后往前找（后面可能跟着最长 64 KB 的注释）
  let eocd = -1
  for (let k = buf.length - 22; k >= Math.max(0, buf.length - 22 - 65535); k--) {
    if (buf.readUInt32LE(k) === EOCD) { eocd = k; break }
  }
  if (eocd < 0) throw new Error('不是 ZIP 文件（EPUB / DOCX 都应该是 ZIP）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const local = buf.readUInt32LE(off + 42)
    // 文件名按 UTF-8 读：没打 UTF-8 标记的老包，EPUB / DOCX 里的路径也基本是纯 ASCII
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, local })
    off += 46 + nameLen + extraLen + commentLen
  }

  function read(name) {
    const e = entries.get(name)
    if (!e) return null
    if (buf.readUInt32LE(e.local) !== LOC) throw new Error(`ZIP 里的 ${name} 坏了`)
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28)
    const data = buf.subarray(start, start + e.compSize)
    if (e.method === 0) return Buffer.from(data)
    if (e.method === 8) return inflateRawSync(data)
    throw new Error(`不支持的压缩方式 ${e.method}`)
  }

  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    read,
    text: name => { const b = read(name); return b ? b.toString('utf8').replace(/^﻿/, '') : null },
  }
}
