import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { PIXELS_ENABLED } from './shared/pixels-flag'

/**
 * Vite stamps `crossorigin` on the emitted <script> and <link rel=stylesheet>.
 * Every asset here is same-origin, so it buys nothing — but it does make the
 * browser send an `Origin` header, and Cloudflare Pages answers that CORS
 * variant with the SPA fallback HTML instead of the file. The stylesheet then
 * gets refused for having a `text/html` MIME type and the whole site renders
 * unstyled, while curl (no Origin) sees a perfectly good text/css. Dropping the
 * attribute keeps the request simple and the response correct.
 */
function noCrossorigin(): Plugin {
  return {
    name: 'no-crossorigin-on-same-origin-assets',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=("|')[^"']*\2)?/g, '')
    },
  }
}

/**
 * Whether this build ships the pixel canvas. Flipping PIXELS_ENABLED off drops
 * the /pixels page, the link to it, and (in the Functions, which read the same
 * constant) the API — `PIXELS=1` still forces the page on for local work.
 */
const withPixels = PIXELS_ENABLED || process.env.PIXELS === '1'

/** Drop the homepage entry point when the canvas is not being shipped, so the
 *  button is absent from the markup rather than merely hidden with CSS. */
function pixelsGate(): Plugin {
  return {
    name: 'pixels-gate',
    enforce: 'post',
    transformIndexHtml(html) {
      if (withPixels) return html
      return html.replace(/\s*<a id="pixels-btn"[\s\S]*?<\/a>/, '')
    },
    // Emitted only while the canvas is down, so an existing /pixels link lands
    // on the map rather than a bare 404. Kept here rather than in public/ so
    // the rule cannot outlive the takedown it belongs to.
    generateBundle() {
      if (withPixels) return
      this.emitFile({
        type: 'asset',
        fileName: '_redirects',
        source: '# The pixel canvas is under development and off public view.\n' +
          '/pixels     /  302\n/pixels/*   /  302\n',
      })
    },
  }
}

/**
 * Inline the pixel page's own stylesheet into its HTML.
 *
 * Cloudflare has twice now cached an *opaque* variant of a hashed asset: the
 * response still arrives 200 with the right content-type, but the browser
 * treats it as cross-origin, so `cssRules` throws SecurityError and not one
 * declaration applies. The page then renders with the palette and dock
 * unstyled — present in the DOM, invisible on screen — and curl cannot
 * reproduce it because curl never asks for the poisoned variant. Purging fixes
 * it until the next time.
 *
 * This stylesheet is ~5 kB. Inlining costs a little repetition between the two
 * pages and removes the failure mode outright: there is no request left to
 * poison, and the page cannot paint before its own styles exist. The big
 * MapLibre stylesheet stays a normal link — it is 80 kB and shared with the map
 * page, where inlining it would cost more than it saves.
 */
function inlinePixelsCss(): Plugin {
  return {
    name: 'inline-pixels-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['pixels/index.html']
      if (!page || page.type !== 'asset') return
      page.source = String(page.source).replace(
        /<link rel="stylesheet"[^>]*href="\/assets\/(pixels-[^"]+\.css)"[^>]*>/g,
        (tag, file: string) => {
          const css = bundle[`assets/${file}`]
          if (!css || css.type !== 'asset') return tag
          delete bundle[`assets/${file}`]     // nothing else references it
          return `<style>${String(css.source).trim()}</style>`
        },
      )
    },
  }
}

export default defineConfig({
  plugins: [noCrossorigin(), pixelsGate(), inlinePixelsCss()],
  server: { port: 5180, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Its own entry point, so the map page does not carry the canvas code
        // and vice versa. Emits dist/pixels/index.html, served at /pixels.
        ...(withPixels ? { pixels: resolve(__dirname, 'pixels/index.html') } : {}),
      },
    },
  },
})
