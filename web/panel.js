// web/panel.js — 朗读面板：书库（导入、书单）和朗读页（正文、播放条、目录、声音、语速、定时）
//
// 路由：#/ 书库 · #/book/<id> 朗读页。进度每读一段存一次（服务器 + 本机），换设备、关掉面板都接得上。

import { createPlayer } from './player.js'
import { initTalk } from './talk.js'

const $ = sel => document.querySelector(sel)
const app = $('#app')
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ago = t => {
  if (!t) return '还没听过'
  const d = Date.now() - t
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`
  return `${Math.floor(d / 86400e3)} 天前`
}
const local = {
  get(k, d) { try { const v = localStorage.getItem('audiobook:' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('audiobook:' + k, JSON.stringify(v)) } catch { /* 隐私模式：只是不记住 */ } },
}

async function api(path, body) {
  const init = body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-audiobook': '1' },
    body: JSON.stringify(body),
  }
  const r = await fetch(path, init)
  let j = {}
  try { j = await r.json() } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`)
  return j
}

let toastTimer
function toast(text) {
  let el = $('.toast')
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el) }
  el.textContent = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 3000)
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 4a8 8 0 1 0 8 8"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite"/></path></svg>',
}

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]
const SLEEPS = [[0, '不定时'], [15, '15 分钟'], [30, '30 分钟'], [45, '45 分钟'], [60, '1 小时'], [90, '1.5 小时'], [-1, '读完本章']]
const ENGINE_LABEL = { browser: '浏览器朗读', edge: '微软 Edge', kokoro: '本地离线' }

// ———————————————————— 全局状态 ————————————————————

const S = {
  status: null,
  settings: null,
  voices: null, // 服务器上的声音
  book: null,
  segs: [],
  chapter: -1, // 正文区显示的是第几章
  sleepEnd: 0, // 定时停止的时刻（毫秒）；-1 = 读完本章
  sleepChapter: -1,
  userScrollAt: 0,
}

const player = createPlayer({
  audio: $('#player'),
  api,
  onSeg: seg => onSeg(seg),
  onState: s => renderTransport(s),
  onError: msg => toast(msg),
  onFinish: () => { toast('这本书读完了'); saveProgress(S.segs.length - 1) },
})

// 🎙 记心得、💬 问 AI、心得本、我的心得
const talk = initTalk({
  api, esc, toast, $, S, player, local,
  openSheet: (...a) => openSheet(...a),
  closeSheet: () => closeSheet(),
  currentVoice: () => currentVoice(),
  jumpTo: (seg) => {
    if (player.state === 'playing' || player.state === 'loading') player.play(seg)
    else player.seek(seg)
  },
})

// ———————————————————— 进度 ————————————————————

let saveTimer
function saveProgress(seg) {
  if (!S.book) return
  const id = S.book.id
  local.set('pos:' + id, { seg, at: Date.now() })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => api('progress', { id, seg }).then((p) => { if (S.book && S.book.id === id) S.lastServerSeg = p.seg }).catch(() => {}), 600)
}

const chapterOf = (seg) => {
  const list = S.book.chapters
  let k = 0
  while (k + 1 < list.length && list[k + 1].seg <= seg) k++
  return k
}
const chapterEnd = k => (k + 1 < S.book.chapters.length ? S.book.chapters[k + 1].seg : S.segs.length)

function onSeg(seg) {
  if (!S.book) return
  const k = chapterOf(seg)
  // 定时：读完本章 —— 刚跨进下一章就停
  if (S.sleepEnd === -1 && S.sleepChapter >= 0 && k !== S.sleepChapter && (player.state === 'playing' || player.state === 'loading')) {
    S.sleepEnd = 0
    S.sleepChapter = -1
    setTimeout(() => { player.pause(); renderTools() }, 0)
    toast('定时到了：本章读完')
  }
  if (k !== S.chapter) renderChapter(k)
  highlight(seg)
  renderWhere()
  saveProgress(seg)
  updateMediaSession()
}

// ———————————————————— 书库 ————————————————————

async function showLibrary() {
  player.stop()
  S.book = null
  $('#back').hidden = true
  $('#brand').textContent = '搜书听'
  app.className = ''
  document.querySelector('.dock')?.remove()
  closeSheet()
  // 面板开在别的机器上（比如手机打开 VPS 上的 DSH）时，「填路径」填的是服务器上的路径，容易误会：
  // 这时把「选择文件」当主按钮，路径框说清楚是服务器上的
  const remote = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname)
  app.innerHTML = `
    <div class="card">
      <h3>搜书</h3>
      <div class="row">
        <input class="input grow" id="q" placeholder="书名、作者，或者记得的角色名、情节" value="${esc(S.lastQuery || '')}">
        <button class="btn primary" id="q-go">搜索</button>
      </div>
      <div class="faint" style="margin-top:6px">在古腾堡计划、维基文库、Internet Archive、Standard Ebooks 这些公版和授权免费的书源里找，找到直接加入书架。受版权保护的现代书这里没有。</div>
      <div id="found"></div>
      <div id="elsewhere"></div>
      <div id="web"></div>
    </div>
    <div class="card">
      <div class="drop" id="drop">
        <div class="big">导入一本书</div>
        <div class="muted small">${remote ? '从这台设备（手机、电脑）上选一本书' : '把文件拖到这里，或'} <button class="btn ${remote ? 'primary' : ''}" id="pick">选择文件</button></div>
        <div class="faint" style="margin-top:6px">TXT · EPUB · PDF · DOCX · Markdown · HTML · RTF</div>
        <input type="file" id="file" hidden accept=".txt,.text,.md,.markdown,.html,.htm,.xhtml,.epub,.docx,.pdf,.rtf,.doc">
      </div>
      <div class="row" style="margin-top:10px">
        <input class="input grow" id="path" placeholder="${remote ? '或者填服务器上的文件路径' : '或者填这台电脑上的文件路径，如 ~/Downloads/书.epub'}">
        <button class="btn" id="go">导入</button>
      </div>
      <div class="faint" id="import-msg" style="margin-top:6px"></div>
    </div>
    <div class="row lib-head"><b class="grow">书架</b><button class="btn" id="all-notes">我的心得</button></div>
    <div id="books"><div class="empty">正在读书库…</div></div>`
  const msg = $('#import-msg')
  const done = (b) => { msg.textContent = ''; location.hash = `#/book/${b.id}` }
  const fail = (e) => { msg.textContent = e.message; msg.style.color = 'var(--bad)' }
  const busy = (t) => { msg.textContent = t; msg.style.color = '' }
  const upload = async (file) => {
    busy(`正在导入《${file.name}》…`)
    try {
      const r = await fetch(`upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'x-audiobook': '1' }, body: file,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `导入失败（${r.status}）`)
      done(j.book)
    } catch (e) { fail(e) }
  }
  $('#pick').onclick = () => $('#file').click()
  $('#file').onchange = e => { const f = e.target.files[0]; if (f) upload(f) }
  const drop = $('#drop')
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) upload(f) }
  const byPath = async () => {
    const p = $('#path').value.trim()
    if (!p) return
    busy('正在导入…')
    try { done((await api('import', { path: p })).book) } catch (e) { fail(e) }
  }
  $('#go').onclick = byPath
  $('#path').onkeydown = e => { if (e.key === 'Enter') byPath() }

  $('#all-notes').onclick = () => talk.openAllNotes()
  $('#q-go').onclick = () => runSearch($('#q').value)
  $('#q').onkeydown = e => { if (e.key === 'Enter') runSearch($('#q').value) }
  if (S.lastFound) renderFound(S.lastFound)
  if (S.lastWeb) renderWeb(S.lastWeb)
  api('settings').then((st) => { S.settings = st; renderElsewhere() }).catch(() => {})
  loadBooks()
}

/** 书单 */
async function loadBooks() {
  let books = []
  try { books = (await api('books')).books } catch (e) { if ($('#books')) $('#books').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
  // 等书单的时候用户可能已经点进某本书了
  if (!$('#books')) return
  $('#books').innerHTML = books.length ? books.map(b => `
    <div class="card book" data-id="${esc(b.id)}">
      <div class="cover">${esc([...b.title][0] || '书')}</div>
      <div class="grow">
        <div class="t">${esc(b.title)}</div>
        <div class="meta">${esc(b.author ? b.author + ' · ' : '')}${b.listenedAt ? `听到「${esc(b.chapterTitle)}」 · ${b.percent}%` : `${b.chapters} 章 · 约 ${Math.max(1, Math.round(b.chars / 10000))} 万字`} · ${ago(b.listenedAt)}</div>
        <div class="bar"><i style="width:${b.percent}%"></i></div>
      </div>
      <button class="icon-btn more" data-more="${esc(b.id)}" title="删除、改书名…" aria-label="更多操作">⋯</button>
    </div>`).join('') : '<div class="empty">书库还是空的。导入一本书，或者在上面搜一本，就能开始听。</div>'
  for (const el of document.querySelectorAll('.book')) {
    el.onclick = (e) => {
      if (e.target.closest('[data-more]')) return
      location.hash = `#/book/${el.dataset.id}`
    }
  }
  for (const btn of document.querySelectorAll('[data-more]')) {
    btn.onclick = () => openBookMenu(books.find(b => b.id === btn.dataset.more))
  }
}

// ———————————————————— 搜书 ————————————————————

async function runSearch(q) {
  q = String(q || '').trim()
  if (!q) return
  S.lastQuery = q
  S.lastWeb = null
  renderElsewhere()
  const box = $('#found')
  box.innerHTML = '<div class="faint" style="margin-top:10px">正在搜书源…（让 AI 猜书名、再去各书源找，大约几秒到十几秒）</div>'
  $('#web').innerHTML = '<div class="faint" style="margin-top:12px">正在网页搜索…</div>'
  // 网页搜索慢一些，各搜各的，谁先好先显示谁
  api(`websearch?q=${encodeURIComponent(q)}`)
    .then((w) => { if (S.lastQuery === q) { S.lastWeb = { ...w, query: q }; renderWeb(S.lastWeb) } })
    .catch((e) => { if (S.lastQuery === q) { S.lastWeb = { available: false, results: [], error: e.message, query: q }; renderWeb(S.lastWeb) } })
  try {
    const f = await api(`search?q=${encodeURIComponent(q)}`)
    if (S.lastQuery !== q) return
    S.lastFound = f
    renderFound(f)
  } catch (e) { box.innerHTML = `<div class="note" style="color:var(--bad)">${esc(e.message)}</div>` }
}

/** 「去别处搜」：自定义的网页搜索地址，点了在浏览器新窗口打开 */
function renderElsewhere() {
  const box = $('#elsewhere')
  if (!box || !S.settings) return
  const webs = (S.settings.customSources || []).filter(c => c.kind === 'web')
  const opds = (S.settings.customSources || []).filter(c => c.kind === 'opds')
  const q = S.lastQuery || ''
  box.innerHTML = `<div class="row elsewhere">
    <span class="faint">去别处搜：</span>
    ${webs.map(c => q ? `<a class="link" target="_blank" rel="noopener" href="${esc(c.url.replace('{q}', encodeURIComponent(q)))}">${esc(c.name)}</a>` : `<span class="faint">${esc(c.name)}</span>`).join('<span class="faint">·</span>')}
    ${opds.length ? `<span class="faint">｜我的书库：${opds.map(c => esc(c.name)).join('、')}（结果合在上面）</span>` : ''}
    <button class="btn ghost small" id="manage-src">管理搜索地址</button>
  </div>`
  $('#manage-src').onclick = openSources
}

/** 网页搜索结果：只给链接，在浏览器里打开，由用户自己判断 */
function renderWeb(w) {
  const box = $('#web')
  if (!box) return
  if (!w.available) {
    box.innerHTML = w.error ? `<div class="faint" style="margin-top:10px">网页搜索没成功：${esc(w.error)}。可以在 DSH 的「插件 → 网页搜索」里检查设置，或者点上面的「去别处搜」。</div>` : ''
    return
  }
  box.innerHTML = `<h3 style="margin:16px 0 4px">网页搜索</h3>` + (w.results.length ? `<div class="hits">${w.results.map(r => {
    let host = ''
    try { host = new URL(r.url).host.replace(/^www\./, '') } catch { /* 不是网址 */ }
    return `<div class="hit">
      <div class="grow">
        <div class="t">${esc(r.title)}</div>
        <div class="meta">${esc(host)}${r.snippet ? ' · ' + esc(r.snippet) : ''}</div>
      </div>
      <a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">打开</a>
    </div>`
  }).join('')}</div>
  <div class="faint" style="margin-top:6px">网页上下载到的书，可以用下面的「导入」加进书架。请只下载有授权的书。</div>` : '<div class="faint">网页搜索没有结果。</div>')
}

/** 管理自定义搜索地址：网页（在浏览器打开）或 OPDS 书库（结果合进书源结果，可直接加入书架） */
function openSources() {
  let list = (S.settings.customSources || []).map(c => ({ ...c }))
  const draw = () => {
    const body = $('#sheet-body')
    if (!body) return
    body.innerHTML = `
      <div class="src-list">${list.map((c, k) => `
        <div class="hit">
          <div class="grow"><div class="t">${esc(c.name)} <span class="badge">${c.kind === 'opds' ? 'OPDS 书库' : '网页'}</span></div><div class="meta">${esc(c.url)}</div></div>
          <button class="btn ghost" data-up="${k}" ${k ? '' : 'disabled'} title="往前挪">↑</button>
          <button class="btn danger" data-del="${k}">删除</button>
        </div>`).join('') || '<div class="faint">没有自定义地址</div>'}</div>
      <h3 style="margin:16px 0 6px">添加</h3>
      <div class="row">
        <input class="input" id="s-name" placeholder="名字，如 豆瓣" style="width:8em">
        <select class="input" id="s-kind"><option value="web">网页</option><option value="opds">OPDS 书库</option></select>
      </div>
      <div class="row" style="margin-top:6px">
        <input class="input grow" id="s-url" placeholder="地址，用 {q} 代表要搜的词，如 https://www.baidu.com/s?wd={q}">
        <button class="btn" id="s-add">添加</button>
      </div>
      <p class="note">网页：点名字就在浏览器里打开那个网站的搜索结果。OPDS 书库：Calibre、calibre-web、Kavita 这类自建书库的搜索地址（Calibre 内容服务器是 http://地址:8080/opds/search/{q}），结果会合在上面的书源结果里，可以直接加入书架。</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="s-save">保存</button><button class="btn ghost" id="s-reset">恢复默认</button><span class="faint" id="s-msg"></span></div>`
    for (const b of body.querySelectorAll('[data-del]')) b.onclick = () => { list.splice(Number(b.dataset.del), 1); draw() }
    for (const b of body.querySelectorAll('[data-up]')) b.onclick = () => { const k = Number(b.dataset.up); [list[k - 1], list[k]] = [list[k], list[k - 1]]; draw() }
    $('#s-add').onclick = () => {
      const name = $('#s-name').value.trim()
      const url = $('#s-url').value.trim()
      if (!name || !url) { $('#s-msg').textContent = '名字和地址都要填'; return }
      if (!url.includes('{q}')) { $('#s-msg').textContent = '地址里要有 {q}'; return }
      list.push({ name, url, kind: $('#s-kind').value })
      draw()
    }
    $('#s-reset').onclick = () => { list = null; save() }
    $('#s-save').onclick = () => save()
  }
  const save = async () => {
    try {
      const r = await api('settings', { customSources: list === null ? 'default' : list })
      S.settings = r.settings
      closeSheet()
      renderElsewhere()
      toast('搜索地址已保存')
    } catch (e) { const m = $('#s-msg'); if (m) m.textContent = e.message }
  }
  openSheet('搜索地址', '', draw)
}

function renderFound(f) {
  const box = $('#found')
  if (!box) return
  const guesses = f.guesses.length && f.results.length ? `<div class="note">AI 认为你找的可能是：${f.guesses.map(g =>
    `<b>《${esc(g.title || g.original)}》</b>${g.author ? esc(g.author) : ''}${g.found ? '' : '<span class="faint">（书源里没有，多半还在版权期内）</span>'}`).join('；')}</div>` : ''
  const notes = [f.note, f.failed.length ? `${f.failed.join('、')}暂时连不上，结果可能不全` : ''].filter(Boolean).map(t => `<div class="faint">${esc(t)}</div>`).join('')
  const list = f.results.length ? f.results.map((r, k) => `
    <div class="hit">
      <div class="grow">
        <div class="t">${esc(r.title)} <span class="badge">${esc(r.sourceLabel)}</span>${r.guess >= 0 ? ' <span class="badge ok">AI 猜的</span>' : ''}</div>
        <div class="meta">${esc(r.author || '')}${r.snippet ? `${r.author ? ' · ' : ''}${esc(r.snippet)}` : ''}</div>
      </div>
      <a class="link" href="${esc(r.link)}" target="_blank" rel="noopener">看看</a>
      <button class="btn" data-hit="${k}">加入书架</button>
    </div>`).join('') : f.guesses.length
    ? `<div class="note">合规书源里没有${f.guesses.map(g => `《${esc(g.title || g.original)}》`).join('、')}。这里只有公版书和授权免费的书，这几本多半还在版权期内：可以买正版电子书，再用下面的「导入」读给你听。</div>`
    : `<div class="note">没搜到「${esc(f.query)}」。换个说法试试：书名、作者，或者书里的角色名、情节；外国书可以用原文书名。</div>`
  box.innerHTML = guesses + notes + `<div class="hits">${list}</div>`
  for (const b of box.querySelectorAll('[data-hit]')) {
    b.onclick = async () => {
      const r = f.results[Number(b.dataset.hit)]
      b.disabled = true
      b.textContent = r.source.startsWith('wikisource') ? '下载中…（整部导出可能要一两分钟）' : '下载中…'
      try {
        const j = await api('download', { source: r.source, ref: r.ref, author: r.author || '', title: r.title || '', catalog: r.catalog })
        b.textContent = '已加入，去听 ›'
        b.disabled = false
        b.classList.add('primary')
        b.onclick = () => { location.hash = `#/book/${j.book.id}` }
        toast(`《${j.book.title}》已加入书架`)
        loadBooks()
      } catch (e) {
        b.disabled = false
        b.textContent = '重试'
        toast(e.message)
      }
    }
  }
}

/** 书单里一本书的操作：继续听、改书名 / 作者、从头听、删除 */
function openBookMenu(b) {
  if (!b) return
  openSheet(`《${b.title}》`, `
    <div class="faint" style="margin-bottom:10px">${esc(b.author ? b.author + ' · ' : '')}${esc(b.format.toUpperCase())} · ${b.chapters} 章 · ${b.listenedAt ? `听到「${esc(b.chapterTitle)}」${b.percent}%` : '还没听过'}</div>
    <div class="field"><label>书名</label><input class="input" id="m-title" value="${esc(b.title)}"></div>
    <div class="field"><label>作者</label><input class="input" id="m-author" value="${esc(b.author)}"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="m-open">${b.listenedAt ? '继续听' : '开始听'}</button>
      <button class="btn" id="m-save">保存书名和作者</button>
      <button class="btn" id="m-reset" ${b.seg ? '' : 'disabled'}>从头开始</button>
      <span class="grow"></span>
      <button class="btn danger" id="m-del">删除</button>
    </div>`, () => {
    $('#m-open').onclick = () => { closeSheet(); location.hash = `#/book/${b.id}` }
    $('#m-save').onclick = async () => {
      try { await api('rename', { id: b.id, title: $('#m-title').value, author: $('#m-author').value }); closeSheet(); loadBooks() } catch (e) { toast(e.message) }
    }
    $('#m-reset').onclick = async () => {
      try { await api('progress', { id: b.id, seg: 0 }); local.set('pos:' + b.id, { seg: 0, at: Date.now() }); closeSheet(); loadBooks(); toast('已回到开头') } catch (e) { toast(e.message) }
    }
    $('#m-del').onclick = async () => {
      if (!confirm(`删除《${b.title}》？收听进度和声音缓存也会删掉（原文件不受影响）。`)) return
      try { await api('delete', { id: b.id }); closeSheet(); loadBooks(); toast('已删除') } catch (e) { toast(e.message) }
    }
  })
}

// ———————————————————— 朗读页 ————————————————————

/** 书主要是中文还是英文（选默认声音用） */
function bookLang() {
  const sample = S.segs.slice(0, 30).join('')
  const cjk = (sample.match(/[㐀-鿿]/g) || []).length
  return cjk > sample.length * 0.2 ? 'zh' : 'en'
}

/** 当前朗读方式和声音：设置里没选过、或选的声音这台设备没有，就挑一个合适的 */
function currentVoice() {
  const s = S.settings
  let engine = s.engine || (S.status && S.status.edge && S.status.edge.ready ? 'edge' : 'browser')
  if (engine === 'kokoro' && !(S.status && S.status.kokoro && S.status.kokoro.ready)) engine = 'browser'
  if (engine === 'edge' && !(S.status && S.status.edge && S.status.edge.ready)) engine = 'browser'
  let voice = s.voices[engine] || ''
  if (engine === 'browser') {
    const list = player.browserVoices()
    if (!list.some(v => v.voiceURI === voice)) {
      const lang = bookLang()
      const pref = lang === 'zh' ? [/^zh[-_]CN/i, /^zh/i] : [/^en[-_]US/i, /^en/i]
      const local1 = list.filter(v => v.localService !== false)
      voice = ''
      for (const re of pref) {
        const hit = local1.find(v => re.test(v.lang) && /premium|enhanced|高级|增强|優化/i.test(v.name)) || local1.find(v => re.test(v.lang)) || list.find(v => re.test(v.lang))
        if (hit) { voice = hit.voiceURI; break }
      }
    }
  }
  if (engine === 'edge' && !voice) voice = bookLang() === 'zh' ? 'zh-CN-YunxiNeural' : 'en-US-AndrewNeural'
  if (engine === 'kokoro' && !voice) voice = 'f01'
  return { engine, voice }
}

function applyVoice() {
  const { engine, voice } = currentVoice()
  player.setVoice(engine, voice)
  player.setRate(S.settings.rate || 1)
}

async function showBook(id) {
  let j
  try {
    ;[j, S.status, S.settings] = await Promise.all([api(`book?id=${encodeURIComponent(id)}`), api('status'), api('settings')])
  } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
  S.book = j.book
  S.segs = j.segs
  S.chapter = -1
  // 进度：服务器和本机取较新的
  const mine = local.get('pos:' + id, null)
  const srv = j.progress || { seg: 0 }
  const seg = mine && mine.at > (srv.updatedAt || 0) ? mine.seg : srv.seg || 0
  S.lastServerSeg = srv.seg || 0

  $('#back').hidden = false
  $('#brand').textContent = S.book.title
  app.className = 'reading'
  app.innerHTML = `<div class="chapter-title" id="ct"></div><div class="reader" id="reader"></div>
    <div class="chapter-nav"><button class="btn ghost" id="prev-ch">‹ 上一章</button><button class="btn ghost" id="next-ch">下一章 ›</button></div>`
  $('#prev-ch').onclick = () => jumpChapter(S.chapter - 1)
  $('#next-ch').onclick = () => jumpChapter(S.chapter + 1)
  $('#reader').onclick = (e) => {
    const sp = e.target.closest('span[data-s]')
    if (!sp) return
    const s = Number(sp.dataset.s)
    if (player.state === 'playing' || player.state === 'loading') player.play(s)
    else player.seek(s)
  }
  mountDock()
  player.load(S.book, S.segs, seg)
  applyVoice()
  renderChapter(chapterOf(seg))
  highlight(seg, 'auto')
  renderWhere()
  renderTools()
  renderTransport('stopped')
  updateMediaSession()
  talk.loadNotes()
}

function jumpChapter(k) {
  if (!S.book || k < 0 || k >= S.book.chapters.length) return
  const s = S.book.chapters[k].seg
  if (player.state === 'playing' || player.state === 'loading') player.play(s)
  else player.seek(s)
  window.scrollTo({ top: 0 })
}

/** 正文区：显示第 k 章，每个朗读段一个 span（段里的 \n 是分段） */
function renderChapter(k) {
  S.chapter = k
  const ch = S.book.chapters[k]
  $('#ct').textContent = `${k + 1} / ${S.book.chapters.length} · ${ch.title}`
  const end = chapterEnd(k)
  let html = ''
  for (let s = ch.seg; s < end; s++) {
    S.segs[s].split('\n').forEach((part, n) => {
      // 章首、段里的每个 \n 都开新段落
      if (n > 0 || s === ch.seg) html += (html ? '</p>' : '') + '<p>'
      if (part) html += `<span data-s="${s}">${esc(part)}</span>`
    })
  }
  $('#reader').innerHTML = html + (html ? '</p>' : '')
  talk.markNotes()
  $('#prev-ch').disabled = k === 0
  $('#next-ch').disabled = k >= S.book.chapters.length - 1
}

function highlight(seg, behavior = 'smooth') {
  for (const el of document.querySelectorAll('#reader span.cur')) el.classList.remove('cur')
  const spans = document.querySelectorAll(`#reader span[data-s="${seg}"]`)
  for (const el of spans) el.classList.add('cur')
  // 用户刚翻过页就别抢着滚回去
  if (spans[0] && Date.now() - S.userScrollAt > 5000) spans[0].scrollIntoView({ block: 'center', behavior })
}
for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, () => { S.userScrollAt = Date.now() }, { passive: true })

// ———————————————————— 播放条 ————————————————————

function mountDock() {
  document.querySelector('.dock')?.remove()
  const dock = document.createElement('div')
  dock.className = 'dock'
  dock.innerHTML = `<div class="dock-inner">
    <div class="where"><span class="ct" id="d-ch"></span><span id="d-pct"></span></div>
    <input type="range" id="d-range" min="0" value="0" aria-label="全书进度">
    <div class="transport">
      <button class="side" id="d-ask" title="问 AI：刚听到的内容、人物、词语">💬<span>问 AI</span></button>
      <button class="skip" id="d-prev" title="上一段（←）">« 上一段</button>
      <button class="playbtn" id="d-play" aria-label="播放 / 暂停（空格）"></button>
      <button class="skip" id="d-next" title="下一段（→）">下一段 »</button>
      <button class="side" id="d-note" title="记心得：按住说话">🎙<span>记心得</span></button>
    </div>
    <div class="tools">
      <button id="t-toc">目录</button>
      <button id="t-notes">心得</button>
      <button id="t-voice">声音</button>
      <button id="t-rate">语速</button>
      <button id="t-sleep">定时</button>
    </div></div>`
  document.body.appendChild(dock)
  const range = $('#d-range')
  range.max = String(Math.max(0, S.segs.length - 1))
  range.oninput = () => { $('#d-pct').textContent = pct(Number(range.value)) }
  range.onchange = () => { const s = Number(range.value); if (player.state === 'playing' || player.state === 'loading') player.play(s); else player.seek(s) }
  $('#d-play').onclick = () => { player.toggle() }
  $('#d-prev').onclick = () => step(-1)
  $('#d-next').onclick = () => step(1)
  $('#t-toc').onclick = openToc
  $('#t-notes').onclick = () => talk.openNotebook()
  $('#d-ask').onclick = () => talk.openAsk()
  $('#d-note').onclick = () => talk.openVoiceNote()
  $('#t-voice').onclick = openVoice
  $('#t-rate').onclick = openRate
  $('#t-sleep').onclick = openSleep
}

const pct = seg => `${S.segs.length > 1 ? (Math.round((seg / (S.segs.length - 1)) * 1000) / 10) : 0}%`

function step(d) {
  const s = Math.max(0, Math.min(S.segs.length - 1, player.seg + d))
  if (player.state === 'playing' || player.state === 'loading') player.play(s)
  else player.seek(s)
}

function renderWhere() {
  if (!$('#d-ch')) return
  const seg = player.seg
  $('#d-ch').textContent = S.book.chapters[chapterOf(seg)].title
  $('#d-pct').textContent = pct(seg)
  $('#d-range').value = String(seg)
}

function renderTransport(state) {
  const b = $('#d-play')
  if (!b) return
  b.innerHTML = state === 'playing' ? ICON.pause : state === 'loading' ? ICON.wait : ICON.play
  b.classList.toggle('loading', state === 'loading')
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : state === 'stopped' ? 'none' : 'paused'
}

function renderTools() {
  if (!$('#t-rate')) return
  const { engine } = currentVoice()
  $('#t-voice').textContent = ENGINE_LABEL[engine]
  $('#t-rate').textContent = `语速 ${S.settings.rate || 1}×`
  const sl = $('#t-sleep')
  if (S.sleepEnd === -1) { sl.textContent = '读完本章停'; sl.classList.add('on') }
  else if (S.sleepEnd > Date.now()) {
    const left = Math.ceil((S.sleepEnd - Date.now()) / 1000)
    sl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后停`
    sl.classList.add('on')
  } else { sl.textContent = '定时'; sl.classList.remove('on') }
}

// 定时停止：每秒看一眼
setInterval(() => {
  if (S.sleepEnd > 0 && Date.now() >= S.sleepEnd) {
    S.sleepEnd = 0
    player.pause()
    toast('定时到了，已暂停')
  }
  if (S.sleepEnd) renderTools()
}, 1000)

// ———————————————————— 弹出层 ————————————————————

function openSheet(title, body, onMount) {
  closeSheet()
  const back = document.createElement('div')
  back.className = 'sheet-back'
  back.onclick = closeSheet
  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.innerHTML = `<div class="sheet-inner"><h3>${esc(title)}<button class="btn ghost x" id="sheet-x">关闭</button></h3><div id="sheet-body">${body}</div></div>`
  document.body.append(back, sheet)
  $('#sheet-x').onclick = closeSheet
  if (onMount) onMount(sheet)
}
function closeSheet() {
  document.querySelector('.sheet')?.remove()
  document.querySelector('.sheet-back')?.remove()
  clearInterval(S.pollStatus)
}

function openToc() {
  const cur = chapterOf(player.seg)
  const list = S.book.chapters.map((c, k) => `<a data-k="${k}" class="${k === cur ? 'cur' : ''}"><span class="n">${k + 1}</span><span>${esc(c.title)}</span></a>`).join('')
  openSheet(`目录 · ${S.book.chapters.length} 章`, `<div class="toc">${list}</div>
    <div class="row" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <span class="faint grow">${esc(S.book.author || '')} · ${S.book.format.toUpperCase()} · 约 ${Math.max(1, Math.round(S.book.chars / 10000))} 万字</span>
      <button class="btn" id="rename">改书名</button>
      <button class="btn danger" id="del">删除这本书</button>
    </div>`, (sheet) => {
    for (const a of sheet.querySelectorAll('.toc a')) a.onclick = () => { closeSheet(); jumpChapter(Number(a.dataset.k)) }
    sheet.querySelector('.toc a.cur')?.scrollIntoView({ block: 'center' })
    $('#rename').onclick = async () => {
      const t = prompt('书名', S.book.title)
      if (!t || !t.trim()) return
      try { S.book = (await api('rename', { id: S.book.id, title: t })).book; $('#brand').textContent = S.book.title; closeSheet() } catch (e) { toast(e.message) }
    }
    $('#del').onclick = async () => {
      if (!confirm(`删除《${S.book.title}》？收听进度和声音缓存也会删掉（原文件不受影响）。`)) return
      try { await api('delete', { id: S.book.id }); closeSheet(); location.hash = '#/' } catch (e) { toast(e.message) }
    }
  })
}

function openRate() {
  const cur = S.settings.rate || 1
  openSheet('语速', `<div class="opts">${RATES.map(r => `<button class="btn ${r === cur ? 'on' : ''}" data-r="${r}">${r}×</button>`).join('')}</div>
    <p class="note">换语速不用重新合成：微软 Edge 和本地语音由播放器加速，音调不变。</p>`, (sheet) => {
    for (const b of sheet.querySelectorAll('[data-r]')) b.onclick = async () => {
      S.settings.rate = Number(b.dataset.r)
      player.setRate(S.settings.rate)
      renderTools()
      closeSheet()
      api('settings', { rate: S.settings.rate }).catch(() => {})
    }
  })
}

function openSleep() {
  const curKey = S.sleepEnd === -1 ? -1 : S.sleepEnd > Date.now() ? 'on' : 0
  openSheet('定时停止', `<div class="opts">${SLEEPS.map(([m, l]) => `<button class="btn ${m === curKey ? 'on' : ''}" data-m="${m}">${l}</button>`).join('')}</div>
    ${S.sleepEnd > Date.now() ? `<p class="note">还有 ${Math.ceil((S.sleepEnd - Date.now()) / 60000)} 分钟停止。</p>` : ''}`, (sheet) => {
    for (const b of sheet.querySelectorAll('[data-m]')) b.onclick = () => {
      const m = Number(b.dataset.m)
      if (m === -1) { S.sleepEnd = -1; S.sleepChapter = chapterOf(player.seg) }
      else { S.sleepEnd = m ? Date.now() + m * 60000 : 0; S.sleepChapter = -1 }
      renderTools()
      closeSheet()
    }
  })
}

async function openVoice() {
  const { engine } = currentVoice()
  let tab = engine
  let showAll = false
  openSheet('声音', '<div class="empty">正在读声音列表…</div>', async () => {
    try { [S.voices, S.status] = await Promise.all([api('voices'), api('status')]) } catch (e) { $('#sheet-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    draw()
  })
  const choose = async (eng, voice) => {
    S.settings.engine = eng
    S.settings.voices[eng] = voice
    applyVoice()
    renderTools()
    draw()
    try { await api('settings', { engine: eng, voices: { [eng]: voice } }) } catch (e) { toast(e.message) }
  }
  const sample = (eng) => {
    // 试听：从当前这段开始读
    if (currentVoice().engine !== eng) return
    player.play(player.seg)
  }
  function draw() {
    const body = $('#sheet-body')
    if (!body) return
    const active = currentVoice()
    const tabs = ['browser', 'edge', 'kokoro'].map(e => `<button data-tab="${e}" class="${e === tab ? 'on' : ''}">${ENGINE_LABEL[e]}${e === active.engine ? ' ✓' : ''}</button>`).join('')
    let inner = ''
    if (tab === 'browser') {
      const list = player.browserVoices()
      const lang = bookLang()
      const sameLang = v => (lang === 'zh' ? /^(zh|cmn|yue)/i : /^en/i).test(v.lang)
      // 高级 / 增强版排前面，苹果那几个「趣味」声音排后面
      const rank = v => (/premium|enhanced|高级|增强|優化|优化/i.test(v.name) ? 0 : /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/.test(v.name) ? 2 : 1)
      const shown = (showAll ? list : list.filter(sameLang))
      const pool = shown.length ? shown : list
      const sorted = [...pool].sort((a, b) => (sameLang(b) - sameLang(a)) || rank(a) - rank(b) || (/^yue/i.test(a.lang) - /^yue/i.test(b.lang)) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
      inner = list.length ? `<div class="field"><label class="row"><span class="grow">这台设备上的${showAll || !shown.length ? '' : lang === 'zh' ? '中文' : '英文'}声音（${pool.length} 个）</span>
        <span><input type="checkbox" id="v-all" ${showAll ? 'checked' : ''}> 显示所有语言</span></label>
        <select class="input" id="v-sel">${sorted.map(v => `<option value="${esc(v.voiceURI)}" ${active.engine === 'browser' && v.voiceURI === active.voice ? 'selected' : ''}>${esc(v.name)}（${esc(v.lang)}）${v.localService === false ? ' · 在线' : ''}</option>`).join('')}</select></div>
        <div class="row"><button class="btn primary" id="v-use">用这个声音</button></div>
        <p class="note">不用安装，用的是这台设备自带的语音，声音不出这台设备。Mac 上想要更自然的声音：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音…，下载带「高级」或「增强」的中文声音。手机锁屏后浏览器朗读可能会停，锁屏听用微软 Edge 或本地离线。</p>`
        : '<p class="note">这个浏览器没有提供朗读声音。换成微软 Edge 或本地离线。</p>'
    } else if (tab === 'edge') {
      const e = S.status.edge || {}
      inner = e.ready ? `<div class="field"><label>微软在线神经网络语音</label>
        <select class="input" id="v-sel">${S.voices.edge.voices.map(v => `<option value="${esc(v.id)}" ${active.engine === 'edge' && v.id === active.voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
        <div class="row"><button class="btn primary" id="v-use">用这个声音</button><button class="btn" id="v-up">更新 Edge 语音组件</button></div>
        <p class="note">最自然的中文朗读。要联网：文字会发到微软的服务器合成。这不是微软公开的正式接口，可能哪天失效；失效时先点「更新 Edge 语音组件」。</p>`
        : e.error ? `<p class="note" style="color:var(--bad)">${esc(e.error)}</p><div class="row"><button class="btn primary" id="v-inst">重试安装</button></div>
        <p class="note">Edge 语音组件是开源的 edge-tts，插件会自己装在 ~/.dsh/dsh-audiobook 里，不需要管理员权限。</p>`
        : `<p class="note">正在自动安装 Edge 语音组件（开源的 edge-tts，装在插件自己的目录里），一般几秒到一分钟。装好就能用，不用做任何事。</p><div class="bar"><i style="width:60%"></i></div>`    } else {
      const k = S.status.kokoro || {}
      const d = k.download
      inner = k.ready ? `<div class="field"><label>本地离线中文语音（Kokoro，100 个声音）</label>
        <select class="input" id="v-sel">${S.voices.kokoro.voices.map(v => `<option value="${esc(v.id)}" ${active.engine === 'kokoro' && v.id === active.voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
        <div class="row"><button class="btn primary" id="v-use">用这个声音</button></div>
        <p class="note">在这台电脑上合成，不联网、不上传文字。听感比微软 Edge 生硬一些，读英文一般。第一段要等模型加载几秒。</p>`
        : d && d.running ? `<p class="note">正在下载本地中文语音模型：${Math.round(d.got / 1048576)} / ${Math.round(d.total / 1048576)} MB</p><div class="bar"><i style="width:${Math.round((d.got / d.total) * 100)}%"></i></div>`
        : `<p class="note">要先下载本地中文语音模型（Kokoro，约 147 MB，从 GitHub 下载）。下好之后完全离线，文字不出这台电脑。${d && d.error ? `<br><span style="color:var(--bad)">${esc(d.error)}</span>` : ''}</p>
        <div class="row"><button class="btn primary" id="v-dl">下载模型</button></div>`
    }
    body.innerHTML = `<div class="seg-tabs">${tabs}</div>${inner}`
    for (const b of body.querySelectorAll('[data-tab]')) b.onclick = () => { tab = b.dataset.tab; draw() }
    const all = $('#v-all')
    if (all) all.onchange = () => { showAll = all.checked; draw() }
    const use = $('#v-use')
    if (use) use.onclick = async () => { await choose(tab, $('#v-sel').value); sample(tab) }
    const inst = $('#v-inst') || $('#v-up')
    if (inst) inst.onclick = async () => {
      inst.disabled = true
      inst.textContent = '正在安装…（几秒到一分钟）'
      try { const r = await api('edge/install', {}); S.status.edge = { ready: r.ready, version: r.version }; toast('Edge 语音组件装好了') } catch (e) { toast(e.message) }
      draw()
    }
    if (tab === 'edge' && !(S.status.edge || {}).ready && !(S.status.edge || {}).error) {
      clearInterval(S.pollStatus)
      S.pollStatus = setInterval(async () => {
        try { S.status = await api('status') } catch { return }
        const ee = S.status.edge || {}
        if (ee.ready || ee.error) { clearInterval(S.pollStatus); S.voices = await api('voices'); draw(); renderTools() }
      }, 2000)
    }
    const dl = $('#v-dl')
    if (dl) dl.onclick = async () => {
      try { await api('kokoro/install', {}) } catch (e) { toast(e.message); return }
      clearInterval(S.pollStatus)
      S.pollStatus = setInterval(async () => {
        try { S.status = await api('status') } catch { return }
        const kk = S.status.kokoro || {}
        if (kk.ready || !(kk.download && kk.download.running)) {
          clearInterval(S.pollStatus)
          if (kk.ready) S.voices = await api('voices')
        }
        draw()
      }, 1000)
      S.status.kokoro.download = { running: true, got: 0, total: 147031220 }
      draw()
    }
  }
}

// ———————————————————— 锁屏 / 耳机线控、快捷键 ————————————————————

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !S.book) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.book.chapters[chapterOf(player.seg)].title,
      artist: S.book.author || '搜书听',
      album: S.book.title,
    })
  } catch { /* 老浏览器 */ }
}
if ('mediaSession' in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn) } catch { /* 不支持这个动作 */ } }
  set('play', () => player.resume())
  set('pause', () => player.pause())
  set('previoustrack', () => step(-1))
  set('nexttrack', () => step(1))
  set('seekbackward', () => step(-1))
  set('seekforward', () => step(1))
}

document.addEventListener('keydown', (e) => {
  if (!S.book || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === ' ') { e.preventDefault(); player.toggle() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
})

// AI 在对话里改了收听位置（audiobook_goto）：没在读的时候每几秒看一眼，跟上
setInterval(async () => {
  if (!S.book || player.state === 'playing' || player.state === 'loading' || document.hidden) return
  try {
    const p = await api(`progress?id=${encodeURIComponent(S.book.id)}`)
    if (Number.isInteger(p.seg) && p.seg !== S.lastServerSeg) {
      S.lastServerSeg = p.seg
      if (p.seg !== player.seg) { player.seek(p.seg); toast('收听位置已更新') }
    }
  } catch { /* 下次再看 */ }
}, 4000)

// ———————————————————— 路由 ————————————————————

function route() {
  const m = /^#\/book\/([a-z0-9-]+)/.exec(location.hash)
  if (m) showBook(m[1])
  else showLibrary()
}
window.addEventListener('hashchange', route)
$('#back').onclick = () => { location.hash = '#/' }
// 在 DSH 右侧栏的 iframe 里时，给一个「新窗口打开」
if (window.top !== window.self) $('#popout').hidden = false
api('status').then((s) => { S.status = s; if (s.version) $('#ver').textContent = 'v' + s.version }).catch(() => {})
route()
