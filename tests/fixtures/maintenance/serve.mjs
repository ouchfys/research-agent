import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createServer({ configFile: false, root: projectRoot, plugins: [react()], server: { host: '127.0.0.1', port: 5184, strictPort: true } });
await server.listen();
console.log('Isolated maintenance fixture: http://127.0.0.1:5184/tests/fixtures/maintenance/index.html');
