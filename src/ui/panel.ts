import type { Campus, Faculty, MessMenu, Poi } from '../types'
import { openNow } from '../search/hours'
import { humanDistance, humanEta } from '../route/router'
import type { Hit } from '../search/engine'

const el = document.getElementById('panel') as HTMLElement

export const REPO = 'https://github.com/ni5arga/iitk'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MEAL_ORDER = ['Breakfast', 'Lunch', 'Dinner']

export interface PanelHost {
  campus: Campus
  routeTo(lat: number, lon: number, label: string): void
  routeState(): { active: boolean; eta?: number; metres?: number }
  close(): void
}

let host: PanelHost

export function initPanel(h: PanelHost) {
  host = h
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.p-close')) { hidePanel(); host.close() }
    const r = t.closest('[data-route]') as HTMLElement | null
    if (r) host.routeTo(+r.dataset.lat!, +r.dataset.lon!, r.dataset.label!)
  })
}

export function hidePanel() { el.hidden = true }

function shell(title: string, kind: string, body: string) {
  el.hidden = false
  el.innerHTML = `
    <div class="p-grip" aria-hidden="true"></div>
    <div class="p-head">
      <div>
        <h2>${esc(title)}</h2>
        <div class="p-kind">${esc(kind)}</div>
      </div>
      <button class="p-close" aria-label="Close">&times;</button>
    </div>
    <div class="p-body">${body}</div>`
  el.querySelector('.p-body')!.scrollTop = 0
}

function kv(rows: [string, string | undefined][]) {
  const live = rows.filter(([, v]) => v)
  if (!live.length) return ''
  return `<dl class="kv">${live.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function hoursRow(spec?: string): string | undefined {
  if (!spec) return undefined
  const st = openNow(spec)
  const badge = st === null ? ''
    : st.open ? ` <span style="color:#7ee787">· open${st.until ? ` till ${st.until}` : ''}</span>`
    : ` <span style="color:#ff7b72">· closed${st.next ? ` · opens ${st.next}` : ''}</span>`
  return `${esc(spec)}${badge}`
}

function routeButtons(lat: number, lon: number, label: string) {
  const s = host.routeState()
  return `<div class="p-actions">
    <button data-route data-lat="${lat}" data-lon="${lon}" data-label="${esc(label)}"
      class="${s.active ? 'on' : ''}">${s.active && s.eta != null
        ? `${humanEta(s.eta)} · ${humanDistance(s.metres!)}`
        : 'Route here'}</button>
  </div>`
}

/* ── places ──────────────────────────────────────────────────────────────── */

/** Renders today's meals, then the rest of the week. Shared by the mess result
 *  and by any mess POI opened from the map. */
function menuSections(menus: MessMenu[]): string {
  const today = DAY_NAMES[new Date().getDay()]!
  const hour = new Date().getHours()
  const nowMeal = hour < 10 ? 'Breakfast' : hour < 15 ? 'Lunch' : hour < 22 ? 'Dinner' : null

  const one = (m: MessMenu, markNow: boolean) => `
    <div class="meal${markNow && m.meal === nowMeal ? ' now' : ''}">
      <b>${esc(m.meal)}</b>
      <span>${esc(m.menu)}</span>
      ${m.extras ? `<em>extras: ${esc(m.extras)}</em>` : ''}
    </div>`

  const forDay = (d: string) =>
    MEAL_ORDER.map((meal) => menus.find((m) => m.day === d && m.meal === meal)).filter(Boolean) as MessMenu[]

  const todays = forDay(today)
  const rest = DAY_NAMES.filter((d) => d !== today)
    .map((d) => ({ day: d, meals: forDay(d) }))
    .filter((x) => x.meals.length)

  return [
    todays.length
      ? `<div class="p-sec">Today · ${esc(today)}</div>${todays.map((m) => one(m, true)).join('')}`
      : `<p class="p-note">No menu listed for ${esc(today)}.</p>`,
    rest.length
      ? `<details class="week"><summary>Rest of the week</summary>${rest.map((x) =>
          `<div class="p-sec" style="margin:12px 0 2px">${esc(x.day)}</div>${x.meals.map((m) => one(m, false)).join('')}`,
        ).join('')}</details>`
      : '',
    `<p class="src">Menus from <a href="https://campusmess.in" target="_blank" rel="noopener">campusmess.in</a> · community-maintained</p>`,
  ].join('')
}

export function showPoi(p: Poi, menus?: MessMenu[]) {
  const cat = host.campus.categories[p.cat]
  const wheel = p.wheelchair === 'yes' ? 'step-free'
    : p.wheelchair === 'limited' ? 'limited'
    : p.wheelchair === 'no' ? 'not step-free' : undefined

  const body = [
    routeButtons(p.lat, p.lon, p.name),
    kv([
      ['Hours', hoursRow(p.hours)],
      ['Access', wheel ? esc(wheel) : undefined],
      ['Type', p.kind ? esc(p.kind.replace(/_/g, ' ')) : undefined],
      ['Cuisine', p.cuisine ? esc(p.cuisine.replace(/;/g, ', ')) : undefined],
      ['Capacity', p.capacity ? esc(p.capacity) : undefined],
      ['Covered', p.covered ? esc(p.covered) : undefined],
      ['Operator', p.operator ? esc(p.operator) : undefined],
      ['Price', p.price ? esc(p.price) : undefined],
      ['Potable', p.potable === 'no' ? 'no — not drinking water' : undefined],
      ['Phone', p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : undefined],
      ['Website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : undefined],
      ['Near', p.near ? esc(p.near) : undefined],
    ]),
    p.desc ? `<p class="p-note">${esc(p.desc)}</p>` : '',
    // A mess opened from the map should answer the actual question: what's for dinner.
    menus?.length ? menuSections(menus) : '',
    `<p class="src">${p.src === 'osm'
      ? `OpenStreetMap · <a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">${esc(p.osm)}</a>`
      : 'Hand-surveyed — verify before relying on it'}</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, body)
}

/* ── people ──────────────────────────────────────────────────────────────── */

export function showPerson(f: Faculty, at?: Poi) {
  const body = [
    at ? routeButtons(at.lat, at.lon, at.name) : '',
    kv([
      ['Dept', esc(f.dept)],
      ['Office', f.office ? esc(f.office) : undefined],
      ['On map', at ? `${esc(at.name)}${f.atVia === 'dept' ? ' <span style="color:#6b7482">(department building)</span>' : ''}` : undefined],
      ['Email', f.email ? `<a href="mailto:${esc(f.email)}">${esc(f.email)}</a>` : undefined],
      ['Phone', f.phone ? `<a href="tel:${esc(f.phone)}">${esc(f.phone)}</a>` : undefined],
      ['Web', f.web ? `<a href="${esc(f.web)}" target="_blank" rel="noopener">${esc(f.web.replace(/^https?:\/\//, '').slice(0, 32))}</a>` : undefined],
      ['Degree', f.qualification ? esc(f.qualification) : undefined],
    ]),
    f.research ? `<div class="p-sec">Research</div><p class="p-note">${esc(f.research)}</p>` : '',
    `<p class="src"><a href="${esc(f.url)}" target="_blank" rel="noopener">Profile on iitk.ac.in →</a></p>`,
  ].join('')

  shell(f.name, f.title || 'Faculty', body)
}

/* ── mess ────────────────────────────────────────────────────────────────── */

export function showMess(hit: Hit) {
  const at = hit.lat != null && hit.lon != null
  shell(hit.title, 'Mess menu', [
    at ? routeButtons(hit.lat!, hit.lon!, hit.title) : '',
    menuSections(hit.menus ?? []),
  ].join(''))
}

/* ── about ───────────────────────────────────────────────────────────────── */

export function showAbout(campus: Campus) {
  const f = campus.faculty
  const m = campus.mess
  const total = Object.values(campus.meta.counts).reduce((a, b) => a + b, 0)

  const body = `
    <p class="p-note">Everything here comes from a public source. Nothing on this
    map is invented — where there is no source, the feature is simply absent.</p>

    <div class="p-sec">Map & places</div>
    <p class="p-note"><b>${total}</b> places, <b>${campus.meta.counts.lecture ?? 0}</b> lecture halls.
    Geometry, opening hours and wheelchair tags from
    <a href="https://www.openstreetmap.org/relation/52434888" target="_blank" rel="noopener">OpenStreetMap</a>,
    ODbL. Walking and cycling times are computed over the OSM path network.</p>

    ${f ? `<div class="p-sec">Faculty</div>
    <p class="p-note"><b>${f.items.length}</b> people from
    <a href="${esc(f._source)}" target="_blank" rel="noopener">iitk.ac.in/iitk-faculty</a>,
    fetched ${esc(f._fetched.slice(0, 10))} — everything that directory publishes, paged out
    from behind its Load More buttons. ${f._located ?? 0} are placed on the map from their
    listed office.
    ${f._incomplete_departments?.length
      ? `<br><br><b>${f._incomplete_departments.length} departments came back short</b> on the
         last fetch: ${f._incomplete_departments.map((d) => `${esc(d.dept)} ${d.got}/${d.expected}`).join(', ')}.`
      : ''}</p>` : ''}

    ${m ? `<div class="p-sec">Mess menus</div>
    <p class="p-note"><b>${m.items.length}</b> approved menus across <b>${m.halls.length}</b> halls from
    <a href="${esc(m._source)}" target="_blank" rel="noopener">campusmess.in</a>,
    fetched ${esc(m._fetched.slice(0, 10))}. Community-maintained, so treat it as a strong hint.</p>` : ''}

    <div class="p-sec">Not here yet</div>
    <p class="p-note">Courses and timetables (Pingala is login-walled, no public API),
    clubs (<code>students.iitk.ac.in</code> does not resolve), notices, bus timings and
    lost &amp; found. Each one is waiting on a real source — see
    <a href="${REPO}/blob/main/TODO.md" target="_blank" rel="noopener">TODO.md</a>.</p>

    <div class="p-sec">Contribute</div>
    <p class="p-note">Something wrong or missing? Most of it — printers, water
    coolers, cycle stands, opening hours, step-free access — belongs in
    <a href="https://www.openstreetmap.org/relation/52434888" target="_blank" rel="noopener">OpenStreetMap</a>;
    map it once there and this picks it up on the next build. Everything else:
    <a href="${REPO}" target="_blank" rel="noopener">github.com/ni5arga/iitk</a>.</p>

    <p class="src">Built ${esc(campus.meta.built)} · ${esc(campus.meta.attribution)}
    · <a href="${REPO}" target="_blank" rel="noopener">source</a></p>`

  shell('iitk.nis.pet', 'About & sources', body)
}
