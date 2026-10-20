// 用假的 DSH 宿主（inject / webServer / tools / connection）挂上插件，走一遍接口和 AI 工具
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeEpub } from './helpers.js'

const home = await mkdtemp(join(tmpdir(), 'audiobook-test-'))
process.env.DSH_AUDIOBOOK_HOME = home
// 别借用本机「听懂」的模型和 Edge 组件：测试要看「没装」时的样子
process.env.DSH_TINGDONG_HOME = join(home, 'no-tingdong')

const plugin = (await import('../plugin/index.js')).default

function fakeCtx() {
  const services = {
    webServer: { routes: [], register(r) { this.routes.push(r); return () => {} } },
    tools: { defs: [], register(d) { this.defs.push(d); return () => {} } },
    // 假的 DSH 信任围栏：带 x-deny 头的请求当成没登录
    connection: { requestRejection: req => (req.headers['x-deny'] ? 401 : undefined) },
  }
  const effects = []
  return {
    services,
    effects,
    effect(fn) { effects.push(fn()) },
    inject(names, cb) {
      const scope = { effect: fn => { effects.push(fn()) }, get: n => services[n] }
      for (const n of names) scope[n] = services[n]
      cb(scope)
    },
  }
}

let server, base, ctx
const P = '/api-dsh-audiobook/'
const get = async (path, headers = {}) => { const r = await fetch(base + P + path, { headers }); return { status: r.status, body: await r.json().catch(() => null) } }
const post = async (path, body, headers = { 'x-audiobook': '1', 'content-type': 'application/json' }) => {
  const r = await fetch(base + P + path, { method: 'POST', headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const tool = name => ctx.services.tools.defs.find(d => d.name === name)

const BOOK_TXT = `第一章 出发\n${'清晨，他背起行囊走出家门。'.repeat(12)}\n* * *\n第二章 远方\n路上遇到了一个叫阿青的姑娘。她说要去海边。\n第三章 海边\n阿青终于看到了海。`

before(async () => {
  ctx = fakeCtx()
  plugin.apply(ctx, {})
  await new Promise(r => setTimeout(r, 50)) // 工具注册是异步的
  const route = ctx.services.webServer.routes[0]
  server = createServer((req, res) => route.handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  for (const fn of ctx.effects) if (typeof fn === 'function') fn() // 停掉合成子进程
  server && server.close()
  await rm(home, { recursive: true, force: true })
})

test('挂一个前缀路由，注册 4 个工具', () => {
  const routes = ctx.services.webServer.routes
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api-dsh-audiobook')
  assert.deepEqual(ctx.services.tools.defs.map(d => d.name), ['audiobook_import', 'audiobook_books', 'audiobook_text', 'audiobook_goto'])
  for (const d of ctx.services.tools.defs) assert.equal(d.parameters.type, 'object')
})

test('没过 DSH 登录校验的请求原样拒绝；改东西的请求要带自定义头', async () => {
  assert.equal((await get('books', { 'x-deny': '1' })).status, 401)
  assert.equal((await post('import', { path: '/x' }, { 'content-type': 'application/json' })).status, 403)
  const cross = await post('import', { path: '/x' }, { 'x-audiobook': '1', origin: 'https://evil.example' })
  assert.equal(cross.status, 403)
})

test('面板页面和状态', async () => {
  const r = await fetch(base + P + 'panel')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /搜书听/)
  const s = await get('status')
  assert.equal(s.status, 200)
  assert.equal(s.body.host, 'dsh')
  assert.equal(s.body.kokoro.ready, false)
  assert.equal(typeof s.body.edge.ready, 'boolean')
})

let bookId
test('按路径导入，再导入一次是同一本书', async () => {
  const f = join(home, '远行记.txt')
  await writeFile(f, BOOK_TXT)
  const r = await post('import', { path: f })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.book.title, '远行记')
  assert.equal(r.body.book.chapters, 3)
  assert.equal(r.body.book.existed, false)
  bookId = r.body.book.id
  const again = await post('import', { path: f })
  assert.equal(again.body.book.id, bookId)
  assert.equal(again.body.book.existed, true)
  const missing = await post('import', { path: join(home, 'nope.txt') })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /找不到文件/)
})

test('上传 EPUB（请求体就是文件），上传的临时文件不留', async () => {
  const epub = makeEpub({ title: '上传的书', chapters: [{ toc: '第一章', html: '<p>你好。</p>' }] })
  const r = await post(`upload?name=${encodeURIComponent('x.epub')}`, epub, { 'x-audiobook': '1' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.book.title, '上传的书')
  assert.deepEqual(await readdir(join(home, 'uploads')), [])
  const bad = await post('upload?name=a.exe', 'x', { 'x-audiobook': '1' })
  assert.equal(bad.status, 400)
})

test('书单、一本书、进度（越界夹住）', async () => {
  const list = await get('books')
  assert.equal(list.body.books.length, 2)
  const b = await get(`book?id=${bookId}`)
  assert.equal(b.body.book.chapters[1].title, '第二章 远方')
  assert.equal(b.body.segs.length, b.body.book.segCount)
  assert.equal(b.body.progress.seg, 0)
  const p = await post('progress', { id: bookId, seg: 99999 })
  assert.equal(p.body.seg, b.body.book.segCount - 1)
  await post('progress', { id: bookId, seg: 2 })
  assert.equal((await get(`progress?id=${bookId}`)).body.seg, 2)
  // 最近听的排第一
  assert.equal((await get('books')).body.books[0].id, bookId)
  assert.equal((await get('book?id=../etc')).status, 400)
})

test('设置：只收认得的值', async () => {
  const r = await post('settings', { engine: 'edge', voices: { edge: 'zh-CN-XiaoxiaoNeural', bogus: 'x' }, rate: 1.5, sleep: 30 })
  assert.equal(r.body.settings.engine, 'edge')
  assert.equal(r.body.settings.voices.edge, 'zh-CN-XiaoxiaoNeural')
  assert.equal(r.body.settings.rate, 1.5)
  const r2 = await post('settings', { engine: 'nope', rate: 99 })
  assert.equal(r2.body.settings.engine, 'edge')
  assert.equal(r2.body.settings.rate, 1.5)
  assert.equal((await get('settings')).body.voices.kokoro, 'f01')
})

let symId
test('合成：没有能读的字的段直接给一小段静音；没装的引擎说清楚怎么装', async () => {
  const f = join(home, '符号.txt')
  await writeFile(f, '第一章\n※ ※ ※\n第二章\n好。')
  symId = (await post('import', { path: f })).body.book.id
  const b = (await get(`book?id=${symId}`)).body
  const star = b.segs.findIndex(s => s.trim() === '※ ※ ※')
  assert.ok(star > 0, JSON.stringify(b.segs))
  const r = await post('speak', { id: symId, seg: star, engine: 'kokoro', voice: 'f01' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const audio = await fetch(base + P + r.body.url)
  assert.equal(audio.status, 200)
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  // Range 请求
  const part = await fetch(base + P + r.body.url, { headers: { range: 'bytes=0-3' } })
  assert.equal(part.status, 206)
  assert.equal(Buffer.from(await part.arrayBuffer()).toString('ascii'), 'RIFF')

  const k = await post('speak', { id: bookId, seg: 0, engine: 'kokoro', voice: 'f01' })
  assert.equal(k.status, 400)
  assert.match(k.body.error, /下载中文语音模型/)
  assert.equal((await post('speak', { id: bookId, seg: 0, engine: 'say', voice: 'x' })).status, 400)
  assert.equal((await post('speak', { id: bookId, seg: 0, engine: 'edge', voice: 'not-a-voice' })).status, 400)
  assert.equal((await post('speak', { id: bookId, seg: 99999, engine: 'kokoro', voice: 'f01' })).status, 400)
})

test('AI 工具：书单、刚听过的内容、找人名、按章取、跳章', async () => {
  const books = await tool('audiobook_books').execute({})
  assert.equal(books.books[0].id, bookId)
  assert.match(tool('audiobook_books').output.render({}, books)[0].text, /《远行记》/)

  await tool('audiobook_goto').execute({ id: bookId, chapter: '2' })
  const segs = (await get(`book?id=${bookId}`)).body
  const ch2 = segs.book.chapters[1].seg
  assert.equal((await get(`progress?id=${bookId}`)).body.seg, ch2)

  const recent = await tool('audiobook_text').execute({ id: bookId, limit: 300 })
  assert.match(recent.where, /第 2 章「第二章 远方」/)
  assert.match(recent.text, /第二章 远方$/)
  assert.match(recent.text, /清晨/)

  const found = await tool('audiobook_text').execute({ mode: 'find', query: '阿青' })
  assert.match(found.where, /出现在 2 段/)
  assert.match(found.text, /第二章 远方/)
  assert.match(found.text, /第三章 海边/)

  const chap = await tool('audiobook_text').execute({ mode: 'chapter', chapter: '海边' })
  assert.equal(chap.text, '第三章 海边\n阿青终于看到了海。')
  await assert.rejects(tool('audiobook_text').execute({ mode: 'chapter', chapter: '不存在' }), /目录：1\. 第一章 出发/)

  const g = await tool('audiobook_goto').execute({ query: '终于' })
  assert.equal(g.chapterTitle, '第三章 海边')
  assert.match(tool('audiobook_goto').output.render({}, g)[0].text, /收听位置已改到「第三章 海边」/)
})

test('AI 工具：导入', async () => {
  const f = join(home, 'note.md')
  await writeFile(f, '# 笔记\n\n## 一\n\n内容。')
  const r = await tool('audiobook_import').execute({ path: f })
  assert.equal(r.title, '笔记')
  assert.match(tool('audiobook_import').output.render({}, r)[0].text, /已导入/)
})

test('删书连同缓存', async () => {
  assert.ok(existsSync(join(home, 'cache', symId)))
  assert.equal((await post('delete', { id: symId })).status, 200)
  assert.equal(existsSync(join(home, 'books', symId)), false)
  assert.equal(existsSync(join(home, 'cache', symId)), false)
  assert.equal((await get(`book?id=${symId}`)).status, 404)
})
