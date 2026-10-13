import { spawn } from 'node:child_process';
import electron from 'electron';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['.'],{stdio:'inherit',env,windowsHide:false});
child.on('error',error=>{console.error('无法启动 Electron：'+error.message);process.exitCode=1;});
child.on('exit',code=>process.exit(code??0));
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
