import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleDashed, ExternalLink, File, FolderOpen, LoaderCircle, MessageSquare, Minus, Paperclip, Pause, Play, Plus, RotateCcw, Upload as UploadIcon, X } from 'lucide-react';
import type { Category, DocumentMeta, KnowledgeDocument, RawMaterial, Task, TaskDetail, TaskInput, Upload } from '../shared/types';
import type { UsageGroupSummary, UsageSummary, UsageTotals } from '../shared/usage';
import { DraftView } from './DocumentPanel';
import { ConflictCard } from './ResearchPanel';
import { TurnUsage } from './ResearchConversation';
import { dateText, ErrorNotice, errorText, IconButton, Loading, Markdown, readLocal, removeLocal, stageText, writeLocal } from './ui';
import './ingestion.css';

interface Props {
  active: boolean;
  tasks: Task[];
  taskId: string | null;
  revision: number;
  categories: Category[];
  configured: boolean;
  locked: boolean;
  lockedTaskId?: string;
  streaming: string;
  onSelect: (id: string | null) => void;
  onUpdated: () => Promise<void>;
  onDocument: (id: string) => void;
  onRaw: (id: string) => void;
  onSettings: () => void;
  onLibrary: () => void;
  onTask: (id: string) => void;
}

const statusText: Record<Task['status'], string> = { queued: '等待开始', running: '正在入库', waiting_user: '等待回复', paused: '已暂停', failed: '执行失败', completed: '已完成', unconfigured: '待配置模型' };
const outcomeText: Record<TaskInput['status'], string> = { pending: '等待处理', published: '已入库', answered: '已回答', skipped: '已跳过', blocked: '处理失败' };
const numberFields: (keyof Omit<UsageTotals, 'hasUnknown'>)[] = ['requests', 'successfulRequests', 'failedRequests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheMissTokens', 'cacheWriteTokens', 'audioSeconds', 'estimatedMinCny', 'estimatedMaxCny', 'unknownRequests'];
function emptyUsage(): UsageTotals { return { requests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, cacheWriteTokens: 0, audioSeconds: 0, estimatedMinCny: 0, estimatedMaxCny: 0, unknownRequests: 0, hasUnknown: false }; }
function batchUsage(detail: TaskDetail): UsageSummary | undefined {
  const summaries = detail.turns.flatMap(turn => turn.usage ? [turn.usage] : []);
  if (!summaries.length) return undefined;
  const totals = emptyUsage(), groups = new Map<string, UsageGroupSummary>();
  for (const summary of summaries) {
    for (const field of numberFields) totals[field] += summary[field];
    totals.hasUnknown ||= summary.hasUnknown;
    for (const group of summary.groups) {
      const key = JSON.stringify([group.purpose, group.provider, group.model]);
      const combined = groups.get(key) || { ...emptyUsage(), purpose: group.purpose, provider: group.provider, model: group.model };
      for (const field of numberFields) combined[field] += group[field];
      combined.hasUnknown ||= group.hasUnknown;
      groups.set(key, combined);
    }
  }
  return { ...totals, groups: [...groups.values()] };
}
function elapsedText(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${seconds % 60} 秒`].filter(Boolean).join(' ');
}
function inputSource(input: TaskInput, sources: RawMaterial[]) {
  const linked = input.sourceIds.flatMap(id => sources.find(source => source.id === id) || []).reverse();
  return linked.find(source => source.title && !/^https?:\/\//i.test(source.title)) || linked[0];
}
function droppedFiles(files: File[]): Promise<Upload[]> {
  return Promise.all(files.map(file => new Promise<Upload>((resolve, reject) => {
    if (file.size > 32 * 1024 * 1024) { reject(new Error(`「${file.name}」超过拖拽的 32 MB 限制，请使用「选择文件」导入（最多 512 MB）。`)); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取「${file.name}」，请重新选择。`));
    reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', data: String(reader.result).split(',').slice(1).join(',') });
    reader.readAsDataURL(file);
  })));
}

export default function IngestionPanel(props: Props) {
  const batches = props.tasks.filter(task => task.kind === 'ingestion');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState(() => readLocal<string>('research-shelf:ingestion-composer', ''));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [documents, setDocuments] = useState<Record<string, DocumentMeta>>({});
  const [reasons, setReasons] = useState<string[]>([]);
  const [reply, setReply] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const selectedId = useRef(props.taskId);
  selectedId.current = props.taskId;
  const task = detail?.task.id === props.taskId ? detail.task : null;
  const running = task?.status === 'running' || task?.status === 'queued';
  const activeTask = props.tasks.find(item => item.status === 'running' || item.status === 'queued');
  const otherRunning = activeTask && activeTask.id !== props.taskId;
  const mayStart = !props.locked && !activeTask && !busy && !readingFiles;
  const mayControl = !busy && !otherRunning && !props.locked && props.configured;

  useEffect(() => {
    setReasons([]); setError('');
    setReply(props.taskId ? readLocal<string>(`research-shelf:ingestion-reply:${props.taskId}`, '') : '');
  }, [props.taskId]);
  useEffect(() => {
    if (!props.taskId) { setDetail(null); setLoading(false); return; }
    if (!props.active) return;
    let valid = true;
    if (detail?.task.id !== props.taskId) { setDetail(null); setLoading(true); }
    window.shelf.call<TaskDetail>('task', { id: props.taskId }).then(result => {
      if (valid) setDetail(result);
    }).catch(cause => { if (valid) setError(errorText(cause)); }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [props.taskId, props.revision, props.active]);

  const publications = useMemo(() => {
    const found = new Map<string, { id: string; title: string; version?: number }>();
    if (!detail || detail.task.id !== props.taskId) return [];
    for (const turn of detail.turns) for (const item of turn.publications || []) {
      const previous = found.get(item.id);
      if (!previous || (previous.version || 0) <= item.version) found.set(item.id, item);
    }
    for (const draft of detail.drafts.filter(item => item.status === 'published')) {
      const previous = found.get(draft.id), version = draft.publishedVersion || draft.version;
      if (!previous || (previous.version || 0) <= version) found.set(draft.id, { id: draft.id, title: draft.title, version });
    }
    for (const input of detail.inputs.filter(item => item.status === 'published')) for (const id of input.documentIds) {
      if (!found.has(id)) found.set(id, { id, title: documents[id]?.title || '已入库文档', version: documents[id]?.version });
    }
    return [...found.values()];
  }, [detail, props.taskId, documents]);
  useEffect(() => {
    const missing = publications.filter(item => !documents[item.id]).map(item => item.id);
    if (!missing.length) return;
    let valid = true;
    void Promise.allSettled(missing.map(id => window.shelf.call<KnowledgeDocument>('document', { id }))).then(results => {
      if (!valid) return;
      const found: Record<string, DocumentMeta> = {};
      results.forEach(result => { if (result.status === 'fulfilled') found[result.value.id] = result.value; });
      if (Object.keys(found).length) setDocuments(previous => ({ ...previous, ...found }));
    });
    return () => { valid = false; };
  }, [publications, documents]);

  async function changed() { await props.onUpdated(); }
  async function chooseFiles() {
    setReadingFiles(true); setError('');
    try {
      const chosen = await window.shelf.chooseFiles();
      if (uploads.length + chosen.length > 12) throw new Error('每批最多添加 12 个文件，请分批导入。');
      setUploads(previous => [...previous, ...chosen]);
    }
    catch (cause) { setError(errorText(cause)); } finally { setReadingFiles(false); }
  }
  async function drop(event: React.DragEvent) {
    event.preventDefault(); setDragging(false);
    if (props.locked || busy || readingFiles) return;
    setReadingFiles(true); setError('');
    try {
      const files = Array.from(event.dataTransfer.files);
      if (uploads.length + files.length > 12) throw new Error('每批最多添加 12 个文件，请分批导入。');
      const chosen = await droppedFiles(files); setUploads(previous => [...previous, ...chosen]);
    }
    catch (cause) { setError(errorText(cause)); } finally { setReadingFiles(false); }
  }
  async function start() {
    if (!mayStart || (!text.trim() && !uploads.length)) return;
    setBusy(true); setError('');
    try {
      const result = await window.shelf.call<Task>('task.start', { kind: 'ingestion', text, uploads, selectedDocIds: [] });
      setText(''); setUploads([]); removeLocal('research-shelf:ingestion-composer');
      props.onSelect(result.id); await changed();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function action(method: 'task.pause' | 'task.resume' | 'task.retryInputs', inputIds?: string[]) {
    if (!props.taskId || busy) return;
    setBusy(true); setError('');
    try { await window.shelf.call<Task>(method, { taskId: props.taskId, ...(inputIds ? { inputIds } : {}) }); await changed(); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function answer() {
    if (!props.taskId || !reply.trim() || busy || running) return;
    const id = props.taskId;
    setBusy(true); setError('');
    try {
      await window.shelf.call<Task>('task.message', { taskId: id, text: reply });
      removeLocal(`research-shelf:ingestion-reply:${id}`);
      if (selectedId.current === id) setReply('');
      await changed();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  function newBatch() { props.onSelect(null); setTimeout(() => composer.current?.focus(), 0); }

  const inputs = task ? detail!.inputs : [];
  const failed = inputs.filter(input => input.status === 'blocked');
  const pending = inputs.filter(input => input.status === 'pending');
  const published = inputs.filter(input => input.status === 'published');
  const other = inputs.filter(input => input.status === 'answered' || input.status === 'skipped');
  const publicationMap = new Map(publications.map(publication => [publication.id, publication]));
  const shownPublications = new Set<string>();
  const resultRows: ({ kind: 'document'; publication: (typeof publications)[number] } | { kind: 'input'; input: TaskInput })[] = [];
  for (const input of inputs) {
    if (input.status !== 'published') { resultRows.push({ kind: 'input', input }); continue; }
    for (const id of input.documentIds) {
      const publication = publicationMap.get(id);
      if (publication && !shownPublications.has(id)) { resultRows.push({ kind: 'document', publication }); shownPublications.add(id); }
    }
  }
  for (const publication of publications) if (!shownPublications.has(publication.id)) resultRows.push({ kind: 'document', publication });
  const question = task?.status === 'waiting_user' && !detail?.conflicts.some(conflict => conflict.status === 'suspected' || conflict.status === 'confirmed') ? [...(detail?.messages || [])].reverse().find(message => message.role === 'assistant') : undefined;
  const categoryName = (id?: string) => props.categories.find(category => category.id === id)?.name;

  return <div className="ingestion-page" hidden={!props.active}>
    <aside className="ingestion-sidebar" aria-label="入库记录">
      <header><h2>入库记录</h2><IconButton label="新建入库批次" onClick={newBatch}><Plus size={20} /></IconButton></header>
      <div className="ingestion-history">
        {!batches.length && <p className="ingestion-history-empty">还没有入库记录。<br />从右侧提交第一批资料。</p>}
        {batches.map(batch => {
          const summary = detail?.task.id === batch.id ? { total: detail.inputs.length, blocked: detail.inputs.filter(input => input.status === 'blocked').length } : batch.inputSummary;
          return <button className="ingestion-history-item" key={batch.id} aria-current={props.taskId === batch.id ? 'true' : undefined} onClick={() => props.onSelect(batch.id)}>
            <strong>{batch.title}</strong><span><time>{dateText(batch.createdAt)}</time>{summary ? <span> · {summary.total} 项</span> : null}<small className={summary?.blocked || batch.status === 'failed' ? 'has-error' : ''}>{summary?.blocked ? `${summary.blocked} 项失败` : batch.status !== 'completed' ? statusText[batch.status] : ''}</small></span>
          </button>;
        })}
      </div>
      <button className="ingestion-back secondary" onClick={props.onLibrary}><ChevronLeft size={18} />返回书架</button>
    </aside>
    <main className="ingestion-main" aria-label="资料入库">
      <div className="ingestion-content">
        <header className="ingestion-heading"><h1>资料入库</h1><p>粘贴链接、分享文字，或拖入文件。</p></header>
        <section className={`ingestion-composer ${dragging ? 'is-dragging' : ''}`} aria-label="提交新一批资料" onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => void drop(event)}>
          <label className="sr-only" htmlFor="ingestion-input">新一批资料</label>
          <textarea id="ingestion-input" ref={composer} value={text} disabled={busy || props.locked} onChange={event => { setText(event.target.value); writeLocal('research-shelf:ingestion-composer', event.target.value); }} rows={4} placeholder={'在这里粘贴资料，支持一次多个链接\n抖音 / 小红书 / 公众号 / 网页 / 论文'} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }} />
          {uploads.length > 0 && <div className="attachment-list">{uploads.map((upload, index) => <div className="attachment" key={`${upload.name}-${index}`}><File size={15} /><span title={upload.name}>{upload.name}</span><IconButton label={`移除附件：${upload.name}`} disabled={busy} onClick={() => setUploads(previous => previous.filter((_, position) => position !== index))}><X size={14} /></IconButton></div>)}</div>}
          <div className="ingestion-composer-actions"><button className="secondary ingestion-file" disabled={busy || readingFiles || props.locked} onClick={() => void chooseFiles()}>{readingFiles ? <LoaderCircle size={19} className="spin" /> : <Paperclip size={19} />}选择文件</button><span className="ingestion-auto"><FolderOpen size={18} />自动分类到书架</span><button className="primary ingestion-start" disabled={!mayStart || (!text.trim() && !uploads.length)} onClick={() => void start()}>{busy ? <LoaderCircle size={19} className="spin" /> : <UploadIcon size={20} />}开始入库</button></div>
          {dragging && <div className="ingestion-drop"><Paperclip size={28} />松开以添加文件</div>}
        </section>
        {!props.configured && <div className="notice info ingestion-notice"><span>可以先保存资料，配置文本模型后继续自动入库。</span><button className="text-button" onClick={props.onSettings}>打开设置</button></div>}
        {otherRunning && <div className="notice info ingestion-notice"><span>另一个任务正在运行，完成或暂停后可开始新一批。</span><button className="text-button" onClick={() => props.onTask(activeTask!.id)}>查看任务</button></div>}
        {props.locked && props.lockedTaskId !== props.taskId && <div className="notice warning ingestion-notice"><span>请先处理当前知识冲突，再导入新资料。</span><button className="text-button" onClick={() => props.lockedTaskId && props.onTask(props.lockedTaskId)}>查看冲突</button></div>}
        {error && <div className="ingestion-notice"><ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice></div>}
        {loading ? <Loading label="正在读取入库记录…" /> : !task || !detail ? <div className="ingestion-empty"><FolderOpen size={27} strokeWidth={1.5} /><h2>资料整理好后，会出现在这里</h2><p>每批独立处理，结果自动归入书架。遇到失败可以单独重试。</p></div> : <>
          <section className="ingestion-results" aria-label="本批结果">
            <header className="ingestion-results-heading"><h2>本批结果</h2><p aria-live="polite">{inputs.length} 项{published.length > 0 && ` · ${published.length} 项已入库`}{failed.length > 0 && <span className="has-error"> · {failed.length} 项失败</span>}{pending.length > 0 && ` · ${pending.length} 项待处理`}{other.length > 0 && ` · ${other.length} 项已说明`}</p>{failed.length > 0 && <button className="text-button ingestion-retry-all" disabled={!mayControl || running} onClick={() => void action('task.retryInputs', failed.map(input => input.id))}><RotateCcw size={17} />重试失败项</button>}</header>
            {(running || task.status === 'paused' || task.status === 'failed' || task.status === 'unconfigured') && <div className={`ingestion-run-state ${task.status === 'failed' ? 'has-error' : ''}`} role="status">{running ? <LoaderCircle size={16} className="spin" /> : task.status === 'failed' ? <X size={16} /> : <Pause size={16} />}<span>{running ? stageText(task.stage) : statusText[task.status]}</span>{running ? <button className="text-button" disabled={busy} onClick={() => void action('task.pause')}><Pause size={14} />暂停</button> : <button className="text-button" disabled={!mayControl} onClick={() => void action('task.resume')}><Play size={14} />继续处理</button>}</div>}
            <div className="ingestion-result-list">
              {resultRows.map(row => {
                if (row.kind === 'document') {
                  const { publication } = row;
                  return <article className="ingestion-result is-success" key={`document-${publication.id}`}><span className="ingestion-result-icon"><Check size={20} aria-hidden="true" /></span><div className="ingestion-result-copy"><h3>{publication.title}</h3><p>{categoryName(documents[publication.id]?.categoryId) || categoryName(detail.drafts.find(draft => draft.id === publication.id)?.categoryId)}{(documents[publication.id]?.categoryId || detail.drafts.find(draft => draft.id === publication.id)?.categoryId) && ' · '}{publication.version ? `已发布 v${publication.version}` : '已入库'}</p></div><button className="text-button ingestion-result-open" onClick={() => props.onDocument(publication.id)}>打开文档<ExternalLink size={16} /></button></article>;
                }
                const { input } = row;
                const source = inputSource(input, detail.sources), expanded = reasons.includes(input.id);
                return <article className={`ingestion-result ${input.status === 'blocked' ? 'is-failure' : 'is-pending'}`} key={input.id}>
                  <span className="ingestion-result-icon">{input.status === 'blocked' ? <X size={20} aria-hidden="true" /> : input.status === 'pending' ? <CircleDashed size={20} aria-hidden="true" /> : input.status === 'answered' ? <MessageSquare size={18} aria-hidden="true" /> : <Minus size={20} aria-hidden="true" />}</span>
                  <div className="ingestion-result-copy"><h3>{source?.title || source?.url || '提交的材料'}</h3><p>{outcomeText[input.status]}{input.reason ? ` · ${input.reason}` : source?.kind ? ` · ${source.kind}` : ''}</p></div>
                  <div className="ingestion-result-actions">{input.status === 'blocked' && <button className="text-button" disabled={!mayControl || running} onClick={() => void action('task.retryInputs', [input.id])}>重试</button>}<button className="text-button" aria-expanded={expanded} aria-controls={`input-reason-${input.id}`} onClick={() => setReasons(previous => expanded ? previous.filter(id => id !== input.id) : [...previous, input.id])}>{input.status === 'blocked' ? '查看原因' : '查看详情'}</button></div>
                  {expanded && <div className="ingestion-result-detail" id={`input-reason-${input.id}`}><p>{input.reason || source?.error || source?.coverage || '这项材料正在等待处理。'}</p>{source && <button className="text-button" onClick={() => props.onRaw(source.id)}>查看原始材料</button>}</div>}
                </article>;
              })}
              {!inputs.length && !publications.length && <p className="ingestion-awaiting">{running ? '正在获取这批资料，处理结果会陆续显示。' : '这批资料暂时没有入库结果。'}</p>}
            </div>
            {task.error && <ErrorNotice>{task.error}</ErrorNotice>}
          </section>
          {question && <section className="ingestion-question"><h2>需要你补充</h2><Markdown compact>{question.content}</Markdown><label htmlFor="ingestion-reply">你的回复</label><textarea id="ingestion-reply" value={reply} disabled={busy} rows={3} placeholder="补充必要的信息后继续这批资料…" onChange={event => { setReply(event.target.value); writeLocal(`research-shelf:ingestion-reply:${task.id}`, event.target.value); }} /><button className="primary" disabled={busy || !reply.trim() || !props.configured || Boolean(otherRunning)} onClick={() => void answer()}>回复并继续</button></section>}
          {detail.conflicts.map(conflict => <ConflictCard key={conflict.id} conflict={conflict} onUpdated={changed} onRaw={props.onRaw} />)}
          {detail.drafts.some(draft => draft.status !== 'published') && <details className="disclosure ingestion-drafts"><summary><ChevronRight size={15} />待处理草稿</summary>{detail.drafts.filter(draft => draft.status !== 'published').map(draft => <DraftView key={draft.draftId} draft={draft} />)}</details>}
          <BatchProcess key={task.id} detail={detail} streaming={props.streaming} />
          <div className="ingestion-cost"><TurnUsage usage={batchUsage(detail)} incomplete={detail.turns.some(turn => turn.usageHistoryIncomplete)} active={Boolean(running)} label="本批 API 费用" /></div>
        </>}
      </div>
    </main>
  </div>;
}

function BatchProcess({ detail, streaming }: { detail: TaskDetail; streaming: string }) {
  const [open, setOpen] = useState(false), [now, setNow] = useState(Date.now);
  const active = detail.task.status === 'running' || detail.task.status === 'queued';
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = detail.turns.reduce((total, turn) => total + Math.max(0, turn.elapsedMs || 0) + ((turn.status === 'running' || turn.status === 'queued') && turn.runningSince ? Math.max(0, now - Date.parse(turn.runningSince)) : 0), 0);
  const entries = useMemo(() => [
    ...detail.events.map(event => ({ id: event.id, time: event.createdAt, kind: 'event' as const, text: event.message })),
    ...detail.messages.map(message => ({ id: message.id, time: message.createdAt, kind: message.role, text: message.content })),
  ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), [detail]);
  return <details className="ingestion-process disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={17} className="ingestion-process-chevron" /><span>处理过程 · {detail.turns.length ? `用时 ${elapsedText(elapsed)}` : '用时未记录'}</span>{active && <LoaderCircle size={15} className="spin" />}<span className="ingestion-process-count">{entries.length} 条记录</span></summary>
    {open && <div className="ingestion-process-body">{entries.map(entry => entry.kind === 'event' ? <div className="progress-event" key={entry.id}><span className="event-dot" /><div><p>{entry.text}</p><time>{dateText(entry.time)}</time></div></div> : <article className={`message message-${entry.kind}`} key={entry.id}><header><span>{entry.kind === 'user' ? '提交内容' : entry.kind === 'assistant' ? '研究助手' : '任务记录'}</span><time>{dateText(entry.time)}</time></header>{entry.kind === 'assistant' ? <Markdown compact>{entry.text}</Markdown> : <p className="message-text">{entry.text}</p>}</article>)}{streaming && <article className="message message-assistant"><header>研究助手 · 正在输出</header><Markdown compact>{streaming}</Markdown></article>}{!entries.length && <p className="muted">尚无处理记录。</p>}</div>}
  </details>;
}
