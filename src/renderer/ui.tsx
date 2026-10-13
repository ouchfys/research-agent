import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { AlertCircle, ExternalLink, LoaderCircle, X } from 'lucide-react';
import type { SourceRef, TaskStatus } from '../shared/types';

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function dateText(value?: string, full = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', full ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
let localScope = '';
const globalLocalKeys = new Set(['research-shelf:left-width', 'research-shelf:right-width']);
const scopePrefix = (directory: string) => `research-shelf:scope:${encodeURIComponent(directory.replace(/\\/g, '/').toLowerCase())}:`;
export function scopeLocalKey(key: string): string {
  return !key.startsWith('research-shelf:') || key.startsWith('research-shelf:scope:') || globalLocalKeys.has(key) ? key : localScope ? scopePrefix(localScope) + key : '';
}
export function setLocalScope(directory: string): void {
  localScope = directory;
  try {
    // Bind pre-migration recovery data to only the first opened library.
    const owner = localStorage.getItem('research-shelf:legacy-scope');
    if (!owner) localStorage.setItem('research-shelf:legacy-scope', directory);
    if (!owner || owner === directory) {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('research-shelf:') || key.startsWith('research-shelf:scope:') || key === 'research-shelf:legacy-scope' || globalLocalKeys.has(key)) continue;
        const scoped = scopeLocalKey(key);
        if (localStorage.getItem(scoped) === null) localStorage.setItem(scoped, localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
    }
  } catch { /* The editor remains usable without browser persistence. */ }
}
export function copyLocalScope(previousDirectory: string, directory: string): void {
  try {
    const prefix = scopePrefix(previousDirectory), next = scopePrefix(directory);
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.setItem(next + key.slice(prefix.length), localStorage.getItem(key)!);
  } catch { /* Original recovery entries are kept if storage is full. */ }
}
export function readLocal<T>(key: string, fallback: T): T { try { const scoped = scopeLocalKey(key); return scoped ? JSON.parse(localStorage.getItem(scoped) || 'null') ?? fallback : fallback; } catch { return fallback; } }
export function writeLocal(key: string, value: unknown) { try { const scoped = scopeLocalKey(key); if (scoped) localStorage.setItem(scoped, JSON.stringify(value)); } catch { /* Editing still works when browser storage is unavailable. */ } }
export function removeLocal(key: string) { try { const scoped = scopeLocalKey(key); if (scoped) localStorage.removeItem(scoped); } catch { /* Optional recovery cache. */ } }

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {label: string; children: ReactNode}) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}
export function ErrorNotice({ children, dismiss }: { children: ReactNode; dismiss?: () => void }) {
  return <div className="notice error" role="alert"><AlertCircle size={17} /><div>{children}</div>{dismiss && <IconButton label="关闭错误提示" onClick={dismiss}><X size={16} /></IconButton>}</div>;
}
export function Loading({ label = '正在读取…' }: {label?: string}) { return <div className="loading" role="status"><LoaderCircle className="spin" size={18} />{label}</div>; }

const statusLabels: Record<TaskStatus, string> = { queued: '排队中', running: '研究中', waiting_user: '等待你回复', paused: '已暂停', failed: '执行失败', completed: '已完成', unconfigured: '待配置模型' };
export function Status({ status }: {status: TaskStatus}) { return <span className={`status status-${status}`}><span className="status-dot" />{statusLabels[status] ?? status}</span>; }
export function stageText(stage: string): string {
  const labels: Record<string, string> = { fetching: '正在获取来源', researching: '正在研究', classifying: '正在确定分类', scanning: '正在扫描简介', reading: '正在阅读候选', drafting: '正在修改草稿', self_review: '正在内容自检', reviewing_conflict: '正在核实疑似冲突', waiting_user: '等待你的回复', published: '文档已发布', completed: '研究已完成', paused: '研究已暂停', error: '执行出现错误', draft_pending: '草稿待处理', inputs_pending: '还有输入待处理', inputs_blocked: '有输入受阻，待补充', unconfigured: '请先配置文本模型', queued: '等待开始', ingesting: '正在获取材料' };
  return labels[stage] || (/^[a-z_]+$/.test(stage) ? '正在处理研究任务' : stage || '等待下一步');
}

export function Modal({ title, children, close, wide = false }: {title: string; children: ReactNode; close: () => void; wide?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    const cancel = (event: Event) => { event.preventDefault(); closeRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => { dialog?.removeEventListener('cancel', cancel); dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="dialog-title"><header className="modal-heading"><h2 id="dialog-title">{title}</h2><IconButton label="关闭窗口" onClick={close}><X size={20} /></IconButton></header>{children}</dialog>;
}

export function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  return <div className={`markdown ${compact ? 'markdown-compact' : ''}`}><ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex, rehypeHighlight]}
    urlTransform={(url, key) => key === 'src' ? url : (/^https?:\/\//i.test(url) || url.startsWith('#') ? url : '')}
    components={{
      a: ({ href, children: content }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.shelf.openExternal(href); }}>{content}</a>,
      img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt || '文档图片'} />,
      table: ({ children: content }) => <div className="table-scroll"><table>{content}</table></div>,
    }}
  >{children}</ReactMarkdown></div>;
}

function MarkdownImage({ src, alt }: {src: string; alt: string}) {
  const [resolved, setResolved] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setError(''); setResolved('');
    if (/^https?:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(src) || src.startsWith('blob:')) { setResolved(src); return; }
    if (!src || (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) { setError('图片路径不可用'); return; }
    let path = src;
    try { path = decodeURIComponent(src); } catch { /* Keep literal path when it is not URL encoded. */ }
    window.shelf.call<{dataUrl: string}>('asset.image', { path }).then(result => { if (active) setResolved(result.dataUrl); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [src]);
  if (error) return <span className="image-error" role="note"><AlertCircle size={15} />{alt}：{error}</span>;
  if (!resolved) return <span className="image-error">正在读取图片：{alt}</span>;
  return <img src={resolved} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setError('图片无法显示，请检查来源或本地文件')} />;
}

export function Sources({ sources, onRaw }: { sources: SourceRef[]; onRaw?: (id: string) => void }) {
  if (!sources.length) return <p className="muted">这篇文档尚未关联来源。</p>;
  return <div className="source-list">{sources.map((source, index) => <div className="source-item" key={`${source.id}-${index}`}><div className="source-heading"><strong>{source.title || source.url || source.id}</strong>{source.url && <IconButton label={`打开来源：${source.title}`} onClick={() => void window.shelf.openExternal(source.url!)}><ExternalLink size={16} /></IconButton>}</div><p>{source.coverage || '未记录获取范围'}</p><div className="source-meta"><span>{source.kind}</span><time>{dateText(source.accessedAt, true)}</time>{onRaw && <button className="text-button" onClick={() => onRaw(source.id)}>查看原始材料</button>}</div></div>)}</div>;
}
