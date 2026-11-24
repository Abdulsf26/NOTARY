import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // bind 0.0.0.0 so hosted previews can reach it
    port: 5173,
    allowedHosts: true,  // accept the sandbox preview host header
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
})
