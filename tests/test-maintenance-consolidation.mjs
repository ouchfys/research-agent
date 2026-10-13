import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

// Every writable path and every database opened here belongs to this mkdtemp.
// Store is bundled directly; Config, application .env, and model clients are never loaded.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'maintenance-consolidation-verify-'));
const digest = value => createHash('sha256').update(value).digest('hex');
let Store;
let store;
let checks = 0;
const review = { materialUnderstanding: '已阅读隔离测试原稿。', speculation: '没有未标明推测。', conditions: '保留每份资料的适用条件。', methodIdentity: '整理同主题下不同方法。', conflicts: '已落实可信人类裁决或没有未决分歧。', structure: '整合后的结构完整。', metadataConsistency: '标题概览正文和全部来源一致。', passed: true, fixes: '' };
const source = key => ({ id: `fixture-${key}`, title: `隔离测试来源 ${key}`, kind: 'test', coverage: '本脚本的独立测试资料', accessedAt: '2026-10-12T00:00:00Z' });
const fixture = (title, key, categoryId = 'agent') => ({ categoryId, title, description: `${title}：测试资料的概念与条件。`, aliases: [], paperIds: [], sources: [source(key)], body: `# ${title}\n\n测试条件 ${key} 的独立说明。`, expectedVersion: 0 });
const close = () => { store?.close(); store = undefined; };
function owned(target) {
  const rel = path.relative(path.resolve(scratch), path.resolve(target));
  assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'Path escaped the isolated test directory');
  return target;
}
const open = name => { close(); store = new Store(owned(path.join(scratch, name))); return store; };
function withDb(work, readOnly = true, folder = store.dataDir) {
  const db = new DatabaseSync(owned(path.join(folder, 'app.sqlite')), { readOnly });
  try { return work(db); } finally { db.close(); }
}
const rows = (kind, folder) => withDb(db => db.prepare('SELECT id,value FROM records WHERE kind=? ORDER BY id').all(kind), true, folder);
const record = (kind, id) => rows(kind).map(row => ({ id: row.id, value: JSON.parse(row.value) })).find(row => row.id === id)?.value;
const journalCount = () => withDb(db => Number(db.prepare('SELECT count(*) AS n FROM publication_journal').get().n));
const bodyReadCount = taskId => rows('event').filter(row => { const event = JSON.parse(row.value); return event.taskId === taskId && ['阅读候选', '阅读当前输入'].includes(event.stage); }).length;
const noChange = (document, comparedDocIds = []) => ({ documentId: document.id, version: document.version, outcome: 'no_change', comparedDocIds, summary: '已实际读取；没有需要处理的同主题内容或分歧。' });
function start() {
  const run = store.startMaintenance();
  store.updateTask(run.taskId, { status: 'paused' }); // No agent is launched by these Store-only tests.
  return run;
}
function scan(taskId, categoryId = 'agent', documentIds = []) {
  store.markCategoriesRead(taskId);
  const input = store.maintenanceInput(taskId);
  const reason = `当前资料“${input?.title ?? '已完成的输入'}”与 ${categoryId} 目录中的方法都说明同一测试问题，核对适用条件及来源。`;
  let batch = store.scanCategoryBatch(taskId, categoryId, undefined, undefined, reason);
  while (batch.continuation) batch = store.scanCategoryBatch(taskId, categoryId, batch.continuation);
  assert.equal(batch.scan.complete, true);
  const ordered = [...new Set(documentIds)].sort((left, right) => Number(right === input?.id) - Number(left === input?.id));
  for (const documentId of ordered) {
    const candidate = store.document(documentId);
    store.readCandidate(taskId, documentId, documentId === input?.id ? undefined : `当前资料“${input?.title}”与“${candidate.title}”说明同一测试问题，比较其中结论与适用条件。`);
  }
}
function draftMerge(taskId, documents, title = '整合后的主题', categoryId = 'agent', extra = {}) {
  return store.putDraft(taskId, { categoryId, title, description: '重新整理后的共同问题、不同方法及适用条件。', aliases: [], paperIds: [], sources: [],
    body: `# ${title}\n\n共同问题。\n\n${documents.map(document => `## ${document.title}\n\n${document.body}`).join('\n\n')}\n\n不同条件分别保留。`,
    expectedVersion: 0, mergeFromDocIds: documents.map(document => document.id), ...extra });
}
function publishMerge(taskId, documents, title, categoryId) {
  const draft = draftMerge(taskId, documents, title, categoryId);
  const result = store.submitDraft(taskId, draft.draftId, draft.revision, review);
  assert.equal(result.draft.status, 'published');
  assert.equal(result.document.version, 1);
  return { draft, document: result.document };
}
function preserve(document) {
  return { document, bytes: digest(readFileSync(path.join(store.dataDir, 'library', `${document.id}.md`))), versions: store.versions(document.id) };
}
function assertPreserved(saved, replacementId) {
  const read = store.document(saved.document.id);
  assert.equal(read.archivedIntoId, replacementId);
  assert.equal(read.body, saved.document.body);
  assert.equal(read.version, saved.document.version);
  assert.deepEqual(read.sources, saved.document.sources);
  assert.equal(digest(readFileSync(path.join(store.dataDir, 'library', `${saved.document.id}.md`))), saved.bytes);
  assert.deepEqual(store.versions(saved.document.id), saved.versions);
}
function assertConsolidated(run, originals, result) {
  assert.deepEqual(store.libraryDocuments().map(document => document.id), [result.id]);
  assert.equal(store.categories().reduce((sum, category) => sum + (category.count || 0), 0), 1);
  assert.equal(store.maintenanceRun(run.taskId).checked, run.total);
  assert.equal(store.maintenanceRun(run.taskId).mergedCount, 1);
  assert.equal(store.maintenanceState().pendingCount, 0, 'The derived public node must already have a maintenance ledger');
  assert.equal(record('maintenance_ledger', result.id).checkedVersion, result.version);
  for (const saved of originals) assertPreserved(saved, result.id);
}
function pass(label) { checks++; console.log(`PASS ${checks}. ${label}`); }
function filesUnder(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const target = owned(path.join(folder, entry.name));
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}
function protectedSnapshot(otherTaskId) {
  const categories = rows('category');
  const documents = rows('document');
  const raws = rows('raw');
  const versions = withDb(db => db.prepare('SELECT * FROM versions ORDER BY doc_id,version').all());
  const taskScoped = withDb(db => db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all().filter(row => {
    const value = JSON.parse(row.value);
    return row.kind === 'task' ? row.id === otherTaskId : value.taskId === otherTaskId || ['categories_read', 'round_boundary'].includes(row.kind) && row.id === otherTaskId;
  }));
  const bytes = ['library', 'history', 'raw'].flatMap(sub => filesUnder(path.join(store.dataDir, sub)).map(file => [path.relative(store.dataDir, file), digest(readFileSync(file))]));
  return { categories, documents, raws, versions, taskScoped, bytes };
}

try {
  const bundle = owned(path.join(scratch, 'store.mjs'));
  await build({ entryPoints: [path.join(projectRoot, 'src/server/store.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  ({ Store } = await import(pathToFileURL(bundle).href));

  open('fixed-batch');
  const independent = store.saveManual(fixture('无匹配的独立资料', 'independent'));
  const firstRun = start();
  assert.equal(store.maintenanceInput(firstRun.taskId).id, independent.id);
  assert.equal('body' in store.maintenanceInput(firstRun.taskId), false, 'Current input supplies metadata, not a bulk body payload');
  assert.throws(() => store.finishMaintenance(firstRun.taskId), /尚未全部|未完成/);
  assert.throws(() => store.readCandidate(firstRun.taskId, independent.id), /父节点|概览|简介|完整/);
  store.markCategoriesRead(firstRun.taskId);
  assert.throws(() => store.scanCategoryBatch(firstRun.taskId, 'infra', undefined, undefined, '当前资料与基础设施目录的方法存在相同的测试条件，需要比较。'), /当前|正文|阅读/);
  assert.equal(store.scans(firstRun.taskId).some(item => item.categoryId === 'infra'), false);
  const late = store.saveManual(fixture('启动后新增资料', 'late'));
  assert.equal(store.maintenanceRun(firstRun.taskId).total, 1);
  assert.throws(() => store.recordMaintenanceReports(firstRun.taskId, [noChange(late)]), /固定批次|本批/);
  scan(firstRun.taskId, 'agent', [independent.id]);
  assert.throws(() => store.readCandidate(firstRun.taskId, late.id), /理由|线索|比较|共同问题|核对点/);
  assert.throws(() => store.readCandidate(firstRun.taskId, late.id, '相同'), /理由|线索|比较|具体|共同问题|核对点/);
  assert.throws(() => store.readCandidate(firstRun.taskId, late.id, '比'.repeat(2001)), /2000|理由|线索|比较|长度|共同问题|核对点/);
  assert.equal(store.scans(firstRun.taskId).at(-1).readIds.length, 1, 'Scanning all summaries must not imply reading all candidate bodies');
  store.recordMaintenanceReports(firstRun.taskId, [noChange(independent)]);
  assert.equal(store.maintenanceInput(firstRun.taskId), undefined);
  assert.equal(store.maintenanceRun(firstRun.taskId).noChangeCount, 1);
  assert.equal(store.maintenanceRun(firstRun.taskId).mergedCount, 0);
  assert.equal(store.maintenanceState().lastCompletedAt, undefined);
  close(); open('fixed-batch');
  assert.equal(store.startMaintenance().id, firstRun.id);
  store.finishMaintenance(firstRun.taskId);
  assert.equal(store.document(independent.id).version, 1);
  assert.equal(store.maintenanceState().pendingCount, 1);
  assert.deepEqual(start().items.map(item => item.documentId), [late.id]);

  open('per-input-read-evidence');
  const inputA = store.saveManual(fixture('01 首篇输入', 'input-a'));
  const inputB = store.saveManual(fixture('02 已读候选成为输入', 'input-b'));
  const inputC = store.saveManual(fixture('03 尚未读的下一输入', 'input-c'));
  const inputRun = start();
  scan(inputRun.taskId, 'agent', [inputA.id, inputB.id]);
  const readsBefore = bodyReadCount(inputRun.taskId);
  assert.equal(readsBefore, 2);
  store.recordMaintenanceReports(inputRun.taskId, [noChange(inputA, [inputB.id])]);
  assert.equal(store.maintenanceInput(inputRun.taskId).id, inputB.id);
  const newlyAdded = store.saveManual(fixture('04 批次外新增影响目录版本', 'input-late'));
  assert.throws(() => store.recordMaintenanceReports(inputRun.taskId, [noChange(inputB, [inputA.id])]), /目录变化|概览|重新|完整/);
  scan(inputRun.taskId, 'agent');
  store.recordMaintenanceReports(inputRun.taskId, [noChange(inputB, [inputA.id])]);
  assert.equal(bodyReadCount(inputRun.taskId), readsBefore, 'Fresh metadata plus unchanged prior body evidence must not require re-reading the candidate');
  assert.equal(store.maintenanceInput(inputRun.taskId).id, inputC.id);
  assert.throws(() => store.readCandidate(inputRun.taskId, inputB.id, '输入丙与已完成资料乙讨论同一测试方法，核对条件是否一致。'), /当前|正文|阅读/);
  scan(inputRun.taskId, 'agent', [inputC.id]);
  store.readCandidate(inputRun.taskId, inputB.id, '输入丙与已完成资料乙讨论同一测试方法，核对条件是否一致。');
  store.recordMaintenanceReports(inputRun.taskId, [noChange(inputC, [inputB.id])]);
  assert.equal(store.maintenanceRun(inputRun.taskId).checked, 3);
  store.finishMaintenance(inputRun.taskId);
  assert.deepEqual(start().items.map(item => item.documentId), [newlyAdded.id]);
  pass('当前输入先读才可跨类，候选须具体理由；零候选无需处理、固定批次隔离与恢复');

  open('real-consolidation');
  const a = store.saveManual(fixture('原稿甲', 'a'));
  const b = store.saveManual(fixture('原稿乙', 'b'));
  const originals = [preserve(a), preserve(b)];
  const run = start(); scan(run.taskId, 'agent', [a.id, b.id]);
  const savedDraft = draftMerge(run.taskId, [a, b], a.title);
  assert.deepEqual(savedDraft.mergeFrom, [a, b].map(document => ({ id: document.id, version: document.version })));
  assert.deepEqual(new Set(savedDraft.sources.map(item => item.id)), new Set([...a.sources, ...b.sources].map(item => item.id)));
  assert.equal(store.libraryDocuments().length, 2, 'Writing a draft must not archive originals');
  const combined = store.submitDraft(run.taskId, savedDraft.draftId, savedDraft.revision, review).document;
  assert.notEqual(combined.id, a.id); assert.notEqual(combined.id, b.id);
  assertConsolidated(run, originals, combined);
  assert(store.maintenanceRun(run.taskId).items.every(item => item.outcome === 'merged' && item.mergedDocIds[0] === combined.id));
  for (const document of [a, b]) {
    assert.throws(() => store.saveManual({ ...document, expectedVersion: document.version }), /归档|整合/);
    assert.throws(() => store.moveDocument(document.id, 'infra', document.version), /归档|整合/);
    assert.throws(() => store.rollback(document.id, 1, document.version), /归档|整合/);
  }
  store.finishMaintenance(run.taskId);
  assert.throws(() => store.startMaintenance(), /没有新入库/);
  pass('真实二合一新公开节点、自动全来源与认证、原文件和版本保留且禁止误编辑');

  open('invalid-merges');
  const invalidA = store.saveManual(fixture('01 候选甲', 'invalid-a'));
  const invalidB = store.saveManual(fixture('02 候选乙', 'invalid-b'));
  const invalidRun = start(); scan(invalidRun.taskId, 'agent', [invalidA.id]);
  assert.equal(store.maintenanceInput(invalidRun.taskId).id, invalidA.id);
  assert.throws(() => draftMerge(invalidRun.taskId, [invalidA, invalidA]), /至少两篇|二合一/);
  assert.throws(() => draftMerge(invalidRun.taskId, [invalidA, invalidB]), /最新正文|阅读/);
  assert.throws(() => store.readCandidate(invalidRun.taskId, invalidB.id), /理由|线索|比较|共同问题|核对点/);
  store.readCandidate(invalidRun.taskId, invalidB.id, '候选甲与候选乙都说明同一测试方法，核对重复内容与条件。');
  assert.throws(() => store.recordMaintenanceReports(invalidRun.taskId, [noChange(invalidB)]), /当前|顺序|逐篇/);
  assert.throws(() => store.recordMaintenanceReports(invalidRun.taskId, [noChange(invalidA), noChange(invalidB)]), /一篇|一个|逐篇|当前|一次/);
  assert.throws(() => store.putDraft(invalidRun.taskId, { ...invalidA, expectedVersion: invalidA.version, body: invalidA.body + '\n试图覆盖旧ID。' }), /新建整合|替换原节点/);
  assert.throws(() => draftMerge(invalidRun.taskId, [invalidA, invalidB], '不能伪造来源', 'agent', { sources: [source('unread-forgery')] }), /未获取的来源|来源/);
  const outsideA = store.saveManual(fixture('批外甲', 'outside-a'));
  const outsideB = store.saveManual(fixture('批外乙', 'outside-b'));
  scan(invalidRun.taskId, 'agent', [invalidA.id, invalidB.id, outsideA.id, outsideB.id]);
  assert.throws(() => draftMerge(invalidRun.taskId, [outsideA, outsideB]), /本批|当前输入|当前资料|当前文档/);
  assert.throws(() => draftMerge(invalidRun.taskId, [invalidB, outsideA]), /当前输入|当前资料|当前文档/);
  assert.equal(store.drafts(invalidRun.taskId).length, 0);
  assert.equal(store.libraryDocuments().length, 4);
  assert.equal(store.maintenanceRun(invalidRun.taskId).checked, 0);
  pass('拒绝批量关闭或跳过当前输入、无理由批读、重复ID、未读原稿、旧ID覆盖和伪来源');

  open('cross-directory');
  const crossA = store.saveManual(fixture('01 跨目录甲', 'cross-a'));
  let crossB = store.saveManual(fixture('02 跨目录乙', 'cross-b', 'infra'));
  const crossRun = start(); scan(crossRun.taskId, 'agent', [crossA.id]);
  assert.throws(() => store.scanCategoryBatch(crossRun.taskId, 'infra'), /理由|说明|线索|比较/);
  assert.equal(store.scans(crossRun.taskId).some(item => item.categoryId === 'infra'), false);
  assert.throws(() => store.readCandidate(crossRun.taskId, crossB.id, '两篇跨目录资料都说明相同测试问题，需比较实现与适用条件。'), /父节点|目录/);
  assert.throws(() => draftMerge(crossRun.taskId, [crossA, crossB]), /全部概览|目录|阅读/);
  scan(crossRun.taskId, 'infra', [crossB.id]);
  scan(crossRun.taskId, 'agent', [crossA.id]);
  crossB = store.saveManual({ ...crossB, expectedVersion: crossB.version, body: crossB.body + '\n新的条件。' });
  assert.throws(() => draftMerge(crossRun.taskId, [crossA, crossB]), /目录变化|概览|最新正文|重新/);
  scan(crossRun.taskId, 'infra', [crossB.id]);
  scan(crossRun.taskId, 'agent', [crossA.id]);
  const crossOriginals = [preserve(crossA), preserve(crossB)];
  const crossMerged = publishMerge(crossRun.taskId, [crossA, crossB], '跨目录的整合主题').document;
  assertConsolidated(crossRun, crossOriginals, crossMerged);
  assert.equal(store.documents('infra').length, 0);
  assert.equal(store.documents('agent').length, 1);
  pass('跨目录须逐目录完整概览与最新正文，旧证据拒绝且各目录计数一致');

  open('stale-no-change');
  const staleA = store.saveManual(fixture('01 比较原稿甲', 'stale-a'));
  const staleB = store.saveManual(fixture('02 比较原稿乙', 'stale-b'));
  const unrelated = store.saveManual(fixture('00 先前无需处理项', 'stale-third'));
  const staleRun = start(); scan(staleRun.taskId, 'agent', [staleA.id, staleB.id, unrelated.id]);
  store.recordMaintenanceReports(staleRun.taskId, [noChange(unrelated, [staleA.id])]);
  assert.equal(store.maintenanceRun(staleRun.taskId).checked, 1);
  assert.equal(store.maintenanceInput(staleRun.taskId).id, staleA.id);
  const staleMerged = publishMerge(staleRun.taskId, [staleA, staleB], '取代比较原稿的新主题').document;
  let state = store.maintenanceRun(staleRun.taskId);
  assert.equal(state.checked, 2);
  assert.equal(state.items.find(item => item.documentId === unrelated.id).status, 'pending');
  assert(state.items.filter(item => [staleA.id, staleB.id].includes(item.documentId)).every(item => item.status === 'done' && item.outcome === 'merged'));
  assert.equal(record('maintenance_ledger', unrelated.id), undefined);
  assert.throws(() => store.finishMaintenance(staleRun.taskId), /尚未全部|未完成/);
  scan(staleRun.taskId, 'agent', [unrelated.id, staleMerged.id]);
  store.recordMaintenanceReports(staleRun.taskId, [noChange(unrelated, [staleMerged.id])]);
  store.finishMaintenance(staleRun.taskId);
  assert.equal(store.maintenanceRun(staleRun.taskId).checked, 3);

  open('pinned-input-during-stale-earlier');
  const earlier = store.saveManual(fixture('00 已报告但后来外改', 'pinned-earlier'));
  const pinnedB = store.saveManual(fixture('01 当前待发布原稿', 'pinned-b'));
  const pinnedC = store.saveManual(fixture('02 合并候选原稿', 'pinned-c'));
  const pinnedRun = start();
  scan(pinnedRun.taskId, 'agent', [earlier.id, pinnedB.id, pinnedC.id]);
  store.recordMaintenanceReports(pinnedRun.taskId, [noChange(earlier)]);
  assert.equal(store.maintenanceInput(pinnedRun.taskId).id, pinnedB.id);
  const pinnedDraft = draftMerge(pinnedRun.taskId, [pinnedB, pinnedC], '当前输入草稿的整合稿');
  writeFileSync(owned(path.join(store.dataDir, 'library', `${earlier.id}.md`)), earlier.body + '\n\n完成后人类补充了独立资料的测试条件。');
  assert.equal(store.maintenanceRun(pinnedRun.taskId).items.find(item => item.documentId === earlier.id).status, 'pending');
  assert.equal(store.maintenanceInput(pinnedRun.taskId).id, pinnedB.id, 'Earlier stale work must not steal the anchor of an unpublished merge draft');
  close(); open('pinned-input-during-stale-earlier');
  assert.equal(store.startMaintenance().id, pinnedRun.id);
  assert.equal(store.maintenanceInput(pinnedRun.taskId).id, pinnedB.id, 'The draft anchor remains pinned after restarting and refreshing earlier stale work');
  assert.equal(store.drafts(pinnedRun.taskId).find(draft => draft.draftId === pinnedDraft.draftId).status, 'draft');
  const pinnedPublished = store.submitDraft(pinnedRun.taskId, pinnedDraft.draftId, pinnedDraft.revision, review).document;
  assert.equal(store.maintenanceInput(pinnedRun.taskId).id, earlier.id, 'After publication, earlier stale work returns to the pending queue');
  const freshEarlier = store.document(earlier.id);
  scan(pinnedRun.taskId, 'agent', [freshEarlier.id]);
  store.recordMaintenanceReports(pinnedRun.taskId, [noChange(freshEarlier)]);
  store.finishMaintenance(pinnedRun.taskId);
  assert.equal(store.maintenanceRun(pinnedRun.taskId).checked, 3);
  assert.equal(store.maintenanceRun(pinnedRun.taskId).mergedCount, 1);
  assert.equal(store.document(pinnedB.id).archivedIntoId, pinnedPublished.id);
  assert.equal(store.libraryDocuments().length, 2);
  pass('归档依据使none项重查，较早项失效不抢未发布草稿当前输入；真实合并项保持稳定');

  open('merge-chain');
  const chainA = store.saveManual(fixture('01 链原稿甲', 'chain-a'));
  const chainB = store.saveManual(fixture('02 链原稿乙', 'chain-b'));
  const chainD = store.saveManual(fixture('03 链原稿丙', 'chain-d'));
  const chainOriginals = [preserve(chainA), preserve(chainB), preserve(chainD)];
  const chainRun = start(); scan(chainRun.taskId, 'agent', [chainA.id, chainB.id, chainD.id]);
  const chainC = publishMerge(chainRun.taskId, [chainA, chainB], '第一轮整合主题').document;
  const savedC = preserve(chainC);
  assert.equal(store.maintenanceInput(chainRun.taskId).id, chainD.id, 'Publishing closes both pending participants and advances to the remaining input');
  scan(chainRun.taskId, 'agent', [chainC.id, chainD.id]);
  const chainE = publishMerge(chainRun.taskId, [chainC, chainD], '最终整合主题').document;
  assertConsolidated(chainRun, chainOriginals, chainE);
  assertPreserved(savedC, chainE.id);
  assert.deepEqual(new Set(chainE.sources.map(item => item.id)), new Set([chainA, chainB, chainD].flatMap(document => document.sources.map(item => item.id))));
  assert.equal(store.pendingMaintenance(chainRun.taskId).length, 0);
  assert(store.maintenanceRun(chainRun.taskId).items.every(item => item.mergedDocIds[0] === chainE.id));
  store.finishMaintenance(chainRun.taskId);
  close(); open('merge-chain');
  assert.equal(store.maintenanceState().pendingCount, 0);
  assert.equal(store.document(chainA.id).archivedIntoId, chainE.id);
  assert.throws(() => store.startMaintenance(), /没有新入库/);

  open('done-candidate-merge');
  const doneA = store.saveManual(fixture('01 已无需处理的旧输入', 'done-a'));
  const doneB = store.saveManual(fixture('02 后续当前输入', 'done-b'));
  const doneOriginals = [preserve(doneA), preserve(doneB)];
  const doneRun = start();
  scan(doneRun.taskId, 'agent', [doneA.id]);
  store.recordMaintenanceReports(doneRun.taskId, [noChange(doneA)]);
  assert.equal(store.maintenanceInput(doneRun.taskId).id, doneB.id);
  scan(doneRun.taskId, 'agent', [doneB.id, doneA.id]);
  const doneMerged = publishMerge(doneRun.taskId, [doneB, doneA], '后续输入与已完成候选的整合稿').document;
  assertConsolidated(doneRun, doneOriginals, doneMerged);
  assert(store.maintenanceRun(doneRun.taskId).items.every(item => item.status === 'done' && item.outcome === 'merged'));
  store.finishMaintenance(doneRun.taskId);
  pass('A+B→C再C+D→E与已done候选合并均可推进，全来源和最终替代正确、无重复待办');

  for (const decision of ['A', 'B', 'C']) {
    open(`human-${decision}`);
    const humanA = store.saveManual(fixture('旧说法资料', `human-${decision}-a`));
    const humanB = store.saveManual(fixture('新说法资料', `human-${decision}-b`));
    const humanRun = start(); scan(humanRun.taskId, 'agent', [humanA.id, humanB.id]);
    const conflict = store.reportConflict(humanRun.taskId, { docIds: [humanA.id, humanB.id], sourceIds: [], oldClaim: '旧说法在测试条件下成立', newClaim: '新说法在相同条件下相反', reason: '须核实并等待可信人类裁决。' });
    assert.throws(() => draftMerge(humanRun.taskId, [humanA, humanB]), /知识冲突|分歧/);
    assert.throws(() => store.recordMaintenanceReports(humanRun.taskId, [noChange(humanA)]), /知识冲突|分歧/);
    assert.throws(() => store.finishMaintenance(humanRun.taskId), /知识冲突|分歧/);
    store.reviewConflict(humanRun.taskId, conflict.id, { confirmed: true, review: '测试中的真分歧已经确认。', evidence: [] });
    assert.throws(() => store.reviewConflict(humanRun.taskId, conflict.id, { confirmed: false, review: '模型不得撤销人类裁决等待。', evidence: [] }), /人类|裁决/);
    assert.throws(() => store.resolveConflict(conflict.id, 'Other'), /有效裁决|A、B、C/);
    if (decision === 'C') assert.throws(() => store.resolveConflict(conflict.id, 'C', '条件不同', '条件不同'), /具体|条件/);
    store.resolveConflict(conflict.id, decision, decision === 'C' ? '旧说法仅适用于测试条件甲。' : undefined, decision === 'C' ? '新说法仅适用于测试条件乙。' : undefined);
    assert.throws(() => store.finishMaintenance(humanRun.taskId), /尚未全部|未完成/);
    scan(humanRun.taskId, 'agent', [humanA.id, humanB.id]);
    const humanDraft = draftMerge(humanRun.taskId, [humanA, humanB], `已落实裁决${decision}`, 'agent', { body: `# 已落实裁决${decision}\n\n${decision === 'A' ? '采用旧说法；新说法作为不同意见的来源保留。' : decision === 'B' ? '采用新说法；旧说法作为历史说明保留。' : '旧说法：测试条件甲。新说法：测试条件乙。'}` });
    store.submitDraft(humanRun.taskId, humanDraft.draftId, humanDraft.revision, { ...review, passed: false, fixes: '自检失败，不能归档原稿。' });
    assert.equal(store.libraryDocuments().length, 2);
    assert.equal(store.maintenanceRun(humanRun.taskId).checked, 0);
    const fixed = draftMerge(humanRun.taskId, [humanA, humanB], `已落实裁决${decision}`, 'agent', { draftId: humanDraft.draftId, body: humanDraft.body + '\n\n已核对条件与来源。' });
    store.submitDraft(humanRun.taskId, fixed.draftId, fixed.revision, review);
    store.finishMaintenance(humanRun.taskId);
    assert.equal(store.libraryDocuments().length, 1);
    assert.equal(store.maintenanceRun(humanRun.taskId).diffCount, 1);
  }
  pass('真实分歧锁及独立A/B/C可信裁决，自检未过不能归档或计完成');

  for (const phase of ['journal', 'output', 'transaction', 'post-commit']) {
    const name = `crash-${phase}`;
    open(name);
    const crashA = store.saveManual(fixture('崩溃原稿甲', `${phase}-a`));
    const crashB = store.saveManual(fixture('崩溃原稿乙', `${phase}-b`));
    const crashOriginals = [preserve(crashA), preserve(crashB)];
    const crashRun = start(); scan(crashRun.taskId, 'agent', [crashA.id, crashB.id]);
    const crashDraft = draftMerge(crashRun.taskId, [crashA, crashB], `崩溃恢复-${phase}`);
    const injected = `INJECT_${phase}`;
    if (phase === 'journal') store.finishPublication = () => { throw new Error(injected); };
    else if (phase === 'transaction') {
      const originalCommit = store.commitMaintenanceMerge;
      store.commitMaintenanceMerge = function (journal) { originalCommit.call(this, journal); throw new Error(injected); };
    } else {
      const originalAtomic = store.atomic;
      store.atomic = function (file, body) {
        const publicOutput = file === path.join(this.dataDir, 'library', `${crashDraft.id}.md`);
        const publishedDraft = file === path.join(this.dataDir, 'drafts', `${crashDraft.draftId}.json`) && this.drafts(crashRun.taskId).some(draft => draft.draftId === crashDraft.draftId && draft.status === 'published');
        if (phase === 'post-commit' && publishedDraft) throw new Error(injected);
        originalAtomic.call(this, file, body);
        if (phase === 'output' && publicOutput) throw new Error(injected);
      };
    }
    assert.throws(() => store.submitDraft(crashRun.taskId, crashDraft.draftId, crashDraft.revision, review), new RegExp(injected));
    assert.equal(journalCount(), phase === 'post-commit' ? 0 : 1);
    assert.equal(store.libraryDocuments().length, phase === 'post-commit' ? 1 : 2);
    assert.equal(store.maintenanceRun(crashRun.taskId).checked, phase === 'post-commit' ? 2 : 0);
    close(); open(name);
    assert.equal(journalCount(), 0);
    const recovered = store.document(crashDraft.id);
    assertConsolidated(crashRun, crashOriginals, recovered);
    const duplicate = store.submitDraft(crashRun.taskId, crashDraft.draftId, crashDraft.revision, review);
    assert.equal(duplicate.document.id, recovered.id);
    assert.equal(store.versions(recovered.id).length, 1);
    assert.equal(store.libraryDocuments().length, 1);
    store.finishMaintenance(crashRun.taskId);
  }
  pass('journal/正文落盘/事务回滚/提交后中断均可恢复，重复提交不重复归档或生成版本');

  open('abandon-stale-input');
  const abandonedA = store.saveManual(fixture('中断原稿甲', 'abandon-a'));
  const abandonedB = store.saveManual(fixture('中断原稿乙', 'abandon-b'));
  const abandonedRun = start(); scan(abandonedRun.taskId, 'agent', [abandonedA.id, abandonedB.id]);
  const abandonedDraft = draftMerge(abandonedRun.taskId, [abandonedA, abandonedB], '应停止恢复的整合稿');
  const originalAtomic = store.atomic;
  store.atomic = function (file, body) {
    originalAtomic.call(this, file, body);
    if (file === path.join(this.dataDir, 'library', `${abandonedDraft.id}.md`)) throw new Error('INJECT_STALE_OUTPUT');
  };
  assert.throws(() => store.submitDraft(abandonedRun.taskId, abandonedDraft.draftId, abandonedDraft.revision, review), /INJECT_STALE_OUTPUT/);
  const externalBody = abandonedA.body + '\n\n中断后人类修改了原始依据。';
  writeFileSync(owned(path.join(store.dataDir, 'library', `${abandonedA.id}.md`)), externalBody);
  close(); open('abandon-stale-input');
  assert.equal(journalCount(), 0);
  assert.equal(rows('document_archive').length, 0);
  assert.equal(store.libraryDocuments().length, 2);
  assert.equal(store.maintenanceRun(abandonedRun.taskId).checked, 0);
  assert.equal(rows('abandoned_publication').length, 1);
  assert.equal(store.drafts(abandonedRun.taskId).find(draft => draft.draftId === abandonedDraft.draftId).status, 'draft');
  assert.equal(record('maintenance_ledger', abandonedDraft.id), undefined);
  assert.equal(readFileSync(path.join(store.dataDir, 'library', `${abandonedA.id}.md`), 'utf8'), externalBody);
  const recoveredOutputs = filesUnder(path.join(store.dataDir, 'drafts')).filter(file => path.basename(file).startsWith('recovered-'));
  assert.equal(recoveredOutputs.length, 1);
  assert.equal(readFileSync(recoveredOutputs[0], 'utf8'), abandonedDraft.body);
  const latestA = store.document(abandonedA.id);
  scan(abandonedRun.taskId, 'agent', [latestA.id, abandonedB.id]);
  const retry = draftMerge(abandonedRun.taskId, [latestA, abandonedB], abandonedDraft.title, 'agent', { draftId: abandonedDraft.draftId });
  store.submitDraft(abandonedRun.taskId, retry.draftId, retry.revision, review);
  assert.equal(store.libraryDocuments().length, 1);
  assert.equal(store.document(abandonedA.id).archivedIntoId, retry.id);
  pass('原稿外部变化后放弃旧发布，不归档/认证；中断输出保留草稿并可重新读取后重试');

  open('explicit-reset');
  const resetA = store.saveManual(fixture('清理时保留的甲资料', 'reset-a'));
  const resetB = store.saveManual(fixture('清理时保留的乙资料', 'reset-b'));
  const other = store.createTask('必须保留的普通研究', [resetA.id]);
  store.updateTask(other.id, { status: 'paused' });
  store.addMessage(other.id, 'user', '普通研究记录不能被维护清理删除。');
  store.event(other.id, '测试过程', '只属于普通研究的过程。');
  store.markCategoriesRead(other.id);
  store.scanCollectionCategory(other.id, 'agent', { title: resetA.title });
  store.readCandidate(other.id, resetA.id);
  const resetRun = start();
  store.addMessage(resetRun.taskId, 'user', '这是应清理的旧维护对话。');
  store.event(resetRun.taskId, '维护检查', '应删除的维护过程。');
  store.putRaw({ id: 'retained-original-material', taskId: resetRun.taskId, title: '必须保留的原始资料', kind: 'text', text: '原始资料不是维护对话记录。', coverage: '完整隔离测试正文', status: 'available', createdAt: '2026-10-12T00:00:00Z' });
  scan(resetRun.taskId, 'agent', [resetA.id, resetB.id]);
  while (store.maintenanceInput(resetRun.taskId)) {
    const input = store.document(store.maintenanceInput(resetRun.taskId).id);
    scan(resetRun.taskId, input.categoryId);
    store.recordMaintenanceReports(resetRun.taskId, [noChange(input)]);
  }
  store.finishMaintenance(resetRun.taskId);
  const resetFolder = store.dataDir;
  close();
  withDb(db => {
    const old = JSON.parse(db.prepare("SELECT value FROM records WHERE kind='maintenance_run' AND id=?").get(resetRun.taskId).value);
    old.items[0].relatedDocIds = [resetB.id]; old.items[0].relatedVersions = { [resetB.id]: resetB.version };
    db.prepare("UPDATE records SET value=? WHERE kind='maintenance_run' AND id=?").run(JSON.stringify(old), resetRun.taskId);
  }, false, resetFolder);
  open('explicit-reset');
  const protectedBefore = protectedSnapshot(other.id);
  const result = store.resetMaintenanceHistory();
  assert.equal(result.deletedTasks, 1);
  assert(result.backupPath && existsSync(result.backupPath));
  const backupDatabase = path.extname(result.backupPath) === '.sqlite' ? result.backupPath : path.join(result.backupPath, 'app.sqlite');
  const backup = new DatabaseSync(owned(backupDatabase), { readOnly: true });
  try {
    assert(backup.prepare("SELECT value FROM records WHERE kind='maintenance_run' AND id=?").get(resetRun.taskId));
    assert.equal(Number(backup.prepare("SELECT count(*) AS n FROM records WHERE kind='maintenance_ledger'").get().n), 2);
  } finally { backup.close(); }
  for (const kind of ['maintenance_run', 'maintenance_ledger', 'maintenance_meta']) assert.equal(rows(kind).length, 0);
  assert.equal(record('task', resetRun.taskId), undefined);
  assert.equal(rows('message').some(row => JSON.parse(row.value).taskId === resetRun.taskId), false);
  assert.equal(rows('event').some(row => JSON.parse(row.value).taskId === resetRun.taskId), false);
  assert.deepEqual(withDb(db => db.prepare('SELECT kind,id,value FROM records').all().filter(row => {
    if (row.kind === 'raw') return false; // Raw provenance is intentionally retained even when its producing maintenance task is removed.
    const value = JSON.parse(row.value);
    return value.taskId === resetRun.taskId || ['categories_read', 'round_boundary'].includes(row.kind) && row.id === resetRun.taskId;
  }).map(row => ({ kind: row.kind, id: row.id }))), [], 'Reset must also remove task-scoped scan/read evidence, without deleting raw provenance');
  assert.deepEqual(protectedSnapshot(other.id), protectedBefore);
  assert.equal(store.maintenanceState().pendingCount, 2);
  assert.equal(store.maintenanceState().run, undefined);
  assert.equal(store.maintenanceState().lastCompletedAt, undefined);
  const beforeSecondReset = protectedSnapshot(other.id);
  assert.equal(store.resetMaintenanceHistory().deletedTasks, 0);
  assert.deepEqual(protectedSnapshot(other.id), beforeSecondReset);
  pass('显式清旧维护限定任务/ledger/meta并先备份，真实文档/raw/版本及其它任务完整保留');

  open('cross-directory-abandon-retry');
  const retryA = store.saveManual(fixture('01 需重新扫描的甲原稿', 'cross-retry-a'));
  const retryB = store.saveManual(fixture('02 需重新扫描的乙原稿', 'cross-retry-b', 'infra'));
  const retryRun = start();
  scan(retryRun.taskId, 'agent', [retryA.id]);
  scan(retryRun.taskId, 'infra', [retryB.id]);
  const initialCrossDraft = draftMerge(retryRun.taskId, [retryA, retryB], '中断前的标题', 'infra');
  const crossAtomic = store.atomic;
  store.atomic = function (file, body) {
    crossAtomic.call(this, file, body);
    if (file === path.join(this.dataDir, 'library', `${initialCrossDraft.id}.md`)) throw new Error('INJECT_CROSS_RETRY_AFTER_SNAPSHOT');
  };
  assert.throws(() => store.submitDraft(retryRun.taskId, initialCrossDraft.draftId, initialCrossDraft.revision, review), /INJECT_CROSS_RETRY_AFTER_SNAPSHOT/);
  const retryFolder = store.dataDir;
  const existingSnapshots = filesUnder(path.join(retryFolder, 'history', initialCrossDraft.id)).map(file => [path.relative(retryFolder, file), digest(readFileSync(file))]);
  assert.equal(existingSnapshots.filter(([file]) => file.endsWith('.json')).length, 1);
  close();
  // A whitespace-only external edit changes the source version without changing
  // the semantic material or the eventual merged body bytes used below.
  writeFileSync(owned(path.join(retryFolder, 'library', `${retryA.id}.md`)), retryA.body + '\n');
  open('cross-directory-abandon-retry');
  assert.equal(rows('document_archive').length, 0);
  assert.equal(journalCount(), 0);
  assert.equal(store.drafts(retryRun.taskId).find(draft => draft.draftId === initialCrossDraft.draftId).status, 'draft');
  assert.throws(() => scan(retryRun.taskId, 'model-training'), /未发布|合并|参与|目录|范围/);
  assert.equal(store.scans(retryRun.taskId).some(item => item.categoryId === 'model-training'), false);
  assert.throws(() => store.finishMaintenance(retryRun.taskId), /未发布草稿/);
  const refreshedA = store.document(retryA.id);
  assert.equal(refreshedA.version, retryA.version + 1);
  scan(retryRun.taskId, 'agent', [refreshedA.id]);
  scan(retryRun.taskId, 'infra', [retryB.id]);
  const retriedCrossDraft = draftMerge(retryRun.taskId, [refreshedA, retryB], '重试后更新的标题', 'infra', {
    draftId: initialCrossDraft.draftId, body: initialCrossDraft.body,
    description: '重试只更新标题和概览；整合正文保持原字节。',
  });
  assert.equal(retriedCrossDraft.id, initialCrossDraft.id);
  assert.equal(retriedCrossDraft.body, initialCrossDraft.body);
  assert.equal(retriedCrossDraft.revision, initialCrossDraft.revision + 1);
  const retriedCrossResult = store.submitDraft(retryRun.taskId, retriedCrossDraft.draftId, retriedCrossDraft.revision, review).document;
  assert.equal(retriedCrossResult.title, retriedCrossDraft.title);
  assert.equal(retriedCrossResult.description, retriedCrossDraft.description);
  assert.equal(store.libraryDocuments().length, 1);
  assert.equal(store.document(retryA.id).archivedIntoId, retriedCrossResult.id);
  assert.equal(store.document(retryB.id).archivedIntoId, retriedCrossResult.id);
  assert.equal(store.versions(retriedCrossResult.id).length, 1);
  for (const [file, expected] of existingSnapshots) assert.equal(digest(readFileSync(path.join(retryFolder, file))), expected);
  assert.equal(filesUnder(path.join(retryFolder, 'history', initialCrossDraft.id)).filter(file => file.endsWith('.json')).length, 2);
  store.finishMaintenance(retryRun.taskId);
  pass('跨目录中断草稿可重扫来源再回目标修订，第三目录拒绝；同正文重试不碰撞既有历史快照');

  open('invalidated-review-replay');
  const epochA = store.saveManual(fixture('审批原稿甲', 'epoch-a'));
  const epochB = store.saveManual(fixture('审批原稿乙', 'epoch-b'));
  const reporter = store.createTask('另一研究发现真实分歧', [epochA.id, epochB.id]);
  store.updateTask(reporter.id, { status: 'paused' });
  store.markCategoriesRead(reporter.id);
  store.scanCollectionCategory(reporter.id, 'agent', { title: epochA.title });
  store.scanCollectionCategory(reporter.id, 'agent', { title: epochB.title });
  store.readCandidate(reporter.id, epochA.id); store.readCandidate(reporter.id, epochB.id);
  const epochRun = start(); scan(epochRun.taskId, 'agent', [epochA.id, epochB.id]);
  const staleApproval = draftMerge(epochRun.taskId, [epochA, epochB], '需要重新审批的整合稿');
  const epochAtomic = store.atomic;
  store.atomic = function (file, body) {
    epochAtomic.call(this, file, body);
    if (file === path.join(this.dataDir, 'library', `${staleApproval.id}.md`)) throw new Error('INJECT_APPROVAL_JOURNAL');
  };
  assert.throws(() => store.submitDraft(epochRun.taskId, staleApproval.draftId, staleApproval.revision, review), /INJECT_APPROVAL_JOURNAL/);
  const pendingApproval = withDb(db => JSON.parse(db.prepare('SELECT value FROM publication_journal').get().value));
  assert.equal(pendingApproval.draftReviewEpoch, record('draft_review_epoch', staleApproval.draftId)?.value ?? 0);
  const discovered = store.reportConflict(reporter.id, { docIds: [epochA.id, epochB.id], sourceIds: [], oldClaim: '旧结论在测试条件下成立', newClaim: '相同条件下的新结论相反', reason: '另一任务发现真实分歧，使旧草稿审批失效。' });
  assert.equal(store.drafts(epochRun.taskId).find(draft => draft.draftId === staleApproval.draftId).review, undefined);
  assert(record('draft_review_epoch', staleApproval.draftId).value > pendingApproval.draftReviewEpoch);
  assert.throws(() => draftMerge(epochRun.taskId, [epochA, epochB], '不能越过当前分歧'), /知识冲突|分歧/);
  store.reviewConflict(reporter.id, discovered.id, { confirmed: true, review: '相同条件下的真分歧已经确认。', evidence: [] });
  store.resolveConflict(discovered.id, 'A');
  assert.equal(store.document(epochA.id).version, epochA.version);
  assert.equal(store.document(epochB.id).version, epochB.version);
  close(); open('invalidated-review-replay');
  assert.equal(journalCount(), 0);
  assert.equal(rows('document_archive').length, 0);
  assert.equal(store.libraryDocuments().length, 2);
  assert.equal(store.maintenanceRun(epochRun.taskId).checked, 0);
  assert.equal(rows('abandoned_publication').length, 1);
  const invalidated = store.drafts(epochRun.taskId).find(draft => draft.draftId === staleApproval.draftId);
  assert.equal(invalidated.status, 'draft'); assert.equal(invalidated.review, undefined);
  assert.equal(record('maintenance_ledger', staleApproval.id), undefined);
  scan(epochRun.taskId, 'agent', [epochA.id, epochB.id]);
  const approvedAgain = draftMerge(epochRun.taskId, [epochA, epochB], '已按可信裁决重新整理', 'agent', {
    draftId: staleApproval.draftId, body: staleApproval.body + '\n\n可信裁决A：采用旧结论；新说法作为已审查的历史意见保留。',
  });
  assert.equal(approvedAgain.revision, staleApproval.revision + 1);
  store.submitDraft(epochRun.taskId, approvedAgain.draftId, approvedAgain.revision, review);
  store.finishMaintenance(epochRun.taskId);
  assert.equal(store.libraryDocuments().length, 1);
  assert.equal(store.document(epochA.id).archivedIntoId, approvedAgain.id);
  assert.equal(store.document(epochB.id).archivedIntoId, approvedAgain.id);
  pass('另一任务分歧使旧审批epoch失效；源版本不变也不能重放旧journal，新修订自检后才发布');

  assert.equal(checks, 12);
  console.log('All 12 isolated consolidation checks passed; no real library, configuration, or model request was used.');
} finally {
  close();
  const resolved = path.resolve(scratch), base = path.resolve(tmpdir());
  if (!resolved.startsWith(base + path.sep) || !path.basename(resolved).startsWith('maintenance-consolidation-verify-')) throw new Error('Refusing cleanup outside the isolated temporary directory');
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}
