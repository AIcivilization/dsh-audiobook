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
