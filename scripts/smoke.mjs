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
const html = await readFile(join(ROOT, 'index.html'), 'utf8')
const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

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

const wanted = new Map() // id -> file
for (const file of await walk(srcDir)) {
  const code = await readFile(file, 'utf8')
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
}

// Elements the app creates at runtime rather than declaring in the markup.
const RUNTIME_IDS = new Set(['route-badge'])

const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
ok(orphans.length === 0, `all ${wanted.size} referenced ids exist in index.html`,
   orphans.map(([id, f]) => `#${id} (${f})`).join(', '))

await rm(TMP, { force: true })
await rm(ROUTER_TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
