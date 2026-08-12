export type Resolved = 'light' | 'dark'

const KEY = 'campusmap.theme'

/**
 * Dark is the product's default, not the system's. Most people open this at
 * night looking for a mess menu, and the map palette was designed dark first.
 * Anyone who prefers light picks it once and localStorage remembers, on this
 * browser, until they change it back.
 */
const DEFAULT: Resolved = 'dark'

let choice: Resolved = read()
const listeners = new Set<(t: Resolved) => void>()

function read(): Resolved {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // Private mode or storage disabled — fall through to the default.
  }
  return DEFAULT
}

export function resolved(): Resolved {
  return choice
}

function apply() {
  document.documentElement.setAttribute('data-theme', choice)
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', choice === 'light' ? '#e9ebef' : '#0b0d10')
  for (const fn of listeners) fn(choice)
}

/** Straight flip. One press, one visible change. */
export function toggle(): Resolved {
  choice = choice === 'dark' ? 'light' : 'dark'
  try { localStorage.setItem(KEY, choice) } catch { /* nothing we can do */ }
  apply()
  return choice
}

export function onThemeChange(fn: (t: Resolved) => void) {
  listeners.add(fn)
}

// The inline script in index.html sets the attribute before first paint; this
// syncs the meta colour and notifies subscribers once the module loads.
apply()
