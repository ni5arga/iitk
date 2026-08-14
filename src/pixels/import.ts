/**
 * Turn a dropped image into pixel art, in the browser.
 *
 * Same algorithm as scripts/pixelify.mjs, but decoding through
 * `createImageBitmap` instead of shelling out to `sips`, so it runs on the
 * admin's machine with no build step and can re-render live as they drag a
 * slider.
 */

import { PALETTE } from './grid'

export interface Converted {
  w: number
  h: number
  /** [x, y, paletteIndex] */
  px: [number, number, number][]
}

export interface ConvertOptions {
  /** Target width in canvas pixels. Height follows the aspect ratio. */
  width: number
  /** How close a colour must be to a corner sample to count as background. */
  tolerance: number
  /**
   * Sample the middle of each source block rather than averaging it. Right for
   * sources that are already pixel art — averaging blends neighbouring cells
   * and any grid lines between them into mud.
   */
  centre: boolean
  /**
   * What to do with detected background.
   *   drop  — leave it transparent (default)
   *   holes — keep only background enclosed by artwork
   *   box   — fill the whole bounding box, for two-tone charts where the
   *           white cells are as much a part of the picture as the black
   */
  backdrop: 'drop' | 'holes' | 'box'
  /** Palette index painted in for `holes` and `box`. */
  holeColour: number
}

export const DEFAULTS: ConvertOptions = {
  width: 48,
  tolerance: 46,
  centre: true,
  backdrop: 'drop',
  holeColour: 5,
}

const palRgb = PALETTE.map((hex, i) => i === 0 ? null : [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
] as [number, number, number])

/** Perceptually weighted squared distance — green dominates what we notice. */
function dist2(a: readonly number[], b: readonly number[]) {
  const dr = a[0]! - b[0]!, dg = a[1]! - b[1]!, db = a[2]! - b[2]!
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
}

const spread = (c: readonly number[]) =>
  Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!)
const NEUTRAL = 10

function nearest(c: readonly number[]) {
  let best = 1, bd = Infinity
  for (let i = 1; i < palRgb.length; i++) {
    const d = dist2(c, palRgb[i]!)
    if (d < bd) { bd = d; best = i }
  }
  return best
}

/** Decode once; the caller re-converts from this as options change. */
export async function decode(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file)
  // Cap the working copy: a 4000px photo gives no more detail at 64 cells wide
  // and makes every slider drag chew through megapixels.
  const max = 1024
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return g.getImageData(0, 0, w, h)
}

export function convert(img: ImageData, o: ConvertOptions): Converted {
  const { width: iw, height: ih, data } = img
  const outW = Math.max(1, Math.min(o.width, 400))
  const scale = iw / outW
  const outH = Math.max(1, Math.round(ih / scale))

  const at = (x: number, y: number): [number, number, number] => {
    const i = (Math.min(ih - 1, y) * iw + Math.min(iw - 1, x)) * 4
    return [data[i]!, data[i + 1]!, data[i + 2]!]
  }
  const alphaAt = (x: number, y: number) =>
    data[(Math.min(ih - 1, y) * iw + Math.min(iw - 1, x)) * 4 + 3]!

  // Walk the whole border, cluster, and keep only what is *common* there.
  //
  // Six corner samples missed the grid lines in a screenshot backdrop and every
  // missed line survived as a bright streak. Taking every distinct border
  // colour instead went too far the other way: artwork and chart rules that
  // happen to touch an edge became "background" and whole images converted to
  // nothing. Frequency is what separates a backdrop from a stray edge pixel.
  const clusters: { c: [number, number, number]; n: number }[] = []
  const sample = (c: [number, number, number]) => {
    const hit = clusters.find((k) => dist2(c, k.c) < 14 * 14)
    if (hit) hit.n++
    else clusters.push({ c, n: 1 })
  }
  const step = Math.max(1, Math.floor(Math.min(iw, ih) / 64))
  let seen = 0
  for (let x = 0; x < iw; x += step) { sample(at(x, 0)); sample(at(x, ih - 1)); seen += 2 }
  for (let y = 0; y < ih; y += step) { sample(at(0, y)); sample(at(iw - 1, y)); seen += 2 }

  const bg = clusters
    .filter((k) => k.n / seen >= 0.08)      // at least 8% of the border
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((k) => k.c)
  // A border with no dominant colour is probably artwork bleeding to the edge;
  // fall back to the corners rather than treating everything as background.
  if (!bg.length) bg.push(at(0, 0), at(iw - 1, ih - 1))
  // A real alpha channel beats guessing from corners.
  const hasAlpha = alphaAt(0, 0) < 250 || alphaAt(iw - 1, ih - 1) < 250

  const isBg = (c: readonly number[]) => bg.some((b) =>
    dist2(c, b) < o.tolerance * o.tolerance &&
    (spread(b) > NEUTRAL || spread(c) <= NEUTRAL))

  const px: [number, number, number][] = []
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
      const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))

      let r = 0, g = 0, b = 0, n = 0, bgHits = 0, total = 1
      if (o.centre) {
        const cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1
        const c = at(cx, cy)
        if ((hasAlpha && alphaAt(cx, cy) < 128) || isBg(c)) bgHits = 1
        else { r = c[0]; g = c[1]; b = c[2]; n = 1 }
      } else {
        for (let sy = y0; sy < y1 && sy < ih; sy++) {
          for (let sx = x0; sx < x1 && sx < iw; sx++) {
            const c = at(sx, sy)
            if ((hasAlpha && alphaAt(sx, sy) < 128) || isBg(c)) { bgHits++; continue }
            r += c[0]; g += c[1]; b += c[2]; n++
          }
        }
        total = (y1 - y0) * (x1 - x0)
      }
      if (!n || bgHits / total > 0.6) continue
      px.push([x, y, nearest([r / n, g / n, b / n])])
    }
  }

  despeckle(px, outW)
  if (o.backdrop === 'holes') fillEnclosed(px, outW, outH, o.holeColour)
  if (o.backdrop === 'box') fillBox(px, outW, o.holeColour)
  return { w: outW, h: outH, px }
}

/** A pixel whose neighbours all agree with each other but not with it is
 *  compression noise, not detail. */
function despeckle(px: [number, number, number][], w: number) {
  const grid = new Map<number, number>()
  for (const [x, y, c] of px) grid.set(y * w + x, c)
  for (const [key, c] of grid) {
    const x = key % w, y = (key - x) / w
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => grid.get((y + dy!) * w + (x + dx!)))
      .filter((v): v is number => v !== undefined)
    if (n.length < 3) continue
    const tally = new Map<number, number>()
    for (const v of n) tally.set(v, (tally.get(v) ?? 0) + 1)
    const [best, count] = [...tally].sort((a, b) => b[1] - a[1])[0]!
    if (best !== c && count === n.length) grid.set(key, best)
  }
  px.length = 0
  for (const [key, c] of grid) {
    const x = key % w
    px.push([x, (key - x) / w, c])
  }
}

/** Fill every gap inside the artwork's bounding box. Two-tone bead charts read
 *  as a solid silhouette otherwise — the white cells carry the drawing. */
function fillBox(px: [number, number, number][], w: number, colour: number) {
  if (!px.length) return
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const filled = new Set<number>()
  for (const [x, y] of px) {
    filled.add(y * w + x)
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!filled.has(y * w + x)) px.push([x, y, colour])
    }
  }
}

/** Only background reachable from the border is really background; anything
 *  walled in by artwork is a hole in the drawing and should stay opaque. */
function fillEnclosed(px: [number, number, number][], w: number, h: number, colour: number) {
  const filled = new Uint8Array(w * h)
  for (const [x, y] of px) filled[y * w + x] = 1
  const outside = new Uint8Array(w * h)
  const stack: [number, number][] = []
  for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1])
  for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y])
  while (stack.length) {
    const [x, y] = stack.pop()!
    if (x < 0 || y < 0 || x >= w || y >= h) continue
    const i = y * w + x
    if (outside[i] || filled[i]) continue
    outside[i] = 1
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!filled[i] && !outside[i]) px.push([x, y, colour])
    }
  }
}
