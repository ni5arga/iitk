import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'

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
 * The pixel canvas is unfinished and off public view — painting threw a
 * ReferenceError on every request (Cloudflare 1101), so the board silently
 * stayed empty for everyone. Shipping it is opt-in rather than opt-out: a plain
 * `npm run build`, which is what Cloudflare Pages runs, emits no /pixels/ page
 * and no link to it. Work on it with `PIXELS=1 npm run dev` (or `:build`).
 */
const withPixels = process.env.PIXELS === '1'

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
  }
}

export default defineConfig({
  plugins: [noCrossorigin(), pixelsGate()],
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
