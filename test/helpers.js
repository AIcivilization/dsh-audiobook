// 测试用：拼一个 ZIP（存储方式，不压缩），用来造 EPUB / DOCX

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {Record<string, string|Buffer>} files */
export function makeZip(files) {
  const locals = []
  const centrals = []
  let off = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(0, 8)
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22)
    loc.writeUInt16LE(nameBuf.length, 26); loc.writeUInt16LE(0, 28)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(0, 10)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(off, 42)
    locals.push(loc, nameBuf, data)
    centrals.push(cen, nameBuf)
    off += 30 + nameBuf.length + data.length
  }
  const cenBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cenBuf, end])
}

export function makeEpub({ title = '测试之书', author = '佚名', chapters }) {
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  }
  const items = chapters.map((_, k) => `<item id="c${k}" href="text/c${k}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = chapters.map((_, k) => `<itemref idref="c${k}"/>`).join('')
  files['OEBPS/content.opf'] = `<?xml version="1.0"?><package><metadata><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata>
    <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`
  files['OEBPS/nav.xhtml'] = `<html><body><nav epub:type="toc"><ol>${chapters.map((c, k) => (c.toc ? `<li><a href="text/c${k}.xhtml">${c.toc}</a></li>` : '')).join('')}</ol></nav></body></html>`
  chapters.forEach((c, k) => { files[`OEBPS/text/c${k}.xhtml`] = `<html><head><title>x</title><style>p{}</style></head><body>${c.html}</body></html>` })
  return makeZip(files)
}
