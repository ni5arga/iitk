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

export default defineConfig({
  plugins: [noCrossorigin()],
  server: { port: 5180, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Its own entry point, so the map page does not carry the canvas code
        // and vice versa. Emits dist/pixels/index.html, served at /pixels.
        pixels: resolve(__dirname, 'pixels/index.html'),
      },
    },
  },
})
