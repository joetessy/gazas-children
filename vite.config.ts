import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [tailwindcss(), cloudflare()],
  base: '/',
  server: {
    port: 5183,
    strictPort: true
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0
  }
})