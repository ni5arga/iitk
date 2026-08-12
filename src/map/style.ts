import type { StyleSpecification } from 'maplibre-gl'
import type { Campus } from '../types'

/**
 * The whole basemap is drawn from our own GeoJSON — no tile server, no API key
 * and no external request. The campus is small enough that the entire extract
 * fits in a few hundred kB, so the map renders from one static fetch.
 *
 * Label glyphs are served from public/font too. Pointing them at a demo CDN
 * cost us every label on the map when that host 404'd the fontstack.
 */
const PALETTE = {
  dark: {
    bg: '#0b0d10',
    campus: '#10141a',
    green: '#121c15',
    water: '#0e2230',
    building: '#181d25',
    buildingEdge: '#232a35',
    named: '#1d2430',
    road: '#2a313d',
    roadCase: '#171b22',
    path: '#2e3743',
    steps: '#3a4250',
    wall: '#1c222b',
    boundary: '#28303c',
    label: '#9aa4b2',
    labelHalo: '#0b0d10',
    dotStroke: '#0b0d10',
    routeHalo: '#0b0d10',
    route: '#58a6ff',
    focus: '#61d47c',
    glow: '#ffcf6b',
    glowCore: '#fff3cf',
  },
  // Deliberately not a white map. The campus is a warm paper tone, buildings a
  // half-step darker, and roads the only near-white — so the built area reads
  // without any large field of pure white to stare into.
  light: {
    bg: '#dfe3e8',
    campus: '#f4f2ee',
    green: '#e2ebdc',
    water: '#cfe0ec',
    building: '#e6e3dd',
    buildingEdge: '#d3cfc7',
    named: '#ddd8cf',
    road: '#fdfdfc',
    roadCase: '#dcd8d1',
    path: '#fbfaf8',
    steps: '#b6b1a8',
    wall: '#e0dcd4',
    boundary: '#c2beb6',
    label: '#4a5058',
    labelHalo: '#f4f2ee',
    dotStroke: '#fdfdfc',
    routeHalo: '#fdfdfc',
    route: '#2b6cb8',
    focus: '#2a8a4d',
    glow: '#e0a11f',
    glowCore: '#8a6410',
  },
} as const

/** Must match a directory under public/font. */
export const FONT = 'Noto Sans Regular'

export function buildStyle(
  geo: Record<string, GeoJSON.FeatureCollection>,
  campus: Campus,
  theme: 'light' | 'dark' = 'dark',
  base = '/',
): StyleSpecification {
  const C = PALETTE[theme]

  const src = (data: GeoJSON.FeatureCollection) => ({ type: 'geojson' as const, data })

  return {
    version: 8,
    glyphs: `${base}font/{fontstack}/{range}.pbf`,
    sources: {
      boundary: src(geo.boundary!),
      green: src(geo.green!),
      water: src(geo.water!),
      waterway: src(geo.waterway!),
      wall: src(geo.wall!),
      roads: src(geo.roads!),
      paths: src(geo.paths!),
      buildings: src(geo.buildings!),
      pois: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

      { id: 'campus', type: 'fill', source: 'boundary', paint: { 'fill-color': C.campus } },

      { id: 'green', type: 'fill', source: 'green', paint: { 'fill-color': C.green } },
      { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': C.water } },
      {
        id: 'waterway', type: 'line', source: 'waterway',
        paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 18, 5] },
      },

      {
        id: 'campus-edge', type: 'line', source: 'boundary',
        paint: { 'line-color': C.boundary, 'line-width': 1.2, 'line-dasharray': [3, 2] },
      },
      {
        id: 'wall', type: 'line', source: 'wall',
        minzoom: 15,
        paint: { 'line-color': C.wall, 'line-width': 1 },
      },

      // Roads get a casing so junctions read cleanly at low zoom.
      {
        id: 'road-case', type: 'line', source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadCase,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 2, 16, 7, 19, 22],
        },
      },
      {
        id: 'road', type: 'line', source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1, 16, 4.5, 19, 16],
        },
      },
      // Two layers rather than one: `line-dasharray` rejects data expressions,
      // so steps cannot be dashed by a `case` on the feature.
      {
        id: 'path', type: 'line', source: 'paths',
        minzoom: 14,
        filter: ['!=', ['get', 'hw'], 'steps'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.path,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 0.6, 17, 2, 19, 5],
        },
      },
      {
        id: 'path-steps', type: 'line', source: 'paths',
        minzoom: 15,
        filter: ['==', ['get', 'hw'], 'steps'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': C.steps,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 15, 1.5, 19, 6],
          'line-dasharray': [1, 1],
        },
      },

      {
        id: 'building', type: 'fill', source: 'buildings',
        paint: {
          'fill-color': ['case', ['!=', ['get', 'name'], ''], C.named, C.building],
          'fill-outline-color': C.buildingEdge,
        },
      },
      {
        id: 'building-top', type: 'line', source: 'buildings',
        minzoom: 16,
        paint: { 'line-color': C.buildingEdge, 'line-width': 0.7 },
      },
      // Category tint for buildings that are themselves a POI.
      {
        id: 'building-cat', type: 'fill', source: 'buildings',
        filter: ['all', ['!=', ['get', 'cat'], ''], ['in', ['get', 'cat'], ['literal', []]]],
        paint: { 'fill-color': catColour(campus), 'fill-opacity': 0.16 },
      },

      {
        id: 'route-halo', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.routeHalo, 'line-width': 9, 'line-opacity': 0.9 },
      },
      {
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.route, 'line-width': 4 },
      },

      // Street lamps read as a pool of light on the ground rather than a pin.
      // Three stacked blurred circles: a wide falloff, a tighter halo, and a
      // small bright core. Drawn under everything else so it lights the map
      // instead of washing out the markers.
      {
        id: 'lamp-glow-far', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'cat'], 'light'],
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 14, 8, 17, 34, 19.5, 90],
          'circle-color': C.glow,
          'circle-blur': 1,
          'circle-opacity': theme === 'dark' ? 0.20 : 0.13,
          'circle-pitch-alignment': 'map',
        },
      },
      {
        id: 'lamp-glow-near', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'cat'], 'light'],
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 14, 3, 17, 14, 19.5, 38],
          'circle-color': C.glow,
          'circle-blur': 0.9,
          'circle-opacity': theme === 'dark' ? 0.32 : 0.18,
          'circle-pitch-alignment': 'map',
        },
      },
      {
        id: 'lamp-core', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'cat'], 'light'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 17, 2.4, 19.5, 4],
          'circle-color': C.glowCore,
          'circle-blur': 0.3,
          'circle-opacity': 0.95,
        },
      },
      {
        id: 'poi-dot', type: 'circle', source: 'pois',
        filter: ['!=', ['get', 'cat'], 'light'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 4.5, 19, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': C.dotStroke,
          'circle-stroke-width': 1.4,
          'circle-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.25, 1],
        },
      },
      {
        id: 'poi-label', type: 'symbol', source: 'pois',
        // The default view sits at z15.1, so a higher floor here meant the map
        // opened with no labels at all.
        minzoom: 14.5,
        filter: ['==', ['get', 'pin'], true],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': [FONT],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 19, 13.5],
          'text-offset': [0, 1.05],
          'text-anchor': 'top',
          'text-max-width': 8,
          'text-optional': true,
          'text-padding': 4,
          // Drop the least useful labels first when they collide.
          'symbol-sort-key': ['case', ['==', ['get', 'cat'], 'lecture'], 0,
                                      ['==', ['get', 'cat'], 'mess'], 1, 2],
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'poi-focus', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'focus'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 9, 19, 18],
          'circle-color': 'transparent',
          'circle-stroke-color': C.focus,
          'circle-stroke-width': 1.6,
        },
      },
    ],
  }
}

/** `match` expression mapping a category key to its colour. */
function catColour(campus: Campus): maplibregl.ExpressionSpecification {
  const pairs: (string | string[])[] = []
  for (const [k, v] of Object.entries(campus.categories)) pairs.push(k, v.color)
  return ['match', ['get', 'cat'], ...pairs, '#8b949e'] as unknown as maplibregl.ExpressionSpecification
}
