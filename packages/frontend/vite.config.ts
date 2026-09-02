import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Backend scripts already load the repository-root .env through dotenv-cli.
  // Use the same file for VITE_* values so Clerk/dev-bypass settings cannot
  // silently diverge between workspaces.
  envDir: '../../',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
