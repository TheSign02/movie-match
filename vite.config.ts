import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind to the LAN so a phone on the same wifi can hit the dev
    // server. Two-device testing starts in phase 4 and there is no
    // point discovering this then.
    host: true,
  },
})
