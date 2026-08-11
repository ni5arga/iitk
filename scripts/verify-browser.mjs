// Loads the built site in a real headless Chrome, on a throwaway profile, and
// fails on any console error, page error or failed request. The unit tests
// cannot catch "the map never appeared"; this can.
//
//   npm run verify              # builds nothing, expects a server on :5180
//   npm run verify -- --url http://localhost:5199
//   npm run verify -- --shot    # also write screenshots to .verify/

import puppeteer from 'puppeteer-core'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > -1 ? process.argv[i + 1] : d
}
const URL_ = argOf('url', 'http://localhost:5180/')
const SHOTS = process.argv.includes('--shot')

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))

if (!CHROME) {
  console.error('No Chrome found — skipping browser verification.')
  process.exit(0)
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Throwaway profile so nothing touches the user's real Chrome.
const PROFILE = join(ROOT, 'node_modules/.cache/verify-profile')
await rm(PROFILE, { recursive: true, force: true })
if (SHOTS) await mkdir(join(ROOT, '.verify'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

async function check(name, width, height, theme) {
  console.log(`\n${name} (${width}x${height}${theme ? `, ${theme}` : ''})`)
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  if (theme) {
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem('campusmap.theme', t) } catch {}
    }, theme)
  }

  const errors = []
  const failed = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`)
  })

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 30_000 })

  // The boot overlay only clears once MapLibre fires `load`.
  const booted = await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'),
    { timeout: 20_000 },
  ).then(() => true).catch(() => false)

  const bootText = await page.$eval('#boot', (el) => el.textContent?.trim() ?? '')
  ok(booted, 'map finished loading', booted ? '' : `boot still says: "${bootText}"`)
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '))
  ok(failed.length === 0, 'no failed requests', failed.slice(0, 3).join(' | '))

  // The map must have actually painted something, not just fired `load`.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#map canvas')
    return c ? c.width > 0 && c.height > 0 : false
  })
  ok(painted, 'map canvas has dimensions')

  const dots = await page.evaluate(() => {
    const el = document.getElementById('layers')
    return el ? el.querySelectorAll('.chip').length : 0
  })
  ok(dots > 5, `layer chips rendered (${dots})`)

  ok(await page.$('#foot a') !== null, 'source link present in footer')

  // Labels are the thing a broken glyph URL silently kills.
  const labels = await page.evaluate(() => {
    const m = window.__map
    if (!m) return -1
    return m.queryRenderedFeatures({ layers: ['poi-label'] }).length
  })
  ok(labels > 0, `map labels rendering (${labels} visible)`,
     labels === 0 ? 'glyphs failed or minzoom too high' : '')

  // The dock must not overlap itself — chips and footer in one stack.
  const overlap = await page.evaluate(() => {
    const l = document.getElementById('layers')?.getBoundingClientRect()
    const f = document.getElementById('foot')?.getBoundingClientRect()
    if (!l || !f) return 'missing'
    return l.bottom > f.top + 1 ? `layers.bottom=${l.bottom.toFixed(0)} > foot.top=${f.top.toFixed(0)}` : ''
  })
  ok(overlap === '', 'layer chips do not overlap the footer', overlap)

  // Open the palette and run a query the way a user would.
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
  const paletteOpen = await page.waitForFunction(
    () => document.getElementById('palette') && !document.getElementById('palette').hidden,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  ok(paletteOpen, 'palette opens on ⌘K')

  if (paletteOpen) {
    await page.type('#palette-input', 'mess dinner', { delay: 12 })
    await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
      { timeout: 4000 }).catch(() => {})
    const rows = await page.$$eval('#palette-results .row .row-title', (r) => r.map((x) => x.textContent))
    ok(rows.length > 0, `"mess dinner" returns results (${rows.length})`, rows[0] ?? '')

    // Result text must stay inside the palette box.
    const spill = await page.evaluate(() => {
      const box = document.getElementById('palette-box').getBoundingClientRect()
      return [...document.querySelectorAll('#palette-results .row-title, #palette-results .row-sub')]
        .filter((el) => el.getBoundingClientRect().right > box.right + 1).length
    })
    ok(spill === 0, 'palette rows stay inside the box', spill ? `${spill} overflowing` : '')

    if (SHOTS) await page.screenshot({ path: join(ROOT, `.verify/${name}-palette.png`) })

    await page.keyboard.press('Enter')
    const panelUp = await page.waitForFunction(
      () => document.getElementById('panel') && !document.getElementById('panel').hidden,
      { timeout: 4000 },
    ).then(() => true).catch(() => false)
    ok(panelUp, 'selecting a result opens the panel')

    const hasMenu = await page.evaluate(() =>
      document.querySelectorAll('#panel .meal').length > 0)
    ok(hasMenu, 'mess panel shows the menu')
  }

  if (SHOTS) {
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(ROOT, `.verify/${name}.png`) })
  }

  // Late errors (style reload, tile decode) show up after interaction.
  ok(errors.length === 0, 'still no console errors after interaction', errors.slice(0, 3).join(' | '))
  await page.close()
}

await check('desktop-dark', 1440, 900, 'dark')
await check('desktop-light', 1440, 900, 'light')
await check('mobile-dark', 390, 844, 'dark')

await browser.close()
await rm(PROFILE, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nbrowser verification passed\n')
process.exit(failures ? 1 : 0)
