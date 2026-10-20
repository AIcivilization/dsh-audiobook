// lib/importer.js — 导入一本书：取文字 → 分章切段 → 存进书库

import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extractDocument } from './extract.js'
import { buildSegments } from './segment.js'
import { getBook, getProgress, makeId, saveBook, summary } from './store.js'

/**
 * @param {string} file 文档路径
 * @param {{ name?: string, title?: string, source?: string }} [opt]
 *   name：上传时的原文件名；title：自己指定的书名；source：记在书里的来源（默认就是 file）
 * @returns 书单里的那一行，外加 existed（以前导入过同一本）
 */
export async function importDocument(file, opt = {}) {
  const st = await stat(file).catch(() => null)
  if (!st) throw Object.assign(new Error(`找不到文件：${file}`), { status: 400 })
  if (st.isDirectory()) throw Object.assign(new Error('请给一个文件，不是文件夹'), { status: 400 })
  if (st.size > 300 * 1024 * 1024) throw Object.assign(new Error('文件太大（最多 300 MB）'), { status: 400 })
  const doc = await extractDocument(file, { name: opt.name })
  const { chapters, segs, chars } = buildSegments(doc.chapters)
  if (!segs.length) throw Object.assign(new Error('文档里没有可以朗读的文字'), { status: 400 })
  const title = (opt.title && String(opt.title).trim().slice(0, 120)) || doc.title
  // 编号按内容算：同一本书换个地方再导入，还是同一本，进度接得上
  const fingerprint = createHash('sha1').update(segs.join('\n')).digest('hex')
  const id = makeId(title, fingerprint)
  const old = await getBook(id)
  const book = {
    id,
    version: 1,
    title,
    author: doc.author,
    format: doc.format,
    source: opt.source || file,
    chars,
    segCount: segs.length,
    chapters,
    createdAt: (old && old.createdAt) || Date.now(),
  }
  await saveBook(book, segs)
  return { ...summary(book, await getProgress(id)), existed: Boolean(old) }
}
