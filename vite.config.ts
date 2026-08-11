import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5180, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
