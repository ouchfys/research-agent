import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { projectRoot as workspace, qaRoot } from './workspace.mjs';

// Run Config and the SDK import in a child with a whitelist environment. The
// test never loads the user's .env, settings, data directory or credentials.
if (!process.argv.includes('--isolated')) {
  const scratch = mkdtempSync(path.join(qaRoot, 'research-maintenance-service-test-'));
  try {
    const environment = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) if (process.env[name]) environment[name] = process.env[name];
    Object.assign(environment, { SHELF_TEST_SCRATCH: scratch, SHELF_PROJECT_DIR: scratch, SHELF_ENV_FILE: path.join(scratch, 'nonexistent-test.env'), SHELF_DATA_DIR: path.join(scratch, 'library-a') });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], { cwd: scratch, env: environment, encoding: 'utf8' });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== qaRoot || !path.basename(resolved).startsWith('research-maintenance-service-test-')) throw new Error('Refusing cleanup outside the isolated workspace test directory.');
    if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
  }
} else {
  const scratch = path.resolve(process.env.SHELF_TEST_SCRATCH || '');
  assert.equal(path.dirname(scratch), qaRoot);
  assert(path.basename(scratch).startsWith('research-maintenance-service-test-'));
  const output = path.join(scratch, 'service.mjs');
  await build({ entryPoints: [path.join(workspace, 'src/server/service.ts')], outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { ShelfService } = await import(pathToFileURL(output).href);
  const calls = [];
  const events = [];
  const service = new ShelfService(path.join(scratch, 'config'), path.join(scratch, 'library-a'), event => events.push(event));
  const active = new Map();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const fakeAgent = {
    busy: () => active.size > 0,
    isRunning: taskId => active.has(taskId),
    start(taskId, content, files, ingest) {
      calls.push({ type: 'start', taskId, content, files: structuredClone(files), ingest });
      service.store.updateTask(taskId, { status: 'running', stage: 'maintenance' });
      return new Promise(resolve => active.set(taskId, resolve));
    },
    async pause(taskId) {
      calls.push({ type: 'pause', taskId });
      service.store.updateTask(taskId, { status: 'paused', stage: 'paused' });
      const resolve = active.get(taskId);
      active.delete(taskId);
      resolve?.();
      await settle();
    },
    async shutdown() {
      for (const taskId of [...active.keys()]) await this.pause(taskId);
    },
  };
  service.agent = fakeAgent;
  const passed = name => console.log(`PASS ${name}`);
  const document = title => ({ categoryId: 'agent', title, description: `${title}的研究方法与条件。`, aliases: [], paperIds: [], sources: [], body: `# ${title}\n\n研究知识正文。`, expectedVersion: 0 });
  const scope = state => ({ dataDir: state.dataDir, ...(state.run ? { runId: state.run.id } : {}) });
  async function stopTask(taskId) { await fakeAgent.pause(taskId); await settle(); }
  async function releaseTask(taskId) { const resolve = active.get(taskId); active.delete(taskId); resolve?.(); await settle(); }

  try {
    for (const provider of Object.values(service.config.public().providers)) assert.equal(provider.hasKey, false);
    const a = service.store.saveManual(document('RPC 新文档 A'));
    const b = service.store.saveManual(document('RPC 新文档 B'));
    const initial = await service.call('maintenance.get', { dataDir: service.store.dataDir });
    assert.equal(initial.pendingCount, 2);
    assert.equal(initial.run, undefined);
    const started = await service.call('maintenance.start', scope(initial));
    assert.equal(started.run.total, 2);
    assert.equal(started.run.status, 'running');
    assert.equal(service.store.task(started.run.taskId).retrievalMode, 'maintenance');
    assert.deepEqual(new Set(service.store.task(started.run.taskId).selectedDocIds), new Set([a.id, b.id]));
    const dispatched = calls.at(-1);
    assert.equal(dispatched.ingest, false);
    assert.deepEqual(dispatched.files, []);
    assert(dispatched.content.includes('逐篇书架整理'));
    assert(dispatched.content.includes('maintenanceInput'));
    assert.equal(service.store.raws(started.run.taskId).length, 0);
    const late = service.store.saveManual(document('RPC 运行中新入库'));
    assert.equal((await service.call('maintenance.get', scope(started))).run.total, 2);
    await assert.rejects(() => service.call('maintenance.start', scope(started)), /已有研究或维护正在运行/);
    passed('启动创建固定maintenance任务，模型入口仅被stub记录且ingest=false；运行中新文档不改变分母');

    const beforeRejected = calls.length;
    const foreignDataDir = path.join(scratch, 'library-b');
    for (const method of ['maintenance.get', 'maintenance.start', 'maintenance.pause', 'maintenance.resume']) await assert.rejects(() => service.call(method, { dataDir: foreignDataDir, runId: started.run.id }), /知识库已切换/);
    for (const method of ['maintenance.pause', 'maintenance.resume']) await assert.rejects(() => service.call(method, { dataDir: started.dataDir, runId: 'foreign-run-id' }), /维护批次已变化/);
    assert.equal(calls.length, beforeRejected);
    const paused = await service.call('maintenance.pause', scope(started));
    assert.equal(paused.run.id, started.run.id);
    assert.equal(paused.run.status, 'paused');
    assert.equal(fakeAgent.busy(), false);
    const resumed = await service.call('maintenance.resume', scope(paused));
    assert.equal(resumed.run.id, started.run.id);
    assert.equal(resumed.run.taskId, started.run.taskId);
    assert.equal(resumed.run.status, 'running');
    assert.equal(calls.at(-1).ingest, false);
    assert.deepEqual(calls.at(-1).files, []);
    await service.call('maintenance.pause', scope(resumed));
    const fixed = [...service.store.task(started.run.taskId).selectedDocIds];
    await assert.rejects(() => service.call('task.context', { taskId: started.run.taskId, selectedDocIds: [late.id] }), /维护待办批次已经固定/);
    assert.deepEqual(service.store.task(started.run.taskId).selectedDocIds, fixed);
    passed('跨库和旧run请求在执行前拒绝；暂停恢复复用同一批次；generic上下文入口不能改变固定范围');

    service.store.markCategoriesRead(started.run.taskId);
    assert.equal(service.store.scanCategoryBatch(started.run.taskId, 'agent').scan.complete, true);
    const scansBefore = service.store.scans(started.run.taskId);
    const startsBefore = calls.filter(call => call.type === 'start').length;
    await assert.rejects(() => service.call('task.message', { taskId: started.run.taskId, text: '不允许增加维护附件', uploads: [{ name: 'new.md', mimeType: 'text/markdown', data: Buffer.from('# 新文件').toString('base64') }] }), /维护批次范围固定/);
    assert.equal(calls.filter(call => call.type === 'start').length, startsBefore);
    await service.call('task.message', { taskId: started.run.taskId, text: `继续检查本批内容。引用 library/${late.id}.md 不改变批次。`, selectedDocIds: [late.id], uploads: [] });
    assert.equal(calls.at(-1).ingest, false);
    assert.deepEqual(calls.at(-1).files, []);
    assert.deepEqual(service.store.task(started.run.taskId).selectedDocIds, fixed);
    assert.deepEqual(service.store.scans(started.run.taskId), scansBefore);
    assert.equal(service.store.raws(started.run.taskId).length, 0);
    await stopTask(started.run.taskId);
    passed('维护追问不创建新轮次、不扩selectedDocIds、不摄入材料；附件在调度前拒绝');

    const ordinary = await service.call('task.start', { text: '普通研究与资料收集', selectedDocIds: [], uploads: [] });
    assert.equal(ordinary.retrievalMode, 'collection');
    assert.equal(calls.at(-1).ingest, true);
    await stopTask(ordinary.id);
    await service.call('task.resume', { taskId: started.run.taskId });
    assert.equal(calls.at(-1).ingest, false);
    assert(calls.at(-1).content.includes('逐篇书架整理'));
    assert.deepEqual(service.store.task(started.run.taskId).selectedDocIds, fixed);
    await stopTask(started.run.taskId);
    passed('普通task.start默认collection；generic task.resume沿用固定维护提示与ingest=false');

    const report = value => ({ documentId: value.id, version: value.version, outcome: 'no_change', comparedDocIds: [], summary: '已读取当前输入全文并核对本分类概览，没有同一具体问题的候选需要进一步比较。' });
    const currentInput = service.store.maintenanceInput(started.run.taskId);
    const laterInput = [a, b].find(value => value.id !== currentInput.id);
    assert.throws(() => service.store.recordMaintenanceReports(started.run.taskId, [report(laterInput)]), /不能跳过它登记其它待办文档/);
    for (let remaining = 2; remaining > 0; remaining--) {
      const value = service.store.maintenanceInput(started.run.taskId);
      assert(value);
      service.store.readCandidate(started.run.taskId, value.id);
      service.store.recordMaintenanceReports(started.run.taskId, [report(value)]);
    }
    service.store.finishMaintenance(started.run.taskId);
    const complete = await service.call('maintenance.get', scope(started));
    assert.equal(complete.run.status, 'completed');
    assert.equal(complete.run.checked, 2);
    const callsBeforeComplete = calls.length;
    const completeTaskBefore = service.store.task(started.run.taskId);
    const completeTurnBefore = service.store.turns(started.run.taskId);
    const pausedComplete = await service.call('maintenance.pause', scope(complete));
    assert.equal(pausedComplete.run.status, 'completed');
    assert.deepEqual(service.store.task(started.run.taskId), completeTaskBefore);
    await service.call('task.pause', { taskId: started.run.taskId });
    assert.deepEqual(service.store.task(started.run.taskId), completeTaskBefore);
    await assert.rejects(() => service.call('maintenance.resume', scope(complete)), /本批维护已经完成/);
    await assert.rejects(() => service.call('task.resume', { taskId: started.run.taskId }), /本批维护已经完成/);
    await assert.rejects(() => service.call('task.message', { taskId: started.run.taskId, text: '不能继续旧的完成批次', uploads: [] }), /本批维护已经完成/);
    assert.equal(calls.length, callsBeforeComplete);
    assert.deepEqual(service.store.turns(started.run.taskId), completeTurnBefore);
    const next = await service.call('maintenance.start', { dataDir: complete.dataDir });
    assert.notEqual(next.run.id, complete.run.id);
    assert.deepEqual(next.run.items.map(item => item.documentId), [late.id]);
    await service.call('maintenance.pause', scope(next));
    passed('已完成维护pause无副作用；所有resume/message绕路均拒绝且不生成回合；下一次只检查运行中新文档');

    const originalDataDir = service.store.dataDir;
    await service.call('storage.switch', { dataDir: foreignDataDir, mode: 'open' });
    service.agent = fakeAgent;
    assert.equal(service.store.dataDir, foreignDataDir);
    assert.equal((await service.call('maintenance.get', { dataDir: foreignDataDir })).run, undefined);
    await assert.rejects(() => service.call('maintenance.resume', { dataDir: originalDataDir, runId: next.run.id }), /知识库已切换/);
    await assert.rejects(() => service.call('maintenance.resume', { dataDir: foreignDataDir, runId: next.run.id }), /维护批次已变化/);
    await service.call('storage.switch', { dataDir: originalDataDir, mode: 'open' });
    service.agent = fakeAgent;
    const restored = await service.call('maintenance.get', { dataDir: originalDataDir });
    assert.equal(restored.run.id, next.run.id);
    assert.equal(restored.run.total, 1);
    assert.equal(restored.run.status, 'paused');
    assert(restored.lastCompletedAt);
    assert(events.some(event => event.type === 'storage.changed'));
    passed('真实storage.switch只触及临时库，原维护checkpoint可恢复且新库无法使用旧run');
    await releaseTask(next.run.taskId);
    console.log('Maintenance RPC lifecycle tests passed without model or network requests.');
  } finally {
    await service.close();
  }
}
