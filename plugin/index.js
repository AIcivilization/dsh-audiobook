// plugin/index.js — 搜书听（dsh-audiobook）的 DSH 插件（宿主端）
//
// 1. 把朗读面板和接口挂到 dsh 自己的 webServer 上：/api-dsh-audiobook/*
//    插件路由不会自动过 dsh 的登录校验：每个请求先问 connection.requestRejection()（和官方 open-in-app 一样：
//    Host/Origin 防 DNS 重绑定和跨站，再查登录令牌 cookie）；老版本没有这个服务就只放行本机
// 2. 注册 AI 工具（plugin/tools.js）：在对话里搜书下书、导入书、查进度、读出刚听过的内容、跳到某一章
// 3. 面板里搜书时，用 DSH 里配好的模型（ctx.llm）按角色名、情节猜书名：插件配置里的 provider/model，没有就用 DSH 的默认模型
//
// 本地语音合成在子进程里跑（lib/kokoro-worker.js），不卡 DSH。
//
// 可选配置（profile 的 cordis.patch.yml 里给 id: dsh-audiobook 加 config）：
//   ffmpeg    ffmpeg 的完整路径（可选：有就把本地合成的声音压成 MP3）
//   threads   每个本地语音进程的线程数，默认 2
//   provider / model   搜书时猜书名用的模型（两个都填才生效；不填跟 DSH 的默认模型）
//   edge      false：不要自动安装微软 Edge 语音组件（默认会在后台自动装）
//   workers   同时开几个本地语音进程，默认 2（每个占 300–400 MB 内存；VPS 内存小就设 1）

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureEdge } from '../lib/edge.js'
import { dshLlm } from '../lib/llm.js'
import { findFfmpeg } from '../lib/paths.js'
import { createHandler } from '../lib/server.js'
import { createSpeech } from '../lib/speech.js'
import { registerTools } from './tools.js'
import { createManager } from './manage.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PREFIX = '/api-dsh-audiobook'

export const name = 'dsh-audiobook'
export const inject = []

/** Web Worker 隧道里的请求没有 socket（本机页面发的），也算本机 */
export function isLoopback(ip) {
  if (ip === undefined || ip === null) return true
  return /^(127\.|::1$|::ffff:127\.)/.test(String(ip))
}

async function readPkgJson() {
  try { return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')) } catch { return {} }
}

export function apply(ctx, config = {}) {
  const cfg = config || {}
  let version = ''
  readPkgJson().then(p => { version = p.version || '' })

  // 模型：每次用时取当前的（用户在 DSH 里换了默认模型就跟着换）
  let llm
  let defaults
  const route = () => {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    try {
      const sel = defaults && defaults.currentSelection()
      return sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : null
    } catch { return null }
  }
  ctx.inject(['llm'], (c) => {
    c.effect(() => {
      llm = c.llm || (c.get && c.get('llm'))
      return () => { llm = undefined }
    })
  })
  ctx.inject(['agentDefaultModel'], (c) => {
    c.effect(() => {
      defaults = c.agentDefaultModel || (c.get && c.get('agentDefaultModel'))
      return () => { defaults = undefined }
    })
  })
  const model = () => (llm && typeof llm.stream === 'function' && route() ? dshLlm(llm, route) : null)

  const speech = createSpeech({ ffmpeg: () => findFfmpeg(cfg.ffmpeg), threads: cfg.threads || 2, workers: cfg.workers || 2 })
  // 插件卸载 / DSH 退出：停掉合成子进程
  const stopAll = () => speech.stop()
  if (typeof ctx.effect === 'function') ctx.effect(() => stopAll)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stopAll)

  // DSH 自己的插件管理器（更新 / 卸载按钮用；老版本 DSH 没有）
  let pluginManager
  ctx.inject(['pluginManager'], (c) => {
    c.effect(() => {
      pluginManager = c.pluginManager || (c.get && c.get('pluginManager'))
      return () => { pluginManager = undefined }
    })
  })
  let profile
  try { profile = ctx.get && ctx.get('profileContext') && ctx.get('profileContext').name } catch { profile = undefined }
  const manage = createManager({ pkgRoot: PKG_ROOT, pluginManager: () => pluginManager, profile: () => profile })

  const handle = createHandler({
    manage,
    prefix: PREFIX,
    pkgRoot: PKG_ROOT,
    speech,
    llm: model,
    options: () => ({ ffmpeg: cfg.ffmpeg }),
    status: () => {
      const r = route()
      return { host: 'dsh', version, llm: llm && r ? `${r.provider}/${r.model}` : '' }
    },
  })

  let connection
  ctx.inject(['connection'], (c) => {
    c.effect(() => {
      connection = c.connection || (c.get && c.get('connection'))
      return () => { connection = undefined }
    })
  })
  /** 不放行就直接回状态码，返回 true */
  const rejected = (req, res) => {
    let code
    if (connection && typeof connection.requestRejection === 'function') code = connection.requestRejection(req)
    else if (!isLoopback(req.socket && req.socket.remoteAddress)) code = 403
    if (code === undefined) return false
    res.statusCode = code
    res.end()
    return true
  }
  const guarded = (req, res) => (rejected(req, res) ? undefined : handle(req, res))

  // 微软 Edge 语音组件：没装就在后台自动装（几秒到一分钟），用户不用点
  if (cfg.edge !== false) {
    const t = setTimeout(() => ensureEdge().catch(e => { try { ctx.logger ? ctx.logger.warn(e.message) : console.warn(e.message) } catch { /* 忽略 */ } }), 3000)
    if (t.unref) t.unref()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearTimeout(t))
  }

  ctx.inject(['webServer'], (c) => {
    const ws = c.webServer || (c.get && c.get('webServer'))
    if (!ws || typeof ws.register !== 'function') return
    const reg = () => ws.register({ kind: 'prefix', path: PREFIX, handler: guarded })
    if (typeof c.effect === 'function') c.effect(reg)
    else reg()
  })

  ctx.inject(['tools'], (c) => {
    const tools = c.tools || (c.get && c.get('tools'))
    if (!tools || typeof tools.register !== 'function') return
    registerTools(tools, { effect: typeof c.effect === 'function' ? fn => c.effect(fn) : null })
      .catch(e => console.warn('[dsh-audiobook] AI 工具注册失败', e))
  })
}

export default { name, inject, apply, __meta: { pkgRoot: PKG_ROOT } }
