import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), { name: 'desktop-development-csp', transformIndexHtml(html, context) {
    if (!context.server) return html;
    return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173");
  } }],
  base: './',
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    watch: { ignored: ['**/.cache/**', '**/.local/**', '**/release/**', '**/tools/**'] },
  },
  build: { outDir: 'dist/renderer', emptyOutDir: true },
});
