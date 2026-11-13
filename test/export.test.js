// 文字转音频下载、AI 添加搜索地址（不联网、不用 ffmpeg：MP3 是手工拼的帧，网络是假的）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'audiobook-export-'))
process.env.DSH_AUDIOBOOK_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const { createExporter, mp3Duration, wavDuration, toLrc, toSrt, estimate } = await import('../lib/exporter.js')
const { importDocument } = await import('../lib/importer.js')
const { openZip } = await import('../lib/zip.js')
const { cleanTemplate, formTemplate, fromOpenSearch, parseForms, discoverSearch } = await import('../lib/discover.js')

/** n 帧 MPEG-2 Layer III、24 kHz、48 kbps、单声道：每帧 144 字节、0.024 秒（和微软 Edge 的输出一样） */
function mp3(frames) {
  const frame = Buffer.alloc(144)
  frame[0] = 0xff; frame[1] = 0xf3; frame[2] = 0x64; frame[3] = 0xc0
  return Buffer.concat(Array.from({ length: frames }, () => frame))
}

test('时长：一帧一帧数 MP3（跳过 ID3）；WAV 按数据长度', () => {
  assert.equal(Math.round(mp3Duration(mp3(100)) * 1000), 2400)
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...Buffer.alloc(10)])
  assert.equal(Math.round(mp3Duration(Buffer.concat([id3, mp3(50)])) * 1000), 1200)
  const wav = Buffer.alloc(44 + 48000)
  wav.write('RIFF', 0); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40)
  assert.equal(wavDuration(wav), 1)
})

test('字幕：LRC、SRT 的时间格式', () => {
  const rows = [{ start: 0, end: 2.5, text: '第一章' }, { start: 62.04, end: 65, text: '傍晚六点，\n最后一班船。' }]
  assert.equal(toLrc(rows, { title: '书', author: '某' }), '[ti:书]\n[ar:某]\n[00:00.00]第一章\n[01:02.04]傍晚六点， 最后一班船。\n')
  assert.match(toSrt(rows), /^1\n00:00:00,000 --> 00:00:02,500\n第一章\n\n2\n00:01:02,040 --> 00:01:05,000\n/)
  assert.ok(estimate(42000, 'edge').audio === 10000)
  assert.ok(estimate(42000, 'kokoro').make > estimate(42000, 'edge').make)
})

test('导出：后台按顺序合成、拼成一个 MP3 带字幕；每章一个打成 ZIP；浏览器朗读不能导出', async () => {
  const f = join(home, '书.txt')
  await writeFile(f, '第一章 开端\n甲走进屋子。乙在等他。\n第二章 结局\n甲离开了村子。')
  const book = await importDocument(f)
  // 假的合成：每段一个 MP3，段号越大越长；还记下导出排的是不是「不插队」
  const made = []
  const dir = join(home, 'fake')
  await mkdir(dir, { recursive: true })
  const speech = {
    async make(id, seg, engine, voice) {
      made.push({ id, seg, engine, voice })
      const p = join(dir, `${seg}.mp3`)
      await writeFile(p, mp3(50 + seg * 10))
      return p
    },
  }
  const ex = createExporter({ speech, ffmpeg: () => null })
  await assert.rejects(ex.start(book.id, { engine: 'browser' }), /浏览器朗读/)
  const wait = async (job) => {
    for (let k = 0; k < 100; k++) {
      const j = (await ex.list(book.id)).find(x => x.id === job.id)
      if (j.state === 'done' || j.state === 'failed') return j
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('导出没做完')
  }
  const one = await wait(await ex.start(book.id, { engine: 'edge', voice: 'zh-CN-YunxiNeural' }))
  assert.equal(one.state, 'done', one.error)
  assert.equal(one.label, '全本')
  assert.equal(one.voiceLabel, 'Edge 云希')
  assert.deepEqual(made.map(m => m.seg), [0, 1, 2, 3])
  assert.deepEqual(one.outputs.map(o => o.kind), ['audio', 'lrc', 'srt'])
  assert.equal(one.outputs[0].name, '《书》全本（Edge 云希）.mp3')
  const audio = await ex.file(book.id, one.id, 'audio.mp3')
  // 没有 ffmpeg：MP3 首尾相接，总时长是各段之和
  const total = [0, 1, 2, 3].reduce((a, s) => a + (50 + s * 10) * 0.024, 0)
  assert.equal(Math.round(mp3Duration(readFileSync(audio.path)) * 100), Math.round(total * 100))
  const lrc = readFileSync((await ex.file(book.id, one.id, 'audio.lrc')).path, 'utf8')
  assert.match(lrc, /\[00:00\.00\]第一章 开端/)
  assert.match(lrc, /\]甲走进屋子。\n\[\d\d:\d\d\.\d\d\]乙在等他。/, '字幕一句一行')

  const zipJob = await wait(await ex.start(book.id, { engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', from: 0, to: 1, split: 'chapter' }))
  assert.equal(zipJob.state, 'done', zipJob.error)
  const z = openZip(readFileSync((await ex.file(book.id, zipJob.id)).path))
  assert.deepEqual(z.names, ['1 第一章 开端.mp3', '1 第一章 开端.lrc', '1 第一章 开端.srt', '2 第二章 结局.mp3', '2 第二章 结局.lrc', '2 第二章 结局.srt'])
  assert.ok(mp3Duration(z.read('2 第二章 结局.mp3')) > 0)

  const part = await wait(await ex.start(book.id, { engine: 'edge', voice: 'zh-CN-YunxiNeural', from: 1, to: 1 }))
  assert.equal(part.label, '第 2 章')
  assert.equal((await ex.list(book.id)).length, 3)
  await ex.remove(book.id, part.id)
  assert.equal((await ex.list(book.id)).length, 2)
})

// ———————————————————— AI 添加搜索地址 ————————————————————

test('搜索地址：OpenSearch 描述、GET 表单、去掉空参数', () => {
  const os = '<OpenSearchDescription><Url type="text/html" template="https://a.com/search?q={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>'
  assert.deepEqual(fromOpenSearch(os, 'https://a.com/os.xml'), { url: 'https://a.com/search?q={q}', kind: 'web' })
  const forms = parseForms('<form action="/s" method="get"><input type="hidden" name="cat" value="1001"><input name="wd" placeholder="搜书"><input type="submit"></form><form method="post" action="/login"><input name="user"></form>', 'https://b.com/home')
  assert.equal(forms.length, 2)
  assert.equal(formTemplate(forms[0]), 'https://b.com/s?cat=1001&wd={q}')
  assert.equal(formTemplate(forms[1]), null, 'POST 表单做不成搜索地址')
  assert.equal(cleanTemplate('https://c.com/x?query={q}&per-page=&page='), 'https://c.com/x?query={q}')
})

test('AI 添加：找表单 → 真去搜一次验证；有人机验证的说清楚；找不到时问模型', async () => {
  const prev = globalThis.fetch
  const pages = {
    'https://shu.example/': '<title>好书网 - 首页</title><form action="/search"><input name="keyword"></form>',
    'https://shu.example/search?keyword=%E7%BA%A2%E6%A5%BC%E6%A2%A6': '<p>红楼梦 的搜索结果</p>',
    'https://cf.example/': '<title>Just a moment...</title>',
    'https://spa.example/': '<title>单页应用</title><div id="app"></div>',
  }
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u in pages) return new Response(pages[u], { status: u.startsWith('https://cf.') ? 503 : 200, headers: { 'content-type': 'text/html' } })
    return new Response('not found', { status: 404 })
  }
  try {
    const r = await discoverSearch('shu.example')
    assert.deepEqual(r, { name: '好书网', url: 'https://shu.example/search?keyword={q}', kind: 'web', verified: true, how: '找到了网页上的搜索框' })
    await assert.rejects(discoverSearch('https://cf.example'), /人机验证/)
    await assert.rejects(discoverSearch('https://spa.example'), /没找到这个网站的搜索功能/)
    const llm = { async complete() { return '{"url":"https://spa.example/find?q={q}","why":"凭了解"}' } }
    const g = await discoverSearch('https://spa.example', { llm })
    assert.equal(g.url, 'https://spa.example/find?q={q}')
    assert.equal(g.verified, false)
    assert.match(g.how, /没能自动验证/)
    await assert.rejects(discoverSearch('ftp://x'), /http/)
  } finally { globalThis.fetch = prev }
})
