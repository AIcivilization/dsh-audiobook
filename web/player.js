// web/player.js — 一段接一段地读
//
// 三种朗读方式：
//   browser  浏览器自带的 speechSynthesis（不用装，声音来自这台设备：Mac 上就是系统语音）
//   edge     服务器经 edge-tts 合成（微软在线神经网络语音）
//   kokoro   服务器本地离线合成
// 服务器合成的两种用两个 <audio> 轮换：放这一段时，下一段已经在另一个里预载好，段和段之间几乎不停顿。
// 语速：audio 用 playbackRate（保持音高），浏览器朗读用 utterance.rate。

const SERVER = ['edge', 'kokoro']

/**
 * @param {object} o
 * @param {HTMLAudioElement[]} o.audios 两个 audio 元素
 * @param {(path: string, body?: object) => Promise<any>} o.api
 * @param {(seg: number) => void} o.onSeg 开始读某一段
 * @param {(state: 'playing'|'paused'|'loading'|'stopped') => void} o.onState
 * @param {(msg: string) => void} o.onError
 * @param {() => void} o.onFinish 全书读完
 */
export function createPlayer(o) {
  const st = {
    book: null, segs: [], seg: 0, engine: 'browser', voice: '', rate: 1,
    state: 'stopped', gen: 0,
  }
  let cur = 0 // 正在用的 audio
  let standby = null // { seg, url, gen } 另一个 audio 里预载好的
  let browserVoices = []

  const setState = (s) => { st.state = s; o.onState(s) }
  const text = seg => String(st.segs[seg] || '').replace(/\s*\n\s*/g, '\n').trim()

  // —— 浏览器朗读 ——
  function loadBrowserVoices() {
    if (!('speechSynthesis' in window)) return []
    browserVoices = speechSynthesis.getVoices()
    return browserVoices
  }
  if ('speechSynthesis' in window) {
    loadBrowserVoices()
    speechSynthesis.addEventListener('voiceschanged', loadBrowserVoices)
  }

  function speakBrowser(seg, gen) {
    if (!('speechSynthesis' in window)) { o.onError('这个浏览器不支持朗读，换成 Edge 或本地语音'); return setState('stopped') }
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text(seg) || '。')
    const v = browserVoices.find(x => x.voiceURI === st.voice)
    if (v) { u.voice = v; u.lang = v.lang }
    u.rate = st.rate
    u.onend = () => { if (gen === st.gen && st.state === 'playing') next() }
    u.onerror = (e) => {
      if (gen !== st.gen || e.error === 'interrupted' || e.error === 'canceled') return
      o.onError(`浏览器朗读出错（${e.error}）`)
      setState('paused')
    }
    speechSynthesis.speak(u)
    setState('playing')
  }

  // —— 服务器合成 ——
  const audio = k => o.audios[k]
  async function urlFor(seg) {
    const j = await o.api('speak', { id: st.book.id, seg, engine: st.engine, voice: st.voice, ahead: 4 })
    return j.url
  }

  /** 把下一段预载进另一个 audio */
  function preload(seg, gen) {
    if (seg >= st.segs.length) return
    urlFor(seg).then((url) => {
      if (gen !== st.gen) return
      const a = audio(1 - cur)
      a.src = url
      a.load()
      standby = { seg, url, gen }
    }).catch(() => { /* 轮到它时再取，会报出真正的错 */ })
  }

  async function speakServer(seg, gen) {
    setState('loading')
    let a
    if (standby && standby.gen === gen && standby.seg === seg) {
      cur = 1 - cur
      a = audio(cur)
    } else {
      let url
      try { url = await urlFor(seg) } catch (e) {
        if (gen !== st.gen) return
        o.onError(e.message)
        return setState('paused')
      }
      if (gen !== st.gen) return
      a = audio(cur)
      a.src = url
    }
    standby = null
    audio(1 - cur).pause()
    a.playbackRate = st.rate
    a.preservesPitch = true
    a.onended = () => { if (gen === st.gen && st.state === 'playing') next() }
    a.onerror = () => {
      if (gen !== st.gen) return
      o.onError('这一段的声音没放出来，点播放再试一次')
      setState('paused')
    }
    try { await a.play() } catch (e) {
      if (gen !== st.gen) return
      // 浏览器要求先点一下页面才能出声
      o.onError(e && e.name === 'NotAllowedError' ? '点一下播放按钮开始' : `播放失败：${e.message}`)
      return setState('paused')
    }
    if (gen !== st.gen) return
    setState('playing')
    preload(seg + 1, gen)
  }

  function start(seg) {
    st.gen++
    standby = null
    st.seg = Math.max(0, Math.min(st.segs.length - 1, seg))
    o.onSeg(st.seg)
    if (SERVER.includes(st.engine)) {
      if ('speechSynthesis' in window) speechSynthesis.cancel()
      speakServer(st.seg, st.gen)
    } else {
      for (const a of o.audios) a.pause()
      speakBrowser(st.seg, st.gen)
    }
  }

  function next() {
    if (st.seg + 1 >= st.segs.length) {
      st.gen++
      setState('stopped')
      o.onFinish()
      return
    }
    start(st.seg + 1)
  }

  function halt(state) {
    st.gen++
    standby = null
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    for (const a of o.audios) a.pause()
    setState(state)
  }

  return {
    get state() { return st.state },
    get seg() { return st.seg },
    get engine() { return st.engine },
    get rate() { return st.rate },
    browserVoices: () => loadBrowserVoices(),
    /** 换书（停下） */
    load(book, segs, seg) {
      halt('stopped')
      st.book = book
      st.segs = segs
      st.seg = Math.max(0, Math.min(segs.length - 1, seg || 0))
    },
    play(seg = st.seg) { start(seg) },
    /** 暂停：服务器音频原地停住；浏览器朗读没有可靠的暂停，继续时从这一段开头重读 */
    pause() {
      if (st.state === 'stopped' || st.state === 'paused') return
      const a = audio(cur)
      if (SERVER.includes(st.engine) && st.state === 'playing' && a.src) {
        st.gen++
        const gen = st.gen
        a.pause()
        st.resumeGen = gen
        setState('paused')
        return
      }
      halt('paused')
    },
    resume() {
      const a = audio(cur)
      if (SERVER.includes(st.engine) && st.resumeGen === st.gen && a.src && a.currentTime > 0 && !a.ended) {
        st.gen++
        const gen = st.gen
        a.onended = () => { if (gen === st.gen && st.state === 'playing') next() }
        a.playbackRate = st.rate
        a.play().then(() => { if (gen === st.gen) { setState('playing'); preload(st.seg + 1, gen) } },
          () => start(st.seg))
        return
      }
      start(st.seg)
    },
    toggle() { if (st.state === 'playing' || st.state === 'loading') this.pause(); else this.resume() },
    seek(seg) {
      if (st.state === 'playing' || st.state === 'loading') start(seg)
      else { halt(st.state === 'stopped' ? 'stopped' : 'paused'); st.seg = Math.max(0, Math.min(st.segs.length - 1, seg)); o.onSeg(st.seg) }
    },
    /** 换朗读方式 / 声音：正在读就从这一段重新读 */
    setVoice(engine, voice) {
      const changed = engine !== st.engine || voice !== st.voice
      st.engine = engine
      st.voice = voice
      if (changed && (st.state === 'playing' || st.state === 'loading')) start(st.seg)
      else if (changed) { standby = null; st.resumeGen = -1 }
    },
    setRate(rate) {
      st.rate = rate
      for (const a of o.audios) a.playbackRate = rate
      // 浏览器朗读的语速只能在下一句生效：重读这一段
      if (st.engine === 'browser' && st.state === 'playing') start(st.seg)
    },
    stop() { halt('stopped') },
  }
}
