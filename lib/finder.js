// lib/finder.js — 搜书：书名、作者、书里的角色名、大概的情节都可以
//
// 1. 直接拿原话去各书源搜
// 2. 有模型时（DSH 里），同时让模型猜「这说的是哪几本书」，再按猜到的书名（简体、繁体、原文）去搜
// 3. 合并去重：猜中的书排前面；猜到了但书源里没有的，也告诉用户（多半是还在版权期内的书）

import { searchSources, SOURCES } from './sources.js'

const SYSTEM = `你是图书检索助手。用户会给出书名、作者、书中角色名或大致情节，可能记得不准。
判断最可能是哪几本书，只输出 JSON，不要别的文字：
{"books":[{"title":"书名（中文书用简体）","hant":"繁体书名（中文书才填）","original":"原文书名（外国书才填）","author":"作者","why":"一句话：为什么是这本"}]}
最多 4 本，拿不准就少写；完全猜不出就输出 {"books":[]}。`

/** 从模型的回答里抠出 JSON（可能包在 ```json 里，或前后带了话） */
export function parseGuesses(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''))
  if (!m) return []
  let j
  try { j = JSON.parse(m[0]) } catch { return [] }
  return (Array.isArray(j.books) ? j.books : []).slice(0, 4)
    .map(b => ({
      title: String(b.title || '').trim().slice(0, 80),
      hant: String(b.hant || '').trim().slice(0, 80),
      original: String(b.original || '').trim().slice(0, 120),
      author: String(b.author || '').trim().slice(0, 60),
      why: String(b.why || '').trim().slice(0, 120),
    }))
    .filter(b => b.title || b.original)
}

const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 一条结果是不是某本猜测的书 */
function matches(r, g) {
  const t = norm(r.title)
  if (!t) return false
  return [g.title, g.hant, g.original].map(norm).filter(x => x.length >= 2).some(x => t.includes(x) || (x.includes(t) && t.length >= 4))
}

/**
 * @param {string} query
 * @param {{ llm?: { complete: Function } | null }} [o]
 */
export async function findBooks(query, { llm } = {}) {
  const q = String(query || '').trim().slice(0, 200)
  const direct = searchSources(q).catch(e => ({ results: [], failed: [e.message] }))
  let guesses = []
  let note = ''
  if (llm) {
    try { guesses = parseGuesses(await llm.complete({ system: SYSTEM, user: q, maxTokens: 800 })) } catch (e) { note = `AI 猜书没成功（${e.message}），只按原话搜了` }
  }
  // 按猜到的书名再搜一轮（去重，最多 6 次）
  const titles = [...new Set(guesses.flatMap(g => [g.title, g.hant, g.original]).filter(Boolean))].filter(t => norm(t) !== norm(q)).slice(0, 6)
  const more = await Promise.all(titles.map(t => searchSources(t).catch(() => ({ results: [], failed: [] }))))
  const first = await direct

  const seen = new Set()
  const all = []
  for (const r of [...more.flatMap(m => m.results), ...first.results]) {
    const key = `${r.source}|${r.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    const g = guesses.findIndex(x => matches(r, x))
    all.push({ ...r, sourceLabel: SOURCES[r.source].label, guess: g })
  }
  // 猜中的排前面（按猜测顺序），其余保持书源给的相关度顺序
  all.sort((a, b) => (a.guess < 0) - (b.guess < 0) || (a.guess >= 0 && b.guess >= 0 ? a.guess - b.guess : 0))
  return {
    query: q,
    guesses: guesses.map((g, k) => ({ ...g, found: all.some(r => r.guess === k) })),
    results: all.slice(0, 30),
    failed: [...new Set([...first.failed, ...more.flatMap(m => m.failed)])],
    note,
  }
}
