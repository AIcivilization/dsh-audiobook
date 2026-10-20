// lib/sources.js — 去哪儿搜书、下书
//
// 只接公版书和授权免费的书源，下载的都是合法可以自由传播的书：
//   古腾堡计划（Project Gutenberg）   7 万多本公版书，英文为主，也有《紅樓夢》等中文古籍；OPDS 接口搜，下 EPUB
//   中文维基文库（zh.wikisource.org）  中文公版古籍、民国作品（如鲁迅）；用 ws-export 把整部作品导出成 EPUB
//   英文维基文库（en.wikisource.org）  同上，英文
//   Internet Archive（archive.org）     只要标了公有领域或 CC 授权、而且有文字版（EPUB / TXT / 扫描识别的文字）的书；
//                                      没标授权的（借阅图书馆、用户随手上传的）一律不要
//   Standard Ebooks                    精校排版的英文公版书（CC0）
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
  archive: { label: 'Internet Archive', home: 'https://archive.org' },
  standardebooks: { label: 'Standard Ebooks', home: 'https://standardebooks.org' },
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

const LANGS = { Chinese: '中文', English: '英文', German: '德语', French: '法语', Spanish: '西班牙语', Italian: '意大利语', Dutch: '荷兰语', Finnish: '芬兰语', Portuguese: '葡萄牙语', Russian: '俄语', Swedish: '瑞典语', Danish: '丹麦语', Norwegian: '挪威语', Latin: '拉丁语', Greek: '希腊语', Japanese: '日语', Esperanto: '世界语', Polish: '波兰语', Hungarian: '匈牙利语', Czech: '捷克语', Tagalog: '他加禄语', Catalan: '加泰罗尼亚语', Welsh: '威尔士语', Hebrew: '希伯来语' }

export function parseGutenbergOpds(xml) {
  const out = []
  for (const [entry] of String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const id = /<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/.exec(entry)
    if (!id) continue
    let title = tag(entry, 'title')
    const author = tag(entry, 'content')
    // 非英文的书在标题后面标着语言：(Chinese)、(German)……
    const m = /\s*\(([A-Z][a-z]+)\)\s*$/.exec(title)
    const langName = m && LANGS[m[1]] ? m[1] : ''
    if (langName) title = title.slice(0, m.index)
    const lang = langName === 'Chinese' || /[\u3400-\u9fff]/.test(title) ? 'zh' : ''
    out.push({
      source: 'gutenberg', ref: id[1], title, author, lang,
      snippet: langName && langName !== 'Chinese' && langName !== 'English' ? `${LANGS[langName]}版` : '',
      link: `https://www.gutenberg.org/ebooks/${id[1]}`,
    })
  }
  return out
}

async function searchGutenberg(q) {
  const xml = await getText(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}`)
  return parseGutenbergOpds(xml)
}

// ———————————————————— Internet Archive ————————————————————

/** 搜索语法里有特殊含义的字符去掉，只留词 */
const iaTerms = q => String(q).replace(/[()"':\[\]{}^~*?\\/!&|+-]/g, ' ').replace(/\s+/g, ' ').trim()

export function parseArchiveSearch(j) {
  return ((j && j.response && j.response.docs) || []).map((d) => {
    const formats = Array.isArray(d.format) ? d.format : [d.format].filter(Boolean)
    const creator = Array.isArray(d.creator) ? d.creator.join('、') : String(d.creator || '')
    const title = Array.isArray(d.title) ? d.title[0] : String(d.title || '')
    // 有扫描件（PDF / DjVu）又没有现成文本的，文字是扫描识别出来的，可能有错字
    const scan = !formats.includes('Text') && formats.some(f => /Text PDF|DjVu$/.test(f))
    const lang = [].concat(d.language || []).join(' ')
    return {
      source: 'archive', ref: d.identifier, title, author: creator,
      lang: /chi|zho|zh/i.test(lang) ? 'zh' : '',
      scan,
      snippet: scan ? '扫描版，文字是识别出来的，可能有错字' : '',
      link: `https://archive.org/details/${d.identifier}`,
    }
  }).filter(r => r.ref && r.title)
}

async function searchArchive(q) {
  const t = iaTerms(q)
  if (!t) return []
  const query = `(title:(${t}) OR creator:(${t})) AND mediatype:texts AND licenseurl:* AND format:(EPUB OR Text OR DjVuTXT)` +
    ' AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary)'
  const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=format&fl[]=language&rows=20&output=json`
  return parseArchiveSearch(JSON.parse(await getText(u)))
}

/** 挑一个文字文件：EPUB（带章节）> 上传的 TXT > 扫描识别的 TXT */
export function pickArchiveFile(files) {
  const ok = (files || []).filter(f => f.private !== 'true' && f.private !== true && f.name)
  const epub = ok.find(f => f.format === 'EPUB' || /\.epub$/i.test(f.name))
  if (epub) return { name: epub.name, ext: '.epub' }
  const txt = ok.find(f => f.format === 'Text' && /\.txt$/i.test(f.name) && !/_djvu\.txt$/i.test(f.name))
  if (txt) return { name: txt.name, ext: '.txt' }
  const djvu = ok.find(f => f.format === 'DjVuTXT' || /_djvu\.txt$/i.test(f.name))
  if (djvu) return { name: djvu.name, ext: '.txt' }
  return null
}

// ———————————————————— Standard Ebooks ————————————————————

export function parseStandardEbooks(html) {
  const out = []
  for (const m of String(html).matchAll(/<li typeof="schema:Book"[^>]*about="\/ebooks\/([a-z0-9-]+(?:\/[a-z0-9-]+){1,3})"[\s\S]*?<\/li>/g)) {
    const names = [...m[0].matchAll(/property="schema:name"[^>]*>([^<]*)</g)].map(x => decodeEntities(x[1]).trim())
    if (!names[0]) continue
    out.push({
      source: 'standardebooks', ref: m[1], title: names[0], author: names.slice(1).join('、'), lang: '',
      link: `https://standardebooks.org/ebooks/${m[1]}`,
    })
  }
  return out
}

async function searchStandardEbooks(q) {
  return parseStandardEbooks(await getText(`https://standardebooks.org/ebooks?query=${encodeURIComponent(q)}&per-page=24`))
}

/** Standard Ebooks 的书前后有书名页、版权页（Imprint / Colophon / Uncopyright）：不读 */
export function cleanStandardEbooks(doc) {
  const chapters = doc.chapters.filter(c => !/^(Titlepage|Imprint|Colophon|Uncopyright|Endnotes|Table of Contents|Contents)$/i.test(String(c.title).trim()))
  return { ...doc, chapters: chapters.length ? chapters : doc.chapters }
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

/**
 * 古腾堡的书前后各有一段英文声明：「*** START OF THE PROJECT GUTENBERG EBOOK …」之前、「*** END OF …」之后都不读。
 * 按正文里的标记切，不管它落在哪一章（EPUB、TXT、Internet Archive 上转存的都一样）。
 */
const PG_START = /\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n?/i
// 老一些的书结尾只写「End of the Project Gutenberg EBook of …」，没有星号
const PG_END = /\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG|^[ \t]*End of (?:the )?Project Gutenberg'?s? (?:E-?Book|Etext)/im
export function cleanGutenberg(doc) {
  let chapters = doc.chapters.map(c => ({ ...c }))
  const s = chapters.findIndex(c => PG_START.test(c.text))
  if (s >= 0) {
    const c = chapters[s]
    const m = PG_START.exec(c.text)
    // 紧跟着的「Produced by …」是制作者署名，也不读
    c.text = c.text.slice(m.index + m[0].length).trim().replace(/^(?:Produced by|Transcribed from)[^\n]*(?:\n|$)/i, '').trim()
    // 声明那一章原来的标题（「The Project Gutenberg eBook of …」「X, by Y」）换成正文第一行
    if (/gutenberg|,\s*by\s/i.test(c.title) && c.text) c.title = shortLine(c.text)
    chapters = chapters.slice(s)
  }
  const e = chapters.findIndex(c => PG_END.test(c.text))
  if (e >= 0) {
    chapters[e].text = chapters[e].text.slice(0, PG_END.exec(chapters[e].text).index).trim()
    chapters = chapters.slice(0, e + 1)
  }
  chapters = chapters.filter(c => c.text && !/PROJECT GUTENBERG|^back$/i.test(c.title))
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
  const jobs = [['gutenberg', () => searchGutenberg(query)], ['archive', () => searchArchive(query)]]
  if (!cjk) jobs.push(['standardebooks', () => searchStandardEbooks(query)])
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
  if (source === 'archive') {
    const id = String(ref || '')
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw bad('Internet Archive 的编号不对')
    const meta = JSON.parse(await getText(`https://archive.org/metadata/${id}`, 20000))
    const lic = String((meta.metadata && meta.metadata.licenseurl) || '')
    if (!lic) throw bad('这本书没有标明公有领域或开放授权，不下载')
    const f = pickArchiveFile(meta.files)
    if (!f) throw new Error('这本书在 Internet Archive 上没有文字版（只有扫描图片），读不了')
    try {
      await saveTo(`https://archive.org/download/${id}/${f.name.split('/').map(encodeURIComponent).join('/')}`, tmp + f.ext)
    } catch (e) {
      await rm(tmp + f.ext, { force: true })
      throw new Error(`从 Internet Archive 下载失败（${e.message}）`)
    }
    return { file: tmp + f.ext, name: `${id}${f.ext}` }
  }
  if (source === 'standardebooks') {
    const path = String(ref || '')
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+){1,3}$/.test(path)) throw bad('Standard Ebooks 的书名不对')
    try {
      await saveTo(`https://standardebooks.org/ebooks/${path}/downloads/${path.replace(/\//g, '_')}.epub?source=download`, tmp + '.epub')
    } catch (e) {
      await rm(tmp + '.epub', { force: true })
      throw new Error(`从 Standard Ebooks 下载失败（${e.message}）`)
    }
    return { file: tmp + '.epub', name: `${path.replace(/\//g, '_')}.epub` }
  }
  throw bad('不认识的书源')
}
