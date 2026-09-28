import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

// Baked in at build time so a loaded tab can state which build it is actually running.
// This is the frontend half of the "is my fix deployed?" problem: the backend can be
// asked directly, but a browser tab opened before a deploy keeps running the old
// bundle indefinitely and looks identical to a deploy that never landed.
function commitSha(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
    },
  },
})
