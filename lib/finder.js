// lib/finder.js — 搜书：书名、作者、书里的角色名、大概的情节都可以
//
// 1. 直接拿原话去各书源搜
// 2. 有模型时（DSH 里），同时让模型猜「这说的是哪几本书」，再按猜到的书名（简体、繁体、原文）去搜
// 3. 合并去重：猜中的书排前面；猜到了但书源里没有的，也告诉用户（多半是还在版权期内的书）

import { searchSources, SOURCES } from './sources.js'

const SYSTEM = `你是图书检索助手。用户会给出书名、作者、书中角色名或大致情节，可能记得不准，也可能用简体写繁体书名。
判断最可能是哪几本书，只输出 JSON，不要别的文字：
{"books":[{"title":"书名（中文书用简体）","hant":"繁体书名（中文书一定要填，书源里的中文古籍多是繁体）","original":"原文书名（外国书才填）","author":"作者","why":"一句话：为什么是这本"}]}
用户只给了作者名时，列出这位作者最有名、最可能被找的作品。
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
const plain = s => String(s || '').trim().toLowerCase().replace(/^(the|a|an)\s+/, '')

/**
 * 书名对不对得上：完全一样 3 分；目标书名后面只跟着版本说明（「紅樓夢 (程乙本)」「西遊記：第一冊」）2 分；
 * 其余 0 分。只是标题里含着这几个字的（「上海围城置业…判决书」「圍城病中文舉相過」）不算。
 */
export function titleScore(title, target) {
  const t = plain(title)
  const g = plain(target)
  if (!t || !g || norm(g).length < 2) return 0
  if (norm(t) === norm(g)) return 3
  if (t.startsWith(g) && /^[\s(（\[【〈《<:：\-—–·,，.;；]/.test(t.slice(g.length))) return 2
  return 0
}

/** 作者对得上（用户搜的是作者名）：1 分 */
const authorScore = (author, target) => (norm(author).length >= 2 && norm(target).length >= 2 && (norm(author).includes(norm(target)) || norm(target).includes(norm(author))) ? 1 : 0)

/** 一条结果是第几本猜测的书（-1：都不是） */
function guessOf(r, guesses) {
  return guesses.findIndex(g => [g.title, g.hant, g.original].some(x => titleScore(r.title, x) > 0))
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
    const g = guessOf(r, guesses)
    // 相关度：书名对得上原话或某本猜测的书，或者作者对得上原话；都不沾边的丢掉
    const score = Math.max(
      titleScore(r.title, q),
      ...guesses.flatMap(x => [x.title, x.hant, x.original].map(t => titleScore(r.title, t))),
      authorScore(r.author, q),
    )
    if (score <= 0) continue
    all.push({ ...r, sourceLabel: SOURCES[r.source].label, guess: g, score })
  }
  // 猜中的按猜测顺序排前面，其余按相关度
  all.sort((a, b) => (a.guess < 0) - (b.guess < 0) || (a.guess >= 0 && b.guess >= 0 ? a.guess - b.guess : 0) || b.score - a.score)
  return {
    query: q,
    guesses: guesses.map((g, k) => ({ ...g, found: all.some(r => r.guess === k) })),
    results: all.slice(0, 30),
    failed: [...new Set([...first.failed, ...more.flatMap(m => m.failed)])],
    note,
  }
}
