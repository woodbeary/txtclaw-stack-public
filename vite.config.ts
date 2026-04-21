import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/_admin/',
  plugins: [
    react(),
    cloudflare({
      configPath: './wrangler.jsonc',
      persistState: false,
    }),
  ],
})
