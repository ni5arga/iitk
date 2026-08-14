/**
 * The pixel grid laid over campus.
 *
 * One fixed grid, anchored to the campus bounding box, so a pixel means the
 * same square of ground for everyone regardless of zoom or device. Coordinates
 * are integer (x, y) from the north-west corner.
 *
 * Shared verbatim by three places — the seed generator, the browser and the
 * Pages Functions — so the maths can never drift between them.
 */

/** North-west anchor of the grid. Matches the Overpass bbox in fetch-osm.mjs. */
export const ORIGIN = { lat: 26.5265, lon: 80.2180 } as const
export const SOUTH_EAST = { lat: 26.4995, lon: 80.2480 } as const

/** Metres per pixel. 2 m reads as chunky pixel art at building scale. */
export const PIXEL_M = 2

const M_PER_DEG_LAT = 111_320
/** Campus sits at ~26.5°N; cos(26.5°) ≈ 0.8949. */
const M_PER_DEG_LON = 111_320 * Math.cos((26.51 * Math.PI) / 180)

export const GRID_W = Math.ceil(((SOUTH_EAST.lon - ORIGIN.lon) * M_PER_DEG_LON) / PIXEL_M)
export const GRID_H = Math.ceil(((ORIGIN.lat - SOUTH_EAST.lat) * M_PER_DEG_LAT) / PIXEL_M)

/** Chunk size in pixels. Storage and fetches are per chunk, never per pixel. */
export const CHUNK = 128
export const CHUNKS_X = Math.ceil(GRID_W / CHUNK)
export const CHUNKS_Y = Math.ceil(GRID_H / CHUNK)

export function lonLatToPixel(lon: number, lat: number): { x: number; y: number } {
  return {
    x: Math.floor(((lon - ORIGIN.lon) * M_PER_DEG_LON) / PIXEL_M),
    y: Math.floor(((ORIGIN.lat - lat) * M_PER_DEG_LAT) / PIXEL_M),
  }
}

/** North-west corner of a pixel, in lon/lat. */
export function pixelToLonLat(x: number, y: number): [number, number] {
  return [
    ORIGIN.lon + (x * PIXEL_M) / M_PER_DEG_LON,
    ORIGIN.lat - (y * PIXEL_M) / M_PER_DEG_LAT,
  ]
}

export const inBounds = (x: number, y: number) =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_W && y < GRID_H

export const chunkOf = (x: number, y: number) =>
  ({ cx: Math.floor(x / CHUNK), cy: Math.floor(y / CHUNK) })

export const chunkKey = (cx: number, cy: number) => `c:${cx}:${cy}`

/**
 * Fixed 32-colour palette. Pixels store an index, so a pixel is one byte on
 * the wire and nobody can inject arbitrary colours. Index 0 is "erase".
 */
export const PALETTE: readonly string[] = [
  'transparent',
  '#000000', '#3c3c3c', '#787878', '#d2d2d2', '#ffffff',
  '#600018', '#a50e1e', '#ed1c24', '#fa8072',
  '#e45c1a', '#ff7f27', '#f6aa09', '#f9dd3b', '#fffabc',
  '#0eb968', '#13e67b', '#87ff5e',
  '#0c816e', '#10aea6', '#60f7f2',
  '#28509e', '#4093e4', '#7dc7ff',
  '#4a4284', '#7a71c4', '#b5aef1',
  '#780c99', '#aa38b9', '#e09ff9',
  '#cb007a', '#ec1f80', '#f38da9',
] as const

export const TRANSPARENT = 0

export interface Pixel {
  x: number
  y: number
  /** Index into PALETTE. */
  c: number
}

/**
 * Chunks are stored as a flat "x,y,c" triple list rather than a dense array —
 * the canvas is overwhelmingly empty, so a sparse list is far smaller than
 * 128×128 bytes per chunk and survives JSON round-tripping unchanged.
 */
export function packChunk(pixels: Iterable<Pixel>): string {
  const out: number[] = []
  for (const p of pixels) out.push(p.x, p.y, p.c)
  return out.join(',')
}

export function unpackChunk(packed: string): Pixel[] {
  if (!packed) return []
  const n = packed.split(',')
  const out: Pixel[] = []
  for (let i = 0; i + 2 < n.length; i += 3) {
    out.push({ x: +n[i]!, y: +n[i + 1]!, c: +n[i + 2]! })
  }
  return out
}
