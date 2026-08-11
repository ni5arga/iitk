import type { Hit, SearchIndex, Kind } from '../search/engine'
import { openNow } from '../search/hours'
import type { Campus } from '../types'

const root = document.getElementById('palette') as HTMLElement
const input = document.getElementById('palette-input') as HTMLInputElement
const list = document.getElementById('palette-results') as HTMLElement
const timing = document.getElementById('palette-timing') as HTMLElement
const count = document.getElementById('palette-count') as HTMLElement

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const GROUP: Record<Kind, string> = {
  mess: 'Mess', place: 'Places', person: 'People',
  layer: 'Layers', action: 'Commands', hint: '',
}
const ORDER: Kind[] = ['mess', 'place', 'person', 'layer', 'action']

export interface PaletteHost {
  index: SearchIndex
  campus: Campus
  open(hit: Hit): void
  routeTo(hit: Hit): void
}

let host: PaletteHost
let hits: Hit[] = []
let cursor = 0

export function initPalette(h: PaletteHost) {
  host = h

  input.addEventListener('input', () => render(input.value))
  input.addEventListener('keydown', onKey)

  root.addEventListener('mousedown', (e) => {
    // Click on the backdrop closes; clicks inside the box must not steal focus.
    if (e.target === root) closePalette()
    else e.preventDefault()
  })

  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
    if (!row) return
    cursor = +row.dataset.i!
    commit(false)
  })

  list.addEventListener('mousemove', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
    if (!row || +row.dataset.i! === cursor) return
    cursor = +row.dataset.i!
    paintCursor()
  })

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName)
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault()
      openPalette()
    }
  })

  document.getElementById('open-search')!.addEventListener('click', () => openPalette())
}

export function openPalette(prefill = '') {
  root.hidden = false
  if (prefill) input.value = prefill
  input.focus()
  input.select()
  render(input.value)
}

export function closePalette() {
  root.hidden = true
  input.blur()
}

function onKey(e: KeyboardEvent) {
  switch (e.key) {
    case 'Escape': e.preventDefault(); closePalette(); break
    case 'ArrowDown': e.preventDefault(); move(1); break
    case 'ArrowUp': e.preventDefault(); move(-1); break
    case 'Home': if (hits.length) { e.preventDefault(); cursor = 0; paintCursor() } break
    case 'End': if (hits.length) { e.preventDefault(); cursor = hits.length - 1; paintCursor() } break
    case 'Enter': e.preventDefault(); commit(false); break
    case 'Tab': e.preventDefault(); commit(true); break
    case 'n': if (e.ctrlKey) { e.preventDefault(); move(1) } break
    case 'p': if (e.ctrlKey) { e.preventDefault(); move(-1) } break
  }
}

function move(d: number) {
  if (!hits.length) return
  cursor = (cursor + d + hits.length) % hits.length
  paintCursor()
}

function commit(route: boolean) {
  const hit = hits[cursor]
  if (!hit) return
  if (route && hit.lat != null) { host.routeTo(hit); closePalette(); return }
  host.open(hit)
  if (hit.kind !== 'layer') closePalette()
}

/* ── render ──────────────────────────────────────────────────────────────── */

function render(raw: string) {
  const t0 = performance.now()
  const q = raw.trim()
  hits = q ? host.index.search(q) : []
  const ms = performance.now() - t0

  cursor = 0
  timing.textContent = q ? `${ms < 1 ? ms.toFixed(2) : ms.toFixed(1)}ms` : ''
  count.textContent = q ? `${hits.length}` : `${host.index.docs.length} indexed`

  if (!q) { list.innerHTML = welcome(); return }
  if (!hits.length) { list.innerHTML = empty(q); return }

  const seen = new Set<Kind>()
  const parts: string[] = []
  // Keep the ranked order, but label the first row of each kind as it appears.
  const grouped = [...hits].sort((a, b) => {
    const ga = ORDER.indexOf(a.kind), gb = ORDER.indexOf(b.kind)
    return ga - gb || b.score - a.score
  })
  hits = grouped

  grouped.forEach((h, i) => {
    if (!seen.has(h.kind)) { seen.add(h.kind); parts.push(`<div class="grp">${GROUP[h.kind]}</div>`) }
    parts.push(row(h, i))
  })
  list.innerHTML = parts.join('')
  paintCursor()
}

function row(h: Hit, i: number) {
  const colour = h.cat ? host.campus.categories[h.cat]?.color ?? '#6b7482'
    : h.kind === 'person' ? '#8ab4f8' : '#6b7482'

  let meta = ''
  const st = openNow(h.hours)
  if (st?.open) meta = `<span class="open">open${st.until ? ` · ${st.until}` : ''}</span>`
  else if (st && !st.open) meta = `<span class="shut">closed</span>`
  else if (h.kind === 'action') meta = '↵'
  else if (h.kind === 'layer') meta = 'layer'

  return `<div class="row" role="option" data-i="${i}" aria-selected="false">
    <span class="row-dot" style="background:${colour}"></span>
    <span class="row-main">
      <span class="row-title">${mark(h.title, h.marks)}</span>
      ${h.sub ? `<span class="row-sub">${esc(h.sub)}</span>` : ''}
    </span>
    ${meta ? `<span class="row-meta">${meta}</span>` : ''}
  </div>`
}

function mark(title: string, at: number[]) {
  if (!at.length) return esc(title)
  const set = new Set(at)
  let out = ''
  let open = false
  for (let i = 0; i < title.length; i++) {
    const hit = set.has(i)
    if (hit && !open) { out += '<mark>'; open = true }
    if (!hit && open) { out += '</mark>'; open = false }
    out += esc(title[i])
  }
  return out + (open ? '</mark>' : '')
}

function paintCursor() {
  const rows = list.querySelectorAll<HTMLElement>('.row')
  rows.forEach((r) => r.setAttribute('aria-selected', String(+r.dataset.i! === cursor)))
  rows[cursor]?.scrollIntoView({ block: 'nearest' })
}

function welcome() {
  const ex = host.index.examples()
  return `<div class="empty">
    <b>Search every place, person and menu on campus</b>
    ${ex.map((e) => `<code data-try="${esc(e)}">${esc(e)}</code>`).join('')}
  </div>`
}

function empty(q: string) {
  // Be specific about the known gaps rather than shrugging.
  const missing =
    /^[a-z]{2,4}\s?\d{3}$/i.test(q) ? 'Course data is not loaded — Pingala has no public API. See TODO.md.'
    : /\bclub\b|\bsociety\b/i.test(q) ? 'Club data is not loaded — students.iitk.ac.in does not resolve. See TODO.md.'
    : /\bbus\b|airport|station|train/i.test(q) ? 'Bus timings are not loaded — no machine-readable source found. See TODO.md.'
    : /\blost\b|\bfound\b/i.test(q) ? 'Lost & found needs a live board, not a static file. See TODO.md.'
    : /notice|deadline|exam/i.test(q) ? 'Notices are not loaded — no public feed found. See TODO.md.'
    : null

  return `<div class="empty">
    <b>No match for “${esc(q)}”</b>
    ${missing ? `<div style="color:#9aa4b2;font-size:12px;line-height:1.55;max-width:38ch;margin:0 auto 12px">${esc(missing)}</div>` : ''}
    ${host.index.examples().slice(0, 4).map((e) => `<code data-try="${esc(e)}">${esc(e)}</code>`).join('')}
  </div>`
}

list.addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest('code[data-try]') as HTMLElement | null
  if (!c) return
  input.value = c.dataset.try!
  render(input.value)
  input.focus()
})
