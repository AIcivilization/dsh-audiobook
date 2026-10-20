// lib/custom.js — 自定义搜索地址
//
// 两种：
//   web   网页搜索地址（百度、豆瓣读书、微信读书……）：地址里的 {q} 换成要搜的词，在浏览器里打开
//   opds  OPDS 书库（Calibre、calibre-web、Kavita 等自建书库都有）：插件去搜，结果显示在面板里，可以直接加入书架
// 存在服务器的设置里，换设备也在。

import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decodeEntities, DOC_EXT } from './extract.js'
import { uploadsDir } from './paths.js'

/** 没自定义过时给的几个：都是正规的网页，打开后用户自己看 */
export const DEFAULT_WEB = [
  { id: 'baidu', name: '百度', kind: 'web', url: 'https://www.baidu.com/s?wd={q}' },
  { id: 'bing', name: '必应', kind: 'web', url: 'https://cn.bing.com/search?q={q}' },
  { id: 'google', name: 'Google', kind: 'web', url: 'https://www.google.com/search?q={q}' },
  { id: 'douban', name: '豆瓣读书', kind: 'web', url: 'https://search.douban.com/book/subject_search?search_text={q}' },
  { id: 'weread', name: '微信读书', kind: 'web', url: 'https://weread.qq.com/web/search/global?keyword={q}' },
]

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

/** 检查、整理用户填的自定义地址（最多 20 个）；有问题直接报错，说清楚是哪一个 */
export function normalizeCustom(list) {
  if (!Array.isArray(list)) throw bad('自定义搜索地址的格式不对')
  if (list.length > 20) throw bad('自定义搜索地址最多 20 个')
  const seen = new Set()
  return list.map((x, k) => {
    const name = String((x && x.name) || '').trim().slice(0, 20)
    const url = String((x && x.url) || '').trim().slice(0, 500)
    const kind = x && x.kind === 'opds' ? 'opds' : 'web'
    if (!name) throw bad(`第 ${k + 1} 个地址没有名字`)
    let u
    try { u = new URL(url.replace('{q}', 'x')) } catch { throw bad(`「${name}」的地址不是网址`) }
    if (!/^https?:$/.test(u.protocol)) throw bad(`「${name}」只能是 http 或 https 地址`)
    if (!url.includes('{q}')) throw bad(`「${name}」的地址里要有 {q}，代表要搜的词，例如 https://www.baidu.com/s?wd={q}`)
    let id = String((x && x.id) || '').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || `c${k}`
    while (seen.has(id)) id += 'x'
    seen.add(id)
    return { id, name, url, kind }
  })
}

const fill = (template, q) => template.replace('{q}', encodeURIComponent(q))

// ———————————————————— OPDS ————————————————————

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3]) : ''
}
const text = (xml, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : ''
}

/** 下载链接的格式：能读的才要，EPUB 优先 */
const FORMAT_RANK = [[/epub/i, '.epub'], [/text\/plain|\.txt/i, '.txt'], [/pdf/i, '.pdf'], [/officedocument\.wordprocessingml|\.docx/i, '.docx'], [/markdown/i, '.md'], [/html/i, '.html']]

/** OPDS（Atom）搜索结果 → 书；每本书挑一个能读的下载链接，地址补全成绝对地址 */
export function parseOpds(xml, base, catalog) {
  const out = []
  for (const [entry] of String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map(m => ({ rel: attr(m[0], 'rel'), type: attr(m[0], 'type'), href: attr(m[0], 'href') }))
      .filter(l => /acquisition/i.test(l.rel) && l.href)
    let pick = null
    for (const [re, ext] of FORMAT_RANK) {
      const l = links.find(x => re.test(x.type) || re.test(x.href))
      if (l) { pick = { href: l.href, ext }; break }
    }
    if (!pick) continue
    let href
    try { href = new URL(pick.href, base).href } catch { continue }
    const author = [...entry.matchAll(/<author\b[\s\S]*?<\/author>/gi)].map(a => text(a[0], 'name')).filter(Boolean).join('、')
    out.push({
      source: 'opds', ref: href, catalog: catalog.id, ext: pick.ext,
      title: text(entry, 'title'), author, lang: '', sourceLabel: catalog.name, link: href,
    })
  }
  return out
}

/** 在用户的 OPDS 书库里搜（并行；某个连不上不影响别的） */
export async function searchOpds(catalogs, q) {
  const opds = catalogs.filter(c => c.kind === 'opds')
  const settled = await Promise.allSettled(opds.map(async (c) => {
    const url = fill(c.url, q)
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.5' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseOpds(await res.text(), res.url || url, c)
  }))
  const results = []
  const failed = []
  settled.forEach((r, k) => {
    if (r.status === 'fulfilled') results.push(...r.value.slice(0, 15))
    else failed.push(`${opds[k].name}（${r.reason && r.reason.message}）`)
  })
  return { results, failed }
}

/**
 * 从 OPDS 书库下载一本：只认这个书库自己域名下的地址（书库返回的链接也一样），不当成任意网址的代理
 * @returns {Promise<{ file: string, name: string }>}
 */
export async function downloadOpds(catalog, href, title) {
  if (!catalog || catalog.kind !== 'opds') throw bad('没有这个 OPDS 书库')
  let u
  try { u = new URL(href) } catch { throw bad('下载地址不对') }
  const home = new URL(catalog.url.replace('{q}', 'x'))
  if (!/^https?:$/.test(u.protocol) || u.host !== home.host) throw bad('只能下载这个书库自己的书')
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(300000) })
  if (!res.ok || !res.body) throw new Error(`从「${catalog.name}」下载失败（HTTP ${res.status}）`)
  // 扩展名：响应头里的文件名 > 链接里的扩展名 > 内容类型
  const cd = res.headers.get('content-disposition') || ''
  const fname = decodeURIComponent((/filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd) || [])[1] || '')
  const type = res.headers.get('content-type') || ''
  let ext = extname(fname).toLowerCase()
  if (!DOC_EXT.includes(ext)) ext = extname(u.pathname).toLowerCase()
  if (!DOC_EXT.includes(ext)) ext = (FORMAT_RANK.find(([re]) => re.test(type)) || [null, ''])[1]
  if (!DOC_EXT.includes(ext)) throw new Error(`「${catalog.name}」给的不是能读的格式（${type || '未知'}）`)
  await mkdir(uploadsDir(), { recursive: true })
  const file = join(uploadsDir(), `opds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
    if ((await stat(file)).size < 100) throw new Error('下载到的文件是空的')
  } catch (e) {
    await rm(file, { force: true })
    throw e
  }
  return { file, name: (fname && DOC_EXT.includes(extname(fname).toLowerCase()) ? fname : `${title || 'book'}${ext}`) }
}
