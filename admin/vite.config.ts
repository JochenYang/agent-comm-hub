import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { resolve } from 'node:path'

// Build a single self-contained admin.html for the hub to serve at /admin
// (src/mcp-server.ts reads assets/admin.html). Keep emptyOutDir false so the
// rest of assets/ (banner images, etc.) survives the build.
export default defineConfig({
  root: resolve(import.meta.dirname),
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, '../assets'),
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'index.html'),
    },
  },
})
