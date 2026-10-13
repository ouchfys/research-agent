import { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FilePlus2, Folder, FolderOpen, FolderPlus, ListFilter, MoreHorizontal, Search, X } from 'lucide-react';
import type { Category, DocumentMeta } from '../shared/types';
import { dateText, IconButton, Loading } from './ui';
import CategoryEditor from './CategoryEditor';
import { categoryPath } from './category-utils';

interface LibraryProps {
  categories: Category[];
  categoryId: string;
  onCategory: (id: string) => void;
  documents: DocumentMeta[];
  loading: boolean;
  documentId: string | null;
  onDocument: (id: string) => void;
  contextIds: string[];
  onContext: (id: string) => void;
  onNewDocument: () => void;
  onCategorySaved: () => Promise<void>;
  locked: boolean;
}

export default function LibraryPanel(props: LibraryProps) {
  const { categories, categoryId, documents, documentId, contextIds, locked } = props;
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<Partial<Category> | null>(null);
  const current = categories.find(category => category.id === categoryId);
  const filtered = useMemo(() => documents.filter(document => !filter || `${document.title} ${document.description} ${document.aliases.join(' ')} ${document.paperIds.join(' ')}`.toLowerCase().includes(filter.toLowerCase())), [documents, filter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  const safePage = Math.min(page, pageCount - 1);
  const visibleDocuments = filtered.slice(safePage * 40, safePage * 40 + 40);

  function tree(parentId: string | null, depth = 0, ancestors: string[] = []): React.ReactNode {
    return categories.filter(category => category.parentId === parentId).map(category => {
      if (ancestors.includes(category.id)) return null;
      const hasChildren = categories.some(child => child.parentId === category.id);
      const expanded = !collapsed.includes(category.id);
      return <div key={category.id} className="category-branch"><div className={`category-row ${categoryId === category.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {hasChildren ? <button className="tree-toggle" aria-label={`${expanded ? '收起' : '展开'}${category.name}`} aria-expanded={expanded} onClick={() => setCollapsed(value => expanded ? [...value, category.id] : value.filter(id => id !== category.id))}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-spacer" />}
        <button className="category-button" aria-current={categoryId === category.id ? 'page' : undefined} onClick={() => { props.onCategory(category.id); setFilter(''); setPage(0); }}>
          {categoryId === category.id ? <FolderOpen size={16} /> : <Folder size={16} />}<span className="truncate">{category.name}</span>{!category.scopeConfirmed && <span className="scope-dot" title="分类范围尚未确认" />}<span className="count">{category.count ?? 0}</span>
        </button>
      </div>{hasChildren && expanded && tree(category.id, depth + 1, [...ancestors, category.id])}</div>;
    });
  }

  return <>
    <div className="panel-heading"><h2><BookOpen size={18} />书架</h2><IconButton label="新建分类" disabled={locked} onClick={() => setEditor({ parentId: null, scopeConfirmed: true })}><FolderPlus size={17} /></IconButton></div>
    <div className="category-tree" aria-label="知识分类">{tree(null)}</div>
    <section className="directory">
      <header className="directory-heading"><div><h3>{categoryPath(categories, categoryId) || '分类目录'}</h3><span className="muted">{documents.length} 篇文档</span></div><div className="inline-actions"><IconButton label="编辑当前分类范围" disabled={!current || locked} onClick={() => setEditor(current!)}><MoreHorizontal size={18} /></IconButton><IconButton label="在当前分类新建文档" disabled={!current || locked} onClick={props.onNewDocument}><FilePlus2 size={18} /></IconButton></div></header>
      {current?.description && <p className="category-description">{current.description}</p>}
      {current && !current.scopeConfirmed && <div className="scope-notice"><p>范围待确认，研究助手暂不会自动归入这里。</p><button className="text-button" disabled={locked} onClick={() => setEditor(current)}>说明分类范围</button></div>}
      <label className="search-field"><Search size={15} /><input aria-label="筛选当前分类文档" value={filter} placeholder="筛选标题、简介、标识符" onChange={event => { setFilter(event.target.value); setPage(0); }} />{filter && <IconButton label="清除筛选" onClick={() => setFilter('')}><X size={14} /></IconButton>}</label>
      <div className="document-list">{props.loading ? <Loading label="正在读取目录…" /> : !visibleDocuments.length ? <div className="directory-empty">{filter ? <><ListFilter size={24} /><p>没有匹配的文档</p><button className="text-button" onClick={() => setFilter('')}>清除筛选</button></> : <><FolderOpen size={28} /><p>这个分类还是空的</p><span>开始研究，或手动写下第一篇文档。</span><button className="secondary" disabled={locked || !current} onClick={props.onNewDocument}><FilePlus2 size={15} />写文档</button></>}</div> : visibleDocuments.map(document => <article className={`document-row ${document.id === documentId ? 'active' : ''}`} key={document.id}>
        <label className="context-checkbox" title="选为研究上下文"><input type="checkbox" disabled={locked} checked={contextIds.includes(document.id)} onChange={() => props.onContext(document.id)} aria-label={`将「${document.title}」选为研究上下文`} /></label>
        <button className="document-list-button" onClick={() => props.onDocument(document.id)} aria-current={document.id === documentId ? 'page' : undefined}><strong>{document.title}</strong><span className="document-description">{document.description || '暂无简介'}</span><span className="document-row-meta"><time>{dateText(document.updatedAt)}</time><span>v{document.version}</span></span></button>
      </article>)}</div>
      {pageCount > 1 && <footer className="pagination"><button className="text-button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><span>{safePage + 1} / {pageCount}</span><button className="text-button" disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>下一页</button></footer>}
      <div className="library-hint">勾选文档，将它加入右侧研究上下文。</div>
    </section>
    {editor && <CategoryEditor category={editor} categories={categories} close={() => setEditor(null)} saved={async () => { setEditor(null); await props.onCategorySaved(); }} />}
  </>;
}
