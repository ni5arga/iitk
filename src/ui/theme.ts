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

/**
 * Straight flip between light and dark.
 *
 * This used to cycle auto -> light -> dark -> auto, which meant that whenever
 * `auto` resolved to the theme you were already looking at, one press changed
 * nothing on screen and you had to press again. Following the system is still
 * the default until you touch this; after that it is your explicit choice.
 */
export function toggle(): Resolved {
  const next: Resolved = resolved() === 'dark' ? 'light' : 'dark'
  choice = next
  localStorage.setItem(KEY, next)
  apply()
  return next
}

export function onThemeChange(fn: (t: Resolved) => void) {
  listeners.add(fn)
}

media.addEventListener('change', () => { if (choice === 'auto') apply() })

// Applied before first paint by the inline script in index.html; this syncs
// the meta colour and notifies subscribers once the module loads.
apply()
