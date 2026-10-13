import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleX, File, FileClock, FileText, Info, LoaderCircle, MessageSquare, Minus, Paperclip, Pause, Play, Plus, Search, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import type { Category, Conflict, DocumentMeta, MaterialStage, Task, TaskDetail, Upload } from '../shared/types';
import { DraftView } from './DocumentPanel';
import ResearchConversation from './ResearchConversation';
import { dateText, ErrorNotice, errorText, IconButton, Loading, Markdown, readLocal, removeLocal, scopeLocalKey, Sources, stageText, Status, writeLocal } from './ui';

interface Props {
  tasks: Task[];
  detail: TaskDetail | null;
  taskId: string | null;
  taskLoading: boolean;
  contextIds: string[];
  contextDocuments: Record<string, DocumentMeta>;
  categories: Category[];
  streaming: string;
  locked: boolean;
  lockedTaskId?: string;
  configured: boolean;
  onTask: (id: string | null) => void;
  onContextRemove: (id: string) => void;
  onContextOpen: (id: string) => void;
  onUpdated: (taskId?: string) => Promise<void>;
  onSettings: () => void;
  onRaw: (id: string) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}

function filesToUploads(files: File[]): Promise<Upload[]> {
  return Promise.all(files.map(file => new Promise<Upload>((resolve, reject) => {
    if (file.size > 32 * 1024 * 1024) { reject(new Error(`「${file.name}」超过拖拽上传的 32 MB 限制。请通过附件按钮选择本地视频/音频（最多 512 MB）。`)); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取「${file.name}」，请重新选择。`));
    reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', data: String(reader.result).split(',').slice(1).join(',') });
    reader.readAsDataURL(file);
  })));
}

export default function ResearchPanel(props: Props) {
  const { detail, taskId, contextIds, configured, locked, lockedTaskId } = props;
  const key = taskId || 'new';
  const recoveryKey = scopeLocalKey(`research-shelf:composer:${key}`);
  const [text, setText] = useState(() => readLocal<string>(recoveryKey, ''));
  const [uploadMap, setUploadMap] = useState<Record<string, Upload[]>>({});
  const uploads = uploadMap[key] || [];
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const task = detail?.task;
  const running = task?.status === 'running' || task?.status === 'queued';
  const mayMessage = !locked || (Boolean(taskId) && taskId === lockedTaskId);
  const mayImport = !locked;
  const pendingDrafts = detail?.drafts.filter(draft => draft.status !== 'published') || [];
  const waitingElsewhere = locked && taskId !== lockedTaskId;
  useEffect(() => { setText(readLocal<string>(recoveryKey, '')); setError(''); isNearBottom.current = true; }, [recoveryKey]);
  useEffect(() => { const node = logRef.current; if (node && isNearBottom.current) node.scrollTop = node.scrollHeight; }, [detail, props.streaming]);
  function updateText(value: string) { setText(value); writeLocal(recoveryKey, value); }
  function addUploads(items: Upload[]) { setUploadMap(previous => ({ ...previous, [key]: [...(previous[key] || []), ...items] })); }
  async function chooseFiles() {
    setError(''); setReadingFiles(true);
    try { const chosen = await window.shelf.chooseFiles(); addUploads(chosen); } catch (cause) { setError(errorText(cause)); } finally { setReadingFiles(false); }
  }
  async function dropFiles(event: React.DragEvent) {
    event.preventDefault(); setDragging(false);
    if (!mayImport) { setError('正在处理知识冲突，暂时不能导入新材料。可在当前冲突下补充说明或证据链接。'); return; }
    setError(''); setReadingFiles(true);
    try { addUploads(await filesToUploads(Array.from(event.dataTransfer.files))); } catch (cause) { setError(errorText(cause)); } finally { setReadingFiles(false); }
  }
  async function send() {
    if (sending || (!text.trim() && !uploads.length) || !mayMessage) return;
    setSending(true); setError('');
    try {
      const result = await window.shelf.call<Task>(taskId ? 'task.message' : 'task.start', taskId ? { taskId, text, uploads, selectedDocIds: contextIds } : { text, uploads, selectedDocIds: contextIds });
      removeLocal(recoveryKey); setText(''); setUploadMap(previous => ({ ...previous, [key]: [] }));
      isNearBottom.current = true;
      await props.onUpdated(result.id);
    } catch (cause) { setError(errorText(cause)); } finally { setSending(false); }
  }
  async function control(method: 'task.resume' | 'task.pause') {
    setActionBusy(true); setError('');
    try { await window.shelf.call(method, { taskId }); await props.onUpdated(); } catch (cause) { setError(errorText(cause)); } finally { setActionBusy(false); }
  }
  const conversationTitle = task?.title || '新的研究';
  return <>
    <div className="panel-heading research-heading"><h2><MessageSquare size={18} />研究</h2><IconButton label="新建研究对话" disabled={locked || sending} onClick={() => props.onTask(null)}><Plus size={18} /></IconButton></div>
    <div className="task-selector"><label className="sr-only" htmlFor="task-select">选择研究对话</label><select id="task-select" value={taskId ?? ''} onChange={event => props.onTask(event.target.value || null)}><option value="">新的研究</option>{props.tasks.map(item => <option key={item.id} value={item.id}>{item.title} · {dateText(item.updatedAt)}</option>)}</select><ChevronDown size={15} /></div>
    <div className="research-context"><div className="context-heading"><span>研究上下文</span><span>{contextIds.length ? `${contextIds.length} 篇` : '未选文档'}</span></div>{contextIds.length > 0 ? <div className="context-chips">{contextIds.map(id => <div className="context-chip" key={id}><button onClick={() => props.onContextOpen(id)} title={props.contextDocuments[id]?.title || id}><FileText size={13} /><span>{props.contextDocuments[id]?.title || id}</span></button><IconButton label={`移除上下文：${props.contextDocuments[id]?.title || id}`} disabled={locked} onClick={() => props.onContextRemove(id)}><X size={12} /></IconButton></div>)}</div> : <p>可在左侧勾选文档，也可直接从材料开始。</p>}</div>
    {task && <div className="task-state"><Status status={task.status} /><span className="truncate" title={stageText(task.stage)}>{stageText(task.stage)}</span>{running && <IconButton label="暂停当前研究" disabled={actionBusy} onClick={() => void control('task.pause')}><Pause size={15} /></IconButton>}{['paused', 'failed', 'unconfigured'].includes(task.status) && <button className="text-button" disabled={actionBusy || waitingElsewhere || !configured} onClick={() => void control('task.resume')}><Play size={14} />继续</button>}</div>}
    <div className="conversation-scroll" ref={logRef} onScroll={() => { const node = logRef.current; if (node) { isNearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; setShowBottom(!isNearBottom.current); } }}>
      {props.taskLoading ? <Loading label="正在恢复研究对话…" /> : !detail ? <div className="research-empty"><div className="research-empty-icon"><Search size={25} strokeWidth={1.6} /></div><h3>把线索交给研究助手</h3><p>粘贴链接、分享文本或研究问题。也可以拖入截图、论文与文件。</p><div className="research-flow"><span>获取来源</span><span>理解与比较</span><span>持续更新文档</span></div><p className="muted">需要保存的知识会自动整理成草稿；遇到真实冲突时，由你决定采用的说法。</p>{!configured && <button className="secondary" onClick={props.onSettings}>先配置文本模型</button>}</div> : <>
        <div className="conversation-title"><h3>{conversationTitle}</h3><time>{dateText(task?.createdAt, true)}</time></div>
        <ResearchConversation detail={detail} streaming={props.streaming} documents={props.contextDocuments} onDocument={props.onContextOpen} onRaw={props.onRaw} />
        {pendingDrafts.length > 0 && <details className="task-drafts disclosure" key={`drafts-${detail.task.id}`}><summary><ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" /><FileClock size={16} aria-hidden="true" /><span>待处理草稿</span><span className="muted">{pendingDrafts.length} 份</span></summary>{pendingDrafts.map(draft => <DraftView key={draft.draftId} draft={draft} />)}</details>}
        {detail.conflicts.map(conflict => <ConflictCard key={conflict.id} conflict={conflict} onUpdated={() => props.onUpdated()} onRaw={props.onRaw} />)}
        {task?.error && <ErrorNotice>{task.error}</ErrorNotice>}
      </>}
    </div>
    {showBottom && <button className="jump-bottom secondary" onClick={() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }}><ArrowDown size={14} />最新消息</button>}
    <div className={`composer-area ${dragging ? 'dragging' : ''}`} onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => void dropFiles(event)}>
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
      {waitingElsewhere && <div className="notice warning"><ShieldAlert size={16} /><div>请先在原研究对话中处理知识冲突。<button className="text-button" onClick={() => props.onTask(lockedTaskId!)}>前往冲突</button></div></div>}
      {!configured && <div className="composer-configuration"><Info size={15} /><span>文本模型尚未配置</span><button className="text-button" onClick={props.onSettings}>配置</button></div>}
      {uploads.length > 0 && <div className="attachment-list">{uploads.map((upload, index) => <div className="attachment" key={`${upload.name}-${index}`}><File size={14} /><span title={upload.name}>{upload.name}</span><IconButton label={`移除附件：${upload.name}`} disabled={sending} onClick={() => setUploadMap(previous => ({ ...previous, [key]: (previous[key] || []).filter((_, itemIndex) => index !== itemIndex) }))}><X size={13} /></IconButton></div>)}</div>}
      {readingFiles && <Loading label="正在读取附件…" />}
      <label className="sr-only" htmlFor="research-input">研究问题与材料</label><textarea id="research-input" ref={props.composerRef} value={text} disabled={sending || !mayMessage} onChange={event => updateText(event.target.value)} placeholder={locked && mayMessage ? '围绕当前冲突追问，或补充证据…' : '粘贴材料、链接，或提出研究问题…'} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (configured && !running) void send(); } }} />
      <footer className="composer-footer"><IconButton label="选择图片、文档、视频、音频或字幕" disabled={!mayImport || sending || readingFiles} onClick={() => void chooseFiles()}><Paperclip size={18} /></IconButton><span>{running ? '研究正在进行，可先保留下一条问题' : 'Ctrl + Enter 发送'}</span><button className="send-button primary" aria-label={taskId ? '发送后续问题' : '开始研究'} disabled={sending || readingFiles || !configured || !mayMessage || running || (!text.trim() && !uploads.length)} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}</button></footer>
      {dragging && <div className="drop-indicator"><Paperclip size={24} />松开以添加文件</div>}
    </div>
  </>;
}

const materialStageLabels: Record<MaterialStage['status'], string> = { ok: '完成', partial: '部分完成', failed: '失败', skipped: '未执行' };
export function MaterialStages({ stages, compact = false }: { stages?: MaterialStage[]; compact?: boolean }) {
  if (!Array.isArray(stages)) return null;
  const visible = stages.filter(stage => stage && typeof stage.name === 'string' && Object.hasOwn(materialStageLabels, stage.status));
  if (!visible.length) return null;
  return <span className="material-stages" aria-label="材料处理阶段">{visible.map((stage, index) => <span key={`${stage.name}-${index}`} className={`material-stage stage-${stage.status}`} title={stage.detail}>{stage.status === 'failed' ? <CircleX size={13} aria-hidden="true" /> : stage.status === 'ok' ? <Check size={13} aria-hidden="true" /> : stage.status === 'partial' ? <TriangleAlert size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}<span><strong>{stage.name} · {materialStageLabels[stage.status]}</strong>{!compact && stage.detail ? `：${stage.detail}` : ''}</span></span>)}</span>;
}

export function ConflictCard({ conflict, onUpdated, onRaw }: {conflict: Conflict; onUpdated: () => Promise<void>; onRaw: (id: string) => void}) {
  const recoveryKey = scopeLocalKey(`research-shelf:conflict:${conflict.id}`);
  const [conditionsA, setConditionsA] = useState(conflict.conditionsA || '');
  const [conditionsB, setConditionsB] = useState(conflict.conditionsB || '');
  const [showConditions, setShowConditions] = useState(false);
  const [other, setOther] = useState(() => readLocal<string>(recoveryKey, ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (conflict.conditionsA) setConditionsA(conflict.conditionsA); if (conflict.conditionsB) setConditionsB(conflict.conditionsB); }, [conflict.conditionsA, conflict.conditionsB]);
  async function resolve(decision: 'A' | 'B' | 'C') {
    setBusy(true); setError('');
    try { await window.shelf.call('conflict.resolve', { id: conflict.id, decision, conditionsA: decision === 'C' ? conditionsA : undefined, conditionsB: decision === 'C' ? conditionsB : undefined }); await onUpdated(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function followup() {
    setBusy(true); setError('');
    try { await window.shelf.call('task.message', { taskId: conflict.taskId, text: `关于当前冲突的补充或追问（不是裁决）：\n${other}` }); setOther(''); removeLocal(recoveryKey); await onUpdated(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  if (conflict.status === 'dismissed' || conflict.status === 'resolved') return <details className="resolved-conflict"><summary><Check size={16} />{conflict.status === 'dismissed' ? '疑似冲突已核实解除' : `冲突已裁决：${conflict.decision || '已处理'}`}</summary><p>{conflict.resolution || conflict.review || conflict.reason}</p>{conflict.conditionsA && <p>A 的条件：{conflict.conditionsA}</p>}{conflict.conditionsB && <p>B 的条件：{conflict.conditionsB}</p>}</details>;
  return <section className={`conflict-card ${conflict.status}`} aria-label="知识冲突裁决"><header><ShieldAlert size={19} /><h3>{conflict.status === 'suspected' ? '发现疑似冲突，正在核实' : '两种说法需要你的裁决'}</h3></header><p className="conflict-reason">{conflict.reason}</p><div className="claim"><strong>A · 旧说法</strong><Markdown compact>{conflict.oldClaim}</Markdown></div><div className="claim"><strong>B · 新说法</strong><Markdown compact>{conflict.newClaim}</Markdown></div>{conflict.review && <div className="conflict-review"><h4>核实结果</h4><Markdown compact>{conflict.review}</Markdown></div>}{conflict.evidence.length > 0 && <details className="conflict-evidence" open><summary>核实依据 · {conflict.evidence.length} 个来源</summary><Sources sources={conflict.evidence} onRaw={onRaw} /></details>}{error && <ErrorNotice>{error}</ErrorNotice>}
    {conflict.status === 'confirmed' ? <><p className="conflict-help">选择后将恢复原研究。其他编辑和导入会保持暂停，直到所有冲突处理完毕。</p><div className="conflict-actions"><button className="secondary" disabled={busy} onClick={() => void resolve('A')}>A · 保留上方旧说法</button><button className="secondary" disabled={busy} onClick={() => void resolve('B')}>B · 采纳上方新说法</button><button className="secondary" disabled={busy} aria-expanded={showConditions} onClick={() => setShowConditions(!showConditions)}>C · 明确区分适用条件</button></div>{showConditions && <div className="conditions-form"><label>A 适用的具体条件<textarea value={conditionsA} onChange={event => setConditionsA(event.target.value)} placeholder="写明对象、版本、前提或指标等区别" rows={3} /></label><label>B 适用的具体条件<textarea value={conditionsB} onChange={event => setConditionsB(event.target.value)} placeholder="写明与 A 不同的明确条件" rows={3} /></label><p className="field-help">“可能都对”或“场景不同”不构成条件区分。</p><button className="primary" disabled={busy || !conditionsA.trim() || !conditionsB.trim() || conditionsA.trim() === conditionsB.trim()} onClick={() => void resolve('C')}>确认两组条件并采纳 C</button></div>}</> : <div className="notice info"><LoaderCircle size={16} className="spin" /><span>核实期间暂停其他业务操作。确认冲突后，会在这里提供 A / B / C 裁决。</span></div>}
    <div className="conflict-other"><label>Other · 追问或补充说明<textarea value={other} onChange={event => { setOther(event.target.value); writeLocal(recoveryKey, event.target.value); }} rows={3} placeholder="例如：请解释支持 B 的证据，以及它的适用条件。" /></label><div><span>补充说明不会解除冲突。</span><button className="text-button" disabled={busy || !other.trim()} onClick={() => void followup()}>发送追问</button></div></div>
  </section>;
}
