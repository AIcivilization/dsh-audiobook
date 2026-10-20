/* global window, document */
// plugin/client.js — 搜书听在 DSH 界面里的入口
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入（写法照 dsh-pick）。挂两处：
//   - 对话页右侧栏的一个页签：整个朗读面板（iframe 指向宿主路由 /api-dsh-audiobook/panel）
//   - 「设置 → 搜书听」：版本、更新、卸载，状态（Edge 语音组件、本地中文模型）和用法
// 面板本身是独立调好的页面（dsh-audiobook serve 也能直接打开），这里原样复用。
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-audiobook',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const PANEL = '/api-dsh-audiobook/panel'
    const SIDEBAR_TAB_ID = 'dsh-audiobook/panel'
    const SIDEBAR_KIND = 'dsh-audiobook'

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      good: '#1f9d55',
      warn: '#c98a12',
      accent: 'var(--dsw-alias-link, #2f6bff)',
      danger: '#c94040',
    }

    function Btn({ onClick, disabled, primary, danger, title, children }) {
      return h('button', {
        type: 'button', onClick, disabled, title,
        style: {
          appearance: 'none', fontFamily: 'inherit', fontSize: 12, lineHeight: '18px', padding: '2px 10px',
          borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, whiteSpace: 'nowrap',
          border: '1px solid ' + (danger ? C.danger : primary ? C.accent : C.border),
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : danger ? C.danger : C.text,
        },
      }, children)
    }

    async function api(path, method = 'GET') {
      const r = await fetch('/api-dsh-audiobook/' + path, {
        method, credentials: 'same-origin',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-audiobook': '1' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      })
      return r.json()
    }

    /** 给用户自己在终端执行的命令：等宽显示，旁边一个「复制」 */
    function CommandLine({ command }) {
      const [copied, setCopied] = useState(false)
      const copy = async () => {
        try { await navigator.clipboard.writeText(command) } catch {
          const ta = document.createElement('textarea')
          ta.value = command
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          try { document.execCommand('copy') } catch { /* 实在不行用户还能手动选 */ }
          ta.remove()
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
        h('code', { style: { flex: '1 1 auto', minWidth: 0, padding: '4px 8px', borderRadius: 6, fontSize: 12, color: C.text, border: '1px solid ' + C.border, userSelect: 'all', overflowWrap: 'anywhere' } }, command),
        h(Btn, { onClick: copy }, copied ? '已复制' : '复制'))
    }

    /**
     * 标题行：搜书听 · 版本号 · 更新 ……（最右）卸载
     * 打开设置页时自动去 npm 查新版本；更新、卸载交给 DSH 的插件管理器（宿主路由 /update、/uninstall）
     */
    function HeaderBar() {
      const [info, setInfo] = useState(null)
      const [phase, setPhase] = useState('checking') // checking | idle | updating | updated | removing | removed
      const [confirm, setConfirm] = useState(false)
      const [msg, setMsg] = useState(null) // { text, command?, ok? }
      const check = (force) => {
        setPhase('checking')
        api('update' + (force ? '?force=1' : '')).then(j => { setInfo(j); setPhase('idle') }).catch(() => setPhase('idle'))
      }
      useEffect(() => { check(false) }, [])
      const update = async () => {
        setPhase('updating'); setMsg(null)
        try {
          const j = await api('update', 'POST')
          setMsg({ text: j.message, command: j.command, ok: j.ok })
          if (j.ok) { setPhase('updated'); return }
        } catch (e) { setMsg({ text: '更新请求失败：' + e.message }) }
        setPhase('idle')
      }
      const uninstall = async () => {
        setConfirm(false); setPhase('removing'); setMsg(null)
        try {
          const j = await api('uninstall', 'POST')
          setMsg({ text: j.message, command: j.command, ok: j.ok })
          setPhase(j.ok ? 'removed' : 'idle')
        } catch {
          // 卸下插件时它自己的接口也随之消失，请求多半就是这么断的
          setPhase('removed')
        }
      }
      let upd
      if (phase === 'updating') upd = { label: '正在更新…', disabled: true }
      else if (phase === 'updated') upd = { label: '已更新，重启 DSH 生效', disabled: true }
      else if (info && info.restartPending) upd = { label: `v${info.restartPending} 已装好，重启 DSH 生效`, disabled: true }
      else if (info && info.available) upd = { label: `更新到 v${info.latest}`, primary: true, onClick: update }
      else if (phase === 'checking') upd = { label: '检查更新…', disabled: true }
      else upd = { label: info && info.latest ? '已是最新' : '检查更新', onClick: () => check(true), title: '点一下重新检查' }
      const busy = phase === 'updating' || phase === 'removing' || phase === 'removed'
      const managed = !info || info.managed !== false
      return h('div', { style: { marginBottom: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 15, fontWeight: 650 } }, '搜书听'),
          info && info.running ? h('span', { style: { fontSize: 12, color: C.sub, fontVariantNumeric: 'tabular-nums' } }, 'v' + info.running) : null,
          managed ? h(Btn, { onClick: upd.onClick, disabled: upd.disabled || busy, primary: upd.primary, title: upd.title }, upd.label) : null,
          h('span', { style: { flex: 1 } }),
          !managed ? null
            : phase === 'removed' ? h('span', { style: { fontSize: 12, color: C.sub } }, '已卸载，重启 DSH 后彻底移除')
            : phase === 'removing' ? h('span', { style: { fontSize: 12, color: C.sub } }, '正在卸载…')
            : confirm ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                h('span', { style: { fontSize: 12, color: C.sub } }, '确定卸载？书和收听进度会保留'),
                h(Btn, { danger: true, onClick: uninstall }, '确认卸载'),
                h(Btn, { onClick: () => setConfirm(false) }, '取消'))
            : h(Btn, { danger: true, disabled: busy, onClick: () => setConfirm(true) }, '卸载')),
        msg ? h('div', { style: { fontSize: 12, color: msg.ok ? C.sub : C.danger, marginTop: 6, lineHeight: 1.6 } },
          msg.text, msg.command ? h(CommandLine, { command: msg.command }) : null) : null)
    }

    /** 右侧栏：占满栏高的 iframe */
    function Panel() {
      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } },
        h('iframe', {
          src: PANEL,
          title: '搜书听',
          allow: 'autoplay',
          style: { width: '100%', flex: '1 1 0', minHeight: 0, border: 0, display: 'block', background: 'transparent' },
        }))
    }

    let sidebarRightApi = null

    function Line({ ok, children }) {
      return h('div', { style: { fontSize: 12.5, lineHeight: 1.8 } },
        h('span', { style: { color: ok ? C.good : C.warn, marginRight: 6 } }, ok ? '✓' : '!'), children)
    }

    function SettingsSection() {
      const [st, setSt] = useState(null)
      const [msg, setMsg] = useState('')
      useEffect(() => {
        let alive = true
        fetch('/api-dsh-audiobook/status', { credentials: 'same-origin' }).then(r => r.json()).then(j => { if (alive) setSt(j) }).catch(() => {})
        return () => { alive = false }
      }, [])
      const open = () => {
        try { sidebarRightApi.openTab(SIDEBAR_KIND); setMsg('已在右侧栏打开，关闭设置就能看到') }
        catch { setMsg('先回到一个对话，再从右侧栏打开') }
      }
      return h('div', { style: { color: C.text } },
        h(HeaderBar),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7, marginTop: 6 } },
          '搜一本书（古腾堡计划、维基文库的公版书，书名、角色名、情节都能搜），或者导入自己的 TXT、EPUB、PDF、Word，在右侧栏读给你听。声音、语速可选，自动记住听到哪。'),
        h('div', { style: { marginTop: 14 } },
          !st ? h('div', { style: { fontSize: 12, color: C.sub } }, '正在检查…') : [
            h(Line, { key: 'b', ok: true }, '浏览器朗读：不用安装，用这台设备自带的语音'),
            h(Line, { key: 'e', ok: st.edge && st.edge.ready }, st.edge && st.edge.ready ? `微软 Edge 语音组件已装好${st.edge.version ? `（edge-tts ${st.edge.version}）` : ''}，要联网`
              : st.edge && st.edge.error ? st.edge.error + '（可在朗读面板的「声音」里重试）'
              : '微软 Edge 语音组件正在后台自动安装，一般几秒到一分钟'),
            h(Line, { key: 'k', ok: st.kokoro && st.kokoro.ready }, st.kokoro && st.kokoro.ready ? '本地中文语音模型已就绪（离线，不上传文字）' : '本地中文语音（离线）：第一次用时在「声音」里下载模型（约 147 MB）'),
          ]),
        h('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 18, marginBottom: 6 } }, '怎么打开'),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } },
          '朗读面板在对话页的右侧栏：打开右侧栏，选「搜书听」。也可以在对话里直接说「帮我找那本主角叫贾宝玉的书来听」「把 <文件路径> 导入搜书听」「我听到哪了？刚才那段讲了什么」「跳到第十章」。'),
        sidebarRightApi ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
          h(Btn, { onClick: open }, '在右侧栏打开'),
          h(Btn, { onClick: () => window.open(PANEL, '_blank') }, '新窗口打开'),
          msg ? h('span', { style: { fontSize: 12, color: C.sub } }, msg) : null) : null,
      )
    }

    function BookIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none' },
        h('path', {
          d: 'M4 7c3-1.5 6-1.5 9 0v18c-3-1.5-6-1.5-9 0zM13 7c1.5-.8 3-1.2 4.5-1.2M22 12a5 5 0 0 1 0 8M26 9a9 9 0 0 1 0 14',
          stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    function apply(ctx) {
      try {
        ctx.inject && ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = (scope.get && scope.get('sidebarRight')) || scope.sidebarRight
          const tabs = (scope.get && scope.get('sidebarRightTabs')) || scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => '搜书听',
            guide: [{
              id: 'dsh-audiobook',
              order: 61,
              title: () => '搜书听 · 读书给你听',
              description: () => '导入一本书，读给你听，记住听到哪',
              icon: BookIcon,
            }],
          }), 'dsh-audiobook: sidebar type')
          const slots = scope.slots || ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, Panel)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-audiobook: sidebar body')
          if (right && typeof right.openTab === 'function') {
            sidebarRightApi = right
            effect(() => () => { if (sidebarRightApi === right) sidebarRightApi = null }, 'dsh-audiobook: sidebar api')
          }
        })
      } catch (error) {
        console.warn('[dsh-audiobook] 右侧栏注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-audiobook', order: 32, label: () => '搜书听' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-audiobook] 设置页注册失败', error)
      }
    }

    module.exports = { name: 'dsh-audiobook', inject: ['slots'], apply }
    return module.exports
  },
})
