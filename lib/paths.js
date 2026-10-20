// lib/paths.js — 数据放哪、外部程序在哪
//
// 书都在 ~/.dsh/dsh-audiobook/books/<id>/ 下：book.json（书名、目录）、text.json（切好的朗读段落）、
// progress.json（听到第几段）。合成好的声音缓存在 cache/ 下，可以随时删。
// 环境变量 DSH_AUDIOBOOK_HOME 可以换位置（测试用）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function dataRoot() {
  return process.env.DSH_AUDIOBOOK_HOME || join(homedir(), '.dsh', 'dsh-audiobook')
}

export const booksDir = () => join(dataRoot(), 'books')
export const bookDir = id => join(booksDir(), id)
export const uploadsDir = () => join(dataRoot(), 'uploads')
export const cacheDir = () => join(dataRoot(), 'cache')
export const settingsPath = () => join(dataRoot(), 'settings.json')

/** 听懂（dsh-tingdong）的数据目录：它下好的 Kokoro 中文模型、装好的 Edge 语音组件可以直接借用 */
export const tingdongRoot = () => process.env.DSH_TINGDONG_HOME || join(homedir(), '.dsh', 'dsh-tingdong')

/** 书的 id：只允许字母数字和 -，防止路径穿越 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

/**
 * 找 ffmpeg（可选：有就把本地合成的声音压成 MP3，没有就直接给 WAV）。
 * DSH 桌面版从 Dock 启动时 PATH 很短（没有 /opt/homebrew/bin），所以常见位置要自己找。
 */
export function findFfmpeg(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const dir of String(process.env.PATH || '').split(delimiter)) if (dir) candidates.push(join(dir, exe))
  candidates.push(
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    join(homedir(), 'bin', 'ffmpeg'),
    join(homedir(), '.local', 'bin', 'ffmpeg'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  )
  return candidates.find(p => existsSync(p)) || null
}
