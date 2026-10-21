// lib/notes.js — 读书心得、和 AI 的讨论、读后感
//
// books/<id>/notes.json  { notes: [...], reviews: [...] }
//   note:   { id, title, titleBy: auto|ai|user, seg, chapter, quote, text（原话）, polished?（AI 整理后的，原话保留）,
//             source: voice|typed|ai, createdAt, updatedAt }
//   标题：记下时先按原话顺手起一个（auto），有模型就在后台换成 AI 起的简短标题（ai）；用户改过的（user）不再动
//   review: { id, text, createdAt }  读后感（AI 按你的心得写的）
// books/<id>/chat.json   { messages: [{ role: user|ai, text, seg, at }] }  「问 AI」的讨论记录（最多留 60 条）
// 只存文字：录音识别完就删。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bookDir } from './paths.js'
import { chapterOf, checkId, getBook, getSegs, listBooks } from './store.js'

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}
async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1))
  await rename(tmp, path)
}
const queues = new Map()
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(key, next.catch(() => {}))
  return next
}

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }) }

const notesPath = id => join(bookDir(checkId(id)), 'notes.json')
const chatPath = id => join(bookDir(checkId(id)), 'chat.json')

export async function getNotes(id) {
  const j = await readJson(notesPath(id), {})
  // 早先记的心得没有标题：读的时候先顺手补一个，等 AI 起好再存
  const notes = (j.notes || []).map(n => (n.title ? n : { ...n, title: quickTitle(n.polished || n.text), titleBy: 'auto' }))
  return { notes, reviews: j.reviews || [] }
}

function mutate(id, fn) {
  return serial(id + ':notes', async () => {
    const j = await getNotes(id)
    const out = await fn(j)
    await writeJson(notesPath(id), j)
    return out
  })
}

/** 口头语：开头的这些不进标题 */
const FILLERS = /^(?:嗯+|呃+|啊+|那个|这个|就是说?|然后|我觉得|我感觉|我想|其实|所以说?|反正)[，,、\s]*/

/** 不用模型、马上能有的标题：去掉开头的口头语，取第一句，最多 14 个字 */
export function quickTitle(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim()
  for (let k = 0; k < 4; k++) t = t.replace(FILLERS, '')
  t = (t.split(/[。！？!?；;\n]/)[0] || t).split(/[，,：:]/).find(x => x.trim().length >= 4) || t
  t = t.trim().replace(/[。，、,.!！?？~～…]+$/, '')
  return t.length > 14 ? t.slice(0, 13) + '…' : t || '一条心得'
}

const TITLE = `给读书心得起标题：4 到 12 个字，简单明确，说出这条心得的核心意思（谁、什么、怎么看），用用户自己的视角。
不要书名号，不要「关于」「心得」「感想」这类空词，不要标点结尾。`

/** 让模型给一批心得起标题（一次请求）；拿不到的返回空字符串 */
async function aiTitles(llm, book, list) {
  if (!llm || !list.length) return list.map(() => '')
  const out = String(await llm.complete({
    system: `${TITLE}\n用户会给几条心得，按顺序编号。只输出 JSON：{"titles":["标题1","标题2",…]}，条数和顺序与心得一致。`,
    user: `书：《${book.title}》\n${list.map((n, k) => `${k + 1}. [${n.chapter}] ${n.polished || n.text}`).join('\n').slice(0, 12000)}`,
    maxTokens: 800,
  }))
  let titles = []
  try { titles = JSON.parse((/\{[\s\S]*\}/.exec(out) || ['{}'])[0]).titles || [] } catch { titles = [] }
  return list.map((_, k) => String(titles[k] || '').replace(/^[《「“"]+|[》」”"。，.]+$/g, '').trim().slice(0, 20))
}

/**
 * 把还是「顺手起的」标题换成 AI 起的（后台调用，失败就留着顺手起的）
 * @param {string[]} [only] 只处理这几条
 * @returns 更新后的心得列表
 */
export async function titleNotes(llm, id, only) {
  if (!llm) return (await getNotes(id)).notes
  const book = await getBook(id)
  const { notes } = await getNotes(id)
  const todo = notes.filter(n => n.titleBy !== 'ai' && n.titleBy !== 'user' && (!only || only.includes(n.id))).slice(0, 30)
  if (!todo.length) return notes
  const titles = await aiTitles(llm, book, todo)
  return mutate(id, (j) => {
    todo.forEach((t, k) => {
      const n = j.notes.find(x => x.id === t.id)
      // 起标题这几秒里用户可能自己改了标题或内容：那就不覆盖
      if (n && titles[k] && n.titleBy !== 'user' && n.text === t.text) { n.title = titles[k]; n.titleBy = 'ai' }
    })
    return j.notes
  })
}

/** 一段原文的摘句（心得挂在哪儿） */
const quoteOf = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > 120 ? t.slice(0, 118) + '…' : t }

/** 记一条心得，挂在第 seg 段 */
export async function addNote(id, { seg, text, source = 'typed', title }) {
  const t = String(text || '').trim().slice(0, 5000)
  if (!t) throw bad('心得是空的')
  const book = await getBook(id)
  if (!book) throw bad('没有这本书', 404)
  const segs = await getSegs(id)
  const s = Math.min(Math.max(0, Math.floor(Number(seg) || 0)), Math.max(0, segs.length - 1))
  const userTitle = String(title || '').trim().slice(0, 30)
  const note = {
    id: randomUUID().slice(0, 12),
    title: userTitle || quickTitle(t),
    titleBy: userTitle ? 'user' : 'auto',
    seg: s,
    chapter: (book.chapters[chapterOf(book, s)] || {}).title || '',
    quote: quoteOf(segs[s]),
    text: t,
    source: ['voice', 'typed', 'ai'].includes(source) ? source : 'typed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await mutate(id, (j) => { j.notes.push(note) })
  return note
}

/**
 * 改心得：text 改原话（改了原话，整理版作废，没被用户改过的标题重新起）；polished 改整理版（空字符串表示删掉整理版）；
 * title 改标题（空字符串表示交回给 AI 重新起）
 */
export function editNote(id, noteId, patch) {
  return mutate(id, (j) => {
    const n = j.notes.find(x => x.id === noteId)
    if (!n) throw bad('没有这条心得', 404)
    if (typeof patch.title === 'string') {
      const t = patch.title.trim().slice(0, 30)
      if (t) { n.title = t; n.titleBy = 'user' } else { n.title = quickTitle(n.polished || n.text); n.titleBy = 'auto' }
    }
    if (typeof patch.text === 'string') {
      const t = patch.text.trim().slice(0, 5000)
      if (!t) throw bad('心得不能是空的')
      if (t !== n.text) {
        n.text = t
        delete n.polished
        if (n.titleBy !== 'user') { n.title = quickTitle(t); n.titleBy = 'auto' }
      }
    }
    if (typeof patch.polished === 'string') {
      const p = patch.polished.trim().slice(0, 5000)
      if (p) n.polished = p
      else delete n.polished
    }
    n.updatedAt = Date.now()
    return n
  })
}

export function deleteNote(id, noteId) {
  return mutate(id, (j) => {
    const k = j.notes.findIndex(x => x.id === noteId)
    if (k < 0) throw bad('没有这条心得', 404)
    j.notes.splice(k, 1)
  })
}

const POLISH = `你帮用户整理口述的读书心得。用户是用语音说的，可能有口头语（嗯、那个、就是说）、重复、语序乱、识别错的同音字。
只做这些：去掉口头语和重复、理顺语序、改正明显的同音错字、加上合适的标点。
不要改变用户的观点和意思，不要增加用户没说的内容，不要评价，不要加标题。保持第一人称。只输出整理后的文字。`

/** AI 整理一条心得（原话保留，整理版另存） */
export async function polishNote(llm, id, noteId) {
  if (!llm) throw bad('没有可用的模型：请在 DSH 里选一个默认模型')
  const { notes } = await getNotes(id)
  const n = notes.find(x => x.id === noteId)
  if (!n) throw bad('没有这条心得', 404)
  const book = await getBook(id)
  const out = String(await llm.complete({
    system: POLISH,
    user: `书：《${book.title}》${n.chapter ? `，${n.chapter}` : ''}\n当时正在听的原文：${n.quote}\n\n用户的原话：\n${n.text}`,
    maxTokens: 2000,
  })).trim()
  if (!out) throw new Error('模型没有返回内容')
  return editNote(id, noteId, { polished: out })
}

const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const clock = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/** 一本书的心得 → Markdown（按章节排，带摘句和位置） */
export function notesMarkdown(book, { notes, reviews }) {
  const lines = [`# 《${book.title}》读书心得`, '']
  const meta = [book.author, notes.length ? `${notes.length} 条心得` : '', notes.length ? `${day(Math.min(...notes.map(n => n.createdAt)))} 至 ${day(Math.max(...notes.map(n => n.createdAt)))}` : ''].filter(Boolean)
  if (meta.length) lines.push(meta.join(' · '), '')
  for (const r of reviews) lines.push(`## 读后感（${day(r.createdAt)}）`, '', r.text, '')
  let chapter = null
  for (const n of [...notes].sort((a, b) => a.seg - b.seg || a.createdAt - b.createdAt)) {
    if (n.chapter !== chapter) { chapter = n.chapter; lines.push(`## ${chapter || '（未分章）'}`, '') }
    lines.push(`### ${n.title || quickTitle(n.polished || n.text)}`, '')
    lines.push(`<sub>${day(n.createdAt)} ${clock(n.createdAt)}${n.source === 'voice' ? ' · 语音' : n.source === 'ai' ? ' · 和 AI 的讨论' : ''}</sub>`, '')
    lines.push(n.polished || n.text, '')
    if (n.polished) lines.push(`<details><summary>原话</summary>\n\n${n.text}\n\n</details>`, '')
    lines.push(`> 原文：${n.quote}`, '')
  }
  if (!notes.length && !reviews.length) lines.push('（还没有心得）', '')
  return lines.join('\n')
}

/** 所有书的心得（跨书看、跨书搜）；since：只要这个时间之后的 */
export async function allNotes({ since = 0, query = '' } = {}) {
  const q = String(query || '').trim()
  const out = []
  for (const b of await listBooks()) {
    const { notes } = await getNotes(b.id)
    for (const n of notes) {
      if (n.createdAt < since) continue
      if (q && !`${n.title || ''}\n${n.text}\n${n.polished || ''}\n${n.quote}`.includes(q)) continue
      out.push({ ...n, bookId: b.id, bookTitle: b.title, author: b.author })
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

// ———————————————————— 问 AI ————————————————————

export async function getChat(id) { return (await readJson(chatPath(id), {})).messages || [] }
export const clearChat = id => serial(id + ':chat', () => writeJson(chatPath(id), { messages: [] }))
const pushChat = (id, msgs) => serial(id + ':chat', async () => {
  const messages = (await getChat(id)).concat(msgs).slice(-60)
  await writeJson(chatPath(id), { messages })
  return messages
})

/**
 * 给 AI 看的原文：本章开头到正在听的这一段（太长就只留后面），再带一点上一章的结尾。
 * 不给后面的内容：防剧透。
 */
export function contextText(book, segs, seg, limit = 9000) {
  const chs = book.chapters || []
  const k = chapterOf(book, seg)
  const from = chs[k] ? chs[k].seg : 0
  let body = segs.slice(from, seg + 1).join('')
  if (body.length > limit) body = '……' + body.slice(-limit)
  let prev = ''
  if (k > 0 && body.length < limit) {
    const p = segs.slice(chs[k - 1].seg, from).join('')
    const room = Math.min(2000, limit - body.length)
    if (room > 200) prev = (p.length > room ? '……' + p.slice(-room) : p)
  }
  return { chapter: chs[k] ? chs[k].title : '', prevChapter: k > 0 ? chs[k - 1].title : '', prev, body: body.replace(/^\n+/, '') }
}

function askSystem(spoilers) {
  return `你是用户的读书伙伴，正陪用户听一本书。用户会问刚听到的内容、人物、情节、词语典故，或者和你讨论感想。
回答要求：
- 用口语化的中文，简洁，像朋友聊天；用户可能是在听，回答会被读出来，少用列表和符号，一般不超过 300 字
- 优先依据给你的原文回答；原文里没有的，可以用你知道的背景知识，但要说明
${spoilers
    ? '- 用户允许剧透：可以讲后面的情节'
    : '- 不要剧透：给你的原文只到用户正在听的位置。即使你知道这本书后面的情节或结局，也不要透露；用户问到后面会怎样，就说「还没读到，先不剧透」，可以聊猜测'}`
}

/**
 * 问 AI（围绕正在听的位置；mode=notes 时围绕用户这本书的心得聊）
 * @returns {Promise<{ answer: string, messages: object[] }>}
 */
export async function ask(llm, id, { seg, question, spoilers = false, mode = 'book' }) {
  if (!llm) throw bad('没有可用的模型：请在 DSH 里选一个默认模型')
  const q = String(question || '').trim().slice(0, 2000)
  if (!q) throw bad('问题是空的')
  const book = await getBook(id)
  if (!book) throw bad('没有这本书', 404)
  const segs = await getSegs(id)
  const s = Math.min(Math.max(0, Math.floor(Number(seg) || 0)), segs.length - 1)
  const ctx = contextText(book, segs, s)
  const history = (await getChat(id)).slice(-12)
  let material = `书：《${book.title}》${book.author ? `，${book.author}` : ''}\n用户正在听：${ctx.chapter}（全书第 ${s + 1}/${segs.length} 段）\n`
  if (ctx.prev) material += `\n【上一章「${ctx.prevChapter}」的结尾】\n${ctx.prev}\n`
  material += `\n【本章到用户正在听的位置为止】\n${ctx.body}\n`
  if (mode === 'notes') {
    const { notes } = await getNotes(id)
    material += `\n【用户这本书的读书心得（按位置排）】\n${notes.sort((a, b) => a.seg - b.seg).map(n => `- ${day(n.createdAt)} [${n.chapter}] 「${n.title || ''}」摘句「${n.quote}」：${n.polished || n.text}`).join('\n').slice(0, 8000) || '（还没有）'}\n`
  }
  const talk = history.length ? `\n【之前的讨论】\n${history.map(m => `${m.role === 'user' ? '用户' : '你'}：${m.text}`).join('\n')}\n` : ''
  const answer = String(await llm.complete({
    system: askSystem(spoilers) + (mode === 'notes' ? '\n- 这次围绕用户自己的读书心得聊：可以回应、追问、对比前后想法的变化，帮用户想得更深，不要只是夸' : ''),
    user: `${material}${talk}\n用户：${q}`,
    maxTokens: 1500,
  })).trim()
  if (!answer) throw new Error('模型没有返回内容')
  const messages = await pushChat(id, [{ role: 'user', text: q, seg: s, at: Date.now() }, { role: 'ai', text: answer, seg: s, at: Date.now() }])
  return { answer, messages }
}

// ———————————————————— 读后感、跨书回顾 ————————————————————

/** AI 按用户的心得写读后感：观点都来自用户，AI 只组织成文 */
export async function writeReview(llm, id) {
  if (!llm) throw bad('没有可用的模型：请在 DSH 里选一个默认模型')
  const book = await getBook(id)
  if (!book) throw bad('没有这本书', 404)
  const { notes } = await getNotes(id)
  if (!notes.length) throw bad('这本书还没有心得：先记几条，再来写读后感')
  const text = String(await llm.complete({
    system: `根据用户的读书心得，替用户写一篇读后感。
- 观点、感受全部来自用户的心得，不要编造用户没表达过的看法，也不要编造用户的经历和动作（比如「我几次合上书」）；可以补充必要的情节背景，让文章读得通
- 第一人称，自然朴实，800 字左右；可以引用心得里摘的原文
- 只输出读后感正文，第一行是标题`,
    user: `书：《${book.title}》${book.author ? `，${book.author}` : ''}\n\n用户的心得（按阅读顺序）：\n${notes.sort((a, b) => a.seg - b.seg).map(n => `- [${n.chapter}] 摘句「${n.quote}」：${n.polished || n.text}`).join('\n').slice(0, 12000)}`,
    maxTokens: 3000,
  })).trim()
  if (!text) throw new Error('模型没有返回内容')
  const review = { id: randomUUID().slice(0, 12), text, createdAt: Date.now() }
  await mutate(id, (j) => { j.reviews.unshift(review) })
  return review
}

export function deleteReview(id, reviewId) {
  return mutate(id, (j) => { j.reviews = j.reviews.filter(r => r.id !== reviewId) })
}

/** 跨书回顾：最近一段时间各本书的心得，AI 帮你回顾 */
export async function reflect(llm, { days = 30 } = {}) {
  if (!llm) throw bad('没有可用的模型：请在 DSH 里选一个默认模型')
  const since = days > 0 ? Date.now() - days * 86400e3 : 0
  const notes = await allNotes({ since })
  if (!notes.length) throw bad(days > 0 ? `最近 ${days} 天没有心得` : '还没有任何心得')
  const byBook = new Map()
  for (const n of notes.slice().reverse()) {
    if (!byBook.has(n.bookTitle)) byBook.set(n.bookTitle, [])
    byBook.get(n.bookTitle).push(n)
  }
  const text = String(await llm.complete({
    system: `你帮用户回顾一段时间的读书心得。用口语化的中文，600 字以内：
- 这段时间读了什么、最打动用户的是什么（引用用户自己的话）
- 不同书之间用户的想法有没有呼应或变化
- 最后提一两个值得继续想的问题
只依据用户的心得，不要编造。`,
    user: [...byBook].map(([t, ns]) => `《${t}》\n${ns.map(n => `- ${new Date(n.createdAt).toLocaleDateString('zh-CN')} [${n.chapter}]：${n.polished || n.text}`).join('\n')}`).join('\n\n').slice(0, 15000),
    maxTokens: 2000,
  })).trim()
  return { text, books: byBook.size, notes: notes.length }
}
