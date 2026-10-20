// lib/kokoro.js — 本地离线中文语音：Kokoro v1.1-zh（sherpa-onnx），55 个普通话女声、45 个普通话男声
//
// 模型约 147 MB，第一次用时下载到 ~/.dsh/dsh-audiobook/models/；「听懂」已经下好的直接借用。
// 合成在常驻子进程里跑（lib/kokoro-worker.js）：sherpa-onnx 是同步推理，放在 DSH 主进程里会卡界面；
// 模型加载要几秒，所以子进程留着不退，空闲 5 分钟才关。

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dataRoot, tingdongRoot } from './paths.js'

const MODEL = {
  name: 'kokoro-int8-multi-lang-v1_1',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
  bytes: 147031220,
}

// speaker id：0–2 是英文声音，3–57 女声，58–102 男声
export const KOKORO_VOICES = [
  ...Array.from({ length: 55 }, (_, k) => ({ id: `f${String(k + 1).padStart(2, '0')}`, sid: 3 + k, label: `女声 ${String(k + 1).padStart(2, '0')}` })),
  ...Array.from({ length: 45 }, (_, k) => ({ id: `m${String(k + 1).padStart(2, '0')}`, sid: 58 + k, label: `男声 ${String(k + 1).padStart(2, '0')}` })),
]
export const kokoroVoice = id => KOKORO_VOICES.find(v => v.id === id)

const ownDir = () => join(dataRoot(), 'models', MODEL.name)
const complete = d => existsSync(join(d, 'model.int8.onnx')) && existsSync(join(d, 'lexicon-zh.txt')) && existsSync(join(d, 'dict'))

/** 模型目录：自己下的 > 听懂下的；都没有返回 null */
export function kokoroDir() {
  for (const d of [ownDir(), join(tingdongRoot(), 'models', MODEL.name)]) if (complete(d)) return d
  return null
}

/** 下载进度（给设置页显示）：null 表示没在下 */
export const download = { state: null }

/** 没有就下载（约 147 MB）并解压 */
export async function ensureKokoro() {
  if (kokoroDir()) return kokoroDir()
  if (download.state && download.state.running) return download.state.promise
  const state = { running: true, got: 0, total: MODEL.bytes, error: '' }
  download.state = state
  state.promise = fetchModel(state).then(
    () => { state.running = false; return kokoroDir() },
    (e) => { state.running = false; state.error = e.message; throw e },
  )
  return state.promise
}

async function fetchModel(state) {
  const root = join(dataRoot(), 'models')
  await mkdir(root, { recursive: true })
  const part = join(root, `${MODEL.name}.${process.pid}.tar.bz2`)
  try {
    const res = await fetch(MODEL.url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const meter = new Transform({ transform(c, _e, cb) { state.got += c.length; cb(null, c) } })
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part))
    if ((await stat(part)).size !== MODEL.bytes) throw new Error('文件大小不对')
    const tmpDir = join(root, `.extract-${process.pid}`)
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir)
    await new Promise((resolve, reject) => {
      const t = spawn('tar', ['-xjf', part, '-C', tmpDir], { stdio: 'ignore' })
      t.on('error', reject)
      t.on('close', code => (code === 0 ? resolve() : reject(new Error(`解压失败（${code}）`))))
    })
    await rm(ownDir(), { recursive: true, force: true })
    await rename(join(tmpDir, MODEL.name), ownDir())
    await rm(tmpDir, { recursive: true, force: true })
    if (!complete(ownDir())) throw new Error('解压出来的模型不完整')
  } catch (e) {
    throw new Error(`下载中文语音模型失败：${e.message}`)
  } finally {
    await rm(part, { force: true })
  }
}

const WORKER = fileURLToPath(new URL('./kokoro-worker.js', import.meta.url))

/** 常驻的合成子进程：speak(text, sid, out) 写一个 WAV */
export function createKokoro({ threads = 2, idleMs = 5 * 60 * 1000 } = {}) {
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

  function start(dir) {
    // Electron（DSH 桌面版）里 process.execPath 是 App 本体：ELECTRON_RUN_AS_NODE=1 让它当 Node 用
    const c = spawn(process.execPath, [WORKER, JSON.stringify({ dir, threads })], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let stderr = ''
    c.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
    createInterface({ input: c.stdout }).on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      const w = waiting.get(msg.id)
      if (!w) return
      waiting.delete(msg.id)
      if (msg.error) w.reject(new Error(`本地语音合成失败：${msg.error}`))
      else w.resolve(msg)
    })
    c.on('exit', (code) => {
      if (child === c) child = null
      for (const [id, w] of waiting) {
        w.reject(new Error(`本地语音进程退出了（${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-1)[0] : ''}`))
        waiting.delete(id)
      }
    })
    c.stdin.on('error', () => {})
    return c
  }

  return {
    async speak(text, sid, out) {
      const dir = kokoroDir()
      if (!dir) throw Object.assign(new Error('还没下载中文语音模型：在朗读设置里点「下载」'), { status: 400 })
      if (!child) child = start(dir)
      touch()
      const id = ++seq
      const p = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
      child.stdin.write(JSON.stringify({ id, text, sid, out }) + '\n')
      return p
    },
    stop,
  }
}
