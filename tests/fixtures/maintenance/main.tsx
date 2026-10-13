import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ShelfDirectory from '../../../src/renderer/ShelfDirectory.tsx';
import DocumentPanel from '../../../src/renderer/DocumentPanel.tsx';
import { setLocalScope, scopeLocalKey } from '../../../src/renderer/ui.tsx';
import '../../../src/renderer/styles.css';
import '../../../src/renderer/shelf-directory.css';

const scenario = new URLSearchParams(location.search).get('scenario') || 'completed';
const stamp = '2026-10-12T03:00:00.000Z';
const category = { id: 'agent', parentId: null, name: 'Agent', description: '测试分类', includes: '', excludes: '', scopeConfirmed: true, metadataVersion: 1 };
const makeDocument = (id: string, title: string, archivedIntoId?: string) => ({ id, title, body: '# ' + title + '\n\n隔离验证使用的固定正文。', categoryId: 'agent', description: '隔离验证使用的固定文档概览', aliases: [], paperIds: [], sources: [], version: 2, createdAt: stamp, updatedAt: stamp, ...(archivedIntoId ? { archivedIntoId } : {}) });
const originalA = makeDocument('source-one', '视频摘要 A：Agent 记忆管理', 'final-note');
const originalB = makeDocument('source-two', '视频摘要 B：Agent 记忆管理', 'final-note');
const independent = makeDocument('independent', '独立视频摘要：沙箱隔离');
const priorMerged = makeDocument('main-note', '早期整合版：Agent 记忆管理', 'final-note');
const finalMerged = makeDocument('final-note', '长程 Agent 记忆管理：状态保存、读写与上下文压缩');
const allDocuments = [originalA, originalB, independent, priorMerged, finalMerged];
const activeDocuments = [independent, finalMerged];
const queueDocuments = [makeDocument('queue-input', '长程 Agent 的记忆读写与上下文压缩策略（当前待整理原稿）'), makeDocument('queue-candidate-one', 'AgeMem：学习长短期记忆的读写时机（候选一）'), makeDocument('queue-candidate-two', 'CompactionRL 与 ECHO：上下文压缩后的信用分配（候选二）')];
const item = (doc: typeof originalA) => ({ documentId: doc.id, title: doc.title, categoryId: 'agent', initialVersion: 2, status: 'done', checkedVersion: 2, outcome: 'merged', concept: 'Agent 记忆管理', comparedDocIds: ['source-one', 'source-two'].filter(id => id !== doc.id), mergedDocIds: ['main-note'], summary: '两份相同概念的原稿已合并为新标题与概览的文档，原参与节点归档。', completedAt: stamp });
const items = [item(originalA), item(originalB), { documentId: independent.id, title: independent.title, categoryId: 'agent', initialVersion: 2, status: 'done', checkedVersion: 2, outcome: 'no_change', comparedDocIds: [], summary: '本分类没有可比较的同概念候选，无需处理，独立文档保留。', completedAt: stamp }];
const pending = { ...items[0], status: 'pending', summary: '尚未发布的草稿内容不应成为成功报告。' };
const run = { id: 'fixture-run', taskId: 'fixture-task', status: scenario === 'pending' ? 'paused' : 'completed', stage: 'maintenance_completed', total: scenario === 'pending' ? 1 : 3, checked: scenario === 'pending' ? 0 : 3, mergedCount: scenario === 'pending' ? 0 : 1, noChangeCount: scenario === 'pending' ? 0 : 1, diffCount: scenario === 'pending' ? 0 : 1, items: scenario === 'pending' ? [pending] : items, startedAt: stamp, updatedAt: stamp, completedAt: scenario === 'pending' ? undefined : stamp };
if (scenario === 'queue') Object.assign(run, { status: 'running', stage: 'scanning', progressMessage: '正在提供分类下的完整标题与简介', currentDocumentId: queueDocuments[0].id, currentDocumentTitle: queueDocuments[0].title, total: 1, checked: 0, mergedCount: 0, noChangeCount: 0, diffCount: 0, completedAt: undefined, items: [{ documentId: queueDocuments[0].id, title: queueDocuments[0].title, categoryId: 'agent', initialVersion: 2, status: 'pending' }] });
const state = { dataDir: 'fixture', totalDocuments: scenario === 'empty' ? 0 : scenario === 'queue' ? queueDocuments.length : activeDocuments.length, pendingCount: scenario === 'pending' || scenario === 'queue' ? 1 : 0, lastCompletedAt: scenario === 'pending' || scenario === 'queue' || scenario === 'empty' ? undefined : stamp, run: scenario === 'empty' ? undefined : run };
const calls: string[] = [];
setLocalScope('fixture-maintenance-archive');
const recoveryKey = scopeLocalKey('research-shelf:document:source-one');
localStorage.removeItem(recoveryKey);
if (scenario === 'archived-dirty') localStorage.setItem(recoveryKey, JSON.stringify({ id: 'source-one', title: '未保存标题', description: '未保存概览', categoryId: 'agent', aliasesText: '', paperIdsText: '', body: '未保存的原稿内容，需要保留以便复制。', expectedVersion: 2 }));
Object.assign(window, { __fixtureCalls: calls, __fixtureRecoveryKey: recoveryKey, shelf: { call: async (name: string, args?: { id?: string }) => {
  calls.push(name);
  if (name === 'library.documents') return scenario === 'empty' ? [] : scenario === 'queue' ? queueDocuments : activeDocuments;
  if (name === 'maintenance.get') return structuredClone(state);
  if (name === 'document') { const doc = [...queueDocuments, ...allDocuments].find(item => item.id === args?.id); if (!doc) throw new Error('测试文档不存在'); return doc; }
  if (name === 'versions') { const doc = allDocuments.find(item => item.id === args?.id)!; return [{ ...doc, reason: '测试原稿', version: 2 }, { ...doc, reason: '测试历史', version: 1, body: '历史正文' }]; }
  throw new Error('隔离验证拒绝写操作：' + name);
}, openExternal: async () => {} } });
function App() {
  const [event, setEvent] = useState('尚未触发回调');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(scenario.startsWith('archived') ? originalA : scenario === 'archive-live' ? makeDocument(originalA.id, originalA.title) : null);
  function open(id: string) { setEvent('document:' + id); setSelected(allDocuments.find(doc => doc.id === id) || null); }
  function phase(stage: string, progressMessage: string) { Object.assign(run, { stage, progressMessage }); setRevision(value => value + 1); }
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}><div style={{ padding: '5px 12px', flexShrink: 0, fontSize: 12 }} data-testid="fixture-status">隔离验证 fixture · {scenario} · 回调：{event}{scenario === 'archive-live' && <button className="text-button" onClick={() => setSelected(originalA)}>模拟本稿合并归档</button>}{scenario === 'queue' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}><button className="text-button" onClick={() => phase('scanning', '正在提供分类下的完整标题与简介')}>模拟概览</button><button className="text-button" onClick={() => phase('reading', '正在阅读待整理文档：' + queueDocuments[0].title)}>模拟当前正文</button><button className="text-button" onClick={() => phase('reading', '正在比较候选正文：' + queueDocuments[1].title)}>模拟候选一</button><button className="text-button" onClick={() => phase('reading', '正在比较候选正文：' + queueDocuments[2].title)}>模拟候选二</button><button className="text-button" onClick={() => phase('drafting', '草稿已保存，等待自检')}>模拟整合稿</button></div>}</div>{selected ? <main className="main-panel" style={{ flex: 1, minHeight: 0 }}><DocumentPanel key={selected.id} document={selected} newDocument={false} categoryId="agent" categories={[category]} loading={false} drafts={[]} locked={false} configured onSaved={async () => { throw new Error('fixture不允许保存'); }} onNew={() => {}} onSettings={() => {}} onResearch={() => {}} onRaw={() => {}} onOpenDocument={open} /></main> : <ShelfDirectory categories={[category]} revision={revision} active locked={false} dataDir="fixture" configured onUpdated={async () => {}} onDocument={doc => open(doc.id)} onTask={id => setEvent('task:' + id)} onSettings={() => setEvent('settings')} />}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
