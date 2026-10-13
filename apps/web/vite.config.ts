import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.NEXUS_API_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The sandbox preview is served from an *.e2b.app host; allow it explicitly
    // instead of disabling the check. Override with NEXUS_WEB_ALLOWED_HOSTS.
    allowedHosts: (process.env.NEXUS_WEB_ALLOWED_HOSTS ?? '.e2b.app,localhost,127.0.0.1').split(',').map((h) => h.trim()),
    // The browser only ever talks to this origin; the dev server proxies to the API.
    // This keeps cookies first-party and means no secret or CORS surface in the client.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false, cookieDomainRewrite: '' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // three.js is the heavy dependency: keep it out of the main chunk so the
        // first paint does not wait for the WebGL orb on low-end devices.
        manualChunks: { 'vendor-three': ['three'] },
      },
    },
  },
});
