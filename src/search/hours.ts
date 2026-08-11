/**
 * A small, deliberately partial `opening_hours` reader.
 *
 * OSM's opening_hours grammar is enormous. This covers the shapes that actually
 * occur in the IITK extract — "24/7", "Mo-Fr 09:00-20:00", "Mo-Sa 08:30-19:30;
 * Su off", multiple ranges — and returns `null` for anything it does not
 * understand rather than guessing. A wrong "open now" is worse than none.
 */

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

export type OpenState = { open: boolean; until?: string; next?: string } | null

interface Span { days: Set<number>; from: number; to: number }

const cache = new Map<string, Span[] | null>()

function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = +m[1]!, mi = +m[2]!
  if (h > 24 || mi > 59) return null
  return h * 60 + mi
}

function parseDays(token: string): Set<number> | null {
  const out = new Set<number>()
  for (const part of token.split(',')) {
    const range = /^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/.exec(part.trim())
    if (range) {
      const a = DAYS.findIndex((d) => d.toLowerCase() === range[1]!.toLowerCase())
      const b = DAYS.findIndex((d) => d.toLowerCase() === range[2]!.toLowerCase())
      if (a < 0 || b < 0) return null
      for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break }
      continue
    }
    const one = DAYS.findIndex((d) => d.toLowerCase() === part.trim().toLowerCase())
    if (one < 0) return null
    out.add(one)
  }
  return out.size ? out : null
}

function parse(spec: string): Span[] | null {
  const hit = cache.get(spec)
  if (hit !== undefined) return hit

  let result: Span[] | null = []
  const s = spec.trim()

  if (/^24\s*\/\s*7$/.test(s)) {
    result = [{ days: new Set([0, 1, 2, 3, 4, 5, 6]), from: 0, to: 1440 }]
  } else {
    for (const rule of s.split(';')) {
      const r = rule.trim()
      if (!r) continue
      if (/\b(off|closed)\b/i.test(r)) continue // "Su off" — just no span for that day
      // "Mo-Fr 09:00-20:00" or "09:00-20:00" (every day) or "Mo-Fr 09:00-13:00,14:00-18:00"
      const m = /^(?:([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s+)?((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)$/.exec(r)
      if (!m) { result = null; break }
      const days = m[1] ? parseDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6])
      if (!days) { result = null; break }
      for (const win of m[2]!.split(',')) {
        const [a, b] = win.split('-')
        const from = minutes(a ?? ''), to = minutes(b ?? '')
        if (from === null || to === null) { result = null; break }
        result!.push({ days, from, to })
      }
      if (result === null) break
    }
    if (result && !result.length) result = null
  }

  cache.set(spec, result)
  return result
}

const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** `null` when the spec is unparseable or absent — render nothing in that case. */
export function openNow(spec: string | undefined, now = new Date()): OpenState {
  if (!spec) return null
  const spans = parse(spec)
  if (!spans) return null

  const day = now.getDay()
  const mins = now.getHours() * 60 + now.getMinutes()

  for (const s of spans) {
    // A span ending past midnight (to <= from) spills into the next day.
    const overnight = s.to <= s.from
    if (s.days.has(day) && (overnight ? mins >= s.from : mins >= s.from && mins < s.to)) {
      return { open: true, until: overnight ? clock(s.to) : clock(s.to) }
    }
    if (overnight && s.days.has((day + 6) % 7) && mins < s.to) {
      return { open: true, until: clock(s.to) }
    }
  }

  // Closed — find the next opening within a week.
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = (day + ahead) % 7
    let best = Infinity
    for (const s of spans) {
      if (!s.days.has(d)) continue
      if (ahead === 0 && s.from <= mins) continue
      best = Math.min(best, s.from)
    }
    if (best < Infinity) {
      return { open: false, next: ahead === 0 ? clock(best) : `${DAYS[d]} ${clock(best)}` }
    }
  }
  return { open: false }
}
