import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleHelp, FolderOpen, LibraryBig, LockKeyhole, MessageSquare, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw, Settings2, Upload, X } from 'lucide-react';
import type { DocumentMeta, Draft, KnowledgeDocument, RawMaterial, Snapshot, Task, TaskDetail } from '../shared/types';
import DocumentPanel from './DocumentPanel';
import LibraryPanel from './LibraryPanel';
import IngestionPanel from './IngestionPanel';
import ResearchPanel, { MaterialStages } from './ResearchPanel';
import SettingsDialog from './SettingsDialog';
import ShelfDirectory from './ShelfDirectory';
import { copyLocalScope, dateText, ErrorNotice, errorText, IconButton, Loading, Markdown, Modal, readLocal, setLocalScope, writeLocal } from './ui';

type ActivePane = 'library' | 'document' | 'research' | 'ingestion' | 'directory';

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [categoryId, setCategoryId] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [newDocument, setNewDocument] = useState(false);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [ingestionTaskId, setIngestionTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [contextIds, setContextIds] = useState<string[]>([]);
  const [contextDocuments, setContextDocuments] = useState<Record<string, DocumentMeta>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [raw, setRaw] = useState<RawMaterial | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawError, setRawError] = useState('');
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [activePane, setActivePane] = useState<ActivePane>('document');
  const [leftHidden, setLeftHidden] = useState(false);
  const [rightHidden, setRightHidden] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() => readLocal<number>('research-shelf:left-width', 276));
  const [rightWidth, setRightWidth] = useState(() => readLocal<number>('research-shelf:right-width', 386));
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const appliedTask = useRef<string | null>(null);
  const refreshing = useRef(false);
  const pendingRefresh = useRef(false);
  const libraryEpoch = useRef(0);
  const activeLibrary = useRef('');
  const stateRef = useRef({ categoryId, taskId, documentId, document });
  stateRef.current = { categoryId, taskId, documentId, document };
  const lock = snapshot?.conflicts.find(conflict => conflict.status === 'suspected' || conflict.status === 'confirmed');
  const locked = Boolean(lock);

  const refresh = useCallback(async () => {
    if (!window.shelf) { setError('未连接桌面服务。请通过项目的 npm run dev 或 npm start 启动 Electron 应用。'); setLoading(false); return; }
    if (refreshing.current) { pendingRefresh.current = true; return; }
    refreshing.current = true;
    const epoch = libraryEpoch.current;
    try {
      const results = await Promise.allSettled([window.shelf.call<Snapshot>('snapshot'), window.shelf.call<Draft[]>('drafts')]);
      if (epoch !== libraryEpoch.current) return;
      const snapResult = results[0];
      if (snapResult.status === 'fulfilled') {
        const next = snapResult.value;
        if (activeLibrary.current !== next.settings.dataDir) {
          activeLibrary.current = next.settings.dataDir; setLocalScope(next.settings.dataDir);
          const recoveredCategory = readLocal<string>('research-shelf:category', '');
          const recoveredDocument = readLocal<string | null>('research-shelf:document', null);
          const recoveredTask = readLocal<string | null>('research-shelf:task', null);
          stateRef.current = { categoryId: recoveredCategory, documentId: recoveredDocument, taskId: recoveredTask, document: null };
          setCategoryId(recoveredCategory); setDocumentId(recoveredDocument); setTaskId(recoveredTask);
          setIngestionTaskId(readLocal<string | null>('research-shelf:ingestion-task', null));
          setDocument(null); setTask(null); setDocuments([]); setContextDocuments({}); setContextIds(readLocal<string[]>('research-shelf:new-context', []));
          setNewDocument(false); setStreams({}); appliedTask.current = null;
        }
        setSnapshot(next);
        if (!next.categories.some(category => category.id === stateRef.current.categoryId)) setCategoryId(next.categories[0]?.id || '');
        if (stateRef.current.taskId && !next.tasks.some(item => item.id === stateRef.current.taskId)) setTaskId(null);
        setIngestionTaskId(previous => previous && !next.tasks.some(item => item.id === previous && item.kind === 'ingestion') ? null : previous);
        setRevision(value => value + 1);
      } else setError(errorText(snapResult.reason));
      if (results[1].status === 'fulfilled') setDrafts(results[1].value); else setError(errorText(results[1].reason));
    } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); refreshing.current = false; if (pendingRefresh.current) { pendingRefresh.current = false; void refresh(); } }
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.shelf) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.shelf.onEvent(event => {
      if (event.type === 'service.error') { setError(typeof event.data === 'string' ? event.data : (event.data as { message?: string } | undefined)?.message || '本地服务发生错误，请查看终端或重新启动应用。'); return; }
      if (event.type === 'storage.changed') {
        const data = event.data as { dataDir?: string; previousDataDir?: string; mode?: 'move' | 'open' } | undefined;
        if (!data?.dataDir) return;
        if (data.mode === 'move' && data.previousDataDir) copyLocalScope(data.previousDataDir, data.dataDir);
        setLocalScope(data.dataDir); activeLibrary.current = data.dataDir; libraryEpoch.current += 1;
        stateRef.current = { categoryId: '', taskId: null, documentId: null, document: null }; appliedTask.current = null;
        setCategoryId(''); setDocumentId(null); setNewDocument(false); setDocument(null); setDocuments([]); setTaskId(null); setTask(null);
        setIngestionTaskId(readLocal<string | null>('research-shelf:ingestion-task', null));
        setContextIds([]); setContextDocuments({}); setDrafts([]); setStreams({}); setRaw(null); setRawOpen(false); setRawError('');
        setDocumentLoading(false); setDocumentsLoading(false); setTaskLoading(false); setRawLoading(false); setError(''); setRecoveryDismissed(false);
        setSnapshot(previous => previous ? { ...previous, categories: [], tasks: [], conflicts: [], recovered: false, settings: { ...previous.settings, dataDir: data.dataDir!, pendingDataDir: undefined } } : null);
        if (timer) { clearTimeout(timer); timer = null; }
        void refresh(); return;
      }
      if (event.type === 'assistant.delta' && event.taskId) {
        const delta = typeof event.data === 'string' ? event.data : (event.data as { delta?: string } | undefined)?.delta || '';
        if (delta) setStreams(previous => ({ ...previous, [event.taskId!]: (previous[event.taskId!] || '') + delta }));
        return;
      }
      if (event.taskId && (event.type === 'assistant.end' || event.type === 'assistant.message' || event.type === 'task.updated' || event.type === 'task.completed')) setStreams(previous => ({ ...previous, [event.taskId!]: '' }));
      if (!timer) timer = setTimeout(() => { timer = null; void refresh(); }, 450);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!categoryId || !snapshot) return;
    writeLocal('research-shelf:category', categoryId);
    let active = true; const epoch = libraryEpoch.current; setDocumentsLoading(true);
    window.shelf.call<DocumentMeta[]>('documents', { categoryId }).then(result => { if (!active || epoch !== libraryEpoch.current) return; setDocuments(result); setContextDocuments(previous => ({ ...previous, ...Object.fromEntries(result.map(item => [item.id, item])) })); }).catch(cause => { if (active && epoch === libraryEpoch.current) { setDocuments([]); setError(errorText(cause)); } }).finally(() => { if (active && epoch === libraryEpoch.current) setDocumentsLoading(false); });
    return () => { active = false; };
  }, [categoryId, revision]);

  useEffect(() => {
    if (!snapshot) return;
    writeLocal('research-shelf:document', documentId);
    if (!documentId) { setDocument(null); setDocumentLoading(false); return; }
    let active = true; const epoch = libraryEpoch.current;
    if (stateRef.current.document?.id !== documentId) setDocumentLoading(true);
    window.shelf.call<KnowledgeDocument>('document', { id: documentId }).then(result => { if (active && epoch === libraryEpoch.current) { setDocument(result); setContextDocuments(previous => ({ ...previous, [result.id]: result })); } }).catch(cause => { if (active && epoch === libraryEpoch.current) { setDocument(null); setError(errorText(cause)); } }).finally(() => { if (active && epoch === libraryEpoch.current) setDocumentLoading(false); });
    return () => { active = false; };
  }, [documentId, revision]);

  useEffect(() => {
    if (!snapshot) return;
    writeLocal('research-shelf:task', taskId);
    if (!taskId) { setTask(null); setTaskLoading(false); appliedTask.current = null; return; }
    let active = true; const epoch = libraryEpoch.current;
    if (appliedTask.current !== taskId) setTaskLoading(true);
    window.shelf.call<TaskDetail>('task', { id: taskId }).then(result => {
      if (!active || epoch !== libraryEpoch.current) return;
      setTask(result);
      if (appliedTask.current !== taskId) { setContextIds(result.task.selectedDocIds); appliedTask.current = taskId; }
      if (result.task.status !== 'running') setStreams(previous => previous[taskId] ? { ...previous, [taskId]: '' } : previous);
    }).catch(cause => { if (active && epoch === libraryEpoch.current) { setTask(null); setError(errorText(cause)); } }).finally(() => { if (active && epoch === libraryEpoch.current) setTaskLoading(false); });
    return () => { active = false; };
  }, [taskId, revision]);

  useEffect(() => {
    if (!window.shelf) return;
    const ids = [...new Set([...contextIds, ...(task?.scans.flatMap(scan => scan.readIds) || [])])].filter(id => !contextDocuments[id]);
    if (!ids.length) return;
    let active = true; const epoch = libraryEpoch.current;
    void Promise.allSettled(ids.map(id => window.shelf.call<KnowledgeDocument>('document', { id }))).then(results => {
      if (!active || epoch !== libraryEpoch.current) return;
      const found: Record<string, DocumentMeta> = {};
      results.forEach(result => { if (result.status === 'fulfilled') found[result.value.id] = result.value; });
      if (Object.keys(found).length) setContextDocuments(previous => ({ ...previous, ...found }));
    });
    return () => { active = false; };
  }, [contextIds, task?.scans, contextDocuments]);

  const contextMutation = useRef(false);
  async function updateContext(next: string[]) {
    if (locked || contextMutation.current) return;
    contextMutation.current = true;
    const epoch = libraryEpoch.current;
    try { if (taskId) { const result = await window.shelf.call<Task>('task.context', { taskId, selectedDocIds: next }); if (epoch === libraryEpoch.current) setContextIds(result.selectedDocIds); } else { setContextIds(next); writeLocal('research-shelf:new-context', next); } } catch (cause) { if (epoch === libraryEpoch.current) setError(errorText(cause)); } finally { contextMutation.current = false; }
  }
  function toggleContext(id: string) { void updateContext(contextIds.includes(id) ? contextIds.filter(item => item !== id) : [...contextIds, id]); }
  function openDocument(id: string) { setDocumentId(id); setNewDocument(false); setActivePane('document'); }
  function createDocument() { if (locked) return; setDocumentId(null); setDocument(null); setNewDocument(true); setActivePane('document'); }
  function chooseIngestionTask(id: string | null) { setIngestionTaskId(id); writeLocal('research-shelf:ingestion-task', id); setActivePane('ingestion'); }
  function chooseTask(id: string | null) { if (id && snapshot?.tasks.find(item => item.id === id)?.kind === 'ingestion') { chooseIngestionTask(id); return; } setTaskId(id); setActivePane('research'); setRightHidden(false); if (!id) { setTask(null); setContextIds(readLocal<string[]>('research-shelf:new-context', [])); } }
  async function onUpdated(id?: string) { if (snapshot?.settings.dataDir !== activeLibrary.current) return; if (id && id !== taskId) setTaskId(id); await refresh(); }
  function research(id?: string) { if (id && !contextIds.includes(id)) void updateContext([...contextIds, id]); setRightHidden(false); setActivePane('research'); setTimeout(() => composerRef.current?.focus(), 0); }
  async function openRaw(id: string) { const epoch = libraryEpoch.current; setRaw(null); setRawOpen(true); setRawLoading(true); setRawError(''); try { const result = await window.shelf.call<RawMaterial>('raw', { id }); if (epoch === libraryEpoch.current) setRaw(result); } catch (cause) { if (epoch === libraryEpoch.current) setRawError(errorText(cause)); } finally { if (epoch === libraryEpoch.current) setRawLoading(false); } }

  function resize(panel: 'left' | 'right', amount: number, relative = true) {
    const setter = panel === 'left' ? setLeftWidth : setRightWidth;
    setter(previous => { const next = Math.min(panel === 'left' ? 420 : 640, Math.max(panel === 'left' ? 220 : 320, relative ? previous + amount : amount)); writeLocal(`research-shelf:${panel}-width`, next); return next; });
  }
  function startResize(event: React.PointerEvent, panel: 'left' | 'right') {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === 'left' ? leftWidth : rightWidth;
    const move = (next: PointerEvent) => resize(panel, startWidth + (next.clientX - startX) * (panel === 'left' ? 1 : -1), false);
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); documentBody?.classList.remove('resizing'); };
    const documentBody = globalThis.document.body;
    documentBody.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
  }
  function separator(panel: 'left' | 'right') { return <div className={`panel-resizer resizer-${panel}`} role="separator" tabIndex={0} aria-label={`调整${panel === 'left' ? '书架' : '研究'}面板宽度`} aria-orientation="vertical" aria-valuenow={panel === 'left' ? leftWidth : rightWidth} aria-valuemin={panel === 'left' ? 220 : 320} aria-valuemax={panel === 'left' ? 420 : 640} onPointerDown={event => startResize(event, panel)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(panel, (event.key === 'ArrowLeft' ? -16 : 16) * (panel === 'left' ? 1 : -1)); } }} />; }

  if (loading && !snapshot) return <main className="boot-screen"><LibraryBig size={34} /><h1>研究书架</h1><Loading label="正在连接本地知识库…" /></main>;
  if (!snapshot) return <main className="boot-error"><LibraryBig size={34} /><h1>暂时无法打开研究书架</h1><ErrorNotice>{error || '本地服务尚未就绪。'}</ErrorNotice><button className="primary" onClick={() => { setLoading(true); setError(''); void refresh(); }}><RefreshCw size={16} />重新连接</button></main>;

  return <div className="app-shell">
    <header className="app-toolbar"><div className="brand"><LibraryBig size={22} strokeWidth={1.8} /><strong>研究书架</strong></div><div className="toolbar-divider" /><nav className="pane-tabs" aria-label="工作台面板"><button aria-pressed={activePane === 'library'} onClick={() => { setActivePane('library'); setLeftHidden(false); }}><FolderOpen size={16} />书架</button><button aria-pressed={activePane === 'document'} onClick={() => setActivePane('document')}><BookOpen size={16} />文档</button><button aria-pressed={activePane === 'research'} onClick={() => { setActivePane('research'); setRightHidden(false); }}><MessageSquare size={16} />研究</button><button className="ingestion-nav" aria-pressed={activePane === 'ingestion'} onClick={() => setActivePane('ingestion')}><Upload size={16} />资料入库</button><button className="directory-nav" aria-pressed={activePane === 'directory'} onClick={() => setActivePane('directory')}><Network size={16} />书架目录</button></nav><span className="toolbar-spacer" /><div className="panel-toggles" hidden={activePane === 'directory' || activePane === 'ingestion'}><IconButton label={leftHidden ? '展开书架面板' : '收起书架面板'} onClick={() => setLeftHidden(!leftHidden)}>{leftHidden ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</IconButton><IconButton label={rightHidden ? '展开研究面板' : '收起研究面板'} onClick={() => setRightHidden(!rightHidden)}>{rightHidden ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}</IconButton></div><IconButton label="使用说明" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></IconButton><button className="toolbar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /><span>设置</span>{!snapshot.settings.text.configured && <span className="settings-attention" />}</button></header>
    {error && <div className="global-notice"><ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice></div>}
    {snapshot.recovered && !recoveryDismissed && <div className="recovery-banner" role="status"><RefreshCw size={15} /><span>已恢复上次的任务、草稿和冲突状态。暂停的研究可在原对话中继续。</span><IconButton label="关闭恢复提示" onClick={() => setRecoveryDismissed(true)}><X size={15} /></IconButton></div>}
    {lock && <div className="lock-banner" role="status"><LockKeyhole size={16} /><span>{lock.status === 'suspected' ? '正在核实疑似知识冲突' : '知识冲突等待你的裁决'}，其他编辑和研究暂时暂停。</span><button onClick={() => chooseTask(lock.taskId)}>查看冲突<ChevronRight size={15} /></button></div>}
    <ShelfDirectory key={`directory:${snapshot.settings.dataDir}`} categories={snapshot.categories} revision={revision} active={activePane === 'directory'} locked={locked || snapshot.tasks.some(item => item.status === 'running' || item.status === 'queued')} dataDir={snapshot.settings.dataDir} configured={snapshot.settings.text.configured} blockingTaskId={lock?.taskId} onUpdated={refresh} onDocument={item => { setCategoryId(item.categoryId); openDocument(item.id); }} onTask={chooseTask} onSettings={() => setSettingsOpen(true)} />
    <IngestionPanel key={`ingestion:${snapshot.settings.dataDir}`} active={activePane === 'ingestion'} tasks={snapshot.tasks} taskId={ingestionTaskId} revision={revision} categories={snapshot.categories} configured={snapshot.settings.text.configured} locked={locked} lockedTaskId={lock?.taskId} streaming={ingestionTaskId ? streams[ingestionTaskId] || '' : ''} onSelect={chooseIngestionTask} onUpdated={refresh} onDocument={openDocument} onRaw={id => void openRaw(id)} onSettings={() => setSettingsOpen(true)} onLibrary={() => { setActivePane('library'); setLeftHidden(false); }} onTask={chooseTask} />
    <div hidden={activePane === 'directory' || activePane === 'ingestion'} key={snapshot.settings.dataDir} className={`workbench active-${activePane} ${leftHidden ? 'left-hidden' : ''} ${rightHidden ? 'right-hidden' : ''}`} style={{ '--left-width': `${leftWidth}px`, '--right-width': `${rightWidth}px` } as CSSProperties}>
      <aside className="library-panel" aria-label="书架目录"><LibraryPanel categories={snapshot.categories} categoryId={categoryId} onCategory={id => { setCategoryId(id); setActivePane('library'); }} documents={documents} loading={documentsLoading} documentId={documentId} onDocument={openDocument} contextIds={contextIds} onContext={toggleContext} onNewDocument={createDocument} onCategorySaved={refresh} locked={locked} /></aside>
      {separator('left')}
      <main className="main-panel" aria-label="文档工作区">{documentLoading ? <div className="document-loading"><Loading label="正在打开文档…" /></div> : <DocumentPanel key={documentId || (newDocument ? 'new' : 'welcome')} document={document} newDocument={newDocument} categoryId={categoryId} categories={snapshot.categories} loading={false} drafts={drafts} locked={locked} configured={snapshot.settings.text.configured} onSaved={async saved => { if (snapshot.settings.dataDir !== activeLibrary.current) return; setDocument(saved); setDocumentId(saved.id); setNewDocument(false); setCategoryId(saved.categoryId); await refresh(); }} onNew={createDocument} onSettings={() => setSettingsOpen(true)} onResearch={research} onRaw={id => void openRaw(id)} onOpenDocument={openDocument} />}</main>
      {separator('right')}
      <aside className="research-panel" aria-label="研究对话"><ResearchPanel tasks={snapshot.tasks.filter(item => item.kind !== 'ingestion')} detail={task} taskId={taskId} taskLoading={taskLoading} contextIds={contextIds} contextDocuments={contextDocuments} categories={snapshot.categories} streaming={taskId ? streams[taskId] || '' : ''} locked={locked} lockedTaskId={lock?.taskId} configured={snapshot.settings.text.configured} onTask={chooseTask} onContextRemove={id => void updateContext(contextIds.filter(item => item !== id))} onContextOpen={openDocument} onUpdated={onUpdated} onSettings={() => setSettingsOpen(true)} onRaw={id => void openRaw(id)} composerRef={composerRef} /></aside>
      {leftHidden && <button className="panel-reopen reopen-left" title="展开书架" aria-label="展开书架" onClick={() => setLeftHidden(false)}><ChevronRight size={18} /></button>}{rightHidden && <button className="panel-reopen reopen-right" title="展开研究" aria-label="展开研究" onClick={() => setRightHidden(false)}><ChevronLeft size={18} /></button>}
    </div>
    <footer className="statusbar"><span><span className="status-dot is-ready" />本地知识库</span><span>{snapshot.categories.length} 个分类 · {snapshot.categories.reduce((sum, category) => sum + (category.count || 0), 0)} 篇文档</span><span className="statusbar-right">{locked ? '冲突处理中' : snapshot.settings.text.configured ? '文本模型已配置' : '手动编辑可用 · 模型待配置'}</span></footer>
    {settingsOpen && <SettingsDialog settings={snapshot.settings} close={() => setSettingsOpen(false)} saved={refresh} locked={locked} />}
    {rawOpen && <Modal title="原始材料" close={() => setRawOpen(false)} wide><div className="raw-material modal-scroll">{rawLoading && <Loading label="正在读取原始材料…" />}{rawError && <ErrorNotice>{rawError}</ErrorNotice>}{raw && <><div className="raw-material-heading"><h3>{raw.title}</h3><span className={`tag ${raw.status === 'unavailable' ? 'tag-error' : ''}`}>{raw.status === 'available' ? '已获取' : raw.status === 'partial' ? '部分内容' : '不可访问'}</span></div><p className="muted">{raw.kind} · {dateText(raw.createdAt, true)}</p><div className="notice info"><div><strong>实际获取范围</strong><p>{raw.coverage || '未记录'}</p><MaterialStages stages={raw.metadata?.stages} /></div></div>{raw.error && <ErrorNotice>{raw.error}</ErrorNotice>}{raw.url && <button className="text-button" onClick={() => void window.shelf.openExternal(raw.url!)}>打开原始链接</button>}{raw.filePath && <button className="text-button raw-file-link" onClick={() => void window.shelf.openPath(raw.filePath!).catch(cause => setRawError(errorText(cause)))}>打开保留的原文件</button>}<Markdown>{raw.text || '*没有可展示的文字内容。请查看获取范围与错误信息。*'}</Markdown></>}</div></Modal>}
    {helpOpen && <Modal title="使用研究书架" close={() => setHelpOpen(false)}><div className="help-content modal-scroll"><h3>从材料开始</h3><p>打开顶部「资料入库」，粘贴链接、分享文字或选择文件，点击「开始入库」。每批独立处理，不带入其他批次的对话；结果按材料显示，失败项可以单独重试。日常入库会检查同名、别名和论文标识，减少重复建档。</p><h3>用已有文档继续研究</h3><p>在左侧勾选一篇或多篇文档，右侧会显示上下文标签，可以结合这些文档继续研究。</p><h3>维护书架</h3><p>打开「书架目录」，点击右上角的「维护书架」，集中检查新入库资料是否属于同一概念，只做内容合并与差异检查，允许无需处理。首次维护会检查现有文档；中央显示实际检查、合并与无需处理数量，可展开逐文档报告，并暂停后继续。</p><h3>阅读、编辑与历史</h3><p>中间面板提供 Markdown 阅读与编辑。手动修改需点击保存；Ctrl + S 可在正文编辑框保存。版本页可以对比历史并回滚。</p><h3>草稿与知识冲突</h3><p>自动维护先写草稿，经主模型自检后发布。确认的知识冲突需由你选择 A、B 或填写明确条件的 C。Other 仅用于追问，不会解除冲突。</p><h3>快捷操作</h3><p>Ctrl + Enter 发送研究消息。Tab 可到达面板分隔条，左右方向键调整宽度。窗口变窄时，使用顶部书架、文档、研究切换。</p><p className="muted">所有文档、来源与会话保存在设置中的本地数据目录。</p></div></Modal>}
  </div>;
}
