// lib/targets.js — 心得可以导入到哪儿：自动发现，找到几个就给几个「导入到 xxx」
//
//   DSH 插件   在 DSH 的工具注册表里找「能写笔记 / 知识库 / 记忆 / 日记」的工具（名字或说明里带这些词、
//              说明里有保存 / 添加 / 写入，而且有一个文字参数），调它把心得写进去
//   起居注     当前 DSH profile 里装了 dsh-memex（看 profile 的插件清单，不看文件夹在不在：卸了插件文件夹还会留着）：
//              写一份 Markdown 到它的日记目录（配置里的 outputDir，默认 ~/.dsh/memex）下的「读书心得」文件夹
//   Obsidian   DSH 所在的机器上有 Obsidian 库：写到库里的「读书心得」文件夹
//   Logseq     有 Logseq 图谱：写成 pages 下的一页
//   备忘录     Mac 上：写进「备忘录」App（第一次会弹出授权）
// 心得默认只存在插件里；导入是用户点了才做，每次导入覆盖同一本书上次导入的那份。

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const WORDS = /(note|memo|memory|knowledge|\bkb\b|journal|diary|notion|obsidian|logseq|wiki|bookmark|笔记|备忘|知识库|记忆|日记|收藏|文档库)/i
const WRITES = /(save|add|create|write|append|store|record|insert|put|新建|保存|添加|写入|记录|存入|存到|追加|创建)/i
const CONTENT_KEYS = ['content', 'markdown', 'text', 'body', 'note', 'memo', 'value', 'data']
const TITLE_KEYS = ['title', 'name', 'subject', 'heading']

/** 一个工具像不像「存笔记」的：返回 { content, title } 参数名，不像返回 null */
export function sinkFields(schema) {
  if (!schema || !schema.name || /^audiobook_/.test(schema.name)) return null
  const desc = `${schema.name} ${schema.description || ''}`
  if (!WORDS.test(desc) || !WRITES.test(desc)) return null
  const props = (schema.parameters && schema.parameters.properties) || {}
  const required = (schema.parameters && schema.parameters.required) || []
  const strings = Object.keys(props).filter(k => props[k] && props[k].type === 'string' && !props[k].enum)
  const content = CONTENT_KEYS.map(k => strings.find(s => s.toLowerCase() === k)).find(Boolean)
  if (!content) return null
  // 除了正文和标题，还有别的必填参数的，填不了，不用
  const title = TITLE_KEYS.map(k => strings.find(s => s.toLowerCase() === k)).find(Boolean)
  if (required.some(r => r !== content && r !== title)) return null
  return { content, title: title || '' }
}

function obsidianVaults() {
  const cfg = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json')
    : process.platform === 'win32' ? join(process.env.APPDATA || '', 'obsidian', 'obsidian.json') : join(homedir(), '.config', 'obsidian', 'obsidian.json')
  try {
    const j = JSON.parse(readFileSync(cfg, 'utf8'))
    return Object.values(j.vaults || {}).map(v => v.path).filter(p => p && existsSync(p))
  } catch { return [] }
}

function logseqGraphs() {
  const dir = join(homedir(), '.logseq', 'graphs')
  try {
    // 文件名像 logseq_local_++Users++me++notes.transit：++ 是路径分隔
    return readdirSync(dir).map(f => /^logseq_local_(.+)\.transit$/.exec(f)).filter(Boolean)
      .map(m => m[1].replace(/\+\+/g, '/')).filter(p => existsSync(p))
  } catch { return [] }
}

const expandHome = p => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/**
 * 当前 profile 的插件：读 ~/.dsh/profiles/<profile>/package.json 里登记的插件包，
 * 和 cordis.patch.yml 里给 dsh-memex 配的日记目录。拿不到（独立运行）返回 null。
 */
export function profilePlugins(profile) {
  if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile)) return null
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile)
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const deps = Object.keys(pkg.dependencies || {})
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || deps
    const names = deps.filter(d => bundles.includes(d))
    let memexDir = ''
    try {
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      const m = /dsh-memex[\s\S]*?outputDir:\s*["']?([^"'\n#]+)/.exec(patch)
      if (m) memexDir = expandHome(m[1].trim())
    } catch { /* 没有配置文件 */ }
    return { names, memexDir }
  } catch { return null }
}

const memexDir = plugins => (plugins && plugins.memexDir) || join(homedir(), '.dsh', 'memex')
const hasMemex = plugins => Boolean(plugins && plugins.names.includes('dsh-memex'))
const safeName = s => String(s || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名'

/**
 * 找能导入的地方
 * @param {{ tools?: any, plugins?: {names: string[], memexDir: string}|null }} o
 *   tools：DSH 的工具注册表；plugins：当前 profile 装了哪些插件（profilePlugins 的结果）。独立运行时都没有
 * @returns {{ id: string, label: string, detail: string }[]}
 */
export function detectTargets({ tools, plugins } = {}) {
  const out = []
  try {
    const schemas = tools && typeof tools.schemas === 'function' ? tools.schemas() : []
    for (const s of schemas) {
      const f = sinkFields(s)
      if (f) out.push({ id: `tool:${s.name}`, label: s.name, detail: String(s.description || '').slice(0, 60) })
    }
  } catch { /* 拿不到工具列表就算了 */ }
  if (hasMemex(plugins)) out.push({ id: 'memex', label: '起居注（dsh-memex）', detail: join(memexDir(plugins), '读书心得') })
  for (const v of obsidianVaults()) out.push({ id: `obsidian:${v}`, label: `Obsidian：${basename(v)}`, detail: join(v, '读书心得') })
  for (const g of logseqGraphs()) out.push({ id: `logseq:${g}`, label: `Logseq：${basename(g)}`, detail: join(g, 'pages') })
  if (process.platform === 'darwin' && existsSync('/System/Applications/Notes.app')) out.push({ id: 'applenotes', label: '备忘录', detail: 'Mac 的「备忘录」App，第一次会弹出授权' })
  return out
}

function osascript(script, args) {
  return new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 30000 },
    (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve())))
}

/**
 * 导入：title 是笔记标题，markdown 是正文
 * @returns {Promise<string>} 一句人话：导到哪儿了
 */
export async function sendTo(targetId, { title, markdown, html }, { tools, plugins } = {}) {
  const target = detectTargets({ tools, plugins }).find(t => t.id === targetId)
  if (!target) throw Object.assign(new Error('找不到这个导入位置（可能插件已经卸了）'), { status: 400 })
  const file = `${safeName(title)}.md`
  if (targetId.startsWith('tool:')) {
    const name = targetId.slice(5)
    const def = tools.get(name)
    const f = sinkFields(tools.schemas().find(s => s.name === name))
    if (!def || typeof def.execute !== 'function' || !f) throw new Error(`工具 ${name} 用不了了`)
    await def.execute({ [f.content]: markdown, ...(f.title ? { [f.title]: title } : {}) }, { signal: AbortSignal.timeout(60000) })
    return `已交给 ${name}`
  }
  if (targetId === 'memex' || targetId.startsWith('obsidian:')) {
    const dir = targetId === 'memex' ? join(memexDir(plugins), '读书心得') : join(targetId.slice(9), '读书心得')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), markdown, 'utf8')
    return `已写到 ${join(dir, file)}`
  }
  if (targetId.startsWith('logseq:')) {
    const dir = join(targetId.slice(7), 'pages')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), markdown, 'utf8')
    return `已写到 ${join(dir, file)}`
  }
  if (targetId === 'applenotes') {
    // 同名笔记已有就更新，没有就新建；正文用 HTML（备忘录认 HTML）
    await osascript(`on run argv
  set t to item 1 of argv
  set b to item 2 of argv
  tell application "Notes"
    set found to (every note whose name is t)
    if (count of found) > 0 then
      set body of item 1 of found to b
    else
      make new note with properties {name:t, body:b}
    end if
  end tell
end run`, [title, html])
    return '已写进「备忘录」'
  }
  throw new Error('不认识的导入位置')
}
