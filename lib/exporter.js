// lib/exporter.js — 文字转音频下载：把整本书（或几章）合成好，拼成 MP3 下载
//
// 做法照「听懂」的文档转音频：每段的朗读文件格式一样，直接按顺序拼接、不重新编码，几个小时的书也很快拼完。
//   - 有 ffmpeg：用它的 concat 拼（-c copy，不重新编码），章与章之间插 1.5 秒静音，写上书名、作者
//   - 没有 ffmpeg：微软 Edge 的 MP3 直接首尾相接；本地语音（没 ffmpeg 时是 WAV）合成一个 WAV
// 合成在后台排队（不抢正在听的那段），关掉面板也接着做；每段一合成好就先存进这次导出的工作目录，
// 不怕声音缓存满了被清掉。做完只留成品，工作目录删掉。
//
// exports/<书>/<导出编号>/manifest.json  这次导出的设置、进度、成品清单
// 成品：一个 MP3（可选再配 LRC / SRT 字幕），或者每章一个 MP3 打成一个 ZIP（字幕也在包里）

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { EDGE_VOICES } from './edge.js'
import { kokoroVoice } from './kokoro.js'
import { dataRoot } from './paths.js'
import { checkId, getBook, getSegs } from './store.js'
import { sentences, weight } from './segment.js'
import { writeZip } from './zipwrite.js'

const GAP = 1.5 // 章与章之间的静音（秒）
const WINDOW = 8 // 同时排着几段在合成
const JOB_RE = /^[a-f0-9]{12}$/

export const exportsDir = id => join(dataRoot(), 'exports', checkId(id))
function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }) }
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || '未命名'

export function voiceLabel(engine, voice) {
  if (engine === 'edge') return `Edge ${(EDGE_VOICES.find(v => v.id === voice) || { label: voice }).label.split('（')[0]}`
  if (engine === 'kokoro') return `本地 ${(kokoroVoice(voice) || { label: voice }).label}`
  return voice
}

// ———————————————————— 时长 ————————————————————

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2 / 2.5 Layer III
}
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

/** 一个 MP3 有多长：一帧一帧数（CBR、VBR 都准）；开头的 ID3 标签跳过 */
export function mp3Duration(buf) {
  let off = 0
  if (buf.toString('ascii', 0, 3) === 'ID3') off = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9])
  let seconds = 0
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) { off++; continue }
    const ver = (buf[off + 1] >> 3) & 3 // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layer = (buf[off + 1] >> 1) & 3 // 1=Layer III
    const br = (buf[off + 2] >> 4) & 15
    const sr = (buf[off + 2] >> 2) & 3
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) { off++; continue }
    const bitrate = MP3_BITRATES[ver === 3 ? 1 : 2][br] * 1000
    const rate = MP3_RATES[ver][sr]
    const samples = ver === 3 ? 1152 : 576
    const len = Math.floor((samples / 8) * bitrate / rate) + ((buf[off + 2] >> 1) & 1)
    if (len < 4) { off++; continue }
    seconds += samples / rate
    off += len
  }
  return seconds
}

/** WAV 有多长 */
export function wavDuration(buf) {
  let off = 12
  let rate = 24000
  let block = 2
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') { rate = buf.readUInt32LE(off + 12); block = buf.readUInt16LE(off + 20) || 2 }
    if (id === 'data') return Math.min(size, buf.length - off - 8) / (rate * block)
    off += 8 + size + (size % 2)
  }
  return 0
}

// ———————————————————— 字幕 ————————————————————

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0')
const srtTime = (t) => { const ms = Math.max(0, Math.round(t * 1000)); return `${pad(ms / 3600000)}:${pad(ms / 60000 % 60)}:${pad(ms / 1000 % 60)},${pad(ms % 1000, 3)}` }
const lrcTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); return `[${pad(cs / 6000)}:${pad(cs / 100 % 60)}.${pad(cs % 100)}]` }
const oneLine = t => String(t || '').replace(/\s*\n\s*/g, ' ').trim()

/** rows: [{start, end, text}] */
export function toSrt(rows) {
  return rows.map((r, k) => `${k + 1}\n${srtTime(r.start)} --> ${srtTime(r.end)}\n${oneLine(r.text)}\n`).join('\n')
}
export function toLrc(rows, { title, author } = {}) {
  return [title ? `[ti:${title}]` : '', author ? `[ar:${author}]` : '', ...rows.map(r => `${lrcTime(r.start)}${oneLine(r.text)}`)].filter(Boolean).join('\n') + '\n'
}

// ———————————————————— 拼接 ————————————————————

function ffmpegRun(ffmpeg, args) {
  return new Promise((resolve, reject) => execFile(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { timeout: 30 * 60 * 1000, maxBuffer: 8 << 20 },
    (err, _o, stderr) => (err ? reject(new Error(`拼接音频失败：${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`)) : resolve())))
}

/** 不用 ffmpeg：MP3 首尾相接（去掉各自开头的 ID3 标签） */
async function catMp3(files, out) {
  const ws = createWriteStream(out)
  for (const f of files) {
    const buf = await readFile(f)
    let off = 0
    if (buf.toString('ascii', 0, 3) === 'ID3') off = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9])
    if (!ws.write(buf.subarray(off))) await once(ws, 'drain')
  }
  ws.end()
  await once(ws, 'close')
}

/** 不用 ffmpeg：WAV 合成一个（取第一个的格式，后面的只要数据部分） */
async function catWav(files, out) {
  const datas = []
  let fmt = null
  for (const f of files) {
    const buf = await readFile(f)
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ' && !fmt) fmt = buf.subarray(off, off + 8 + size)
      if (id === 'data') { datas.push(buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8))); break }
      off += 8 + size + (size % 2)
    }
  }
  const total = datas.reduce((a, d) => a + d.length, 0)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0); head.writeUInt32LE(4 + fmt.length + 8 + total, 4); head.write('WAVE', 8)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0); dataHead.writeUInt32LE(total, 4)
  const ws = createWriteStream(out)
  for (const b of [head, fmt, dataHead, ...datas]) if (!ws.write(b)) await once(ws, 'drain')
  ws.end()
  await once(ws, 'close')
}

/**
 * 一组段落 → 一个音频文件 + 字幕时间
 * @param {{ file: string, seconds: number, text: string, chapterStart?: boolean }[]} parts 按顺序
 * @param {string} base 输出路径（不带扩展名：拼出来是 MP3 还是 WAV 由这里定）
 */
async function build(parts, base, { ffmpeg, workDir, meta }) {
  const wav = parts.every(p => p.file.endsWith('.wav'))
  const out = base + (wav ? '.wav' : '.mp3')
  // 拼 MP3 时，个别没有字的段（「※ ※ ※」）是 WAV 静音：跳过
  const use = wav ? parts : parts.filter(p => p.file.endsWith('.mp3'))
  const rows = []
  let t = 0
  const gap = Boolean(ffmpeg) && !wav
  for (const [k, p] of use.entries()) {
    if (gap && k > 0 && p.chapterStart) t += GAP
    // 字幕一句一行：一段里的几句按字数分这段的时长
    const lines = String(p.text || '').split('\n').flatMap(par => sentences(par)).map(x => x.trim()).filter(Boolean)
    const total = lines.reduce((a, l) => a + weight(l), 0) || 1
    let at = t
    for (const l of lines) {
      const d = p.seconds * weight(l) / total
      rows.push({ start: at, end: at + d, text: l })
      at += d
    }
    t += p.seconds
  }
  if (!use.length) throw new Error('选的范围里没有能读的文字')
  if (wav) {
    await catWav(use.map(p => p.file), out)
  } else if (ffmpeg) {
    const silence = join(workDir, 'gap.mp3')
    if (!existsSync(silence)) await ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(GAP), '-c:a', 'libmp3lame', '-b:a', '48k', silence])
    const q = f => `file '${f.replace(/'/g, "'\\''")}'`
    const list = use.flatMap((p, k) => (k > 0 && p.chapterStart ? [q(silence), q(p.file)] : [q(p.file)])).join('\n')
    const listFile = join(workDir, `concat-${randomUUID().slice(0, 6)}.txt`)
    await writeFile(listFile, list + '\n')
    await ffmpegRun(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy',
      '-metadata', `title=${meta.title}`, '-metadata', `artist=${meta.author || ''}`, '-metadata', `album=${meta.album || meta.title}`, out])
  } else {
    await catMp3(use.map(p => p.file), out)
  }
  return { rows, seconds: t, ext: wav ? '.wav' : '.mp3', file: out }
}

// ———————————————————— 导出任务 ————————————————————

/**
 * @param {object} o
 * @param {{ make(id, seg, engine, voice): Promise<string> }} o.speech
 * @param {() => string|null} o.ffmpeg
 */
export function createExporter(o) {
  const jobs = new Map() // 在跑的：编号 → 任务

  const manifestPath = (id, job) => join(exportsDir(id), job, 'manifest.json')
  const save = j => writeFile(manifestPath(j.bookId, j.id), JSON.stringify(view(j), null, 1))
  /** 给界面看的（不带内部字段） */
  const view = j => ({
    id: j.id, bookId: j.bookId, title: j.title, label: j.label, engine: j.engine, voice: j.voice, voiceLabel: j.voiceLabel,
    from: j.from, to: j.to, split: j.split, subs: j.subs, state: j.state, done: j.done, total: j.total,
    error: j.error || '', outputs: j.outputs || [], seconds: j.seconds || 0, createdAt: j.createdAt, finishedAt: j.finishedAt || 0,
  })

  async function run(j) {
    const segs = await getSegs(j.bookId)
    const book = await getBook(j.bookId)
    const dir = join(exportsDir(j.bookId), j.id)
    const workDir = join(dir, 'work')
    await mkdir(workDir, { recursive: true })
    const chs = book.chapters
    const endOf = k => (k + 1 < chs.length ? chs[k + 1].seg : segs.length)
    // 要读的段：每段记着属于哪章
    const list = []
    for (let k = j.from; k <= j.to; k++) for (let s = chs[k].seg; s < endOf(k); s++) list.push({ seg: s, chapter: k, chapterStart: s === chs[k].seg })
    j.total = list.length
    const parts = new Array(list.length)
    // 按顺序拿，前面排着 WINDOW 段在合成
    let next = 0
    const pending = []
    const fill = () => { while (next < list.length && pending.length < WINDOW) { const it = list[next++]; const p = o.speech.make(j.bookId, it.seg, j.engine, j.voice); p.catch(() => {}); pending.push({ it, p }) } }
    fill()
    for (let k = 0; k < list.length; k++) {
      if (j.cancelled) throw new Error('已取消')
      const { it, p } = pending.shift()
      fill()
      const src = await p
      // 先存进工作目录（硬链接，不占地方；跨盘就复制），之后清缓存也不影响
      const ext = src.endsWith('.wav') ? '.wav' : '.mp3'
      const dst = join(workDir, `${String(it.seg).padStart(6, '0')}${ext}`)
      if (!existsSync(dst)) { try { await link(src, dst) } catch { await copyFile(src, dst) } }
      const buf = await readFile(dst)
      parts[k] = { file: dst, seconds: ext === '.wav' ? wavDuration(buf) : mp3Duration(buf), text: segs[it.seg], chapter: it.chapter, chapterStart: it.chapterStart }
      j.done = k + 1
      if (k % 20 === 0) save(j).catch(() => {})
    }

    // 拼成品
    j.state = 'building'
    await save(j)
    const ffmpeg = o.ffmpeg()
    const meta = { title: book.title, author: book.author, album: book.title }
    const outputs = []
    if (j.split === 'chapter') {
      const entries = []
      for (let k = j.from; k <= j.to; k++) {
        const chParts = parts.filter(p => p.chapter === k)
        if (!chParts.length) continue
        const base = `${String(k - j.from + 1).padStart(String(j.to - j.from + 1).length, '0')} ${safeName(chs[k].title)}`
        const tmp = join(workDir, `ch${k}`)
        const r = await build(chParts, tmp, { ffmpeg, workDir, meta: { ...meta, title: chs[k].title } })
        entries.push({ name: base + r.ext, file: r.file })
        if (j.subs) {
          await writeFile(tmp + '.lrc', toLrc(r.rows, { title: chs[k].title, author: book.author }))
          await writeFile(tmp + '.srt', toSrt(r.rows))
          entries.push({ name: `${base}.lrc`, file: tmp + '.lrc' }, { name: `${base}.srt`, file: tmp + '.srt' })
        }
        j.seconds = (j.seconds || 0) + r.seconds
      }
      const name = `${safeName(`《${book.title}》${j.label}（${j.voiceLabel}）`)}.zip`
      await writeZip(join(dir, 'audio.zip'), entries)
      outputs.push({ kind: 'zip', name, file: 'audio.zip', size: (await stat(join(dir, 'audio.zip'))).size })
    } else {
      const r = await build(parts, join(workDir, 'all'), { ffmpeg, workDir, meta })
      const base = safeName(`《${book.title}》${j.label}（${j.voiceLabel}）`)
      await rename(r.file, join(dir, `audio${r.ext}`))
      outputs.push({ kind: 'audio', name: base + r.ext, file: `audio${r.ext}`, size: (await stat(join(dir, `audio${r.ext}`))).size })
      if (j.subs) {
        await writeFile(join(dir, 'audio.lrc'), toLrc(r.rows, { title: book.title, author: book.author }))
        await writeFile(join(dir, 'audio.srt'), toSrt(r.rows))
        outputs.push({ kind: 'lrc', name: `${base}.lrc`, file: 'audio.lrc', size: (await stat(join(dir, 'audio.lrc'))).size })
        outputs.push({ kind: 'srt', name: `${base}.srt`, file: 'audio.srt', size: (await stat(join(dir, 'audio.srt'))).size })
      }
      j.seconds = r.seconds
    }
    await rm(workDir, { recursive: true, force: true })
    j.outputs = outputs
    j.state = 'done'
    j.finishedAt = Date.now()
    await save(j)
  }

  return {
    /**
     * 开始导出
     * @param {string} id 书
     * @param {{ from: number, to: number, engine: string, voice: string, split?: 'one'|'chapter', subs?: boolean }} opt 章节从 0 开始，含首尾
     */
    async start(id, opt) {
      checkId(id)
      const book = await getBook(id)
      if (!book) throw bad('没有这本书', 404)
      const n = book.chapters.length
      const from = Math.max(0, Math.min(n - 1, Math.floor(Number(opt.from) || 0)))
      const to = Math.max(from, Math.min(n - 1, Math.floor(Number(opt.to ?? n - 1))))
      if (!['edge', 'kokoro'].includes(opt.engine)) throw bad('导出要用微软 Edge 或本地离线语音（浏览器朗读的声音在你的设备上，存不下来）')
      if ([...jobs.values()].some(j => j.bookId === id && j.state !== 'done' && j.state !== 'failed')) throw bad('这本书已经有一个在导出，等它做完或者先取消')
      const label = from === 0 && to === n - 1 ? '全本' : from === to ? `第 ${from + 1} 章` : `第 ${from + 1}–${to + 1} 章`
      const j = {
        id: randomUUID().replace(/-/g, '').slice(0, 12), bookId: id, title: book.title, label,
        engine: opt.engine, voice: String(opt.voice || ''), voiceLabel: voiceLabel(opt.engine, opt.voice),
        from, to, split: opt.split === 'chapter' ? 'chapter' : 'one', subs: opt.subs !== false,
        state: 'running', done: 0, total: 0, createdAt: Date.now(),
      }
      await mkdir(join(exportsDir(id), j.id), { recursive: true })
      jobs.set(j.id, j)
      await save(j)
      run(j).catch(async (e) => {
        j.state = 'failed'
        j.error = e.message
        await save(j).catch(() => {})
        await rm(join(exportsDir(id), j.id, 'work'), { recursive: true, force: true }).catch(() => {})
      }).finally(() => { jobs.delete(j.id) })
      return view(j)
    },

    /** 一本书的导出（在跑的 + 做完的 + 失败的），新的在前 */
    async list(id) {
      let names = []
      try { names = await readdir(exportsDir(id)) } catch { return [] }
      const out = []
      for (const job of names) {
        if (!JOB_RE.test(job)) continue
        if (jobs.has(job)) { out.push(view(jobs.get(job))); continue }
        try {
          const m = JSON.parse(await readFile(manifestPath(id, job), 'utf8'))
          // DSH 重启了，没做完的就算中断（已经合成的段还在缓存里，重新开始会很快）
          if (m.state === 'running' || m.state === 'building') { m.state = 'failed'; m.error = 'DSH 重启了，导出中断：重新开始会接着用已经合成好的部分' }
          out.push(m)
        } catch { /* 坏的跳过 */ }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },

    cancel(job) {
      const j = jobs.get(job)
      if (!j) return false
      j.cancelled = true
      return true
    },

    async remove(id, job) {
      if (!JOB_RE.test(String(job))) throw bad('导出编号不对')
      if (jobs.has(job)) { jobs.get(job).cancelled = true; jobs.delete(job) }
      await rm(join(exportsDir(id), job), { recursive: true, force: true })
    },

    /** 成品文件在哪、下载时叫什么 */
    async file(id, job, which) {
      if (!JOB_RE.test(String(job))) throw bad('导出编号不对')
      const m = JSON.parse(await readFile(manifestPath(id, job), 'utf8').catch(() => { throw bad('没有这次导出', 404) }))
      const o2 = (m.outputs || []).find(x => x.file === which) || (m.outputs || [])[0]
      if (!o2) throw bad('还没做好', 409)
      return { path: join(exportsDir(id), job, o2.file), name: o2.name, kind: o2.kind }
    },

    stopAll() { for (const j of jobs.values()) j.cancelled = true },
  }
}

/** 估一下：音频大概多长、生成大概要多久（秒）；cjk：中文书 */
export function estimate(chars, engine, { cjk = true, workers = 2 } = {}) {
  const audio = chars / (cjk ? 4.2 : 15) // 中文每秒四个字左右，英文每秒十五个字母左右
  const make = engine === 'edge' ? audio / 12 : audio / (1.4 * workers)
  return { audio: Math.round(audio), make: Math.round(make) }
}

