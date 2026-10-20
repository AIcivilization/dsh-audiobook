// lib/store.js — 书库：书、朗读段、收听进度、全局设置（JSON 文件，原子写入）
//
// books/<id>/book.json      书名、作者、格式、来源、目录（每章从第几段开始）
// books/<id>/text.json      { segs: [...] } 切好的朗读段
// books/<id>/progress.json  { seg, updatedAt } 听到第几段
// settings.json             朗读方式、各方式选的声音、语速、定时

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bookDir, booksDir, dataRoot, ID_RE, settingsPath } from './paths.js'

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

/** 先写临时文件再改名：写到一半断电也不会把书弄坏 */
async function writeJson(path, value, pretty = true) {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value))
  await rename(tmp, path)
}

// 同一个文件的写入排队，免得两个请求同时写把对方覆盖掉
const queues = new Map()
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(key, next.catch(() => {}))
  return next
}

export function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw Object.assign(new Error('书的编号不对'), { status: 400 })
  return id
}

/** 书的编号：书名里的英文字母部分 + 内容的短哈希（同一本书再导入一次得到同一个编号） */
export function makeId(title, fingerprint) {
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const hash = createHash('sha1').update(String(fingerprint)).digest('hex').slice(0, 8)
  return `${slug || 'book'}-${hash}`
}

const bookPath = id => join(bookDir(checkId(id)), 'book.json')
const textPath = id => join(bookDir(checkId(id)), 'text.json')
const progressPath = id => join(bookDir(checkId(id)), 'progress.json')

export const getBook = id => readJson(bookPath(id), null)
export async function getSegs(id) { return (await readJson(textPath(id), { segs: [] })).segs || [] }
export const getProgress = id => readJson(progressPath(id), { seg: 0 })

/** 存一本新书（书 + 朗读段）；同编号的书已存在时覆盖内容，进度保留 */
export async function saveBook(book, segs) {
  checkId(book.id)
  await mkdir(bookDir(book.id), { recursive: true })
  await serial(book.id + ':text', () => writeJson(textPath(book.id), { segs }, false))
  await serial(book.id + ':book', () => writeJson(bookPath(book.id), book))
  return book
}

/** 记下听到第几段（越界的夹到最后一段） */
export function setProgress(id, seg, total) {
  return serial(id + ':progress', async () => {
    const p = await getProgress(id)
    const max = Math.max(0, (total ?? Infinity) - 1)
    p.seg = Math.min(max, Math.max(0, Math.floor(Number(seg) || 0)))
    p.updatedAt = Date.now()
    await writeJson(progressPath(id), p)
    return p
  })
}

/** 改书名 / 作者 */
export function updateBook(id, patch) {
  return serial(id + ':book', async () => {
    const b = await getBook(id)
    if (!b) throw Object.assign(new Error('没有这本书'), { status: 404 })
    if (typeof patch.title === 'string' && patch.title.trim()) b.title = patch.title.trim().slice(0, 120)
    if (typeof patch.author === 'string') b.author = patch.author.trim().slice(0, 80)
    await writeJson(bookPath(id), b)
    return b
  })
}

export async function deleteBook(id) {
  await rm(bookDir(checkId(id)), { recursive: true, force: true })
}

/** 第 seg 段在哪一章 */
export function chapterOf(book, seg) {
  const list = book.chapters || []
  let k = 0
  while (k + 1 < list.length && list[k + 1].seg <= seg) k++
  return k
}

/** 书单里的一行：不带正文，带进度 */
export function summary(b, p) {
  const seg = (p && p.seg) || 0
  const ch = chapterOf(b, seg)
  return {
    id: b.id,
    title: b.title,
    author: b.author || '',
    format: b.format,
    chars: b.chars || 0,
    segCount: b.segCount || 0,
    chapters: (b.chapters || []).length,
    createdAt: b.createdAt,
    seg,
    chapter: ch,
    chapterTitle: ((b.chapters || [])[ch] || {}).title || '',
    percent: b.segCount > 1 ? Math.round((seg / (b.segCount - 1)) * 1000) / 10 : 0,
    listenedAt: (p && p.updatedAt) || 0,
  }
}

/** 书单：最近听过的在前，没听过的按导入时间 */
export async function listBooks() {
  let names = []
  try { names = await readdir(booksDir()) } catch { return [] }
  const out = []
  for (const id of names) {
    if (!ID_RE.test(id)) continue
    const b = await getBook(id)
    if (!b) continue
    out.push(summary(b, await getProgress(id)))
  }
  out.sort((a, b) => (b.listenedAt || 0) - (a.listenedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0))
  return out
}

// ———————————————————— 设置 ————————————————————

export const ENGINES = ['browser', 'edge', 'kokoro']
export const DEFAULT_SETTINGS = { engine: '', voices: { browser: '', edge: 'zh-CN-YunxiNeural', kokoro: 'f01' }, rate: 1, sleep: 0 }

export async function getSettings() {
  const s = await readJson(settingsPath(), {})
  return { ...DEFAULT_SETTINGS, ...s, voices: { ...DEFAULT_SETTINGS.voices, ...(s.voices || {}) } }
}

export function saveSettings(patch) {
  return serial('settings', async () => {
    const s = await getSettings()
    if (ENGINES.includes(patch.engine)) s.engine = patch.engine
    if (patch.voices && typeof patch.voices === 'object') {
      for (const e of ENGINES) if (typeof patch.voices[e] === 'string' && patch.voices[e].length <= 200) s.voices[e] = patch.voices[e]
    }
    const rate = Number(patch.rate)
    if (Number.isFinite(rate) && rate >= 0.5 && rate <= 3) s.rate = Math.round(rate * 100) / 100
    const sleep = Number(patch.sleep)
    if (Number.isInteger(sleep) && sleep >= -1 && sleep <= 240) s.sleep = sleep
    await mkdir(dataRoot(), { recursive: true })
    await writeJson(settingsPath(), s)
    return s
  })
}
