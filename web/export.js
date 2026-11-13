// web/export.js — 文本转音频下载：选书、选范围和声音，后台转成 MP3（可带字幕），做好了下载
//
// 入口：书库页的「文本转音频下载」、每本书「⋯」里的「转成音频下载」、朗读页播放条的「下载音频」。

/**
 * @param {object} d panel.js 给的：api, esc, toast, $, S, local, openSheet, closeSheet, currentVoice()
 */
export function initExport(d) {
  const { api, esc, $, S, openSheet, closeSheet } = d
  const ENGINE = { edge: '微软 Edge（最自然，要联网）', kokoro: '本地离线（不联网）' }
  const dur = (s) => {
    s = Math.round(s || 0)
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return h ? `${h} 小时 ${m} 分钟` : m ? `${m} 分钟` : `${s} 秒`
  }
  const size = b => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
  let poll = null

  /** 没指定书：先选一本 */
  async function pickBook() {
    let books = []
    try { books = (await api('books')).books } catch (e) { d.toast(e.message); return }
    openSheet('文本转音频下载', books.length ? `
      <p class="note" style="margin-top:0">选一本书，转成 MP3 下载（可以只转几章，可以带字幕），放到手机、MP3、Walkman 里听。</p>
      <div class="pick-list">${books.map(b => `<button class="pick" data-id="${esc(b.id)}"><span class="t">${esc(b.title)}</span><span class="faint">${esc(b.author ? b.author + ' · ' : '')}${b.chapters} 章 · ${b.chars < 10000 ? `${b.chars} 字` : `约 ${Math.round(b.chars / 10000)} 万字`}</span></button>`).join('')}</div>`
      : '<div class="empty">书架还是空的：先搜一本或者导入一本。</div>', () => {
      for (const b of document.querySelectorAll('.pick[data-id]')) b.onclick = () => open(b.dataset.id)
    })
  }

  /**
   * 一本书的导出面板
   * @param {string} [id] 书；不给就先选书
   */
  async function open(id) {
    if (!id) return pickBook()
    let book
    let status
    let voices
    let settings
    try {
      ;[{ book }, status, voices, settings] = await Promise.all([api(`book?id=${encodeURIComponent(id)}`), api('status'), api('voices'), api('settings')])
    } catch (e) { d.toast(e.message); return }
    const chs = book.chapters
    const reading = S.book && S.book.id === id
    const curCh = reading ? chs.reduce((a, c, k) => (c.seg <= d.playerSeg() ? k : a), 0) : 0
    // 默认声音：正在用的服务器语音；用的是浏览器朗读就默认 Edge
    const cv = d.currentVoice()
    let engine = cv.engine === 'kokoro' && status.kokoro.ready ? 'kokoro' : 'edge'
    const pickVoice = e => (cv.engine === e ? cv.voice : settings.voices[e]) || (e === 'edge' ? 'zh-CN-YunxiNeural' : 'f01')
    let voice = pickVoice(engine)
    const opt = { from: 0, to: chs.length - 1, split: d.local.get('exportSplit', 'one'), subs: d.local.get('exportSubs', true) }
    let jobs = [] // 这本书转过的
    let sample = null // 正在试听的

    openSheet(`文本转音频 · 《${book.title}》`, '<div id="ex"></div>', () => { draw(); refresh() })

    function chapterOptions(sel) {
      return chs.map((c, k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${k + 1}. ${esc(c.title.length > 24 ? c.title.slice(0, 23) + '…' : c.title)}</option>`).join('')
    }
    function voiceOptions() {
      const list = engine === 'edge' ? voices.edge.voices : voices.kokoro.voices
      return list.map(v => `<option value="${esc(v.id)}" ${v.id === voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('')
    }

    function draw() {
      const box = $('#ex')
      if (!box) return
      const whole = opt.from === 0 && opt.to === chs.length - 1
      const ready = engine === 'edge' ? status.edge.ready : status.kokoro.ready
      box.innerHTML = `
        <div class="field"><label>转哪些</label>
          <div class="row">
            <button class="btn small ${whole ? 'on' : ''}" id="x-all">全本（${chs.length} 章）</button>
            ${reading ? `<button class="btn small ${opt.from === curCh && opt.to === curCh ? 'on' : ''}" id="x-cur">正在听的这章</button>` : ''}
          </div>
          ${chs.length > 1 ? `<div class="row" style="margin-top:6px"><span class="faint">从</span><select class="input grow" id="x-from">${chapterOptions(opt.from)}</select></div>
          <div class="row" style="margin-top:4px"><span class="faint">到</span><select class="input grow" id="x-to">${chapterOptions(opt.to)}</select></div>` : ''}
        </div>
        <div class="field"><label>用什么声音</label>
          <div class="seg-tabs">${['edge', 'kokoro'].map(e => `<button data-eng="${e}" class="${e === engine ? 'on' : ''}">${ENGINE[e]}</button>`).join('')}</div>
          ${ready ? `<div class="row"><select class="input grow" id="x-voice">${voiceOptions()}</select><button class="btn" id="x-try">试听</button></div>`
            : `<p class="note" style="margin:0">${engine === 'edge' ? 'Edge 语音组件还没装好（插件会自动装，稍等一下再打开这里）。' : '本地离线语音要先下载模型：在朗读页的「声音 → 本地离线」里下载。'}</p>`}
          <p class="note" style="margin:4px 0 0">浏览器朗读的声音在你自己的设备上，存不成文件，所以这里只有这两种。</p>
        </div>
        <div class="field"><label>做成</label>
          <label class="radio"><input type="radio" name="x-split" value="one" ${opt.split === 'one' ? 'checked' : ''}> 一个 MP3（${chs.length > 1 ? '章与章之间停 1.5 秒' : '整篇'}）</label>
          ${opt.to > opt.from ? `<label class="radio"><input type="radio" name="x-split" value="chapter" ${opt.split === 'chapter' ? 'checked' : ''}> 每章一个 MP3，打成一个 ZIP 包</label>` : ''}
          <label class="radio"><input type="checkbox" id="x-subs" ${opt.subs ? 'checked' : ''}> 带字幕（LRC 歌词 + SRT），播放器里能一句一句滚动显示</label>
        </div>
        <div class="note" id="x-est">正在估算…</div>
        <div class="row" style="margin-top:10px"><button class="btn primary big" id="x-go" ${ready ? '' : 'disabled'}>开始转换</button><span class="faint" id="x-st"></span></div>
        <h3 style="margin:18px 0 6px">转好的</h3>
        <div id="x-jobs"><div class="faint">正在读…</div></div>`

      const all = $('#x-all')
      if (all) all.onclick = () => { opt.from = 0; opt.to = chs.length - 1; draw() }
      const cur = $('#x-cur')
      if (cur) cur.onclick = () => { opt.from = curCh; opt.to = curCh; opt.split = 'one'; draw() }
      const f = $('#x-from')
      const t = $('#x-to')
      if (f) f.onchange = () => { opt.from = Number(f.value); if (opt.to < opt.from) opt.to = opt.from; draw() }
      if (t) t.onchange = () => { opt.to = Number(t.value); if (opt.from > opt.to) opt.from = opt.to; draw() }
      for (const b of box.querySelectorAll('[data-eng]')) b.onclick = () => { engine = b.dataset.eng; voice = pickVoice(engine); draw() }
      const vs = $('#x-voice')
      if (vs) vs.onchange = () => { voice = vs.value }
      const tryBtn = $('#x-try')
      if (tryBtn) tryBtn.onclick = () => trySample(tryBtn)
      for (const r of box.querySelectorAll('[name="x-split"]')) r.onchange = () => { opt.split = r.value; d.local.set('exportSplit', opt.split) }
      $('#x-subs').onchange = (e) => { opt.subs = e.target.checked; d.local.set('exportSubs', opt.subs) }
      $('#x-go').onclick = start
      estimate()
      jobsDraw()
    }

    async function estimate() {
      try {
        const e = await api(`export/estimate?id=${encodeURIComponent(id)}&from=${opt.from}&to=${opt.to}&engine=${engine}`)
        const el = $('#x-est')
        if (el) el.innerHTML = `${e.chars < 1000 ? `${e.chars} 字` : `约 ${Math.round(e.chars / 1000)} 千字`}，音频大约 <b>${dur(e.audio)}</b>，生成大约要 <b>${dur(e.make)}</b>${engine === 'kokoro' ? '（本地离线合成比较慢）' : ''}。在后台做，关掉这里、接着听书都不影响；听过的部分已经合成好，会更快。${e.ffmpeg ? '' : '<br>这台机器没有 ffmpeg：章与章之间不加停顿' + (engine === 'kokoro' ? '，本地语音会存成 WAV（文件较大）' : '') + '。'}`
      } catch { /* 估不出来就不显示 */ }
    }

    async function trySample(btn) {
      if (sample) { sample.pause(); sample = null; btn.textContent = '试听'; return }
      const segs = (await api(`book?id=${encodeURIComponent(id)}`)).segs
      const text = String(segs[chs[opt.from].seg + 1] || segs[chs[opt.from].seg] || '').replace(/\s+/g, ' ').slice(0, 120)
      btn.textContent = '…'
      try {
        const r = await fetch('say', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-audiobook': '1' }, body: JSON.stringify({ text, engine, voice: $('#x-voice').value }) })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '试听失败')
        sample = new Audio(URL.createObjectURL(await r.blob()))
        sample.onended = () => { sample = null; btn.textContent = '试听' }
        await sample.play()
        btn.textContent = '停'
      } catch (e) { btn.textContent = '试听'; d.toast(e.message) }
    }

    async function start() {
      const st = $('#x-st')
      try {
        await api('export/start', { id, from: opt.from, to: opt.to, engine, voice: $('#x-voice').value, split: opt.to > opt.from ? opt.split : 'one', subs: opt.subs })
        st.textContent = '开始了，进度在下面'
        refresh()
      } catch (e) { st.textContent = e.message }
    }

    async function refresh() {
      clearTimeout(poll)
      try { jobs = (await api(`exports?id=${encodeURIComponent(id)}`)).exports } catch { /* 下次再刷 */ }
      jobsDraw()
      // 有在做的：两秒刷新一次，面板关了就停
      if ($('#x-jobs') && jobs.some(j => j.state === 'running' || j.state === 'building')) poll = setTimeout(refresh, 2000)
    }

    function jobsDraw() {
      const box = $('#x-jobs')
      if (!box) return
      box.innerHTML = jobs.length ? jobs.map((j) => {
        const head = `<div class="row"><b class="grow">${esc(j.label)} · ${esc(j.voiceLabel)}</b><span class="faint">${j.split === 'chapter' ? '每章一个（ZIP）' : '一个文件'}</span></div>`
        if (j.state === 'running' || j.state === 'building') {
          const pct = j.total ? Math.round((j.done / j.total) * 100) : 0
          return `<div class="job">${head}<div class="bar" style="margin:6px 0"><i style="width:${pct}%"></i></div>
            <div class="row"><span class="faint grow">${j.state === 'building' ? '正在拼接成文件…' : j.total ? `正在合成：${j.done} / ${j.total} 段（${pct}%）` : '准备中…'}</span><button class="btn small" data-cancel="${esc(j.id)}">取消</button></div></div>`
        }
        if (j.state === 'failed') {
          return `<div class="job">${head}<div class="note" style="color:var(--bad)">${esc(j.error || '没做成')}</div>
            <div class="row"><button class="btn small" data-retry="${esc(j.id)}">重新开始</button><span class="grow"></span><button class="link-btn danger" data-del="${esc(j.id)}">删除</button></div></div>`
        }
        const main = j.outputs.find(x => x.kind === 'audio' || x.kind === 'zip')
        const subs = j.outputs.filter(x => x.kind === 'lrc' || x.kind === 'srt')
        return `<div class="job done">${head}
          <div class="faint">${dur(j.seconds)} · ${main ? size(main.size) : ''} · ${new Date(j.finishedAt || j.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</div>
          <div class="row" style="margin-top:6px">
            ${main ? `<a class="btn primary" href="export/file?id=${encodeURIComponent(id)}&job=${j.id}&f=${main.file}" download>⬇ 下载${main.kind === 'zip' ? ' ZIP' : ' MP3'}</a>` : ''}
            ${subs.map(s => `<a class="btn small" href="export/file?id=${encodeURIComponent(id)}&job=${j.id}&f=${s.file}" download>${s.kind.toUpperCase()} 字幕</a>`).join('')}
            <span class="grow"></span><button class="link-btn danger" data-del="${esc(j.id)}">删除</button>
          </div></div>`
      }).join('') : '<div class="faint">还没有转过。</div>'
      for (const b of box.querySelectorAll('[data-cancel]')) b.onclick = async () => { await api('export/cancel', { job: b.dataset.cancel }).catch(() => {}); setTimeout(refresh, 500) }
      for (const b of box.querySelectorAll('[data-del]')) {
        b.onclick = async () => {
          if (!confirm('删除这次转好的音频？')) return
          await api('export/delete', { id, job: b.dataset.del }).catch(e => d.toast(e.message))
          refresh()
        }
      }
      for (const b of box.querySelectorAll('[data-retry]')) {
        b.onclick = async () => {
          const j = jobs.find(x => x.id === b.dataset.retry)
          try {
            await api('export/delete', { id, job: j.id })
            await api('export/start', { id, from: j.from, to: j.to, engine: j.engine, voice: j.voice, split: j.split, subs: j.subs })
            refresh()
          } catch (e) { d.toast(e.message) }
        }
      }
    }
  }

  return { open, stop() { clearTimeout(poll) } }
}
