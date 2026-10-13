import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { AlertCircle, ArrowRightLeft, BookOpen, Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, GripVertical, Info, List, Maximize, Minus, MoreHorizontal, Network, Pause, Play, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import type { Category, DocumentMeta, KnowledgeDocument, MaintenanceState } from '../shared/types';
import CategoryEditor from './CategoryEditor';
import { categoryPath } from './category-utils';
import { buildShelfLayout, type ShelfNode } from './shelf-layout';
import { dateText, ErrorNotice, errorText, IconButton, Loading, Modal, stageText } from './ui';

interface Props { categories: Category[]; revision: number; active: boolean; locked: boolean; dataDir: string; configured: boolean; blockingTaskId?: string; onUpdated: () => Promise<void>; onDocument: (document: DocumentMeta) => void; onTask: (taskId: string) => void; onSettings: () => void }
const DRAG_TYPE = 'application/x-research-shelf-document';
type MaintenanceAction = 'get' | 'start' | 'pause' | 'resume';

export default function ShelfDirectory({ categories, revision, active, locked, dataDir, configured, blockingTaskId, onUpdated, onDocument, onTask, onSettings }: Props) {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState<Partial<Category> | null>(null);
  const [moving, setMoving] = useState<DocumentMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<DocumentMeta | null>(null);
  const [dropTarget, setDropTarget] = useState('');
  const [feedback, setFeedback] = useState('');
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const viewport = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const mutation = useRef(false);
  const fetchSequence = useRef(0);
  const dragDocument = useRef<DocumentMeta | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number; pointer: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceError, setMaintenanceError] = useState('');
  const [maintenanceAction, setMaintenanceAction] = useState<MaintenanceAction | null>(null);
  const [maintenanceVisible, setMaintenanceVisible] = useState(false);
  const maintenanceSequence = useRef(0);
  const maintenanceMutation = useRef(false);
  const maintenanceErrorSource = useRef<'load' | 'action' | null>(null);
  const dismissedMaintenance = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  const applyMaintenance = useCallback((result: MaintenanceState) => {
    if (!mounted.current || result.dataDir !== dataDir) return false;
    setMaintenance(result);
    if (result.run && (result.run.status === 'running' || result.run.status === 'queued' || (result.run.status !== 'completed' && dismissedMaintenance.current !== result.run.id))) setMaintenanceVisible(true);
    return true;
  }, [dataDir]);
  const loadMaintenance = useCallback(async () => {
    if (maintenanceMutation.current) return;
    const sequence = ++maintenanceSequence.current;
    setMaintenanceLoading(true);
    try {
      const result = await window.shelf.call<MaintenanceState>('maintenance.get', { dataDir });
      if (sequence === maintenanceSequence.current && applyMaintenance(result) && maintenanceErrorSource.current !== 'action') { maintenanceErrorSource.current = null; setMaintenanceError(''); }
    } catch (cause) {
      if (mounted.current && sequence === maintenanceSequence.current && maintenanceErrorSource.current !== 'action') { maintenanceErrorSource.current = 'load'; setMaintenanceError(errorText(cause)); }
    } finally {
      if (mounted.current && sequence === maintenanceSequence.current) setMaintenanceLoading(false);
    }
  }, [dataDir, applyMaintenance]);
  useEffect(() => { if (active) void loadMaintenance(); }, [active, revision, loadMaintenance]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; maintenanceSequence.current++; }; }, []);

  async function performMaintenance(action: Exclude<MaintenanceAction, 'get'>) {
    if (maintenanceMutation.current) return;
    maintenanceMutation.current = true;
    maintenanceSequence.current++;
    dismissedMaintenance.current = undefined; maintenanceErrorSource.current = null;
    setMaintenanceVisible(true); setMaintenanceAction(action); setMaintenanceError('');
    try {
      const result = await window.shelf.call<MaintenanceState>(`maintenance.${action}`, { dataDir, runId: maintenance?.run?.id });
      if (applyMaintenance(result)) await onUpdated();
    } catch (cause) { if (mounted.current) { maintenanceErrorSource.current = 'action'; setMaintenanceError(errorText(cause)); } }
    finally { maintenanceMutation.current = false; if (mounted.current) { setMaintenanceAction(null); setMaintenanceLoading(false); } }
  }
  async function maintain() {
    dismissedMaintenance.current = undefined;
    setMaintenanceVisible(true);
    if (maintenanceMutation.current) return;
    maintenanceMutation.current = true;
    maintenanceSequence.current++;
    maintenanceErrorSource.current = null; setMaintenanceAction('get'); setMaintenanceError('');
    try {
      const result = await window.shelf.call<MaintenanceState>('maintenance.get', { dataDir });
      if (!applyMaintenance(result)) return;
      if (result.run && result.run.status !== 'completed') return;
      if (!result.pendingCount || !configured || locked) return;
      setMaintenanceAction('start');
      const started = await window.shelf.call<MaintenanceState>('maintenance.start', { dataDir });
      if (applyMaintenance(started)) await onUpdated();
    } catch (cause) { if (mounted.current) { maintenanceErrorSource.current = 'action'; setMaintenanceError(errorText(cause)); } }
    finally { maintenanceMutation.current = false; if (mounted.current) { setMaintenanceAction(null); setMaintenanceLoading(false); } }
  }

  const load = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    try {
      const result = await window.shelf.call<DocumentMeta[]>('library.documents');
      if (sequence === fetchSequence.current) { setDocuments(result); setLoading(false); }
    } catch (cause) { if (sequence === fetchSequence.current) { setError(errorText(cause)); setLoading(false); } }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, revision, load]);
  useEffect(() => () => { fetchSequence.current++; }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(''), 5500); return () => clearTimeout(timer); }, [feedback]);
  useEffect(() => {
    function closeMenus(event: Event) { document.querySelectorAll<HTMLDetailsElement>('.shelf-menu[open]').forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; }); }
    function escapeMenus(event: KeyboardEvent) { if (event.key === 'Escape') document.querySelectorAll<HTMLDetailsElement>('.shelf-menu[open]').forEach(menu => { menu.open = false; }); }
    document.addEventListener('pointerdown', closeMenus); document.addEventListener('keydown', escapeMenus);
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', escapeMenus); };
  }, []);

  const layout = useMemo(() => buildShelfLayout(categories, documents, collapsed, query), [categories, documents, collapsed, query]);
  const contentWidth = Math.max(layout.width, size.width / zoom);
  const offset = (contentWidth - layout.width) / 2;
  useEffect(() => {
    if (!active || loading || initialized.current || !size.width) return;
    initialized.current = true;
    const initial = Math.min(1, Math.max(.45, (size.width - 32) / layout.width));
    setZoom(initial);
  }, [active, loading, layout.width, size.width]);

  function changeZoom(next: number) {
    const value = Math.min(1.5, Math.max(.35, next));
    const element = viewport.current;
    const centerX = element ? (element.scrollLeft + element.clientWidth / 2) / zoom : 0;
    const centerY = element ? (element.scrollTop + element.clientHeight / 2) / zoom : 0;
    setZoom(value);
    requestAnimationFrame(() => { if (element) { element.scrollLeft = Math.max(0, centerX * value - element.clientWidth / 2); element.scrollTop = Math.max(0, centerY * value - element.clientHeight / 2); } });
  }
  function fit() {
    changeZoom(Math.min(1, (size.width - 40) / layout.width, (size.height - 54) / layout.height));
    requestAnimationFrame(() => viewport.current?.scrollTo({ left: 0, top: 0 }));
  }
  function toggle(category: Category) { setSelected(category.id); setCollapsed(previous => { const next = new Set(previous); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; }); }
  function newChild(category: Category) { setSelected(category.id); setCollapsed(previous => new Set([...previous].filter(id => id !== category.id))); setEditor({ parentId: category.id, scopeConfirmed: false }); }

  async function move(document: DocumentMeta, categoryId: string) {
    if (mutation.current || locked) return;
    if (document.categoryId === categoryId) { setMoving(null); setFeedback('文档已在这个目录中'); return; }
    mutation.current = true; setBusy(true); setError('');
    try {
      const saved = await window.shelf.call<KnowledgeDocument>('document.move', { id: document.id, categoryId, expectedVersion: document.version });
      setDocuments(previous => previous.map(item => item.id === saved.id ? saved : item));
      setSelected(categoryId); setCollapsed(previous => { const next = new Set(previous); next.delete(categoryId); const parent = categories.find(item => item.id === categoryId)?.parentId; if (parent) next.delete(parent); return next; });
      setMoving(null); setFeedback(`已移动到：${categoryPath(categories, categoryId)}`);
      await onUpdated(); await load();
    } catch (cause) { setError(errorText(cause)); await load(); }
    finally { mutation.current = false; setBusy(false); }
  }
  function startDrag(event: DragEvent, document: DocumentMeta) {
    if (locked || busy) { event.preventDefault(); return; }
    event.dataTransfer.setData(DRAG_TYPE, document.id); event.dataTransfer.effectAllowed = 'move';
    dragDocument.current = document; setDragged(document); setFeedback('');
  }
  function endDrag() { dragDocument.current = null; setDragged(null); setDropTarget(''); }
  function dragOver(event: DragEvent, category: Category) {
    if (locked || busy || !dragDocument.current || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(category.id);
  }
  function drop(event: DragEvent, category: Category) {
    const document = dragDocument.current;
    if (!document || locked || busy) return;
    event.preventDefault(); const id = event.dataTransfer.getData(DRAG_TYPE); endDrag();
    if (id === document.id) void move(document, category.id);
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('button,input,summary,details,a,[draggable="true"]')) return;
    const element = viewport.current; if (!element) return;
    pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) { const state = pan.current, element = viewport.current; if (state && element) { element.scrollLeft = state.left - event.clientX + state.x; element.scrollTop = state.top - event.clientY + state.y; } }
  function endPan() { pan.current = null; setPanning(false); }

  function categoryNode(category: Category, node?: ShelfNode) {
    const open = Boolean(query.trim()) || !collapsed.has(category.id);
    const count = documents.filter(document => document.categoryId === category.id).length;
    return <div key={category.id} className={`shelf-folder ${node ? 'shelf-positioned' : ''} ${selected === category.id ? 'is-selected' : ''} ${dropTarget === category.id ? 'is-drop-target' : ''}`} data-category-id={category.id} style={node ? { left: node.x + offset, top: node.y, width: node.width, height: node.height } : undefined} onDragOver={event => dragOver(event, category)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(''); }} onDrop={event => drop(event, category)}>
      <button className="shelf-folder-main" onClick={() => toggle(category)} aria-expanded={open} title={categoryPath(categories, category.id)}><span className="shelf-folder-icon">{open ? <FolderOpen size={21} /> : <Folder size={21} />}</span><span className="shelf-folder-title">{category.name}</span><span className="shelf-folder-count" aria-label={`${count} 篇直属文档`}>{count}</span>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      <details className="shelf-menu"><summary aria-label={`${category.name}的目录操作`} title="目录操作"><MoreHorizontal size={17} /></summary><div className="shelf-menu-popover">{!category.parentId && <button disabled={locked || busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); newChild(category); }}><FolderPlus size={15} />新建二级目录</button>}<button disabled={locked || busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setEditor(category); }}><Folder size={15} />编辑目录</button></div></details>
      {!category.parentId && selected === category.id && !dragged && <button className="shelf-add-child" disabled={locked || busy} onClick={() => newChild(category)}><Plus size={14} />二级目录</button>}
    </div>;
  }
  function documentNode(document: DocumentMeta, node?: ShelfNode) {
    return <div key={document.id} className={`shelf-file ${node ? 'shelf-positioned' : ''} ${dragged?.id === document.id ? 'is-dragging' : ''}`} data-document-id={document.id} style={node ? { left: node.x + offset, top: node.y, width: node.width, height: node.height } : undefined} draggable={!locked && !busy} onDragStart={event => startDrag(event, document)} onDragEnd={endDrag}>
      <button className="shelf-file-open" title={document.title} onClick={() => onDocument(document)}><FileText size={16} /><span>{document.title}</span></button>
      <IconButton label={`移动文档：${document.title}`} disabled={locked || busy} onClick={() => { setError(''); setMoving(document); }}><GripVertical size={15} /></IconButton>
    </div>;
  }
  async function openMaintenanceDocument(id: string) {
    setError('');
    try {
      const document = documents.find(item => item.id === id) || await window.shelf.call<KnowledgeDocument>('document', { id });
      if (mounted.current) onDocument(document);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
  }
  function listBranch(category: Category, ancestors = new Set<string>()): React.ReactNode {
    if (ancestors.has(category.id) || !layout.nodes.some(node => node.id === category.id)) return null;
    const next = new Set([...ancestors, category.id]);
    const files = layout.nodes.filter(node => node.kind === 'document' && node.document?.categoryId === category.id);
    return <section key={category.id} className="shelf-list-branch">{categoryNode(category)}<div className="shelf-list-contents">{files.map(node => documentNode(node.document!))}{categories.filter(item => item.parentId === category.id).map(child => listBranch(child, next))}</div></section>;
  }

  return <section className="shelf-directory-page" hidden={!active} aria-label="书架目录">
    <header className="shelf-directory-toolbar"><h1>书架目录</h1><label className="shelf-directory-search"><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索目录或文档" aria-label="搜索目录或文档" />{query && <IconButton label="清除目录搜索" onClick={() => setQuery('')}><X size={15} /></IconButton>}</label><div className="shelf-view-switch" aria-label="目录展示方式"><button aria-pressed={mode === 'list'} onClick={() => setMode('list')}><List size={16} /><span>列表</span></button><button aria-pressed={mode === 'map'} onClick={() => setMode('map')}><Network size={16} /><span>地图</span></button></div><div className="shelf-directory-actions"><button className="secondary shelf-new-root" disabled={locked || busy || Boolean(maintenanceAction)} onClick={() => setEditor({ parentId: null, scopeConfirmed: false })}><Plus size={18} />新建一级目录</button><button className="primary shelf-maintain" disabled={Boolean(maintenanceAction)} onClick={() => void maintain()} title={maintenance ? `检查上次维护后新入库的 ${maintenance.pendingCount} 篇文档` : '检查新入库文档的同概念合并与知识差异'} aria-expanded={maintenanceVisible} aria-controls={maintenanceVisible ? 'shelf-maintenance-progress' : undefined}><RefreshCw size={17} className={maintenance?.run?.status === 'running' || maintenanceAction ? 'spin' : undefined} />维护书架</button></div></header>
    {error && <div className="shelf-directory-error"><ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice></div>}
    <div className="shelf-canvas-shell">
      <div className={`shelf-canvas-viewport ${panning ? 'is-panning' : ''} ${mode === 'list' ? 'is-list' : ''}`} ref={viewport} tabIndex={0} aria-label={mode === 'map' ? '目录画布，可滚动或拖动空白区域平移' : '目录列表'} onPointerDown={mode === 'map' ? startPan : undefined} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
        {loading ? <Loading label="正在读取书架目录…" /> : !categories.length ? <div className="shelf-empty"><BookOpen size={36} /><h2>从一个目录开始</h2><p>为研究资料创建一级目录，再按需要添加二级目录。</p><button className="primary" disabled={locked || busy} onClick={() => setEditor({ parentId: null, scopeConfirmed: false })}><FolderPlus size={17} />新建一级目录</button></div> : query && layout.nodes.length === 1 ? <div className="shelf-empty"><Search size={32} /><h2>没有匹配的目录或文档</h2><p>试试其他关键词，或清除搜索查看整个书架。</p><button className="secondary" onClick={() => setQuery('')}>清除搜索</button></div> : mode === 'list' ? <div className="shelf-list">{categories.filter(category => !category.parentId || !categories.some(item => item.id === category.parentId)).map(category => listBranch(category))}</div> : <div className="shelf-canvas-size" style={{ width: contentWidth * zoom, height: layout.height * zoom }}><div className="shelf-canvas-content" style={{ width: contentWidth, height: layout.height, transform: `scale(${zoom})` } as CSSProperties}>
          <svg className="shelf-connections" width={contentWidth} height={layout.height} aria-hidden="true"><g transform={`translate(${offset} 0)`}>{layout.lines.map((line, index) => <path key={index} d={line} />)}</g></svg>
          {layout.nodes.map(node => node.kind === 'root' ? <div key={node.id} className="shelf-root shelf-positioned" style={{ left: node.x + offset, top: node.y, width: node.width, height: node.height }}><span className="shelf-root-icon"><BookOpen size={25} /></span><div><strong>研究书架</strong><span>{categories.filter(category => !category.parentId).length} 个一级目录 · {documents.length} 篇文档</span></div></div> : node.kind === 'category' ? categoryNode(node.category!, node) : documentNode(node.document!, node))}
        </div></div>}
      </div>
      {maintenanceVisible && <MaintenanceProgress state={maintenance} documents={documents} onDocumentId={id => void openMaintenanceDocument(id)} loading={maintenanceLoading} error={maintenanceError} action={maintenanceAction} configured={configured} locked={locked} blockingTaskId={blockingTaskId} onSettings={onSettings} onTask={onTask} onAction={next => void performMaintenance(next)} onRetry={() => void maintain()} onClose={() => { dismissedMaintenance.current = maintenance?.run?.id; setMaintenanceVisible(false); }} />}
      <div className="shelf-canvas-bottom"><span className="shelf-canvas-hint"><Info size={15} />{query ? `搜索结果：${layout.matches} 篇文档` : locked ? '研究进行或冲突处理期间，目录可浏览' : '拖动文档调整目录 · 拖动画布空白处平移'}</span>{mode === 'map' && <div className="shelf-zoom"><IconButton label="缩小目录地图" disabled={zoom <= .35} onClick={() => changeZoom(zoom - .1)}><Minus size={17} /></IconButton><button className="shelf-zoom-value" aria-label="恢复地图为 100%" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button><IconButton label="放大目录地图" disabled={zoom >= 1.5} onClick={() => changeZoom(zoom + .1)}><Plus size={17} /></IconButton><span /><button className="shelf-fit" onClick={fit}><Maximize size={16} />适应画布</button></div>}</div>
      <div className={`shelf-feedback ${feedback || dropTarget || busy ? 'is-visible' : ''}`} role="status" aria-live="polite">{busy ? <><ArrowRightLeft size={17} />正在移动文档…</> : dropTarget ? <><ArrowRightLeft size={17} /><span>移动到：<strong>{categoryPath(categories, dropTarget)}</strong></span></> : feedback ? <><Check size={17} /><span>{feedback}</span></> : null}</div>
    </div>
    {editor && <CategoryEditor compact category={editor} categories={categories} close={() => setEditor(null)} saved={async () => { setEditor(null); setFeedback('目录已保存'); await onUpdated(); await load(); }} />}
    {moving && <MoveDocument document={moving} categories={categories} busy={busy} error={error} close={() => { if (!busy) setMoving(null); }} move={id => void move(moving, id)} />}
  </section>;
}

function MaintenanceProgress({ state, documents, onDocumentId, loading, error, action, configured, locked, blockingTaskId, onSettings, onTask, onAction, onRetry, onClose }: {
  state: MaintenanceState | null; documents: DocumentMeta[]; onDocumentId: (id: string) => void; loading: boolean; error: string; action: MaintenanceAction | null; configured: boolean; locked: boolean; blockingTaskId?: string;
  onSettings: () => void; onTask: (taskId: string) => void; onAction: (action: 'start' | 'pause' | 'resume') => void; onRetry: () => void; onClose: () => void;
}) {
  const run = action === 'start' ? undefined : state?.run;
  const running = run?.status === 'running' || run?.status === 'queued';
  const waiting = run?.status === 'waiting_user' || Boolean(blockingTaskId);
  const resumable = run && (run.status === 'paused' || run.status === 'failed' || run.status === 'unconfigured');
  const preparing = Boolean(action === 'start' || action === 'get' || (!state && loading));
  const empty = state?.totalDocuments === 0;
  const missingModel = !configured && !empty && !running && Boolean(state && (state.pendingCount > 0 || (run && run.status !== 'completed')));
  const failed = run?.status === 'failed';
  const finished = run?.status === 'completed';
  const percent = run?.total ? Math.round(run.checked / run.total * 100) : 0;
  const title = preparing ? '正在准备维护书架' : empty ? '还没有待维护的文档' : waiting ? '书架维护需要你处理' : error ? '维护操作未成功' : missingModel ? '配置模型后维护书架' : running ? '正在维护书架' : run?.status === 'paused' ? '书架维护已暂停' : failed ? '书架维护中断' : finished && !state?.pendingCount ? '书架维护已完成' : locked ? '书架维护暂不可开始' : !state?.pendingCount ? '书架已是最新' : '准备维护书架';
  const activityMessage = run?.progressMessage || '';
  const candidateTitle = activityMessage.match(/^正在比较候选正文[：:]\s*(.+)$/)?.[1];
  const workStage = run?.stage === 'scanning' ? '查看目录概览' : candidateTitle ? '比较候选' : /^正在阅读待整理文档[：:]/.test(activityMessage) ? '阅读当前文档' : run?.stage === 'drafting' ? '生成整合稿' : run?.stage === 'self_review' ? '自检整合稿' : run?.stage === 'maintenance' ? '保存整理结论' : run?.stage === 'researching' ? '整理当前文档' : stageText(run?.stage || '');
  const currentStage = waiting ? '等待你在研究中处理后继续' : run?.status === 'paused' ? '已暂停检查' : failed ? '检查中断' : run?.status === 'unconfigured' ? '等待配置模型' : workStage;
  const currentTitle = run?.currentDocumentTitle || run?.items.find(item => item.status === 'pending')?.title;
  const resumeDisabled = Boolean(action || waiting || locked || !configured);
  const conflictTaskId = blockingTaskId || (run?.status === 'waiting_user' ? run.taskId : undefined);
  const documentById = new Map(documents.map(document => [document.id, document]));

  return <div className="shelf-maintenance-overlay" id="shelf-maintenance-progress">
    <section className={`shelf-maintenance-card ${failed || error ? 'has-error' : ''}`} aria-labelledby="shelf-maintenance-title" aria-busy={Boolean(action)}>
      <header className="shelf-maintenance-heading"><span className="shelf-maintenance-icon">{failed || error ? <AlertCircle size={25} /> : finished && !state?.pendingCount ? <Check size={25} /> : <RefreshCw size={25} className={running || preparing ? 'spin' : undefined} />}</span><h2 id="shelf-maintenance-title" role="status" aria-live="polite">{title}</h2><div className="shelf-maintenance-actions">{running && <button className="secondary" disabled={Boolean(action)} onClick={() => onAction('pause')}><Pause size={14} />{action === 'pause' ? '正在暂停…' : '暂停'}</button>}{resumable && !waiting && configured && <button className="secondary" disabled={resumeDisabled} onClick={() => onAction('resume')}><Play size={14} />{action === 'resume' ? '正在继续…' : failed ? '重试' : '继续'}</button>}{!running && !action && <IconButton label="收起维护进度" onClick={onClose}><X size={16} /></IconButton>}</div></header>
      {preparing && !run ? <p className="shelf-maintenance-summary">正在确认上次维护后新入库的 .md 文档…</p> : run ? <>
        <div className="shelf-maintenance-summary"><span>{finished ? '本次维护' : state?.lastCompletedAt ? '上次维护后新增' : '首次维护'} {run.total} 篇 .md · 已检查 {run.checked} / {run.total} 篇</span><span className="shelf-maintenance-percent">{percent}%</span></div>
        <progress className="shelf-maintenance-bar" value={run.checked} max={Math.max(1, run.total)} aria-label={`已检查 ${run.checked} / ${run.total} 篇文档`} />
        {!finished && currentTitle && <p className="shelf-maintenance-detail shelf-maintenance-current">当前待整理：<strong>{currentTitle}</strong></p>}
        <div className="shelf-maintenance-detail shelf-maintenance-phase"><span>{finished ? '已完成同概念合并与差异检查' : <>阶段：{currentStage}{running && workStage === '比较候选' && candidateTitle && <>：{candidateTitle}</>}</>}</span></div>
        <div className="shelf-maintenance-detail" style={{ marginTop: 6 }}><strong style={{ flexShrink: 1, overflowWrap: 'anywhere' }}>已生成整合文档 {run.mergedCount ?? 0} 篇 · 无需处理 {run.noChangeCount ?? 0} 篇 · 差异 {run.diffCount ?? 0} 项</strong></div>
        <p className="shelf-maintenance-note">逐篇整理，概览用于筛选，候选正文按需读取；当前项形成结论后再继续下一篇。</p>
        <p className="shelf-maintenance-note">同概念且适合合并的两篇或多篇资料会形成一篇新文档，生成新标题与概览。没有匹配则保留独立文档；疑似差异先由你裁决。</p>
        <details className="shelf-maintenance-report" style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 14 }}>查看逐文档维护报告（{run.checked} / {run.total} 篇）</summary>
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 10 }}>
            {run.items.length ? run.items.map(item => {
              const done = item.status === 'done';
              const outcome = !done ? '待检查' : item.outcome === 'merged' ? '已合并' : item.outcome === 'no_change' ? '无需处理' : '已检查';
              return <section key={item.documentId} aria-label={`${item.title}：${outcome}`} style={{ padding: '12px 0', borderTop: '1px solid var(--shelf-node-border)', overflowWrap: 'anywhere' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                  <button className="text-button" style={{ minWidth: 0, textAlign: 'left', whiteSpace: 'normal', fontWeight: 600 }} onClick={() => onDocumentId(item.documentId)}>{item.title}</button>
                  <span style={{ flexShrink: 0, fontSize: 12 }}>{outcome}</span>
                </div>
                {done && item.concept && <p className="shelf-maintenance-note">共同概念：{item.concept}</p>}
                <p className="shelf-maintenance-note" style={{ whiteSpace: 'pre-wrap' }}>{done ? item.summary || '已完成检查，未保存具体结论。' : '检查尚未完成，处理结论将在完成后保存。'}</p>
                {done && item.outcome === 'merged' && Boolean(item.mergedDocIds?.length) && <p className="shelf-maintenance-note">新整合文档：{item.mergedDocIds!.map((id, index) => {
                  const target = documentById.get(id);
                  return <span key={id}>{index > 0 && '、'}<button className="text-button" style={{ display: 'inline', padding: 0, fontSize: 'inherit', whiteSpace: 'normal' }} onClick={() => onDocumentId(id)}>{target?.title || run.items.find(candidate => candidate.documentId === id)?.title || '打开整合文档'}</button></span>;
                })}。参与原稿已归档，可查看原文与历史。</p>}
              </section>;
            }) : <p className="shelf-maintenance-note">本次没有待检查文档。</p>}
          </div>
          <button className="text-button shelf-maintenance-start" onClick={() => onTask(run.taskId)}>{run.diffCount > 0 ? '查看差异与审核记录' : '查看本次研究'}<ChevronRight size={15} /></button>
        </details>
      </> : <p className="shelf-maintenance-summary">{empty ? '收集资料或保存 Markdown 文档后，就可以在这里检查同概念合并与知识差异。' : !state ? '暂时无法读取维护状态。' : !state.pendingCount ? '上次维护后没有新入库的 .md 文档。' : state.lastCompletedAt ? `上次维护后新增 ${state.pendingCount} 篇 .md，等待同概念合并与差异检查。` : `首次维护将检查书架中现有的 ${state.pendingCount} 篇 .md。`}</p>}
      {(error || run?.error) && <p className="shelf-maintenance-error" role="alert">{error || run?.error}</p>}
      {state && finished && state.pendingCount > 0 && <p className="shelf-maintenance-note">还有 {state.pendingCount} 篇新入库的文档等待下一次维护。</p>}
      {state && finished && state.pendingCount === 0 && <p className="shelf-maintenance-note">上次维护后没有新入库的 .md 文档。</p>}
      {(waiting || missingModel || (!running && locked) || (error && !running && !resumable)) && <div className="shelf-maintenance-recovery">{waiting ? <><p>{conflictTaskId ? '维护进度与疑似差异已保留，请在原研究中查看并处理。' : '需要补充信息，请打开本次研究继续。'}</p>{(conflictTaskId || run?.taskId) && <button className="text-button" onClick={() => onTask(conflictTaskId || run!.taskId)}>查看研究<ChevronRight size={15} /></button>}</> : missingModel ? <><p>配置文本模型后，可以继续同概念合并与知识差异检查。</p><button className="text-button" onClick={onSettings}><Settings2 size={15} />配置文本模型</button></> : locked ? <p>请先完成或暂停正在进行的研究，再维护书架。</p> : <button className="text-button" disabled={Boolean(action)} onClick={onRetry}><RefreshCw size={15} />重新尝试</button>}</div>}
      {state && !run && state.pendingCount > 0 && configured && !locked && !action && !error && <button className="text-button shelf-maintenance-start" onClick={() => onAction('start')}><RefreshCw size={15} />开始维护</button>}
    </section>
    <p className="shelf-maintenance-footnote">上次维护：{state?.lastCompletedAt ? dateText(state.lastCompletedAt, true) : '尚未维护'}{run && run.status !== 'completed' && ' · 进度自动保存'}</p>
  </div>;
}

function MoveDocument({ document, categories, busy, error, close, move }: { document: DocumentMeta; categories: Category[]; busy: boolean; error: string; close: () => void; move: (id: string) => void }) {
  const [target, setTarget] = useState(document.categoryId);
  return <Modal title="移动文档" close={close}><form className="modal-form" onSubmit={event => { event.preventDefault(); move(target); }}><p className="shelf-move-title"><FileText size={18} />{document.title}</p><p className="field-help">当前目录：{categoryPath(categories, document.categoryId)}</p>{error && <ErrorNotice>{error}</ErrorNotice>}<label>目标目录<select autoFocus value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>{categories.map(category => <option key={category.id} value={category.id}>{categoryPath(categories, category.id)}</option>)}</select></label><footer className="modal-footer"><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button type="submit" className="primary" disabled={busy || !target || target === document.categoryId}><ArrowRightLeft size={16} />{busy ? '移动中…' : '移动到这里'}</button></footer></form></Modal>;
}
