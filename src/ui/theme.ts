export type ThemeChoice = 'auto' | 'light' | 'dark'
export type Resolved = 'light' | 'dark'

const KEY = 'campusmap.theme'
const media = window.matchMedia('(prefers-color-scheme: light)')

let choice: ThemeChoice = read()
const listeners = new Set<(t: Resolved) => void>()

function read(): ThemeChoice {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

export function resolved(): Resolved {
  if (choice === 'auto') return media.matches ? 'light' : 'dark'
  return choice
}

export function current(): ThemeChoice {
  return choice
}

function apply() {
  const r = resolved()
  // `auto` leaves the attribute off so the media query in CSS decides.
  if (choice === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', r === 'light' ? '#f2f4f7' : '#0b0d10')
  for (const fn of listeners) fn(r)
}

/** auto -> light -> dark -> auto */
export function cycle(): ThemeChoice {
  choice = choice === 'auto' ? 'light' : choice === 'light' ? 'dark' : 'auto'
  if (choice === 'auto') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, choice)
  apply()
  return choice
}

export function onThemeChange(fn: (t: Resolved) => void) {
  listeners.add(fn)
}

media.addEventListener('change', () => { if (choice === 'auto') apply() })

// Applied before first paint by the inline script in index.html; this syncs
// the meta colour and notifies subscribers once the module loads.
apply()
