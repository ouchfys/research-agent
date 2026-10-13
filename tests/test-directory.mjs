import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { projectRoot, qaRoot } from './workspace.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const scratch = mkdtempSync(path.join(qaRoot, 'research-directory-test-'));
const output = path.join(scratch, 'store.mjs');
await build({ entryPoints: [path.join(projectRoot, 'src/server/store.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
const { Store } = await import(pathToFileURL(output).href);
let store;
const fixture = (categoryId, title = '已有研究文档') => ({
  categoryId, title, description: '现有知识文档的真实简介。', aliases: ['已有主题'], paperIds: ['arXiv:2601.01885'],
  body: '# 已有主题\n\n原始研究正文与完整结论。', expectedVersion: 0,
  sources: [{ id: 'original-source', title: '原始论文', kind: 'paper', coverage: '完整论文正文', accessedAt: '2026-10-01T08:00:00Z', url: 'https://arxiv.org/abs/2601.01885' }],
});
const open = name => { store = new Store(path.join(scratch, name)); return store; };
const close = () => { store?.close(); store = undefined; };
const passed = name => console.log(`PASS ${name}`);

try {
  open('library');
  const originalCategories = store.categories();
  assert.equal(originalCategories.length, 3);
  assert(originalCategories.every(category => category.parentId === null));
  const original = store.saveManual(fixture('model-training'));
  const originalBody = readFileSync(path.join(store.dataDir, 'library', `${original.id}.md`), 'utf8');
  const child = store.saveCategory({ parentId: 'agent', name: '记忆研究', scopeConfirmed: false });
  assert.equal(child.description, '');
  assert.equal(child.includes, '');
  assert.equal(child.excludes, '');
  assert.equal(child.scopeConfirmed, false);
  assert.equal(store.document(original.id).categoryId, 'model-training');
  assert.deepEqual(store.categories().filter(category => originalCategories.some(previous => previous.id === category.id)), originalCategories.map(category => ({ ...category, count: category.id === original.categoryId ? 1 : 0, metadataVersion: category.metadataVersion + (category.id === original.categoryId ? 1 : 0) })));
  const root = store.saveCategory({ name: '个人研究' });
  assert.equal(root.parentId, null);
  assert.equal(root.scopeConfirmed, false);
  const beforeInvalid = store.categories();
  assert.throws(() => store.saveCategory({ parentId: child.id, name: '三级目录' }), /一级和二级/);
  assert.throws(() => store.saveCategory({ id: 'agent', parentId: child.id, name: 'Agent' }), /自身/);
  assert.throws(() => store.saveCategory({ id: 'agent', parentId: root.id, name: 'Agent' }), /已有子目录/);
  assert.throws(() => store.saveCategory({ parentId: 'missing-parent', name: '错误父级' }), /不存在/);
  assert.throws(() => store.saveCategory({ parentId: '', name: '错误父级' }), /父目录/);
  assert.throws(() => store.saveCategory({ parentId: 'agent', name: '  记忆研究  ' }), /同名/);
  assert.throws(() => store.saveCategory({ name: 'ＡＧＥＮＴ' }), /同名/);
  assert.throws(() => store.saveCategory({ name: '缺少真实范围', scopeConfirmed: true }), /分类介绍/);
  assert.throws(() => store.saveCategory({ name: '缺少包含范围', scopeConfirmed: true, description: '真实简介' }), /纳入范围/);
  assert.deepEqual(store.categories(), beforeInvalid);
  const confirmed = store.saveCategory({ id: child.id, name: child.name, scopeConfirmed: true, description: '研究 Agent 记忆。', includes: 'Agent 记忆机制与管理方法。' });
  assert.equal(confirmed.scopeConfirmed, true);
  passed('名称即可创建未确认一级/二级目录；非法父级、三级、循环、重复名称与虚假确认均不改变旧目录');

  const task = store.createTask('保留现有文档身份', [original.id], 'maintenance');
  store.updateTask(task.id, { status: 'paused' });
  store.markCategoriesRead(task.id);
  store.selectCategory(task.id, original.categoryId);
  assert.equal(store.scanPage(task.id, original.categoryId, 1).scan.complete, true);
  store.readCandidate(task.id, original.id);
  const draft = store.putDraft(task.id, { ...fixture(original.categoryId), id: original.id, body: '# 已有主题\n\n尚未发布的补充研究。', expectedVersion: original.version });
  const review = { materialUnderstanding: '已对照原始论文。', speculation: '事实与推测已区分。', conditions: '已说明条件。', methodIdentity: '方法身份一致。', conflicts: '无知识冲突。', structure: '结构完整。', metadataConsistency: '标题简介正文一致。', passed: true, fixes: '' };
  const reviewed = store.reviewDraft(task.id, draft.draftId, review);
  const draftFile = readFileSync(path.join(store.dataDir, 'drafts', `${draft.draftId}.json`), 'utf8');
  const targetTask = store.createTask('目标目录扫描', [], 'maintenance');
  store.updateTask(targetTask.id, { status: 'paused' });
  store.markCategoriesRead(targetTask.id);
  store.selectCategory(targetTask.id, child.id);
  assert.equal(store.scanPage(targetTask.id, child.id, 1).scan.complete, true);
  const beforeMove = store.categories();
  const moved = store.moveDocument(original.id, child.id, original.version);
  assert.equal(moved.id, original.id);
  assert.equal(moved.categoryId, child.id);
  assert.equal(moved.version, original.version + 1);
  assert.equal(moved.body, original.body);
  assert.equal(moved.createdAt, original.createdAt);
  assert.deepEqual(moved.sources, original.sources);
  assert.deepEqual(moved.aliases, original.aliases);
  assert.deepEqual(moved.paperIds, original.paperIds);
  assert.equal(readFileSync(path.join(store.dataDir, 'library', `${original.id}.md`), 'utf8'), originalBody);
  assert.equal(store.libraryDocuments().length, 1);
  assert.equal(store.documents(original.categoryId).length, 0);
  assert.equal(store.documents(child.id)[0].id, original.id);
  const versions = store.versions(original.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].reason, '移动书架目录');
  assert.equal(versions[1].categoryId, original.categoryId);
  assert.deepEqual(store.drafts(task.id), [reviewed]);
  assert.equal(readFileSync(path.join(store.dataDir, 'drafts', `${draft.draftId}.json`), 'utf8'), draftFile);
  for (const categoryId of [original.categoryId, child.id]) assert.equal(store.categories().find(category => category.id === categoryId).metadataVersion, beforeMove.find(category => category.id === categoryId).metadataVersion + 1);
  assert.throws(() => store.publishDraft(task.id, draft.draftId), /扫描已失效/);
  assert.equal(store.scanPage(task.id, original.categoryId, 1).scan.complete, true);
  assert.throws(() => store.publishDraft(task.id, draft.draftId), /草稿不能覆盖新版本/);
  // Reading a moved candidate must reset a previously complete target scan.
  assert.throws(() => store.readCandidate(targetTask.id, original.id), /扫描|简介/);
  assert.equal(store.scans(targetTask.id).at(-1).complete, false);
  assert.equal(store.moveDocument(original.id, child.id, moved.version).version, moved.version);
  assert.equal(store.versions(original.id).length, 2);
  assert.throws(() => store.moveDocument(original.id, root.id, original.version), /版本已变化/);
  assert.throws(() => store.moveDocument(original.id, 'missing-category', moved.version), /不存在/);
  assert.throws(() => store.moveDocument('missing-document', root.id, 1), /不存在/);
  assert.throws(() => store.moveDocument(original.id, root.id, 0), /预期版本/);
  const collision = store.saveManual({ ...fixture(root.id), title: original.title, aliases: [], paperIds: [] });
  assert.throws(() => store.moveDocument(original.id, root.id, moved.version), /另一篇文档/);
  assert.equal(store.document(collision.id).body, collision.body);
  assert.equal(store.document(original.id).categoryId, child.id);
  passed('移动保留文档/来源/正文/历史/草稿身份，递增版本与双目录版本，拒绝旧扫描、版本冲突和身份覆盖');

  for (const status of ['queued', 'running']) {
    store.updateTask(task.id, { status });
    assert.throws(() => store.moveDocument(original.id, root.id, moved.version), /研究仍在运行/);
    assert.throws(() => store.saveCategory({ name: '研究期间新建' }), /研究仍在运行/);
    store.updateTask(task.id, { status: 'paused' });
  }
  store.beginTurn(task.id);
  assert.throws(() => store.moveDocument(original.id, root.id, moved.version), /研究仍在运行/);
  store.finishTurn(task.id);
  store.updateTask(task.id, { status: 'paused' });
  close();
  open('library');
  assert.equal(store.document(original.id).categoryId, child.id);
  assert.equal(store.document(original.id).body, original.body);
  assert.equal(store.drafts(task.id)[0].draftId, draft.draftId);
  assert.equal(store.drafts(task.id)[0].baseVersion, original.version);
  passed('研究排队/运行/实际回合期间拒绝目录写入；重开旧资料仍保持文档及草稿身份');
  store.reportConflict(task.id, { docIds: [original.id], sourceIds: [], oldClaim: '旧研究结论', newClaim: '待核实的新结论', reason: '需要核实适用条件。' });
  assert.throws(() => store.moveDocument(original.id, root.id, moved.version), /知识冲突/);
  assert.throws(() => store.saveCategory({ name: '冲突期间新建' }), /知识冲突/);
  assert.equal(store.libraryDocuments().length, 2);
  passed('知识冲突期间拒绝目录写入，但全部文档元数据仍可只读查询');
  close();

  open('recovery');
  const recoverDoc = store.saveManual(fixture('model-training', '持久化恢复测试'));
  const hash = createHash('sha256').update(recoverDoc.body).digest('hex').slice(0, 16);
  const collisionPath = path.join(store.dataDir, 'history', recoverDoc.id, `v2-${hash}.json`);
  mkdirSync(collisionPath);
  assert.throws(() => store.moveDocument(recoverDoc.id, 'agent', recoverDoc.version));
  assert.equal(store.libraryDocuments()[0].categoryId, 'model-training');
  assert.equal(store.libraryDocuments()[0].version, 1);
  assert.equal(readFileSync(path.join(store.dataDir, 'library', `${recoverDoc.id}.md`), 'utf8'), recoverDoc.body);
  close();
  rmdirSync(collisionPath);
  open('recovery');
  assert.equal(store.recovered, true);
  assert.equal(store.document(recoverDoc.id).categoryId, 'agent');
  assert.equal(store.document(recoverDoc.id).version, 2);
  assert.equal(store.versions(recoverDoc.id).length, 2);
  assert.equal(store.categories().find(category => category.id === 'model-training').count, 0);
  assert.equal(store.categories().find(category => category.id === 'agent').count, 1);
  passed('持久化故障不留下半移动；重启由既有 durable journal 恢复且只产生一个新版本');
  close();

  open('external-recovery');
  const externalDoc = store.saveManual(fixture('model-training', '保留外部编辑测试'));
  const externalCollision = path.join(store.dataDir, 'history', externalDoc.id, `v2-${hash}.json`);
  mkdirSync(externalCollision);
  assert.throws(() => store.moveDocument(externalDoc.id, 'agent', 1));
  const file = path.join(store.dataDir, 'library', `${externalDoc.id}.md`);
  writeFileSync(file, '# 外部编辑\n\n故障期间用户的最新正文。');
  close();
  rmdirSync(externalCollision);
  open('external-recovery');
  const preserved = store.document(externalDoc.id);
  assert.equal(preserved.categoryId, 'model-training');
  assert.equal(preserved.body, '# 外部编辑\n\n故障期间用户的最新正文。');
  assert.equal(preserved.version, 2);
  passed('中断移动后发现外部正文修改时保留用户编辑，不强制完成旧移动');
  close();

  // A real older-library fixture may contain deeper user-created categories.
  // Opening it must neither reshape those categories nor move any documents.
  const legacyDir = path.join(scratch, 'legacy');
  open('legacy');
  const legacyDoc = store.saveManual(fixture('model-training', '旧版本资料'));
  close();
  const database = new DatabaseSync(path.join(legacyDir, 'app.sqlite'));
  const oldChild = { id: 'legacy-child', parentId: 'model-training', name: '旧二级', description: '旧简介', includes: '旧范围', excludes: '', scopeConfirmed: true, metadataVersion: 1 };
  const oldGrandchild = { ...oldChild, id: 'legacy-grandchild', parentId: oldChild.id, name: '旧三级' };
  for (const category of [oldChild, oldGrandchild]) database.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run('category', category.id, JSON.stringify(category));
  database.close();
  open('legacy');
  assert.equal(store.categories().find(category => category.id === oldGrandchild.id).parentId, oldChild.id);
  assert.equal(store.document(legacyDoc.id).categoryId, 'model-training');
  store.saveCategory({ id: oldGrandchild.id, name: '旧三级改名' });
  assert.throws(() => store.saveCategory({ parentId: oldChild.id, name: '新三级' }), /一级和二级/);
  passed('既有目录保持原层级与资料位置；允许旧目录名称维护但拒绝新增非法层级');
  close();
  console.log('Directory tests passed.');
} finally {
  close();
  const resolved = path.resolve(scratch);
  if (!resolved.startsWith(qaRoot + path.sep) || !path.basename(resolved).startsWith('research-directory-test-')) throw new Error('Refusing cleanup outside the isolated test directory.');
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}
