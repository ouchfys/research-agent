import { ShelfService } from './service';
import { createBrowserMediaClient } from './browser-media-client';

type ParentPort={on(event:'message',handler:(event:{data:unknown})=>void):void;postMessage(message:unknown):void};
const parent=(process as typeof process & {parentPort?:ParentPort}).parentPort;
if(!parent)throw new Error('本地服务必须由 Electron 启动。');
const browserMedia=createBrowserMediaClient(parent);
let service:ShelfService;
try{
  service=new ShelfService(process.env.SHELF_CONFIG_DIR!,process.env.SHELF_DEFAULT_DATA_DIR!,event=>parent.postMessage({kind:'event',event}),browserMedia.read);
  parent.postMessage({kind:'ready',dataDir:service.store.dataDir});
}catch(error){parent.postMessage({kind:'fatal',error:error instanceof Error?error.message:'本地服务初始化失败'});process.exit(1);}
parent.on('message',event=>{
  const message=event.data as {id?:string;method?:string;payload?:unknown;kind?:string};
  if(message.kind==='shutdown'){browserMedia.close();void service.close().then(()=>process.exit(0));return;}
  if(!message.id||typeof message.method!=='string')return;
  void service.call(message.method,message.payload).then(result=>parent.postMessage({kind:'response',id:message.id,result}),error=>parent.postMessage({kind:'response',id:message.id,error:service.config.redact(error)}));
});
