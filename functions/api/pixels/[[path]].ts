/**
 * Pixel canvas API — Cloudflare Pages Functions.
 *
 *   GET  /api/pixels          whole canvas, chunked
 *   POST /api/pixels/paint    place pixels, IP rate limited
 *   POST /api/pixels/admin    moderation, needs PIXELS_ADMIN_TOKEN
 *
 * Bindings expected on the Pages project:
 *   PIXELS               KV namespace (canvas, rate limits, bans, log buffer)
 *   DISCORD_WEBHOOK      secret — never reaches the browser
 *   PIXELS_ADMIN_TOKEN   secret — bearer token for the admin route
 *
 * Storage note: KV is eventually consistent and has no transactions, so two
 * people painting the same 128×128 chunk within a second can lose one write.
 * That is an acceptable trade for a campus toy; a Durable Object per chunk is
 * the fix if this ever gets busy.
 */

import {
  CHUNK, GRID_W, GRID_H, PALETTE, chunkKey, chunkOf, inBounds,
  packChunk, unpackChunk, type Pixel,
} from '../../../src/pixels/grid'

interface Env {
  PIXELS: KVNamespace
  DISCORD_WEBHOOK?: string
  PIXELS_ADMIN_TOKEN?: string
}

/** Pixels allowed before a forced break, and how long that break lasts. */
const BURST = 30
const COOLDOWN_S = 60
/** Most pixels one request may carry. Stops a single call painting the map. */
const MAX_PER_REQUEST = 12

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  })

/* ── identity ────────────────────────────────────────────────────────────── */

/**
 * A short, stable id derived from the client IP. We never store or log the
 * address itself — bans and rate limits key off this instead, which is enough
 * to moderate with and useless for identifying anyone off-platform.
 */
async function painterId(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0'
  const bytes = new TextEncoder().encode(`iitk-pixels:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].slice(0, 5)
    .map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ── canvas ──────────────────────────────────────────────────────────────── */

async function readCanvas(env: Env) {
  const chunks: Record<string, string> = {}
  let cursor: string | undefined
  do {
    const page = await env.PIXELS.list({ prefix: 'c:', cursor, limit: 1000 })
    for (const k of page.keys) {
      const v = await env.PIXELS.get(k.name)
      if (v) chunks[k.name.slice(2)] = v
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return chunks
}

/** Apply pixels to their chunks. Returns how many actually changed. */
async function applyPixels(env: Env, pixels: Pixel[]): Promise<number> {
  const byChunk = new Map<string, Pixel[]>()
  for (const p of pixels) {
    const { cx, cy } = chunkOf(p.x, p.y)
    const key = chunkKey(cx, cy)
    const arr = byChunk.get(key)
    if (arr) arr.push(p); else byChunk.set(key, [p])
  }

  let changed = 0
  for (const [key, batch] of byChunk) {
    const existing = unpackChunk((await env.PIXELS.get(key)) ?? '')
    const merged = new Map(existing.map((p) => [`${p.x},${p.y}`, p]))
    for (const p of batch) {
      const k = `${p.x},${p.y}`
      if (p.c === 0) merged.delete(k)
      else merged.set(k, p)
      changed++
    }
    if (merged.size) await env.PIXELS.put(key, packChunk(merged.values()))
    else await env.PIXELS.delete(key)
  }
  return changed
}

/* ── discord logging ─────────────────────────────────────────────────────── */

/**
 * Every pixel is logged, but batched. Discord rate limits a webhook to a
 * handful of posts per second; one message per pixel would be throttled into
 * uselessness within moments of anyone actually drawing.
 */
const LOG_FLUSH_AT = 25
const LOG_MAX_AGE_MS = 45_000

async function logPixels(env: Env, who: string, pixels: Pixel[], note = '') {
  if (!env.DISCORD_WEBHOOK) return
  const raw = await env.PIXELS.get('log:buf')
  const buf = raw ? (JSON.parse(raw) as { t: number; lines: string[] }) : { t: Date.now(), lines: [] }

  for (const p of pixels) {
    buf.lines.push(`\`${who}\` ${note}(${p.x},${p.y}) ${p.c === 0 ? 'erase' : PALETTE[p.c]}`)
  }

  const stale = Date.now() - buf.t > LOG_MAX_AGE_MS
  if (buf.lines.length < LOG_FLUSH_AT && !stale) {
    await env.PIXELS.put('log:buf', JSON.stringify(buf))
    return
  }

  const lines = buf.lines.splice(0, 60)
  await env.PIXELS.put('log:buf', JSON.stringify({ t: Date.now(), lines: buf.lines }))
  await fetch(env.DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'iitk.nis.pet pixels',
      embeds: [{
        title: `${lines.length} pixels`,
        description: lines.join('\n').slice(0, 4000),
        color: 0x61d47c,
        timestamp: new Date().toISOString(),
      }],
    }),
  }).catch(() => { /* logging must never break painting */ })
}

/* ── routes ──────────────────────────────────────────────────────────────── */

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx
  const path = (ctx.params.path as string[] | undefined)?.join('/') ?? ''

  if (!env.PIXELS) {
    return json({ error: 'canvas storage is not configured on this deployment' }, 503)
  }

  /* GET /api/pixels */
  if (request.method === 'GET' && path === '') {
    return json({
      grid: { w: GRID_W, h: GRID_H, chunk: CHUNK },
      burst: BURST,
      cooldown: COOLDOWN_S,
      maxPerRequest: MAX_PER_REQUEST,
      chunks: await readCanvas(env),
    })
  }

  /* POST /api/pixels/paint */
  if (request.method === 'POST' && path === 'paint') {
    const who = await painterId(request)

    if (await env.PIXELS.get(`ban:${who}`)) {
      return json({ error: 'You are banned from painting.', id: who }, 403)
    }

    let body: { pixels?: [number, number, number][] }
    try { body = await request.json() } catch { return json({ error: 'bad json' }, 400) }

    const raw = body.pixels
    if (!Array.isArray(raw) || raw.length === 0) return json({ error: 'no pixels' }, 400)
    if (raw.length > MAX_PER_REQUEST) {
      return json({ error: `at most ${MAX_PER_REQUEST} pixels per request` }, 400)
    }

    const pixels: Pixel[] = []
    for (const item of raw) {
      if (!Array.isArray(item) || item.length !== 3) return json({ error: 'bad pixel' }, 400)
      const [x, y, c] = item.map(Number)
      // Validate server-side: the client is not trusted about position or colour.
      if (!inBounds(x!, y!)) return json({ error: `pixel out of bounds: ${x},${y}` }, 400)
      if (!Number.isInteger(c) || c! < 0 || c! >= PALETTE.length) {
        return json({ error: `bad colour index: ${c}` }, 400)
      }
      pixels.push({ x: x!, y: y!, c: c! })
    }

    // Rate limit: a budget of BURST pixels, then a forced cooldown.
    const now = Date.now()
    const rlRaw = await env.PIXELS.get(`rl:${who}`)
    const rl = rlRaw ? (JSON.parse(rlRaw) as { n: number; until: number }) : { n: 0, until: 0 }

    if (rl.until > now) {
      return json({
        error: 'cooling down', cooldownUntil: rl.until, remaining: 0, id: who,
      }, 429, { 'retry-after': String(Math.ceil((rl.until - now) / 1000)) })
    }
    if (rl.until && rl.until <= now) rl.n = 0 // cooldown served, budget refills

    if (rl.n + pixels.length > BURST) {
      return json({
        error: `only ${BURST - rl.n} left before a break`, remaining: Math.max(0, BURST - rl.n), id: who,
      }, 429)
    }

    rl.n += pixels.length
    rl.until = rl.n >= BURST ? now + COOLDOWN_S * 1000 : 0
    await env.PIXELS.put(`rl:${who}`, JSON.stringify(rl), { expirationTtl: 3600 })

    await applyPixels(env, pixels)
    ctx.waitUntil(logPixels(env, who, pixels))

    return json({
      ok: true,
      painted: pixels.length,
      remaining: Math.max(0, BURST - rl.n),
      cooldownUntil: rl.until || null,
      id: who,
    })
  }

  /* POST /api/pixels/admin */
  if (request.method === 'POST' && path === 'admin') {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!env.PIXELS_ADMIN_TOKEN || token !== env.PIXELS_ADMIN_TOKEN) {
      return json({ error: 'unauthorised' }, 401)
    }

    let body: Record<string, unknown>
    try { body = await request.json() } catch { return json({ error: 'bad json' }, 400) }
    const op = String(body.op ?? '')

    const rect = () => ({
      x: Math.max(0, Number(body.x) | 0), y: Math.max(0, Number(body.y) | 0),
      w: Math.min(Number(body.w) | 0, GRID_W), h: Math.min(Number(body.h) | 0, GRID_H),
    })

    switch (op) {
      /* Erase or flood a rectangle — the two bulk cleanup tools. */
      case 'clearRect':
      case 'fillRect': {
        const { x, y, w, h } = rect()
        if (w <= 0 || h <= 0) return json({ error: 'w and h must be positive' }, 400)
        if (w * h > 40_000) return json({ error: 'rectangle too large, split it up' }, 400)
        const c = op === 'clearRect' ? 0 : Number(body.c) | 0
        if (c < 0 || c >= PALETTE.length) return json({ error: 'bad colour' }, 400)
        const px: Pixel[] = []
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            if (inBounds(x + dx, y + dy)) px.push({ x: x + dx, y: y + dy, c })
          }
        }
        await applyPixels(env, px)
        ctx.waitUntil(logPixels(env, 'ADMIN', px.slice(0, 5), `${op} ${w}x${h} `))
        return json({ ok: true, op, affected: px.length })
      }

      /* Stamp arbitrary art over whatever is there. No rate limit. */
      case 'paint': {
        const raw = body.pixels as [number, number, number][] | undefined
        if (!Array.isArray(raw) || !raw.length) return json({ error: 'no pixels' }, 400)
        if (raw.length > 40_000) return json({ error: 'too many pixels' }, 400)
        const px: Pixel[] = []
        for (const [x, y, c] of raw) {
          if (inBounds(x, y) && c >= 0 && c < PALETTE.length) px.push({ x, y, c })
        }
        await applyPixels(env, px)
        ctx.waitUntil(logPixels(env, 'ADMIN', px.slice(0, 5), 'stamp '))
        return json({ ok: true, op, affected: px.length })
      }

      /* Wipe every user-drawn pixel. The baked seed art is untouched — it is a
         static file, not storage, so the canvas is never left blank. */
      case 'clearAll': {
        let n = 0, cursor: string | undefined
        do {
          const page = await env.PIXELS.list({ prefix: 'c:', cursor, limit: 1000 })
          for (const k of page.keys) { await env.PIXELS.delete(k.name); n++ }
          cursor = page.list_complete ? undefined : page.cursor
        } while (cursor)
        ctx.waitUntil(logPixels(env, 'ADMIN', [], `cleared the whole canvas (${n} chunks) `))
        return json({ ok: true, op, chunksDeleted: n })
      }

      case 'ban':
      case 'unban': {
        const id = String(body.id ?? '').trim()
        if (!/^[0-9a-f]{10}$/.test(id)) return json({ error: 'id must be the 10-char painter id' }, 400)
        if (op === 'ban') await env.PIXELS.put(`ban:${id}`, String(Date.now()))
        else await env.PIXELS.delete(`ban:${id}`)
        ctx.waitUntil(logPixels(env, 'ADMIN', [], `${op} ${id} `))
        return json({ ok: true, op, id })
      }

      case 'bans': {
        const page = await env.PIXELS.list({ prefix: 'ban:', limit: 1000 })
        return json({ ok: true, bans: page.keys.map((k) => k.name.slice(4)) })
      }

      case 'stats': {
        const chunks = await readCanvas(env)
        const pixels = Object.values(chunks).reduce((n, s) => n + unpackChunk(s).length, 0)
        const bans = await env.PIXELS.list({ prefix: 'ban:', limit: 1000 })
        return json({ ok: true, chunks: Object.keys(chunks).length, pixels, bans: bans.keys.length })
      }

      default:
        return json({
          error: 'unknown op',
          ops: ['clearRect', 'fillRect', 'paint', 'clearAll', 'ban', 'unban', 'bans', 'stats'],
        }, 400)
    }
  }

  return json({ error: 'not found' }, 404)
}
