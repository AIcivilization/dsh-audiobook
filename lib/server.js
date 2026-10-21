// lib/server.js — 朗读面板用的 HTTP 接口；DSH 插件（挂在 dsh 的 webServer 上）和独立运行（dsh-audiobook serve）共用
//
//   GET  <prefix>/panel  /panel.js  /panel.css       面板
//   GET  <prefix>/status                             Edge 组件、本地模型、ffmpeg 是否就绪，模型下载进度
//   GET  <prefix>/books                              书单（带进度）
//   GET  <prefix>/book?id=                           一本书：目录、全部朗读段、进度
//   GET  <prefix>/voices                             服务器上能用的声音（Edge、本地 Kokoro）
//   GET  <prefix>/settings · POST /settings {...}    朗读方式、声音、语速、定时（全局）
//   GET  <prefix>/audio?id=&seg=&engine=&voice=      一段的音频（没合成就当场合成；支持 Range）
//   POST <prefix>/speak    {id, seg, engine, voice, ahead?}  合成这一段（等它好），再在后台预取后面 ahead 段
//   GET  <prefix>/progress?id= · POST /progress {id, seg}   听到第几段（AI 工具也会改它）
//   POST <prefix>/import   {path, title?}            导入本机的文档
//   POST <prefix>/upload?name=&title=                上传文档（请求体就是文件）
//   POST <prefix>/rename   {id, title?, author?}     改书名 / 作者
//   POST <prefix>/delete   {id}                      删书（连同声音缓存）
//   GET  <prefix>/search?q=                          搜书（书名、作者、角色名、情节；有模型时先让模型猜书名）
//   GET  <prefix>/websearch?q=                       常规网页搜索（用 DSH 配好的网页搜索；结果是链接，在浏览器里打开）
//   POST <prefix>/download {source, ref, title?, author?, catalog?}   从书源 / 自己的 OPDS 书库下载一本，直接进书架
//   POST <prefix>/edge/install · /kokoro/install     重装 Edge 语音组件 / 下载本地中文模型
//   POST <prefix>/asr                               语音输入：请求体是 16 kHz 单声道 WAV，回 {text}；POST /asr/install 下载识别模型
//   GET  <prefix>/notes?id= · /notes/all?days=&q= · /notes/export?id=   一本书的心得 / 所有书的心得 / 导出 Markdown
//   POST <prefix>/note {id, seg, text, source} · /note/edit · /note/delete · /note/polish    记、改、删、AI 整理心得
//   GET  <prefix>/targets · POST /notes/send {id, target}               能导入到哪些知识库 / 导入
//   GET  <prefix>/chat?id= · POST /ask {id, seg, question, spoilers, mode} · /chat/clear   问 AI
//   POST <prefix>/say {text, engine, voice}         把一段文字（AI 的回答）合成成声音
//   POST <prefix>/review {id} · /review/delete · /reflect {days}        读后感 / 跨书回顾
//   GET  <prefix>/update[?force=1] · POST /update · POST /uninstall   插件自己的版本、更新、卸载（只在 DSH 里）
//
// 会改东西的请求都要带 x-audiobook 头：别的网站发跨站请求带不了自定义头（要预检），挡住 CSRF。

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DOC_EXT } from './extract.js'
import { EDGE_VOICES, edgeStatus, installEdge } from './edge.js'
import { asrDownload, ensureAsrModels, findAsrModels } from './asr.js'
import { findBooks } from './finder.js'
import { importDocument, importFromSource } from './importer.js'
import { download, ensureKokoro, KOKORO_VOICES, kokoroDir } from './kokoro.js'
import { findFfmpeg, uploadsDir } from './paths.js'
import { addNote, allNotes, ask, clearChat, deleteNote, deleteReview, editNote, getChat, getNotes, notesMarkdown, polishNote, reflect, writeReview } from './notes.js'
import { SOURCES } from './sources.js'
import { detectTargets, sendTo } from './targets.js'
import { SERVER_ENGINES } from './speech.js'
import { checkId, deleteBook, getBook, getProgress, getSegs, getSettings, listBooks, saveSettings, setProgress, updateBook } from './store.js'

const STATIC = {
  '/panel': ['web/panel.html', 'text/html; charset=utf-8'],
  '/panel.css': ['web/panel.css', 'text/css; charset=utf-8'],
  '/panel.js': ['web/panel.js', 'text/javascript; charset=utf-8'],
  '/player.js': ['web/player.js', 'text/javascript; charset=utf-8'],
  '/recorder.js': ['web/recorder.js', 'text/javascript; charset=utf-8'],
  '/talk.js': ['web/talk.js', 'text/javascript; charset=utf-8'],
}

const MAX_UPLOAD = 300 * 1024 * 1024

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); resolve({}) } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function safePost(req) {
  if (req.method !== 'POST' || !req.headers['x-audiobook']) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function serveAudio(req, res, file) {
  let st
  try { st = await stat(file) } catch { return send(res, 404, { error: '这段声音还没有合成' }) }
  const size = st.size
  const type = file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
  const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400' }
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...head, 'content-length': size })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(file).pipe(res)
  }
  let start = m[1] ? Number(m[1]) : size - Number(m[2])
  let end = m[1] && m[2] ? Number(m[2]) : size - 1
  start = Math.max(0, start); end = Math.min(size - 1, end)
  if (start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` })
    return res.end()
  }
  res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

const audioUrl = (id, seg, engine, voice) => `audio?id=${encodeURIComponent(id)}&seg=${seg}&engine=${engine}&voice=${encodeURIComponent(voice)}`

/**
 * @param {object} o
 * @param {string} o.prefix 例如 /api-dsh-audiobook
 * @param {string} o.pkgRoot 包根目录（找 web/）
 * @param {ReturnType<import('./speech.js').createSpeech>} o.speech
 * @param {() => object} [o.status] 额外的状态字段（插件版本……）
 * @param {() => object} [o.options] { ffmpeg? }
 * @param {object} [o.manage] 版本、更新、卸载（plugin/manage.js；独立运行时没有）
 * @param {() => object|null} [o.llm] DSH 的模型（搜书时猜书名用；没有就只按原话搜）
 * @param {{ transcribe(file: string): Promise<string> }} [o.asr] 语音识别（lib/asr.js 的 createAsr）
 * @param {() => any} [o.tools] DSH 的工具注册表（找能导入心得的知识库插件用）
 * @param {() => object|null} [o.plugins] 当前 profile 装了哪些插件（lib/targets.js 的 profilePlugins）
 * @param {(q: string) => Promise<{title: string, url: string, snippet?: string}[]>} [o.webSearch] DSH 的网页搜索（没有时面板只给「去别处搜」的链接）
 */
export function createHandler(o) {
  const opts = () => (o.options && o.options()) || {}
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://x')
    const path = url.pathname.slice(o.prefix.length) || '/'
    const q = url.searchParams
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (STATIC[path]) {
          const [rel, type] = STATIC[path]
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
          return res.end(await readFile(join(o.pkgRoot, rel)))
        }
        if (path === '/status') {
          const d = download.state
          return send(res, 200, {
            ffmpeg: Boolean(findFfmpeg(opts().ffmpeg)),
            edge: await edgeStatus(),
            kokoro: { ready: Boolean(kokoroDir()), download: d ? { running: d.running, got: d.got, total: d.total, error: d.error } : null },
            asr: { ready: Boolean(await findAsrModels()), download: asrDownload.state ? { running: asrDownload.state.running, got: asrDownload.state.got, total: asrDownload.state.total, error: asrDownload.state.error } : null },
            llm: Boolean(o.llm && o.llm()),
            ...(o.status ? await o.status() : {}),
          })
        }
        if (path === '/books') return send(res, 200, { books: await listBooks() })
        if (path === '/book') {
          const id = checkId(q.get('id'))
          const book = await getBook(id)
          if (!book) return send(res, 404, { error: '没有这本书' })
          return send(res, 200, { book, segs: await getSegs(id), progress: await getProgress(id) })
        }
        if (path === '/voices') {
          return send(res, 200, {
            edge: { ...(await edgeStatus()), voices: EDGE_VOICES },
            kokoro: { ready: Boolean(kokoroDir()), voices: KOKORO_VOICES.map(({ id, label }) => ({ id, label })) },
          })
        }
        if (path === '/search') {
          const { customSources } = await getSettings()
          return send(res, 200, await findBooks(q.get('q') || '', { llm: o.llm ? o.llm() : null, catalogs: customSources }))
        }
        if (path === '/websearch') {
          const query = String(q.get('q') || '').trim().slice(0, 200)
          if (!query) return send(res, 400, { error: '请输入要搜的内容' })
          if (!o.webSearch) return send(res, 200, { available: false, results: [] })
          try { return send(res, 200, { available: true, results: await o.webSearch(query) }) } catch (e) {
            return send(res, 200, { available: false, results: [], error: e.message })
          }
        }
        if (path === '/progress') return send(res, 200, await getProgress(checkId(q.get('id'))))
        if (path === '/notes') return send(res, 200, await getNotes(checkId(q.get('id'))))
        if (path === '/notes/all') {
          const days = Number(q.get('days')) || 0
          return send(res, 200, { notes: await allNotes({ since: days > 0 ? Date.now() - days * 86400e3 : 0, query: q.get('q') || '' }) })
        }
        if (path === '/notes/export') {
          const id = checkId(q.get('id'))
          const book = await getBook(id)
          if (!book) return send(res, 404, { error: '没有这本书' })
          const name = `《${book.title}》读书心得.md`.replace(/[\\/:*?"<>|]/g, '_')
          res.writeHead(200, {
            'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store',
            'content-disposition': `attachment; filename="notes.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
          })
          return res.end(notesMarkdown(book, await getNotes(id)))
        }
        if (path === '/targets') return send(res, 200, { targets: detectTargets({ tools: o.tools ? o.tools() : null, plugins: o.plugins ? o.plugins() : null }) })
        if (path === '/chat') return send(res, 200, { messages: await getChat(checkId(q.get('id'))) })
        if (path === '/settings') return send(res, 200, await getSettings())
        if (path === '/audio') {
          const id = checkId(q.get('id'))
          const file = await o.speech.get(id, Number(q.get('seg')), q.get('engine'), q.get('voice') || '')
          return serveAudio(req, res, file)
        }
        if (path === '/update') {
          if (!o.manage) return send(res, 200, { managed: false })
          return send(res, 200, { managed: true, ...(await o.manage.info(q.get('force') === '1')) })
        }
        return send(res, 404, { error: 'not found' })
      }

      if (!safePost(req)) return send(res, 403, { error: '只接受本页面发出的请求' })

      if (path === '/upload') {
        const name = String(q.get('name') || 'book.txt').replace(/[\\/]/g, '_').slice(0, 200)
        const ext = extname(name).toLowerCase()
        if (!DOC_EXT.includes(ext)) return send(res, 400, { error: '不支持这种文件。支持：TXT、EPUB、PDF、DOCX、Markdown、HTML、RTF' })
        if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return send(res, 413, { error: '文件太大（最多 300 MB）' })
        await mkdir(uploadsDir(), { recursive: true })
        const tmp = join(uploadsDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
        let book
        try {
          await pipeline(req, createWriteStream(tmp))
          book = await importDocument(tmp, { name, title: q.get('title') || '', source: name })
        } finally {
          await rm(tmp, { force: true })
        }
        return send(res, 200, { ok: true, book })
      }

      if (path === '/asr') {
        if (!o.asr) return send(res, 400, { error: '这里不能语音输入' })
        if (Number(req.headers['content-length'] || 0) > 12 * 1024 * 1024) return send(res, 413, { error: '说得太长了（最多约 3 分钟）' })
        await mkdir(uploadsDir(), { recursive: true })
        const tmp = join(uploadsDir(), `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
        try {
          await pipeline(req, createWriteStream(tmp))
          return send(res, 200, { ok: true, text: await o.asr.transcribe(tmp) })
        } catch (e) {
          if (e.code === 'NO_MODEL') return send(res, 409, { error: e.message, code: 'NO_MODEL' })
          throw e
        } finally {
          // 只要文字：录音识别完就删
          await rm(tmp, { force: true })
        }
      }

      const body = await readJson(req)
      if (path === '/import') {
        if (typeof body.path !== 'string' || !body.path.trim()) return send(res, 400, { error: '请填文档的完整路径' })
        const book = await importDocument(body.path.trim(), { title: typeof body.title === 'string' ? body.title : '' })
        return send(res, 200, { ok: true, book })
      }
      if (path === '/download') {
        let catalog
        if (body.source === 'opds') {
          catalog = (await getSettings()).customSources.find(c => c.id === body.catalog && c.kind === 'opds')
          if (!catalog) return send(res, 400, { error: '没有这个 OPDS 书库（可能已经删了）' })
        } else if (!SOURCES[body.source]) return send(res, 400, { error: '不认识的书源' })
        const book = await importFromSource(body.source, String(body.ref || ''), {
          title: typeof body.title === 'string' ? body.title : '',
          author: typeof body.author === 'string' ? body.author : '',
          catalog,
        })
        return send(res, 200, { ok: true, book })
      }
      if (path === '/speak') {
        const id = checkId(body.id)
        const seg = Number(body.seg)
        const engine = String(body.engine || '')
        const voice = String(body.voice || '')
        if (!SERVER_ENGINES.includes(engine)) return send(res, 400, { error: '不认识的朗读方式' })
        // 先把这一段排进队（插队），再排后面几段的预取，最后等这一段好
        const ahead = Math.min(6, Math.max(0, Number.parseInt(body.ahead, 10) || 0))
        const total = (await getBook(id) || {}).segCount || 0
        const ready = o.speech.get(id, seg, engine, voice)
        ready.catch(() => {})
        const next = Array.from({ length: ahead }, (_, k) => seg + 1 + k).filter(s => s < total)
        if (next.length) o.speech.prefetch(id, next, engine, voice)
        await ready
        return send(res, 200, { ok: true, url: audioUrl(id, seg, engine, voice) })
      }
      if (path === '/progress') {
        const id = checkId(body.id)
        const book = await getBook(id)
        if (!book) return send(res, 404, { error: '没有这本书' })
        return send(res, 200, { ok: true, ...(await setProgress(id, body.seg, book.segCount)) })
      }
      if (path === '/settings') return send(res, 200, { ok: true, settings: await saveSettings(body) })
      if (path === '/rename') return send(res, 200, { ok: true, book: await updateBook(checkId(body.id), body) })
      if (path === '/delete') {
        const id = checkId(body.id)
        await o.speech.forget(id)
        await deleteBook(id)
        return send(res, 200, { ok: true })
      }
      const model = () => (o.llm ? o.llm() : null)
      if (path === '/asr/install') { ensureAsrModels().catch(() => {}); return send(res, 200, { ok: true }) }
      if (path === '/note') return send(res, 200, { ok: true, note: await addNote(checkId(body.id), body) })
      if (path === '/note/edit') return send(res, 200, { ok: true, note: await editNote(checkId(body.id), String(body.note || ''), body) })
      if (path === '/note/delete') { await deleteNote(checkId(body.id), String(body.note || '')); return send(res, 200, { ok: true }) }
      if (path === '/note/polish') return send(res, 200, { ok: true, note: await polishNote(model(), checkId(body.id), String(body.note || '')) })
      if (path === '/notes/send') {
        const id = checkId(body.id)
        const book = await getBook(id)
        if (!book) return send(res, 404, { error: '没有这本书' })
        const n = await getNotes(id)
        if (!n.notes.length && !n.reviews.length) return send(res, 400, { error: '这本书还没有心得' })
        const markdown = notesMarkdown(book, n)
        const html = markdown.split('\n').map(l => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/^#+\s*/, '') || '<br>'}</div>`).join('')
        const message = await sendTo(String(body.target || ''), { title: `《${book.title}》读书心得`, markdown, html }, { tools: o.tools ? o.tools() : null, plugins: o.plugins ? o.plugins() : null })
        return send(res, 200, { ok: true, message })
      }
      if (path === '/ask') {
        const r = await ask(model(), checkId(body.id), { seg: body.seg, question: body.question, spoilers: Boolean(body.spoilers), mode: body.mode === 'notes' ? 'notes' : 'book' })
        return send(res, 200, { ok: true, ...r })
      }
      if (path === '/chat/clear') { await clearChat(checkId(body.id)); return send(res, 200, { ok: true }) }
      if (path === '/say') {
        const engine = String(body.engine || '')
        if (!SERVER_ENGINES.includes(engine)) return send(res, 400, { error: '不认识的朗读方式' })
        return serveAudio(req, res, await o.speech.say(String(body.text || ''), engine, String(body.voice || '')))
      }
      if (path === '/review') return send(res, 200, { ok: true, review: await writeReview(model(), checkId(body.id)) })
      if (path === '/review/delete') { await deleteReview(checkId(body.id), String(body.review || '')); return send(res, 200, { ok: true }) }
      if (path === '/reflect') return send(res, 200, { ok: true, ...(await reflect(model(), { days: Number(body.days) || 0 })) })
      if (path === '/edge/install') return send(res, 200, { ok: true, ...(await installEdge()) })
      if (path === '/kokoro/install') {
        // 下载要一两分钟：不等它，界面轮询 /status 看进度
        ensureKokoro().catch(() => {})
        return send(res, 200, { ok: true })
      }
      if (path === '/update' && o.manage) return send(res, 200, await o.manage.update())
      if (path === '/uninstall' && o.manage) return send(res, 200, await o.manage.uninstall())
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) })
      else res.destroy()
    }
  }
}
