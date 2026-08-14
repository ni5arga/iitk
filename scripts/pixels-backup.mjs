// Back up the live pixel canvas, and put it back.
//
//   node scripts/pixels-backup.mjs dump
//   node scripts/pixels-backup.mjs restore data/backups/pixels-<stamp>.json
//
// The canvas has two halves and only one of them is in storage. The seeded art
// (`public/data/pixels-seed.json`) is a static file baked at build time, so
// `clearAll` never touches it and it needs no backup. Everything anyone has
// painted since lives in D1, and that is what this dumps.
//
// Restoring goes through the admin `paint` op, which stamps pixels without
// spending anyone's rate limit. Set PIXELS_ADMIN_TOKEN in the environment.
//
// Watch the D1 free tier: writes are billed per row and the daily allowance is
// 100,000. A full restore of a large canvas will exceed that in one go — the
// script says how many rows it is about to write and makes you pass --yes.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i > -1 ? argv[i + 1] : d
}
const BASE = (opt('base', 'https://iitk.nis.pet')).replace(/\/$/, '')

/** Chunks are "x,y,c,x,y,c…" strings; flatten them to triples. */
function flatten(chunks) {
  const px = []
  for (const packed of Object.values(chunks)) {
    if (!packed) continue
    const n = packed.split(',')
    for (let i = 0; i + 2 < n.length; i += 3) px.push([+n[i], +n[i + 1], +n[i + 2]])
  }
  return px
}

async function getCanvas() {
  const res = await fetch(`${BASE}/api/pixels`, { headers: { 'user-agent': 'iitk-pixels-backup' } })
  if (!res.ok) throw new Error(`GET /api/pixels -> ${res.status}`)
  return res.json()
}

async function dump() {
  const before = await getCanvas()
  const pixels = flatten(before.chunks)

  // Anyone painting mid-dump would leave the file describing a canvas that
  // never existed. The read is a single request, so a moved sequence number
  // only means the file is a moment stale — worth saying so, not worth failing.
  const after = await getCanvas()
  const drifted = after.seq !== before.seq

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = opt('out', join(ROOT, 'data/backups', `pixels-${stamp}.json`))
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({
    takenAt: new Date().toISOString(),
    source: BASE,
    seq: before.seq,
    epoch: before.epoch,
    grid: before.grid,
    count: pixels.length,
    note: 'User-painted pixels from D1. The seeded art is static and not included.',
    pixels,
  }))

  console.log(`${out}`)
  console.log(`  ${pixels.length.toLocaleString()} pixels · seq ${before.seq} · ${Object.keys(before.chunks).length} chunks`)
  if (drifted) console.log(`  note: seq moved ${before.seq} -> ${after.seq} while dumping; someone is painting`)
}

async function restore(file) {
  const token = process.env.PIXELS_ADMIN_TOKEN
  if (!token) throw new Error('set PIXELS_ADMIN_TOKEN')
  const data = JSON.parse(await readFile(file, 'utf8'))
  const pixels = data.pixels ?? []
  if (!pixels.length) throw new Error('backup has no pixels')

  if (data.grid && (data.grid.w !== 1495 || data.grid.h !== 1503)) {
    throw new Error(`backup grid ${data.grid.w}x${data.grid.h} does not match the current one`)
  }

  const batch = Number(opt('batch', 4000))
  console.log(`${pixels.length.toLocaleString()} pixels from ${data.takenAt} -> ${BASE}`)
  console.log(`  ${Math.ceil(pixels.length / batch)} requests of ${batch}, ${pixels.length.toLocaleString()} D1 row writes`)
  if (!argv.includes('--yes')) {
    console.log('  refusing without --yes (the D1 free tier allows 100,000 row writes a day)')
    return
  }

  let done = 0
  for (let i = 0; i < pixels.length; i += batch) {
    const slice = pixels.slice(i, i + batch)
    const res = await fetch(`${BASE}/api/pixels/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: 'paint', pixels: slice }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) throw new Error(`batch at ${i}: ${res.status} ${JSON.stringify(body)}`)
    done += body.affected ?? slice.length
    process.stdout.write(`\r  ${done.toLocaleString()}/${pixels.length.toLocaleString()}`)
  }
  console.log('\n  done')
}

if (cmd === 'dump') await dump()
else if (cmd === 'restore') await restore(argv[1])
else {
  console.error('usage: pixels-backup.mjs dump [--out file] [--base url]\n' +
    '       pixels-backup.mjs restore <file> [--batch 4000] [--yes] [--base url]')
  process.exit(1)
}
