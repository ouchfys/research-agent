import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { StorageInspection } from '../shared/types';

const MANIFEST = '.shelf-location.json';
type Location = { schema: 1; root: string; previousRoots: string[] };
export type StorageSelection = { source: string; sourceRoots: string[]; target: string; mode: 'move' | 'open'; empty: boolean };

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

export function storageRoots(dataDir: string): string[] {
  const file = join(dataDir, MANIFEST);
  if (!existsSync(file)) return [resolve(dataDir)];
  const value = JSON.parse(readFileSync(file, 'utf8')) as Location;
  if (value.schema !== 1 || typeof value.root !== 'string' || !isAbsolute(value.root) || !Array.isArray(value.previousRoots) || value.previousRoots.some(root => typeof root !== 'string' || !isAbsolute(root))) throw new Error('知识库位置记录无效，请保留目录并检查 .shelf-location.json。');
  return [...new Set([resolve(dataDir), resolve(value.root), ...value.previousRoots.map(root => resolve(root))])];
}

/** Historical Markdown and Pi messages remain byte-for-byte unchanged. Only
 * resolve old absolute asset references into the current authorized library. */
export function relocatedPath(dataDir: string, value: string): string {
  if (!isAbsolute(value)) return value;
  for (const root of storageRoots(dataDir)) if (inside(root, value)) return join(dataDir, relative(root, value));
  return value;
}

async function canonicalTarget(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('知识库位置必须是绝对路径。');
  if (value.includes('\0') || (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(value.replace(/^[a-z]:/i, '')) || value.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))))) throw new Error('知识库位置包含系统不支持的文件夹名称，请重新选择。');
  let current = resolve(value); const parts: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('无法找到目标磁盘或父目录。');
    parts.unshift(basename(current)); current = parent;
  }
  const info = await lstat(current);
  if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error('目标位置的父路径不是目录。');
  return join(await realpath(current), ...parts);
}

/** Explain the selection without creating directories, opening a writable
 * Store, or changing the current location. The switch revalidates it later. */
export async function inspectStorage(sourceDir: string, requested: string): Promise<StorageInspection> {
  const requestedPath = requested.trim(), result: StorageInspection = { requestedPath, status: 'invalid', exists: false, canCopy: false, canOpen: false, message: '' };
  try {
    const target = await canonicalTarget(requestedPath), source = await realpath(sourceDir);
    result.targetPath = target; result.exists = existsSync(target);
    if (relative(source, target) === '') return { ...result, status: 'current', message: '这就是当前知识库位置，无需切换。' };
    const selection = await readSelection(sourceDir, requestedPath, 'open');
    if (selection.empty) return { ...result, status: result.exists ? 'empty' : 'missing', canCopy: true, canOpen: true, recommendedMode: 'move', message: result.exists ? '这是空文件夹。可将当前知识库复制到这里，或在这里新建空知识库。' : '这个文件夹还不存在。确认后会创建，可复制当前知识库或新建空知识库。' };
    const documentCount = await inspectDatabaseSnapshot(target);
    return { ...result, status: 'library', canOpen: true, recommendedMode: 'open', documentCount, message: '这里已有研究书架知识库。可打开它，当前知识库保留在原位置。' };
  } catch (error) {
    // Database and filesystem exceptions can contain SQL or internal details;
    // keep the preflight result useful without displaying those diagnostics.
    const message = error instanceof Error ? error.message : '';
    result.message = /^(?:知识库位置|无法找到目标|目标位置|新旧知识库|目标知识库|迁移需要|所选文件夹|知识库含有|知识库包含|知识库位置记录|目标 app\.sqlite|目标知识库包含|目标知识库正在更新)/.test(message) ? message : '无法读取这个位置或识别其中的知识库，请选择可访问的空文件夹或完整知识库目录。';
    return result;
  }
}

function validateDatabaseRecords(db: DatabaseSync): void {
  const required: Record<string, string[]> = { records: ['kind', 'id', 'value'], versions: ['doc_id', 'version', 'value'], publication_journal: ['id', 'value'], counters: ['id', 'value'] };
  for (const [table, columns] of Object.entries(required)) {
    const found = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some(column => !found.some(row => row.name === column))) throw new Error('目标 app.sqlite 不是可识别的研究书架知识库。');
  }
  for (const row of db.prepare('SELECT kind, value FROM records').all() as { kind: string; value: string }[]) {
    const value = JSON.parse(row.value) as Record<string, unknown>;
    if (!value || typeof value !== 'object') throw new Error('目标知识库包含损坏的记录。');
    // Opening a library restores its persisted conflict lock in Store. It
    // must remain possible to open that library in order to resolve it.
  }
}

function validateDatabase(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, 'app.sqlite'), { readOnly: true });
  try { validateDatabaseRecords(db); } finally { db.close(); }
}

async function inspectDatabaseSnapshot(dataDir: string): Promise<number> {
  // SQLite readOnly can still create WAL coordination files. Inspect a bounded
  // temporary copy so even an existing target library remains untouched.
  const base = await realpath(tmpdir()), temporary = await mkdtemp(join(base, 'bookshelf-storage-inspect-'));
  const files = ['app.sqlite', 'app.sqlite-wal'];
  const stamps = () => Promise.all(files.map(async file => {
    try { const value = await stat(join(dataDir, file), { bigint: true }); return `${value.size}:${value.mtimeNs}:${value.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }));
  try {
    const before = await stamps();
    if (!before[0]) throw new Error('目标 app.sqlite 不是可识别的研究书架知识库。');
    try { for (let index = 0; index < files.length; index++) if (before[index]) await copyFile(join(dataDir, files[index]), join(temporary, files[index])); }
    catch { throw new Error('目标知识库正在更新或暂时无法读取，请关闭使用它的其他窗口后重试。'); }
    const after = await stamps();
    if (before.some((stamp, index) => stamp !== after[index])) throw new Error('目标知识库正在更新，请等待保存完成或关闭使用它的其他窗口后重试。');
    const db = new DatabaseSync(join(temporary, 'app.sqlite'), { readOnly: true });
    try {
      validateDatabaseRecords(db);
      return Number((db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='document' AND id NOT IN (SELECT id FROM records WHERE kind='document_archive')").get() as {count:number}).count);
    } finally { db.close(); }
  } finally {
    const target = resolve(temporary);
    if (dirname(target) !== base || !basename(target).startsWith('bookshelf-storage-inspect-')) throw new Error('临时预检目录校验失败。');
    await rm(target, { recursive: true, force: true });
  }
}

async function assertPlainTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('知识库含有符号链接或目录联接，请先将其改为实际文件后切换。');
    if (entry.isDirectory()) await assertPlainTree(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('知识库包含不支持的特殊文件。');
  }
}

/** Legacy libraries did not have a location manifest. A library copied through
 * Explorer can still recover its old root from the known persisted layout. */
function rootsFromRecords(dataDir: string): string[] {
  const roots = storageRoots(dataDir), db = new DatabaseSync(join(dataDir, 'app.sqlite'), { readOnly: true });
  try {
    for (const row of db.prepare("SELECT kind,value FROM records WHERE kind IN ('task','raw')").all() as {kind:string;value:string}[]) {
      const value = JSON.parse(row.value) as {sessionFile?:unknown;filePath?:unknown;id?:unknown};
      if (row.kind === 'task' && typeof value.sessionFile === 'string' && isAbsolute(value.sessionFile) && basename(dirname(value.sessionFile)).toLowerCase() === 'sessions') roots.push(dirname(dirname(value.sessionFile)));
      if (row.kind === 'raw' && typeof value.filePath === 'string' && isAbsolute(value.filePath) && typeof value.id === 'string' && basename(dirname(value.filePath)) === value.id && basename(dirname(dirname(value.filePath))).toLowerCase() === 'raw') roots.push(dirname(dirname(dirname(value.filePath))));
    }
  } finally { db.close(); }
  return [...new Set(roots.map(root => resolve(root)))];
}

async function readSelection(sourceDir: string, requested: string, mode: 'move' | 'open'): Promise<StorageSelection> {
  const source = await realpath(sourceDir), target = await canonicalTarget(requested.trim());
  if (inside(source, target) || inside(target, source)) throw new Error('新旧知识库必须是不同且互不包含的目录，不能选自身、父目录或子目录。');
  let empty = true;
  if (existsSync(target)) {
    if (!(await lstat(target)).isDirectory()) throw new Error('目标知识库位置不是文件夹。');
    empty = (await readdir(target)).length === 0;
  }
  if (mode === 'move' && !empty) throw new Error('迁移需要一个空文件夹，避免覆盖已有文件。已有知识库请使用“打开已有知识库”。');
  if (mode === 'open' && !empty) {
    if (!existsSync(join(target, 'app.sqlite'))) throw new Error('所选文件夹不是知识库，也不是空文件夹。请选择包含 app.sqlite 的研究书架目录。');
    await assertPlainTree(target);
    storageRoots(target);
  }
  return { source, sourceRoots: [...new Set([source, ...storageRoots(sourceDir)])], target, mode, empty };
}

export async function selectStorage(sourceDir: string, requested: string, mode: 'move' | 'open'): Promise<StorageSelection> {
  const selection = await readSelection(sourceDir, requested, mode);
  if (mode === 'open' && !selection.empty) validateDatabase(selection.target);
  return selection;
}

async function durableJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

/** Copy only ordinary files and directories. Do not follow links outside a
 * knowledge base or accidentally retain links back into the old live library. */
async function copyLibrary(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('知识库含有符号链接或目录联接，请先将其改为实际文件后迁移。');
    if (entry.isDirectory()) await copyLibrary(from, to);
    else if (entry.isFile()) { await copyFile(from, to); const handle = await open(to, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
    else throw new Error('知识库含有不支持迁移的特殊文件。');
  }
}

async function commitCopy(staging: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (existsSync(target)) throw new Error('目标文件夹在迁移期间出现新文件，已停止，未覆盖目标。');
    try { await rename(staging, target); return; }
    catch (error) {
      // Windows indexers may hold the freshly closed SQLite files briefly.
      // Retry only transient locks; the destination check runs on every try.
      const code = (error as NodeJS.ErrnoException).code || '';
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

function rewritePaths(value: unknown, roots: string[], target: string, key = ''): unknown {
  if (typeof value === 'string') {
    // Keep document bodies, version hashes and Pi conversation history intact.
    // Only explicit structured path fields are storage implementation details.
    if (!/(?:path|file|files|dir|directory)$/i.test(key) || !isAbsolute(value)) return value;
    for (const root of roots) if (inside(root, value)) return join(target, relative(root, value));
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rewritePaths(item, roots, target, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewritePaths(item, roots, target, name)]));
  return value;
}

async function rebaseMetadata(physicalDir: string, target: string, roots: string[]): Promise<void> {
  // Record aliases first so interrupted rebasing remains repeatable even when
  // some database fields or source.json files have already been updated.
  await durableJson(join(physicalDir, MANIFEST), { schema: 1, root: target, previousRoots: roots.filter(root => relative(root, target) !== '') } satisfies Location);
  const db = new DatabaseSync(join(physicalDir, 'app.sqlite'));
  try {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      const update = db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?');
      for (const row of db.prepare("SELECT kind,id,value FROM records WHERE kind IN ('task','raw')").all() as {kind:string;id:string;value:string}[]) {
        const next = rewritePaths(JSON.parse(row.value), roots, target);
        update.run(JSON.stringify(next), row.kind, row.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const rawDir = join(physicalDir, 'raw');
  if (existsSync(rawDir)) for (const entry of await readdir(rawDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('原始材料目录含有符号链接，无法迁移。');
    const file = entry.isDirectory() ? join(rawDir, entry.name, 'source.json') : /^[a-zA-Z0-9_-]+\.json$/.test(entry.name) && !entry.name.startsWith('pending-') ? join(rawDir, entry.name) : null;
    if (file && existsSync(file)) {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('原始材料记录含有符号链接，无法迁移。');
      const value = JSON.parse(readFileSync(file, 'utf8'));
      await durableJson(file, rewritePaths(value, roots, target));
    }
  }
}

/** Called only after the current Store is closed. A failed transfer keeps the
 * original and leaves any staging copy clearly separate from the requested path. */
export async function prepareStorage(selection: StorageSelection): Promise<void> {
  const { source, sourceRoots, target, mode, empty } = selection;
  if (mode === 'open') {
    if (empty) { if(existsSync(target) && (await readdir(target)).length)throw new Error('目标文件夹已出现新文件，请重新选择知识库位置。');await mkdir(target, { recursive: true }); return; }
    const roots = rootsFromRecords(target);
    if (roots.some(root => relative(root, target) !== '')) await rebaseMetadata(target, target, roots);
    return;
  }
  // Windows can reject mkdir('E:\\', { recursive: true }) even when the
  // existing drive root is writable. Only create a missing parent directory.
  if (!existsSync(dirname(target))) await mkdir(dirname(target), { recursive: true });
  const staging = join(dirname(target), `.${basename(target)}.shelf-copy-${randomUUID()}`);
  await mkdir(staging);
  try {
    await copyLibrary(source, staging);
    await rebaseMetadata(staging, target, sourceRoots);
    validateDatabase(staging);
    if (existsSync(target)) {
      if ((await readdir(target)).length) throw new Error('目标文件夹在迁移期间出现新文件，已停止，未覆盖目标。');
      // rmdir refuses nonempty directories; never recursively remove user paths.
      await rmdir(target);
    }
    await commitCopy(staging, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法复制知识库。';
    throw new Error(`${message} 原知识库保持不变；未完成副本保留在 ${staging}，未将其设为当前知识库。`);
  }
}
