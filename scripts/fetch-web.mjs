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
  // Cards, department headings and "Load More" buttons, read in document order
  // so each card inherits the heading above it and each button the department
  // it belongs to. The listing page markup uses double quotes; the AJAX
  // fragments below use single quotes, hence ['"] throughout.
  const CARD = `<div class=['"]iitk__faculty-card[^'"]*['"]>\\s*<a href=['"]([^'"]+)['"]>\\s*</a>[\\s\\S]*?<h4>([^<]*)</h4>\\s*<p>([^<]*)</p>`
  const HEADING = `<div class="ui--acoord-item--heading">\\s*<span>([^<]+)</span>`
  const MORE = `data-count="(\\d+)"\\s+data-totalcount="(\\d+)"\\s+data-taxon="(\\d+)"`

  const parseCards = (frag, dept) => {
    const out = []
    const re = new RegExp(CARD, 'g')
    let m
    while ((m = re.exec(frag))) {
      out.push({
        name: strip(m[2]),
        title: strip(m[3]),
        dept,
        url: m[1].startsWith('http') ? m[1] : `https://www.iitk.ac.in${m[1]}`,
      })
    }
    return out
  }

  const list = []
  const pending = [] // departments that have more behind a Load More button
  {
    const re = new RegExp(`${HEADING}|${CARD}|${MORE}`, 'g')
    let m, dept = ''
    while ((m = re.exec(html))) {
      if (m[1]) { dept = strip(m[1]); continue }
      if (m[2]) {
        list.push({
          name: strip(m[3]),
          title: strip(m[4]),
          dept,
          url: m[2].startsWith('http') ? m[2] : `https://www.iitk.ac.in${m[2]}`,
        })
        continue
      }
      // A Load More button: data-totalcount is the department's real size.
      pending.push({ dept, from: +m[5], total: +m[6], taxon: +m[7] })
    }
  }
  if (!list.length) throw new Error('faculty: parsed 0 cards — the page markup changed')

  // The listing renders 12 per department and hides the rest behind a button
  // that POSTs to /loadmore-faculty. Page through it so this is the whole roll.
  const PAGE = 12
  const jobs = []
  for (const d of pending) {
    for (let page = d.from; page * PAGE < d.total; page++) jobs.push({ ...d, page })
  }

  if (jobs.length) {
    const advertised = pending.reduce((s, d) => s + d.total, 0)
    console.log(`faculty: ${list.length} on the first page; ${pending.length} departments ` +
                `advertise ${advertised} total — fetching ${jobs.length} more pages`)
    const pages = await pool(jobs, 6, async (j) => {
      const url = `https://www.iitk.ac.in/loadmore-faculty?count=${j.page}&taxon=${j.taxon}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=replace',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return parseCards(await res.text(), j.dept)
    })
    const missed = pages.filter((p) => p === null).length
    if (missed) console.warn(`  ! ${missed} of ${jobs.length} load-more pages failed`)
    for (const p of pages) if (p) list.push(...p)
  }

  // One record per person. Joint appointments are real — Ashutosh Sharma is
  // listed under four units — so collect every department rather than dropping
  // the duplicate listing.
  const byPerson = new Map()
  for (const f of list) {
    const key = f.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/main\//, '/').toLowerCase()
    const hit = byPerson.get(key)
    if (hit) { if (!hit.depts.includes(f.dept)) hit.depts.push(f.dept); continue }
    byPerson.set(key, { ...f, depts: [f.dept] })
  }
  list.length = 0
  list.push(...byPerson.values())

  // Completeness is per department listing, so count by membership, not by the
  // primary department — otherwise cross-listed people read as missing.
  const inDept = (d) => list.filter((f) => f.depts.includes(d)).length
  const short = pending.filter((d) => inDept(d.dept) < d.total)
  const departments = new Set(list.flatMap((f) => f.depts))

  console.log(`faculty: ${list.length} people across ${departments.size} departments ` +
              `(${list.filter((f) => f.depts.length > 1).length} hold joint appointments)`)
  if (short.length) {
    console.warn(`  ! ${short.length} departments came back short: ` +
      short.map((d) => `${d.dept} ${inDept(d.dept)}/${d.total}`).join(', '))
  }

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

    // A few people have two profile pages under different slugs
    // (vivek-verma and vivek_verma). The URL key cannot see that; the email
    // can, so collapse on it once profiles are in.
    const byEmail = new Map()
    const merged = []
    for (const f of list) {
      if (!f.email) { merged.push(f); continue }
      const hit = byEmail.get(f.email)
      if (!hit) { byEmail.set(f.email, f); merged.push(f); continue }
      for (const d of f.depts) if (!hit.depts.includes(d)) hit.depts.push(d)
      // Keep whichever record is more complete.
      for (const k of ['office', 'phone', 'web', 'research', 'qualification']) {
        if (!hit[k] && f[k]) hit[k] = f[k]
      }
    }
    if (merged.length !== list.length) {
      console.log(`  merged ${list.length - merged.length} duplicate profile pages by email`)
      list.length = 0
      list.push(...merged)
    }
  }

  return {
    _source: 'https://www.iitk.ac.in/iitk-faculty',
    _fetched: new Date().toISOString(),
    _note: 'Public faculty directory published by IIT Kanpur. The listing page shows 12 per department and hides the rest behind a Load More button; this walks that endpoint, so it is the full roll.',
    _incomplete_departments: short.map((d) => ({ dept: d.dept, got: perDept[d.dept] ?? 0, expected: d.total })),
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
