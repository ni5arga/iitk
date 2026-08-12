import './styles.css'
import maplibregl from 'maplibre-gl'
import type { Campus, Graph, MessMenu, Poi, Profile } from './types'
import { buildStyle } from './map/style'
import { Router, humanEta, humanDistance } from './route/router'
import { SearchIndex, type Hit } from './search/engine'
import { initPalette, openPalette } from './ui/palette'
import { initPanel, showAbout, showMess, showPerson, showPoi, hidePanel } from './ui/panel'
import { toggle as toggleTheme, onThemeChange, resolved } from './ui/theme'

const boot = document.getElementById('boot')!
const base = import.meta.env.BASE_URL

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo, graphData] = await Promise.all([
    json<Campus>('campus.json'),
    json<Record<string, GeoJSON.FeatureCollection>>('geo.json'),
    json<Graph>('graph.json'),
  ])

  const router = new Router(graphData)
  const byId = new Map(campus.pois.map((p) => [p.id, p]))
  const byName = new Map(campus.pois.map((p) => [p.name, p]))

  // OSM mess feature name -> that hall's week of menus, so clicking a mess on
  // the map answers "what's for dinner" instead of just naming the building.
  const menusAt = new Map<string, MessMenu[]>()
  for (const hall of campus.mess?.halls ?? []) {
    if (!hall.at) continue
    const rows = (campus.mess?.items ?? []).filter((m) => m.hall === hall.name)
    if (rows.length) menusAt.set(hall.at, rows)
  }

  // The category palette is tuned for a dark ground and washes out on a pale
  // one. Darken in HSL, holding hue and saturation and moving only lightness —
  // scaling the RGB channels instead (the previous approach) drains the colour
  // and turns every marker into the same sludge brown.
  const shadeCache = new Map<string, string>()
  function catColour(cat: string): string {
    const base = campus.categories[cat]?.color ?? '#8b949e'
    if (resolved() === 'dark') return base
    const hit = shadeCache.get(base)
    if (hit) return hit

    const n = parseInt(base.slice(1), 16)
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, bl = (n & 255) / 255
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl)
    const l = (max + min) / 2
    const d = max - min
    let h = 0
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    if (d !== 0) {
      h = max === r ? ((g - bl) / d) % 6 : max === g ? (bl - r) / d + 2 : (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    // Target ~38% lightness: dark enough to read on near-white, light enough
    // to stay recognisably the same hue as the dark theme.
    const L = Math.min(l, 0.38)
    const S = Math.min(1, sat * 1.05)
    const c = (1 - Math.abs(2 * L - 1)) * S
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = L - c / 2
    const seg: [number, number, number] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
    const out = '#' + seg
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
    shadeCache.set(base, out)
    return out
  }

  /* ── map ──────────────────────────────────────────────────────────────── */

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, campus, resolved(), base),
    center: campus.meta.center,
    zoom: 15.1,
    minZoom: 13,
    maxZoom: 19.5,
    maxBounds: [[80.205, 26.487], [80.262, 26.539]],
    // Attribution lives in the page footer instead — same ODbL credit, one place.
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  // Handle for scripts/verify-browser.mjs and for poking at the map in devtools.
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }), 'bottom-right')

  /* ── layer state ──────────────────────────────────────────────────────── */

  // Everything on by default — a student looking for a water cooler should not
  // have to discover a layer toggle first. Street lights are the exception:
  // they are ambience, not a destination, and the glow competes with the pins.
  const DEFAULT_OFF = new Set(['light'])
  const active = new Set(
    Object.keys(campus.categories).filter((c) => campus.meta.counts[c] && !DEFAULT_OFF.has(c)),
  )
  let focusId: string | null = null

  function poiFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: campus.pois
        .filter((p) => active.has(p.cat) || p.id === focusId)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            cat: p.cat,
            color: catColour(p.cat),
            // `pin` = important enough to label from low zoom. `named` lets
            // everything else pick up a label once you are zoomed right in.
            pin: !!campus.categories[p.cat]?.pin && !p.unnamed,
            named: !p.unnamed,
            focus: p.id === focusId,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  function refreshPois() {
    ;(map.getSource('pois') as maplibregl.GeoJSONSource | undefined)?.setData(poiFeatures())
    // Tint building footprints belonging to visible categories.
    if (map.getLayer('building-cat')) {
      map.setFilter('building-cat', ['all',
        ['!=', ['get', 'cat'], ''],
        ['in', ['get', 'cat'], ['literal', [...active]]],
      ])
    }
    paintChips()
  }

  /* ── layer chips ──────────────────────────────────────────────────────── */

  const rail = document.getElementById('layers')!
  const cats = Object.entries(campus.categories)
    .filter(([c]) => campus.meta.counts[c])
    .sort((a, b) => (campus.meta.counts[b[0]] ?? 0) - (campus.meta.counts[a[0]] ?? 0))

  const chipBox = document.getElementById('layer-chips')!
  const layersBtn = document.getElementById('layers-btn')!

  function paintRail() {
    chipBox.innerHTML = cats.map(([c, meta]) =>
      `<button class="chip" data-cat="${c}" aria-pressed="false" style="color:${catColour(c)}"
         title="${meta.label} · ${campus.meta.counts[c]}">
         <span class="dot"></span>${meta.label}<span class="n">${campus.meta.counts[c]}</span>
       </button>`).join('')
    paintChips()
  }
  paintRail()

  function paintChips() {
    chipBox.querySelectorAll<HTMLElement>('.chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(active.has(c.dataset.cat!))))
    layersBtn.querySelector('.n')!.textContent = `${active.size}`
    layersBtn.setAttribute('aria-label', `Layers — ${active.size} of ${cats.length} shown`)
  }

  rail.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.layers-close')) { closeLayers(); return }
    if (t.closest('[data-all]')) { cats.forEach(([c]) => active.add(c)); refreshPois(); return }
    if (t.closest('[data-none]')) { active.clear(); refreshPois(); return }
    const chip = t.closest('.chip') as HTMLElement | null
    if (!chip) return
    const c = chip.dataset.cat!
    active.has(c) ? active.delete(c) : active.add(c)
    refreshPois()
  })

  // The sheet only exists on narrow screens; on desktop the chips are always
  // laid out in the dock and the button is hidden.
  const scrim = document.createElement('div')
  scrim.id = 'layers-scrim'
  scrim.hidden = true
  document.body.append(scrim)

  function openLayers() {
    rail.classList.add('open')
    scrim.hidden = false
    layersBtn.setAttribute('aria-expanded', 'true')
  }
  function closeLayers() {
    rail.classList.remove('open')
    scrim.hidden = true
    layersBtn.setAttribute('aria-expanded', 'false')
  }
  layersBtn.addEventListener('click', () =>
    rail.classList.contains('open') ? closeLayers() : openLayers())
  scrim.addEventListener('click', closeLayers)

  /* ── routing ──────────────────────────────────────────────────────────── */

  let profile: Profile = 'foot'
  let origin: { lat: number; lon: number; label: string } | null = null
  let target: { lat: number; lon: number; label: string } | null = null
  /** Metrics of the last successful route, so the panel button can show the ETA. */
  let lastRoute: { seconds: number; metres: number } | null = null

  const badge = document.createElement('div')
  badge.id = 'route-badge'
  badge.hidden = true
  document.body.append(badge)

  function clearRoute() {
    target = null
    lastRoute = null
    badge.hidden = true
    ;(map.getSource('route') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: [] })
  }

  function drawRoute() {
    if (!target) return
    const from = origin ?? campusCentreNode()
    const r = router.route(from, target, profile)
    const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined

    if (!r) {
      lastRoute = null
      badge.hidden = false
      badge.innerHTML = `<span>No path found on the mapped network</span>
        <button class="x" data-clear aria-label="Clear route">&times;</button>`
      src?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    lastRoute = { seconds: r.seconds, metres: r.metres }

    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }],
    })

    const notes = [
      r.steps ? 'steps' : '',
      r.unpaved ? 'unpaved shortcut' : '',
      r.indoor ? 'indoor corridor' : '',
    ].filter(Boolean).join(' · ')

    badge.hidden = false
    badge.innerHTML = `
      <span class="eta">${humanEta(r.seconds)}</span>
      <span>${humanDistance(r.metres)}</span>
      <span class="mode">
        <button data-mode="foot" class="${profile === 'foot' ? 'on' : ''}">walk</button>
        <button data-mode="bike" class="${profile === 'bike' ? 'on' : ''}">cycle</button>
      </span>
      <span class="via">${origin ? '' : 'from campus centre · '}to ${escapeHtml(target.label)}${notes ? ` · ${notes}` : ''}</span>
      <button class="x" data-clear aria-label="Clear route">&times;</button>`

    map.fitBounds(bounds(r.coords), { padding: { top: 80, bottom: 110, left: 60, right: 380 }, maxZoom: 17.5 })
  }

  badge.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.clear !== undefined) { clearRoute(); return }
    if (t.dataset.mode) { profile = t.dataset.mode as Profile; drawRoute() }
  })

  function campusCentreNode() {
    return { lat: campus.meta.center[1], lon: campus.meta.center[0], label: 'campus centre' }
  }

  function routeTo(lat: number, lon: number, label: string) {
    target = { lat, lon, label }
    drawRoute()
  }

  // Use the browser's location as the route origin when it is on campus.
  map.on('load', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords
        if (lat > 26.49 && lat < 26.53 && lon > 80.21 && lon < 80.25) {
          origin = { lat, lon, label: 'you' }
          if (target) drawRoute()
        }
      },
      () => {},
      { timeout: 6000, maximumAge: 120_000 },
    )
  })

  /* ── report a missing place ───────────────────────────────────────────── */

  // Half the campus is in OSM as unnamed footprints — the geometry is there,
  // nobody has typed the name on it. Someone standing next to Hall 4 can fix
  // that in seconds, so make the coordinates one tap away.
  const REPO = 'https://github.com/ni5arga/iitk'
  let picking = false

  const pickBar = document.createElement('div')
  pickBar.id = 'pick-bar'
  pickBar.hidden = true
  document.body.append(pickBar)

  function startPicking() {
    picking = true
    map.getCanvas().style.cursor = 'crosshair'
    pickBar.hidden = false
    pickBar.innerHTML = `<span>Tap the map where the place is</span>
      <button class="x" data-cancel>cancel</button>`
  }

  function stopPicking() {
    picking = false
    map.getCanvas().style.cursor = ''
    pickBar.hidden = true
  }

  pickBar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).dataset.cancel !== undefined) stopPicking()
  })

  function reportAt(lat: number, lon: number) {
    stopPicking()
    const ll = `${lat.toFixed(7)}, ${lon.toFixed(7)}`
    const title = `Missing place at ${lat.toFixed(5)}, ${lon.toFixed(5)}`
    const body = [
      `**Coordinates:** ${ll}`,
      '',
      '**Name:** <!-- e.g. Hall 4, Lecture Hall 9, GH1 -->',
      '**What is it:** <!-- hostel / mess / canteen / lecture hall / water cooler / … -->',
      '',
      '---',
      'Even better: add it straight to OpenStreetMap and it lands here on the next',
      `build, plus every other map app — https://www.openstreetmap.org/edit#map=19/${lat.toFixed(5)}/${lon.toFixed(5)}`,
      '',
      'Please only report a spot you have actually stood at or can point to on the',
      'satellite layer. Do not copy coordinates out of Google Maps — this dataset is',
      'ODbL and Google-derived data cannot be redistributed or pushed upstream.',
    ].join('\n')
    window.open(
      `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
      '_blank', 'noopener',
    )
  }

  // Desktop: right-click. Phones have no right-click and iOS Safari does not
  // reliably fire contextmenu on a canvas, so long-press is wired by hand.
  map.on('contextmenu', (e) => { reportAt(e.lngLat.lat, e.lngLat.lng) })

  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let holdFrom: { x: number; y: number } | null = null
  const cancelHold = () => { clearTimeout(holdTimer); holdFrom = null }

  map.on('touchstart', (e) => {
    // One finger only — two is a pinch, and panning must not trigger it.
    if (e.points.length !== 1) { cancelHold(); return }
    holdFrom = { x: e.point.x, y: e.point.y }
    const { lat, lng } = e.lngLat
    holdTimer = setTimeout(() => {
      if (!holdFrom) return
      cancelHold()
      if (navigator.vibrate) navigator.vibrate(12)
      reportAt(lat, lng)
    }, 550)
  })
  map.on('touchmove', (e) => {
    if (!holdFrom) return
    // A few pixels of drift is a held finger; more than that is a pan.
    if (Math.hypot(e.point.x - holdFrom.x, e.point.y - holdFrom.y) > 10) cancelHold()
  })
  map.on('touchend', cancelHold)
  map.on('touchcancel', cancelHold)
  map.on('movestart', cancelHold)

  /* ── selection ────────────────────────────────────────────────────────── */

  /** Nudge the map so the focused point is not hidden by the panel or sheet. */
  function panelOffset(): [number, number] {
    return window.matchMedia('(max-width: 760px)').matches ? [0, -110] : [-140, 0]
  }

  function focusPoi(p: Poi, zoom = 17.4) {
    focusId = p.id
    refreshPois()
    map.easeTo({
      center: [p.lon, p.lat],
      zoom: Math.max(map.getZoom(), zoom),
      duration: 520,
      offset: panelOffset(),
    })
    showPoi(p, menusAt.get(p.name))
  }

  map.on('click', (e) => {
    if (!picking) return
    e.preventDefault()
    reportAt(e.lngLat.lat, e.lngLat.lng)
  })

  // Lamps are drawn as a glow instead of a dot, so they need their own hit
  // targets — `lamp-hit` is a transparent circle sized for a fingertip.
  const CLICKABLE = ['poi-dot', 'lamp-hit', 'poi-label', 'poi-label-minor', 'poi-label-generic']

  for (const layer of CLICKABLE) {
    map.on('click', layer, (e) => {
      if (picking) return
      const id = e.features?.[0]?.properties?.id as string | undefined
      const p = id ? byId.get(id) : undefined
      if (p) focusPoi(p)
    })
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  /* ── search ───────────────────────────────────────────────────────────── */

  const index = new SearchIndex(campus, {
    onLayer: (cat) => {
      active.has(cat) && active.size === 1 ? active.clear() : active.add(cat)
      refreshPois()
    },
    onAction: (id) => {
      if (id === 'layers-all') { cats.forEach(([c]) => active.add(c)); refreshPois() }
      if (id === 'layers-none') { active.clear(); refreshPois() }
      if (id === 'clear-route') clearRoute()
      if (id === 'about') showAbout(campus)
      if (id === 'report') startPicking()
      if (id === 'locate') {
        navigator.geolocation?.getCurrentPosition((pos) =>
          map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 }))
      }
    },
  })

  function openHit(hit: Hit) {
    if (hit.run) { hit.run(); return }
    if (hit.kind === 'place' && hit.poi) { focusPoi(hit.poi); return }
    if (hit.kind === 'person' && hit.person) {
      const at = hit.person.at ? byName.get(hit.person.at) : undefined
      if (at) { focusId = at.id; refreshPois(); map.easeTo({ center: [at.lon, at.lat], zoom: 17, duration: 520, offset: panelOffset() }) }
      showPerson(hit.person, at)
      return
    }
    if (hit.kind === 'mess') {
      if (hit.lat != null && hit.lon != null) {
        map.easeTo({ center: [hit.lon, hit.lat], zoom: 17, duration: 520, offset: panelOffset() })
      }
      showMess(hit)
    }
  }

  initPanel({
    campus,
    routeTo,
    routeState: () => ({
      active: !!target,
      eta: lastRoute?.seconds,
      metres: lastRoute?.metres,
    }),
    close: () => { focusId = null; refreshPois() },
  })

  initPalette({
    index,
    campus,
    open: openHit,
    routeTo: (hit) => { if (hit.lat != null) routeTo(hit.lat, hit.lon!, hit.title) },
  })

  /* ── chrome ───────────────────────────────────────────────────────────── */

  document.getElementById('brand-btn')!.addEventListener('click', () => showAbout(campus))

  /* ── theme ────────────────────────────────────────────────────────────── */

  const themeBtn = document.getElementById('theme-btn')!
  const paintThemeBtn = () => {
    const dark = resolved() === 'dark'
    themeBtn.textContent = dark ? '☾' : '☀'
    themeBtn.title = dark ? 'Switch to light' : 'Switch to dark'
  }
  paintThemeBtn()
  themeBtn.addEventListener('click', () => { toggleTheme(); paintThemeBtn() })

  onThemeChange((t) => {
    shadeCache.clear()
    paintRail()
    // setStyle swaps the basemap wholesale, so the two dynamic sources have to
    // be refilled once the new style is live.
    map.setStyle(buildStyle(geo, campus, t, base))
    map.once('styledata', () => {
      refreshPois()
      if (target) drawRoute()
    })
  })

  // What is loaded is stated in the About panel; the counts used to live under
  // the wordmark but that element is gone.
  document.getElementById('brand-btn')!.title =
    `${campus.pois.length} places · ${campus.faculty?.items.length ?? 0} faculty · ` +
    `${campus.mess?.items.length ?? 0} menus — click for sources`

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.getElementById('palette')!.hidden) return
    if (rail.classList.contains('open')) { closeLayers(); return }
    hidePanel(); focusId = null; refreshPois()
  })

  // A style or asset failure otherwise leaves the boot overlay up forever, which
  // reads as "the site never loads" with nothing on screen to explain it.
  const bootTimer = setTimeout(() => {
    if (boot.classList.contains('gone')) return
    boot.className = 'err'
    boot.textContent = 'The map did not finish loading. Check the browser console — and please open an issue at github.com/ni5arga/iitk.'
  }, 12_000)

  map.on('error', (e) => {
    // Missing glyphs and the odd tile error are survivable; a style error is not.
    console.error('[map]', e.error?.message ?? e)
  })

  map.on('load', () => {
    clearTimeout(bootTimer)
    refreshPois()
    boot.classList.add('gone')
    // Deep link: ?q=… opens the palette pre-filled, ?id=… focuses a place.
    const params = new URLSearchParams(location.search)
    const id = params.get('id')
    const q = params.get('q')
    if (id && byId.has(id)) focusPoi(byId.get(id)!)
    else if (q) openPalette(q)
  })
}

function bounds(coords: [number, number][]): [[number, number], [number, number]] {
  let w = 180, s = 90, e = -180, n = -90
  for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon)
    s = Math.min(s, lat); n = Math.max(n, lat)
  }
  return [[w, s], [e, n]]
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load campus data — ${err.message}. Run \`npm run build:data\` and reload.`
})
