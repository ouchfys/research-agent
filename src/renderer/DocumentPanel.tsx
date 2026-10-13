import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { BookOpen, Check, FileClock, FilePenLine, FilePlus2, FileText, GitCompareArrows, History, Link2, Save, Settings2, Undo2 } from 'lucide-react';
import type { Category, Draft, KnowledgeDocument, Version } from '../shared/types';
import { dateText, ErrorNotice, errorText, Loading, Markdown, Modal, readLocal, removeLocal, scopeLocalKey, Sources, writeLocal } from './ui';
import { categoryPath } from './category-utils';

type View = 'read' | 'edit' | 'sources' | 'versions' | 'drafts';
interface EditorValue { id?: string; title: string; description: string; categoryId: string; aliasesText: string; paperIdsText: string; body: string; expectedVersion: number }
function editorValue(document: KnowledgeDocument | null, categoryId: string): EditorValue {
  return { id: document?.id, title: document?.title || '', description: document?.description || '', categoryId: document?.categoryId || categoryId, aliasesText: document?.aliases.join('\n') || '', paperIdsText: document?.paperIds.join('\n') || '', body: document?.body || '', expectedVersion: document?.version ?? 0 };
}
function listValue(value: string): string[] { return [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))]; }

interface Props {
  document: KnowledgeDocument | null;
  newDocument: boolean;
  categoryId: string;
  categories: Category[];
  loading: boolean;
  drafts: Draft[];
  locked: boolean;
  configured: boolean;
  onSaved: (document: KnowledgeDocument) => Promise<void>;
  onNew: () => void;
  onSettings: () => void;
  onResearch: (id?: string) => void;
  onRaw: (id: string) => void;
  onOpenDocument: (id: string) => void;
}

export default function DocumentPanel(props: Props) {
  const { document, newDocument, categories, categoryId, drafts, locked } = props;
  const archived = Boolean(document?.archivedIntoId);
  const editLocked = locked || archived;
  const recoveryKey = scopeLocalKey(`research-shelf:document:${document?.id ?? 'new'}`);
  const recovered = useMemo(() => readLocal<EditorValue | null>(recoveryKey, null), [recoveryKey]);
  const [tab, setTab] = useState<View>(newDocument || recovered ? 'edit' : 'read');
  const [value, setValue] = useState<EditorValue>(() => recovered || editorValue(document, categoryId));
  const [dirty, setDirty] = useState(Boolean(recovered));
  const [saving, setSaving] = useState(false);
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const [showRecovery, setShowRecovery] = useState(Boolean(recovered));
  const [discard, setDiscard] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<Version | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const docDrafts = drafts.filter(draft => draft.id === document?.id && draft.status !== 'published');
  const hasDocument = Boolean(document || newDocument);
  const stale = Boolean(document && document.version !== value.expectedVersion && dirty);

  useEffect(() => { if (!dirty) setValue(editorValue(document, categoryId)); }, [document, categoryId, dirty]);
  useEffect(() => { if (archived && !dirty && tab === 'edit') setTab('read'); }, [archived, dirty, tab]);
  useEffect(() => { if (dirty) writeLocal(recoveryKey, value); }, [value, dirty, recoveryKey]);
  useEffect(() => {
    if (tab !== 'versions' || !document) return;
    let active = true; setVersionsLoading(true);
    window.shelf.call<Version[]>('versions', { id: document.id }).then(result => { if (active) { setVersions(result); setVersionId(previous => previous ?? result.find(version => version.version < document.version)?.version ?? result[0]?.version ?? null); } }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setVersionsLoading(false); });
    return () => { active = false; };
  }, [tab, document?.id, document?.version]);

  function change(patch: Partial<EditorValue>) { if (editLocked) return; setValue(previous => ({ ...previous, ...patch })); setDirty(true); setSavedText(''); }
  async function save() {
    if (editLocked) { setError(archived ? '这篇原稿已归档，请打开整合文档继续编辑。' : '当前文档暂时无法编辑，请稍后再试。'); return; }
    setSaving(true); setError('');
    try {
      const result = await window.shelf.call<KnowledgeDocument>('document.save', { document: { id: value.id, title: value.title, description: value.description, categoryId: value.categoryId, aliases: listValue(value.aliasesText), paperIds: listValue(value.paperIdsText), body: value.body, sources: document?.sources || [], expectedVersion: value.expectedVersion } });
      removeLocal(recoveryKey); setDirty(false); setShowRecovery(false); setValue(editorValue(result, result.categoryId)); setTab('read'); setSavedText(`手动修改已保存为 v${result.version}`); await props.onSaved(result);
    } catch (cause) { setError(errorText(cause)); } finally { setSaving(false); }
  }
  async function rollback() {
    if (!document || !rollbackTarget || editLocked) return;
    setRollingBack(true); setError('');
    try {
      const result = await window.shelf.call<KnowledgeDocument>('rollback', { id: document.id, version: rollbackTarget.version, expectedVersion: document.version });
      setRollbackTarget(null); setTab('read'); setSavedText(`已回滚，生成 v${result.version}`); await props.onSaved(result);
    } catch (cause) { setError(errorText(cause)); } finally { setRollingBack(false); }
  }
  const version = versions.find(item => item.version === versionId);
  const changes = useMemo(() => version && document ? diffLines(version.body, document.body) : [], [version, document]);

  if (props.loading) return <div className="document-loading"><Loading label="正在打开文档…" /></div>;
  if (!hasDocument) return <div className="welcome"><div className="welcome-symbol"><BookOpen size={34} strokeWidth={1.4} /></div><h1>让研究慢慢积累。</h1><p>从一条线索开始，整理成持续更新的知识。<br />在左侧选择文档，或在右侧开始研究。</p><div className="welcome-actions"><button className="primary" disabled={locked} onClick={() => props.onResearch()}><FileText size={17} />添加研究材料</button><button className="secondary" disabled={locked || !categories.length} onClick={props.onNew}><FilePlus2 size={17} />手动写文档</button></div>{!props.configured && <div className="setup-hint"><Settings2 size={18} /><div><strong>研究助手等待配置</strong><p>连接文本模型后可自动研究与整理。文档阅读和手动编辑现在就能使用。</p><button className="text-button" onClick={props.onSettings}>配置模型与服务</button></div></div>}<div className="welcome-footnote"><span>本地 Markdown</span><span>来源可追溯</span><span>保留每次版本</span></div></div>;

  const tabs: { key: View; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { key: 'read', label: '阅读', icon: <BookOpen size={15} />, disabled: newDocument },
    { key: 'edit', label: archived && dirty ? '未保存修改' : '编辑', icon: <FilePenLine size={15} />, disabled: archived && !dirty },
    { key: 'sources', label: '来源', icon: <Link2 size={15} />, disabled: newDocument },
    { key: 'versions', label: '版本', icon: <History size={15} />, disabled: newDocument },
    { key: 'drafts', label: `草稿${docDrafts.length ? ` ${docDrafts.length}` : ''}`, icon: <FileClock size={15} />, disabled: newDocument },
  ];
  return <>
    <div className="document-toolbar"><div className="document-location"><FolderLabel categories={categories} categoryId={document?.categoryId || value.categoryId} /><span>/</span><span className="truncate">{document?.title || '新文档'}</span></div>{document && <button className="text-button" disabled={locked || archived} title={archived ? "原稿已归档，请打开整合文档选择研究上下文" : undefined} onClick={() => props.onResearch(document.id)}>选为研究上下文</button>}</div>
    <div className="document-tabs" role="tablist" aria-label="文档视图">{tabs.map(item => <button key={item.key} role="tab" aria-selected={tab === item.key} aria-controls="document-tab-panel" disabled={item.disabled} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.icon}{item.label}{item.key === 'edit' && dirty && <span className="unsaved-dot" title="有未保存修改" />}</button>)}</div>
    <div className="document-content" id="document-tab-panel" role="tabpanel" aria-label={tabs.find(item => item.key === tab)?.label}>
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
      {savedText && <div className="notice success" role="status"><Check size={16} />{savedText}</div>}
      {archived && document && <div className="notice info"><FileClock size={17} /><div>这篇原稿已整合归档，不再作为独立书架节点。原文、来源与版本仍可查阅；修改请打开整合文档。<button className="text-button" onClick={() => props.onOpenDocument(document.archivedIntoId!)}>打开整合文档</button>{dirty && <p style={{ margin: '6px 0 0' }}>未保存修改的本地恢复副本仍在，可在“未保存修改”中查看和复制。</p>}</div></div>}
      {tab === 'read' && document && <article className="reading-page"><div className="reading-meta"><span>{archived ? '归档原稿' : '已发布'}</span><span>v{document.version}</span><time>更新于 {dateText(document.updatedAt, true)}</time></div><h1>{document.title}</h1>{document.description && <p className="reading-description">{document.description}</p>}{(document.aliases.length > 0 || document.paperIds.length > 0) && <div className="document-identifiers">{document.aliases.map(alias => <span className="tag" key={alias}>{alias}</span>)}{document.paperIds.map(id => <span className="tag mono" key={id}>{id}</span>)}</div>}<Markdown>{document.body || (archived ? '*这份归档原稿的正文为空。*' : '*正文为空，可切换到编辑视图开始撰写。*')}</Markdown><footer className="reading-footer"><Link2 size={14} /><button className="text-button" onClick={() => setTab('sources')}>{document.sources.length} 个关联来源</button><span>创建于 {dateText(document.createdAt, true)}</span></footer></article>}
      {tab === 'edit' && <form className="document-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        {showRecovery && <div className="notice info"><FileClock size={17} /><div>已恢复上次未保存的修改。<button className="text-button" type="button" onClick={() => setShowRecovery(false)}>知道了</button></div></div>}
        {locked && <div className="notice warning">正在处理知识冲突，手动编辑暂时锁定。未保存内容会保留。</div>}
        {stale && !archived && <div className="notice warning"><div>已发布版本已更新到 v{document?.version}，当前修改基于 v{value.expectedVersion}。请在阅读或版本页比较后合并。<button type="button" className="text-button" disabled={editLocked} onClick={() => change({ expectedVersion: document!.version })}>已合并最新内容，采用 v{document?.version} 作为保存基准</button></div></div>}
        <label className="title-field">标题<input disabled={locked} readOnly={archived} required value={value.title} onChange={event => change({ title: event.target.value })} placeholder="为这个方法或主题命名" /></label>
        <label>简介<textarea disabled={locked} readOnly={archived} rows={3} required value={value.description} onChange={event => change({ description: event.target.value })} placeholder="简要说明研究对象、关键思路和适用边界" /></label>
        <details className="editor-metadata"><summary>分类、别名与论文标识符</summary><div className="metadata-fields"><label>所属分类<select disabled={editLocked} value={value.categoryId} onChange={event => change({ categoryId: event.target.value })}>{categories.map(category => <option value={category.id} key={category.id}>{categoryPath(categories, category.id)}</option>)}</select></label><label>别名<textarea disabled={locked} readOnly={archived} rows={2} value={value.aliasesText} onChange={event => change({ aliasesText: event.target.value })} placeholder="每行一个，也可用逗号分隔" /></label><label>论文标识符<textarea disabled={locked} readOnly={archived} rows={2} value={value.paperIdsText} onChange={event => change({ paperIdsText: event.target.value })} placeholder="arXiv、DOI 等，每行一个" /></label></div></details>
        <label className="body-field"><span>正文 <span className="muted">Markdown</span></span><textarea disabled={locked} readOnly={archived} spellCheck={false} value={value.body} onChange={event => change({ body: event.target.value })} placeholder="在这里撰写正文。支持标题、代码、表格与 LaTeX 公式。" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (!saving && !editLocked && value.title.trim() && value.description.trim()) void save(); } }} /></label>
        <footer className="editor-footer"><span className="muted">{dirty ? '未保存 · 已留存本地恢复副本' : archived ? '归档原稿仅供查阅' : '正文以 Markdown 保存'}</span><div className="inline-actions">{dirty && <button type="button" className="secondary" onClick={() => setDiscard(true)}>放弃修改</button>}<button type="submit" className="primary" disabled={editLocked || saving || !value.title.trim() || !value.description.trim() || !value.categoryId || stale}><Save size={16} />{saving ? '保存中…' : '保存修改'}</button></div></footer>
      </form>}
      {tab === 'sources' && document && <section className="document-section"><h2>文档来源</h2><p className="section-description">来源记录实际获得的内容范围。打开原始材料，可查看研究时保留的内容。</p><Sources sources={document.sources} onRaw={props.onRaw} /></section>}
      {tab === 'versions' && document && <section className="document-section"><h2>版本与差异</h2><p className="section-description">{archived ? `历史版本与归档原稿 v${document.version} 比较。归档原稿仅供查阅，修改请打开整合文档。` : <>历史版本与当前已发布的 v{document.version} 比较。回滚会创建一个新版本，保留已有历史。</>}</p>{versionsLoading ? <Loading label="正在读取历史版本…" /> : !versions.length ? <p className="muted">还没有可显示的历史版本。</p> : <><div className="version-controls"><label>对比版本<select value={versionId ?? ''} onChange={event => setVersionId(Number(event.target.value))}>{versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {dateText(item.updatedAt)} · {item.reason || '保存'}</option>)}</select></label><button className="secondary" disabled={editLocked || !version || version.version === document.version || dirty} onClick={() => setRollbackTarget(version!)}><Undo2 size={15} />回滚至此版本</button></div>{dirty && <p className="field-help">请先保存或放弃手动修改，再回滚版本。</p>}{version && <><div className="diff-legend"><span><GitCompareArrows size={16} />v{version.version} → v{document.version}</span><span className="diff-remove-label">删除</span><span className="diff-add-label">新增</span></div>{(version.title !== document.title || version.description !== document.description || version.categoryId !== document.categoryId || JSON.stringify(version.aliases) !== JSON.stringify(document.aliases) || JSON.stringify(version.paperIds) !== JSON.stringify(document.paperIds) || JSON.stringify(version.sources) !== JSON.stringify(document.sources)) && <details className="metadata-diff" open><summary>元数据变化</summary>{(['title', 'description', 'categoryId', 'aliases', 'paperIds', 'sources'] as const).filter(key => JSON.stringify(version[key]) !== JSON.stringify(document[key])).map(key => <div key={key}><strong>{{ title: '标题', description: '简介', categoryId: '分类', aliases: '别名', paperIds: '论文标识符', sources: '来源' }[key]}</strong><pre className="diff-removed">− {formatMetadata(version[key], categories)}</pre><pre className="diff-added">+ {formatMetadata(document[key], categories)}</pre></div>)}</details>}<div className="line-diff" aria-label="正文逐行差异">{changes.map((change, index) => <pre key={index} className={change.added ? 'diff-added' : change.removed ? 'diff-removed' : 'diff-same'}><span className="diff-marker" aria-label={change.added ? '新增' : change.removed ? '删除' : '未变化'}>{change.added ? '+' : change.removed ? '−' : ' '}</span><code>{change.value}</code></pre>)}</div></>}</>}</section>}
      {tab === 'drafts' && <section className="document-section"><h2>研究草稿</h2><p className="section-description">研究助手先形成草稿，完成内容自检后才会发布。这里的内容尚未替换已发布正文。</p>{!docDrafts.length ? <div className="inline-empty"><FileClock size={28} /><p>这篇文档没有待处理草稿。</p></div> : docDrafts.map(draft => <DraftView key={draft.draftId} draft={draft} />)}</section>}
    </div>
    {discard && <Modal title="放弃未保存修改？" close={() => setDiscard(false)}><div className="modal-form"><p>这会移除本地恢复副本，并重新载入已发布内容。已保存的历史版本不会受影响。</p><footer className="modal-footer"><button className="secondary" onClick={() => setDiscard(false)}>继续编辑</button><button className="danger-button" onClick={() => { setDirty(false); setShowRecovery(false); removeLocal(recoveryKey); setValue(editorValue(document, categoryId)); setDiscard(false); }}>放弃修改</button></footer></div></Modal>}
    {rollbackTarget && <Modal title={`回滚到 v${rollbackTarget.version}？`} close={() => setRollbackTarget(null)}><div className="modal-form"><p>将恢复此版本的标题、简介、正文和元数据，并生成新的已发布版本。当前版本仍会保留在历史记录中。</p>{error && <ErrorNotice>{error}</ErrorNotice>}<footer className="modal-footer"><button className="secondary" onClick={() => setRollbackTarget(null)}>取消</button><button className="primary" disabled={rollingBack || editLocked} onClick={() => void rollback()}>{rollingBack ? '正在回滚…' : '确认回滚'}</button></footer></div></Modal>}
  </>;
}

function FolderLabel({ categories, categoryId }: {categories: Category[]; categoryId: string}) { return <span>{categoryPath(categories, categoryId) || '未选择分类'}</span>; }
function formatMetadata(value: unknown, categories: Category[]): string { if (typeof value === 'string') return categoryPath(categories, value) || value; return JSON.stringify(value, null, 2); }

export function DraftView({ draft }: {draft: Draft}) {
  return <details className="draft-view"><summary><span><FileClock size={16} /><strong>{draft.title}</strong></span><span className="tag">{draft.status === 'reviewed' ? '已自检，待发布' : '草稿'} · r{draft.revision}</span></summary><div className="draft-body"><p className="muted">基于 v{draft.baseVersion} · {dateText(draft.updatedAt, true)}</p>{draft.review && <details className="self-review"><summary>内容自检：{draft.review.passed ? '已通过' : '待修正'}</summary><dl>{Object.entries({ '原始材料理解': draft.review.materialUnderstanding, '事实与推测': draft.review.speculation, '适用条件': draft.review.conditions, '方法身份': draft.review.methodIdentity, '知识冲突': draft.review.conflicts, '文档结构': draft.review.structure, '标题简介一致性': draft.review.metadataConsistency, '集中修正': draft.review.fixes }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '未提供说明'}</dd></div>)}</dl></details>}<Markdown>{draft.body}</Markdown></div></details>;
}
