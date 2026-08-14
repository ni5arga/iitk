// Bakes the seeded pixel art into public/data/pixels-seed.json.
//
//   node scripts/build-pixels.mjs
//
// The seed is a static file, not stored data: it is the same for everyone, it
// never changes at runtime, and keeping it out of KV means the canvas has
// something on it before a single write happens. User-drawn pixels layer on
// top and win wherever they overlap.

import { writeFile, mkdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/data')

// Reuse the exact grid maths the browser and the Functions use.
const GRID_TMP = join(ROOT, 'node_modules/.cache/pixel-grid.mjs')
await build({
  entryPoints: [join(ROOT, 'src/pixels/grid.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: GRID_TMP, logLevel: 'silent',
})
const G = await import(GRID_TMP + `?t=${Date.now()}`)

/* ── palette shorthand ───────────────────────────────────────────────────── */
// One character per colour so the sprites below stay readable as pictures.

const C = {
  '.': 0,                                    // transparent
  k: 1, d: 2, g: 3, l: 4, w: 5,              // black -> white
  M: 6, R: 7, r: 8, S: 9,                    // maroon, red, salmon
  O: 10, o: 11, A: 12, y: 13, Y: 14,         // orange -> pale yellow
  G: 15, n: 16, N: 17,                       // greens
  T: 18, t: 19, c: 20,                       // teals / cyan
  B: 21, b: 22, L: 23,                       // blues
  V: 24, v: 25, e: 26,                       // indigo / periwinkle
  P: 27, p: 28, x: 29,                       // purples
  m: 30, f: 31, h: 32,                       // magenta / pinks
}

/** Turn rows of characters into pixels, validating the rectangle. */
function sprite(name, rows) {
  const w = rows[0].length
  rows.forEach((r, i) => {
    if (r.length !== w) {
      throw new Error(`${name}: row ${i} is ${r.length} wide, expected ${w}\n  "${r}"`)
    }
    for (const ch of r) {
      if (!(ch in C)) throw new Error(`${name}: row ${i} uses unknown colour "${ch}"`)
    }
  })
  const px = []
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = C[ch]
      if (c !== 0) px.push([x, y, c])
    })
  })
  return { name, w, h: rows.length, px }
}

/** Horizontal-stripe flag. `stripes` is [colourChar, rowCount] pairs. */
function flag(name, width, stripes) {
  const rows = []
  for (const [ch, n] of stripes) for (let i = 0; i < n; i++) rows.push(ch.repeat(width))
  return sprite(name, rows)
}

/* ── anime girls ─────────────────────────────────────────────────────────── */
// Chibi busts, 16 wide. At 2 m per pixel each is about 32 m across — roughly
// one building, which is the largest thing that still reads as a sprite.

const pinkTwintails = sprite('pink-twintails', [
  '.....kkkkkk.....',
  '...kkffffffkk...',
  '..kffffffffffk..',
  '.kffffffffffffk.',
  '.kffYYYYYYYYffk.',
  'kffYYYYYYYYYYffk',
  'kfYYYYYYYYYYYYfk',
  'kfYYYYYYYYYYYYfk',
  'kfYwBYYYYYYBwYfk',
  'kfYwBYYYYYYBwYfk',
  'kfYYYYYYYYYYYYfk',
  'kfYhYYYkkYYYhYfk',
  'kfYYYYYYYYYYYYfk',
  '.kffYYYYYYYYffk.',
  '..kkffffffffkk..',
  'ff.kkkYYYYkkk.ff',
  'fff..kwwwwk..fff',
  'fff.kwwwwwwk.fff',
  '.ffkwwwwwwwwkff.',
  '..fkwwwwwwwwkf..',
  '...kwwwwwwwwk...',
  '...kkkkkkkkkk...',
])

const blueBob = sprite('blue-bob', [
  '....kkkkkkkk....',
  '..kkbbbbbbbbkk..',
  '.kbbbbbbbbbbbbk.',
  'kbbbbbbbbbbbbbbk',
  'kbbYYYYYYYYYYbbk',
  'kbYYYYYYYYYYYYbk',
  'kbYYYYYYYYYYYYbk',
  'kbYYYYYYYYYYYYbk',
  'kbYwPYYYYYYPwYbk',
  'kbYwPYYYYYYPwYbk',
  'kbYYYYYYYYYYYYbk',
  'kbYhYYYwwYYYhYbk',
  'kbYYYYYYYYYYYYbk',
  '.kbbYYYYYYYYbbk.',
  '..kkbbbbbbbbkk..',
  '..kkkkYYYYkkkk..',
  '...kkkwwwwkkk...',
  '..kLLwwwwwwLLk..',
  '.kLLLwwwwwwLLLk.',
  '.kLLLLwwwwLLLLk.',
  '.kLLLLLLLLLLLLk.',
  '..kkkkkkkkkkkk..',
])

const purpleLong = sprite('purple-long', [
  '....kkkkkkkk....',
  '..kkppppppppkk..',
  '.kpppppppppppppk',
  'kppppppppppppppk',
  'kppYYYYYYYYYYppk',
  'kpYYYYYYYYYYYYpk',
  'kpYYYYYYYYYYYYpk',
  'kpYYYYYYYYYYYYpk',
  'kpYwtYYYYYYtwYpk',
  'kpYwtYYYYYYtwYpk',
  'kpYYYYYYYYYYYYpk',
  'kpYhYYYkkYYYhYpk',
  'kpYYYYYYYYYYYYpk',
  'kppYYYYYYYYYYppk',
  '.kppppppppppppk.',
  'pp.kkkYYYYkkk.pp',
  'ppp.kwwwwwwk.ppp',
  'ppp.kwwwwwwk.ppp',
  '.ppkwwwwwwwwkpp.',
  '.ppkwwwwwwwwkpp.',
  '..pkwwwwwwwwkp..',
  '...kkkkkkkkkk...',
])

// Bocchi. 32 x 40 — 64 m by 80 m on the ground, the largest piece by a wide
// margin, so it wants an open field rather than a rooftop.
const bocchi = sprite('bocchi', [
  "..............kk................",
  ".............khk................",
  "............khhk................",
  "..........kkhhhkk...............",
  ".......kkkhhhhhhkkk.............",
  ".....kkhhhhhhhhhhhhkk...........",
  "....khhhhhhhhhhhhhhhhk..........",
  "...khhhhhhhhhhhhhhhhhhk.........",
  "..khhhhhhhhhhhhhhhhhhhhk........",
  "..khhhhhhhhhhhhhhhhhhhhhk.......",
  ".khhhhhhhhhhhhhhhhhhhhhhhk......",
  ".khhhhhhhhhhhhhhhhhhhhhhhhk.....",
  "khhhhhhhhhhhhhhhhhhhhhhhhhhk....",
  "khhhhhhhhhhhhhhhhhhhhhhhhhhk....",
  "khhhhhkYYYYYYYYYYYYkhhhhhhhk....",
  "khhhhkYYYYYYYYYYYYYYkhhhhhhk....",
  "khhhkYYYYYYYYYYYYYYYYkhhhhhk....",
  "khhhkYYYYYYYYYYYYYYYYkhhhhhk....",
  "khhhkYkBBkYYYYYYkBBkYkhhhhhk....",
  "khhhkYkBckYYYYYYkBckYkhhhhhk....",
  "khhhkYkBBkYYYYYYkBBkYkhhhhhk....",
  "khhhkYYYYYYYYYYYYYYYYkhhhhhk....",
  "khhhkYSYYYYYYYYYYYYSYkhhhhhk....",
  "khhhkYYYYYYkwwkYYYYYYkhhhhhk....",
  "khhhhkYYYYYYYYYYYYYYkhhhhhhk....",
  "khhhhhkYYYYYYYYYYYYkhhhhhhhk....",
  "khhhhhhkkYYYYYYYYkkhhhhhhhhk....",
  "khhhhhhhhkkkkkkkkhhhhhhhhhhk....",
  "khhhhhhhhhhhhhhhhhhhhhhhhhhk....",
  ".khhhhhhhhhhhhhhhhhhhhhhhhk.....",
  ".kffhhhhhhhhhhhhhhhhhhhhffk.....",
  "..kffhhhhhhhhhhhhhhhhhhfffk.....",
  "...kkffhhhhhhhhhhhhhhffkk.......",
  ".....kkkfffhhhhhhfffkkk.........",
  "........kkkwwwwwwkkk............",
  ".......khwwwwwwwwwwhk...........",
  "......khhwwwwwwwwwwhhk..........",
  ".....khhhwwwwwwwwwwhhhk.........",
  ".....khhhhwwwwwwwwhhhhk.........",
  ".....kkkkkkkkkkkkkkkkkk.........",
])

/* ── pride flags ─────────────────────────────────────────────────────────── */

const FLAGS = [
  flag('pride-rainbow', 24, [['r', 3], ['o', 3], ['y', 3], ['n', 3], ['b', 3], ['P', 3]]),
  flag('trans', 24, [['L', 3], ['h', 3], ['w', 3], ['h', 3], ['L', 3]]),
  flag('bisexual', 24, [['m', 6], ['v', 3], ['B', 6]]),
  flag('lesbian', 24, [['O', 3], ['o', 3], ['w', 3], ['h', 3], ['m', 3]]),
  flag('nonbinary', 24, [['y', 4], ['w', 4], ['v', 4], ['k', 4]]),
  flag('pansexual', 24, [['f', 5], ['y', 5], ['c', 5]]),
  flag('asexual', 24, [['k', 4], ['g', 4], ['w', 4], ['P', 4]]),
  flag('progress-stripe', 24, [['k', 2], ['M', 2], ['L', 2], ['h', 2], ['w', 2],
                               ['r', 2], ['o', 2], ['y', 2], ['n', 2], ['b', 2], ['P', 2]]),
]

/* ── placement ───────────────────────────────────────────────────────────── */
// Anchored to real campus features so the art sits somewhere meaningful rather
// than floating in a field. Offsets are in pixels from the anchor's centre.

const PLACEMENTS = [
  { art: pinkTwintails, at: 'New Lecture Hall Complex', dx: -34, dy: -30 },
  { art: blueBob, at: 'Hall 5 Mess', dx: 26, dy: -34 },
  { art: purpleLong, at: 'P K Kelkar Library', dx: 30, dy: 16 },
  { art: bocchi, at: 'Pronite Ground', dx: -16, dy: -20, fallback: 'Auditorium Grounds' },

  { art: FLAGS[0], at: 'Open Air Theatre', dx: -12, dy: -26 },
  { art: FLAGS[1], at: 'Hall 12 Mess', dx: -12, dy: -28 },
  { art: FLAGS[2], at: 'Hall 9 Mess', dx: -12, dy: -28 },
  { art: FLAGS[3], at: 'Hall 2 Mess', dx: -12, dy: -30 },
  { art: FLAGS[4], at: 'Computer Centre', dx: -12, dy: -28 },
  { art: FLAGS[5], at: 'Health Centre', dx: -12, dy: -26 },
  { art: FLAGS[6], at: 'Hall 3 Mess', dx: -12, dy: -28 },
  { art: FLAGS[7], at: 'Students Gymkhana', dx: -12, dy: -26, fallback: 'Main Auditorium' },
]

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const byName = new Map(campus.pois.map((p) => [p.name, p]))

const board = new Map() // "x,y" -> colour, so later art wins on overlap
const placed = []
const warnings = []

for (const { art, at, dx, dy, fallback } of PLACEMENTS) {
  const poi = byName.get(at) ?? (fallback ? byName.get(fallback) : undefined)
  if (!poi) { warnings.push(`no anchor "${at}" — skipped ${art.name}`); continue }

  const centre = G.lonLatToPixel(poi.lon, poi.lat)
  const ox = centre.x + dx
  const oy = centre.y + dy

  let clipped = 0
  for (const [px, py, c] of art.px) {
    const x = ox + px, y = oy + py
    if (!G.inBounds(x, y)) { clipped++; continue }
    board.set(`${x},${y}`, c)
  }
  if (clipped) warnings.push(`${art.name}: ${clipped}px fell outside the grid`)
  placed.push({ name: art.name, at: poi.name, x: ox, y: oy, w: art.w, h: art.h })
}

const pixels = [...board].map(([k, c]) => {
  const [x, y] = k.split(',')
  return [+x, +y, c]
})

const payload = {
  _note: 'Seeded artwork, baked at build time. Not user data and not stored in KV.',
  _author: 'nisarga@cse.iitk.ac.in',
  grid: { w: G.GRID_W, h: G.GRID_H, pixelMetres: G.PIXEL_M, chunk: G.CHUNK },
  placed,
  pixels,
}

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'pixels-seed.json'), JSON.stringify(payload))

console.log(`seed art: ${placed.length} pieces, ${pixels.length} pixels`)
for (const p of placed) {
  console.log(`  ${p.name.padEnd(18)} ${String(p.w).padStart(2)}x${String(p.h).padStart(2)}  at ${p.at}`)
}
console.log(`output   ${(JSON.stringify(payload).length / 1024).toFixed(1)} kB`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  ! ${w}`)
}
