// lib/llm.js — 调大模型的两种方式，对外都是 complete({system, user, maxTokens, signal}) → 文本
//
// 1. dshLlm：插件里用 DSH 自己的 ctx.llm（用户在 DSH 里配好的模型，不用另填密钥）。
//    写法照「听懂」：一条 user 消息，拼 text-delta，finish 不是 stop 就算失败。
// 2. openaiLlm / cliLlm：命令行独立运行时用任意 OpenAI 兼容接口；没指定就用本机的 dsh-model 网关。

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {{stream(o:object):AsyncIterable<any>}} llm DSH 的 ctx.llm
 * @param {() => {provider:string, model:string}|null} route 每次调用时取当前模型
 */
export function dshLlm(llm, route) {
  return {
    label() { const r = route(); return r ? `${r.provider}/${r.model}` : '（未选模型）' },
    async complete({ system, user, maxTokens = 2000, signal }) {
      const r = route()
      if (!r || !r.provider || !r.model) throw new Error('找不到可用的模型：请在 DSH 里选一个默认模型')
      const message = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-audiobook' },
        content: [{ type: 'text', text: user }],
      }
      let text = ''
      for await (const chunk of llm.stream({
        provider: r.provider, model: r.model, system, messages: [message], maxTokens,
        ...(signal ? { signal } : {}),
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop') {
          const why = chunk.reason.failure && chunk.reason.failure.message
          throw new Error(`模型没有正常结束（${chunk.reason.kind}${why ? '：' + why : ''}）`)
        }
      }
      return text
    },
  }
}

/** @param {{baseURL:string, apiKey?:string, model:string}} cfg */
export function openaiLlm(cfg) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '')
  return {
    label() { return cfg.model },
    async complete({ system, user, maxTokens = 2000, signal }) {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal: signal || AbortSignal.timeout(180000),
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model, max_tokens: maxTokens, temperature: 0.3,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${body.slice(0, 300)}`)
      const text = JSON.parse(body).choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('模型接口没有返回文字')
      return text
    },
  }
}

/** 本机的 dsh-model 网关（同一生态的插件，地址和密钥都在本机） */
async function dshModelGateway() {
  const root = join(homedir(), '.dsh-model')
  try {
    const cfg = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    const yaml = await readFile(join(root, 'engine.yaml'), 'utf8')
    const key = /api-keys:\s*\n\s*-\s*["']?([^"'\n]+)/.exec(yaml)
    return { baseURL: `http://127.0.0.1:${Number(cfg.port) || 8317}/v1`, apiKey: key ? key[1].trim() : '' }
  } catch { return null }
}

/**
 * 命令行版用哪个模型：参数 > 环境变量（AUDIOBOOK_BASE_URL / AUDIOBOOK_API_KEY / AUDIOBOOK_MODEL）> 本机 dsh-model 网关。
 * 没指定模型时在接口的模型列表里优先挑 deepseek。
 * @returns {Promise<object|null>} 没有可用模型返回 null
 */
export async function cliLlm(flags = {}) {
  let baseURL = flags['base-url'] || process.env.AUDIOBOOK_BASE_URL || ''
  let apiKey = flags['api-key'] || process.env.AUDIOBOOK_API_KEY || ''
  let model = flags.model || process.env.AUDIOBOOK_MODEL || ''
  if (!baseURL) {
    const gw = await dshModelGateway()
    if (gw) { baseURL = gw.baseURL; apiKey = apiKey || gw.apiKey }
  }
  if (!baseURL) return null
  if (!model) {
    try {
      const r = await fetch(baseURL.replace(/\/+$/, '') + '/models', { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(6000) })
      const ids = ((await r.json()).data || []).map(m => m.id).filter(id => typeof id === 'string' && !/embed|bge/i.test(id))
      model = ids.find(id => /deepseek/i.test(id)) || ids[0] || ''
    } catch { /* 拿不到模型列表 */ }
  }
  return model ? openaiLlm({ baseURL, apiKey, model }) : null
}
