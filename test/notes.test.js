// 读书心得、问 AI、读后感、导入到知识库（模型、工具注册表都是假的）
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'audiobook-notes-'))
process.env.DSH_AUDIOBOOK_HOME = join(home, 'data')
// 起居注目录、Obsidian 配置都在这个假的家目录里找
const realHome = process.env.HOME
process.env.HOME = home
after(async () => { process.env.HOME = realHome; await rm(home, { recursive: true, force: true }) })

const { importDocument } = await import('../lib/importer.js')
const N = await import('../lib/notes.js')
const { detectTargets, profilePlugins, sendTo, sinkFields } = await import('../lib/targets.js')

/** 假模型：记下收到的提示词，按要求回话 */
const calls = []
const llm = { async complete(o) { calls.push(o); return llm.reply(o) }, reply: () => '好的' }

let id
before(async () => {
  const f = join(home, '书.txt')
  await writeFile(f, `第一章 开端\n${'甲走进屋子。'.repeat(30)}\n乙在等他。\n第二章 发展\n丙出现了。\n第三章 结局\n甲最后离开了村子。`)
  id = (await importDocument(f)).id
})

test('记心得：挂在段上，带章名和摘句；改原话会让整理版作废；删除', async () => {
  const n = await N.addNote(id, { seg: 2, text: '  嗯我觉得甲有点孤独  ', source: 'voice' })
  assert.equal(n.text, '嗯我觉得甲有点孤独')
  assert.equal(n.chapter, '第一章 开端')
  assert.ok(n.quote.length > 0)
  assert.equal(n.source, 'voice')
  await N.editNote(id, n.id, { polished: '我觉得甲有点孤独。' })
  let { notes } = await N.getNotes(id)
  assert.equal(notes[0].polished, '我觉得甲有点孤独。')
  await N.editNote(id, n.id, { text: '我觉得甲很孤独' })
  ;({ notes } = await N.getNotes(id))
  assert.equal(notes[0].polished, undefined)
  await assert.rejects(N.addNote(id, { seg: 0, text: '   ' }), /空的/)
  const extra = await N.addNote(id, { seg: 999, text: '越界的段夹到最后一段' })
  assert.equal(extra.chapter, '第三章 结局')
  await N.deleteNote(id, extra.id)
  assert.equal((await N.getNotes(id)).notes.length, 1)
})

test('AI 整理：只整理成文，原话保留；没有模型时说清楚', async () => {
  const [n] = (await N.getNotes(id)).notes
  llm.reply = () => '我觉得甲很孤独。'
  const out = await N.polishNote(llm, id, n.id)
  assert.equal(out.text, '我觉得甲很孤独')
  assert.equal(out.polished, '我觉得甲很孤独。')
  assert.match(calls.at(-1).system, /不要改变用户的观点/)
  await assert.rejects(N.polishNote(null, id, n.id), /没有可用的模型/)
})

test('问 AI：只给到正在听的位置（防剧透），讨论记录存下来；允许剧透时换提示词', async () => {
  llm.reply = () => '甲在屋里。'
  const r = await N.ask(llm, id, { seg: 1, question: '甲在哪？' })
  assert.equal(r.answer, '甲在屋里。')
  const sent = calls.at(-1)
  assert.match(sent.user, /甲走进屋子/)
  assert.doesNotMatch(sent.user, /离开了村子/, '后面的内容不能给模型')
  assert.match(sent.system, /不要剧透/)
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'ai'])
  await N.ask(llm, id, { seg: 1, question: '结局呢？', spoilers: true, mode: 'notes' })
  assert.match(calls.at(-1).system, /允许剧透/)
  assert.match(calls.at(-1).user, /用户这本书的读书心得/)
  assert.match(calls.at(-1).user, /之前的讨论/)
  assert.equal((await N.getChat(id)).length, 4)
  await N.clearChat(id)
  assert.equal((await N.getChat(id)).length, 0)
})

test('读后感、导出 Markdown、跨书回顾', async () => {
  llm.reply = () => '# 孤独的甲\n我读这本书，觉得甲很孤独。'
  const r = await N.writeReview(llm, id)
  assert.match(r.text, /孤独的甲/)
  assert.match(calls.at(-1).system, /不要编造/)
  const md = N.notesMarkdown({ title: '书', author: '' }, await N.getNotes(id))
  assert.match(md, /^# 《书》读书心得/)
  assert.match(md, /## 读后感/)
  assert.match(md, /## 第一章 开端/)
  assert.match(md, /<summary>原话<\/summary>/)
  llm.reply = () => '这段时间你读了一本书。'
  const re = await N.reflect(llm, { days: 7 })
  assert.equal(re.notes, 1)
  assert.equal(re.books, 1)
  assert.equal((await N.allNotes({ query: '孤独' })).length, 1)
  assert.equal((await N.allNotes({ query: '不存在' })).length, 0)
})

test('知识库插件：按名字、说明和参数认出「存笔记」的工具', () => {
  const p = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required })
  assert.deepEqual(sinkFields({ name: 'kb_save_note', description: '保存一条笔记到知识库', parameters: p({ title: { type: 'string' }, content: { type: 'string' } }) }), { content: 'content', title: 'title' })
  assert.equal(sinkFields({ name: 'kb_search', description: '在知识库里搜索', parameters: p({ query: { type: 'string' } }) }), null, '只读的不算')
  assert.equal(sinkFields({ name: 'notes_add', description: 'Add a note', parameters: p({ text: { type: 'string' }, folderId: { type: 'string' } }) }), null, '有填不了的必填参数')
  assert.equal(sinkFields({ name: 'audiobook_add_note', description: '记心得 save note', parameters: p({ text: { type: 'string' } }) }), null, '不导给自己')
  assert.equal(sinkFields({ name: 'bash', description: 'run a command', parameters: p({ command: { type: 'string' } }) }), null)
})

test('导入：发现假的笔记插件和起居注目录，都能导进去；找不到的位置说清楚', async () => {
  const got = []
  const tools = {
    defs: [{ name: 'mynotes_create', description: 'Create a note in my notebook', parameters: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['markdown'] }, execute: async (a) => { got.push(a) } }],
    schemas() { return this.defs.map(({ name, description, parameters }) => ({ name, description, parameters })) },
    get(n) { return this.defs.find(d => d.name === n) },
  }
  // 只有日记文件夹、profile 里没装 dsh-memex：不出起居注
  await mkdir(join(home, '.dsh', 'memex'), { recursive: true })
  assert.ok(!detectTargets({ tools }).some(t => t.id === 'memex'))
  const prof = join(home, '.dsh', 'profiles', 'desktop')
  await mkdir(prof, { recursive: true })
  await writeFile(join(prof, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pick': '1' }, dsh: { profile: { bundles: ['dsh-pick'] } } }))
  assert.ok(!detectTargets({ tools, plugins: profilePlugins('desktop') }).some(t => t.id === 'memex'))
  // 装了 dsh-memex，日记目录按它的配置走
  await writeFile(join(prof, 'package.json'), JSON.stringify({ dependencies: { 'dsh-memex': '1' }, dsh: { profile: { bundles: ['dsh-memex'] } } }))
  await writeFile(join(prof, 'cordis.patch.yml'), `- id: dsh-memex\n  config:\n    outputDir: "~/diary"\n`)
  const plugins = profilePlugins('desktop')
  assert.equal(plugins.memexDir, join(home, 'diary'))
  const targets = detectTargets({ tools, plugins })
  const ids = targets.map(t => t.id)
  assert.ok(ids.includes('tool:mynotes_create'))
  assert.ok(ids.includes('memex'))
  const doc = { title: '《书》读书心得', markdown: '# 《书》读书心得\n\n内容', html: '<div>内容</div>' }
  assert.match(await sendTo('tool:mynotes_create', doc, { tools }), /mynotes_create/)
  assert.deepEqual(got[0], { markdown: doc.markdown, title: doc.title })
  await sendTo('memex', doc, { tools, plugins })
  const file = join(home, 'diary', '读书心得', '《书》读书心得.md')
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file, 'utf8'), doc.markdown)
  await assert.rejects(sendTo('tool:nope', doc, { tools }), /找不到这个导入位置/)
})
