// 取文字、分章、切朗读段
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { decodeText, extractDocument, extractDocx, extractEpub, extractMarkdown, htmlToText, titleFromFile } from '../lib/extract.js'
import { buildSegments, sentences, splitChapters, unwrapLines, weight } from '../lib/segment.js'
import { openZip } from '../lib/zip.js'
import { makeEpub, makeZip } from './helpers.js'

const dir = await mkdtemp(join(tmpdir(), 'audiobook-text-'))
after(() => rm(dir, { recursive: true, force: true }))

test('句子：中文句末标点和后引号跟着前一句；西文不在 3.14、e.g. 处断', () => {
  assert.deepEqual(sentences('他说：「走吧。」她没动。真的？'), ['他说：「走吧。」', '她没动。', '真的？'])
  assert.deepEqual(sentences('Pi is 3.14 today. He left, e.g. home. Then "Stop!" she said.'),
    ['Pi is 3.14 today.', 'He left, e.g. home.', 'Then "Stop!"', 'she said.'])
})

test('朗读段：不超过上限，段落分隔记成 \\n，章首短标题单独成段', () => {
  const para = '这是一句很长的话，用来测试切段。'.repeat(20)
  const { chapters, segs, chars } = buildSegments([
    { title: '第一章 开始', text: `第一章 开始\n${para}\n嗯。\n好。` },
    { title: '第二章', text: '第二章\n结束了。' },
  ], { max: 60 })
  assert.deepEqual(chapters.map(c => c.title), ['第一章 开始', '第二章'])
  assert.equal(segs[0], '第一章 开始')
  assert.ok(segs.every(s => weight(s.replace(/\n/g, '')) <= 60), '每段都在上限内')
  // 短段落拼到前一段后面，中间用 \n 分开
  assert.ok(segs.some(s => s.endsWith('。\n嗯。')))
  assert.equal(segs[chapters[1].seg], '\n第二章')
  assert.equal(chars, segs.join('').replace(/\n/g, '').length)
})

test('纯文本分章：认得出标题就按标题分，认不出就按字数切部分', () => {
  const ch = splitChapters('书名\n作者的话写在这里，比较长的一段前言文字，前言前言前言前言前言前言前言前言前言前言前言。\n第一章 风起\n正文一。\n第二章 云涌\n正文二。')
  assert.deepEqual(ch.map(c => c.title), ['开头', '第一章 风起', '第二章 云涌'])
  assert.ok(ch[1].text.startsWith('第一章 风起\n'))
  const parts = splitChapters('字'.repeat(50) + '\n' + '字'.repeat(50), { partSize: 40 })
  assert.deepEqual(parts.map(c => c.title), ['第 1 部分', '第 2 部分'])
  assert.deepEqual(splitChapters('就一段').map(c => c.title), ['全文'])
})

test('PDF 折行接回段落，页码去掉', () => {
  const t = unwrapLines('第一章\n他走进房间，看见\n桌上有一封信。\n12\nThe quick brown fox jum-\nped over the dog.\nNext line here.')
  assert.equal(t, '第一章\n他走进房间，看见桌上有一封信。\nThe quick brown fox jumped over the dog.\nNext line here.')
})

test('编码：UTF-8、带 BOM 的 UTF-16、GBK、Big5', () => {
  assert.equal(decodeText(Buffer.from('你好的世界', 'utf8')), '你好的世界')
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('我们说的', 'utf16le')])
  assert.equal(decodeText(u16), '我们说的')
  // 「我是一个人的了」的 GBK 编码
  const gbk = Buffer.from('ced2cac7d2bbb8f6c8cbb5c4c1cb', 'hex')
  assert.equal(decodeText(gbk), '我是一个人的了')
  // 「我是一個人的了」的 Big5 编码
  const big5 = Buffer.from('a7daac4fa440add3a448aabaa446', 'hex')
  assert.equal(decodeText(big5), '我是一個人的了')
})

test('HTML：去掉脚本样式和注音，块级元素换行，实体解码', () => {
  const t = htmlToText('<head><title>t</title></head><script>x()</script><p>甲&amp;乙</p><div>漢<ruby>字<rt>zi</rt></ruby>&#x4E00;&ldquo;</div>')
  assert.deepEqual(t.split('\n').filter(Boolean), ['甲&乙', '漢字一“'])
})

test('EPUB：按书脊顺序，目录里的标题当章名，没有的用第一行', () => {
  const epub = makeEpub({
    title: '三体', author: '刘慈欣',
    chapters: [
      { html: '<p>献给读者。</p>' },
      { toc: '第一章 科学边界', html: '<h1>第一章</h1><p>汪淼觉得，来找他的这四个人是一个奇怪的组合。</p>' },
      { html: '<img src="x.png"/>' },
    ],
  })
  const out = extractEpub(epub)
  assert.equal(out.title, '三体')
  assert.equal(out.author, '刘慈欣')
  assert.deepEqual(out.chapters.map(c => c.title), ['献给读者。', '第一章 科学边界'])
  assert.match(out.chapters[1].text, /^第一章\n汪淼/)
})

test('DOCX：标题样式当章节', () => {
  const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`
  const docx = makeZip({
    'word/document.xml': `<w:document><w:body>${p('序', 'Heading1')}${p('开头的话。')}${p('第一部', 'Heading1')}${p('正文 &amp; 更多。')}</w:body></w:document>`,
    'docProps/core.xml': '<cp:coreProperties><dc:title>我的文档</dc:title></cp:coreProperties>',
  })
  const out = extractDocx(docx)
  assert.equal(out.title, '我的文档')
  assert.deepEqual(out.chapters.map(c => c.title), ['序', '第一部'])
  assert.equal(out.chapters[1].text, '第一部\n正文 & 更多。')
})

test('Markdown：# 标题当章节，去掉链接图片强调', () => {
  const out = extractMarkdown('# 书名\n\n## 一\n\n这是**重点**，[链接](http://x)。![图](a.png)\n\n## 二\n\n- 列表项')
  assert.equal(out.title, '书名')
  assert.deepEqual(out.chapters.map(c => c.title), ['书名', '一', '二'])
  assert.equal(out.chapters[1].text, '一\n这是重点，链接。')
  assert.equal(out.chapters[2].text, '二\n列表项')
})

test('ZIP：存储和 deflate 都能读，不是 ZIP 的报错', () => {
  const z = openZip(makeZip({ 'a.txt': '甲', 'b/c.txt': 'cc' }))
  assert.deepEqual(z.names, ['a.txt', 'b/c.txt'])
  assert.equal(z.text('a.txt'), '甲')
  assert.equal(z.read('nope'), null)
  assert.throws(() => openZip(Buffer.from('not a zip at all, definitely not')), /不是 ZIP/)
})

test('入口：按扩展名分派；书名从文件名来；不支持的格式说清楚', async () => {
  const f = join(dir, '我的_小说 -- 某某下载站.txt')
  await writeFile(f, '第一章\n内容。\n第二章\n更多内容。')
  const out = await extractDocument(f)
  assert.equal(out.title, '我的 小说')
  assert.equal(out.format, 'txt')
  assert.equal(out.chapters.length, 2)
  assert.equal(titleFromFile('/a/b/c.epub'), 'c')
  const bad = join(dir, 'x.mobi')
  await writeFile(bad, 'x')
  await assert.rejects(extractDocument(bad), /不支持 \.mobi/)
  const empty = join(dir, 'empty.txt')
  await writeFile(empty, '   \n\n')
  await assert.rejects(extractDocument(empty), /没有可以朗读的文字/)
})

test('固定宽度折行的 TXT：接回段落；隔行排版也认得；中文一段一行的不动', async () => {
  const { unwrapHardWrapped } = await import('../lib/segment.js')
  const en = Array.from({ length: 12 }, () => 'It was a dark and stormy night; the rain fell in torrents, except at\noccasional intervals, when it was checked by a violent gust of wind.\n').join('\n')
  const out = unwrapHardWrapped(en).split('\n')
  assert.equal(out.length, 12)
  assert.match(out[0], /except at occasional intervals/)
  const zh = Array.from({ length: 12 }, () => '    在我自己，本以為現在是已經並非一個切迫而不能已于言的人了，但或者也還\n\n    未能忘懷于當日自己的寂寞的悲哀罷，所以有時候仍不免吶喊幾聲。\n').join('\n\n')
  const z = unwrapHardWrapped(zh).split('\n')
  assert.equal(z.length, 12)
  assert.match(z[0], /也還未能忘懷/)
  const plain = Array.from({ length: 30 }, (_, k) => `第${k}段，这是一整段中文，一段一行，没有折行。`).join('\n')
  assert.equal(unwrapHardWrapped(plain), plain)
})

test('朗读段：同一段里的英文句子之间留空格', () => {
  const { segs } = buildSegments([{ title: 'I', text: 'I\nIt was cold. Being unable to remove the chain, I jumped over. 天很冷。我跳了过去。' }])
  assert.equal(segs[1], '\nIt was cold. Being unable to remove the chain, I jumped over.天很冷。我跳了过去。')
})
