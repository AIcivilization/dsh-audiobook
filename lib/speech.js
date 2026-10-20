// lib/speech.js — 在服务器上合成朗读段（微软 Edge / 本地 Kokoro），带缓存和预取
//
// 每段合成一个音频文件，缓存在 cache/<书>/<方式>-<声音>/<段号>.mp3（没有 ffmpeg 时本地语音是 .wav）。
// 正在听的那段插队先做，后面几段在后台预取；跳到别处时，排队还没开始的旧预取直接作废。
// 语速不进缓存：播放器自己调（playbackRate），换语速不用重新合成。
// 缓存超过 500 MB 时删掉最久没用的。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { cacheDir } from './paths.js'
import { edgeSpeak, isEdgeVoice } from './edge.js'
import { createKokoro, kokoroVoice } from './kokoro.js'
import { getSegs } from './store.js'

export const SERVER_ENGINES = ['edge', 'kokoro']
const CACHE_LIMIT = 500 * 1024 * 1024
const EDGE_CONCURRENCY = 3

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

/** 朗读前把文字理一理：段落分隔变停顿；Kokoro 会把引号书名号读出怪停顿，去掉 */
export function speakable(text, engine) {
  let t = String(text || '').replace(/\s*\n\s*/g, '\n').trim()
  // 人名里的间隔号（艾米莉・麥澤）不在词典里，会读成一个怪音
  if (engine === 'kokoro') t = t.replace(/[“”"「」『』《》【】・•]/g, '').replace(/\n/g, '，')
  return t
}

/** 0.3 秒静音的 WAV：一段里没有能读的字（如「* * *」「……」）时用 */
function silenceWav(seconds = 0.3, rate = 24000) {
  const n = Math.round(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  return buf
}

const voiceTag = v => String(v).replace(/[^A-Za-z0-9-]/g, '_').slice(0, 60)

/**
 * @param {object} o
 * @param {() => string|null} o.ffmpeg 找 ffmpeg（找不到时本地语音直接给 WAV）
 * @param {number} [o.threads] 每个本地语音进程的线程数
 * @param {number} [o.workers] 同时开几个本地语音进程。Kokoro 加线程几乎不变快（一个进程合成 15 秒的声音要 10 秒左右），
 *   多开进程才能翻倍，代价是每个进程占 300–400 MB 内存
 */
export function createSpeech(o) {
  const pool = Array.from({ length: Math.max(1, Math.min(4, o.workers || 2)) }, () => ({ k: createKokoro({ threads: o.threads || 2 }), busy: 0 }))
  const CONCURRENCY = { edge: EDGE_CONCURRENCY, kokoro: pool.length }
  const queues = { edge: [], kokoro: [] }
  const running = { edge: 0, kokoro: 0 }
  const inflight = new Map() // 缓存文件的基本路径 → Promise<文件>
  let made = 0

  function checkVoice(engine, voice) {
    if (engine === 'edge' && !isEdgeVoice(voice)) throw bad('没有这个 Edge 声音')
    if (engine === 'kokoro' && !kokoroVoice(voice)) throw bad('没有这个本地声音')
    if (!SERVER_ENGINES.includes(engine)) throw bad('不认识的朗读方式')
  }

  const baseOf = (id, seg, engine, voice) => join(cacheDir(), id, `${engine}-${voiceTag(voice)}`, String(seg))

  /** 已经合成好的文件（.mp3 优先） */
  function cached(base) {
    for (const ext of ['.mp3', '.wav']) if (existsSync(base + ext)) return base + ext
    return null
  }

  async function synth(id, seg, engine, voice, base) {
    const segs = await getSegs(id)
    if (!Number.isInteger(seg) || seg < 0 || seg >= segs.length) throw bad('没有这一段')
    return synthText(speakable(segs[seg], engine), engine, voice, base)
  }

  /** 合成一段文字到 base.mp3 / base.wav */
  async function synthText(text, engine, voice, base) {
    await mkdir(join(base, '..'), { recursive: true })
    const tmp = `${base}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
    if (!/[\p{L}\p{N}]/u.test(text)) {
      await writeFile(tmp + '.wav', silenceWav())
      await rename(tmp + '.wav', base + '.wav')
      return base + '.wav'
    }
    try {
      if (engine === 'edge') {
        await edgeSpeak(text, voice, tmp + '.mp3')
        await rename(tmp + '.mp3', base + '.mp3')
        return base + '.mp3'
      }
      const w = pool.reduce((a, b) => (b.busy < a.busy ? b : a))
      w.busy++
      try { await w.k.speak(text, kokoroVoice(voice).sid, tmp + '.wav') } finally { w.busy-- }
      const ff = o.ffmpeg()
      if (ff) {
        // 有 ffmpeg 就压成 MP3：WAV 一分钟约 2.8 MB，手机隔着 VPS 听会卡
        await new Promise((resolve, reject) => execFile(ff, ['-hide_banner', '-nostdin', '-y', '-i', tmp + '.wav', '-codec:a', 'libmp3lame', '-b:a', '64k', tmp + '.mp3'],
          { timeout: 60000 }, err => (err ? reject(new Error(`MP3 编码失败：${err.message}`)) : resolve())))
        await rename(tmp + '.mp3', base + '.mp3')
        await rm(tmp + '.wav', { force: true })
        return base + '.mp3'
      }
      await rename(tmp + '.wav', base + '.wav')
      return base + '.wav'
    } finally {
      await rm(tmp + '.mp3', { force: true })
      await rm(tmp + '.wav', { force: true })
    }
  }

  function pump(engine) {
    const q = queues[engine]
    while (running[engine] < CONCURRENCY[engine] && q.length) {
      const job = q.shift()
      running[engine]++
      job.run().then(job.resolve, job.reject).finally(() => {
        running[engine]--
        if (++made % 40 === 0) prune().catch(() => {})
        pump(engine)
      })
    }
  }

  /** 排一段：urgent 的插到队首；已在排队或在做的直接复用 */
  function enqueue(id, seg, engine, voice, { urgent = false, tag = '' } = {}) {
    const base = baseOf(id, seg, engine, voice)
    const hit = cached(base)
    if (hit) return Promise.resolve(hit)
    const queued = queues[engine].find(j => j.base === base)
    if (queued) {
      if (urgent) { queues[engine].splice(queues[engine].indexOf(queued), 1); queues[engine].unshift(queued); queued.tag = '' }
      return queued.promise
    }
    if (inflight.has(base)) return inflight.get(base)
    const job = { base, tag }
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject })
    job.run = () => {
      const p = synth(id, seg, engine, voice, base)
      inflight.set(base, p)
      return p.finally(() => inflight.delete(base))
    }
    job.promise.catch(() => {}) // 预取失败不要变成未处理的拒绝；需要时再取会重新报错
    if (urgent) queues[engine].unshift(job)
    else queues[engine].push(job)
    pump(engine)
    return job.promise
  }

  /** 缓存超过上限：按最后使用时间删最旧的 */
  async function prune() {
    const files = []
    const walk = async (dir, depth) => {
      let names = []
      try { names = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of names) {
        const p = join(dir, e.name)
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
        else if (e.isFile()) { try { const s = await stat(p); files.push({ p, size: s.size, t: s.mtimeMs }) } catch { /* 刚被删 */ } }
      }
    }
    await walk(cacheDir(), 0)
    let total = files.reduce((a, f) => a + f.size, 0)
    if (total <= CACHE_LIMIT) return
    files.sort((a, b) => a.t - b.t)
    for (const f of files) {
      if (total <= CACHE_LIMIT * 0.8) break
      await rm(f.p, { force: true })
      total -= f.size
    }
  }

  return {
    /** 读一段任意文字（「问 AI」的回答）：按内容缓存在 cache/_text/ 下，插队合成 */
    async say(text, engine, voice) {
      checkVoice(engine, voice)
      const t = speakable(String(text || '').slice(0, 3000), engine)
      if (!t) throw bad('没有要读的文字')
      const base = join(cacheDir(), '_text', `${engine}-${voiceTag(voice)}`, createHash('sha1').update(t).digest('hex').slice(0, 16))
      const hit = cached(base)
      if (hit) return hit
      if (inflight.has(base)) return inflight.get(base)
      const p = new Promise((resolve, reject) => {
        queues[engine].unshift({ base, tag: '', run: () => synthText(t, engine, voice, base), resolve, reject })
        pump(engine)
      })
      inflight.set(base, p)
      return p.finally(() => inflight.delete(base))
    },
    /** 取一段的音频文件；没有就马上合成（插队） */
    async get(id, seg, engine, voice) {
      checkVoice(engine, voice)
      const file = await enqueue(id, seg, engine, voice, { urgent: true })
      // 碰一下修改时间：清缓存时按它判断最近用没用过
      const now = new Date()
      utimes(file, now, now).catch(() => {})
      return file
    },
    /** 后台预取几段；同一本书、同一种声音以前排着还没开始的预取作废 */
    prefetch(id, segs, engine, voice) {
      checkVoice(engine, voice)
      const tag = `${id}|${engine}|${voice}`
      queues[engine] = queues[engine].filter(j => j.tag !== tag || segs.some(s => j.base === baseOf(id, s, engine, voice)))
      for (const s of segs) enqueue(id, s, engine, voice, { tag })
    },
    /** 删一本书的缓存 */
    async forget(id) {
      for (const e of SERVER_ENGINES) queues[e] = queues[e].filter(j => !j.base.startsWith(join(cacheDir(), id) + sep))
      await rm(join(cacheDir(), id), { recursive: true, force: true })
    },
    stop() {
      for (const e of SERVER_ENGINES) {
        for (const j of queues[e]) j.reject(new Error('已停止'))
        queues[e] = []
      }
      for (const w of pool) w.k.stop()
    },
  }
}
