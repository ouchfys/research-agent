import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { qaRoot } from './workspace.mjs';

const baseline = JSON.parse(await readFile(path.join(qaRoot, 'shelf-directory-qa', 'source-baseline.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(path.join(baseline.source, 'app.sqlite'), { readOnly: true });
const records = db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all();
assert.equal(digest(JSON.stringify(records)), baseline.records, 'Original library metadata changed during verification');
for (const [id, original] of Object.entries(baseline.bodies)) assert.equal(digest(await readFile(path.join(baseline.source, 'library', `${id}.md`))), original, `Original document ${id} changed`);
db.close();
console.log(`PASS 原知识库元数据与 ${Object.keys(baseline.bodies).length} 篇正文哈希全部保持一致。`);
