// lib/edge.js — 微软 Edge「大声朗读」的在线神经网络语音（晓晓、云希……）
//
// 不自己实现它的私有鉴权：调用开源命令行工具 edge-tts（https://github.com/rany2/edge-tts），
// 装在本插件自己的 Python 虚拟环境里（~/.dsh/dsh-audiobook/edge-tts），不碰系统 Python，删掉目录即卸载。
// 已经装了「听懂」（dsh-tingdong）的话，直接借用它装好的那一份。
// 注意：要联网，文字会发到微软的服务器；不是微软公开的正式接口，可能失效。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, tingdongRoot } from './paths.js'

export const EDGE_VOICES = [
  { id: 'zh-CN-YunxiNeural', label: '云希（男 · 阳光，适合小说）', lang: 'zh' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女 · 温暖）', lang: 'zh' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男 · 激情）', lang: 'zh' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男 · 新闻播报）', lang: 'zh' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女 · 活泼）', lang: 'zh' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏（男 · 童声）', lang: 'zh' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（女 · 辽宁话）', lang: 'zh' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（女 · 陕西话）', lang: 'zh' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻（女 · 台湾）', lang: 'zh' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲（男 · 台湾）', lang: 'zh' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼（女 · 粤语）', lang: 'zh' },
  { id: 'zh-HK-WanLungNeural', label: '雲龍（男 · 粤语）', lang: 'zh' },
  { id: 'en-US-AndrewNeural', label: 'Andrew（男 · 美式，英文书）', lang: 'en' },
  { id: 'en-US-AvaNeural', label: 'Ava（女 · 美式，英文书）', lang: 'en' },
  { id: 'en-US-BrianNeural', label: 'Brian（男 · 美式，英文书）', lang: 'en' },
  { id: 'en-US-EmmaNeural', label: 'Emma（女 · 美式，英文书）', lang: 'en' },
  { id: 'en-GB-RyanNeural', label: 'Ryan（男 · 英式，英文书）', lang: 'en' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia（女 · 英式，英文书）', lang: 'en' },
]
export const isEdgeVoice = id => EDGE_VOICES.some(v => v.id === id)

export const edgeDir = () => join(dataRoot(), 'edge-tts')
const win = process.platform === 'win32'
const venvBin = (root, name) => join(root, win ? 'Scripts' : 'bin', win ? `${name}.exe` : name)

/** edge-tts 命令在哪：插件自己装的 > 听懂装的 > 系统里已有的 */
export function edgeBin() {
  for (const root of [edgeDir(), join(tingdongRoot(), 'edge-tts')]) if (existsSync(venvBin(root, 'edge-tts'))) return venvBin(root, 'edge-tts')
  for (const p of ['/opt/homebrew/bin/edge-tts', '/usr/local/bin/edge-tts', '/usr/bin/edge-tts']) if (existsSync(p)) return p
  return null
}

function run(cmd, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ')))
      resolve(String(stdout))
    })
  })
}

function findPython() {
  const c = win ? ['py', 'python', 'python3'] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3']
  return c.find(p => !p.includes('/') || existsSync(p)) || null
}

let statusCache = null
export async function edgeStatus() {
  const bin = edgeBin()
  if (!bin) return { ready: false }
  if (statusCache && statusCache.bin === bin && Date.now() - statusCache.at < 60000) return statusCache.value
  let value
  try { value = { ready: true, version: (await run(bin, ['--version'], 15000)).trim().replace(/^edge-tts\s*/, '') } } catch { value = { ready: false } }
  statusCache = { bin, at: Date.now(), value }
  return value
}

/** 装（或更新）edge-tts 到插件自己的虚拟环境 */
export async function installEdge() {
  const py = findPython()
  if (!py) throw Object.assign(new Error('没找到 Python 3：Mac 上装好 Xcode 命令行工具（xcode-select --install），Linux 上 sudo apt install python3 python3-venv'), { status: 400 })
  const venvPy = join(edgeDir(), win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
  if (!existsSync(venvPy)) {
    await rm(edgeDir(), { recursive: true, force: true })
    try { await run(py, ['-m', 'venv', edgeDir()]) } catch (e) {
      throw Object.assign(new Error(`建 Python 虚拟环境失败：${e.message}（Linux 上先 sudo apt install python3-venv）`), { status: 400 })
    }
  }
  await run(venvPy, ['-m', 'pip', 'install', '-q', '--upgrade', 'edge-tts'])
  statusCache = null
  return edgeStatus()
}

/** 读一段，存成 MP3（24 kHz 单声道）。语速交给播放器调，这里总是正常语速 */
export async function edgeSpeak(text, voice, out) {
  const bin = edgeBin()
  if (!bin) throw Object.assign(new Error('还没装 Edge 语音组件：在朗读设置里点「安装 Edge 语音组件」'), { status: 400 })
  // --text=…：正文以「-」开头时不会被当成命令行选项
  const args = ['--voice', voice, `--text=${text}`, '--write-media', out]
  // 网络偶尔抖一下：重试两次
  for (let attempt = 1; ; attempt++) {
    try { await run(bin, args, 60000); return out } catch (e) {
      if (attempt >= 3) throw new Error(`Edge 语音失败（要联网）：${e.message}`)
      await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
}
