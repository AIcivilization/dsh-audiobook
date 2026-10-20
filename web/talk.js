// web/talk.js — 和书说话：🎙 语音记心得、💬 问 AI、心得本、我的心得（跨书）
//
// 语音输入：按住说话、松开识别；轻点一下就进入「一直录，再点一下结束」。录音传到 DSH 所在的机器上本地识别，只存文字。
// 心得默认只存原话，想整理时再点「AI 整理」（原话保留）。

import { startRecording } from './recorder.js'

/**
 * @param {object} d panel.js 给的公共东西：
 *   api, esc, toast, openSheet, closeSheet, $, S（全局状态）, player, currentVoice(), jumpTo(seg)
 */
export function initTalk(d) {
  const { api, esc, toast, openSheet, closeSheet, $, S, player } = d
  let notes = [] // 当前这本书的心得
  let reviews = []
  const fmtTime = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

  // ———————————————————— 心得的记号 ————————————————————

  async function loadNotes() {
    if (!S.book) return
    try { ({ notes, reviews } = await api(`notes?id=${encodeURIComponent(S.book.id)}`)) } catch { notes = []; reviews = [] }
    markNotes()
  }
  /** 正文里有心得的段落标个记号 */
  function markNotes() {
    const segs = new Set(notes.map(n => n.seg))
    for (const el of document.querySelectorAll('#reader span[data-s]')) el.classList.toggle('noted', segs.has(Number(el.dataset.s)))
    const b = $('#t-notes')
    if (b) b.textContent = notes.length ? `心得 ${notes.length}` : '心得'
  }

  /** 暂停朗读；返回「要不要接着读」 */
  function pausePlayer() {
    const was = player.state === 'playing' || player.state === 'loading'
    if (was) player.pause()
    return was
  }

  // ———————————————————— 按住说话 ————————————————————

  /**
   * 把一个按钮变成「按住说话」：识别出的文字交给 onText
   * @param {HTMLElement} btn
   * @param {{ onText: (t: string) => void, status: HTMLElement, label?: string }} o
   */
  function holdToTalk(btn, o) {
    const label = o.label || '按住说话'
    let state = 'idle' // idle | holding | latched | busy
    let rec = null
    let downAt = 0
    let lastBlob = null
    const show = (t, err) => { o.status.textContent = t; o.status.style.color = err ? 'var(--bad)' : '' }
    const setBtn = (t, on) => { btn.textContent = t; btn.classList.toggle('on', Boolean(on)) }
    setBtn(label)

    async function begin() {
      try {
        rec = await startRecording({
          onLevel: (lv, sec) => { btn.style.setProperty('--lv', lv.toFixed(2)); show(`正在听… ${Math.floor(sec)} 秒${state === 'latched' ? '（再点一下结束）' : '（松开结束）'}`) },
          onLimit: () => finish(),
        })
      } catch (e) { state = 'idle'; setBtn(label); show(e.message, true); return false }
      return true
    }
    async function transcribe(blob) {
      state = 'busy'
      setBtn('识别中…')
      show('正在识别…')
      try {
        const r = await fetch('asr', { method: 'POST', credentials: 'same-origin', headers: { 'x-audiobook': '1', 'content-type': 'audio/wav' }, body: blob })
        const j = await r.json().catch(() => ({}))
        if (r.status === 409 && j.code === 'NO_MODEL') { lastBlob = blob; return needModel() }
        if (!r.ok) throw new Error(j.error || `识别失败（${r.status}）`)
        lastBlob = null
        if (j.text) { o.onText(j.text); show('') } else show('没听清，再说一次？', true)
      } catch (e) { show(e.message, true) }
      state = 'idle'
      setBtn(label)
    }
    async function finish() {
      if (!rec) return
      const r = rec
      rec = null
      btn.style.removeProperty('--lv')
      const { blob, seconds } = await r.stop()
      if (seconds < 0.4) { state = 'idle'; setBtn(label); show('太短了，按住多说一会儿'); return }
      await transcribe(blob)
    }
    // 第一次用：下载识别模型，下好接着识别刚才那段
    async function needModel() {
      state = 'idle'
      setBtn(label)
      o.status.innerHTML = `第一次语音输入要下载识别模型（约 241 MB，本机识别，声音不外传）。<button class="btn small" id="asr-dl">下载</button>`
      o.status.querySelector('#asr-dl').onclick = async () => {
        try { await api('asr/install', {}) } catch (e) { show(e.message, true); return }
        const timer = setInterval(async () => {
          let st
          try { st = await api('status') } catch { return }
          const a = st.asr || {}
          if (a.ready) { clearInterval(timer); show('模型下好了'); if (lastBlob) transcribe(lastBlob); return }
          const dl = a.download
          if (dl && !dl.running && dl.error) { clearInterval(timer); show(dl.error, true); return }
          if (dl) show(`正在下载识别模型：${Math.round(dl.got / 1048576)} / ${Math.round(dl.total / 1048576)} MB`)
        }, 1500)
      }
    }

    btn.addEventListener('pointerdown', async (e) => {
      e.preventDefault()
      if (state === 'busy') return
      if (state === 'latched') { state = 'holding'; return finish() }
      state = 'holding'
      downAt = Date.now()
      setBtn('松开结束', true)
      try { btn.setPointerCapture(e.pointerId) } catch { /* 不支持 */ }
      if (!await begin()) return
      // 录音权限弹窗期间可能已经松手了
      if (state === 'idle') finish()
    })
    const up = () => {
      if (state !== 'holding') return
      // 轻点：一直录，再点一下结束
      if (Date.now() - downAt < 400) { state = 'latched'; setBtn('再点一下结束', true); return }
      state = 'idle'
      finish()
    }
    btn.addEventListener('pointerup', up)
    btn.addEventListener('pointercancel', up)
    btn.addEventListener('contextmenu', e => e.preventDefault())
    return { cancel() { if (rec) { rec.cancel(); rec = null } state = 'idle' } }
  }

  // ———————————————————— 🎙 记心得 ————————————————————

  function openVoiceNote() {
    if (!S.book) return
    const resume = pausePlayer()
    const seg = player.seg
    let talk = null
    openSheet('记心得', `
      <div class="quote">${esc(S.segs[seg].replace(/\s+/g, ' ').slice(0, 120))}</div>
      <div class="rec-wrap"><button class="rec" id="n-rec"></button></div>
      <div class="faint center" id="n-st">按住说话，松开就转成文字；也可以直接打字</div>
      <textarea class="input area" id="n-text" rows="4" placeholder="你的想法…"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="n-save">${resume ? '保存，接着听' : '保存心得'}</button>
        <button class="btn" id="n-ask">拿去问 AI</button>
        <span class="grow"></span>
        <button class="btn ghost" id="n-cancel">不记了</button>
      </div>`, () => {
      const area = $('#n-text')
      talk = holdToTalk($('#n-rec'), { status: $('#n-st'), onText: (t) => { area.dataset.voice = '1'; area.value = area.value.trim() ? `${area.value.trim()}\n${t}` : t } })
      const done = (play) => { talk.cancel(); closeSheet(); if (play && resume) player.resume() }
      $('#n-cancel').onclick = () => done(true)
      $('#n-save').onclick = async () => {
        const text = area.value.trim()
        if (!text) { $('#n-st').textContent = '还没有内容'; return }
        try {
          const r = await api('note', { id: S.book.id, seg, text, source: area.dataset.voice ? 'voice' : 'typed' })
          notes.push(r.note)
          markNotes()
          toast('心得记下了')
          done(true)
        } catch (e) { toast(e.message) }
      }
      $('#n-ask').onclick = () => { const q = area.value.trim(); talk.cancel(); openAsk({ preset: q, resume }) }
    })
  }

  // ———————————————————— 💬 问 AI ————————————————————

  const CHIPS = {
    book: ['刚才这段讲了什么？', '出场的人物都是谁，什么关系？', '这段里有不好懂的词或典故吗？', '帮我回顾一下前情', '你怎么看刚才这段？'],
    notes: ['看看我的心得，你怎么看？', '我的想法前后有变化吗？', '还有哪些值得我再想想的问题？'],
  }
  let speaking = null // 正在读的回答

  function stopSpeaking() {
    if (!speaking) return
    try { speaking.pause && speaking.pause() } catch { /* 已停 */ }
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    speaking = null
  }

  /** 用当前选的声音把一段回答读出来 */
  async function speak(text) {
    stopSpeaking()
    const { engine, voice } = d.currentVoice()
    const rate = (S.settings && S.settings.rate) || 1
    if (engine === 'browser') {
      if (!('speechSynthesis' in window)) return
      const u = new SpeechSynthesisUtterance(text)
      const v = player.browserVoices().find(x => x.voiceURI === voice)
      if (v) { u.voice = v; u.lang = v.lang }
      u.rate = rate
      speaking = { pause() { speechSynthesis.cancel() } }
      speechSynthesis.speak(u)
      return
    }
    const r = await fetch('say', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-audiobook': '1' },
      body: JSON.stringify({ text, engine, voice }),
    })
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || '读不出来') }
    const a = new Audio(URL.createObjectURL(await r.blob()))
    a.playbackRate = rate
    speaking = a
    a.onended = () => { URL.revokeObjectURL(a.src); if (speaking === a) speaking = null }
    await a.play()
  }

  /**
   * @param {{ mode?: 'book'|'notes', preset?: string, resume?: boolean }} [o]
   */
  async function openAsk(o = {}) {
    if (!S.book) return
    const mode = o.mode || 'book'
    const resume = o.resume ?? pausePlayer()
    let messages = []
    try { messages = (await api(`chat?id=${encodeURIComponent(S.book.id)}`)).messages } catch { /* 没有记录 */ }
    let talk = null
    const autoRead = () => d.local.get('readAnswers', true)
    const spoilers = () => d.local.get('spoilers', false)
    openSheet(mode === 'notes' ? '和 AI 聊聊我的心得' : `问 AI · 《${S.book.title}》`, `
      <div class="chat" id="c-list"></div>
      <div class="chips" id="c-chips">${CHIPS[mode].map(c => `<button class="chip">${esc(c)}</button>`).join('')}</div>
      <div class="ask-row">
        <textarea class="input area" id="c-in" rows="2" placeholder="问点什么，或者说说你的想法">${esc(o.preset || '')}</textarea>
        <div class="ask-btns"><button class="rec small" id="c-rec"></button><button class="btn primary" id="c-send">发送</button></div>
      </div>
      <div class="row faint" style="margin-top:6px">
        <span id="c-st" class="grow"></span>
        <label><input type="checkbox" id="c-read" ${autoRead() ? 'checked' : ''}> 回答读出来</label>
        <label><input type="checkbox" id="c-spoil" ${spoilers() ? 'checked' : ''}> 允许剧透</label>
        <button class="btn ghost small" id="c-clear">清空记录</button>
      </div>
      <div class="faint" style="margin-top:4px">AI 只看到本章开头到你正在听的这段${mode === 'notes' ? '，和你这本书的心得' : ''}；不勾「允许剧透」时不会讲后面的情节。</div>`, () => {
      const list = $('#c-list')
      const input = $('#c-in')
      const draw = () => {
        list.innerHTML = messages.length ? messages.map((m, k) => `
          <div class="msg ${m.role}">
            <div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>
            ${m.role === 'ai' ? `<div class="msg-act"><button class="link-btn" data-read="${k}">🔊 读出来</button><button class="link-btn" data-keep="${k}">存为心得</button></div>` : ''}
          </div>`).join('') : '<div class="faint center">问问刚听到的内容、人物、词语，或者说说你的想法。</div>'
        list.scrollTop = list.scrollHeight
        for (const b of list.querySelectorAll('[data-read]')) b.onclick = () => speak(messages[Number(b.dataset.read)].text).catch(e => toast(e.message))
        for (const b of list.querySelectorAll('[data-keep]')) {
          b.onclick = async () => {
            const k = Number(b.dataset.keep)
            const q = messages[k - 1] && messages[k - 1].role === 'user' ? `问：${messages[k - 1].text}\n` : ''
            try {
              const r = await api('note', { id: S.book.id, seg: messages[k].seg ?? player.seg, text: `${q}AI：${messages[k].text}`, source: 'ai' })
              notes.push(r.note); markNotes(); b.textContent = '已存'; b.disabled = true
            } catch (e) { toast(e.message) }
          }
        }
      }
      draw()
      const st = $('#c-st')
      const send = async (text) => {
        const q = String(text || input.value).trim()
        if (!q) return
        input.value = ''
        messages = messages.concat([{ role: 'user', text: q, seg: player.seg }, { role: 'ai', text: '…' }])
        draw()
        st.textContent = '正在想…'
        try {
          const r = await api('ask', { id: S.book.id, seg: player.seg, question: q, spoilers: $('#c-spoil').checked, mode })
          messages = r.messages
          st.textContent = ''
          draw()
          if ($('#c-read') && $('#c-read').checked) speak(r.answer).catch(e => toast(e.message))
        } catch (e) {
          messages = messages.slice(0, -2)
          draw()
          input.value = q
          st.textContent = e.message
        }
      }
      $('#c-send').onclick = () => send()
      input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } }
      for (const c of document.querySelectorAll('#c-chips .chip')) c.onclick = () => send(c.textContent)
      // 语音提问：说完直接发出去
      talk = holdToTalk($('#c-rec'), { status: st, label: '🎙', onText: t => send(t) })
      $('#c-read').onchange = () => { d.local.set('readAnswers', $('#c-read').checked); if (!$('#c-read').checked) stopSpeaking() }
      $('#c-spoil').onchange = () => d.local.set('spoilers', $('#c-spoil').checked)
      $('#c-clear').onclick = async () => {
        if (!confirm('清空这本书和 AI 的讨论记录？（心得不受影响）')) return
        try { await api('chat/clear', { id: S.book.id }); messages = []; draw() } catch (e) { toast(e.message) }
      }
      if (o.preset) input.focus()
      // 关掉对话：停止朗读回答，原来在听就接着听
      const x = $('#sheet-x')
      const back = document.querySelector('.sheet-back')
      const close = () => { talk.cancel(); stopSpeaking(); closeSheet(); if (resume) player.resume() }
      x.onclick = close
      if (back) back.onclick = close
    })
  }

  // ———————————————————— 心得本 ————————————————————

  async function openNotebook() {
    if (!S.book) return
    await loadNotes()
    let targets = []
    try { targets = (await api('targets')).targets } catch { /* 没有 */ }
    openSheet(`心得本 · 《${S.book.title}》`, '<div id="nb"></div>', () => draw())

    function draw() {
      const box = $('#nb')
      if (!box) return
      const sorted = [...notes].sort((a, b) => a.seg - b.seg || a.createdAt - b.createdAt)
      let chapter = null
      const items = sorted.map((n) => {
        const head = n.chapter !== chapter ? `<div class="group-title">${esc((chapter = n.chapter) || '（未分章）')}</div>` : ''
        const showRaw = n.polished && n._raw
        return `${head}<div class="note" data-id="${esc(n.id)}">
          <div class="quote link-quote" data-jump="${n.seg}" title="跳到这里接着听">${esc(n.quote)}</div>
          <div class="note-text">${esc(showRaw ? n.text : (n.polished || n.text)).replace(/\n/g, '<br>')}</div>
          <div class="note-meta">
            <span class="faint">${fmtTime(n.createdAt)}${n.source === 'voice' ? ' · 语音' : n.source === 'ai' ? ' · 和 AI 的讨论' : ''}${n.polished ? ` · <button class="link-btn" data-raw="${esc(n.id)}">${showRaw ? '看整理版' : '看原话'}</button>` : ''}</span>
            <span class="grow"></span>
            ${n.polished ? '' : `<button class="link-btn" data-polish="${esc(n.id)}">AI 整理</button>`}
            <button class="link-btn" data-edit="${esc(n.id)}">编辑</button>
            <button class="link-btn danger" data-del="${esc(n.id)}">删除</button>
          </div>
        </div>`
      }).join('')
      box.innerHTML = `
        <div class="row nb-actions">
          <button class="btn primary" id="nb-add">🎙 记一条</button>
          <button class="btn" id="nb-chat" ${notes.length ? '' : 'disabled'}>和 AI 聊聊我的心得</button>
          <button class="btn" id="nb-review" ${notes.length ? '' : 'disabled'}>AI 写读后感</button>
          <a class="btn" href="notes/export?id=${encodeURIComponent(S.book.id)}" ${notes.length || reviews.length ? '' : 'hidden'}>导出 Markdown</a>
        </div>
        ${targets.length && (notes.length || reviews.length) ? `<div class="row nb-actions"><span class="faint">导入到：</span>${targets.map(t => `<button class="btn small" data-target="${esc(t.id)}" title="${esc(t.detail)}">${esc(t.label)}</button>`).join('')}</div>` : ''}
        <div class="faint" id="nb-st"></div>
        ${reviews.map(r => `<div class="review"><div class="row"><b class="grow">读后感 · ${fmtTime(r.createdAt)}</b><button class="link-btn" data-copy="${esc(r.id)}">复制</button><button class="link-btn danger" data-rdel="${esc(r.id)}">删除</button></div><div class="note-text">${esc(r.text.replace(/^#+\s*/gm, '')).replace(/\n/g, '<br>')}</div></div>`).join('')}
        ${items || '<div class="empty">还没有心得。听书时点 🎙，按住说出你的想法就记下来了。</div>'}`
      const st = $('#nb-st')
      $('#nb-add').onclick = () => { closeSheet(); openVoiceNote() }
      $('#nb-chat').onclick = () => openAsk({ mode: 'notes', resume: false })
      $('#nb-review').onclick = async () => {
        st.textContent = '正在按你的心得写读后感…（半分钟左右）'
        try { const r = await api('review', { id: S.book.id }); reviews.unshift(r.review); st.textContent = ''; draw() } catch (e) { st.textContent = e.message }
      }
      for (const b of box.querySelectorAll('[data-target]')) {
        b.onclick = async () => {
          b.disabled = true
          st.textContent = `正在导入到 ${b.textContent}…`
          try { st.textContent = (await api('notes/send', { id: S.book.id, target: b.dataset.target })).message } catch (e) { st.textContent = e.message }
          b.disabled = false
        }
      }
      for (const b of box.querySelectorAll('[data-jump]')) b.onclick = () => { closeSheet(); d.jumpTo(Number(b.dataset.jump)) }
      const find = id => notes.find(n => n.id === id)
      for (const b of box.querySelectorAll('[data-raw]')) b.onclick = () => { const n = find(b.dataset.raw); n._raw = !n._raw; draw() }
      for (const b of box.querySelectorAll('[data-polish]')) {
        b.onclick = async () => {
          b.textContent = '整理中…'
          b.disabled = true
          try { const r = await api('note/polish', { id: S.book.id, note: b.dataset.polish }); Object.assign(find(r.note.id), r.note); draw() } catch (e) { st.textContent = e.message; b.textContent = 'AI 整理'; b.disabled = false }
        }
      }
      for (const b of box.querySelectorAll('[data-edit]')) {
        b.onclick = () => {
          const n = find(b.dataset.edit)
          const el = box.querySelector(`.note[data-id="${CSS.escape(n.id)}"] .note-text`)
          const editingPolished = Boolean(n.polished && !n._raw)
          el.innerHTML = `<textarea class="input area" rows="4">${esc(editingPolished ? n.polished : n.text)}</textarea>
            <div class="row" style="margin-top:6px"><button class="btn primary small" data-ok>保存</button><button class="btn ghost small" data-no>取消</button>
            <span class="faint">${editingPolished ? '改的是整理版，原话不变' : n.polished ? '改了原话，整理版会删掉' : ''}</span></div>`
          el.querySelector('[data-no]').onclick = draw
          el.querySelector('[data-ok]').onclick = async () => {
            const v = el.querySelector('textarea').value
            try {
              const r = await api('note/edit', { id: S.book.id, note: n.id, ...(editingPolished ? { polished: v } : { text: v }) })
              Object.assign(n, r.note)
              if (!r.note.polished) delete n.polished
              draw()
            } catch (e) { st.textContent = e.message }
          }
        }
      }
      for (const b of box.querySelectorAll('[data-del]')) {
        b.onclick = async () => {
          if (!confirm('删除这条心得？')) return
          try { await api('note/delete', { id: S.book.id, note: b.dataset.del }); notes = notes.filter(n => n.id !== b.dataset.del); markNotes(); draw() } catch (e) { st.textContent = e.message }
        }
      }
      for (const b of box.querySelectorAll('[data-rdel]')) {
        b.onclick = async () => {
          if (!confirm('删除这篇读后感？')) return
          try { await api('review/delete', { id: S.book.id, review: b.dataset.rdel }); reviews = reviews.filter(r => r.id !== b.dataset.rdel); draw() } catch (e) { st.textContent = e.message }
        }
      }
      for (const b of box.querySelectorAll('[data-copy]')) {
        b.onclick = async () => {
          const r = reviews.find(x => x.id === b.dataset.copy)
          try { await navigator.clipboard.writeText(r.text); b.textContent = '已复制' } catch { toast('复制不了：手动选中文字复制') }
        }
      }
    }
  }

  // ———————————————————— 我的心得（跨书） ————————————————————

  async function openAllNotes() {
    let days = d.local.get('notesDays', 30)
    let query = ''
    openSheet('我的心得', `
      <div class="row">
        <input class="input grow" id="an-q" placeholder="在所有心得里搜">
        <select class="input" id="an-days">${[[7, '最近 7 天'], [30, '最近 30 天'], [365, '最近一年'], [0, '全部']].map(([v, l]) => `<option value="${v}" ${v === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn" id="an-reflect">AI 帮我回顾</button>
      </div>
      <div class="faint" id="an-st" style="margin-top:6px"></div>
      <div id="an-reflection"></div>
      <div id="an-list"><div class="empty">正在读…</div></div>`, () => {
      const load = async () => {
        let list = []
        try { list = (await api(`notes/all?days=${days}&q=${encodeURIComponent(query)}`)).notes } catch (e) { $('#an-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
        let book = null
        $('#an-list').innerHTML = list.length ? list.map(n => `${n.bookTitle !== book ? `<div class="group-title">《${esc(book = n.bookTitle)}》</div>` : ''}
          <div class="note"><div class="quote link-quote" data-book="${esc(n.bookId)}" data-seg="${n.seg}">${esc(n.chapter)}：${esc(n.quote)}</div>
          <div class="note-text">${esc(n.polished || n.text).replace(/\n/g, '<br>')}</div><div class="faint">${fmtTime(n.createdAt)}</div></div>`).join('')
          : '<div class="empty">这段时间没有心得。</div>'
        for (const q of document.querySelectorAll('#an-list [data-book]')) {
          q.onclick = async () => {
            // 跳到那本书的那个位置
            try { await api('progress', { id: q.dataset.book, seg: Number(q.dataset.seg) }) } catch { /* 进度没改成也能打开书 */ }
            d.local.set('pos:' + q.dataset.book, { seg: Number(q.dataset.seg), at: Date.now() })
            closeSheet()
            location.hash = `#/book/${q.dataset.book}`
          }
        }
      }
      let timer
      $('#an-q').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { query = e.target.value.trim(); load() }, 300) }
      $('#an-days').onchange = (e) => { days = Number(e.target.value); d.local.set('notesDays', days); load() }
      $('#an-reflect').onclick = async () => {
        const st = $('#an-st')
        st.textContent = '正在回顾…（半分钟左右）'
        try {
          const r = await api('reflect', { days })
          st.textContent = `回顾了 ${r.books} 本书的 ${r.notes} 条心得`
          $('#an-reflection').innerHTML = `<div class="review"><div class="note-text">${esc(r.text).replace(/\n/g, '<br>')}</div></div>`
        } catch (e) { st.textContent = e.message }
      }
      load()
    })
  }

  return { loadNotes, markNotes, openVoiceNote, openAsk, openNotebook, openAllNotes, stopSpeaking }
}
