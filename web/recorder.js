// web/recorder.js — 录一段话，转成 16 kHz 单声道 16 位 WAV（服务器上的识别模型要这个格式，不用再装 ffmpeg 转码）
//
// 用 ScriptProcessor 拿原始声音：老一些的 iPhone Safari 也支持。麦克风要求 HTTPS 或本机地址。

const RATE = 16000
const MAX_SECONDS = 180

/** 线性插值降采样到 16 kHz */
function downsample(input, from) {
  if (from === RATE) return input
  const ratio = from / RATE
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio
    const k = Math.floor(p)
    const t = p - k
    out[i] = (input[k] || 0) * (1 - t) + (input[k + 1] || 0) * t
  }
  return out
}

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true)
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * 开始录音
 * @param {{ onLevel?: (level: number, seconds: number) => void, onLimit?: () => void }} [o]
 * @returns {Promise<{ stop(): Promise<{ blob: Blob, seconds: number }>, cancel(): void }>}
 */
export async function startRecording(o = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
      ? '这个浏览器不能录音' : '录音要用 HTTPS 打开面板（或在本机打开）')
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    throw new Error(e && e.name === 'NotAllowedError' ? '没有麦克风权限：在浏览器地址栏旁边允许使用麦克风' : `打不开麦克风：${e.message}`)
  }
  const AC = window.AudioContext || window.webkitAudioContext
  const ac = new AC()
  if (ac.state === 'suspended') await ac.resume()
  const src = ac.createMediaStreamSource(stream)
  const proc = ac.createScriptProcessor(4096, 1, 1)
  const chunks = []
  let total = 0
  let limited = false
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(data))
    total += data.length
    let peak = 0
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]))
    const seconds = total / ac.sampleRate
    if (o.onLevel) o.onLevel(Math.min(1, peak * 2.5), seconds)
    if (seconds >= MAX_SECONDS && !limited) { limited = true; if (o.onLimit) o.onLimit() }
  }
  src.connect(proc)
  // 有的浏览器不接到输出就不跑 onaudioprocess：接一个静音的增益节点
  const mute = ac.createGain()
  mute.gain.value = 0
  proc.connect(mute)
  mute.connect(ac.destination)

  const close = () => {
    try { proc.disconnect(); src.disconnect(); mute.disconnect() } catch { /* 已断开 */ }
    for (const t of stream.getTracks()) t.stop()
    ac.close().catch(() => {})
  }
  return {
    async stop() {
      const rate = ac.sampleRate
      close()
      const all = new Float32Array(total)
      let off = 0
      for (const c of chunks) { all.set(c, off); off += c.length }
      return { blob: wav(downsample(all, rate)), seconds: total / rate }
    },
    cancel: close,
  }
}
