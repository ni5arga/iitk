// Re-runnable Overpass fetch. Writes data/raw/*.json.
//   node scripts/fetch-osm.mjs            # fetch anything missing
//   node scripts/fetch-osm.mjs --force    # refetch everything
//
// Data (c) OpenStreetMap contributors, ODbL.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')

// IIT Kanpur campus: OSM way 52434888. BBox padded slightly past the wall.
export const CAMPUS_WAY = 52434888
export const BBOX = '26.4995,80.2180,26.5265,80.2480'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

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

async function overpass(query, name) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(endpoint, { method: 'POST', body: query })
      const text = await res.text()
      // Overpass reports runtime errors as an HTML page with a 200 status.
      if (!text.startsWith('{')) throw new Error(`non-JSON from ${endpoint}: ${text.slice(0, 160)}`)
      const json = JSON.parse(text)
      if (!Array.isArray(json.elements)) throw new Error('missing elements[]')
      return json
    } catch (err) {
      lastErr = err
      const wait = 5000 * (attempt + 1)
      console.warn(`  ${name}: attempt ${attempt + 1} failed (${err.message.slice(0, 80)}), retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
  throw new Error(`${name}: all attempts failed — ${lastErr?.message}`)
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(RAW, { recursive: true })

  for (const [name, query] of Object.entries(QUERIES)) {
    const path = join(RAW, `${name}.json`)
    if (!force && existsSync(path)) {
      const n = JSON.parse(await readFile(path, 'utf8')).elements.length
      console.log(`= ${name}: cached (${n} elements) — use --force to refetch`)
      continue
    }
    console.log(`> ${name}: fetching…`)
    const json = await overpass(query, name)
    await writeFile(path, JSON.stringify(json))
    console.log(`  ${name}: ${json.elements.length} elements`)
    await sleep(2000) // be polite to a free public API
  }
  console.log('\nDone. Run `npm run build:data` to regenerate public/data.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
