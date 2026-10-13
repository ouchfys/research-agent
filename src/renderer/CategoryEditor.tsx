import { useRef, useState } from 'react';
import type { Category } from '../shared/types';
import { ErrorNotice, errorText, Modal } from './ui';

export interface CategoryEditorProps {
  category: Partial<Category>;
  categories: Category[];
  close: () => void;
  saved: () => Promise<void>;
  compact?: boolean;
}

export default function CategoryEditor({ category, categories, close, saved, compact = false }: CategoryEditorProps) {
  const [value, setValue] = useState({
    name: '', description: '', includes: '', excludes: '', parentId: null as string | null,
    ...category,
    scopeConfirmed: compact && !category.id ? false : category.scopeConfirmed ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const hasChildren = Boolean(category.id && categories.some(item => item.parentId === category.id));
  const parents = categories.filter(item => item.parentId === null && item.id !== category.id);
  const originalParent = categories.find(item => item.id === value.parentId);
  const noun = compact ? '目录' : '分类';

  function requestClose() { if (!savingRef.current) close(); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current || !value.name.trim()) return;
    setError('');
    if (value.parentId && (hasChildren || !parents.some(item => item.id === value.parentId))) {
      setError(hasChildren ? `已有二级${noun}的一级${noun}不能移到其他${noun}下。` : `父${noun}只能选择一级${noun}。`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await window.shelf.call('category.save', { category: { ...value, name: value.name.trim() } });
      await saved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const scopeFields = <>
    <label>说明<textarea disabled={saving} rows={3} value={value.description} onChange={event => setValue({ ...value, description: event.target.value })} placeholder={`这个${noun}研究什么，边界在哪里`} /></label>
    <label>包含的主题<textarea disabled={saving} rows={3} value={value.includes} onChange={event => setValue({ ...value, includes: event.target.value })} /></label>
    <label>不包含的主题<textarea disabled={saving} rows={2} value={value.excludes} onChange={event => setValue({ ...value, excludes: event.target.value })} /></label>
    <label className="checkbox-label"><input type="checkbox" disabled={saving} checked={value.scopeConfirmed} onChange={event => setValue({ ...value, scopeConfirmed: event.target.checked })} /><span>已确认这个{noun}的含义与范围，允许自动归类</span></label>
    <p className="field-help">未确认范围的{noun}仍可手动管理，但研究助手不会自动选择它。</p>
  </>;

  return <Modal title={category.id ? `编辑${noun}${compact ? '' : '范围'}` : `新建${noun}`} close={requestClose}><form className={`modal-form${compact ? ' category-editor-compact' : ''}`} onSubmit={save} aria-busy={saving}>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <label>{noun}名称<input autoFocus disabled={saving} required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></label>
    <label>父{noun}<select disabled={saving} value={value.parentId ?? ''} onChange={event => setValue({ ...value, parentId: event.target.value || null })}><option value="">{compact ? '一级目录' : '顶层分类'}</option>{originalParent && !parents.some(item => item.id === originalParent.id) && <option value={originalParent.id} disabled>{originalParent.name}（请改选一级{noun}）</option>}{parents.map(item => <option disabled={hasChildren} value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    {hasChildren && <p className="field-help">已有二级{noun}，当前{noun}需保持在一级。</p>}
    {compact ? <details className="editor-metadata category-scope"><summary>研究范围与自动归类（可选）</summary><div className="conditions-form category-scope-fields">{scopeFields}</div></details> : scopeFields}
    <footer className="modal-footer"><button type="button" className="secondary" disabled={saving} onClick={requestClose}>取消</button><button className="primary" type="submit" disabled={saving || !value.name.trim()}>{saving ? '保存中…' : `保存${noun}`}</button></footer>
  </form></Modal>;
}
