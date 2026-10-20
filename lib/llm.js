// lib/llm.js — 用 DSH 自己的模型（ctx.llm，用户在 DSH 里配好的，不用另填密钥）
//
// 对外是 complete({system, user, maxTokens, signal}) → 文本。写法照「听懂」：
// 一条 user 消息，拼 text-delta，finish 不是 stop 就算失败。

import { randomUUID } from 'node:crypto'

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
