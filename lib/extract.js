// lib/extract.js — 从文档里取出书名、作者和按章的正文
//
//   TXT / 文本     自动认编码：UTF-8、UTF-16、GB18030（GBK）、Big5
//   Markdown       # 标题当章节，去掉链接、图片、强调这些标记
//   HTML           去标签，块级元素换行
//   EPUB           按书脊（spine）顺序读每个 XHTML，目录（nav / NCX）里的标题当章名
//   DOCX           word/document.xml 的段落，标题样式当章节
//   PDF            unpdf（pdf.js）取文字，再把版面折行接回段落；扫描版 PDF 没有文字层，取不出来
//   RTF / DOC      macOS 自带的 textutil 转成文本
//
// 返回 { title, author, format, chapters: [{ title, text }] }，text 里一行一个段落。

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import { openZip } from './zip.js'
import { paragraphs, splitChapters, unwrapHardWrapped, unwrapLines } from './segment.js'

export const DOC_EXT = ['.txt', '.text', '.md', '.markdown', '.html', '.htm', '.xhtml', '.epub', '.docx', '.pdf', '.rtf', '.doc']

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

/** 文件名 → 书名：去扩展名、下划线变空格，去掉常见的下载站后缀 */
export function titleFromFile(file) {
  return basename(file, extname(file))
    .replace(/[_]+/g, ' ')
    .replace(/\s*--\s*.*$/, '')
    .replace(/\s+/g, ' ')
    .trim() || '未命名'
}

// ———————————————————— 编码 ————————————————————

// 最常用的一批汉字：用来判断按哪种编码解出来的字更像中文
const COMMON = new Set('的一是不了人我在有他这中大来上个们到说时地也子就道要出会可以你对生能而那得于着下自之年过发后作里用如家多去心学么然看起想天成都把好还事没为样见点只又')

function cjkScore(text) {
  let good = 0, bad = 0
  for (const ch of text.slice(0, 20000)) {
    if (COMMON.has(ch)) good++
    else if (ch === '�') bad += 5
  }
  return good - bad
}

/** 认编码：BOM > 严格 UTF-8 > GB18030 / Big5 里更像中文的那个 */
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { /* 不是 UTF-8 */ }
  const cands = ['gb18030', 'big5'].map(enc => {
    try { const t = new TextDecoder(enc).decode(buf); return { t, s: cjkScore(t) } } catch { return null }
  }).filter(Boolean)
  cands.sort((a, b) => b.s - a.s)
  return cands.length ? cands[0].t : buf.toString('utf8')
}

// ———————————————————— HTML / XML ————————————————————

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•', emsp: ' ', ensp: ' ', thinsp: ' ', copy: '©', reg: '®' }

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try { return String.fromCodePoint(n) } catch { return m }
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const BLOCK = 'p|div|br|h[1-6]|li|tr|blockquote|section|article|header|footer|pre|dd|dt|figcaption|table|ul|ol|hr'

/** HTML → 一行一段的纯文本 */
export function htmlToText(html) {
  return decodeEntities(String(html)
    // 源码里的换行、缩进只是排版，不是分段：先压成空格（<pre> 里的除外）
    .replace(/(<pre\b[\s\S]*?<\/pre>)|[\r\n\t ]+/gi, (m, pre) => pre || ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|svg|math|nav)\b[\s\S]*?<\/\1>/gi, '')
    // 注音（ruby）只留正文
    .replace(/<(rt|rp)\b[\s\S]*?<\/\1>/gi, '')
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ''))
}

/** HTML 里的第一个 h1–h3（章名的后备来源） */
function firstHeading(html) {
  const m = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(html)
  return m ? paragraphs(htmlToText(m[2])).join(' ').slice(0, 80) : ''
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[2] ?? m[3]) : ''
}
const tagText = (xml, tag) => {
  const m = new RegExp(`<(?:[a-z]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z]+:)?${tag}>`, 'i').exec(xml)
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : ''
}

// ———————————————————— EPUB ————————————————————

function resolveHref(base, href) {
  const clean = decodeURIComponent(String(href).split('#')[0])
  return posix.normalize(posix.join(posix.dirname(base), clean)).replace(/^\/+/, '')
}
const fragOf = href => { const k = String(href).indexOf('#'); return k >= 0 ? decodeURIComponent(String(href).slice(k + 1)) : '' }

/**
 * 目录：按顺序的 [{ path, frag, title }]（EPUB 3 的 nav.xhtml 优先，其次 EPUB 2 的 toc.ncx）。
 * frag 是文件内的锚点：古腾堡这类书一个文件里装着很多章，靠锚点才分得开。
 */
function readToc(zip, manifest, opf) {
  const toc = []
  const push = (base, href, title) => {
    if (!href || !title) return
    const path = resolveHref(base, href)
    const frag = fragOf(href)
    if (!toc.some(e => e.path === path && e.frag === frag)) toc.push({ path, frag, title })
  }
  const navItem = [...manifest.values()].find(it => /\bnav\b/.test(it.properties || ''))
  if (navItem) {
    const html = zip.text(navItem.path) || ''
    const nav = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i.exec(html)
    for (const m of (nav ? nav[1] : html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      push(navItem.path, attr(m[1], 'href'), paragraphs(htmlToText(m[2])).join(' '))
    }
  }
  if (!toc.length) {
    const tocId = attr(/<spine\b[^>]*>/i.exec(opf)?.[0] || '', 'toc')
    const ncx = (tocId && manifest.get(tocId)) || [...manifest.values()].find(it => /ncx/.test(it.type))
    const xml = ncx ? zip.text(ncx.path) || '' : ''
    for (const m of xml.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)\/?>/gi)) {
      push(ncx.path, attr(m[2], 'src'), decodeEntities(m[1]).trim())
    }
  }
  return toc
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const shortTitle = text => { const first = text.split('\n')[0]; return first.length > 24 ? first.slice(0, 22) + '…' : first }

/**
 * 一个 XHTML 文件 → 一章或几章：目录里指向这个文件的锚点，各自开一章
 * @param {{frag: string, title: string}[]} entries 目录里指向这个文件的条目（按目录顺序）
 */
function splitByAnchors(html, entries) {
  const cuts = []
  for (const e of entries) {
    if (!e.frag) continue
    const m = new RegExp(`\\b(?:id|name)\\s*=\\s*["']${escRe(e.frag)}["']`).exec(html)
    if (!m) continue
    // 从锚点所在标签的开头切
    cuts.push({ at: html.lastIndexOf('<', m.index), title: e.title })
  }
  cuts.sort((a, b) => a.at - b.at)
  const whole = entries.find(e => !e.frag)
  const out = []
  const piece = (from, to, title) => {
    const text = paragraphs(htmlToText(html.slice(from, to))).join('\n')
    if (text) out.push({ title, text })
  }
  // 第一个锚点之前的部分（标题页、序……）
  const head = cuts.length ? cuts[0].at : html.length
  const headText = paragraphs(htmlToText(html.slice(0, head))).join('\n')
  if (headText) out.push({ title: (whole && whole.title) || firstHeading(html.slice(0, head)) || shortTitle(headText), text: headText })
  cuts.forEach((c, k) => piece(c.at, k + 1 < cuts.length ? cuts[k + 1].at : html.length, c.title))
  return out
}

export function extractEpub(buf) {
  const zip = openZip(buf)
  const container = zip.text('META-INF/container.xml')
  const opfPath = container ? attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] || '', 'full-path') : zip.names.find(n => n.endsWith('.opf'))
  const opf = opfPath && zip.text(opfPath)
  if (!opf) throw bad('EPUB 里找不到 OPF 文件，可能已损坏')
  const manifest = new Map()
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id')
    if (id) manifest.set(id, { path: resolveHref(opfPath, attr(m[0], 'href')), type: attr(m[0], 'media-type'), properties: attr(m[0], 'properties') })
  }
  const toc = readToc(zip, manifest, opf)
  const chapters = []
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const it = manifest.get(attr(m[0], 'idref'))
    if (!it || !/x?html/.test(it.type || 'html') || /\bnav\b/.test(it.properties || '')) continue
    const html = zip.text(it.path)
    if (!html) continue
    // 目录里没有的部分（扉页、篇章页）：用标题，没有标题就用第一行，比「第 11 章」这种编号好认
    chapters.push(...splitByAnchors(html, toc.filter(e => e.path === it.path)))
  }
  if (!chapters.length) throw bad('EPUB 里没有可读的文字（可能是纯图片的漫画，或有 DRM 加密）')
  return { title: tagText(opf, 'title'), author: tagText(opf, 'creator'), chapters: resplit(chapters) }
}

/** 目录太粗（一个文件装着几十回）：大块里认得出「第X回」「Chapter N」这类标题的，再按标题切开 */
function resplit(chapters) {
  return chapters.flatMap((ch) => {
    if (ch.text.length < 15000) return [ch]
    const parts = splitChapters(ch.text)
    const real = parts.filter(p => !/^(第 \d+ 部分|全文|开头)$/.test(p.title))
    return real.length >= 2 ? parts.map(p => (p.title === '开头' ? { ...p, title: ch.title } : p)) : [ch]
  })
}

// ———————————————————— DOCX ————————————————————

export function extractDocx(buf) {
  const zip = openZip(buf)
  const xml = zip.text('word/document.xml')
  if (!xml) throw bad('不是 Word 文档（找不到 word/document.xml）')
  const core = zip.text('docProps/core.xml') || ''
  const chapters = []
  let cur = { title: '', text: [] }
  for (const m of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = m[1]
    const text = decodeEntities(body
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_x, t) => t ?? '')).trim()
    if (!text) continue
    const style = attr(/<w:pStyle\b[^>]*>/.exec(body)?.[0] || '', 'w:val')
    if (/^(heading|标题)\s*[12]$|^[12]$|^title$/i.test(style) && text.length <= 80) {
      if (cur.text.length) chapters.push({ title: cur.title, text: cur.text.join('\n') })
      cur = { title: text, text: [text] }
    } else cur.text.push(text)
  }
  if (cur.text.length) chapters.push({ title: cur.title, text: cur.text.join('\n') })
  // 没用标题样式的文档：退回按文字认章节
  const flat = chapters.length <= 1 ? splitChapters(chapters.map(c => c.text).join('\n')) : chapters
  return { title: tagText(core, 'title'), author: tagText(core, 'creator'), chapters: flat }
}

// ———————————————————— Markdown ————————————————————

export function extractMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front matter
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
  const chapters = []
  let cur = { title: '', text: [] }
  let docTitle = ''
  for (const raw of lines) {
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw)
    const line = (h ? h[2] : raw)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^\s*>\s?/, '')
      .trim()
    if (h && h[1].length === 1 && !docTitle) docTitle = line
    if (h && line) {
      if (cur.text.length) chapters.push({ title: cur.title, text: cur.text.join('\n') })
      cur = { title: line, text: [line] }
    } else if (line && !/^[-*_]{3,}$/.test(line)) cur.text.push(decodeEntities(line))
  }
  if (cur.text.length) chapters.push({ title: cur.title, text: cur.text.join('\n') })
  return { title: docTitle, author: '', chapters: chapters.length > 1 ? chapters : splitChapters(chapters.map(c => c.text).join('\n')) }
}

// ———————————————————— PDF / RTF ————————————————————

async function extractPdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: false })
  let meta = {}
  try { meta = (await pdf.getMetadata()).info || {} } catch { /* 没有元数据 */ }
  const all = (Array.isArray(text) ? text : [text]).join('\n')
  if (all.replace(/\s/g, '').length < 20) throw bad('这个 PDF 里没有文字层（多半是扫描版），暂时读不了')
  return { title: String(meta.Title || '').trim(), author: String(meta.Author || '').trim(), chapters: splitChapters(unwrapLines(all)) }
}

function textutil(file) {
  if (process.platform !== 'darwin') return Promise.reject(bad('RTF / DOC 只在 Mac 上能读（要用系统自带的 textutil），可以先另存为 TXT 或 DOCX'))
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', file], { maxBuffer: 256 << 20, timeout: 120000 },
      (err, out) => (err ? reject(bad(`textutil 转换失败：${err.message}`)) : resolve(String(out))))
  })
}

// ———————————————————— 入口 ————————————————————

/**
 * @param {string} file 文件路径
 * @param {{ name?: string }} [opt] name：上传时的原文件名（用来认格式和起书名）
 */
export async function extractDocument(file, opt = {}) {
  const name = opt.name || file
  const ext = extname(name).toLowerCase()
  if (!DOC_EXT.includes(ext)) throw bad(`不支持 ${ext || '这种'} 文件。支持：TXT、EPUB、PDF、DOCX、Markdown、HTML、RTF`)
  let out
  if (ext === '.rtf' || ext === '.doc') out = { title: '', author: '', chapters: splitChapters(await textutil(file)) }
  else {
    const buf = await readFile(file)
    if (ext === '.epub') out = extractEpub(buf)
    else if (ext === '.docx') out = extractDocx(buf)
    else if (ext === '.pdf') out = await extractPdf(buf)
    else if (ext === '.md' || ext === '.markdown') out = extractMarkdown(decodeText(buf))
    else if (ext === '.html' || ext === '.htm' || ext === '.xhtml') {
      const html = decodeText(buf)
      out = { title: tagText(html, 'title'), author: '', chapters: splitChapters(htmlToText(html)) }
    } else out = { title: '', author: '', chapters: splitChapters(unwrapHardWrapped(decodeText(buf))) }
  }
  out.chapters = out.chapters.filter(c => c.text && c.text.trim())
  if (!out.chapters.length) throw bad('文档里没有可以朗读的文字')
  return {
    title: (out.title || '').slice(0, 120) || titleFromFile(name),
    author: (out.author || '').slice(0, 80),
    format: ext.slice(1),
    chapters: out.chapters,
  }
}
