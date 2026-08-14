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
import { Admin, type Ghost } from './admin'

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

  // The set of cells that are actually painted. The canvas is 2.2M cells and
  // ~99.8% empty, so drawing walks this instead of the viewport — which is what
  // lets the art stay visible zoomed out, where a viewport sweep would be
  // millions of cells per frame.
  const painted = new Set<number>()
  function set(x: number, y: number, c: number) {
    if (!inBounds(x, y)) return
    const i = idx(x, y)
    board[i] = c
    if (c === TRANSPARENT) painted.delete(i); else painted.add(i)
  }

  for (const [x, y, c] of seed.pixels) set(x, y, c)

  /** Seed is the floor; server chunks paint over it. */
  function applyChunks(chunks: Record<string, string>) {
    for (const packed of Object.values(chunks)) {
      for (const p of unpackChunk(packed)) set(p.x, p.y, p.c)
    }
  }

  let burst = 30
  let remaining = 30
  let cooldownUntil = 0
  let live = false
  /** Cursor into the server's edit feed; everything up to here is applied. */
  let seq = 0
  let epoch = '0'

  try {
    const server = await json<{
      burst: number; cooldown: number; seq?: number; epoch?: string
      chunks: Record<string, string>
    }>(`${base}api/pixels`)
    applyChunks(server.chunks)
    burst = server.burst
    remaining = server.burst
    seq = server.seq ?? 0
    epoch = server.epoch ?? '0'
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

  /**
   * A pending import, floating over the canvas until it is placed. Held here
   * rather than in the admin module because drawing and hit-testing both live
   * on this side.
   */
  let ghost: Ghost | null = null

  let hover: { x: number; y: number } | null = null

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, innerWidth, innerHeight)

    const b = map.getBounds()
    const nw = lonLatToPixel(b.getWest(), b.getNorth())
    const se = lonLatToPixel(b.getEast(), b.getSouth())
    const x0 = nw.x - 1, y0 = nw.y - 1, x1 = se.x + 1, y1 = se.y + 1

    // Screen size of one cell, taken from two adjacent grid corners.
    const [lonA, latA] = pixelToLonLat(0, 0)
    const [lonB, latB] = pixelToLonLat(1, 1)
    const a = map.project([lonA, latA])
    const bb = map.project([lonB, latB])
    // Never below a visible dot: zoomed right out the art should still read as
    // coloured marks on the campus rather than disappearing entirely.
    const sw = Math.max(Math.abs(bb.x - a.x), 1.5)
    const sh = Math.max(Math.abs(bb.y - a.y), 1.5)

    for (const i of painted) {
      const x = i % GRID_W
      const y = (i - x) / GRID_W
      if (x < x0 || x > x1 || y < y0 || y > y1) continue
      const [lon, lat] = pixelToLonLat(x, y)
      const pt = map.project([lon, lat])
      g.fillStyle = PALETTE[board[i]!]!
      // +1 closes the hairline seams between adjacent cells.
      g.fillRect(pt.x, pt.y, sw + 1, sh + 1)
    }

    if (ghost) {
      // Drawn at reduced alpha so the artwork underneath stays readable while
      // it is being positioned.
      g.globalAlpha = 0.75
      for (const [px, py, c] of ghost.px) {
        const x = ghost.x + px, y = ghost.y + py
        if (x < x0 || x > x1 || y < y0 || y > y1) continue
        const [lon, lat] = pixelToLonLat(x, y)
        const pt = map.project([lon, lat])
        g.fillStyle = PALETTE[c]!
        g.fillRect(pt.x, pt.y, sw + 1, sh + 1)
      }
      g.globalAlpha = 1

      const [gLon, gLat] = pixelToLonLat(ghost.x, ghost.y)
      const [gLon2, gLat2] = pixelToLonLat(ghost.x + ghost.w, ghost.y + ghost.h)
      const pA = map.project([gLon, gLat])
      const pB = map.project([gLon2, gLat2])
      g.strokeStyle = '#61d47c'
      g.setLineDash([6, 4])
      g.lineWidth = 1.5
      g.strokeRect(pA.x + .5, pA.y + .5, pB.x - pA.x, pB.y - pA.y)
      g.setLineDash([])
    }

    if (dragFrom && dragTo) {
      const rx0 = Math.min(dragFrom.x, dragTo.x), ry0 = Math.min(dragFrom.y, dragTo.y)
      const rx1 = Math.max(dragFrom.x, dragTo.x) + 1, ry1 = Math.max(dragFrom.y, dragTo.y) + 1
      const [lonS, latS] = pixelToLonLat(rx0, ry0)
      const [lonE, latE] = pixelToLonLat(rx1, ry1)
      const pA = map.project([lonS, latS])
      const pB = map.project([lonE, latE])
      g.fillStyle = 'rgba(255,123,114,.18)'
      g.fillRect(pA.x, pA.y, pB.x - pA.x, pB.y - pA.y)
      g.strokeStyle = '#ff7b72'
      g.setLineDash([5, 4])
      g.lineWidth = 1.5
      g.strokeRect(pA.x + .5, pA.y + .5, pB.x - pA.x, pB.y - pA.y)
      g.setLineDash([])
    }

    if (hover && sw >= 4 && !dragFrom) {
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
  /** Eraser, from the checkerboard swatch or the button. */
  let erasing = false
  const isErasing = () => erasing

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
      s.setAttribute('aria-checked',
        String(c === TRANSPARENT ? isErasing() : !isErasing() && c === colour))
    })
    eraseBtn.setAttribute('aria-pressed', String(isErasing()))
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

  // Hold Space to draw a continuous stroke instead of clicking each cell. It
  // paints whatever is selected, so with the eraser picked it rubs out a line
  // in one pass. Clicking once per pixel is the tedious part of pixel art.
  let stroking = false
  let cursor: maplibregl.LngLat | null = null

  function setStroking(on: boolean) {
    if (stroking === on) return
    stroking = on
    document.body.classList.toggle('stroking', on)
  }

  addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return
    if (/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName)) return
    e.preventDefault()          // Space would otherwise scroll or re-fire a button
    if (e.repeat) return
    setStroking(true)
    if (cursor) place(cursor)   // start the stroke under the cursor immediately
  })
  addEventListener('keyup', (e) => { if (e.code === 'Space') setStroking(false) })
  // A lost keyup — alt-tab mid-stroke — would leave it painting forever.
  addEventListener('blur', () => setStroking(false))

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

  /* ── god mode ─────────────────────────────────────────────────────────── */

  async function reloadCanvas() {
    const server = await json<{
      chunks: Record<string, string>; seq?: number; epoch?: string
    }>(`${base}api/pixels`)
    board.fill(0)
    painted.clear()
    for (const [x, y, c] of seed.pixels) set(x, y, c)
    applyChunks(server.chunks)
    seq = server.seq ?? seq
    epoch = server.epoch ?? epoch
    draw()
  }

  /* ── live updates ─────────────────────────────────────────────────────── */

  /**
   * Poll the edit feed and apply just the difference.
   *
   * Pages Functions cannot hold a WebSocket open, so this polls — but it asks
   * for "everything after sequence N" and usually gets an empty array, which is
   * a few hundred bytes rather than the whole canvas. Backs right off when the
   * tab is hidden, so a forgotten tab is not hammering the worker all day.
   */
  const POLL_ACTIVE_MS = 2500
  const POLL_HIDDEN_MS = 30_000
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  async function poll() {
    if (!live) return
    try {
      const r = await json<{
        seq: number; epoch: string; stale: boolean; pixels: [number, number, number][]
      }>(`${base}api/pixels/since?seq=${seq}`)

      // A wipe, or we fell behind the feed window — only a full reload is right.
      if (r.epoch !== epoch || r.stale) {
        await reloadCanvas()
        setStatus('canvas reset by a moderator', 'warn')
      } else if (r.pixels.length) {
        for (const [x, y, c] of r.pixels) set(x, y, c)
        seq = r.seq
        draw()
        // Only announce other people's edits; your own already showed instantly.
        const mine = queue.length
        if (!mine) setStatus(`${r.pixels.length} pixel${r.pixels.length > 1 ? 's' : ''} just changed`, '')
      } else {
        seq = r.seq
      }
      failures = 0
    } catch {
      // Keep polling, just slower, so a blip does not permanently kill live mode.
      failures++
    }
    const base_ms = document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS
    pollTimer = setTimeout(poll, Math.min(base_ms * (1 + failures), 60_000))
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !live) return
    clearTimeout(pollTimer)
    poll()                      // catch up the moment the tab comes back
  })

  const admin = new Admin({
    redraw: draw,
    setLocal: set,
    reload: reloadCanvas,
    status: setStatus,
    currentColour: () => (isErasing() ? TRANSPARENT : colour),
    setGhost: (gh) => {
      ghost = gh
      // Drop a new import in the middle of what the admin is looking at.
      if (gh && gh.x < 0) {
        const c = map.getCenter()
        const p = lonLatToPixel(c.lng, c.lat)
        gh.x = Math.max(0, p.x - (gh.w >> 1))
        gh.y = Math.max(0, p.y - (gh.h >> 1))
      }
      draw()
    },
    getGhost: () => ghost,
  }, base)

  // Rectangle tools drag on the map, so panning has to yield while one is armed.
  let dragFrom: { x: number; y: number } | null = null
  let dragTo: { x: number; y: number } | null = null
  const rectTool = () => admin.unlocked && (admin.tool === 'rect-erase' || admin.tool === 'rect-fill')

  let ghostGrab: { dx: number; dy: number } | null = null

  map.on('mousedown', (e) => {
    if (ghost) {
      const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
      const inside = x >= ghost.x && y >= ghost.y &&
                     x < ghost.x + ghost.w && y < ghost.y + ghost.h
      if (inside) {
        e.preventDefault()
        map.dragPan.disable()
        ghostGrab = { dx: x - ghost.x, dy: y - ghost.y }
        return
      }
    }
    if (!rectTool()) return
    const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
    if (!inBounds(x, y)) return
    e.preventDefault()
    map.dragPan.disable()
    dragFrom = { x, y }
    dragTo = { x, y }
  })

  map.on('mousemove', (e) => {
    if (ghostGrab && ghost) {
      const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
      ghost.x = x - ghostGrab.dx
      ghost.y = y - ghostGrab.dy
      draw()
      return
    }
    if (!dragFrom) return
    const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
    if (inBounds(x, y)) { dragTo = { x, y }; draw() }
  })

  map.on('mouseup', async () => {
    if (ghostGrab) { ghostGrab = null; map.dragPan.enable(); admin.onGhostMoved(); return }
    if (!dragFrom || !dragTo) return
    const a = dragFrom, b = dragTo
    dragFrom = dragTo = null
    map.dragPan.enable()
    draw()
    await admin.applyRect(a.x, a.y, b.x, b.y)
  })

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
        for (const p of batch) set(p.x, p.y, TRANSPARENT)
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
    const c = isErasing() ? TRANSPARENT : colour

    // God mode writes straight through: no cooldown, no client-side budget.
    if (admin.unlocked) {
      if (admin.tool === 'inspect') { void admin.inspect(x, y); return }
      if (admin.tool !== 'paint') return   // the rectangle tools drag instead
      if (board[idx(x, y)] === c) return
      set(x, y, c)
      draw()
      void admin.paint([[x, y, c]])
      return
    }

    if (board[idx(x, y)] === c) return

    set(x, y, c)                    // optimistic: show it immediately
    draw()
    queue.push({ x, y, c })
    if (!flushTimer) flushTimer = setTimeout(flush, 180)
  }

  map.on('click', (e) => { if (!rectTool() && !ghost) place(e.lngLat) })

  map.on('mousemove', (e) => {
    cursor = e.lngLat
    const { x, y } = lonLatToPixel(e.lngLat.lng, e.lngLat.lat)
    const next = inBounds(x, y) ? { x, y } : null
    const moved = next?.x !== hover?.x || next?.y !== hover?.y
    if (moved) { hover = next; draw() }
    // Only on a new cell, or a fast drag would queue the same pixel repeatedly.
    if (stroking && moved && next) place(e.lngLat)
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

  /** Bounding box of everything painted, as lon/lat. */
  function artBounds(): maplibregl.LngLatBoundsLike | null {
    if (!painted.size) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const i of painted) {
      const x = i % GRID_W, y = (i - x) / GRID_W
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const [wLon, nLat] = pixelToLonLat(x0 - 4, y0 - 4)
    const [eLon, sLat] = pixelToLonLat(x1 + 5, y1 + 5)
    return [[wLon, sLat], [eLon, nLat]]
  }

  /**
   * Remember where you were, in the URL. A canvas this size is unusable without
   * it — you cannot share a spot, and a reload throws away whatever you found.
   */
  function readHash(): { lon: number; lat: number; zoom: number } | null {
    const m = /^#(\d+(?:\.\d+)?)\/(-?\d+\.\d+)\/(-?\d+\.\d+)$/.exec(location.hash)
    return m ? { zoom: +m[1]!, lat: +m[2]!, lon: +m[3]! } : null
  }

  function writeHash() {
    const c = map.getCenter()
    const h = `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`
    history.replaceState(null, '', h)
  }
  map.on('moveend', writeHash)

  map.on('load', () => {
    fillLabels()

    // Opening on an empty patch of campus made the art look absent — it was
    // simply 980 m away. Frame everything that has been painted instead, unless
    // the URL already says where to go.
    const from = readHash()
    if (from) {
      map.jumpTo({ center: [from.lon, from.lat], zoom: from.zoom })
    } else {
      const b = artBounds()
      if (b) map.fitBounds(b, { padding: 60, maxZoom: 15.4, animate: false })
    }
    boot.classList.add('gone')
    updateHint()
    updateBudget()
    setStatus(live ? `${GRID_W}×${GRID_H} grid · 2 m per pixel · live` : 'read-only preview', live ? '' : 'warn')
    draw()
    if (live) pollTimer = setTimeout(poll, POLL_ACTIVE_MS)
  })
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load the canvas — ${err.message}`
})
