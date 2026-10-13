import { z } from 'zod';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Config } from './config';
import { Store } from './store';
import { SourceService } from './sources';
import { ResearchAgent, type Emit } from './agent';
import { inspectStorage, prepareStorage, relocatedPath, selectStorage } from './storage-location';
import type { Category, SettingsPatch } from '../shared/types';
import { taskDetail } from './task-detail';
import { maintenancePrompt } from './agent-maintenance';
import { withUsage } from './usage';
import type { BrowserMediaReader } from './browser-media-client';

const id=z.string().min(1).max(200);
const ids=z.array(id).max(100);
const upload=z.object({name:z.string().min(1).max(400),mimeType:z.string().max(200),data:z.string().max(70_000_000),localPath:z.string().min(1).max(4000).optional()});
const uploads=z.array(upload).max(12).default([]);
const text=z.string().max(1_000_000);
const documentInput=z.object({id:id.optional(),categoryId:id,title:z.string().min(1).max(500),description:z.string().min(1).max(1600),aliases:z.array(z.string()).default([]),paperIds:z.array(z.string()).default([]),body:z.string().min(1).max(5_000_000),sources:z.array(z.object({id,title:z.string(),url:z.string().optional(),kind:z.string(),coverage:z.string(),accessedAt:z.string()})).optional(),expectedVersion:z.number().int().min(0)});

export class ShelfService {
  readonly config:Config;
  store:Store;
  private agent:ResearchAgent;
  private sources:SourceService;
  private calls=0;
  private switching?:Promise<unknown>;
  private runs=new Set<Promise<void>>();
  constructor(configDir:string,defaultDataDir:string,private emit:Emit,private browserMedia?:BrowserMediaReader){
    this.config=new Config(configDir,defaultDataDir);this.store=new Store(this.config.activeDataDir);
    this.sources=new SourceService(this.store.dataDir,()=>this.config.get(),this.browserMedia);this.agent=new ResearchAgent(this.store,this.config,this.sources,emit);
  }
  private dispatch(taskId:string,content:string,files:z.infer<typeof uploads>=[],ingest=true){
    if(this.agent.busy())throw new Error('已有研究正在运行，请暂停后再继续其他任务。');
    const latestUser=this.store.messages(taskId).filter(message=>message.role==='user').at(-1);
    const stored=this.store.turns(taskId).find(turn=>turn.userMessageId===latestUser?.id);
    // Recover an old prompt only if it already has actual research activity.
    const hasHistory=this.store.events(taskId).some(event=>event.createdAt>=(latestUser?.createdAt||''));
    const seed=stored||(hasHistory?taskDetail(this.store,taskId).turns.find(turn=>turn.userMessageId===latestUser?.id):undefined);
    const turn=this.store.beginTurn(taskId,seed);
    const run=withUsage(record=>{this.store.recordUsage(taskId,turn.id,record);this.emit({type:'changed',taskId});},()=>this.agent.start(taskId,content,files,ingest)).catch(error=>{
      this.store.updateTask(taskId,{status:'failed',error:this.config.redact(error)});this.emit({type:'changed',taskId});
    }).finally(()=>{this.store.finishTurn(taskId);this.emit({type:'changed',taskId});});
    this.runs.add(run);void run.finally(()=>this.runs.delete(run)).catch(()=>{});
    return this.store.task(taskId);
  }
  private selected(values:string[]){for(const value of values)this.store.document(value);return [...new Set(values)];}
  private extractExplicitReferences(message:string,selected:string[]){
    const found=[...message.matchAll(/(?:library[\\/])?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.md)?/gi)].map(m=>m[1]);
    const result=[...selected];for(const value of found){try{this.store.document(value);result.push(value);}catch{/* A quoted unknown ID does not grant access. */}}
    return [...new Set(result)];
  }
  async call(method:string,payload:unknown={}):Promise<unknown>{
    if(this.switching)throw new Error('正在切换知识库位置，请等待完成后继续。');
    if(method==='storage.switch'){
      const p=z.object({dataDir:z.string().trim().min(1).max(4096),mode:z.enum(['move','open'])}).parse(payload);
      const operation=this.switchStorage(p.dataDir,p.mode);this.switching=operation;
      try{return await operation;}finally{this.switching=undefined;}
    }
    this.calls++;
    try{return await this.dispatchCall(method,payload);}finally{this.calls--;}
  }
  private async dispatchCall(method:string,payload:unknown):Promise<unknown>{
    switch(method){
      case 'snapshot':return {categories:this.store.categories(),tasks:this.store.tasks(),conflicts:this.store.conflicts(),settings:this.config.public(),recovered:this.store.recovered};
      case 'documents':{const p=z.object({categoryId:id}).parse(payload);return this.store.documents(p.categoryId);}
      case 'library.documents':return this.store.libraryDocuments();
      case 'maintenance.get':{
        this.maintenanceScope(payload);
        return this.store.maintenanceState();
      }
      case 'maintenance.start':{
        this.maintenanceScope(payload);
        this.store.assertAllowed('task.create');
        const state=this.store.maintenanceState();
        if(this.agent.busy())throw new Error('已有研究或维护正在运行，请先暂停或等待完成。');
        if(!state.pendingCount&&(!state.run||state.run.completedAt))return state;
        const run=this.store.startMaintenance();
        if(!this.store.messages(run.taskId).some(message=>message.role==='user'))this.store.addMessage(run.taskId,'user','逐篇整理尚未维护的 Markdown：根据目录说明先看当前文档所属目录的概览，再读当前正文，只展开有具体比较线索的候选。完成本篇合并、分歧裁决或无需处理结论后再进入下一篇，不预先读完整个待办队列。合并生成新标题、概览和正文，原稿归档保留；真实分歧由我裁决，不生成泛关联。');
        this.dispatch(run.taskId,maintenancePrompt(run),[],false);
        return this.store.maintenanceState();
      }
      case 'maintenance.pause':{
        const run=this.maintenanceScope(payload,true);
        if(run!.completedAt)return this.store.maintenanceState();
        this.store.assertAllowed('task.pause',run!.taskId);
        await this.agent.pause(run!.taskId);
        return this.store.maintenanceState();
      }
      case 'maintenance.resume':{
        const run=this.maintenanceScope(payload,true);
        this.store.assertAllowed('task.resume',run!.taskId);
        if(run!.completedAt)throw new Error('本批维护已经完成，请使用维护书架检查下一批新增文档。');
        this.dispatch(run!.taskId,maintenancePrompt(run!),[],false);
        return this.store.maintenanceState();
      }
      case 'document':{const p=z.object({id}).parse(payload);return this.store.document(p.id);}
      case 'category.save':{this.store.assertAllowed('category.save');if(this.agent.busy())throw new Error('请先暂停研究后修改书架目录。');const p=z.object({category:z.object({id:id.optional(),parentId:id.nullable().optional(),name:z.string().trim().min(1).max(120),description:z.string().max(2000).optional(),includes:z.string().max(4000).optional(),excludes:z.string().max(4000).optional(),scopeConfirmed:z.boolean().optional()})}).parse(payload);const result=this.store.saveCategory(p.category as Partial<Category>&{name:string});this.emit({type:'changed'});return result;}
      case 'document.save':{this.store.assertAllowed('manual.save');const p=z.object({document:documentInput}).parse(payload);const result=this.store.saveManual(p.document);this.emit({type:'changed'});return result;}
      case 'document.move':{this.store.assertAllowed('document.move');if(this.agent.busy())throw new Error('请先暂停研究后移动文档。');const p=z.object({id,categoryId:id,expectedVersion:z.number().int().positive()}).parse(payload);const result=this.store.moveDocument(p.id,p.categoryId,p.expectedVersion);this.emit({type:'changed'});return result;}
      case 'versions':{const p=z.object({id}).parse(payload);return this.store.versions(p.id);}
      case 'rollback':{this.store.assertAllowed('manual.save');const p=z.object({id,version:z.number().int().positive(),expectedVersion:z.number().int().nonnegative()}).parse(payload);const result=this.store.rollback(p.id,p.version,p.expectedVersion);this.emit({type:'changed'});return result;}
      case 'drafts':return this.store.drafts();
      case 'raw':{const p=z.object({id}).parse(payload);return this.store.raw(p.id);}
      case 'asset.image':{
        const p=z.object({path:z.string().min(1).max(4096)}).parse(payload);
        if(/^\w+:\/\//.test(p.path))throw new Error('本地图片需要知识库内的文件路径。');
        const candidate=isAbsolute(p.path)?relocatedPath(this.store.dataDir,p.path):resolve(join(this.store.dataDir,'library'),p.path);
        const base=await realpath(this.store.dataDir),target=await realpath(candidate),rel=relative(base,target);
        if(rel.startsWith('..')||isAbsolute(rel))throw new Error('图片不在当前知识库内。');
        const info=await stat(target);if(!info.isFile()||info.size>12*1024*1024)throw new Error('图片文件不可读取或超过 12 MB。');
        const bytes=await readFile(target);
        const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
        if(!mime)throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 本地图片。');
        return {dataUrl:`data:${mime};base64,${bytes.toString('base64')}`};
      }
      case 'tasks':return this.store.tasks();
      case 'task':{const p=z.object({id}).parse(payload);return taskDetail(this.store,p.id);}
      case 'history.clear':{
        if(this.agent.busy()||this.runs.size)throw new Error('请先暂停或等待任务结束后清理对话记录。');
        const p=z.object({taskIds:ids.optional()}).parse(payload);
        const result=this.store.clearHistory(p.taskIds);this.emit({type:'changed'});return result;
      }
      case 'task.start':{
        this.store.assertAllowed('task.create');if(this.agent.busy())throw new Error('已有研究正在运行，请先暂停或等待完成。');
        const p=z.object({kind:z.enum(['research','ingestion']).default('research'),text,selectedDocIds:ids.default([]),uploads}).parse(payload);
        if(!p.text.trim()&&!p.uploads.length)throw new Error('请输入研究问题或添加材料。');
        const selected=this.extractExplicitReferences(p.text,this.selected(p.selectedDocIds));
        const task=this.store.createTask(p.text.trim().slice(0,60)||p.uploads[0]?.name||(p.kind==='ingestion'?'新批资料':'新的研究'),selected,'collection',p.kind);
        this.store.addMessage(task.id,'user',p.text+(p.uploads.length?'\n\n附件：'+p.uploads.map(f=>f.name).join('、'):''));
        return this.dispatch(task.id,p.text,p.uploads);
      }
      case 'task.retryInputs':{
        const p=z.object({taskId:id,inputIds:ids.optional()}).parse(payload);
        if(this.agent.busy()||this.runs.size)throw new Error('请先暂停或等待当前任务结束，再重试材料。');
        const selected=this.store.prepareInputRetry(p.taskId,p.inputIds);
        this.store.addMessage(p.taskId,'user',`重试本批 ${selected.length} 项未完成材料。`);
        const prompt=`本次为资料入库的独立重试，不加载先前对话。只处理以下输入 ID：${selected.map(input=>input.id).join('、')}。不可重复处理本批已完成或本次未选择的输入。程序会先重新获取不可读来源；已有正文的材料直接读取并研究，避免重复识别成本。检查保存的材料和未发布草稿，必要时核实相关论文和仓库，然后入库并登记每项输入去向。获取仍失败时说明具体原因，禁止凭标题编造。`;
        return this.dispatch(p.taskId,prompt,[],false);
      }
      case 'task.context':{
        this.store.assertAllowed('task.context');const p=z.object({taskId:id,selectedDocIds:ids}).parse(payload);
        if(this.store.maintenanceRun(p.taskId))throw new Error('维护待办批次已经固定；比较候选可沿目录按需扫描，额外输入请在普通研究对话中整理。');
        if(this.agent.isRunning(p.taskId))throw new Error('请暂停当前研究后更改文档上下文。');
        this.store.updateTask(p.taskId,{selectedDocIds:this.selected(p.selectedDocIds)});this.emit({type:'changed',taskId:p.taskId});return this.store.task(p.taskId);
      }
      case 'task.message':{
        const p=z.object({taskId:id,text,uploads,selectedDocIds:ids.optional()}).parse(payload);
        this.store.assertAllowed('task.followup',p.taskId);if(this.agent.busy())throw new Error('请等待当前研究结束，或先暂停后发送补充。');
        if(!p.text.trim()&&!p.uploads.length)throw new Error('请输入问题或补充材料。');
        const conflicts=this.store.conflicts().filter(c=>c.taskId===p.taskId&&['suspected','confirmed'].includes(c.status));
        if(conflicts.length){
          const decision=/^\s*(?:我(?:决定|选择)?\s*)?(?:采纳|采用|选择)\s*([AB])\s*[。.!！]?\s*$/i.exec(p.text);
          if(decision&&conflicts.filter(c=>c.status==='confirmed').length===1){
            const conflict=conflicts.find(c=>c.status==='confirmed')!;
            await this.resolve(conflict.id,decision[1].toUpperCase() as 'A'|'B');
            return this.store.task(p.taskId);
          }
          if(p.uploads.length)throw new Error('冲突等待期间，请在 Other 里提供证据链接或说明；当前不接受新的文件导入。');
          this.store.addMessage(p.taskId,'user',p.text);
          return this.dispatch(p.taskId,'围绕当前冲突的可信人类追问（不是裁决）：\n'+p.text,[],false);
        }
        const maintenance=this.store.maintenanceRun(p.taskId);
        if(maintenance){
          if(maintenance.completedAt)throw new Error('本批维护已经完成，请使用维护书架检查下一批新增文档，或新建普通研究对话。');
          if(p.uploads.length)throw new Error('维护批次范围固定，新增材料请在普通研究对话中入库后留给下一批维护。');
          this.store.addMessage(p.taskId,'user',p.text);
          return this.dispatch(p.taskId,maintenancePrompt(maintenance)+'\n\n当前人类补充：\n'+p.text,[],false);
        }
        // A clarification answer continues the saved scope and scan. A fresh
        // question after a finished informational round may choose a new scope.
        if(this.store.task(p.taskId).status!=='waiting_user'){
          this.store.updateTask(p.taskId,{retryInputIds:undefined,retrySourceIds:undefined});
          this.store.beginResearchRound(p.taskId);
        }
        const selected=this.extractExplicitReferences(p.text,this.selected(p.selectedDocIds??this.store.task(p.taskId).selectedDocIds));
        this.store.updateTask(p.taskId,{selectedDocIds:selected});this.store.addMessage(p.taskId,'user',p.text+(p.uploads.length?'\n\n附件：'+p.uploads.map(f=>f.name).join('、'):''));
        return this.dispatch(p.taskId,p.text,p.uploads);
      }
      case 'task.resume':{
        const p=z.object({taskId:id}).parse(payload);this.store.assertAllowed('task.resume',p.taskId);
        if(this.agent.busy())throw new Error('请先暂停或等待当前任务结束。');
        const task=this.store.task(p.taskId),inputs=this.store.taskInputs(p.taskId);
        if(task.retryInputIds&&!inputs.some(input=>task.retryInputIds!.includes(input.id)&&input.status==='pending'))this.store.updateTask(p.taskId,{retryInputIds:undefined,retrySourceIds:undefined});
        const maintenance=this.store.maintenanceRun(p.taskId);if(maintenance?.completedAt)throw new Error('本批维护已经完成，请使用维护书架检查下一批新增文档。');
        return this.dispatch(p.taskId,maintenance?maintenancePrompt(maintenance):'继续原任务。保留当前检索范围和草稿，检查当前冲突与已完成的来源，不要重新导入。',[],false);
      }
      case 'task.pause':{const p=z.object({taskId:id}).parse(payload);if(this.store.maintenanceRun(p.taskId)?.completedAt)return this.store.task(p.taskId);this.store.assertAllowed('task.pause',p.taskId);await this.agent.pause(p.taskId);return this.store.task(p.taskId);}
      case 'conflict.resolve':{const p=z.object({id,decision:z.enum(['A','B','C']),conditionsA:z.string().optional(),conditionsB:z.string().optional()}).parse(payload);return this.resolve(p.id,p.decision,p.conditionsA,p.conditionsB);}
      case 'settings.get':return this.config.public();
      case 'settings.save':{this.store.assertAllowed('settings.save');if(this.agent.busy())throw new Error('请暂停研究后修改服务配置。');const p=z.object({settings:z.record(z.string(),z.unknown())}).parse(payload);const result=this.config.save(p.settings as SettingsPatch);this.emit({type:'changed'});return result;}
      case 'settings.import-env':{this.store.assertAllowed('settings.save');if(this.agent.busy())throw new Error('请暂停研究后导入服务配置。');const p=z.object({filePath:z.string().min(1).max(4096)}).parse(payload);const result=await this.config.importEnvFile(p.filePath);this.emit({type:'changed'});return result;}
      case 'settings.reload-env':{this.store.assertAllowed('settings.save');if(this.agent.busy())throw new Error('请暂停研究后重新读取服务配置。');const result=await this.config.reloadEnv();this.emit({type:'changed'});return result;}
      case 'storage.inspect':{const p=z.object({dataDir:z.string().trim().min(1).max(4096)}).parse(payload);return inspectStorage(this.store.dataDir,p.dataDir);}
      case 'storage.resolve-path':{
        const p=z.object({path:z.string().min(1).max(4096)}).parse(payload);
        const target=await realpath(relocatedPath(this.store.dataDir,resolve(p.path))),base=await realpath(this.store.dataDir),rel=relative(base,target);
        if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw new Error('只允许打开当前知识库目录内的文件。');
        return target;
      }
      default:throw new Error('不支持的应用操作。');
    }
  }
  private maintenanceScope(payload:unknown,requireRun=false){
    const p=z.object({dataDir:z.string().min(1).max(4096).optional(),runId:id.optional()}).parse(payload??{});
    if(p.dataDir&&resolve(p.dataDir)!==resolve(this.store.dataDir))throw new Error('知识库已切换，请刷新书架目录后重试。');
    if(!requireRun)return undefined;
    const run=this.store.maintenanceState().run;
    if(!run||!p.runId||run.id!==p.runId)throw new Error('维护批次已变化，请刷新书架目录后重试。');
    return run;
  }
  private async resolve(id:string,decision:'A'|'B'|'C',conditionsA?:string,conditionsB?:string){
    const conflict=this.store.conflicts().find(c=>c.id===id);if(!conflict)throw new Error('冲突不存在。');
    if(this.agent.isRunning(conflict.taskId))throw new Error('冲突核实仍在进行，请等待完成后裁决。');
    const result=this.store.resolveConflict(id,decision,conditionsA,conditionsB);
    this.store.addMessage(result.taskId,'user',`明确裁决 ${decision}：${decision==='A'?result.oldClaim:decision==='B'?result.newClaim:`A 适用：${result.conditionsA}\nB 适用：${result.conditionsB}`}`);
    this.emit({type:'changed',taskId:result.taskId});
    const unresolved=this.store.conflicts().some(c=>['suspected','confirmed'].includes(c.status));
    if(!unresolved)this.dispatch(result.taskId,`可信人类裁决已记录：冲突 ${id} 选择 ${decision}。按服务状态中的具体裁决继续原任务，重新处理草稿并最终自检发布。`,[],false);
    return result;
  }
  private async switchStorage(requested:string,mode:'move'|'open'){
    this.store.assertAllowed('storage.switch');
    if(this.calls)throw new Error('正在读取或保存资料，请稍后再切换知识库。');
    if(this.agent.busy())throw new Error('研究仍在运行，请先暂停或等待完成后切换知识库。');
    const selection=await selectStorage(this.store.dataDir,requested,mode);
    const original=this.store.dataDir;
    // The service call gate keeps reads and writes out until both SQLite and
    // all path-dependent services point at one complete location.
    await this.agent.shutdown();await Promise.allSettled([...this.runs]);this.store.close();
    let next:Store|undefined;
    try{
      await prepareStorage(selection);
      next=new Store(selection.target);
      const sources=new SourceService(next.dataDir,()=>this.config.get(),this.browserMedia);
      const agent=new ResearchAgent(next,this.config,sources,this.emit);
      const settings=this.config.activateDataDir(next.dataDir);
      this.store=next;this.sources=sources;this.agent=agent;
      this.emit({type:'storage.changed',data:{dataDir:next.dataDir,previousDataDir:original,mode}});
      return settings;
    }catch(error){
      next?.close();
      this.store=new Store(original);
      this.sources=new SourceService(this.store.dataDir,()=>this.config.get(),this.browserMedia);
      this.agent=new ResearchAgent(this.store,this.config,this.sources,this.emit);
      throw error;
    }
  }
  async close(){if(this.switching)await this.switching.catch(()=>{});await this.agent.shutdown();await Promise.allSettled([...this.runs]);this.store.close();}
}
