import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const ratoeiraBase = process.env.RATOEIRA_BASE
  ? `${process.env.RATOEIRA_BASE.replace(/\/$/, '')}/`
  : './'

// https://vite.dev/config/
export default defineConfig({
  base: ratoeiraBase,
  plugins: [
    react(),
    tailwindcss()
  ],
})
