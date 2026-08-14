// Turn a reference image into pixel art on the canvas palette.
//
//   node scripts/pixelify.mjs <image> --name bocchi-guitar --width 48
//
// Writes data/curated/pixel-art/<name>.json, which build-pixels.mjs picks up.
//
// The conversion itself lives in src/pixels/import.ts and is shared verbatim
// with the in-browser importer in the admin dashboard — this script only
// decodes the file and hands the pixels over. Two copies of the algorithm
// would drift, and the seed would stop matching what an admin sees in the
// live preview before they place something.
//
// Decoding goes through `sips` (macOS, already installed) to a 24-bit BMP,
// which is trivial to parse by hand and avoids an image library for a build
// step that runs a handful of times.
//
// Provenance: a converted image is somebody else's drawing. `--source` is
// recorded in the output and surfaced in the seed metadata, so the artwork is
// never silently credited to the site author.

import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'data/curated/pixel-art')

const argv = process.argv.slice(2)
const input = argv[0]
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i > -1 ? argv[i + 1] : d
}
if (!input || input.startsWith('--')) {
  console.error(
    'usage: node scripts/pixelify.mjs <image> --name <slug> [--width 48] [--tol 46]\n' +
    '                                 [--backdrop drop|holes|box] [--hole-colour 5]\n' +
    '                                 [--no-center] [--source url]')
  process.exit(1)
}

const name = opt('name', 'art')
const source = opt('source', '')
const options = {
  width: Number(opt('width', 48)),
  tolerance: Number(opt('tol', 46)),
  centre: !argv.includes('--no-center'),
  backdrop: opt('backdrop', 'drop'),
  holeColour: Number(opt('hole-colour', 5)),
}

const CONV_TMP = join(ROOT, 'node_modules/.cache/pixelify-convert.mjs')
await build({
  entryPoints: [join(ROOT, 'src/pixels/import.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: CONV_TMP, logLevel: 'silent',
})
const { convert } = await import(CONV_TMP + `?t=${Date.now()}`)

/* ── decode ──────────────────────────────────────────────────────────────── */

const tmpBmp = join(ROOT, 'node_modules/.cache/pixelify.bmp')
// Work at 4x the target so centre sampling has a real pixel to land on.
execFileSync('sips', ['-Z', String(options.width * 4), input, '--out', tmpBmp, '-s', 'format', 'bmp'],
  { stdio: 'ignore' })

function parseBmp(buf) {
  if (buf.readUInt16LE(0) !== 0x4d42) throw new Error('not a BMP')
  const dataOffset = buf.readUInt32LE(10)
  const w = buf.readInt32LE(18)
  const hRaw = buf.readInt32LE(22)
  const h = Math.abs(hRaw)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bpp ${bpp}`)
  const bytes = bpp / 8
  const stride = Math.ceil((w * bytes) / 4) * 4
  // RGBA, matching the ImageData the browser importer works on.
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcY = hRaw > 0 ? h - 1 - y : y   // BMP rows run bottom-up
    for (let x = 0; x < w; x++) {
      const o = dataOffset + srcY * stride + x * bytes
      const d = (y * w + x) * 4
      data[d] = buf[o + 2]
      data[d + 1] = buf[o + 1]
      data[d + 2] = buf[o]
      data[d + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

const img = parseBmp(await readFile(tmpBmp))
const out = convert(img, options)

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, `${name}.json`),
  JSON.stringify({ name, w: out.w, h: out.h, source, px: out.px }))
await rm(tmpBmp, { force: true })

console.log(`${name}: ${out.w}x${out.h}, ${out.px.length} pixels  (${out.w * 2}m x ${out.h * 2}m)`)
if (source) console.log(`  source: ${source}`)
