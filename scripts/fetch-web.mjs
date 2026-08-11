// Pulls the live, public campus sources into data/live/*.json.
//
//   node scripts/fetch-web.mjs              # faculty + mess
//   node scripts/fetch-web.mjs --only=mess  # just one source
//   node scripts/fetch-web.mjs --no-profiles  # skip the 300 profile fetches
//
//   Sources, all public and unauthenticated:
//   faculty  www.iitk.ac.in/iitk-faculty  + one profile page per person
//   mess     campusmess.in/api/{halls,menus}

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = join(ROOT, 'data/live')
const UA = 'CampusMapPlusPlus/0.1 (IITK student project; contact: hi@nis.pet)'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}`))
const only = arg('only=')?.split('=')[1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, { json = false, tries = 3 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return json ? await res.json() : await res.text()
    } catch (e) { last = e; await sleep(800 * (i + 1)) }
  }
  throw new Error(`${url}: ${last?.message}`)
}

/** Run `fn` over `items` with a fixed concurrency. */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch { out[i] = null }
    }
  }))
  return out
}

const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim()

/* ── faculty ─────────────────────────────────────────────────────────────── */

async function fetchFaculty(withProfiles) {
  const html = await get('https://www.iitk.ac.in/iitk-faculty')

  // Department headings and faculty cards, read in document order so each
  // card inherits the heading above it.
  const re = /<div class="ui--acoord-item--heading">\s*<span>([^<]+)<\/span>|<div class="iitk__faculty-card[^"]*">\s*<a href="([^"]+)"><\/a>[\s\S]*?<h4>([^<]*)<\/h4>\s*<p>([^<]*)<\/p>/g
  const list = []
  let m, dept = ''
  while ((m = re.exec(html))) {
    if (m[1]) { dept = strip(m[1]); continue }
    list.push({
      name: strip(m[3]),
      title: strip(m[4]),
      dept,
      url: m[2].startsWith('http') ? m[2] : `https://www.iitk.ac.in${m[2]}`,
    })
  }
  if (!list.length) throw new Error('faculty: parsed 0 cards — the page markup changed')

  // The listing renders at most 12 people per department. Record that so the
  // app can say so rather than implying it is the whole faculty.
  const perDept = {}
  for (const f of list) perDept[f.dept] = (perDept[f.dept] || 0) + 1
  const capped = Object.entries(perDept).filter(([, n]) => n >= 12).map(([d]) => d)

  console.log(`faculty: ${list.length} cards across ${Object.keys(perDept).length} departments`)
  if (capped.length) console.log(`  note: ${capped.length} departments hit the 12-per-department listing cap`)

  if (withProfiles) {
    console.log(`  fetching ${list.length} profile pages (concurrency 6)…`)
    let done = 0
    await pool(list, 6, async (f) => {
      const p = await get(f.url).catch(() => null)
      done++
      if (done % 50 === 0) process.stdout.write(`  …${done}/${list.length}\n`)
      if (!p) return null

      // The contact block is a run of cells, each tagged by an icon symbol:
      // #sym--mail, #sym--phone, #sym--globe, #sym--location.
      const at = p.indexOf('id="contact-info"')
      const contact = at === -1 ? '' : p.slice(at, at + 8000)
      for (const cell of contact.split('iitk__faculty--contact-cell').slice(1)) {
        const sym = cell.match(/#sym--(\w+)/)?.[1]
        if (sym === 'mail') {
          const e = cell.match(/mailto:([^"?]+)/)?.[1]
          if (e) f.email = e.trim().toLowerCase()
        } else if (sym === 'phone') {
          const t = cell.match(/tel:([0-9+\- ]{6,})/)?.[1]
          if (t) f.phone = t.trim()
        } else if (sym === 'globe') {
          const w = cell.match(/href="(https?:\/\/[^"]+)"/)?.[1]
          if (w) f.web = w
        } else if (sym === 'location') {
          // "Room 426, ESB-2<br>IIT Kanpur-208016, …" — keep the room line only.
          const addr = cell.match(/<address>([\s\S]*?)<\/address>/)?.[1] ?? ''
          const t = strip(addr.split(/<br\s*\/?>/i)[0] ?? '')
          if (t && t.length < 120) f.office = t
        }
      }
      if (!f.email) {
        const e = p.match(/mailto:([^"?]+@iitk\.ac\.in)/i)?.[1]
        if (e) f.email = e.toLowerCase()
      }

      const research = p.match(/id="research-interest"[\s\S]*?iitk__inner-content">([\s\S]*?)<\/div>/)?.[1]
      if (research) {
        const t = strip(research)
        if (t && t.length < 400) f.research = t
      }
      const qual = p.match(/<h5 aria-label="[^"]*"[^>]*>([^<]+)<\/h5>/)?.[1]
      if (qual) f.qualification = strip(qual)
      return true
    })
    const withEmail = list.filter((f) => f.email).length
    const withOffice = list.filter((f) => f.office).length
    console.log(`  enriched: ${withEmail} emails, ${withOffice} offices`)
  }

  return {
    _source: 'https://www.iitk.ac.in/iitk-faculty',
    _fetched: new Date().toISOString(),
    _note: 'Public faculty directory published by IIT Kanpur. The listing page shows up to 12 people per department, so this is a subset, not the full faculty roll.',
    _capped_departments: capped,
    items: list,
  }
}

/* ── mess ────────────────────────────────────────────────────────────────── */

async function fetchMess() {
  const [halls, menus] = await Promise.all([
    get('https://campusmess.in/api/halls', { json: true }),
    get('https://campusmess.in/api/menus', { json: true }),
  ])
  const H = halls.data ?? [], M = menus.data ?? []
  if (!H.length || !M.length) throw new Error('mess: empty response')

  const hallById = new Map(H.map((h) => [h.id, h]))
  const items = M
    .filter((m) => m.status === 'approved' && m.description)
    .map((m) => ({
      hall: hallById.get(m.hallId)?.name ?? `Hall ${m.hallId}`,
      day: m.dayOfWeek,
      meal: m.mealType,
      menu: m.description.trim(),
      ...(m.extras?.trim() ? { extras: m.extras.trim() } : {}),
      updated: m.lastUpdated?.slice(0, 10),
    }))

  console.log(`mess: ${items.length} approved menus across ${H.length} halls`)
  return {
    _source: 'https://campusmess.in/api',
    _fetched: new Date().toISOString(),
    _note: 'Community-maintained mess menus from campusmess.in. Approved rows only.',
    halls: H.filter((h) => h.isVisible !== false).map((h) => ({
      name: h.name, type: h.type, tags: h.tags ?? [],
    })),
    items,
  }
}

/* ── main ────────────────────────────────────────────────────────────────── */

const TASKS = {
  faculty: () => fetchFaculty(!process.argv.includes('--no-profiles')),
  mess: fetchMess,
}

async function main() {
  await mkdir(LIVE, { recursive: true })
  const names = only ? [only] : Object.keys(TASKS)
  let failed = 0
  for (const name of names) {
    const task = TASKS[name]
    if (!task) { console.error(`unknown source "${name}" — have: ${Object.keys(TASKS).join(', ')}`); process.exit(1) }
    try {
      const data = await task()
      await writeFile(join(LIVE, `${name}.json`), JSON.stringify(data, null, 1))
      console.log(`  -> data/live/${name}.json\n`)
    } catch (e) {
      failed++
      console.error(`! ${name} failed: ${e.message}`)
      console.error(`  keeping any existing data/live/${name}.json\n`)
    }
  }
  process.exit(failed && failed === names.length ? 1 : 0)
}

main()
