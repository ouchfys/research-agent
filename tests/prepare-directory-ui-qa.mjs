import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { parse } from 'dotenv';
import path from 'node:path';
import { projectRoot as project, qaRoot as qaCache } from './workspace.mjs';

// UI mutations run against a snapshot, never against the user's library.
const qaRoot = path.join(qaCache, 'shelf-directory-qa');
if (existsSync(qaRoot)) throw new Error('QA 快照已存在；请先清理 .cache/qa/shelf-directory-qa，再创建新的隔离快照。');
const env = existsSync(path.join(project, '.env')) ? parse(await readFile(path.join(project, '.env'))) : {};
const savedPath = path.join(project, '.local', 'config', 'settings.json');
const saved = existsSync(savedPath) ? JSON.parse(await readFile(savedPath, 'utf8')) : {};
const source = path.resolve(process.argv[2] || saved.dataDir || env.SHELF_DATA_DIR || path.join(project, '.local', 'data'));
const destination = path.join(qaRoot, '.local', 'data');
await mkdir(destination, { recursive: true });
const db = new DatabaseSync(path.join(source, 'app.sqlite'), { readOnly: true });
const records = db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all();
const digest = value => createHash('sha256').update(value).digest('hex');
const bodies = {};
for (const row of records.filter(row => row.kind === 'document')) {
  const item = JSON.parse(row.value).meta;
  bodies[item.id] = digest(await readFile(path.join(source, 'library', `${item.id}.md`)));
}
await writeFile(path.join(qaRoot, 'source-baseline.json'), JSON.stringify({ source, records: digest(JSON.stringify(records)), bodies }, null, 2));
await backup(db, path.join(destination, 'app.sqlite'));
db.close();
for (const folder of ['library', 'drafts', 'history']) if (existsSync(path.join(source, folder))) await cp(path.join(source, folder), path.join(destination, folder), { recursive: true });
for (const folder of ['dist']) await cp(path.join(project, folder), path.join(qaRoot, folder), { recursive: true });
await writeFile(path.join(qaRoot, 'package.json'), JSON.stringify({ name: 'research-shelf-directory-qa', version: '0.0.0', main: 'dist/electron/main.cjs' }));
await writeFile(path.join(qaRoot, '.env'), `SHELF_DATA_DIR=${destination.replaceAll('\\', '/')}\n`);
console.log(JSON.stringify({ qaRoot, source, categories: records.filter(row => row.kind === 'category').map(row => { const item = JSON.parse(row.value); return { id: item.id, name: item.name, parentId: item.parentId }; }), documents: Object.keys(bodies).length }));
