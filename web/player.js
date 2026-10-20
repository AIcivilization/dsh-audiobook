// web/player.js — 一段接一段地读
//
// 三种朗读方式：
//   browser  浏览器自带的 speechSynthesis（不用装，声音来自这台设备：Mac 上就是系统语音）
//   edge     服务器经 edge-tts 合成（微软在线神经网络语音）
//   kokoro   服务器本地离线合成
// 服务器合成的两种始终用同一个 <audio>，读完一段就换 src 接着放：iPhone 锁屏后，Safari 只允许已经在出声的那个
// <audio> 继续播放，换一个新的会被拦下。为了段间不停顿，放这一段时就把下一段整个下载成 blob，
// 轮到它时直接从内存开始放，不用等网络（锁屏时等网络，iOS 可能趁这个空档把声音挂起）。
// 语速：audio 用 playbackRate（保持音高），浏览器朗读用 utterance.rate。

const SERVER = ['edge', 'kokoro']

/**
 * @param {object} o
 * @param {HTMLAudioElement} o.audio
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
  const audio = o.audio
  let pre = null // 下一段的预载：{ seg, gen, promise: Promise<blob URL> }
  let playingBlob = '' // 正在放的 blob URL（换段后释放）
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
  async function urlFor(seg) {
    const j = await o.api('speak', { id: st.book.id, seg, engine: st.engine, voice: st.voice, ahead: 4 })
    return j.url
  }

  const release = (u) => { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u) }
  function dropPre() {
    if (pre) pre.promise.then(release, () => {})
    pre = null
  }

  /** 把下一段整个下载进内存 */
  function preload(seg, gen) {
    if (seg >= st.segs.length) return
    const promise = urlFor(seg)
      .then(url => fetch(url, { credentials: 'same-origin' }))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() })
      .then(b => URL.createObjectURL(b))
    promise.catch(() => { /* 轮到它时再取，会报出真正的错 */ })
    pre = { seg, gen, promise }
  }

  async function speakServer(seg, gen) {
    setState('loading')
    let src = ''
    // 预载好（或正在预载）的就用它；失败了再直接问服务器
    if (pre && pre.gen === gen && pre.seg === seg) {
      const p = pre.promise
      pre = null
      try { src = await p } catch { src = '' }
    } else dropPre()
    if (!src) {
      try { src = await urlFor(seg) } catch (e) {
        if (gen !== st.gen) return
        o.onError(e.message)
        return setState('paused')
      }
    }
    if (gen !== st.gen) { release(src); return }
    release(playingBlob)
    playingBlob = src
    audio.src = src
    // 换 src 后有的浏览器会把语速重置成 defaultPlaybackRate：两个都设
    audio.defaultPlaybackRate = st.rate
    audio.playbackRate = st.rate
    audio.preservesPitch = true
    audio.onended = () => { if (gen === st.gen && st.state === 'playing') next() }
    audio.onerror = () => {
      if (gen !== st.gen) return
      o.onError('这一段的声音没放出来，点播放再试一次')
      setState('paused')
    }
    try { await audio.play() } catch (e) {
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
    // 预载的那段正好是要读的这段（读完自动接下一段），留着给 speakServer 用
    if (pre && pre.seg === seg) pre.gen = st.gen
    else dropPre()
    st.seg = Math.max(0, Math.min(st.segs.length - 1, seg))
    o.onSeg(st.seg)
    if (SERVER.includes(st.engine)) {
      if ('speechSynthesis' in window) speechSynthesis.cancel()
      speakServer(st.seg, st.gen)
    } else {
      audio.pause()
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
    dropPre()
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    audio.pause()
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
      if (SERVER.includes(st.engine) && st.state === 'playing' && audio.src) {
        st.gen++
        audio.pause()
        st.resumeGen = st.gen
        if (pre) pre.gen = st.gen // 下一段的预载还有用
        setState('paused')
        return
      }
      halt('paused')
    },
    resume() {
      if (SERVER.includes(st.engine) && st.resumeGen === st.gen && audio.src && audio.currentTime > 0 && !audio.ended) {
        st.gen++
        const gen = st.gen
        if (pre) pre.gen = gen
        audio.onended = () => { if (gen === st.gen && st.state === 'playing') next() }
        audio.playbackRate = st.rate
        audio.play().then(() => { if (gen === st.gen) { setState('playing'); if (!pre) preload(st.seg + 1, gen) } },
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
      else if (changed) { dropPre(); st.resumeGen = -1 }
    },
    setRate(rate) {
      st.rate = rate
      audio.defaultPlaybackRate = rate
      audio.playbackRate = rate
      // 浏览器朗读的语速只能在下一句生效：重读这一段
      if (st.engine === 'browser' && st.state === 'playing') start(st.seg)
    },
    stop() { halt('stopped') },
  }
}
