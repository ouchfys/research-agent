import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { projectRoot } from './workspace.mjs';

const bundle = await build({ entryPoints: [path.join(projectRoot, 'src/server/agent-context.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
const { appendRuntimeContext } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const entries = [];
const manager = {
  buildContextEntries: () => entries,
  appendCustomMessageEntry: (customType, content, display, details) => entries.push({ type: 'custom_message', customType, content, display, details }),
};
const payload = () => JSON.parse(entries.at(-1).content.split('\n').at(-1));
const state = (items, checked = 0) => ({ retrievalMode: 'maintenance', maintenance: { id: 'batch-one', total: 2, checked, items } });
const pending = [{ documentId: 'a', status: 'pending', comparedDocIds: ['z', 'y'] }, { documentId: 'b', status: 'pending', comparedDocIds: [] }];
assert.equal(appendRuntimeContext(manager, state(pending)), true);
assert.equal(payload().mode, 'snapshot');
assert.equal(appendRuntimeContext(manager, state([...pending].reverse())), false);
assert.equal(appendRuntimeContext(manager, state([{ ...pending[0], status: 'done', comparedDocIds: ['y', 'z'] }, pending[1]], 1)), true);
assert.equal(payload().set['maintenance.checked'], 1);
assert.equal(payload().set.maintenance, undefined);
assert.deepEqual(payload().collections['maintenance.items'].upsert.map(item => item.documentId), ['a']);
assert.deepEqual(payload().collections['maintenance.items'].remove, []);
assert.equal(appendRuntimeContext(manager, { retrievalMode: 'collection', maintenance: null }), true);
assert.equal(payload().set.maintenance, null);
assert.ok(payload().unset.includes('maintenance.items'));
assert.equal(appendRuntimeContext(manager, state(pending)), true);
assert.equal(payload().set['maintenance.items'].length, 2);
entries.push({ type: 'compaction', id: 'compressed' });
assert.equal(appendRuntimeContext(manager, state(pending)), true);
assert.equal(payload().mode, 'snapshot');
console.log('PASS maintenance context: stable ordering, per-document delta, counters, null transition and compaction baseline');
