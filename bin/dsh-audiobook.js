#!/usr/bin/env node
// bin/dsh-audiobook.js — 不开 DSH 也能用：导入书、打开朗读面板
//
//   dsh-audiobook import <文件> [--title 书名]   导入一本书
//   dsh-audiobook serve [--port 4811]            在浏览器里打开朗读面板（只听本机）
//   dsh-audiobook list                           看书库里有哪些书

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { ensureEdge } from '../lib/edge.js'
import { importDocument } from '../lib/importer.js'
import { findFfmpeg } from '../lib/paths.js'
import { createHandler } from '../lib/server.js'
import { createSpeech } from '../lib/speech.js'
import { listBooks } from '../lib/store.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PREFIX = '/api-dsh-audiobook'

function parse(argv) {
  const flags = {}
  const rest = []
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]
    if (a.startsWith('--')) {
      const [key, val] = a.slice(2).split('=', 2)
      if (val !== undefined) flags[key] = val
      else if (argv[k + 1] && !argv[k + 1].startsWith('--')) flags[key] = argv[++k]
      else flags[key] = true
    } else rest.push(a)
  }
  return { flags, rest }
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2))
  const cmd = rest.shift()

  if (cmd === 'list') {
    const books = await listBooks()
    if (!books.length) console.log('书库是空的。用 dsh-audiobook import <文件> 导入一本。')
    for (const b of books) console.log(`${b.id}  《${b.title}》${b.author ? ' ' + b.author : ''}  ${b.chapters} 章  听到「${b.chapterTitle}」 ${b.percent}%`)
    return
  }

  if (cmd === 'import') {
    if (!rest.length) throw new Error('用法：dsh-audiobook import <文件> [--title 书名]')
    for (const file of rest) {
      const b = await importDocument(file, { title: typeof flags.title === 'string' ? flags.title : '' })
      console.log(`${b.existed ? '已更新' : '已导入'}：《${b.title}》（${b.id}）${b.chapters} 章，${b.chars < 1000 ? `${b.chars} 字` : `约 ${Math.round(b.chars / 1000)} 千字`}`)
    }
    return
  }

  if (cmd === 'serve') {
    const port = Number(flags.port) || 4811
    const speech = createSpeech({ ffmpeg: () => findFfmpeg(flags.ffmpeg), threads: Number(flags.threads) || 2, workers: Number(flags.workers) || 2 })
    ensureEdge().catch(e => console.error(e.message))
    const handle = createHandler({ prefix: PREFIX, pkgRoot: PKG_ROOT, speech, options: () => ({ ffmpeg: flags.ffmpeg }), status: () => ({ host: 'cli' }) })
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '') { res.writeHead(302, { location: `${PREFIX}/panel` }); return res.end() }
      if (!String(req.url).startsWith(PREFIX)) { res.writeHead(404); return res.end() }
      handle(req, res)
    })
    server.listen(port, '127.0.0.1', () => console.log(`朗读面板：http://127.0.0.1:${port}${PREFIX}/panel （Ctrl+C 退出）`))
    const stop = () => { speech.stop(); server.close(); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  console.log(`搜书听 · dsh-audiobook

  dsh-audiobook import <文件> [--title 书名]   导入一本书（TXT、EPUB、PDF、DOCX、Markdown、HTML、RTF）
  dsh-audiobook serve [--port 4811]            在浏览器里打开朗读面板
  dsh-audiobook list                           看书库里有哪些书`)
}

main().catch((e) => { console.error(e.message || e); process.exit(1) })
