import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist/electron',{recursive:true});
await build({entryPoints:['src/electron/main.ts'],outfile:'dist/electron/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:true});
await build({entryPoints:['src/electron/preload.ts'],outfile:'dist/electron/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:true});
await build({entryPoints:['src/server/index.ts'],outfile:'dist/electron/service.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',sourcemap:true});
console.log('Electron 主进程、预加载脚本和独立服务已构建。');
