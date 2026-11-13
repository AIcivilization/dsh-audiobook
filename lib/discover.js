// lib/discover.js — 「AI 添加搜索地址」：用户只给网站地址，自动找出这个网站的搜索地址（{q} 代表搜的词）
//
// 按这个顺序找，找到就验证一下（真去搜一次，看结果页正常、里面有搜的词）：
//   1. 网页里声明的 OpenSearch 描述（<link rel="search" type="application/opensearchdescription+xml">）：最准
//   2. OPDS 书库（Calibre 等）：地址本身是 Atom 目录，里面有 OpenSearch 搜索链接
//   3. 网页里的搜索表单（GET 方式，有 q / wd / keyword / searchkey 这类输入框）
//   4. 都不明确时，把表单和带「搜索」字样的链接交给模型判断
// 有人机验证（Cloudflare 的 Just a moment…）、要登录、只能 POST 搜索的网站，插件访问不了，会说清楚，教用户手动加。

import { decodeEntities } from './extract.js'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const QUERY_NAMES = ['q', 'wd', 'word', 'kw', 'keyword', 'keywords', 'key', 'searchkey', 'search', 'query', 's', 'k', 'searchword', 'search_text', 'text', 'name', 'title']

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : ''
}

async function get(url, timeout = 12000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
  const text = await res.text()
  return { status: res.status, url: res.url || url, type: res.headers.get('content-type') || '', text: text.slice(0, 1_500_000) }
}

/** 有人机验证 / 拦截页 */
const blocked = page => page.status === 403 || page.status === 503 || /<title>\s*(Just a moment|Attention Required|请稍候|安全验证)/i.test(page.text) || /cf-browser-verification|challenge-platform/i.test(page.text)

/** 网站名：<title> 里分隔符前面那段，太长就用域名 */
function siteName(page, url) {
  const t = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text) || [])[1] || '').replace(/\s+/g, ' ').trim()
  const first = t.split(/\s*[-|_—–·:：,，]\s*/)[0]
  if (first && first.length <= 16) return first
  return new URL(url).hostname.replace(/^www\./, '')
}

/** 模板里值为空的参数去掉（OpenSearch 的可选参数去掉后会剩下 &page= 这种） */
export function cleanTemplate(t) {
  const u = new URL(t.replace('{q}', '__Q__'))
  for (const [k, v] of [...u.searchParams]) if (v === '') u.searchParams.delete(k)
  return u.href.replace('__Q__', '{q}')
}

/** OpenSearch 描述 → 模板（{searchTerms} 换成 {q}，其余可选参数去掉） */
export function fromOpenSearch(xml, base, prefer = /html/) {
  const urls = [...String(xml).matchAll(/<Url\b[^>]*>/gi)].map(m => ({ type: attr(m[0], 'type'), template: attr(m[0], 'template') })).filter(u => u.template.includes('{searchTerms}'))
  const u = urls.find(x => prefer.test(x.type)) || urls[0]
  if (!u) return null
  let t = u.template.replace('{searchTerms}', '{q}').replace(/[?&][^=&]+=\{[^}]*\?\}/g, '').replace(/\{[^}q][^}]*\}/g, '')
  try { t = cleanTemplate(new URL(t.replace('{q}', '__Q__'), base).href.replace('__Q__', '{q}')) } catch { return null }
  return { url: t, kind: /atom|opds/i.test(u.type) ? 'opds' : 'web' }
}

/** 网页里的表单：action、method、输入框 */
export function parseForms(html, base) {
  const forms = []
  for (const m of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const head = m[1]
    let action
    try { action = new URL(attr(head, 'action') || base, base).href } catch { continue }
    const inputs = [...m[2].matchAll(/<input\b[^>]*>/gi)].map(x => ({ name: attr(x[0], 'name'), type: (attr(x[0], 'type') || 'text').toLowerCase(), value: attr(x[0], 'value'), placeholder: attr(x[0], 'placeholder') }))
      .filter(i => i.name && !['submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file', 'password'].includes(i.type))
    forms.push({ action, method: (attr(head, 'method') || 'get').toLowerCase(), inputs, text: m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  return forms
}

/** 一个 GET 表单 → 模板：搜索框的值是 {q}，隐藏字段照原样带上 */
export function formTemplate(form) {
  if (form.method !== 'get') return null
  const box = form.inputs.find(i => i.type === 'search')
    || form.inputs.find(i => QUERY_NAMES.includes(i.name.toLowerCase()) && i.type !== 'hidden')
    || form.inputs.find(i => i.type === 'text' && /搜|search|关键|书名|作者/i.test(i.placeholder))
  if (!box) return null
  const u = new URL(form.action)
  for (const i of form.inputs) {
    if (i === box) continue
    if (i.type === 'hidden' && i.value) u.searchParams.set(i.name, i.value)
  }
  u.searchParams.set(box.name, '__Q__')
  return u.href.replace('__Q__', '{q}')
}

/** 真去搜一次：结果页能打开、里面出现搜的词，才算找对了 */
async function verify(template, kind) {
  const word = '红楼梦'
  try {
    const page = await get(template.replace('{q}', encodeURIComponent(word)))
    if (blocked(page) || page.status >= 400) return false
    if (kind === 'opds') return /<feed\b/i.test(page.text)
    return page.text.includes(word) || page.text.includes(encodeURIComponent(word))
  } catch { return false }
}

const LLM_SYSTEM = `你帮用户找出一个网站的「搜索结果页地址」。给你这个网站首页里的表单和带「搜索」字样的链接。
如果能确定用 GET 方式搜索，输出它的地址模板：把搜索词的位置写成 {q}。只输出 JSON：{"url":"https://…{q}…","why":"一句话"}。
有的网站是 JS 渲染的，首页里看不到表单；这时如果你确切知道这个网站的搜索结果页地址，也可以给出（why 里说明是凭了解给的）。
确定不了（比如只能 POST、要登录、没有搜索功能）就输出 {"url":"","why":"原因"}。不要编造网站没有的参数。`

/**
 * @param {string} input 用户给的网址（可以不带 https://）
 * @param {{ llm?: { complete: Function } | null }} [o]
 * @returns {Promise<{ name: string, url: string, kind: 'web'|'opds', verified: boolean, how: string }>}
 */
export async function discoverSearch(input, { llm } = {}) {
  let start = String(input || '').trim()
  if (!start) throw bad('请填网站地址')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(start) && !/^https?:\/\//i.test(start)) throw bad('只能是 http 或 https 网址')
  if (!/^https?:\/\//i.test(start)) start = 'https://' + start
  let base
  try { base = new URL(start) } catch { throw bad('这不是一个网址') }
  if (!/^https?:$/.test(base.protocol)) throw bad('只能是 http 或 https 网址')

  let page
  try { page = await get(base.href) } catch (e) { throw bad(`打不开这个网站（${e.message}）`) }
  if (blocked(page)) throw bad('这个网站有人机验证（比如 Cloudflare 的「Just a moment…」），插件访问不了。可以手动加：在浏览器里用它的搜索框搜一次，复制结果页地址，把搜的词换成 {q}')
  if (page.status >= 400) throw bad(`网站返回了错误（HTTP ${page.status}）`)
  const name = siteName(page, page.url)

  // OPDS 书库：地址本身就是 Atom 目录
  if (/<feed\b/i.test(page.text.slice(0, 3000))) {
    const link = [...page.text.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).find(l => /search/i.test(attr(l, 'rel')))
    if (link) {
      const href = new URL(attr(link, 'href'), page.url).href
      const t = /\{searchTerms\}/.test(href) ? { url: href.replace('{searchTerms}', '{q}'), kind: 'opds' } : fromOpenSearch((await get(href)).text, href, /atom|opds/)
      if (t) return { name, ...t, kind: 'opds', verified: await verify(t.url, 'opds'), how: '这是 OPDS 书库，用它声明的搜索地址' }
    }
    throw bad('这是 OPDS 目录，但没有声明搜索地址')
  }

  // 1. OpenSearch 描述
  const os = [...page.text.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).find(l => /\bsearch\b/i.test(attr(l, 'rel')) && /opensearch/i.test(attr(l, 'type')))
  if (os) {
    try {
      const href = new URL(attr(os, 'href'), page.url).href
      const t = fromOpenSearch((await get(href)).text, href)
      if (t) {
        const ok = await verify(t.url, t.kind)
        if (ok) return { name, ...t, verified: true, how: '网站自己声明了搜索地址（OpenSearch）' }
      }
    } catch { /* 换下一种 */ }
  }

  // 2. 搜索表单
  const forms = parseForms(page.text, page.url)
  for (const f of forms) {
    const t = formTemplate(f)
    if (t && await verify(t, 'web')) return { name, url: t, kind: 'web', verified: true, how: '找到了网页上的搜索框' }
  }

  // 3. 交给模型
  if (llm) {
    const links = [...page.text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ href: attr(m[1], 'href'), text: m[2].replace(/<[^>]+>/g, '').trim() }))
      .filter(l => /search|搜索|搜书|查找/i.test(`${l.href} ${l.text}`)).slice(0, 15)
    const material = `网站：${page.url}\n标题：${name}\n\n表单：\n${forms.slice(0, 8).map(f => `- ${f.method.toUpperCase()} ${f.action} 输入框：${f.inputs.map(i => `${i.name}(${i.type}${i.value ? '=' + i.value : ''}${i.placeholder ? '，提示「' + i.placeholder + '」' : ''})`).join('、') || '无'}`).join('\n') || '（没有）'}\n\n带「搜索」的链接：\n${links.map(l => `- ${l.text} → ${l.href}`).join('\n') || '（没有）'}`
    try {
      const out = String(await llm.complete({ system: LLM_SYSTEM, user: material, maxTokens: 1500 }))
      const j = JSON.parse((/\{[\s\S]*\}/.exec(out) || ['{}'])[0])
      if (j.url && j.url.includes('{q}')) {
        const t = new URL(j.url.replace('{q}', '__Q__'), page.url).href.replace('__Q__', '{q}')
        if (/^https?:/.test(t)) {
          const verified = await verify(t, 'web')
          return { name, url: t, kind: 'web', verified, how: `AI 判断：${String(j.why || '').slice(0, 60)}${verified ? '' : '（没能自动验证，加上后点一下试试）'}` }
        }
      }
      if (j.why) throw bad(`没找到能用的搜索地址：${String(j.why).slice(0, 80)}。可以手动加：在浏览器里用它的搜索框搜一次，复制结果页地址，把搜的词换成 {q}`)
    } catch (e) { if (e.status) throw e }
  }
  if (forms.some(f => f.method === 'post')) throw bad('这个网站的搜索用的是 POST 方式，没法做成搜索地址')
  throw bad('没找到这个网站的搜索功能。可以手动加：在浏览器里用它的搜索框搜一次，复制结果页地址，把搜的词换成 {q}')
}
