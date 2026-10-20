// web/panel.js — 朗读面板：书库（导入、书单）和朗读页（正文、播放条、目录、声音、语速、定时）
//
// 路由：#/ 书库 · #/book/<id> 朗读页。进度每读一段存一次（服务器 + 本机），换设备、关掉面板都接得上。

import { createPlayer } from './player.js'

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
  audios: [$('#a0'), $('#a1')],
  api,
  onSeg: seg => onSeg(seg),
  onState: s => renderTransport(s),
  onError: msg => toast(msg),
  onFinish: () => { toast('这本书读完了'); saveProgress(S.segs.length - 1) },
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
  app.innerHTML = `
    <div class="card">
      <div class="drop" id="drop">
        <div class="big">导入一本书</div>
        <div class="muted small">把文件拖到这里，或 <button class="btn" id="pick">选择文件</button></div>
        <div class="faint" style="margin-top:6px">TXT · EPUB · PDF · DOCX · Markdown · HTML · RTF</div>
        <input type="file" id="file" hidden accept=".txt,.text,.md,.markdown,.html,.htm,.xhtml,.epub,.docx,.pdf,.rtf,.doc">
      </div>
      <div class="row" style="margin-top:10px">
        <input class="input grow" id="path" placeholder="或者填这台电脑上的文件路径，如 ~/Downloads/书.epub">
        <button class="btn" id="go">导入</button>
      </div>
      <div class="faint" id="import-msg" style="margin-top:6px"></div>
    </div>
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

  let books = []
  try { books = (await api('books')).books } catch (e) { $('#books').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
  $('#books').innerHTML = books.length ? books.map(b => `
    <div class="card book" data-id="${esc(b.id)}">
      <div class="cover">${esc([...b.title][0] || '书')}</div>
      <div class="grow">
        <div class="t">${esc(b.title)}</div>
        <div class="meta">${esc(b.author ? b.author + ' · ' : '')}${b.listenedAt ? `听到「${esc(b.chapterTitle)}」 · ${b.percent}%` : `${b.chapters} 章 · 约 ${Math.max(1, Math.round(b.chars / 10000))} 万字`} · ${ago(b.listenedAt)}</div>
        <div class="bar"><i style="width:${b.percent}%"></i></div>
      </div>
    </div>`).join('') : '<div class="empty">书库还是空的。导入一本书，就能开始听。</div>'
  for (const el of document.querySelectorAll('.book')) el.onclick = () => { location.hash = `#/book/${el.dataset.id}` }
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
      <button class="skip" id="d-prev" title="上一段（←）">« 上一段</button>
      <button class="playbtn" id="d-play" aria-label="播放 / 暂停（空格）"></button>
      <button class="skip" id="d-next" title="下一段（→）">下一段 »</button>
    </div>
    <div class="tools">
      <button id="t-toc">目录</button>
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
      const ready = S.status.edge && S.status.edge.ready
      inner = ready ? `<div class="field"><label>微软在线神经网络语音</label>
        <select class="input" id="v-sel">${S.voices.edge.voices.map(v => `<option value="${esc(v.id)}" ${active.engine === 'edge' && v.id === active.voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
        <div class="row"><button class="btn primary" id="v-use">用这个声音</button><button class="btn" id="v-up">更新 Edge 语音组件</button></div>
        <p class="note">最自然的中文朗读。要联网：文字会发到微软的服务器合成。这不是微软公开的正式接口，可能哪天失效；失效时先点「更新 Edge 语音组件」。</p>`
        : `<p class="note">要先装 Edge 语音组件（开源的 edge-tts，装在插件自己的 Python 虚拟环境里，约 10 MB，要有 Python 3）。装好后要联网使用：文字会发到微软的服务器合成。</p>
        <div class="row"><button class="btn primary" id="v-inst">安装 Edge 语音组件</button></div>`
    } else {
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
      inst.textContent = '正在安装…（约半分钟）'
      try { const r = await api('edge/install', {}); S.status.edge = { ready: r.ready, version: r.version }; toast('Edge 语音组件装好了') } catch (e) { toast(e.message) }
      draw()
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
