// Re-runnable Overpass fetch. Writes data/raw/*.json.
//   node scripts/fetch-osm.mjs            # fetch anything missing
//   node scripts/fetch-osm.mjs --force    # refetch everything
//
// Data (c) OpenStreetMap contributors, ODbL.

import { writeFile, readFile, mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')

// IIT Kanpur campus: OSM way 52434888. BBox padded slightly past the wall.
export const CAMPUS_WAY = 52434888
export const BBOX = '26.4995,80.2180,26.5265,80.2480'

// Override to point at a private instance, or at an unreachable host to
// exercise the degraded path.
const ENDPOINTS = (process.env.OVERPASS_ENDPOINTS ?? [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)

const ATTEMPTS = Number(process.env.OVERPASS_ATTEMPTS ?? 8)

const QUERIES = {
  boundary: `[out:json][timeout:60];
way(${CAMPUS_WAY});
out geom tags;`,

  pois: `[out:json][timeout:180][bbox:${BBOX}];
(
  nwr["amenity"];
  nwr["shop"];
  nwr["building"]["name"];
  nwr["office"];
  nwr["leisure"];
  nwr["tourism"];
  nwr["healthcare"];
  nwr["emergency"];
  nwr["man_made"];
  nwr["indoor"]["name"];
  nwr["room"]["name"];
  node["highway"="street_lamp"];
);
out center tags;`,

  buildings: `[out:json][timeout:180][bbox:${BBOX}];
(way["building"];);
out geom tags;`,

  highways: `[out:json][timeout:180][bbox:${BBOX}];
(way["highway"];);
out geom tags;`,

  land: `[out:json][timeout:180][bbox:${BBOX}];
(
  way["natural"];
  way["landuse"];
  way["waterway"];
  relation["natural"="water"];
  way["barrier"="wall"];
  way["barrier"="fence"];
);
out geom tags;`,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every Overpass mirror now rejects requests without one, with a plain-text
// error rather than a status code. Omitting it silently broke `npm run fetch`.
const UA = 'iitk.nis.pet/0.1 (campus map; +https://github.com/ni5arga/iitk; hi@nis.pet)'

/**
 * Overpass reports failures as an XML or HTML page with a 200 status, and the
 * only useful part is buried in a <remark>. Logging the first 160 raw bytes
 * printed `<?xml version="1.0" encod` every time — true, and no help at all in
 * telling a query timeout apart from a rate limit.
 */
function overpassReason(text, status) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const remark = text.match(/<remark>([\s\S]*?)<\/remark>/i)?.[1]
  const para = text.match(/<p>([\s\S]*?)<\/p>/i)?.[1]
  const body = (remark && strip(remark)) || (para && strip(para)) || strip(text)
  return `HTTP ${status}: ${body.slice(0, 200) || '(empty response)'}`
}

async function overpass(query, name) {
  let lastErr
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain;charset=UTF-8' },
      })
      const text = await res.text()
      // Overpass reports runtime errors as an HTML page with a 200 status.
      if (!text.trimStart().startsWith('{')) {
        throw new Error(`${new URL(endpoint).host} — ${overpassReason(text, res.status)}`)
      }
      const json = JSON.parse(text)
      if (!Array.isArray(json.elements)) throw new Error('missing elements[]')
      return json
    } catch (err) {
      lastErr = err
      if (attempt === ATTEMPTS - 1) break
      // Jittered, so parallel jobs and reruns do not land on a struggling
      // mirror in lockstep.
      const wait = Math.round(5000 * (attempt + 1) * (0.75 + Math.random() * 0.5))
      console.warn(`  ${name}: attempt ${attempt + 1}/${ATTEMPTS} failed — ${err.message.slice(0, 120)}`)
      console.warn(`  ${name}: retrying in ${(wait / 1000).toFixed(0)}s`)
      await sleep(wait)
    }
  }
  throw new Error(`${name}: all attempts failed — ${lastErr?.message}`)
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(RAW, { recursive: true })
  /** Datasets left at their committed version because Overpass would not serve them. */
  const stale = []

  for (const [name, query] of Object.entries(QUERIES)) {
    const path = join(RAW, `${name}.json`)
    if (!force && existsSync(path)) {
      const n = JSON.parse(await readFile(path, 'utf8')).elements.length
      console.log(`= ${name}: cached (${n} elements) — use --force to refetch`)
      continue
    }
    console.log(`> ${name}: fetching…`)
    let json
    try {
      json = await overpass(query, name)
    } catch (err) {
      // One struggling mirror used to throw away the whole run. `land` failed
      // its attempts while pois, buildings and highways had already come back
      // clean, and exiting here discarded all of them — so the weekly refresh
      // produced nothing at all because of six bad seconds on someone else's
      // server. Keep the committed copy for this one dataset and carry on; the
      // churn guard sees an unchanged file and the rest of the refresh lands.
      if (existsSync(path)) {
        const n = JSON.parse(await readFile(path, 'utf8')).elements.length
        console.warn(`! ${name}: ${err.message}`)
        console.warn(`  ${name}: keeping the committed copy (${n} elements) and carrying on`)
        stale.push(name)
        continue
      }
      // Nothing to fall back to, so this really is fatal.
      throw err
    }
    await writeFile(path, JSON.stringify(json))
    console.log(`  ${name}: ${json.elements.length} elements`)
    await sleep(2000) // be polite to a free public API
  }

  if (stale.length === Object.keys(QUERIES).length) {
    throw new Error('every Overpass query failed — that is an outage, not churn')
  }
  if (stale.length) {
    const msg = `${stale.length} of ${Object.keys(QUERIES).length} datasets kept their ` +
      `committed version (${stale.join(', ')}) — Overpass was unreachable for them`
    console.log(`\nDone, partially. ${msg}.`)
    console.log('The next run picks them up; nothing was lost.')
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n> **Partial OSM refresh** — ${msg}.\n`)
    }
  } else {
    console.log('\nDone. Run `npm run build:data` to regenerate public/data.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
