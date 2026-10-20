// lib/edge.js — 微软 Edge「大声朗读」的在线神经网络语音（晓晓、云希……）
//
// 不自己实现它的私有鉴权：调用开源命令行工具 edge-tts（https://github.com/rany2/edge-tts），
// 装在本插件自己的 Python 虚拟环境里（~/.dsh/dsh-audiobook/edge-tts），不碰系统 Python，删掉目录即卸载。
// 已经装了「听懂」（dsh-tingdong）的话，直接借用它装好的那一份。
//
// 自动安装（插件启动时在后台装，用户不用点）。各种机器的情况：
//   有 python3 和 venv            → python3 -m venv，pip 装 edge-tts
//   有 python3、没有 venv / pip  → python3 -m venv --without-pip，再用官方 get-pip.py 补上 pip
//                                  （Ubuntu / Debian 默认不带 python3-venv，没有 root 也装得上）
//   连 python3 都没有             → 下载 uv（单个可执行文件），由它下载一份独立的 Python 再装 edge-tts
// 注意：要联网，文字会发到微软的服务器；不是微软公开的正式接口，可能失效。

import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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

function run(cmd, args, { timeout = 300000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20, env: env ? { ...process.env, ...env } : undefined }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ')))
      resolve(String(stdout))
    })
  })
}

/** 能用的 Python 3（3.8 以上）；没有返回 null */
async function findPython() {
  const c = win ? ['py', 'python', 'python3'] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3']
  for (const p of c) {
    if (p.includes('/') && !existsSync(p)) continue
    try {
      const v = (await run(p, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 15000 })).trim()
      const [major, minor] = v.split('.').map(Number)
      if (major === 3 && minor >= 8) return p
    } catch { /* 下一个 */ }
  }
  return null
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  if (!res.ok || !res.body) throw new Error(`下载 ${url} 失败（HTTP ${res.status}）`)
  await mkdir(dirname(file), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  return file
}

const venvPython = () => join(edgeDir(), win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')

/** 有 python3：建虚拟环境，缺 pip 就用 get-pip.py 补 */
async function installWithPython(py) {
  const venvPy = venvPython()
  if (!existsSync(venvPy)) {
    await rm(edgeDir(), { recursive: true, force: true })
    try { await run(py, ['-m', 'venv', edgeDir()]) } catch {
      // Ubuntu / Debian 没装 python3-venv：先建一个不带 pip 的
      await rm(edgeDir(), { recursive: true, force: true })
      await run(py, ['-m', 'venv', '--without-pip', edgeDir()])
    }
  }
  try { await run(venvPy, ['-m', 'pip', '--version'], { timeout: 30000 }) } catch {
    const getPip = join(edgeDir(), 'get-pip.py')
    await download('https://bootstrap.pypa.io/get-pip.py', getPip)
    await run(venvPy, [getPip, '-q', '--disable-pip-version-check'])
    await rm(getPip, { force: true })
  }
  await run(venvPy, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--upgrade', 'edge-tts'])
}

/** uv 的下载包名（https://github.com/astral-sh/uv/releases） */
function uvAsset() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  if (!arch) return null
  if (process.platform === 'darwin') return `uv-${arch}-apple-darwin.tar.gz`
  if (process.platform === 'linux') return `uv-${arch}-unknown-linux-gnu.tar.gz`
  if (process.platform === 'win32' && arch === 'x86_64') return 'uv-x86_64-pc-windows-msvc.zip'
  return null
}

/** 没有 python3：下载 uv，让它下载一份独立的 Python，所有东西都放在插件自己的目录里 */
async function installWithUv() {
  const asset = uvAsset()
  if (!asset) throw new Error(`这台机器（${process.platform}/${process.arch}）上装不了 Edge 语音组件：没有 Python 3，也没有对应的 uv`)
  const uvDir = join(dataRoot(), 'uv')
  const exe = win ? 'uv.exe' : 'uv'
  let uv = [join(uvDir, exe), join(uvDir, asset.replace(/\.(tar\.gz|zip)$/, ''), exe)].find(p => existsSync(p))
  if (!uv) {
    const pkg = await download(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, join(uvDir, asset))
    await run('tar', ['-xf', pkg, '-C', uvDir])
    await rm(pkg, { force: true })
    uv = [join(uvDir, exe), join(uvDir, asset.replace(/\.(tar\.gz|zip)$/, ''), exe)].find(p => existsSync(p))
    if (!uv) throw new Error('uv 解压后找不到可执行文件')
  }
  const env = { UV_PYTHON_INSTALL_DIR: join(dataRoot(), 'python'), UV_CACHE_DIR: join(uvDir, 'cache') }
  await rm(edgeDir(), { recursive: true, force: true })
  await run(uv, ['venv', '--python', '3.12', edgeDir()], { env })
  await run(uv, ['pip', 'install', '--python', venvPython(), 'edge-tts'], { env })
}

let statusCache = null
/** 正在进行的自动安装（同一时刻只装一次） */
let installing = null
let lastError = ''

export async function edgeStatus() {
  const bin = edgeBin()
  if (!bin) return { ready: false, installing: Boolean(installing), error: lastError }
  if (statusCache && statusCache.bin === bin && Date.now() - statusCache.at < 60000) return statusCache.value
  let value
  try { value = { ready: true, version: (await run(bin, ['--version'], { timeout: 15000 })).trim().replace(/^edge-tts\s*/, '') } } catch { value = { ready: false, installing: Boolean(installing), error: lastError } }
  statusCache = { bin, at: Date.now(), value }
  return value
}

/** 装（或更新）edge-tts 到插件自己的虚拟环境 */
export function installEdge() {
  if (installing) return installing
  installing = (async () => {
    try {
      const py = await findPython()
      if (py) await installWithPython(py)
      else await installWithUv()
      lastError = ''
    } catch (e) {
      lastError = `自动安装 Edge 语音组件失败：${e.message}`
      throw Object.assign(new Error(lastError), { status: 500 })
    } finally {
      installing = null
      statusCache = null
    }
    return edgeStatus()
  })()
  return installing
}

/** 没装就装（启动时在后台调；合成时等它装完） */
export async function ensureEdge() {
  if (edgeBin()) return true
  await installEdge()
  return Boolean(edgeBin())
}

/** 读一段，存成 MP3（24 kHz 单声道）。语速交给播放器调，这里总是正常语速 */
export async function edgeSpeak(text, voice, out) {
  if (!edgeBin()) await ensureEdge()
  const bin = edgeBin()
  if (!bin) throw Object.assign(new Error('Edge 语音组件还没装好'), { status: 500 })
  // --text=…：正文以「-」开头时不会被当成命令行选项
  const args = ['--voice', voice, `--text=${text}`, '--write-media', out]
  // 网络偶尔抖一下：重试两次
  for (let attempt = 1; ; attempt++) {
    try { await run(bin, args, { timeout: 60000 }); return out } catch (e) {
      if (attempt >= 3) throw new Error(`Edge 语音失败（要联网）：${e.message}`)
      await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
}
