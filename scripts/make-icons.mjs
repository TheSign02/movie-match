/**
 * Generates the PWA icons.
 *
 * Run:
 *   npm run icons
 *
 * A dependency-free PNG writer, because pulling in an image library to
 * draw a circle on a black square is not a trade worth making, and the
 * icons need to exist as real PNGs — iOS ignores an SVG
 * apple-touch-icon, and manifest icons are better off as raster for the
 * same reason.
 *
 * The mark is the accent dot from the waiting screen's pulse: a green
 * disc on true black. It sits inside the inner 80% so a maskable icon
 * can crop to a circle or a squircle without clipping it.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const BLACK = [0, 0, 0]
// --accent, straight from the token block.
const ACCENT = [0x1f, 0xc1, 0x3c]

/* ─── minimal PNG encoder ──────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))

  return Buffer.concat([length, body, crc])
}

/** rgba is a Buffer of width * height * 4 bytes. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte per scanline; filter 0 means "none", which costs a
  // little size and saves a lot of code.
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const src = y * width * 4
    const dst = y * (1 + width * 4)
    raw[dst] = 0
    rgba.copy(raw, dst + 1, src, src + width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ─── the mark ─────────────────────────────────────────────────────── */

/**
 * Coverage of the disc at a pixel, supersampled 3x3. Without this the
 * circle's edge is visibly stepped at 192px and worse at 32px.
 */
function coverage(px, py, cx, cy, radius) {
  let hits = 0
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3
      const y = py + (sy + 0.5) / 3
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) hits++
    }
  }
  return hits / 9
}

function drawIcon(size, radiusRatio) {
  const rgba = Buffer.alloc(size * size * 4)
  const centre = size / 2
  const radius = size * radiusRatio

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, centre, centre, radius)
      const i = (y * size + x) * 4

      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(BLACK[c] * (1 - a) + ACCENT[c] * a)
      }
      rgba[i + 3] = 255 // opaque: the black square is the icon's ground
    }
  }

  return encodePng(size, size, rgba)
}

/* ─── write them ───────────────────────────────────────────────────── */

mkdirSync('public', { recursive: true })

const icons = [
  // Standard manifest sizes.
  { file: 'public/icon-192.png', size: 192, ratio: 0.3 },
  { file: 'public/icon-512.png', size: 512, ratio: 0.3 },
  // Maskable: smaller disc so a circular or squircle crop cannot clip it.
  { file: 'public/icon-maskable-512.png', size: 512, ratio: 0.22 },
  // iOS home screen. Never transparent, and never an SVG.
  { file: 'public/apple-touch-icon.png', size: 180, ratio: 0.3 },
  { file: 'public/favicon-32.png', size: 32, ratio: 0.34 },
]

for (const { file, size, ratio } of icons) {
  const png = drawIcon(size, ratio)
  writeFileSync(file, png)
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`)
}
