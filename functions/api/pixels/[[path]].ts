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

/* ── campus ip whitelist ─────────────────────────────────────────────────── */

/**
 * Addresses that get the campus budget instead of the public one.
 *
 * Only globally routable ranges are listed. Cloudflare reports the public
 * source address in `cf-connecting-ip`, so an RFC1918 range — 172.24/16,
 * 172.31.0.0/17, 10/8 — can never appear here no matter how much of campus sits
 * behind it; those hosts reach us NATed out through the blocks below. Listing
 * them would be dead config that quietly matches nothing, and 172.16/12 is
 * shared address space that is emphatically not all IITK.
 *
 * Editable at runtime from the admin dashboard; this is only the fallback.
 */
export interface IpRules {
  enabled: boolean
  /** Pixels a campus address may paint before its cooldown. */
  burst: number
  /** Cooldown in seconds once the burst is spent. */
  cooldown: number
  cidrs: string[]
}

const DEFAULT_IP_RULES: IpRules = {
  enabled: true,
  burst: 500,
  cooldown: 60,
  cidrs: [
    '202.3.77.0/24',      // IIT Kanpur campus network (legacy/primary)
    '103.246.106.0/24',   // IIT Kanpur
    '161.248.106.0/24',   // IIT Kanpur
    '2001:df0:92::/48',   // IIT Kanpur campus network, IPv6
  ],
}

function parseIp4(s: string): Uint8Array | null {
  const p = s.split('.')
  if (p.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(p[i]!)) return null
    const n = Number(p[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseIp6(input: string): Uint8Array | null {
  let s = input
  const zone = s.indexOf('%')
  if (zone > -1) s = s.slice(0, zone)

  // A dotted tail ("::ffff:1.2.3.4") is two hextets in disguise. Rewriting it
  // keeps the rest of the parse to a single uniform form.
  if (s.includes('.')) {
    const c = s.lastIndexOf(':')
    if (c < 0) return null
    const v4 = parseIp4(s.slice(c + 1))
    if (!v4) return null
    s = s.slice(0, c + 1) +
      ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16)
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null

  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i]!)) return null
    const n = parseInt(groups[i]!, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

/** An IPv4-mapped IPv6 address is the same host as its IPv4 form, so fold it
 *  down — otherwise `::ffff:202.3.77.9` would miss a 202.3.77.0/24 rule. */
function normaliseIp(b: Uint8Array): Uint8Array {
  const mapped = b.length === 16 && b[10] === 0xff && b[11] === 0xff &&
    b.subarray(0, 10).every((x) => x === 0)
  return mapped ? b.subarray(12) : b
}

export function parseIp(s: string): Uint8Array | null {
  const t = s.trim()
  if (!t) return null
  const b = t.includes(':') ? parseIp6(t) : parseIp4(t)
  return b ? normaliseIp(b) : null
}

/** Bit-prefix match. A bare address with no `/len` matches only itself. */
export function inCidr(ip: Uint8Array, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  const net = parseIp(slash < 0 ? cidr : cidr.slice(0, slash))
  if (!net || net.length !== ip.length) return false
  const bits = net.length * 8
  const len = slash < 0 ? bits : Number(cidr.slice(slash + 1))
  if (!Number.isInteger(len) || len < 0 || len > bits) return false

  const whole = len >> 3
  for (let i = 0; i < whole; i++) if (ip[i] !== net[i]) return false
  const rest = len & 7
  if (rest) {
    const mask = (0xff << (8 - rest)) & 0xff
    if ((ip[whole]! & mask) !== (net[whole]! & mask)) return false
  }
  return true
}

async function getIpRules(env: Env): Promise<IpRules> {
  const raw = await getMeta(env, 'iprules', '')
  if (!raw) return DEFAULT_IP_RULES
  try {
    const r = JSON.parse(raw) as Partial<IpRules>
    return {
      enabled: r.enabled ?? true,
      burst: Number(r.burst) || DEFAULT_IP_RULES.burst,
      cooldown: Number(r.cooldown) || DEFAULT_IP_RULES.cooldown,
      cidrs: Array.isArray(r.cidrs) ? r.cidrs : DEFAULT_IP_RULES.cidrs,
    }
  } catch {
    return DEFAULT_IP_RULES        // corrupt config must not stop the canvas
  }
}

/** Whether this request comes from a whitelisted range, and the budget it earns. */
function budgetFor(req: Request, rules: IpRules) {
  const ip = rules.enabled ? parseIp(req.headers.get('cf-connecting-ip') ?? '') : null
  const campus = !!ip && rules.cidrs.some((c) => inCidr(ip, c))
  return campus
    ? { campus, burst: rules.burst, cooldown: rules.cooldown }
    : { campus, burst: BURST, cooldown: COOLDOWN_S }
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
    const [chunks, seq, epoch, rules] = await Promise.all([
      readCanvas(e), getMeta(e, 'seq'), getMeta(e, 'epoch'), getIpRules(e),
    ])
    // Report the budget this caller actually gets, not the public default, so
    // the on-campus counter does not start out lying about how much is left.
    const { campus, burst, cooldown } = budgetFor(request, rules)
    return json({
      grid: { w: GRID_W, h: GRID_H, chunk: CHUNK },
      burst, cooldown, campus, maxPerRequest: MAX_PER_REQUEST,
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
    const { campus, burst, cooldown } = budgetFor(request, await getIpRules(e))
    const rl = await e.DB.prepare('SELECT n, until FROM limits WHERE id = ?')
      .bind(who).first<{ n: number; until: number }>() ?? { n: 0, until: 0 }

    if (rl.until > now) {
      return json({ error: 'cooling down', cooldownUntil: rl.until, remaining: 0, id: who },
        429, { 'retry-after': String(Math.ceil((rl.until - now) / 1000)) })
    }
    if (rl.until && rl.until <= now) rl.n = 0     // cooldown served, budget refills
    if (rl.n + pixels.length > burst) {
      return json({
        error: `only ${burst - rl.n} left before a break`,
        remaining: Math.max(0, burst - rl.n), id: who,
      }, 429)
    }

    const n = rl.n + pixels.length
    const until = n >= burst ? now + cooldown * 1000 : 0
    await e.DB.prepare(
      `INSERT INTO limits (id, n, until) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET n = excluded.n, until = excluded.until`,
    ).bind(who, n, until).run()

    await applyPixels(e, pixels, who)
    ctx.waitUntil(logPixels(e, who, pixels))

    return json({
      ok: true, painted: pixels.length, campus,
      remaining: Math.max(0, burst - n),
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

      case 'iprules':
        return json({ ok: true, rules: await getIpRules(e), defaults: DEFAULT_IP_RULES })

      case 'setIprules': {
        const r = (body.rules ?? {}) as Partial<IpRules>
        const burst = Number(r.burst)
        const cooldown = Number(r.cooldown)
        if (!Number.isInteger(burst) || burst < 1 || burst > 100_000) {
          return json({ error: 'burst must be 1–100000' }, 400)
        }
        if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 86_400) {
          return json({ error: 'cooldown must be 1–86400 seconds' }, 400)
        }
        const cidrs = (Array.isArray(r.cidrs) ? r.cidrs : [])
          .map((c) => String(c).trim()).filter(Boolean)
        if (cidrs.length > 64) return json({ error: 'at most 64 ranges' }, 400)
        // Reject the whole edit rather than silently dropping a typo'd range —
        // a whitelist that quietly lost an entry is worse than one that failed.
        for (const c of cidrs) {
          if (!parseIp(c.split('/')[0]!) || !inCidr(parseIp(c.split('/')[0]!)!, c)) {
            return json({ error: `not a valid CIDR: ${c}` }, 400)
          }
        }
        const rules: IpRules = { enabled: !!r.enabled, burst, cooldown, cidrs }
        await setMeta(e, 'iprules', JSON.stringify(rules)).run()
        ctx.waitUntil(logPixels(e, 'admin', [], `set ip rules · ${
          rules.enabled ? 'on' : 'off'} · ${burst}/${cooldown}s · ${cidrs.length} ranges`))
        return json({ ok: true, rules })
      }

      default:
        return json({
          error: 'unknown op',
          ops: ['clearRect', 'fillRect', 'paint', 'clearAll', 'ban', 'unban', 'bans',
            'who', 'recent', 'stats', 'iprules', 'setIprules'],
        }, 400)
    }
  }

  return json({ error: 'not found' }, 404)
}
