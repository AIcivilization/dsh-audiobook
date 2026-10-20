// lib/sources.js — 去哪儿搜书、下书
//
// 只接公版书和授权免费的书源，下载的都是合法可以自由传播的书：
//   古腾堡计划（Project Gutenberg）   7 万多本公版书，英文为主，也有《紅樓夢》等中文古籍；OPDS 接口搜，下 EPUB
//   中文维基文库（zh.wikisource.org）  中文公版古籍、民国作品（如鲁迅）；用 ws-export 把整部作品导出成 EPUB
//   英文维基文库（en.wikisource.org）  同上，英文
// 受版权保护的现代书这里搜不到：请通过正规渠道买电子书后导入。
//
// 下载地址都由这里按书源和编号拼出来，不接受外部传进来的网址（防止被当成代理去访问任意地址）。

import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decodeEntities } from './extract.js'
import { uploadsDir } from './paths.js'

export const SOURCES = {
  gutenberg: { label: '古腾堡计划', home: 'https://www.gutenberg.org' },
  'wikisource-zh': { label: '中文维基文库', home: 'https://zh.wikisource.org' },
  'wikisource-en': { label: '英文维基文库', home: 'https://en.wikisource.org' },
}

const UA = 'dsh-audiobook (https://github.com/AIcivilization/dsh-audiobook)'
const MAX_BYTES = 100 * 1024 * 1024

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

async function getText(url, timeout = 10000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? decodeEntities(m[1]).trim() : ''
}

// ———————————————————— 古腾堡 ————————————————————

export function parseGutenbergOpds(xml) {
  const out = []
  for (const [entry] of String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const id = /<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/.exec(entry)
    if (!id) continue
    let title = tag(entry, 'title')
    const author = tag(entry, 'content')
    // 中文书在标题后面标着 (Chinese)
    const lang = /\(Chinese\)\s*$/.test(title) || /[㐀-鿿]/.test(title) ? 'zh' : ''
    title = title.replace(/\s*\((Chinese|English)\)\s*$/, '')
    out.push({ source: 'gutenberg', ref: id[1], title, author, lang, link: `https://www.gutenberg.org/ebooks/${id[1]}` })
  }
  return out
}

async function searchGutenberg(q) {
  const xml = await getText(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}`)
  return parseGutenbergOpds(xml)
}

// ———————————————————— 维基文库 ————————————————————

const WS_HOST = { 'wikisource-zh': 'zh.wikisource.org', 'wikisource-en': 'en.wikisource.org' }

export function parseWikisourceSearch(j, source) {
  const list = (j && j.query && j.query.search) || []
  return list
    // 子页面（「作品/第一回」）不单独列：下载整部作品时会带上
    .filter(x => !x.title.includes('/'))
    // 消歧义页不是书
    .filter(x => !/消歧[義义]|disambiguation/i.test(x.title))
    .map(x => ({
      source,
      ref: x.title,
      title: x.title,
      author: '',
      lang: source === 'wikisource-zh' ? 'zh' : 'en',
      snippet: decodeEntities(String(x.snippet || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 80),
      link: `https://${WS_HOST[source]}/wiki/${encodeURIComponent(x.title)}`,
    }))
}

async function searchWikisource(q, source) {
  const host = WS_HOST[source]
  const u = `https://${host}/w/api.php?action=query&list=search&format=json&srnamespace=0&srlimit=15&srprop=snippet&srsearch=${encodeURIComponent(`intitle:${q}`)}`
  return parseWikisourceSearch(JSON.parse(await getText(u)), source)
}

/**
 * 维基文库导出的 EPUB 里夹着导航（← 上一篇 / 下一篇 →、作者、姊妹计划）和版权说明：
 * 去掉这些，再去掉「封面」「关于」两章。作者从导航里的「作者：xxx」取。
 */
export function cleanWikisource(doc) {
  let author = doc.author || ''
  const chapters = []
  for (const ch of doc.chapters) {
    if (/^(封面|关于|關於|About this digital edition|Cover)$/i.test(String(ch.title).trim())) continue
    let lines = ch.text.split('\n')
    const head = lines.slice(0, 20)
    const a = head.find(l => /^作者[：:]/.test(l))
    if (a && !author) author = a.replace(/^作者[：:]\s*/, '').trim()
    // 导航块：到「姊妹计划」那行为止；没有的话到「→」那行为止
    let cut = head.findIndex(l => /^姊妹[计計][划劃]/.test(l))
    if (cut < 0 && head[0] === '←') cut = head.indexOf('→')
    if (cut >= 0) lines = lines.slice(cut + 1)
    lines = lines.filter(l => !/^另[參参]見/.test(l))
    // 版权说明：从结尾往前找
    const tail = lines.findIndex((l, k) => k >= lines.length - 30 && /公有領域|公有领域|^Public domain|^This work is in the public domain/.test(l))
    if (tail >= 0) lines = lines.slice(0, tail)
    const text = lines.join('\n').trim()
    if (text) chapters.push({ ...ch, text })
  }
  return { ...doc, author, chapters: chapters.length ? chapters : doc.chapters }
}

/** 古腾堡的书前后各有一段英文版权声明（「The Project Gutenberg eBook of…」「*** END OF…」「FULL LICENSE」）：不读 */
export function cleanGutenberg(doc) {
  const chapters = []
  for (const ch of doc.chapters) {
    if (/PROJECT GUTENBERG|^back$/i.test(ch.title)) {
      // 开头那章：去掉声明，留下正文（有的书第一章正文就跟在声明后面）
      const k = ch.text.indexOf('*** START OF')
      const nl = k >= 0 ? ch.text.indexOf('\n', k) : -1
      const rest = nl >= 0 ? ch.text.slice(nl + 1).trim() : ''
      if (rest && !/\*\*\* END OF/.test(rest)) chapters.push({ ...ch, title: shortLine(rest), text: rest })
      continue
    }
    const end = ch.text.indexOf('*** END OF')
    const text = (end >= 0 ? ch.text.slice(0, end) : ch.text).trim()
    if (text) chapters.push({ ...ch, text })
  }
  return { ...doc, chapters: chapters.length ? chapters : doc.chapters }
}
const shortLine = t => { const f = t.split('\n')[0]; return f.length > 24 ? f.slice(0, 22) + '…' : f }

// ———————————————————— 搜索 / 下载 ————————————————————

/**
 * 在所有书源里搜（并行；某个书源挂了不影响别的）
 * @returns {{ results: object[], failed: string[] }}
 */
export async function searchSources(q, { lang } = {}) {
  const query = String(q || '').trim().slice(0, 100)
  if (!query) throw bad('请输入要搜的书名、作者或关键词')
  const cjk = /[㐀-鿿]/.test(query)
  const jobs = [['gutenberg', () => searchGutenberg(query)]]
  if (cjk || lang === 'zh') jobs.push(['wikisource-zh', () => searchWikisource(query, 'wikisource-zh')])
  if (!cjk || lang === 'en') jobs.push(['wikisource-en', () => searchWikisource(query, 'wikisource-en')])
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()))
  const results = []
  const failed = []
  settled.forEach((r, k) => {
    if (r.status === 'fulfilled') results.push(...r.value)
    else failed.push(jobs[k][0].startsWith('wikisource')
      ? `${SOURCES[jobs[k][0]].label}（DSH 所在的网络连不上维基，中国大陆常见）`
      : SOURCES[jobs[k][0]].label)
  })
  return { results, failed }
}

async function saveTo(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(300000) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('文件太大')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  if ((await stat(file)).size < 200) throw new Error('下载到的文件是空的')
  return res.headers.get('content-type') || ''
}

/**
 * 下载一本书到临时目录
 * @returns {Promise<{ file: string, name: string }>} name：带扩展名的文件名（认格式用）
 */
export async function downloadBook(source, ref) {
  await mkdir(uploadsDir(), { recursive: true })
  const tmp = join(uploadsDir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  if (source === 'gutenberg') {
    if (!/^\d{1,7}$/.test(String(ref))) throw bad('古腾堡的书号不对')
    // 优先 EPUB（带章节目录），不行再要纯文本
    for (const [suffix, ext] of [['epub3.images', '.epub'], ['epub.noimages', '.epub'], ['txt.utf-8', '.txt']]) {
      try {
        const type = await saveTo(`https://www.gutenberg.org/ebooks/${ref}.${suffix}`, tmp + ext)
        if (/html/i.test(type)) throw new Error('不是书')
        return { file: tmp + ext, name: `gutenberg-${ref}${ext}` }
      } catch { await rm(tmp + ext, { force: true }) }
    }
    throw new Error('古腾堡上这本书下载失败，稍后再试')
  }
  if (WS_HOST[source]) {
    const title = String(ref || '')
    if (!title || title.length > 200 || /[\u0000-\u001f]/.test(title)) throw bad('维基文库的书名不对')
    const lang = source === 'wikisource-zh' ? 'zh' : 'en'
    try {
      await saveTo(`https://ws-export.wmcloud.org/?lang=${lang}&page=${encodeURIComponent(title)}&format=epub-3`, tmp + '.epub')
    } catch (e) {
      await rm(tmp + '.epub', { force: true })
      throw new Error(`从维基文库导出失败（${e.message}）：整部大书导出要一两分钟，可以稍后再试`)
    }
    return { file: tmp + '.epub', name: `${title}.epub` }
  }
  throw bad('不认识的书源')
}
