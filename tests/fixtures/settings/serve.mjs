import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createServer({ configFile: false, root: projectRoot, plugins: [react()], server: { host: '127.0.0.1', port: 5185, strictPort: true } });
await server.listen();
console.log('Isolated settings fixture: http://127.0.0.1:5185/tests/fixtures/settings/index.html');
