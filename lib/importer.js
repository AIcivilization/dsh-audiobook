// lib/importer.js — 导入一本书：取文字 → 分章切段 → 存进书库；也能从书源下载一本再导入

import { rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extractDocument } from './extract.js'
import { buildSegments } from './segment.js'
import { cleanGutenberg, cleanWikisource, downloadBook, SOURCES } from './sources.js'
import { getBook, getProgress, makeId, saveBook, summary, updateBook } from './store.js'

/**
 * @param {string} file 文档路径
 * @param {{ name?: string, title?: string, source?: string, transform?: (doc: object) => object, extra?: object, fingerprint?: string }} [opt]
 *   name：上传时的原文件名；title：自己指定的书名；source：记在书里的来源（默认就是 file）
 *   transform：取出文字后、切段前改一下（比如去掉维基文库的导航）；extra：额外记在书里的字段
 *   fingerprint：算书的编号用的；默认按内容算，从书源下载的按「书源 + 书号」算
 * @returns 书单里的那一行，外加 existed（以前导入过同一本）
 */
export async function importDocument(file, opt = {}) {
  const st = await stat(file).catch(() => null)
  if (!st) throw Object.assign(new Error(`找不到文件：${file}`), { status: 400 })
  if (st.isDirectory()) throw Object.assign(new Error('请给一个文件，不是文件夹'), { status: 400 })
  if (st.size > 300 * 1024 * 1024) throw Object.assign(new Error('文件太大（最多 300 MB）'), { status: 400 })
  let doc = await extractDocument(file, { name: opt.name })
  if (opt.transform) doc = opt.transform(doc)
  const { chapters, segs, chars } = buildSegments(doc.chapters)
  if (!segs.length) throw Object.assign(new Error('文档里没有可以朗读的文字'), { status: 400 })
  const title = (opt.title && String(opt.title).trim().slice(0, 120)) || doc.title
  // 编号按内容算：同一本书换个地方再导入，还是同一本，进度接得上
  const fingerprint = opt.fingerprint || createHash('sha1').update(segs.join('\n')).digest('hex')
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
    ...(opt.extra || {}),
  }
  await saveBook(book, segs)
  return { ...summary(book, await getProgress(id)), existed: Boolean(old) }
}

/**
 * 从书源下载一本书再导入（下载的临时文件导入后就删）
 * @param {string} source 书源（lib/sources.js 的 SOURCES）
 * @param {string} ref 书在书源里的编号（古腾堡书号 / 维基文库页面名）
 */
export async function importFromSource(source, ref, { title, author } = {}) {
  const { file, name } = await downloadBook(source, ref)
  try {
    const book = await importDocument(file, {
      name,
      title,
      source: `${SOURCES[source].label}：${ref}`,
      transform: source.startsWith('wikisource') ? cleanWikisource : cleanGutenberg,
      extra: { from: { source, ref } },
      // 同一本书再下一次（书源更新了、或者清理规则改了）还是同一本，进度接得上
      fingerprint: `${source}:${ref}`,
    })
    // 书源给的作者比文档里的可靠（古腾堡 EPUB 里常常是空的）
    if (author && !book.author) book.author = (await updateBook(book.id, { author })).author
    return book
  } finally {
    await rm(file, { force: true })
  }
}
