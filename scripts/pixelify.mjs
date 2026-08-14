// Turn a reference image into pixel art on the canvas palette.
//
//   node scripts/pixelify.mjs <image> --name bocchi-guitar --width 48
//
// Writes data/curated/pixel-art/<name>.json, which build-pixels.mjs picks up.
//
// Decoding is done by piping through `sips` (macOS, already on the machine) to
// a 24-bit BMP, which is trivial to parse by hand — that avoids pulling in an
// image library for a build step that runs a handful of times.
//
// Provenance matters here: a converted image is somebody else's drawing, not
// ours. `--source` is recorded in the output and surfaced in the seed metadata
// so the artwork is never silently credited to the site author.

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
  console.error('usage: node scripts/pixelify.mjs <image> --name <slug> [--width 48] [--tol 60] [--source url]')
  process.exit(1)
}

const name = opt('name', 'art')
const targetW = Number(opt('width', 48))
/** How close a pixel must be to a corner colour to count as background. */
const tol = Number(opt('tol', 60))
const source = opt('source', '')
/** Drop pixels whose alpha-ish brightness says "grid line", for bead charts. */
const dropGrid = argv.includes('--drop-grid')
/**
 * Sample the middle of each source block instead of averaging it. References
 * that are themselves pixel art (or bead charts drawn on a grid) get destroyed
 * by averaging — it blends neighbouring cells and the grid lines between them
 * into mud. Centre sampling reads one clean cell colour.
 */
const centre = argv.includes('--center')
/**
 * Treat only edge-connected background as transparent. Without this, a bead
 * chart's interior white cells — the eyes, the gaps that give a silhouette its
 * shape — vanish along with the outer background, and the figure renders as one
 * solid blob. `--hole-colour` is what enclosed background becomes.
 */
const fillHoles = argv.includes('--fill-holes')
const holeColour = Number(opt('hole-colour', 5))   // 5 = white

const GRID_TMP = join(ROOT, 'node_modules/.cache/pixelify-grid.mjs')
await build({
  entryPoints: [join(ROOT, 'src/pixels/grid.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: GRID_TMP, logLevel: 'silent',
})
const { PALETTE } = await import(GRID_TMP + `?t=${Date.now()}`)

/* ── decode ──────────────────────────────────────────────────────────────── */

const tmpBmp = join(ROOT, 'node_modules/.cache/pixelify.bmp')
// `-Z` fits the long edge, so ask for the width we want and let height follow.
execFileSync('sips', ['-Z', String(targetW * 4), input, '--out', tmpBmp, '-s', 'format', 'bmp'],
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
  const px = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    // BMP rows run bottom-up unless the height is negative.
    const srcY = hRaw > 0 ? h - 1 - y : y
    for (let x = 0; x < w; x++) {
      const o = dataOffset + srcY * stride + x * bytes
      const d = (y * w + x) * 3
      px[d] = buf[o + 2]
      px[d + 1] = buf[o + 1]
      px[d + 2] = buf[o]
    }
  }
  return { w, h, px }
}

const img = parseBmp(await readFile(tmpBmp))
const scale = img.w / targetW
const outW = targetW
const outH = Math.max(1, Math.round(img.h / scale))

/* ── background ──────────────────────────────────────────────────────────── */
// Sample the four corners. Reference sprites almost always sit on a flat or
// checkerboard backdrop, and both show up as corner colours.

const at = (x, y) => {
  const i = (Math.min(img.h - 1, y) * img.w + Math.min(img.w - 1, x)) * 3
  return [img.px[i], img.px[i + 1], img.px[i + 2]]
}
const bgSamples = [
  at(0, 0), at(img.w - 1, 0), at(0, img.h - 1), at(img.w - 1, img.h - 1),
  at(1, Math.floor(img.h / 2)), at(img.w - 2, Math.floor(img.h / 2)),
]
const dist2 = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  // Rough perceptual weighting: eyes are most sensitive to green.
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
}

/** Channel spread. A transparency checkerboard is perfectly neutral; artwork
 *  almost never is, even when it looks grey. */
const spread = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])
const NEUTRAL = 10

// Matching on distance alone ate the sprite: a muted purple like (111,90,109)
// sits within tolerance of a (97,97,97) checkerboard square. Requiring the
// candidate to be as neutral as the backdrop separates them cleanly.
const isBg = (c) => bgSamples.some((b) =>
  dist2(c, b) < tol * tol && (spread(b) > NEUTRAL || spread(c) <= NEUTRAL))

/* ── quantise ────────────────────────────────────────────────────────────── */

const palRgb = PALETTE.map((hex, i) => i === 0 ? null : [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
])

function nearest(c) {
  let best = 1, bd = Infinity
  for (let i = 1; i < palRgb.length; i++) {
    const d = dist2(c, palRgb[i])
    if (d < bd) { bd = d; best = i }
  }
  return best
}

const px = []
let dropped = 0
for (let y = 0; y < outH; y++) {
  for (let x = 0; x < outW; x++) {
    // Box-average the source block so downsampling does not alias to noise.
    const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
    const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
    let r = 0, g = 0, b = 0, n = 0, bgHits = 0, total = 1
    if (centre) {
      const c = at((x0 + x1) >> 1, (y0 + y1) >> 1)
      if (isBg(c)) bgHits = 1
      else { r = c[0]; g = c[1]; b = c[2]; n = 1 }
    } else {
      for (let sy = y0; sy < y1 && sy < img.h; sy++) {
        for (let sx = x0; sx < x1 && sx < img.w; sx++) {
          const c = at(sx, sy)
          if (isBg(c)) { bgHits++; continue }
          r += c[0]; g += c[1]; b += c[2]; n++
        }
      }
      total = (y1 - y0) * (x1 - x0)
    }
    // Mostly background, or nothing left after dropping it.
    if (!n || bgHits / total > 0.6) { dropped++; continue }
    const avg = [r / n, g / n, b / n]
    if (dropGrid && avg[0] > 225 && avg[1] > 225 && avg[2] > 225) { dropped++; continue }
    px.push([x, y, nearest(avg)])
  }
}

// JPEG ringing quantises into single stray pixels of a wildly wrong colour.
// Any pixel whose four neighbours agree with each other but not with it is
// noise, not detail.
if (!argv.includes('--no-despeckle')) {
  const grid = new Map(px.map(([x, y, c]) => [y * outW + x, c]))
  let fixed = 0
  for (const [key, c] of grid) {
    const x = key % outW, y = (key - x) / outW
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => grid.get((y + dy) * outW + (x + dx)))
      .filter((v) => v !== undefined)
    if (n.length < 3) continue
    const tally = new Map()
    for (const v of n) tally.set(v, (tally.get(v) ?? 0) + 1)
    const [best, count] = [...tally].sort((a, b) => b[1] - a[1])[0]
    if (best !== c && count >= n.length - 0 && count >= 3) {
      grid.set(key, best)
      fixed++
    }
  }
  if (fixed) {
    px.length = 0
    for (const [key, c] of grid) px.push([key % outW, (key - (key % outW)) / outW, c])
    console.log(`  despeckled ${fixed} stray pixels`)
  }
}

// Reclassify: background that is *not* reachable from the border is interior,
// so paint it rather than dropping it.
if (fillHoles) {
  const isPx = new Uint8Array(outW * outH)
  for (const [x, y] of px) isPx[y * outW + x] = 1
  const outside = new Uint8Array(outW * outH)
  const stack = []
  for (let x = 0; x < outW; x++) { stack.push([x, 0], [x, outH - 1]) }
  for (let y = 0; y < outH; y++) { stack.push([0, y], [outW - 1, y]) }
  while (stack.length) {
    const [x, y] = stack.pop()
    if (x < 0 || y < 0 || x >= outW || y >= outH) continue
    const i = y * outW + x
    if (outside[i] || isPx[i]) continue
    outside[i] = 1
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  let filled = 0
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const i = y * outW + x
      if (!isPx[i] && !outside[i]) { px.push([x, y, holeColour]); filled++ }
    }
  }
  console.log(`  filled ${filled} enclosed background cells with palette ${holeColour}`)
}

await mkdir(OUT, { recursive: true })
const payload = { name, w: outW, h: outH, source, px }
await writeFile(join(OUT, `${name}.json`), JSON.stringify(payload))
await rm(tmpBmp, { force: true })

console.log(`${name}: ${outW}x${outH}, ${px.length} pixels (${dropped} background)`)
if (source) console.log(`  source: ${source}`)
