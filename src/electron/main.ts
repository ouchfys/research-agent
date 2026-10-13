import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, extname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Upload } from '../shared/types';
import { acquireBrowserMedia } from './browser-media';
import { acquireBrowserPage } from './browser-page';
import { BrowserMediaError, browserArticlePlatform, sanitizeBrowserMediaDiagnostics } from '../shared/browser-media';

let window:BrowserWindow|null=null,service:UtilityProcess|null=null,dataDir='',closing=false,ready=false;
let serviceError='',uiConnected=false;
const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout}>();
const selectedFiles=new Map<string,{path:string;name:string;mimeType:string}>();
const browserRequests=new Map<string,AbortController>();
const browserMediaRequests=new Set<string>();
const root=app.getAppPath();
const devUrl=process.env.SHELF_DEV_URL;
const contentUrl=devUrl||pathToFileURL(join(root,'dist','renderer','index.html')).href;
function trusted(event:IpcMainInvokeEvent){if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url.split('#')[0]!==contentUrl)throw new Error('拒绝来自不受信任页面的应用操作。');}
function call(method:string,payload:unknown={}){return new Promise<unknown>((resolveRequest,reject)=>{
  if(!ready||!service){reject(new Error(serviceError||'本地服务尚未就绪，请稍后重试。'));return;}
  const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('本地服务响应超时，请重试或重启应用；已保存的数据会保留。'));},method==='storage.switch'?30*60*1000:45000);
  pending.set(id,{resolve:resolveRequest,reject,timer});service.postMessage({id,method,payload});
});}
function cancelBrowserRequests(){for(const controller of browserRequests.values())controller.abort();browserRequests.clear();browserMediaRequests.clear();}
async function acquireMediaForService(sender:UtilityProcess,message:{id?:string;url?:string;directory?:string;cookiesPath?:string}){
  const id=message.id;
  if(service!==sender||!id||browserRequests.has(id))return;
  const reply=(body:object)=>{if(service===sender&&ready&&!closing)sender.postMessage({kind:'browser-media-response',id,...body});};
  const article=typeof message.url==='string'&&browserArticlePlatform(message.url);
  if(browserRequests.size>=16||(!article&&browserMediaRequests.size)){reply({error:{code:'browser_busy',message:'[browser_busy] 浏览器获取队列已满，请稍后重试。',diagnostics:[]}});return;}
  const controller=new AbortController();browserRequests.set(id,controller);
  if(!article)browserMediaRequests.add(id);
  try{
    if(!ready||closing||typeof message.url!=='string'||typeof message.directory!=='string')throw new Error('invalid');
    const base=await realpath(dataDir),target=await realpath(message.directory),rel=relative(base,target);
    // The service creates this exact per-source directory first. A symlink to any other location is rejected.
    if(!/^raw[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rel)||(await stat(target)).isDirectory()===false)throw new Error('invalid');
    controller.signal.throwIfAborted();
    const acquire=article?acquireBrowserPage:acquireBrowserMedia;
    const result=await acquire({url:message.url,directory:target,cookiesPath:typeof message.cookiesPath==='string'?message.cookiesPath:undefined,signal:controller.signal,onProgress:message=>{
      if(service===sender&&ready&&!closing&&!controller.signal.aborted)sender.postMessage({kind:'browser-media-progress',id,message});
    }});
    controller.signal.throwIfAborted();reply({result:{...result,diagnostics:sanitizeBrowserMediaDiagnostics(result.diagnostics)}});
  }catch(error){
    const safe=error instanceof BrowserMediaError?{code:error.code,message:`[browser_${error.code}] ${error.message}`,diagnostics:sanitizeBrowserMediaDiagnostics(error.diagnostics)}:{code:controller.signal.aborted?'browser_cancelled':'browser_failed',message:controller.signal.aborted?'[browser_cancelled] 浏览器获取已取消。':'[browser_failed] 浏览器获取未完成，未返回可用内容。',diagnostics:[]};
    reply({error:safe});
  }finally{browserRequests.delete(id);browserMediaRequests.delete(id);}
}
async function launchService(){
  const configDir=app.isPackaged?app.getPath('userData'):join(root,'.local','config');
  const defaultData=app.isPackaged?join(app.getPath('userData'),'data'):join(root,'.local','data');
  return new Promise<void>((resolveReady,reject)=>{
    const deadline=setTimeout(()=>reject(new Error('本地服务启动超时。')),30000);
    service=utilityProcess.fork(join(root,'dist','electron','service.mjs'),[],{serviceName:'研究书架本地服务',stdio:'pipe',env:{...process.env,SHELF_CONFIG_DIR:configDir,SHELF_DEFAULT_DATA_DIR:defaultData,SHELF_PROJECT_DIR:root,SHELF_TOOLS_DIR:join(app.isPackaged?process.resourcesPath:root,'tools')}});
    const sender=service;
    service.on('message',(message:{kind:string;id?:string;result?:unknown;error?:string;dataDir?:string;event?:unknown;url?:string;directory?:string;cookiesPath?:string})=>{
      if(message.kind==='browser-media-request'){void acquireMediaForService(sender,message);return;}
      if(message.kind==='browser-media-cancel'){if(message.id)browserRequests.get(message.id)?.abort();return;}
      if(message.kind==='ready'){clearTimeout(deadline);ready=true;dataDir=message.dataDir||defaultData;console.log('SHELF_SERVICE_READY');resolveReady();}
      if(message.kind==='fatal'){clearTimeout(deadline);serviceError=message.error||'服务启动失败';reject(new Error(serviceError));}
      if(message.kind==='event'){
        const event=message.event as {type?:string;data?:{dataDir?:unknown}}|undefined;
        if(event?.type==='storage.changed'&&typeof event.data?.dataDir==='string')dataDir=event.data.dataDir;
        window?.webContents.send('shelf:event',message.event);
      }
      if(message.kind==='response'&&message.id){const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.result);}
    });
    service.on('exit',code=>{cancelBrowserRequests();ready=false;clearTimeout(deadline);serviceError=`本地服务已退出（${code}）。请重启应用以恢复任务。`;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(serviceError));}pending.clear();if(!closing)window?.webContents.send('shelf:event',{type:'service.error',data:serviceError});reject(new Error(serviceError));});
    // The service never logs provider request bodies or credentials.
    service.stderr?.on('data',chunk=>{const line=String(chunk);if(line.includes('ExperimentalWarning'))return;console.error(line.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]'));});
  });
}
function registerIPC(){
  ipcMain.handle('shelf:call',async(event,method:unknown,payload:unknown)=>{
    trusted(event);if(typeof method!=='string'||method.length>80)throw new Error('无效操作。');
    if((method==='task.start'||method==='task.message')&&payload&&typeof payload==='object'){
      const input=payload as Record<string,unknown>;
      if(Array.isArray(input.uploads))payload={...input,uploads:input.uploads.map((upload:Upload)=>{
        if(!upload||typeof upload!=='object')throw new Error('无效附件。');
        if('localPath' in upload)throw new Error('本地附件必须由文件选择器授权。');
        if(!upload.localToken)return upload;
        const selected=selectedFiles.get(upload.localToken);
        if(!selected)throw new Error('所选文件已失效，请重新选择附件。');
        return {name:selected.name,mimeType:selected.mimeType,data:'',localPath:selected.path};
      })};
    }
    const result=await call(method,payload);if(method==='snapshot'&&!uiConnected){uiConnected=true;console.log('SHELF_UI_CONNECTED');}return result;
  });
  ipcMain.handle('shelf:choose-files',async event=>{
    trusted(event);const selection=await dialog.showOpenDialog(window!,{title:'导入视频、音频、字幕或研究材料',properties:['openFile','multiSelections'],filters:[{name:'研究材料',extensions:['png','jpg','jpeg','webp','gif','pdf','md','txt','srt','vtt','ass','ssa','ttml','json','mp3','wav','m4a','ogg','flac','aac','mp4','webm','mov','mkv']}]});
    if(selection.canceled)return [];if(selection.filePaths.length>12)throw new Error('每次最多选择 12 个文件。');
    const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.flac':'audio/flac','.aac':'audio/aac','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska'};
    const result:Upload[]=[];for(const file of selection.filePaths){
      const resolved=await realpath(file),info=await stat(resolved),mimeType=mime[extname(file).toLowerCase()]||'text/plain';
      const media=/^(audio|video)\//.test(mimeType),limit=(media?512:32)*1024*1024;
      if(!info.isFile()||!info.size||info.size>limit)throw new Error(media?'音视频文件需要为 512 MB 以内的非空文件。':'普通材料文件需要为 32 MB 以内的非空文件。');
      const localToken=randomUUID(),name=file.split(/[\\/]/).pop()!;
      selectedFiles.set(localToken,{path:resolved,name,mimeType});
      result.push({name,mimeType,data:'',localToken});
    }return result;
  });
  ipcMain.handle('shelf:choose-directory',async event=>{trusted(event);const r=await dialog.showOpenDialog(window!,{title:'选择知识库位置：迁移请选择空文件夹，打开请选择已有知识库',properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('shelf:import-env',async event=>{trusted(event);const selection=await dialog.showOpenDialog(window!,{title:'导入 .env 服务配置（密钥仅保存在本机）',properties:['openFile'],filters:[{name:'环境配置或其他配置文件',extensions:['env','txt','*']}]});return selection.canceled?null:call('settings.import-env',{filePath:selection.filePaths[0]});});
  ipcMain.handle('shelf:open-path',async(event,value:unknown)=>{trusted(event);if(typeof value!=='string')throw new Error('无效路径。');const resolved=await call('storage.resolve-path',{path:resolve(value)});if(typeof resolved!=='string')throw new Error('无效路径。');const target=await realpath(resolved),base=await realpath(dataDir),rel=relative(base,target);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('只允许打开当前知识库目录内的文件。');const info=await stat(target);if(!info.isDirectory()&&!['.pdf','.txt','.md','.png','.jpg','.jpeg','.gif','.webp','.srt','.vtt','.mp3','.wav','.m4a','.mp4','.webm','.json'].includes(extname(target).toLowerCase())){shell.showItemInFolder(target);return;}const error=await shell.openPath(target);if(error)throw new Error(error);});
  ipcMain.handle('shelf:open-external',async(event,value:unknown)=>{trusted(event);if(typeof value!=='string')throw new Error('无效链接。');const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('只允许 HTTP(S) 来源链接。');await shell.openExternal(url.href);});
}
async function createWindow(){
  window=new BrowserWindow({title:'研究书架',width:1480,height:940,minWidth:760,minHeight:560,backgroundColor:'#f5f6f8',show:false,webPreferences:{preload:join(root,'dist','electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('render-process-gone',(_event,details)=>{serviceError=`界面进程已退出（${details.reason}），已保存的数据仍保留。`;dialog.showErrorBox('研究书架界面退出',serviceError);});
  window.webContents.on('preload-error',()=>{console.error('SHELF_PRELOAD_FAILED');});
  window.webContents.on('will-navigate',(event,url)=>{if(url!==contentUrl)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.on('closed',()=>{window=null;cancelBrowserRequests();});
  window.once('ready-to-show',()=>{window?.show();console.log('SHELF_WINDOW_READY');});
  await window.loadURL(contentUrl);
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(async()=>{
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'研究书架',submenu:[{role:'reload',label:'刷新窗口'},{role:'togglefullscreen',label:'全屏'},{type:'separator'},{role:'quit',label:'退出'}]},{label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},{label:'视图',submenu:[{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'resetZoom',label:'实际大小'},...(!app.isPackaged?[{role:'toggleDevTools' as const,label:'开发者工具'}]:[])]}]));
    registerIPC();try{await launchService();await createWindow();}catch(error){dialog.showErrorBox('研究书架启动失败',error instanceof Error?error.message:'未知启动错误');app.quit();}
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(service&&!closing){event.preventDefault();closing=true;cancelBrowserRequests();service.postMessage({kind:'shutdown'});service.once('exit',()=>app.quit());setTimeout(()=>{service?.kill();app.quit();},5000).unref();}});
}
