import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
await import('./build.mjs');
const server=await createServer({server:{host:'127.0.0.1',port:5173,strictPort:true}});await server.listen();
const env={...process.env,SHELF_DEV_URL:'http://127.0.0.1:5173/'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['.'],{stdio:'inherit',env,windowsHide:false});
child.on('exit',async code=>{await server.close();process.exit(code??0);});
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
