// https://vite.dev/config/
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: "/Peer2Peer/",
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});