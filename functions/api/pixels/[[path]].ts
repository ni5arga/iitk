/**
 * Pixel canvas API — Cloudflare Pages Functions, backed by D1.
 *
 *   GET  /api/pixels           whole canvas
 *   GET  /api/pixels/since     only what changed after a sequence number
 *   POST /api/pixels/paint     place pixels, IP rate limited
 *   POST /api/pixels/admin     moderation, needs PIXELS_ADMIN_TOKEN
 *
 * Bindings on the Pages project:
 *   DB                   D1 database (canvas, rate limits, bans, log buffer)
 *   DISCORD_WEBHOOK      secret — never reaches the browser
 *   PIXELS_ADMIN_TOKEN   secret — bearer token for the admin route
 *
 * Why D1 and not KV. KV bills per *operation* and the free tier allows 1,000
 * writes a day. One paint request cost five of them — the rate-limit counter,
 * the chunk, the Discord buffer, the attribution record and the live feed — so
 * the canvas ran dry after roughly 200 requests. A shared canvas is
 * write-heavy, which is the one shape KV is worst at.
 *
 * D1 bills per *row* and allows 100,000 row-writes a day, and the data was
 * relational all along: one row per pixel, a monotonic `seq` driving the live
 * feed, and the painter recorded on the row itself. That also deletes the chunk
 * packing, every list operation, and the separate `recent` and `feed` keys.
 */

import { CHUNK, GRID_W, GRID_H, PALETTE, chunkOf, inBounds, type Pixel } from '../../../src/pixels/grid'

interface Env {
  /** Preferred binding name. */
  DB?: D1Database
  /** What `wrangler d1 create iitk-pixels` suggests by default — accepted so a
   *  copy-pasted binding name does not silently 503. */
  iitk_pixels?: D1Database
  DISCORD_WEBHOOK?: string
  PIXELS_ADMIN_TOKEN?: string
}

/** The bound database, whichever name it went in under. */
const database = (env: Env) => env.DB ?? env.iitk_pixels

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

/* ── schema ──────────────────────────────────────────────────────────────── */
// Created on demand, so deploying needs only the binding and no migration step.

let ready = false
async function ensureSchema(db: D1Database) {
  if (ready) return
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS pixels (
      x INTEGER NOT NULL, y INTEGER NOT NULL, c INTEGER NOT NULL,
      seq INTEGER NOT NULL, painter TEXT, at INTEGER,
      PRIMARY KEY (x, y))`),
    // The live feed is "rows above a sequence number", so this index is what
    // keeps polling cheap instead of a table scan.
    db.prepare('CREATE INDEX IF NOT EXISTS pixels_seq ON pixels(seq)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS bans (id TEXT PRIMARY KEY, at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS limits (id TEXT PRIMARY KEY, n INTEGER, until INTEGER)'),
  ])
  ready = true
}

const getMeta = async (env: Env, k: string, fallback = '0') => {
  const row = await env.DB!.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first<{ v: string }>()
  return row?.v ?? fallback
}
const setMeta = (env: Env, k: string, v: string) =>
  env.DB!.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, v)

/* ── identity ────────────────────────────────────────────────────────────── */

/**
 * A short, stable id derived from the client IP. The address itself is never
 * stored or logged — bans and rate limits key off this instead, which is enough
 * to moderate with and useless for identifying anyone off-platform.
 */
async function painterId(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`iitk-pixels:${ip}`))
  return [...new Uint8Array(digest)].slice(0, 5)
    .map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ── canvas ──────────────────────────────────────────────────────────────── */

/** Chunked exactly as before, so this migration is invisible to the client. */
async function readCanvas(env: Env) {
  const { results } = await env.DB!.prepare('SELECT x, y, c FROM pixels').all<Pixel>()
  const grouped: Record<string, number[]> = {}
  for (const p of results) {
    const { cx, cy } = chunkOf(p.x, p.y)
    ;(grouped[`${cx}:${cy}`] ??= []).push(p.x, p.y, p.c)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(grouped)) out[k] = v.join(',')
  return out
}

/**
 * Write pixels and bump the sequence in one batch, so a reader can never see
 * half a stroke. Colour 0 deletes rather than storing a transparent row.
 */
async function applyPixels(env: Env, pixels: Pixel[], painter: string) {
  const seq = Number(await getMeta(env, 'seq')) + 1
  const now = Date.now()
  const stmts: D1PreparedStatement[] = []
  for (const p of pixels) {
    stmts.push(p.c === 0
      ? env.DB!.prepare('DELETE FROM pixels WHERE x = ? AND y = ?').bind(p.x, p.y)
      : env.DB!.prepare(
          `INSERT INTO pixels (x, y, c, seq, painter, at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(x, y) DO UPDATE SET
             c = excluded.c, seq = excluded.seq, painter = excluded.painter, at = excluded.at`,
        ).bind(p.x, p.y, p.c, seq, painter, now))
  }
  // A deleted row cannot show up in a "seq > n" query, so erases are recorded
  // separately — otherwise rubbed-out pixels never disappear for anyone else.
  const erased = pixels.filter((p) => p.c === 0)
  if (erased.length) {
    stmts.push(setMeta(env, 'erased', JSON.stringify({ seq, px: erased.map((p) => [p.x, p.y]) })))
  }
  stmts.push(setMeta(env, 'seq', String(seq)))
  await env.DB!.batch(stmts)
}

/* ── discord logging ─────────────────────────────────────────────────────── */

/**
 * Every pixel is logged, but batched. A Discord webhook allows a handful of
 * posts per second; one message per pixel would be throttled into uselessness
 * the moment two people drew at once.
 */
const LOG_FLUSH_AT = 25
const LOG_MAX_AGE_MS = 45_000

async function logPixels(env: Env, who: string, pixels: Pixel[], note = '') {
  if (!env.DISCORD_WEBHOOK) return
  const raw = await getMeta(env, 'logbuf', '')
  const buf = raw ? JSON.parse(raw) as { t: number; lines: string[] } : { t: Date.now(), lines: [] }
  for (const p of pixels) {
    buf.lines.push(`\`${who}\` ${note}(${p.x},${p.y}) ${p.c === 0 ? 'erase' : PALETTE[p.c]}`)
  }
  if (!pixels.length && note) buf.lines.push(`\`${who}\` ${note}`)

  if (buf.lines.length < LOG_FLUSH_AT && Date.now() - buf.t <= LOG_MAX_AGE_MS) {
    await setMeta(env, 'logbuf', JSON.stringify(buf)).run()
    return
  }

  const lines = buf.lines.splice(0, 60)
  await setMeta(env, 'logbuf', JSON.stringify({ t: Date.now(), lines: buf.lines })).run()
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

  const db = database(env)
  if (!db) {
    return json({
      error: 'canvas storage is not configured — bind a D1 database as DB on this Pages project',
    }, 503)
  }
  await ensureSchema(db)
  // Helpers still take `env`; give them the resolved handle under the name
  // they expect rather than threading a parameter through every call site.
  const e = { ...env, DB: db } as Env & { DB: D1Database }

  /* GET /api/pixels */
  if (request.method === 'GET' && path === '') {
    const [chunks, seq, epoch] = await Promise.all([
      readCanvas(e), getMeta(e, 'seq'), getMeta(e, 'epoch'),
    ])
    return json({
      grid: { w: GRID_W, h: GRID_H, chunk: CHUNK },
      burst: BURST, cooldown: COOLDOWN_S, maxPerRequest: MAX_PER_REQUEST,
      seq: Number(seq), epoch, chunks,
    })
  }

  /* GET /api/pixels/since?seq=N */
  if (request.method === 'GET' && path === 'since') {
    const since = Number(new URL(request.url).searchParams.get('seq') ?? 0)
    const [rows, head, epoch, erasedRaw] = await Promise.all([
      e.DB.prepare('SELECT x, y, c FROM pixels WHERE seq > ? LIMIT 4000').bind(since).all<Pixel>(),
      getMeta(e, 'seq'), getMeta(e, 'epoch'), getMeta(e, 'erased', ''),
    ])
    const pixels: [number, number, number][] = rows.results.map((p) => [p.x, p.y, p.c])
    if (erasedRaw) {
      const e = JSON.parse(erasedRaw) as { seq: number; px: [number, number][] }
      if (e.seq > since) for (const [x, y] of e.px) pixels.push([x, y, 0])
    }
    return json({ seq: Number(head), epoch, stale: false, pixels })
  }

  /* POST /api/pixels/paint */
  if (request.method === 'POST' && path === 'paint') {
    const who = await painterId(request)

    const banned = await e.DB.prepare('SELECT 1 FROM bans WHERE id = ?').bind(who).first()
    if (banned) return json({ error: 'You are banned from painting.', id: who }, 403)

    let body: { pixels?: [number, number, number][] }
    try { body = await request.json() } catch { return json({ error: 'bad json' }, 400) }

    const raw = body.pixels
    if (!Array.isArray(raw) || !raw.length) return json({ error: 'no pixels' }, 400)
    if (raw.length > MAX_PER_REQUEST) {
      return json({ error: `at most ${MAX_PER_REQUEST} pixels per request` }, 400)
    }

    const pixels: Pixel[] = []
    for (const item of raw) {
      if (!Array.isArray(item) || item.length !== 3) return json({ error: 'bad pixel' }, 400)
      const [x, y, c] = item.map(Number)
      // The client is not trusted about position or colour.
      if (!inBounds(x!, y!)) return json({ error: `pixel out of bounds: ${x},${y}` }, 400)
      if (!Number.isInteger(c) || c! < 0 || c! >= PALETTE.length) {
        return json({ error: `bad colour index: ${c}` }, 400)
      }
      pixels.push({ x: x!, y: y!, c: c! })
    }

    const now = Date.now()
    const rl = await e.DB.prepare('SELECT n, until FROM limits WHERE id = ?')
      .bind(who).first<{ n: number; until: number }>() ?? { n: 0, until: 0 }

    if (rl.until > now) {
      return json({ error: 'cooling down', cooldownUntil: rl.until, remaining: 0, id: who },
        429, { 'retry-after': String(Math.ceil((rl.until - now) / 1000)) })
    }
    if (rl.until && rl.until <= now) rl.n = 0     // cooldown served, budget refills
    if (rl.n + pixels.length > BURST) {
      return json({
        error: `only ${BURST - rl.n} left before a break`,
        remaining: Math.max(0, BURST - rl.n), id: who,
      }, 429)
    }

    const n = rl.n + pixels.length
    const until = n >= BURST ? now + COOLDOWN_S * 1000 : 0
    await e.DB.prepare(
      `INSERT INTO limits (id, n, until) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET n = excluded.n, until = excluded.until`,
    ).bind(who, n, until).run()

    await applyPixels(e, pixels, who)
    ctx.waitUntil(logPixels(e, who, pixels))

    return json({
      ok: true, painted: pixels.length,
      remaining: Math.max(0, BURST - n),
      cooldownUntil: until || null, id: who,
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

    switch (op) {
      case 'clearRect':
      case 'fillRect': {
        const x = Math.max(0, Number(body.x) | 0), y = Math.max(0, Number(body.y) | 0)
        const w = Math.min(Number(body.w) | 0, GRID_W), h = Math.min(Number(body.h) | 0, GRID_H)
        if (w <= 0 || h <= 0) return json({ error: 'w and h must be positive' }, 400)
        if (w * h > 40_000) return json({ error: 'rectangle too large, split it up' }, 400)
        const c = op === 'clearRect' ? 0 : Number(body.c) | 0
        if (c < 0 || c >= PALETTE.length) return json({ error: 'bad colour' }, 400)

        if (op === 'clearRect') {
          // One statement rather than up to 40,000 individual row writes.
          const seq = Number(await getMeta(e, 'seq')) + 1
          await e.DB.batch([
            e.DB.prepare('DELETE FROM pixels WHERE x >= ? AND x < ? AND y >= ? AND y < ?')
              .bind(x, x + w, y, y + h),
            setMeta(e, 'epoch', String(Date.now())),   // a bulk erase is not a diff
            setMeta(e, 'seq', String(seq)),
          ])
        } else {
          const px: Pixel[] = []
          for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
              if (inBounds(x + dx, y + dy)) px.push({ x: x + dx, y: y + dy, c })
            }
          }
          for (let i = 0; i < px.length; i += 500) await applyPixels(e, px.slice(i, i + 500), 'ADMIN')
        }
        ctx.waitUntil(logPixels(e, 'ADMIN', [], `${op} ${w}x${h} at ${x},${y}`))
        return json({ ok: true, op, affected: w * h })
      }

      case 'paint': {
        const raw = body.pixels as [number, number, number][] | undefined
        if (!Array.isArray(raw) || !raw.length) return json({ error: 'no pixels' }, 400)
        if (raw.length > 40_000) return json({ error: 'too many pixels' }, 400)
        const px: Pixel[] = []
        for (const [x, y, c] of raw) {
          if (inBounds(x, y) && c >= 0 && c < PALETTE.length) px.push({ x, y, c })
        }
        for (let i = 0; i < px.length; i += 500) await applyPixels(e, px.slice(i, i + 500), 'ADMIN')
        ctx.waitUntil(logPixels(e, 'ADMIN', px.slice(0, 5), 'stamp '))
        return json({ ok: true, op, affected: px.length })
      }

      /* Wipe every user-drawn pixel. The seeded art is a static file, not
         storage, so the canvas is never left blank. */
      case 'clearAll': {
        await e.DB.batch([
          e.DB.prepare('DELETE FROM pixels'),
          setMeta(e, 'epoch', String(Date.now())),
          setMeta(e, 'erased', ''),
        ])
        ctx.waitUntil(logPixels(e, 'ADMIN', [], 'cleared the whole canvas'))
        return json({ ok: true, op })
      }

      case 'ban':
      case 'unban': {
        const id = String(body.id ?? '').trim()
        if (!/^[0-9a-f]{10}$/.test(id)) return json({ error: 'id must be the 10-char painter id' }, 400)
        await (op === 'ban'
          ? e.DB.prepare('INSERT OR REPLACE INTO bans (id, at) VALUES (?, ?)').bind(id, Date.now())
          : e.DB.prepare('DELETE FROM bans WHERE id = ?').bind(id)).run()
        ctx.waitUntil(logPixels(e, 'ADMIN', [], `${op} ${id}`))
        return json({ ok: true, op, id })
      }

      case 'bans': {
        const { results } = await e.DB.prepare('SELECT id FROM bans').all<{ id: string }>()
        return json({ ok: true, bans: results.map((r) => r.id) })
      }

      /* Who painted this pixel. The row carries it, so there is no side list to
         fall out of date or age out. */
      case 'who': {
        const x = Number(body.x) | 0, y = Number(body.y) | 0
        if (!inBounds(x, y)) return json({ error: 'out of bounds' }, 400)
        const row = await e.DB.prepare('SELECT painter, at FROM pixels WHERE x = ? AND y = ?')
          .bind(x, y).first<{ painter: string; at: number }>()
        return json({ ok: true, x, y, painter: row ? { id: row.painter, at: row.at } : null })
      }

      case 'recent': {
        const { results } = await e.DB.prepare(
          'SELECT x, y, painter, at FROM pixels ORDER BY at DESC LIMIT 120').all()
        return json({ ok: true, recent: results })
      }

      case 'stats': {
        const [px, bans] = await Promise.all([
          e.DB.prepare('SELECT COUNT(*) AS n FROM pixels').first<{ n: number }>(),
          e.DB.prepare('SELECT COUNT(*) AS n FROM bans').first<{ n: number }>(),
        ])
        return json({ ok: true, pixels: px?.n ?? 0, bans: bans?.n ?? 0, chunks: 0 })
      }

      default:
        return json({
          error: 'unknown op',
          ops: ['clearRect', 'fillRect', 'paint', 'clearAll', 'ban', 'unban', 'bans', 'who', 'recent', 'stats'],
        }, 400)
    }
  }

  return json({ error: 'not found' }, 404)
}
