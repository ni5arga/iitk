import '../styles.css'
import './pixels.css'
import maplibregl from 'maplibre-gl'
import type { Campus } from '../types'
import { buildStyle } from '../map/style'
import { toggle as toggleTheme, onThemeChange, resolved } from '../ui/theme'
import {
  GRID_W, GRID_H, PALETTE, TRANSPARENT,
  lonLatToPixel, pixelToLonLat, inBounds, unpackChunk,
} from './grid'

const base = import.meta.env.BASE_URL
const boot = document.getElementById('boot')!
const statusEl = document.getElementById('px-status')!
const budgetEl = document.getElementById('px-budget')!
const hintEl = document.getElementById('px-hint')!

/** Below this zoom a pixel is under ~4 screen px — too small to aim at. */
const PAINT_ZOOM = 16.5

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo, seed] = await Promise.all([
    json<Campus>(`${base}data/campus.json`),
    json<Record<string, GeoJSON.FeatureCollection>>(`${base}data/geo.json`),
    json<{ pixels: [number, number, number][] }>(`${base}data/pixels-seed.json`),
  ])

  /* ── board state ──────────────────────────────────────────────────────── */
  // One flat byte per grid cell. 2.2 MB, allocated once, and lookups are a
  // single index — far cheaper per frame than a Map of a few thousand keys.
  const board = new Uint8Array(GRID_W * GRID_H)
  const idx = (x: number, y: number) => y * GRID_W + x

  for (const [x, y, c] of seed.pixels) if (inBounds(x, y)) board[idx(x, y)] = c

  /** Seed is the floor; server chunks paint over it. */
  function applyChunks(chunks: Record<string, string>) {
    for (const packed of Object.values(chunks)) {
      for (const p of unpackChunk(packed)) {
        if (inBounds(p.x, p.y)) board[idx(p.x, p.y)] = p.c
      }
    }
  }

  let burst = 30
  let remaining = 30
  let cooldownUntil = 0
  let live = false

  try {
    const server = await json<{
      burst: number; cooldown: number; chunks: Record<string, string>
    }>(`${base}api/pixels`)
    applyChunks(server.chunks)
    burst = server.burst
    remaining = server.burst
    live = true
  } catch {
    // No Functions binding (local `vite preview`, or KV not wired up yet).
    // The seed still renders, painting is just disabled.
    live = false
  }

  /* ── map ──────────────────────────────────────────────────────────────── */

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, campus, resolved(), base),
    center: campus.meta.center,
    zoom: 15.6,
    minZoom: 13,
    maxZoom: 20,
    maxBounds: [[80.205, 26.487], [80.262, 26.539]],
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

  /* ── place labels ─────────────────────────────────────────────────────── */
  // Without these the canvas floats over an anonymous grey map and nobody can
  // tell which building they are painting on. Markers are dimmed so the
  // artwork stays the loudest thing on screen.
  function labelFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: campus.pois
        .filter((p) => !p.unnamed)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            cat: p.cat,
            color: campus.categories[p.cat]?.color ?? '#8b949e',
            pin: !!campus.categories[p.cat]?.pin,
            named: true,
            focus: false,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  function fillLabels() {
    const src = map.getSource('pois') as maplibregl.GeoJSONSource | undefined
    src?.setData(labelFeatures())
    if (map.getLayer('poi-dot')) map.setPaintProperty('poi-dot', 'circle-opacity', 0.35)
    if (map.getLayer('poi-dot')) map.setPaintProperty('poi-dot', 'circle-stroke-width', 0.8)
  }

  /* ── canvas overlay ───────────────────────────────────────────────────── */

  const cv = document.getElementById('pixel-canvas') as HTMLCanvasElement
  const g = cv.getContext('2d')!
  let dpr = Math.min(devicePixelRatio || 1, 2)

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2)
    cv.width = Math.floor(innerWidth * dpr)
    cv.height = Math.floor(innerHeight * dpr)
    cv.style.width = `${innerWidth}px`
    cv.style.height = `${innerHeight}px`
  }
  resize()
  addEventListener('resize', resize)

  let hover: { x: number; y: number } | null = null

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, innerWidth, innerHeight)

    // Only walk the grid cells actually on screen.
    const b = map.getBounds()
    const nw = lonLatToPixel(b.getWest(), b.getNorth())
    const se = lonLatToPixel(b.getEast(), b.getSouth())
    const x0 = Math.max(0, nw.x - 1), y0 = Math.max(0, nw.y - 1)
    const x1 = Math.min(GRID_W - 1, se.x + 1), y1 = Math.min(GRID_H - 1, se.y + 1)
    if (x1 < x0 || y1 < y0) return

    // A whole-grid sweep at low zoom would be millions of cells per frame.
    if ((x1 - x0) * (y1 - y0) > 400_000) return

    const [lonA, latA] = pixelToLonLat(x0, y0)
    const [lonB, latB] = pixelToLonLat(x0 + 1, y0 + 1)
    const a = map.project([lonA, latA])
    const bb = map.project([lonB, latB])
    const sw = Math.abs(bb.x - a.x)
    const sh = Math.abs(bb.y - a.y)
    if (sw < 0.6) return // sub-pixel: nothing legible to draw

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = board[idx(x, y)]!
        if (c === TRANSPARENT) continue
        const [lon, lat] = pixelToLonLat(x, y)
        const pt = map.project([lon, lat])
        g.fillStyle = PALETTE[c]!
        // +1 closes the hairline seams between adjacent cells.
        g.fillRect(pt.x, pt.y, sw + 1, sh + 1)
      }
    }

    if (hover && sw >= 4) {
      const [lon, lat] = pixelToLonLat(hover.x, hover.y)
      const pt = map.project([lon, lat])
      g.strokeStyle = resolved() === 'dark' ? '#ffffff' : '#000000'
      g.lineWidth = 1.5
      g.strokeRect(pt.x + 0.5, pt.y + 0.5, sw, sh)
    }
  }

  map.on('render', draw)
  map.on('move', draw)

  /* ── palette ──────────────────────────────────────────────────────────── */

  let colour = 8 // red
  let erasing = false

  const palEl = document.getElementById('px-palette')!
  // Transparent is a first-class colour, not a mode. Anyone can pick it and
  // rub out anyone else's work — same rate limit, no special standing.
  palEl.innerHTML = PALETTE
    .map((hex, i) => i === TRANSPARENT
      ? `<button class="sw sw-erase" role="radio" data-c="0" aria-checked="false"
           title="Eraser — clears whatever is there"></button>`
      : `<button class="sw" role="radio" data-c="${i}" aria-checked="${i === colour}"
           style="background:${hex}" title="${hex}"></button>`)
    .join('')

  function paintSwatches() {
    palEl.querySelectorAll<HTMLElement>('.sw').forEach((s) => {
      const c = +s.dataset.c!
      s.setAttribute('aria-checked', String(c === TRANSPARENT ? erasing : !erasing && c === colour))
    })
    eraseBtn.setAttribute('aria-pressed', String(erasing))
  }

  palEl.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest('.sw') as HTMLElement | null
    if (!sw) return
    const c = +sw.dataset.c!
    if (c === TRANSPARENT) { erasing = true } else { colour = c; erasing = false }
    paintSwatches()
  })

  const eraseBtn = document.getElementById('px-erase')!
  eraseBtn.addEventListener('click', () => { erasing = !erasing; paintSwatches() })
  paintSwatches()

  /* ── painting ─────────────────────────────────────────────────────────── */

  function setStatus(text: string, tone: '' | 'warn' | 'bad' = '') {
    statusEl.textContent = text
    statusEl.className = tone
  }

  function updateBudget() {
    if (!live) { budgetEl.textContent = ''; return }
    const left = Math.max(0, cooldownUntil - Date.now())
    budgetEl.textContent = left > 0
      ? `cooldown ${Math.ceil(left / 1000)}s`
      : `${remaining}/${burst} left`
  }
  setInterval(updateBudget, 500)

  function updateHint() {
    const zoomedOut = map.getZoom() < PAINT_ZOOM
    hintEl.hidden = !zoomedOut
    document.body.classList.toggle('can-paint', !zoomedOut && live)
  }
  map.on('zoom', updateHint)

  /** Queue writes so a fast drag becomes one request, not twelve. */
  const queue: { x: number; y: number; c: number }[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  async function flush() {
    flushTimer = undefined
    if (!queue.length) return
    const batch = queue.splice(0, 12)
    try {
      const res = await fetch(`${base}api/pixels/paint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pixels: batch.map((p) => [p.x, p.y, p.c]) }),
      })
      const data = await res.json() as {
        error?: string; remaining?: number; cooldownUntil?: number | null
      }
      if (!res.ok) {
        // The server rejected them, so roll the optimistic paint back.
        for (const p of batch) board[idx(p.x, p.y)] = 0
        draw()
        if (typeof data.cooldownUntil === 'number') cooldownUntil = data.cooldownUntil
        if (typeof data.remaining === 'number') remaining = data.remaining
        setStatus(data.error ?? 'rejected', res.status === 429 ? 'warn' : 'bad')
      } else {
        remaining = data.remaining ?? remaining
        cooldownUntil = data.cooldownUntil ?? 0
        setStatus('painting', '')
      }
    } catch {
      setStatus('offline — pixel not saved', 'bad')
    }
    updateBudget()
    if (queue.length) flushTimer = setTimeout(flush, 250)
  }

  function place(lngLat: maplibregl.LngLat) {
    if (!live) { setStatus('read-only: canvas API not reachable', 'warn'); return }
    if (map.getZoom() < PAINT_ZOOM) return
    if (cooldownUntil > Date.now()) return

    const { x, y } = lonLatToPixel(lngLat.lng, lngLat.lat)
    if (!inBounds(x, y)) return
    const c = erasing ? TRANSPARENT : colour
    if (board[idx(x, y)] === c) return

    board[idx(x, y)] = c            // optimistic: show it immediately
    draw()
    queue.push({ x, y, c })
    if (!flushTimer) flushTimer = setTimeout(flush, 180)
  }

  map.on('click', (e) => place(e.lngLat))

  map.on('mousemove', (e) => {
    const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
    const next = inBounds(x, y) ? { x, y } : null
    if (next?.x !== hover?.x || next?.y !== hover?.y) { hover = next; draw() }
  })
  map.on('mouseout', () => { hover = null; draw() })

  /* ── chrome ───────────────────────────────────────────────────────────── */

  const themeBtn = document.getElementById('theme-btn')!
  const paintTheme = () => {
    const dark = resolved() === 'dark'
    themeBtn.textContent = dark ? '☾' : '☀'
    themeBtn.title = dark ? 'Switch to light' : 'Switch to dark'
  }
  paintTheme()
  themeBtn.addEventListener('click', () => { toggleTheme(); paintTheme() })
  onThemeChange((t) => {
    map.setStyle(buildStyle(geo, campus, t, base))
    map.once('styledata', () => { fillLabels(); draw() })
  })

  map.on('load', () => {
    fillLabels()
    boot.classList.add('gone')
    updateHint()
    updateBudget()
    setStatus(live ? `${GRID_W}×${GRID_H} grid · 2 m per pixel` : 'read-only preview', live ? '' : 'warn')
    draw()
  })
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load the canvas — ${err.message}`
})
