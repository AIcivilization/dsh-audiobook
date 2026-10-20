// lib/asr-worker.js — 语音识别的常驻子进程：Silero VAD 切句 → SenseVoice 识别
//
// 启动参数：argv[2] 的 JSON { models: {model, tokens, vad}, threads }
// stdin 每行一个请求 { id, file }：file 是 16 kHz 单声道 16 位 WAV（浏览器录好、转好的）
// stdout 每行一个回复 { id, text } 或 { id, error }

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const RATE = 16000
const WINDOW = 512
const opt = JSON.parse(process.argv[2] || '{}')
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: {
    // 语言自动判断（中文、英文、粤语、日语、韩语），带标点和数字规整
    senseVoice: { model: opt.models.model, language: 'auto', useInverseTextNormalization: 1 },
    tokens: opt.models.tokens, numThreads: opt.threads || 2, provider: 'cpu', debug: 0,
  },
})

/** 16 位 PCM WAV → float（逐块找 fmt 和 data） */
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV')
  let off = 12
  let rate = RATE
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12)
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2)
      const out = new Float32Array(n)
      for (let k = 0; k < n; k++) out[k] = buf.readInt16LE(off + 8 + k * 2) / 32768
      if (rate !== RATE) throw new Error(`采样率要 16000，收到 ${rate}`)
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV 里没有声音数据')
}

/** 一句一句识别再拼起来：中文直接接，西文之间补空格 */
function transcribe(samples) {
  const vad = new sherpa.Vad({
    sileroVad: { model: opt.models.vad, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.2, maxSpeechDuration: 20, windowSize: WINDOW },
    sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0,
  }, 30)
  const parts = []
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: RATE, samples: seg.samples })
      recognizer.decode(stream)
      const t = recognizer.getResult(stream).text.trim()
      if (t) parts.push(t)
      vad.pop()
    }
  }
  let i = 0
  for (; i + WINDOW <= samples.length; i += WINDOW) {
    vad.acceptWaveform(samples.slice(i, i + WINDOW))
    drain()
  }
  if (i < samples.length) vad.acceptWaveform(samples.slice(i))
  vad.flush()
  drain()
  return parts.reduce((a, t) => (!a ? t : /[A-Za-z0-9,.!?]$/.test(a) && /^[A-Za-z0-9]/.test(t) ? `${a} ${t}` : a + t), '')
}

for await (const line of createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  try {
    emit({ id: req.id, text: transcribe(readWav(readFileSync(req.file))) })
  } catch (e) {
    emit({ id: req.id, error: e && e.message ? e.message : String(e) })
  }
}
