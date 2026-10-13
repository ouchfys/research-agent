import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { projectRoot as workspace, qaRoot } from './workspace.mjs';
const scratch = mkdtempSync(path.join(qaRoot, 'research-ingestion-retry-check-'));
let store;
try {
  await build({ stdin: { contents: "export { Store } from './src/server/store'; export { ResearchAgent } from './src/server/agent';", resolveDir: workspace, loader: 'ts' }, outfile: path.join(scratch, 'check.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { Store, ResearchAgent } = await import(pathToFileURL(path.join(scratch, 'check.mjs')).href);
  store = new Store(path.join(scratch, 'data'));
  const config = { public: () => ({ text: { configured: false } }), redact: value => value instanceof Error ? value.message : String(value) };
  const seed = count => {
    const task = store.createTask('独立重试检查', [], 'collection');
    store.updateTask(task.id, { kind: 'ingestion' });
    const raws = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), taskId: task.id, title: `材料 ${i}`, kind: 'web', url: `https://example.com/${i}`, text: '', coverage: '未获取', status: 'unavailable', createdAt: new Date().toISOString(), metadata: { inputRole: 'input' } }));
    for (const raw of raws) store.putRaw(raw);
    store.ensureTaskInputs(task.id);
    store.updateTask(task.id, { retrySourceIds: raws.map(raw => raw.id) });
    return { task, raws };
  };
  const first = seed(2), calls = [];
  const agent = new ResearchAgent(store, config, { async retryMaterial(taskId, raw) {
    calls.push(raw.id);
    if (raw.id === first.raws[0].id) throw new Error('本项来源失败');
    return { ...raw, id: randomUUID(), taskId, text: '已重试取得的真实测试内容', status: 'available', metadata: { retryOf: raw.id } };
  } }, () => {});
  await agent.start(first.task.id, '重试失败项', [], false);
  assert.deepEqual(calls, first.raws.map(raw => raw.id));
  assert.deepEqual(store.task(first.task.id).retrySourceIds, []);
  assert.equal(store.taskInputs(first.task.id)[0].status, 'blocked');
  assert.equal(store.taskInputs(first.task.id)[1].sourceIds.length, 2);
  assert.equal(store.task(first.task.id).status, 'unconfigured');
  assert.equal(store.task(first.task.id).sessionFile, undefined);

  const cancelled = seed(2);
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const cancelledCalls = [];
  const pausable = new ResearchAgent(store, config, { async retryMaterial(_taskId, raw, _progress, signal) {
    cancelledCalls.push(raw.id); notifyStarted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } }, () => {});
  const running = pausable.start(cancelled.task.id, '重试', [], false);
  await started;
  await pausable.pause(cancelled.task.id);
  await running;
  assert.equal(cancelledCalls.length, 1);
  assert.deepEqual(store.task(cancelled.task.id).retrySourceIds, cancelled.raws.map(raw => raw.id));
  assert.equal(store.taskInputs(cancelled.task.id)[0].status, 'pending');
  assert.equal(store.task(cancelled.task.id).status, 'paused');
  console.log('PASS: retry continues after one failure, saves source lineage, keeps cancellation checkpoint, and never calls a model without configuration.');
} finally {
  store?.close();
  const resolved = path.resolve(scratch);
  if (path.dirname(resolved) !== qaRoot || !path.basename(resolved).startsWith('research-ingestion-retry-check-')) throw new Error('Refusing unexpected cleanup path.');
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}
