// lib/segment.js — 把正文切成「章」和「朗读段」
//
// 朗读段是朗读、缓存、记进度的最小单位：一段大约 20–30 秒（约 120 个汉字），在句号处断开。
// 太短的段落会和后面的拼在一起，免得一句「嗯。」也单独发一次合成请求。
// 段内的 \n 是段落分隔；以 \n 开头的段表示它从新段落开始（界面据此分段显示）。

/** 一行像不像章节标题 */
const HEADING_RE = new RegExp([
  '^第[0-9０-９零〇一二两三四五六七八九十百千万]+[章回节卷集部篇幕话](?:[\\s:：.、·—-].{0,30}|$)',
  '^(?:序章|序言|序|楔子|引子|前言|引言|后记|尾声|终章|番外.{0,20}|附录.{0,20}|致谢)(?:[\\s:：.、·—-].{0,30}|$)',
  '^(?:chapter|part|book)\\s+(?:\\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\\b.{0,40}$',
  '^(?:prologue|epilogue|preface|introduction|afterword)\\b.{0,40}$',
].join('|'), 'i')

const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/

export const isHeading = line => line.length <= 40 && HEADING_RE.test(line.trim())

/** 朗读时长的粗略权重：一个汉字 1，西文字符 0.3（一个英文单词约等于两个汉字的时长） */
export function weight(text) {
  let w = 0
  for (const ch of text) w += CJK_RE.test(ch) ? 1 : /\s/.test(ch) ? 0.15 : 0.3
  return w
}

/** 文本 → 段落：每行去掉首尾空白（含全角缩进），去空行，行内连续空白压成一个 */
export function paragraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[\s　 ]+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * PDF 抽出来的字是按版面折行的：把一段里被硬折开的行接回去。
 * 上一行以句末标点结尾、下一行像标题、或者遇到空行，才算新段落。页码行（只有数字）去掉。
 */
export function unwrapLines(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\s　]+$/g, ''))
  const out = []
  let cur = ''
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    if (/^[-—\s]*\d{1,4}[-—\s]*$/.test(line)) continue
    if (isHeading(line)) { flush(); out.push(line); continue }
    if (!cur) { cur = line; continue }
    const end = cur.slice(-1)
    if (/[。！？!?…”」』：:]/.test(end) || (/[.]/.test(end) && /^[A-Z“"]/.test(line))) { flush(); cur = line; continue }
    // 中文直接接；西文接的时候补空格，连字符断词的去掉连字符
    if (/-$/.test(cur) && /^[a-z]/.test(line)) cur = cur.slice(0, -1) + line
    else cur += CJK_RE.test(end) || CJK_RE.test(line[0]) ? line : ' ' + line
  }
  flush()
  return out.join('\n')
}

/**
 * 纯文本分章：认得出两个以上章节标题就按标题分；认不出就每约 8000 字切一个「第 N 部分」，方便跳转。
 * 标题行留在正文里（会被读出来）。
 * @returns {{title: string, text: string}[]}
 */
export function splitChapters(text, { partSize = 8000 } = {}) {
  const paras = paragraphs(text)
  const heads = paras.map((p, k) => (isHeading(p) ? k : -1)).filter(k => k >= 0)
  if (heads.length >= 2) {
    const chapters = []
    const before = paras.slice(0, heads[0])
    if (weight(before.join('')) > 40) chapters.push({ title: '开头', text: before.join('\n') })
    heads.forEach((h, n) => {
      const body = paras.slice(h, n + 1 < heads.length ? heads[n + 1] : paras.length)
      chapters.push({ title: paras[h], text: body.join('\n') })
    })
    return chapters
  }
  const chapters = []
  let buf = []
  let w = 0
  for (const p of paras) {
    buf.push(p)
    w += weight(p)
    if (w >= partSize) { chapters.push({ title: `第 ${chapters.length + 1} 部分`, text: buf.join('\n') }); buf = []; w = 0 }
  }
  if (buf.length) chapters.push({ title: chapters.length ? `第 ${chapters.length + 1} 部分` : '全文', text: buf.join('\n') })
  return chapters
}

/** 一个段落 → 句子（句末标点和后面的引号括号跟着前一句走；西文只在「. 后接空白和大写」处断，避开 3.14、e.g.） */
export function sentences(para) {
  const marked = String(para)
    .replace(/([。！？!?…；;]+[”’」』）)"']*)/g, '$1\u0001')
    .replace(/(\.+["')\]”’]*)\s+(?=[A-Z“"(\u3400-\u9fff])/g, '$1\u0001')
  const out = marked.split('\u0001').map(x => x.trim()).filter(Boolean)
  return out.length ? out : [para]
}

/** 一句比一段还长：先在逗号、顿号处断，再不行就硬切 */
function splitLong(sentence, max) {
  if (weight(sentence) <= max) return [sentence]
  const parts = sentence.match(/[^，、,：:—]+[，、,：:—]*/g) || [sentence]
  const out = []
  let cur = ''
  for (const p of parts) {
    if (cur && weight(cur + p) > max) { out.push(cur); cur = '' }
    if (weight(p) > max) {
      // 没有标点的超长串：按字数硬切
      let piece = ''
      for (const ch of p) { if (weight(piece + ch) > max) { out.push(piece); piece = '' } piece += ch }
      cur = piece
    } else cur += p
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 章 → 朗读段
 * @param {{title: string, text: string}[]} chapters
 * @returns {{ chapters: {title: string, seg: number}[], segs: string[], chars: number }}
 */
export function buildSegments(chapters, { max = 120 } = {}) {
  const segs = []
  const toc = []
  let chars = 0
  for (const ch of chapters) {
    const paras = paragraphs(ch.text)
    if (!paras.length) continue
    toc.push({ title: String(ch.title || '').trim().slice(0, 80) || `第 ${toc.length + 1} 章`, seg: segs.length })
    let cur = ''
    let curW = 0
    const flush = () => { if (cur) segs.push(cur); cur = ''; curW = 0 }
    paras.forEach((p, k) => {
      chars += p.length
      // 章首的短标题单独成段：先读标题、停一下再读正文
      const headingLike = k === 0 && p.length <= 40
      let first = true
      for (const s of sentences(p).flatMap(x => splitLong(x, max))) {
        const w = weight(s)
        if (cur && curW + w > max) flush()
        // 段落的第一句前面加 \n（全书第一段除外）
        cur += first && (cur || segs.length) ? '\n' + s : s
        curW += w
        first = false
      }
      if (headingLike) flush()
    })
    flush()
  }
  return { chapters: toc, segs, chars }
}
