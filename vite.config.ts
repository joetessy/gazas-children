import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
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
