export interface Poi {
  id: string
  name: string
  cat: string
  lat: number
  lon: number
  src: 'osm' | 'seed'
  osm?: string
  kind?: string
  unnamed?: true
  alt?: string
  hours?: string
  wheelchair?: string
  phone?: string
  url?: string
  cuisine?: string
  capacity?: string
  covered?: string
  operator?: string
  desc?: string
  level?: string
  potable?: string
  near?: string
  price?: string
}

export interface Category {
  label: string
  color: string
  pin: boolean
}

export interface Faculty {
  name: string
  title: string
  dept: string
  url: string
  email?: string
  phone?: string
  web?: string
  office?: string
  research?: string
  qualification?: string
  /** Name of the OSM feature this person was placed at, if resolved. */
  at?: string
  atVia?: 'office' | 'dept'
}

export interface MessMenu {
  hall: string
  day: string
  meal: string
  menu: string
  extras?: string
  updated?: string
}

export interface MessHall {
  name: string
  type: string
  tags: string[]
  at?: string
}

export interface Campus {
  meta: {
    name: string
    built: string
    center: [number, number]
    attribution: string
    counts: Record<string, number>
  }
  categories: Record<string, Category>
  pois: Poi[]
  places?: { items: Poi[] }
  faculty?: {
    _source: string
    _fetched: string
    _note: string
    _capped_departments: string[]
    _located?: number
    items: Faculty[]
  }
  mess?: {
    _source: string
    _fetched: string
    _note: string
    halls: MessHall[]
    items: MessMenu[]
  }
}

export interface Graph {
  lat: number[]
  lon: number[]
  /** [a, b, metres, footSeconds, bikeSeconds, flags] */
  edges: [number, number, number, number, number, number][]
}

export type Profile = 'foot' | 'bike'

export interface Route {
  coords: [number, number][]
  seconds: number
  metres: number
  steps: boolean
  indoor: boolean
  unpaved: boolean
}
