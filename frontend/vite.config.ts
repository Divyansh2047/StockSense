import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const API = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

/**
 * In development, serve the marketing page (repo-root index.html) at "/" so the
 * landing page and the app (under /app/) share one origin, exactly like production.
 */
function landingPage(): Plugin {
  const file = fileURLToPath(new URL('../index.html', import.meta.url));
  return {
    name: 'stocksense-landing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(readFileSync(file, 'utf8'));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: '/app/',
  plugins: [react(), landingPage()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  preview: {
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          data: ['@tanstack/react-query'],
          three: ['three'],
        },
      },
    },
  },
});
