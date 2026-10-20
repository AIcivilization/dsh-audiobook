// lib/kokoro-worker.js — Kokoro 中文语音的常驻子进程
//
// 启动参数：argv[2] 的 JSON { dir（模型目录）, threads }
// stdin 每行一个请求 { id, text, sid, out }，按顺序合成，写 16 位单声道 WAV 到 out
// stdout 每行一个回复 { id, duration } 或 { id, error }

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const opt = JSON.parse(process.argv[2] || '{}')
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const d = opt.dir
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: {
      model: join(d, 'model.int8.onnx'), voices: join(d, 'voices.bin'), tokens: join(d, 'tokens.txt'),
      dataDir: join(d, 'espeak-ng-data'), dictDir: join(d, 'dict'),
      lexicon: [join(d, 'lexicon-us-en.txt'), join(d, 'lexicon-zh.txt')].join(','),
    },
    numThreads: opt.threads || 2, provider: 'cpu', debug: 0,
  },
  ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'].map(f => join(d, f)).join(','),
  maxNumSentences: 1,
})

/** float 样本 → 16 位 PCM 的 WAV；合成偶尔吐出 NaN，顺手夹住 */
function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40)
  for (let k = 0; k < samples.length; k++) {
    const v = Number.isFinite(samples[k]) ? Math.max(-1, Math.min(1, samples[k])) : 0
    buf.writeInt16LE(Math.round(v * 32767), 44 + k * 2)
  }
  return buf
}

for await (const line of createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  try {
    const a = tts.generate({ text: req.text, sid: req.sid, speed: 1 })
    writeFileSync(req.out, wav(a.samples, a.sampleRate))
    emit({ id: req.id, duration: a.samples.length / a.sampleRate })
  } catch (e) {
    emit({ id: req.id, error: e && e.message ? e.message : String(e) })
  }
}
