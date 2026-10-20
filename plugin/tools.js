// plugin/tools.js — 给 DSH 对话里的 AI 用的 8 个工具
//
// 让用户在对话里说「帮我找那本主角叫贾宝玉的书来听」「把 ~/Downloads/三体.epub 导入搜书听」
// 「我听到哪了？刚才那段讲了什么」「主角第一次出场在哪」「跳到第十章」，
// AI 自己搜书下书、导入、查进度、取出正文来讲，或者改收听位置。
// 搜书时由对话里的 AI 自己判断是哪本书（它本身就是大模型），工具只管在书源里按书名搜。
// 直接写 DSH 工具注册表认的原始格式（标准 JSON Schema 子集），不依赖 defineTool：
// 插件包从自己的目录加载时 import 不到 @deepseek-ai/dsh-tools，而 {type:'json'} 这种简写只有 defineTool 认。

import { findBooks } from '../lib/finder.js'
import { importDocument, importFromSource } from '../lib/importer.js'
import { addNote, allNotes, getNotes } from '../lib/notes.js'
import { SOURCES } from '../lib/sources.js'
import { chapterOf, checkId, getBook, getProgress, getSegs, getSettings, listBooks, setProgress } from '../lib/store.js'

const ANY_OBJECT = { type: 'object' }

/** {name: {type, description, required?, enum?}} → JSON Schema 的 object */
function params(spec) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(spec)) {
    const { required: req, ...rest } = v
    properties[k] = rest
    if (req) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}
const plain = v => JSON.parse(JSON.stringify(v == null ? null : v))

const OPEN_HINT = '朗读面板在对话页的右侧栏：打开右侧栏，选「搜书听」。'

/** 没给书的编号：用最近听过的那本 */
async function pickBook(id) {
  if (id) {
    const b = await getBook(checkId(String(id)))
    if (!b) throw new Error('没有这本书（用 audiobook_books 查编号）')
    return b
  }
  const [first] = await listBooks()
  if (!first) throw new Error('书库里还没有书')
  return getBook(first.id)
}

/** 把一串朗读段拼成可读的正文（段内 \n 是分段） */
const joinSegs = list => list.join('').replace(/^\n+/, '')

/** 在章名里找：「第十章」「10」「序章」都认 */
function findChapter(book, query) {
  const list = book.chapters || []
  const q = String(query ?? '').trim()
  if (!q) return -1
  if (/^\d+$/.test(q)) {
    const n = Number(q)
    const byTitle = list.findIndex(c => new RegExp(`^第\\s*${n}\\s*[章回节卷]|^chapter\\s+${n}\\b`, 'i').test(c.title))
    if (byTitle >= 0) return byTitle
    return n >= 1 && n <= list.length ? n - 1 : -1
  }
  return list.findIndex(c => c.title.includes(q))
}

export async function buildToolDefinitions() {
  return [
    {
      name: 'audiobook_search',
      description: '在公版书和授权免费的书源里搜书：古腾堡计划（7 万多本公版书，英文为主，也有中文古籍）、中文 / 英文维基文库（公版古籍、民国作品）、Internet Archive（标明公有领域或 CC 授权的书）、Standard Ebooks（精校英文公版书），以及用户自己配置的 OPDS 书库。' +
        '用户只记得角色名或情节时，先自己判断是哪本书，再用书名搜；中文古籍可以再用繁体书名搜一次（古腾堡收的多是繁体）。' +
        '受版权保护的现代书这里搜不到，照实告诉用户，建议买正版电子书后用 audiobook_import 导入。找到后用 audiobook_download 下载。',
      parameters: params({
        query: { type: 'string', required: true, description: '书名、作者或原文书名' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: v.results.length
            ? v.results.map(r => `- 《${r.title}》${r.author ? ` ${r.author}` : ''} [${r.sourceLabel}] source=${r.source} ref=${r.ref}${r.catalog ? ` catalog=${r.catalog}` : ''}${r.snippet ? `：${r.snippet}` : ''}`).join('\n')
            : `没搜到「${v.query}」。这些书源只有公版书和授权免费的书。` + (v.failed.length ? `（${v.failed.join('、')}暂时连不上）` : ''),
        }],
      },
      async execute(args) {
        const r = await findBooks(String(args.query || ''), { catalogs: (await getSettings()).customSources })
        return plain({ ...r, results: r.results.slice(0, 12) })
      },
    },

    {
      name: 'audiobook_download',
      description: '把 audiobook_search 搜到的一本书下载进「搜书听」书架，下载完就能在右侧栏听。维基文库的整部大书导出可能要一两分钟。',
      parameters: params({
        source: { type: 'string', required: true, enum: [...Object.keys(SOURCES), 'opds'], description: 'audiobook_search 结果里的 source' },
        catalog: { type: 'string', description: 'source=opds 时，audiobook_search 结果里的 catalog' },
        ref: { type: 'string', required: true, description: 'audiobook_search 结果里的 ref' },
        title: { type: 'string', description: '书名（可省略，默认从书里读）' },
        author: { type: 'string', description: '作者（书里没写作者时用它）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: `《${v.title}》${v.author ? ` ${v.author}` : ''}（id: ${v.id}）已加入书架：${v.chapters} 章，${v.chars < 1000 ? `${v.chars} 字` : `约 ${Math.round(v.chars / 1000)} 千字`}。${OPEN_HINT}`,
        }],
      },
      async execute(args) {
        const catalog = args.source === 'opds' ? (await getSettings()).customSources.find(c => c.id === args.catalog && c.kind === 'opds') : undefined
        if (args.source === 'opds' && !catalog) throw new Error('没有这个 OPDS 书库')
        return plain(await importFromSource(String(args.source || ''), String(args.ref || ''), {
          catalog,
          title: typeof args.title === 'string' ? args.title : '',
          author: typeof args.author === 'string' ? args.author : '',
        }))
      },
    },

    {
      name: 'audiobook_import',
      description: '把本机的一本书或文档（TXT、EPUB、PDF、DOCX、Markdown、HTML、RTF）导入「搜书听」，导入后可以在右侧栏朗读。',
      parameters: params({
        path: { type: 'string', required: true, description: '文档的完整路径' },
        title: { type: 'string', description: '书名（可省略，默认从文档里读）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: `《${v.title}》${v.author ? ` ${v.author}` : ''}（id: ${v.id}）${v.existed ? '以前导入过，已更新内容，收听进度保留' : '已导入'}：` +
            `${v.chapters} 章，${v.chars < 1000 ? `${v.chars} 字` : `约 ${Math.round(v.chars / 1000)} 千字`}。${OPEN_HINT}`,
        }],
      },
      async execute(args) {
        return plain(await importDocument(String(args.path || ''), { title: typeof args.title === 'string' ? args.title : '' }))
      },
    },

    {
      name: 'audiobook_books',
      description: '列出「搜书听」书库里的书和收听进度（听到第几章、百分之几），最近听的在前。',
      parameters: params({}),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{
          type: 'text',
          text: v.books.length
            ? v.books.map(b => `- 《${b.title}》${b.author ? ` ${b.author}` : ''}（id: ${b.id}）：${b.chapters} 章，听到「${b.chapterTitle}」，${b.percent}%`).join('\n')
            : '书库里还没有书。',
        }],
      },
      async execute() {
        return plain({ books: await listBooks() })
      },
    },

    {
      name: 'audiobook_text',
      description: '取一本书的正文。mode=recent（默认）取用户刚听过的内容（当前收听位置之前约 limit 字，到当前段为止），适合回答「刚才讲了什么」；' +
        'mode=chapter 取某一章（chapter 给章名或序号，省略就是当前章）；mode=find 在全书里找一个词（人名、地名……），返回每处出现的章名和上下文。',
      parameters: params({
        id: { type: 'string', description: '书的编号（省略就是最近听的那本）' },
        mode: { type: 'string', enum: ['recent', 'chapter', 'find'], description: '默认 recent' },
        chapter: { type: 'string', description: 'mode=chapter 时：章名的一部分，或第几章' },
        query: { type: 'string', description: 'mode=find 时要找的词' },
        limit: { type: 'integer', description: '最多返回多少字，默认 3000，最多 12000' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{ type: 'text', text: `《${v.title}》${v.where}\n\n${v.text || '（没有内容）'}` }],
      },
      async execute(args) {
        const book = await pickBook(args.id)
        const segs = await getSegs(book.id)
        const p = await getProgress(book.id)
        const limit = Math.min(12000, Math.max(200, Number.parseInt(args.limit, 10) || 3000))
        const chs = book.chapters || []
        const endOf = k => (k + 1 < chs.length ? chs[k + 1].seg : segs.length)
        if (args.mode === 'find') {
          const q = String(args.query || '').trim()
          if (!q) throw new Error('mode=find 要给 query')
          const hits = []
          let total = 0
          for (let s = 0; s < segs.length; s++) {
            if (!segs[s].includes(q)) continue
            total++
            if (hits.join('').length < limit) hits.push(`[${chs[chapterOf(book, s)]?.title || ''} · 第 ${s} 段${s === p.seg ? ' · 正在听' : ''}] ${segs[s].replace(/\n/g, ' ').trim()}`)
          }
          return plain({ title: book.title, where: `里「${q}」出现在 ${total} 段${total > hits.length ? `（只列出前 ${hits.length} 段）` : ''}：`, text: hits.join('\n') })
        }
        if (args.mode === 'chapter') {
          const k = args.chapter ? findChapter(book, args.chapter) : chapterOf(book, p.seg)
          if (k < 0) throw new Error(`找不到章节「${args.chapter}」。目录：${chs.map((c, n) => `${n + 1}. ${c.title}`).join('；').slice(0, 1500)}`)
          const text = joinSegs(segs.slice(chs[k].seg, endOf(k)))
          return plain({ title: book.title, where: `第 ${k + 1} 章「${chs[k].title}」${text.length > limit ? `（前 ${limit} 字，全章 ${text.length} 字）` : ''}：`, text: text.slice(0, limit) })
        }
        // recent：从当前段往前取到 limit 字
        let from = p.seg
        let len = (segs[p.seg] || '').length
        while (from > 0 && len + segs[from - 1].length <= limit) { from--; len += segs[from].length }
        const k = chapterOf(book, p.seg)
        return plain({
          title: book.title,
          where: `用户正在听第 ${k + 1} 章「${chs[k]?.title || ''}」，全书 ${book.segCount ? Math.round((p.seg / book.segCount) * 100) : 0}%。最近听过的内容（最后一段是正在听的）：`,
          text: joinSegs(segs.slice(from, p.seg + 1)),
        })
      },
    },

    {
      name: 'audiobook_goto',
      description: '改一本书的收听位置：跳到某一章开头，或跳到某个词第一次出现的地方。朗读面板下次播放就从这里开始。',
      parameters: params({
        id: { type: 'string', description: '书的编号（省略就是最近听的那本）' },
        chapter: { type: 'string', description: '章名的一部分，或第几章' },
        query: { type: 'string', description: '跳到这个词出现的地方（从当前位置往后找，找不到再从头找）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{ type: 'text', text: `《${v.title}》收听位置已改到「${v.chapterTitle}」${v.preview ? `：${v.preview}` : ''}。${OPEN_HINT}` }],
      },
      async execute(args) {
        const book = await pickBook(args.id)
        const segs = await getSegs(book.id)
        const chs = book.chapters || []
        let seg = -1
        if (args.chapter) {
          const k = findChapter(book, args.chapter)
          if (k < 0) throw new Error(`找不到章节「${args.chapter}」。目录：${chs.map((c, n) => `${n + 1}. ${c.title}`).join('；').slice(0, 1500)}`)
          seg = chs[k].seg
        } else if (args.query) {
          const q = String(args.query)
          const cur = (await getProgress(book.id)).seg
          seg = segs.findIndex((s, n) => n > cur && s.includes(q))
          if (seg < 0) seg = segs.findIndex(s => s.includes(q))
          if (seg < 0) throw new Error(`书里没有「${q}」`)
        } else throw new Error('要给 chapter 或 query')
        await setProgress(book.id, seg, segs.length)
        return plain({
          title: book.title,
          chapterTitle: chs[chapterOf(book, seg)]?.title || '',
          preview: segs[seg].replace(/\n/g, ' ').trim().slice(0, 60),
        })
      },
    },
  ]
}

const noteLine = n => `- [${n.bookTitle ? `《${n.bookTitle}》` : ''}${n.chapter}] ${new Date(n.createdAt).toLocaleDateString('zh-CN')} 摘句「${n.quote}」：${n.polished || n.text}`

/** 读书心得的两个工具：看 / 搜心得，记一条心得 */
function noteTools() {
  return [
    {
      name: 'audiobook_notes',
      description: '取用户在「搜书听」里记的读书心得（听书时语音或打字记的，挂在书里的位置上）。给 id 就是那本书的全部心得；不给 id 就是所有书的心得，可以用 query 搜、用 days 限定最近几天。' +
        '适合帮用户回顾、整理心得，讨论他的想法，或者写读后感。',
      parameters: params({
        id: { type: 'string', description: '书的编号（省略就是所有书）' },
        query: { type: 'string', description: '只要包含这个词的心得' },
        days: { type: 'integer', description: '只要最近几天的' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{ type: 'text', text: v.lines.length ? `${v.title}（${v.lines.length} 条）
${v.lines.join('\n')}` : `${v.title}：还没有心得` }],
      },
      async execute(args) {
        if (args.id) {
          const book = await getBook(checkId(String(args.id)))
          if (!book) throw new Error('没有这本书')
          const { notes, reviews } = await getNotes(book.id)
          const q = String(args.query || '')
          const lines = notes.filter(n => !q || `${n.text}${n.polished || ''}${n.quote}`.includes(q)).sort((a, b) => a.seg - b.seg).map(noteLine)
          if (reviews[0]) lines.push(`读后感：\n${reviews[0].text}`)
          return plain({ title: `《${book.title}》的读书心得`, lines })
        }
        const days = Number.parseInt(args.days, 10) || 0
        const notes = await allNotes({ since: days > 0 ? Date.now() - days * 86400e3 : 0, query: String(args.query || '') })
        return plain({ title: days > 0 ? `最近 ${days} 天的读书心得` : '所有读书心得', lines: notes.slice(0, 200).map(noteLine) })
      },
    },
    {
      name: 'audiobook_add_note',
      description: '把一条读书心得记到「搜书听」里，挂在用户正在听的位置（或指定的段）。用户说「把这个想法记下来」「记到心得里」时用；记用户自己的想法，或者用户认可的讨论结论。',
      parameters: params({
        text: { type: 'string', required: true, description: '心得内容' },
        id: { type: 'string', description: '书的编号（省略就是最近听的那本）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_a, v) => [{ type: 'text', text: `已记到《${v.title}》的心得里（${v.chapter}）。` }],
      },
      async execute(args) {
        const book = await pickBook(args.id)
        const p = await getProgress(book.id)
        const n = await addNote(book.id, { seg: p.seg, text: String(args.text || ''), source: 'ai' })
        return plain({ title: book.title, chapter: n.chapter })
      },
    },
  ]
}

/** 注册工具；有 effect 就交给它管理生命周期 */
export async function registerTools(tools, deps) {
  const defs = [...await buildToolDefinitions(deps), ...noteTools()]
  return defs.map(def => (deps.effect ? deps.effect(() => tools.register(def)) : tools.register(def)))
}
