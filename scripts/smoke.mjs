// Headless smoke test of the two pure-logic modules — the search index and the
// router. Bundles the TS with esbuild (already a Vite dependency), runs the
// queries from the README, and asserts the answers are sane.
//
//   npm run smoke

import { build } from 'esbuild'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'node_modules/.cache/smoke.mjs')

let failures = 0
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

await build({
  entryPoints: [join(ROOT, 'src/search/engine.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
})
const { SearchIndex } = await import(TMP + `?t=${Date.now()}`)

const ROUTER_TMP = join(ROOT, 'node_modules/.cache/smoke-router.mjs')
await build({
  entryPoints: [join(ROOT, 'src/route/router.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: ROUTER_TMP, logLevel: 'silent',
})
const { Router, humanEta } = await import(ROUTER_TMP + `?t=${Date.now()}`)

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const graph = JSON.parse(await readFile(join(ROOT, 'public/data/graph.json'), 'utf8'))

/* ── search ──────────────────────────────────────────────────────────────── */

console.log('\nsearch')
const index = new SearchIndex(campus, { onLayer: () => {}, onAction: () => {} })
console.log(`  ${index.docs.length} documents indexed`)

const top = (q) => index.search(q)[0]
const titles = (q, n = 3) => index.search(q).slice(0, n).map((h) => h.title)

ok(top('L20')?.title === 'Lecture Hall 20', 'L20 -> Lecture Hall 20', top('L20')?.title)
ok(top('l7')?.title === 'Lecture Hall 7', 'l7 -> Lecture Hall 7', top('l7')?.title)
ok(/Mess/.test(top('mess dinner')?.title ?? ''), 'mess dinner -> a mess', top('mess dinner')?.title)
ok((index.search('mess dinner')[0]?.sub ?? '').length > 20, 'mess dinner shows the actual menu',
   (index.search('mess dinner')[0]?.sub ?? '').slice(0, 60))
ok(top('water')?.cat === 'water' || top('water')?.kind === 'layer', 'water -> water layer/place', top('water')?.title)
ok(titles('cycle parking').some((t) => /[Cc]ycle/.test(t)), 'cycle parking', titles('cycle parking').join(' / '))
ok(top('atm') != null, 'atm', top('atm')?.title)
ok(top('kd')?.title?.includes('Kadim') || titles('kd').some((t) => t.includes('Kadim')),
   'kd -> Kadim Diwan building', titles('kd').join(' / '))
ok(index.search('library').length > 0, 'library', titles('library').join(' / '))
ok(index.search('hall 5').length > 0, 'hall 5', titles('hall 5').join(' / '))

const person = index.search('professor').find((h) => h.kind === 'person')
ok(!!person, 'professor -> a person', person?.title)

// A real surname from the fetched directory, so the test tracks live data.
const someone = campus.faculty?.items.find((f) => f.email && f.name.split(' ').length > 1)
if (someone) {
  const surname = someone.name.split(' ').pop()
  const found = index.search(surname).some((h) => h.person?.name === someone.name)
  ok(found, `surname "${surname}" finds ${someone.name}`)
}

// The listing page shows 12 per department behind a Load More button. If the
// paging breaks we fall back to ~305 people and nobody notices.
const fac = campus.faculty
if (fac) {
  ok(fac.items.length > 600, `faculty roll is complete (${fac.items.length})`,
     fac.items.length <= 600 ? 'load-more paging probably broke' : '')
  ok((fac._incomplete_departments ?? []).length === 0, 'no department came back short',
     (fac._incomplete_departments ?? []).map((d) => `${d.dept} ${d.got}/${d.expected}`).join(', '))

  // One card per person, even for the 59 with joint appointments.
  const byUrl = new Map()
  for (const f of fac.items) byUrl.set(f.url, (byUrl.get(f.url) ?? 0) + 1)
  const repeats = [...byUrl].filter(([, n]) => n > 1)
  ok(repeats.length === 0, 'no duplicate faculty records',
     repeats.slice(0, 3).map(([u]) => u).join(', '))

  // Searching a cross-listed name must return exactly one row.
  const joint = fac.items.find((f) => f.depts?.length > 1)
  if (joint) {
    const hits = index.search(joint.name).filter((h) => h.person?.url === joint.url)
    ok(hits.length === 1, `"${joint.name}" appears once despite ${joint.depts.length} departments`,
       `${hits.length} rows`)
  }
}

// Known gaps must return nothing rather than a bad guess.
ok(index.search('PH101').every((h) => h.kind !== 'place' || !/PH101/i.test(h.title)),
   'PH101 has no fake course result')

console.log('\n  latency')
for (const q of ['m', 'mess dinner', 'lecture hall', 'water cooler', 'a']) {
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) index.search(q)
  const per = (performance.now() - t0) / 50
  ok(per < 12, `"${q}" ${per.toFixed(2)}ms/query`)
}

/* ── routing ─────────────────────────────────────────────────────────────── */

console.log('\nrouting')
const router = new Router(graph)
const find = (n) => campus.pois.find((p) => p.name === n)

const pairs = [
  ['Hall 5 Mess', 'New Lecture Hall Complex'],
  ['P K Kelkar Library', 'Lecture Hall 20'],
  ['Hall 12 Mess', 'Computer Centre'],
  ['Hall 2 Mess', 'H.R. Kadim Diwan Building'],
]
for (const [a, b] of pairs) {
  const A = find(a), B = find(b)
  if (!A || !B) { ok(false, `${a} -> ${b}`, 'POI missing'); continue }
  const walk = router.route(A, B, 'foot')
  const bike = router.route(A, B, 'bike')
  if (!walk || !bike) {
    ok(false, `${a} -> ${b}`, `no route on ${!walk && !bike ? 'either profile' : !walk ? 'foot' : 'bike'}`)
    continue
  }
  const straight = Math.hypot((A.lat - B.lat) * 111320, (A.lon - B.lon) * 99000)
  const detour = walk.metres / Math.max(straight, 1)
  ok(detour > 0.95 && detour < 2.6 && bike.seconds < walk.seconds,
     `${a} -> ${b}`,
     `${walk.metres}m walk ${humanEta(walk.seconds)} / cycle ${humanEta(bike.seconds)} (detour ${detour.toFixed(2)}x)`)
}

// Every pinned POI must be reachable on BOTH profiles. Checking only `foot`
// once hid a bug where buildings entered via an indoor corridor were
// unreachable by bike.
const centre = { lat: campus.meta.center[1], lon: campus.meta.center[0] }
const pinned = campus.pois.filter((p) => campus.categories[p.cat]?.pin)
for (const profile of ['foot', 'bike']) {
  const bad = pinned.filter((p) => !router.route(centre, p, profile))
  ok(bad.length === 0, `all ${pinned.length} pinned POIs reachable by ${profile}`,
     bad.length ? `${bad.length} unreachable, e.g. ${bad.slice(0, 3).map((p) => p.name).join(', ')}` : '')
}

// Cycling should never be slower than walking over the same pair.
const slower = pinned.slice(0, 60).filter((p) => {
  const w = router.route(centre, p, 'foot'), c = router.route(centre, p, 'bike')
  return w && c && c.seconds > w.seconds
})
ok(slower.length === 0, 'cycling never slower than walking',
   slower.length ? `${slower.length} pairs, e.g. ${slower[0].name}` : '')

const t0 = performance.now()
for (let i = 0; i < 30; i++) router.route(centre, pinned[i % pinned.length], 'foot')
ok((performance.now() - t0) / 30 < 40, `route latency ${((performance.now() - t0) / 30).toFixed(1)}ms`)

/* ── pixel canvas ────────────────────────────────────────────────────────── */

console.log('\npixels')
const PX_TMP = join(ROOT, 'node_modules/.cache/smoke-pixels.mjs')
await build({
  entryPoints: [join(ROOT, 'src/pixels/grid.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: PX_TMP, logLevel: 'silent',
})
const PX = await import(PX_TMP + `?t=${Date.now()}`)
const seed = JSON.parse(await readFile(join(ROOT, 'public/data/pixels-seed.json'), 'utf8'))

// The grid maths is duplicated across the browser, the seed script and the
// Functions. If it ever drifts, every stored pixel silently moves.
//
// The property that matters is that a pixel id survives a round trip exactly.
// `pixelToLonLat` returns the north-west corner, so a *point* inside a cell can
// sit up to one diagonal from it — that is the geometry, not an error.
let idBad = 0
for (let i = 0; i < 500; i++) {
  const x = (i * 37) % PX.GRID_W, y = (i * 53) % PX.GRID_H
  const [lon, lat] = PX.pixelToLonLat(x, y)
  const back = PX.lonLatToPixel(lon + 1e-9, lat - 1e-9)
  if (back.x !== x || back.y !== y) idBad++
}
ok(idBad === 0, 'pixel ids survive a lon/lat round trip exactly', `${idBad} drifted`)

const diagonal = PX.PIXEL_M * Math.SQRT2
let worst = 0
for (const p of campus.pois.slice(0, 200)) {
  const px = PX.lonLatToPixel(p.lon, p.lat)
  const [lon, lat] = PX.pixelToLonLat(px.x, px.y)
  worst = Math.max(worst, Math.hypot((lat - p.lat) * 111320, (lon - p.lon) * 99600))
}
ok(worst <= diagonal, `points land inside their cell (worst ${worst.toFixed(2)}m of ${diagonal.toFixed(2)}m)`)

ok(seed.pixels.length > 1000, `seed art present (${seed.pixels.length} pixels)`)
ok(seed.placed.length >= 10, `${seed.placed.length} seeded pieces`)

/* ── campus ip whitelist ─────────────────────────────────────────────────── */

// A whitelist that is wrong in either direction is a real problem: too narrow
// and campus gets the public 30-pixel budget, too wide and 500/min is handed to
// the open internet. The bit-prefix maths is worth pinning down.
console.log('\nip whitelist')
const IP_TMP = join(ROOT, 'node_modules/.cache/smoke-ip.mjs')
await build({
  entryPoints: [join(ROOT, 'functions/api/pixels/[[path]].ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: IP_TMP, logLevel: 'silent',
})
const FN = await import(IP_TMP + `?t=${Date.now()}`)
const hit = (ip, cidr) => {
  const b = FN.parseIp(ip)
  return !!b && FN.inCidr(b, cidr)
}

const IITK = ['202.3.77.0/24', '103.246.106.0/24', '161.248.106.0/24', '2001:df0:92::/48']
const inAny = (ip) => IITK.some((c) => hit(ip, c))

for (const ip of ['202.3.77.1', '202.3.77.255', '103.246.106.77', '161.248.106.9']) {
  ok(inAny(ip), `${ip} is campus`)
}
// The /24s must not bleed into the neighbouring block.
for (const ip of ['202.3.78.1', '103.246.107.1', '161.248.105.255', '8.8.8.8', '1.1.1.1']) {
  ok(!inAny(ip), `${ip} is not campus`)
}
ok(inAny('2001:df0:92::1'), '2001:df0:92::1 is campus (v6)')
ok(inAny('2001:df0:92:abcd:1:2:3:4'), 'a full v6 address inside the /48 is campus')
ok(!inAny('2001:df0:93::1'), '2001:df0:93::1 is outside the /48')
ok(!inAny('2001:df0:0092::1') === false, 'leading zeroes in a hextet still match')

// An IPv4-mapped v6 address is the same host as its v4 form.
ok(inAny('::ffff:202.3.77.5'), 'ipv4-mapped v6 folds down to the v4 rule')
// Families must not cross-match.
ok(!hit('202.3.77.1', '2001:df0:92::/48'), 'v4 address does not match a v6 range')
ok(!hit('2001:df0:92::1', '202.3.77.0/24'), 'v6 address does not match a v4 range')

// Prefixes that are not on a byte boundary are where naive code breaks.
ok(hit('172.31.0.1', '172.31.0.0/17') && !hit('172.31.128.1', '172.31.0.0/17'),
  '/17 splits on the correct bit')
ok(hit('10.1.2.3', '10.0.0.0/8') && !hit('11.1.2.3', '10.0.0.0/8'), '/8 matches one octet')
ok(hit('1.2.3.4', '0.0.0.0/0'), '/0 matches everything')
ok(hit('1.2.3.4', '1.2.3.4') && !hit('1.2.3.5', '1.2.3.4'), 'a bare address matches only itself')

// Garbage must be rejected, not coerced into something that matches.
for (const bad of ['', 'nonsense', '999.1.1.1', '1.2.3', '1.2.3.4.5', ':::1', '2001:df0:92::/x']) {
  ok(!hit(bad, '0.0.0.0/0') || bad === '', `rejects ${JSON.stringify(bad)}`)
}
ok(FN.parseIp('999.1.1.1') === null, 'octet > 255 rejected')
ok(FN.parseIp('1.2.3') === null, 'short v4 rejected')
ok(!hit('202.3.77.1', '202.3.77.0/33'), 'prefix longer than the family is rejected')

const bad = seed.pixels.filter(([x, y, c]) =>
  !PX.inBounds(x, y) || !Number.isInteger(c) || c <= 0 || c >= PX.PALETTE.length)
ok(bad.length === 0, 'every seed pixel is in bounds with a real colour',
   bad.length ? `${bad.length} bad, e.g. ${JSON.stringify(bad[0])}` : '')

// Seed must agree with the grid it was generated against.
ok(seed.grid.w === PX.GRID_W && seed.grid.h === PX.GRID_H,
   'seed matches the current grid dimensions',
   `${seed.grid.w}x${seed.grid.h} vs ${PX.GRID_W}x${PX.GRID_H} — rerun build:data`)

const packed = PX.packChunk([{ x: 1, y: 2, c: 3 }, { x: 4, y: 5, c: 6 }])
const round = PX.unpackChunk(packed)
ok(round.length === 2 && round[1].c === 6, 'chunk pack/unpack round-trips', packed)

await rm(PX_TMP, { force: true })

/* ── map style ───────────────────────────────────────────────────────────── */

// MapLibre validates the style at runtime and refuses to render if it is
// invalid — which shows up as a page that just never loads. Catch it here.
console.log('\nmap style')
const STYLE_TMP = join(ROOT, 'node_modules/.cache/smoke-style.mjs')
await build({
  entryPoints: [join(ROOT, 'src/map/style.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: STYLE_TMP, logLevel: 'silent',
  external: ['maplibre-gl'],
})
const { buildStyle } = await import(STYLE_TMP + `?t=${Date.now()}`)
const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec')

const geo = JSON.parse(await readFile(join(ROOT, 'public/data/geo.json'), 'utf8'))
for (const theme of ['dark', 'light']) {
  const style = buildStyle(geo, campus, theme)
  const errors = validateStyleMin(style)
  ok(errors.length === 0, `${theme} style validates (${style.layers.length} layers)`,
     errors.map((e) => e.message).join(' | '))

  const missing = style.layers.filter((l) => l.source && !style.sources[l.source]).map((l) => l.id)
  ok(missing.length === 0, `${theme}: every layer has a source`, missing.join(', '))

  // A colour token left undefined renders as a black or transparent layer,
  // which is hard to spot and easy to ship.
  const bad = JSON.stringify(style).match(/"(?:[a-z-]*color)":\s*(null|"undefined")/g)
  ok(!bad, `${theme}: no undefined colours`, bad?.join(', ') ?? '')
}

/* ── DOM contract ────────────────────────────────────────────────────────── */

// Every id the TypeScript reaches for must exist in index.html. The `!`
// non-null assertions hide the mismatch from tsc, and the failure surfaces at
// runtime as "Cannot set properties of null" — i.e. a blank page.
console.log('\ndom')

// Two pages now, each with its own markup. src/pixels/* belongs to the canvas
// page; everything else to the map page. Checking against the union would let
// a genuine mismatch through.
const PAGES = [
  { html: 'index.html', src: (f) => !f.includes('/src/pixels/') },
  { html: 'pixels/index.html', src: (f) => f.includes('/src/pixels/') },
]

const srcDir = join(ROOT, 'src')
const walk = async (dir) => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}
const allSrc = await walk(srcDir)

// Elements the app creates at runtime rather than declaring in the markup.
const RUNTIME_IDS = new Set(['route-badge'])

for (const page of PAGES) {
  const html = await readFile(join(ROOT, page.html), 'utf8')
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

  const wanted = new Map()
  for (const file of allSrc.filter(page.src)) {
    const code = await readFile(file, 'utf8')
    for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
      if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
    }
    for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
      if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
    }
  }

  const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
  ok(orphans.length === 0, `${page.html}: all ${wanted.size} referenced ids exist`,
     orphans.map(([id, f]) => `#${id} (${f})`).join(', '))
}

await rm(TMP, { force: true })
await rm(ROUTER_TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
