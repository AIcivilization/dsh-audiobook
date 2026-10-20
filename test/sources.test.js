// 搜书、下书：书源解析、清理、AI 猜书名，整条流程走一遍（网络请求全部换成假的）
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { makeEpub } from './helpers.js'

const home = await mkdtemp(join(tmpdir(), 'audiobook-src-'))
process.env.DSH_AUDIOBOOK_HOME = home
after(() => rm(home, { recursive: true, force: true }))

const { cleanGutenberg, cleanWikisource, parseGutenbergOpds, parseWikisourceSearch, searchSources } = await import('../lib/sources.js')
const { findBooks, parseGuesses, titleScore } = await import('../lib/finder.js')
const { importFromSource } = await import('../lib/importer.js')
const { extractEpub } = await import('../lib/extract.js')
const { getBook, getSegs } = await import('../lib/store.js')

const OPDS = `<feed><entry><id>https://www.gutenberg.org/ebooks/24264.opds</id><title>紅樓夢 (Chinese)</title><content type="text">Xueqin Cao</content></entry>
<entry><id>https://www.gutenberg.org/ebooks.opds/</id><title>No records found.</title></entry>
<entry><id>https://www.gutenberg.org/ebooks/1342.opds</id><title>Pride and Prejudice</title><content type="text">Jane Austen</content></entry></feed>`
const WS = { query: { search: [{ title: '紅樓夢', snippet: '<span>紅樓夢</span>&nbsp;作者' }, { title: '紅樓夢/第一回', snippet: '' }] } }

// 假网络：书源的请求按网址给假数据，其余（打本机服务器的）照常
const realFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  calls.push(u)
  if (u.includes('gutenberg.org/ebooks/search.opds')) return new Response(decodeURIComponent(u).includes('紅樓夢') ? OPDS : '<feed></feed>')
  if (u.includes('wikisource.org/w/api.php')) {
    const d = decodeURIComponent(u)
    if (d.includes('紅樓夢')) return Response.json(WS)
    if (d.includes('城')) return Response.json({ query: { search: [{ title: '井文昊与上海围城置业发展有限公司房屋买卖合同纠纷一审民事判决书' }, { title: '圍城病中文舉相過' }] } })
    return Response.json({ query: { search: [] } })
  }
  // Internet Archive、Standard Ebooks：这些测试里都当成没结果（专门的测试见下面）
  if (u.includes('archive.org/advancedsearch')) return Response.json({ response: { docs: [] } })
  if (u.includes('standardebooks.org/ebooks?')) return new Response('<ol></ol>')
  if (u.includes('ws-export.wmcloud.org')) {
    return new Response(makeEpub({
      title: '紅樓夢', author: '',
      chapters: [
        { toc: '封面', html: '<p>紅樓夢</p><p>以2026年10月20日从维基文库导出</p>' },
        { toc: '第一回', html: '<p>←</p><p>上一回</p><p>紅樓夢</p><p>作者：曹雪芹</p><p>第二回</p><p>→</p><p>姊妹计划: 百科</p><p>此開卷第一回也。</p><p>1996年1月1日，这部作品在原作國家或地區屬於公有領域</p>' },
        { toc: '关于', html: '<p>About this digital edition</p>' },
      ],
    }), { headers: { 'content-type': 'application/epub+zip' } })
  }
  return realFetch(url, init)
}
after(() => { globalThis.fetch = realFetch })

test('古腾堡 OPDS：书号、书名、作者，中文书去掉 (Chinese)', () => {
  const r = parseGutenbergOpds(OPDS)
  assert.deepEqual(r.map(x => [x.ref, x.title, x.author, x.lang]), [['24264', '紅樓夢', 'Xueqin Cao', 'zh'], ['1342', 'Pride and Prejudice', 'Jane Austen', '']])
})

test('维基文库搜索：子页面不单列，摘要去标签', () => {
  const r = parseWikisourceSearch(WS, 'wikisource-zh')
  assert.equal(r.length, 1)
  assert.equal(r[0].snippet, '紅樓夢 作者')
  assert.match(r[0].link, /zh\.wikisource\.org\/wiki\//)
})

test('维基文库清理：去导航、版权说明、封面和关于，作者从导航里取', () => {
  const out = cleanWikisource({
    title: 'x', author: '',
    chapters: [
      { title: '封面', text: '封面字' },
      { title: '狂人日記', text: '←\n上一篇\n狂人日記\n作者：魯迅\n下一篇\n→\n另參見別的版本\n姊妹计划: 百科\n正文一。\n正文二。\n这部作品在原作國家或地區屬於公有領域\nPublic domain' },
      { title: '关于', text: 'About' },
    ],
  })
  assert.equal(out.author, '魯迅')
  assert.deepEqual(out.chapters.map(c => [c.title, c.text]), [['狂人日記', '正文一。\n正文二。']])
})

test('古腾堡清理：开头的声明和结尾的许可证不读', () => {
  const out = cleanGutenberg({
    chapters: [
      { title: 'The Project Gutenberg eBook of X', text: 'This eBook is for the use of anyone\n*** START OF THE PROJECT GUTENBERG EBOOK X ***' },
      { title: 'Chapter 1', text: 'It was a dark night.' },
      { title: 'Chapter 2', text: 'The end.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nlicense text' },
      { title: 'THE FULL PROJECT GUTENBERG LICENSE', text: 'license' },
    ],
  })
  assert.deepEqual(out.chapters.map(c => [c.title, c.text]), [['Chapter 1', 'It was a dark night.'], ['Chapter 2', 'The end.']])
})

test('EPUB：一个文件里装着几章时，按目录锚点切开', () => {
  const epub = makeEpub({ chapters: [{ tocs: [['', '书名页'], ['c1', '第一章'], ['c2', '第二章']], html: '<p>扉页</p><h2 id="c1">第一章</h2><p>甲。</p><h2 id="c2">第二章</h2><p>乙。</p>' }] })
  const out = extractEpub(epub)
  assert.deepEqual(out.chapters.map(c => [c.title, c.text]), [['书名页', '扉页'], ['第一章', '第一章\n甲。'], ['第二章', '第二章\n乙。']])
})

test('书名匹配：只认书名对得上的，标题里含着这几个字的不算', () => {
  assert.equal(titleScore('紅樓夢', '紅樓夢'), 3)
  assert.equal(titleScore('紅樓夢（程甲本）', '紅樓夢'), 2)
  assert.equal(titleScore('Pride and Prejudice', 'pride and prejudice'), 3)
  assert.equal(titleScore('The Adventures of Tom Sawyer', 'Adventures of Tom Sawyer'), 3)
  assert.equal(titleScore('圍城病中文舉相過', '圍城'), 0)
  assert.equal(titleScore('井文昊与上海围城置业发展有限公司房屋买卖合同纠纷一审民事判决书', '围城'), 0)
  assert.equal(titleScore('後紅樓夢', '紅樓夢'), 0)
})

test('搜书：只沾了几个字的结果丢掉；AI 猜到但书源里没有的照实说', async () => {
  const llm = { async complete() { return '{"books":[{"title":"围城","hant":"圍城","author":"钱钟书"}]}' } }
  const r = await findBooks('围城', { llm })
  assert.equal(r.results.length, 0)
  assert.equal(r.guesses[0].found, false)
})

test('AI 猜书名：能从带说明的回答里抠出 JSON', () => {
  const g = parseGuesses('好的：\n```json\n{"books":[{"title":"红楼梦","hant":"紅樓夢","author":"曹雪芹","why":"贾宝玉是主角"}]}\n```')
  assert.deepEqual(g.map(x => [x.title, x.hant, x.author]), [['红楼梦', '紅樓夢', '曹雪芹']])
  assert.deepEqual(parseGuesses('不知道'), [])
})

test('搜书：按角色名搜不到，靠 AI 猜出的繁体书名搜到，猜中的排前面', async () => {
  const llm = { async complete() { return '{"books":[{"title":"红楼梦","hant":"紅樓夢","author":"曹雪芹","why":"贾宝玉"},{"title":"不存在的书","author":"某人"}]}' } }
  const r = await findBooks('主角叫贾宝玉的那本', { llm })
  assert.equal(r.guesses[0].found, true)
  assert.equal(r.guesses[1].found, false)
  assert.equal(r.results[0].guess, 0)
  assert.deepEqual(r.results.slice(0, 2).map(x => x.sourceLabel), ['古腾堡计划', '中文维基文库'])
  // 模型出错也不影响按原话搜
  const r2 = await findBooks('紅樓夢', { llm: { async complete() { throw new Error('没选模型') } } })
  assert.match(r2.note, /没选模型/)
  assert.ok(r2.results.length >= 2)
  await assert.rejects(searchSources('  '), /请输入/)
})

test('下载：维基文库导出的书清理后进书架，再下一次还是同一本', async () => {
  const b = await importFromSource('wikisource-zh', '紅樓夢')
  assert.equal(b.title, '紅樓夢')
  assert.equal(b.author, '曹雪芹')
  const book = await getBook(b.id)
  assert.deepEqual(book.from, { source: 'wikisource-zh', ref: '紅樓夢' })
  assert.deepEqual(book.chapters.map(c => c.title), ['第一回'])
  assert.deepEqual(await getSegs(b.id), ['此開卷第一回也。'])
  const again = await importFromSource('wikisource-zh', '紅樓夢')
  assert.equal(again.id, b.id)
  assert.equal(again.existed, true)
  // 编号不对的直接拒绝，不发请求
  const before = calls.length
  await assert.rejects(importFromSource('gutenberg', '../etc'), /书号不对/)
  await assert.rejects(importFromSource('nope', 'x'), /不认识的书源/)
  assert.equal(calls.length, before)
})

// ———————————————————— 自定义搜索地址 ————————————————————

const { normalizeCustom, parseOpds, searchOpds, DEFAULT_WEB } = await import('../lib/custom.js')
const { getSettings, saveSettings } = await import('../lib/store.js')

test('自定义地址：要有名字、http(s)、{q}；最多 20 个；id 不重复', () => {
  const out = normalizeCustom([{ name: '豆瓣', url: 'https://search.douban.com/book/subject_search?search_text={q}' }, { name: '书库', url: 'http://192.168.1.5:8080/opds/search/{q}', kind: 'opds', id: 'c0' }, { name: 'x', url: 'https://a.com/{q}', id: 'c0' }])
  assert.deepEqual(out.map(x => [x.id, x.kind]), [['c0', 'web'], ['c0x', 'opds'], ['c0xx', 'web']])
  assert.throws(() => normalizeCustom([{ name: '', url: 'https://a.com/{q}' }]), /没有名字/)
  assert.throws(() => normalizeCustom([{ name: 'a', url: 'https://a.com/' }]), /\{q\}/)
  assert.throws(() => normalizeCustom([{ name: 'a', url: 'file:///etc/{q}' }]), /http/)
  assert.throws(() => normalizeCustom(Array.from({ length: 21 }, (_, k) => ({ name: `n${k}`, url: 'https://a.com/{q}' }))), /最多 20/)
})

test('设置：没自定义过给默认的网页搜索；恢复默认存成 null', async () => {
  assert.deepEqual((await getSettings()).customSources, DEFAULT_WEB)
  const s = await saveSettings({ customSources: [{ name: '书库', url: 'http://lib.example/opds/search/{q}', kind: 'opds' }] })
  assert.equal(s.customSources.length, 1)
  assert.equal((await getSettings()).customSources[0].kind, 'opds')
  const d = await saveSettings({ customSources: 'default' })
  assert.deepEqual(d.customSources, DEFAULT_WEB)
})

const LIB = { id: 'lib', name: '我的书库', kind: 'opds', url: 'http://lib.example/opds/search/{q}' }
const OPDS_FEED = `<feed><entry><title>围城</title><author><name>钱钟书</name></author>
  <link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/get/pdf/7"/>
  <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/get/epub/7"/></entry>
  <entry><title>只有封面</title><link rel="http://opds-spec.org/image" href="/c.jpg"/></entry></feed>`

test('OPDS：挑能读的下载链接（EPUB 优先），补全成绝对地址', () => {
  const r = parseOpds(OPDS_FEED, 'http://lib.example/opds/search/x', LIB)
  assert.deepEqual(r.map(x => [x.title, x.author, x.ref, x.ext, x.sourceLabel]), [['围城', '钱钟书', 'http://lib.example/get/epub/7', '.epub', '我的书库']])
})

test('OPDS：搜自己的书库、下载进书架；别的域名的地址不下', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith('http://lib.example/opds/search/')) return new Response(OPDS_FEED)
    if (u === 'http://lib.example/get/epub/7') {
      return new Response(makeEpub({ title: '围城', author: '钱钟书', chapters: [{ toc: '一', html: '<p>红海早过了，船在印度洋面上开驶着。</p>' }] }),
        { headers: { 'content-type': 'application/epub+zip', 'content-disposition': 'attachment; filename="weicheng.epub"' } })
    }
    if (u.startsWith('http://down.example')) return new Response('', { status: 500 })
    return prev(url, init)
  }
  try {
    const found = await searchOpds([LIB, DEFAULT_WEB[0]], '围城')
    assert.equal(found.results.length, 1)
    await saveSettings({ customSources: [LIB] })
    const b = await importFromSource('opds', found.results[0].ref, { catalog: LIB, title: '围城' })
    assert.equal(b.title, '围城')
    assert.equal(b.author, '钱钟书')
    await assert.rejects(importFromSource('opds', 'http://evil.example/x.epub', { catalog: LIB }), /只能下载这个书库自己的书/)
    // 搜书时 OPDS 结果直接留着（书库自己按书名搜过了）
    const r = await findBooks('围城', { catalogs: [LIB] })
    assert.equal(r.results[0].source, 'opds')
  } finally { globalThis.fetch = prev }
})

// ———————————————————— Internet Archive、Standard Ebooks ————————————————————

const { parseArchiveSearch, pickArchiveFile, parseStandardEbooks, cleanStandardEbooks } = await import('../lib/sources.js')

test('古腾堡：标题后面的语言标出来（德语版……），中文、英文不标', () => {
  const r = parseGutenbergOpds('<entry><id>https://www.gutenberg.org/ebooks/44956.opds</id><title>Anna Karenina, 1. Band (German)</title><content>Tolstoy</content></entry>')
  assert.deepEqual([r[0].title, r[0].snippet], ['Anna Karenina, 1. Band', '德语版'])
})

test('Internet Archive：结果解析，扫描版标出来；挑文件：EPUB > TXT > 扫描识别', () => {
  const r = parseArchiveSearch({ response: { docs: [
    { identifier: 'pg768', title: 'Wuthering Heights', creator: 'Emily Brontë', format: ['EPUB', 'Text'] },
    { identifier: 'scan1', title: ['Wuthering Heights'], creator: ['A', 'B'], format: ['DjVuTXT', 'Text PDF'], language: 'chi' },
  ] } })
  assert.deepEqual(r.map(x => [x.ref, x.author, x.scan, x.lang]), [['pg768', 'Emily Brontë', false, ''], ['scan1', 'A、B', true, 'zh']])
  assert.deepEqual(pickArchiveFile([{ name: 'a.epub', format: 'EPUB' }, { name: 'a_djvu.txt', format: 'DjVuTXT' }, { name: 'a.txt', format: 'Text' }]), { name: 'a.epub', ext: '.epub' })
  assert.deepEqual(pickArchiveFile([{ name: 'a_djvu.txt', format: 'DjVuTXT' }, { name: 'a.txt', format: 'Text' }]), { name: 'a.txt', ext: '.txt' })
  assert.deepEqual(pickArchiveFile([{ name: 'a_djvu.txt', format: 'DjVuTXT' }, { name: 'a.epub', format: 'EPUB', private: 'true' }]), { name: 'a_djvu.txt', ext: '.txt' })
  assert.equal(pickArchiveFile([{ name: 'a.pdf', format: 'Text PDF' }]), null)
})

test('Standard Ebooks：解析搜索页；去掉书名页、版权页', () => {
  const r = parseStandardEbooks('<ol><li typeof="schema:Book" about="/ebooks/leo-tolstoy/anna-karenina/constance-garnett"><span property="schema:name">Anna Karenina</span><span property="schema:name">Leo Tolstoy</span></li></ol>')
  assert.deepEqual(r.map(x => [x.ref, x.title, x.author]), [['leo-tolstoy/anna-karenina/constance-garnett', 'Anna Karenina', 'Leo Tolstoy']])
  const c = cleanStandardEbooks({ chapters: [{ title: 'Titlepage', text: 'x' }, { title: 'I', text: 'Happy families' }, { title: 'Colophon', text: 'y' }, { title: 'Uncopyright', text: 'z' }] })
  assert.deepEqual(c.chapters.map(x => x.title), ['I'])
})

test('Internet Archive：没标授权的书不下载', async () => {
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://archive.org/metadata/')
    ? Response.json({ metadata: { title: 'x' }, files: [{ name: 'x.epub', format: 'EPUB' }] })
    : prev(url, init))
  try {
    await assert.rejects(importFromSource('archive', 'someupload'), /没有标明公有领域或开放授权/)
    await assert.rejects(importFromSource('archive', '../x'), /编号不对/)
    await assert.rejects(importFromSource('standardebooks', 'https://evil'), /书名不对/)
  } finally { globalThis.fetch = prev }
})
