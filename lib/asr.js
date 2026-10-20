// lib/asr.js — 语音输入：把浏览器录的一段话（16 kHz 单声道 WAV）识别成文字
//
// 用的是 DSH 自带「语音输入」的同一套本地模型（SenseVoice + Silero VAD，同一个版本）：
// 用过 DSH 语音输入、或者装了「听懂」的机器上已经下好了，直接复用；没有就下载到本插件自己的目录（约 241 MB），
// 先试 huggingface.co，连不上换 hf-mirror.com。识别在本机做，声音不传给任何第三方，录音识别完就删。
// 识别在常驻子进程里跑（lib/asr-worker.js）：sherpa-onnx 是同步推理，放在 DSH 主进程里会卡界面。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dataRoot, tingdongRoot } from './paths.js'

const HF = 'https://huggingface.co'
const SV = '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07'

const ASSETS = {
  model: { dir: 'sensevoice-onnx', name: 'model.int8.onnx', path: SV + '/model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  tokens: { dir: 'sensevoice-onnx', name: 'tokens.txt', path: SV + '/tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  vad: { dir: 'silero', name: 'silero_vad.onnx', path: '/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx', bytes: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' },
}
const TOTAL = Object.values(ASSETS).reduce((a, x) => a + x.bytes, 0)
const ORIGINS = [HF, 'https://hf-mirror.com']

/** 可能已经有模型的目录：DSH 语音输入的、听懂的、本插件自己的 */
const roots = () => [
  join(homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models'),
  join(tingdongRoot(), 'models'),
  join(dataRoot(), 'models'),
]

async function sizeMatches(path, asset) {
  try { return (await stat(path)).size === asset.bytes } catch { return false }
}

/** 找已有模型；三个文件都在才算 @returns {Promise<{model,tokens,vad}|null>} */
export async function findAsrModels() {
  const found = {}
  for (const [key, a] of Object.entries(ASSETS)) {
    for (const root of roots()) {
      const p = join(root, a.dir, a.name)
      if (existsSync(p) && await sizeMatches(p, a)) { found[key] = p; break }
    }
    if (!found[key]) return null
  }
  return found
}

async function sha256(path) {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c)
  return h.digest('hex')
}

/** 下载进度（给界面显示）：null 表示没在下 */
export const asrDownload = { state: null }

async function fetchAsset(asset, root, state) {
  const dir = join(root, asset.dir)
  const dest = join(dir, asset.name)
  if (await sizeMatches(dest, asset)) { state.got += asset.bytes; return dest }
  await mkdir(dir, { recursive: true })
  let lastError
  for (const origin of ORIGINS) {
    const part = `${dest}.${process.pid}.part`
    const base = state.got
    try {
      const res = await fetch(origin + asset.path, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const meter = new Transform({ transform(c, _e, cb) { state.got += c.length; cb(null, c) } })
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part))
      if (await sha256(part) !== asset.sha256) throw new Error('文件校验不通过')
      await rename(part, dest)
      return dest
    } catch (e) {
      lastError = e
      state.got = base
      await rm(part, { force: true })
    }
  }
  throw new Error(`下载语音识别模型 ${asset.name} 失败：${lastError && lastError.message}`)
}

/** 没有就下载（约 241 MB）；同一时刻只下一份 */
export async function ensureAsrModels() {
  const have = await findAsrModels()
  if (have) return have
  if (asrDownload.state && asrDownload.state.running) return asrDownload.state.promise
  const state = { running: true, got: 0, total: TOTAL, error: '' }
  asrDownload.state = state
  state.promise = (async () => {
    const root = join(dataRoot(), 'models')
    const out = {}
    for (const [key, a] of Object.entries(ASSETS)) out[key] = await fetchAsset(a, root, state)
    return out
  })().then(
    (m) => { state.running = false; return m },
    (e) => { state.running = false; state.error = e.message; throw e },
  )
  return state.promise
}

const WORKER = fileURLToPath(new URL('./asr-worker.js', import.meta.url))

/** 常驻的识别子进程：transcribe(wav 文件) → 文字。空闲 5 分钟关掉 */
export function createAsr({ threads = 2, idleMs = 5 * 60 * 1000 } = {}) {
  let child = null
  let seq = 0
  const waiting = new Map()
  let idle = null

  const stop = () => {
    if (child) { try { child.kill() } catch { /* 已经退了 */ } }
    child = null
  }
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => { if (!waiting.size) stop() }, idleMs)
    if (idle.unref) idle.unref()
  }

  function start(models) {
    // Electron（DSH 桌面版）里 process.execPath 是 App 本体：ELECTRON_RUN_AS_NODE=1 让它当 Node 用
    const c = spawn(process.execPath, [WORKER, JSON.stringify({ models, threads })], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stderr = ''
    c.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
    createInterface({ input: c.stdout }).on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      const w = waiting.get(msg.id)
      if (!w) return
      waiting.delete(msg.id)
      if (msg.error) w.reject(new Error(`语音识别失败：${msg.error}`))
      else w.resolve(msg.text || '')
    })
    c.on('exit', (code) => {
      if (child === c) child = null
      for (const [id, w] of waiting) {
        w.reject(new Error(`语音识别进程退出了（${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-1)[0] : ''}`))
        waiting.delete(id)
      }
    })
    c.stdin.on('error', () => {})
    return c
  }

  return {
    async transcribe(file) {
      const models = await findAsrModels()
      if (!models) throw Object.assign(new Error('还没有语音识别模型：第一次用要下载约 241 MB'), { status: 409, code: 'NO_MODEL' })
      if (!child) child = start(models)
      touch()
      const id = ++seq
      const p = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
      child.stdin.write(JSON.stringify({ id, file }) + '\n')
      return p
    },
    stop,
  }
}
