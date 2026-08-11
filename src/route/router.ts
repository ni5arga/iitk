import type { Graph, Profile, Route } from '../types'

const R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180

export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const FLAG_STEPS = 1, FLAG_INDOOR = 2, FLAG_UNPAVED = 8

/**
 * A* over the campus path network. Costs are seconds, baked per profile at
 * build time, so the ETA is just the final g-score — no post-hoc speed guess.
 */
export class Router {
  private readonly lat: Float64Array
  private readonly lon: Float64Array
  /** CSR adjacency: head[n]..head[n+1] indexes into `to`/`edge`. */
  private readonly head: Int32Array
  private readonly to: Int32Array
  private readonly edgeOf: Int32Array
  private readonly edges: Graph['edges']

  /** Fastest metres/second on the network — keeps the A* heuristic admissible. */
  private readonly topSpeed: Record<Profile, number>

  constructor(g: Graph) {
    const n = g.lat.length
    this.lat = Float64Array.from(g.lat)
    this.lon = Float64Array.from(g.lon)
    this.edges = g.edges

    const deg = new Int32Array(n + 1)
    for (const [a, b] of g.edges) { deg[a + 1]!++; deg[b + 1]!++ }
    for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!
    this.head = deg
    this.to = new Int32Array(g.edges.length * 2)
    this.edgeOf = new Int32Array(g.edges.length * 2)

    const cursor = Int32Array.from(deg.subarray(0, n))
    g.edges.forEach(([a, b], i) => {
      this.to[cursor[a]!] = b; this.edgeOf[cursor[a]!] = i; cursor[a]!++
      this.to[cursor[b]!] = a; this.edgeOf[cursor[b]!] = i; cursor[b]!++
    })

    let foot = 0.1, bike = 0.1
    for (const [, , m, fs, bs] of g.edges) {
      if (fs > 0) foot = Math.max(foot, m / fs)
      if (bs > 0) bike = Math.max(bike, m / bs)
    }
    this.topSpeed = { foot, bike }
  }

  /** Nearest graph node to a coordinate, by straight-line distance. */
  nearest(lat: number, lon: number): number {
    let best = -1
    let bestD = Infinity
    // Cheap squared-degree metric first; the network is small enough to scan.
    const kLon = Math.cos(rad(lat))
    for (let i = 0; i < this.lat.length; i++) {
      const dy = this.lat[i]! - lat
      const dx = (this.lon[i]! - lon) * kLon
      const d = dy * dy + dx * dx
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  route(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    profile: Profile,
  ): Route | null {
    const start = this.nearest(from.lat, from.lon)
    const goal = this.nearest(to.lat, to.lon)
    if (start < 0 || goal < 0) return null

    const n = this.lat.length
    const g = new Float64Array(n).fill(Infinity)
    const cameFrom = new Int32Array(n).fill(-1)
    const cameEdge = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const costIdx = profile === 'foot' ? 3 : 4
    const speed = this.topSpeed[profile]

    const h = (i: number) => metresBetween(this.lat[i]!, this.lon[i]!, this.lat[goal]!, this.lon[goal]!) / speed

    const open = new BinaryHeap()
    g[start] = 0
    open.push(start, h(start))

    while (open.size) {
      const cur = open.pop()!
      if (cur === goal) break
      if (closed[cur]) continue
      closed[cur] = 1

      for (let k = this.head[cur]!; k < this.head[cur + 1]!; k++) {
        const nb = this.to[k]!
        if (closed[nb]) continue
        const e = this.edges[this.edgeOf[k]!]!
        const step = e[costIdx] as number
        if (step < 0) continue // profile cannot use this edge (e.g. bike in a corridor)
        const tentative = g[cur]! + step
        if (tentative >= g[nb]!) continue
        g[nb] = tentative
        cameFrom[nb] = cur
        cameEdge[nb] = this.edgeOf[k]!
        open.push(nb, tentative + h(nb))
      }
    }

    if (!isFinite(g[goal]!)) return null

    const coords: [number, number][] = []
    let metres = 0
    let steps = false, indoor = false, unpaved = false
    for (let at = goal; at !== -1; at = cameFrom[at]!) {
      coords.push([this.lon[at]!, this.lat[at]!])
      const ei = cameEdge[at]!
      if (ei >= 0) {
        const e = this.edges[ei]!
        metres += e[2]
        if (e[5] & FLAG_STEPS) steps = true
        if (e[5] & FLAG_INDOOR) indoor = true
        if (e[5] & FLAG_UNPAVED) unpaved = true
      }
    }
    coords.reverse()

    // Walk in from the real endpoints, which sit off-network.
    const legIn = metresBetween(from.lat, from.lon, this.lat[start]!, this.lon[start]!)
    const legOut = metresBetween(to.lat, to.lon, this.lat[goal]!, this.lon[goal]!)
    coords.unshift([from.lon, from.lat])
    coords.push([to.lon, to.lat])

    // Approach legs are always on foot, whatever the profile.
    const walkSpeed = 1.35
    return {
      coords,
      metres: Math.round(metres + legIn + legOut),
      seconds: Math.round(g[goal]! + (legIn + legOut) / walkSpeed),
      steps, indoor, unpaved,
    }
  }
}

/** Min-heap keyed on f-score. Lazy deletion — stale entries are skipped by `closed`. */
class BinaryHeap {
  private items: number[] = []
  private keys: number[] = []

  get size() { return this.items.length }

  push(item: number, key: number) {
    this.items.push(item)
    this.keys.push(key)
    let i = this.items.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p]! <= this.keys[i]!) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number | undefined {
    if (!this.items.length) return undefined
    const top = this.items[0]!
    const lastItem = this.items.pop()!
    const lastKey = this.keys.pop()!
    if (this.items.length) {
      this.items[0] = lastItem
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let s = i
        if (l < this.items.length && this.keys[l]! < this.keys[s]!) s = l
        if (r < this.items.length && this.keys[r]! < this.keys[s]!) s = r
        if (s === i) break
        this.swap(i, s)
        i = s
      }
    }
    return top
  }

  private swap(a: number, b: number) {
    ;[this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!]
    ;[this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!]
  }
}

export function humanEta(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function humanDistance(metres: number): string {
  return metres < 950 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`
}
