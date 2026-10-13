import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Category, Conflict, DocumentMeta, Draft, HistoryClearResult, InputOutcome, KnowledgeDocument, MaintenanceItem, MaintenanceReport, MaintenanceRun, MaintenanceState, Message, RawMaterial, ResearchTurn, Scan, SelfReview, SourceRef, Task, TaskEvent, TaskInput, Version } from '../shared/types.js';
import type { ApiUsageRecord } from '../shared/usage.js';
import { migrateMaintenanceRelations } from './maintenance-migration.js';

type StoredDocument = { meta: DocumentMeta; hash: string };
export type CollectionIdentity = { title?: string; aliases?: string[]; paperIds?: string[] };
type StoredScan = Scan & { round: number; readVersions: Record<string, number>; identity?: CollectionIdentity };
type StoredMaintenanceItem = MaintenanceItem & { comparedVersions?: Record<string, number> };
type StoredMaintenanceRun = Pick<MaintenanceRun, 'id'|'taskId'|'startedAt'|'updatedAt'|'completedAt'|'currentDocumentId'|'currentDocumentTitle'> & { policyVersion?: number; items: StoredMaintenanceItem[] };
type MaintenanceLedger = { documentId: string; checkedVersion: number; runId: string; completedAt: string };
type DocumentInput = { id?: string; categoryId: string; title: string; description: string; aliases?: string[]; paperIds?: string[]; body: string; sources?: SourceRef[]; expectedVersion: number };
type Journal = { id: string; next: KnowledgeDocument; previous?: KnowledgeDocument; reason: string; draftId?: string; draftRevision?: number; draftReviewEpoch?: number; taskId?: string; mergeFrom?: Array<{ id: string; version: number }> };
type DocumentArchive = { documentId: string; replacementId: string; version: number; taskId: string; mergedAt: string };
type DocumentSummary = Pick<DocumentMeta, 'id' | 'categoryId' | 'title' | 'description' | 'aliases' | 'paperIds' | 'version'>;
export type CategoryBatch = {
  scope: 'category' | 'identity';
  note?: string;
  scan: Pick<Scan, 'taskId' | 'categoryId' | 'metadataVersion' | 'total' | 'complete'> & { provided: number };
  documents: DocumentSummary[];
  continuation: string | null;
};
type StoredCategoryBatch = { taskId: string; categoryId: string; round: number; metadataVersion: number; offset: number; batch: number; progress: string; result?: CategoryBatch };
type DraftSubmission = { taskId: string; draftId: string; revision: number; reviewEpoch: number; fingerprint: string; createdAt: string };
export const SCAN_BATCH_MAX_CHARACTERS = 24_000;

const now = () => new Date().toISOString();
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const id = () => randomUUID();
const active = (c: Conflict) => c.status === 'suspected' || c.status === 'confirmed';
const normal = (s: string) => s.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
const identity = (s: string) => normal(s).replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//, 'arxiv:').replace(/\.pdf$/, '').replace(/^(arxiv:\d{4}\.\d{4,5})v\d+$/, '$1');
const cleanList = (items: string[] = []) => [...new Set(items.map(s => s.trim()).filter(Boolean))];
function required(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
  if (value.length > max) throw new Error(`${label}过长（上限 ${max} 字符）。`);
  return value.trim();
}
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) throw new Error('无效的数据 ID。');
  return value;
}
function checkedReview(review: SelfReview): SelfReview {
  if (!review || typeof review !== 'object' || typeof review.passed !== 'boolean' || typeof review.fixes !== 'string') throw new Error('自检必须包含七项结论、是否通过和集中修正说明。');
  return {
    materialUnderstanding: required(review.materialUnderstanding, '自检项 materialUnderstanding', 20_000),
    speculation: required(review.speculation, '自检项 speculation', 20_000),
    conditions: required(review.conditions, '自检项 conditions', 20_000),
    methodIdentity: required(review.methodIdentity, '自检项 methodIdentity', 20_000),
    conflicts: required(review.conflicts, '自检项 conflicts', 20_000),
    structure: required(review.structure, '自检项 structure', 20_000),
    metadataConsistency: required(review.metadataConsistency, '自检项 metadataConsistency', 20_000),
    passed: review.passed, fixes: review.fixes.trim(),
  };
}

/** SQLite owns metadata; Markdown files are the readable, editable document bodies.
 * A durable journal bridges both stores. Every successful revision also has an
 * immutable full snapshot, including metadata, in SQLite and under history/.
 */
export class Store {
  readonly dataDir: string;
  recovered = false;
  private db: DatabaseSync;
  private activeTurns = new Map<string, { id: string; inputs: Map<string, string>; publications: Set<string> }>();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    for (const sub of ['', 'library', 'raw', 'drafts', 'history', 'sessions']) mkdirSync(path.join(this.dataDir, sub), { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'app.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS versions (doc_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(doc_id,version));
      CREATE TABLE IF NOT EXISTS publication_journal (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters(id,value) VALUES('categories',1);`);
    migrateMaintenanceRelations(this.db, this.dataDir);
    if (!this.all<Category>('category').length) this.seedCategories();
    else this.migrateInitialCategories();
    this.recoverPublications();
    // A crashed process cannot provide its exact stop time. Count only the
    // observed active interval, never the hours for which the app was closed.
    for (const turn of this.all<ResearchTurn>('turn')) if (turn.runningSince) {
      const end = turn.lastActivityAt || turn.runningSince;
      const inputs = new Map((turn.inputs || []).map(input => [input.id, input]));
      for (const input of this.taskInputs(turn.taskId)) if (input.updatedAt >= turn.runningSince) inputs.set(input.id, input);
      const publications = new Map((turn.publications || []).map(item => [`${item.id}:${item.version}`, item]));
      for (const draft of this.drafts(turn.taskId)) if (draft.status === 'published' && draft.updatedAt >= turn.runningSince) {
        const version = draft.publishedVersion || draft.version;
        publications.set(`${draft.id}:${version}`, { id: draft.id, title: draft.title, version, draftId: draft.draftId });
      }
      this.put('turn', turn.id, { ...turn, inputs: [...inputs.values()], publications: [...publications.values()], elapsedMs: turn.elapsedMs + Math.max(0, Date.parse(end) - Date.parse(turn.runningSince)), runningSince: undefined, finishedAt: end, status: 'paused', legacy: true });
    }
    for (const task of this.all<Task>('task')) {
      if (task.status === 'running' || task.status === 'queued') {
        const confirmed = this.conflicts().some(c => c.status === 'confirmed' && c.taskId === task.id);
        const suspected = this.conflicts().some(c => c.status === 'suspected' && c.taskId === task.id);
        this.put('task', task.id, { ...task, status: confirmed ? 'waiting_user' : 'paused', stage: confirmed ? '等待用户裁决' : suspected ? '已恢复，等待继续核实疑似冲突' : '已恢复，等待继续', updatedAt: now() });
        this.event(task.id, '恢复', '应用上次退出时任务尚未结束，材料、草稿和会话已保留。');
        this.recovered = true;
      }
    }
    if (this.conflicts().some(active) || this.all<Draft>('draft').some(d => d.status !== 'published')) this.recovered = true;
  }

  close(): void { this.db.close(); }

  private get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  private all<T>(kind: string): T[] {
    return (this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as { value: string }[]).map(row => JSON.parse(row.value) as T);
  }
  private put(kind: string, key: string, value: unknown): void {
    this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, key, JSON.stringify(value));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private atomic(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx'); writeFileSync(fd, body, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(tmp, file);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
      throw error;
    }
  }
  private immutable(file: string, body: string): void {
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') !== body) throw new Error('历史版本完整性异常，已拒绝覆盖。');
      return;
    }
    this.atomic(file, body);
  }
  private libraryPath(docId: string): string { return path.join(this.dataDir, 'library', `${safeId(docId)}.md`); }
  private category(categoryId: string): Category {
    const category = this.get<Category>('category', categoryId);
    if (!category) throw new Error('分类不存在。');
    return category;
  }
  private bumpCategory(categoryId: string): number {
    const cat = this.category(categoryId);
    cat.metadataVersion += 1; this.put('category', cat.id, cat); return cat.metadataVersion;
  }
  private categoryVersion(): number { return Number((this.db.prepare("SELECT value FROM counters WHERE id='categories'").get() as { value: number }).value); }
  private currentScan(taskId: string): StoredScan | undefined {
    const boundary = this.get<{ after: number }>('round_boundary', taskId)?.after ?? 0;
    return this.all<StoredScan>('scan').filter(s => s.taskId === taskId && s.round > boundary).sort((a, b) => b.round - a.round)[0];
  }
  private saveScan(scan: StoredScan): void { this.put('scan', `${scan.taskId}:${scan.round}`, scan); }
  private publicScan(scan: StoredScan): Scan {
    const { round: _round, readVersions: _readVersions, identity: _identity, ...visible } = scan; return visible;
  }
  private conflictOwners(): Set<string> { return new Set(this.conflicts().filter(active).map(c => c.taskId)); }

  /** This is a strict, fail-closed action list while a conflict is outstanding.
   * It deliberately does not accept patterns such as arbitrary '*.read'. */
  assertAllowed(action: string, taskId?: string): void {
    const conflicts = this.conflicts().filter(active);
    if (!conflicts.length) return;
    const passive = new Set(['system.read', 'library.read', 'categories.read', 'conflict.read', 'settings.read', 'task.read', 'task.pause', 'conflict.resolve']);
    if (passive.has(action)) return;
    const investigation = new Set(['candidate.read', 'draft.read', 'raw.read', 'source.read', 'source.fetch', 'source.search', 'source.paper', 'conflict.explain', 'conflict.review', 'conflict.report', 'task.followup', 'task.resume']);
    if (taskId && this.conflictOwners().has(taskId) && investigation.has(action)) return;
    throw new Error('知识冲突尚未处理：当前只允许核实、解释当前冲突及接收明确的人类裁决，其他操作已暂停。');
  }

  categories(): Category[] {
    const docs = this.activeDocuments();
    return this.all<Category>('category').map(c => ({ ...c, count: docs.filter(d => d.meta.categoryId === c.id).length }));
  }
  markCategoriesRead(taskId: string): Category[] {
    this.assertAllowed('category.scan', taskId); this.task(taskId);
    this.put('categories_read', taskId, { version: this.categoryVersion(), at: now() });
    return this.categories();
  }
  private assertDirectoryMutable(action: 'category.save' | 'document.move'): void {
    this.assertAllowed(action);
    if (this.activeTurns.size || this.tasks().some(task => task.status === 'running' || task.status === 'queued')) throw new Error('研究仍在运行，请先暂停或等待完成后修改书架目录。');
  }
  saveCategory(input: Partial<Category> & { name: string }): Category {
    this.assertDirectoryMutable('category.save');
    const prior = input.id ? this.category(input.id) : undefined;
    const categoryId = prior?.id ?? id();
    const parentId = input.parentId === undefined ? prior?.parentId ?? null : input.parentId;
    if (parentId !== null && (typeof parentId !== 'string' || !parentId)) throw new Error('父目录 ID 无效。');
    const hierarchyChanged = !prior || parentId !== (prior.parentId ?? null);
    const categories = this.all<Category>('category');
    if (parentId) {
      let cursor: Category | undefined = this.category(parentId);
      const seen = new Set<string>([categoryId]);
      let ancestors = 0;
      while (cursor) {
        if (seen.has(cursor.id)) throw new Error('分类不能成为自身的子分类。');
        ancestors += 1;
        seen.add(cursor.id); cursor = cursor.parentId ? this.category(cursor.parentId) : undefined;
      }
      if (hierarchyChanged && ancestors > 1) throw new Error('书架目录只支持一级和二级目录；二级目录必须挂在一级目录下。');
      if (hierarchyChanged && categories.some(category => category.parentId === categoryId)) throw new Error('这个目录已有子目录，不能将它移到二级目录，以免形成三级目录。');
    }
    const name = required(input.name, '分类名称', 120);
    if (categories.some(category => category.id !== categoryId && (category.parentId ?? null) === parentId && normal(category.name) === normal(name))) throw new Error('同一父目录下已存在同名目录，请使用不同名称。');
    const scopeConfirmed = input.scopeConfirmed ?? prior?.scopeConfirmed ?? false;
    const scopeText = (value: unknown, label: string, max: number, mandatory = false): string => {
      if (mandatory) return required(value, label, max);
      if (value === undefined) return '';
      if (typeof value !== 'string' || value.length > max) throw new Error(`${label}必须是最多 ${max} 字符的文字。`);
      return value.trim();
    };
    const category: Category = {
      id: categoryId, parentId, name,
      description: scopeText(input.description ?? prior?.description, '分类介绍', 2000, scopeConfirmed),
      includes: scopeText(input.includes ?? prior?.includes, '纳入范围', 4000, scopeConfirmed),
      excludes: scopeText(input.excludes ?? prior?.excludes, '分类边界', 4000),
      scopeConfirmed,
      metadataVersion: (prior?.metadataVersion ?? 0) + 1,
    };
    this.transaction(() => {
      this.put('category', categoryId, category);
      this.db.prepare("UPDATE counters SET value=value+1 WHERE id='categories'").run();
    });
    return category;
  }
  libraryDocuments(): DocumentMeta[] {
    this.assertAllowed('library.read');
    return this.activeDocuments().map(document => document.meta).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  }
  documents(categoryId: string): DocumentMeta[] {
    this.category(categoryId);
    return this.activeDocuments().filter(d => d.meta.categoryId === categoryId).map(d => d.meta).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  }
  private activeDocuments(): StoredDocument[] {
    const archived = new Set(this.all<DocumentArchive>('document_archive').map(item => item.documentId));
    return this.all<StoredDocument>('document').filter(item => !archived.has(item.meta.id));
  }
  private replacementId(docId: string): string | undefined {
    let cursor = docId;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(cursor)) throw new Error('合并记录形成循环，请从备份恢复。');
      seen.add(cursor);
      const archive = this.get<DocumentArchive>('document_archive', cursor);
      if (!archive) return cursor === docId ? undefined : cursor;
      cursor = archive.replacementId;
    }
  }
  private assertDocumentActive(docId: string): void {
    if (this.replacementId(docId)) throw new Error('这篇原稿已归档，请打开整合后的文档进行阅读和编辑。');
  }
  document(docId: string): KnowledgeDocument {
    const hasPending = (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[])
      .some(row => (JSON.parse(row.value) as Journal).next.id === docId);
    if (hasPending) {
      if (this.conflicts().some(active)) throw new Error('该文档有中断的发布等待恢复；知识冲突解决前不会继续发布或覆盖正文。');
      this.recoverPublications();
    }
    const stored = this.get<StoredDocument>('document', docId);
    if (!stored) throw new Error('文档不存在。');
    const file = this.libraryPath(docId);
    if (!existsSync(file)) {
      const snapshot = this.version(docId, stored.meta.version);
      if (snapshot.id !== docId || snapshot.version !== stored.meta.version || hash(snapshot.body) !== stored.hash) throw new Error('Markdown 正文缺失，且已发布历史快照不匹配。请从可信备份恢复文件，当前数据未被覆盖。');
      // Repair storage only: this restores the exact published bytes and never
      // increments the version, publishes a draft, or changes conflict state.
      this.atomic(file, snapshot.body); this.recovered = true;
    }
    const archivedIntoId = this.replacementId(docId);
    const body = readFileSync(file, 'utf8');
    if (hash(body) !== stored.hash) {
      if (archivedIntoId) throw new Error('归档原稿被外部修改，已保留修改文件；请在整合文档中处理，历史原稿未被覆盖。');
      if (this.conflicts().some(active)) throw new Error('检测到外部 Markdown 修改。知识冲突未解决前不会导入或覆盖该修改；请完成当前裁决后重新读取。已发布历史内容仍然保留。');
      const prior = this.version(docId, stored.meta.version);
      const next: KnowledgeDocument = { ...stored.meta, body, version: stored.meta.version + 1, updatedAt: now() };
      this.persistDocument(next, prior, '外部 Markdown 修改');
      return next;
    }
    return { ...stored.meta, body, ...(archivedIntoId ? { archivedIntoId } : {}) };
  }
  private version(docId: string, version: number): Version {
    const row = this.db.prepare('SELECT value FROM versions WHERE doc_id=? AND version=?').get(docId, version) as { value: string } | undefined;
    if (!row) throw new Error('历史版本不存在。');
    return JSON.parse(row.value) as Version;
  }
  versions(docId: string): Version[] {
    if (!this.get<StoredDocument>('document', docId)) throw new Error('文档不存在。');
    return (this.db.prepare('SELECT value FROM versions WHERE doc_id=? ORDER BY version DESC').all(docId) as { value: string }[]).map(row => JSON.parse(row.value) as Version);
  }

  private validateDocument(input: DocumentInput, prior?: KnowledgeDocument): KnowledgeDocument {
    this.category(input.categoryId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('必须提供有效的预期版本。');
    if ((prior?.version ?? 0) !== input.expectedVersion) throw new Error(`文档版本已变化：当前 v${prior?.version ?? 0}，提交基于 v${input.expectedVersion}。请重新阅读并合并修改。`);
    const body = required(input.body, '文档正文', 5_000_000);
    if (/^(?:#+\s*)?(?:待补充|TODO|TBD)[.!。\s]*$/i.test(body)) throw new Error('只有占位内容的文档不能发布。');
    const sources = input.sources ?? prior?.sources ?? [];
    this.validateSources(sources);
    return {
      id: prior?.id ?? input.id ?? id(), categoryId: input.categoryId,
      title: required(input.title, '标题', 500), description: required(input.description, '简介', 1600),
      aliases: cleanList(input.aliases ?? prior?.aliases), paperIds: cleanList(input.paperIds ?? prior?.paperIds),
      sources, body, version: (prior?.version ?? 0) + 1, createdAt: prior?.createdAt ?? now(), updatedAt: now(),
    };
  }
  private validateSources(sources: SourceRef[]): void {
    if (!Array.isArray(sources)) throw new Error('来源必须为数组。');
    for (const source of sources) {
      required(source.id, '来源 ID', 200); required(source.title, '来源标题', 1000);
      required(source.kind, '来源类型', 200); required(source.coverage, '实际获取范围', 8000);
      required(source.accessedAt, '获取时间', 200);
      if (source.url && !/^https?:\/\//i.test(source.url)) throw new Error('来源链接必须是 HTTP 或 HTTPS 地址。');
    }
  }
  private assertIdentity(doc: KnowledgeDocument, taskId?: string, draftId?: string, mergeFromIds: string[] = []): void {
    const names = new Set([doc.title, ...doc.aliases].map(normal));
    const candidates: DocumentMeta[] = this.activeDocuments().map(d => d.meta);
    if (taskId) candidates.push(...this.drafts(taskId).filter(d => d.draftId !== draftId && d.status !== 'published'));
    for (const other of candidates) {
      if (other.id === doc.id || mergeFromIds.includes(other.id)) continue;
      if ((other.categoryId === doc.categoryId || ('taskId' in other && other.taskId === taskId)) && [other.title, ...other.aliases].some(n => names.has(normal(n)))) {
        throw new Error('同一标题或别名已经对应另一篇文档，请读取现有候选并判断应更新的主题。');
      }
    }
  }
  saveManual(input: DocumentInput): KnowledgeDocument {
    this.assertAllowed('manual.save');
    if (input.id) this.assertDocumentActive(input.id);
    const prior = input.id ? this.document(input.id) : undefined;
    const doc = this.validateDocument(input, prior); safeId(doc.id); this.assertIdentity(doc);
    this.persistDocument(doc, prior, '手动编辑'); return doc;
  }
  moveDocument(docId: string, categoryId: string, expectedVersion: number): KnowledgeDocument {
    this.assertDirectoryMutable('document.move');
    this.assertDocumentActive(docId);
    safeId(docId); this.category(categoryId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('移动文档必须提供有效的预期版本。');
    const prior = this.document(docId);
    if (prior.version !== expectedVersion) throw new Error(`文档版本已变化：当前 v${prior.version}，移动基于 v${expectedVersion}。请刷新后再移动。`);
    if (prior.categoryId === categoryId) return prior;
    // A directory move is a metadata revision, not a content rewrite or draft
    // publication. Pending drafts retain their identity and historical base;
    // their stale baseVersion cannot overwrite this new published revision.
    const next: KnowledgeDocument = { ...prior, categoryId, version: prior.version + 1, updatedAt: now() };
    this.assertIdentity(next);
    this.persistDocument(next, prior, '移动书架目录');
    return next;
  }
  rollback(docId: string, version: number, expectedVersion: number): KnowledgeDocument {
    this.assertAllowed('manual.save');
    this.assertDocumentActive(docId);
    const stored = this.get<StoredDocument>('document', docId);
    if (!stored) throw new Error('文档不存在。');
    // Missing body files can be recovered from the immutable snapshots as well.
    const current = existsSync(this.libraryPath(docId)) ? this.document(docId) : this.version(docId, stored.meta.version);
    if (current.version !== expectedVersion) throw new Error('当前版本已变化，请重新读取再回滚。');
    const { reason: _oldReason, ...old } = this.version(docId, version);
    const doc = { ...old, version: current.version + 1, createdAt: current.createdAt, updatedAt: now() };
    this.assertIdentity(doc); this.persistDocument(doc, current, `回滚至 v${version}`); return doc;
  }

  tasks(): Task[] {
    const inputs = this.all<TaskInput>('task_input');
    return this.all<Task>('task').map(task => {
      const own = inputs.filter(input => input.taskId === task.id);
      return { ...task, inputSummary: { total: own.length, published: own.filter(input => input.status === 'published').length, blocked: own.filter(input => input.status === 'blocked').length, pending: own.filter(input => input.status === 'pending').length } };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  task(taskId: string): Task {
    const task = this.get<Task>('task', taskId);
    if (!task) throw new Error('任务不存在。'); return task;
  }
  createTask(title: string, selectedDocIds: string[], retrievalMode: NonNullable<Task['retrievalMode']> = 'collection', kind: NonNullable<Task['kind']> = 'research'): Task {
    this.assertAllowed('task.create');
    const selected = cleanList(selectedDocIds);
    for (const docId of selected) this.document(docId);
    if (!['collection', 'maintenance'].includes(retrievalMode)) throw new Error('无效的检索模式。');
    if (!['research', 'ingestion'].includes(kind) || (kind === 'ingestion' && retrievalMode !== 'collection')) throw new Error('无效的任务类型。');
    const task: Task = { id: id(), title: required(title, '研究问题', 500), kind, status: 'queued', stage: '等待处理', selectedDocIds: selected, sourceIds: [], retrievalMode, createdAt: now(), updatedAt: now() };
    this.put('task', task.id, task); return task;
  }
  updateTask(taskId: string, patch: Partial<Task>): Task {
    const task = this.task(taskId);
    const next = { ...task, ...patch, id: task.id, createdAt: task.createdAt, updatedAt: now() };
    this.put('task', taskId, next); return next;
  }

  /** A retry is a new model context over selected saved inputs, not a replay of
   * the batch transcript. Published items keep their results and source links. */
  prepareInputRetry(taskId: string, inputIds?: string[]): TaskInput[] {
    this.assertAllowed('task.new_round', taskId);
    const task = this.task(taskId);
    if (task.kind !== 'ingestion') throw new Error('重试材料只适用于资料入库批次。');
    if (this.activeTurns.size || this.tasks().some(item => item.status === 'running' || item.status === 'queued')) throw new Error('请先暂停或等待当前任务结束。');
    if (existsSync(path.join(this.dataDir, 'raw', `pending-${safeId(taskId)}.json`))) throw new Error('本批材料获取尚未完成，请先点击继续完成获取，再重试失败项。');
    const allInputs = this.taskInputs(taskId);
    const requested = inputIds ? cleanList(inputIds) : allInputs.filter(input => input.status === 'blocked' || input.status === 'pending').map(input => input.id);
    if (!requested.length) throw new Error('本批没有需要重试的材料。');
    const selected = requested.map(inputId => {
      const input = allInputs.find(item => item.id === inputId);
      if (!input || !['blocked', 'pending'].includes(input.status)) throw new Error('只能重试当前批次尚未完成或受阻的材料。');
      return input;
    });
    const selectedSources = new Set(selected.flatMap(input => input.sourceIds));
    if (this.drafts(taskId).some(draft => draft.status !== 'published' && !draft.sources.some(source => selectedSources.has(source.id)))) throw new Error('本批还有其他未完成草稿，请先点击继续处理；若草稿属于其他失败项，也可重试全部未完成材料。');
    const retrySourceIds = selected.flatMap(input => {
      const raw = this.raw(input.sourceIds.at(-1) || input.id);
      // Readable partial video/image sources already carry paid recognition.
      // Their publication retry must not reacquire those same inputs by default.
      return raw.status === 'unavailable' || !raw.text.trim() ? [raw.id] : [];
    });
    this.transaction(() => {
      this.beginResearchRound(taskId);
      for (const input of selected) this.put('task_input', input.id, { ...input, status: 'pending', reason: undefined, updatedAt: now() });
      this.updateTask(taskId, { sessionFile: undefined, previousSessionFiles: cleanList([...(task.previousSessionFiles || []), ...(task.sessionFile ? [task.sessionFile] : [])]), retrySourceIds, retryInputIds: requested, status: 'paused', error: undefined, stage: '准备重试所选材料' });
    });
    return this.taskInputs(taskId).filter(input => requested.includes(input.id));
  }

  /** Clear conversation state only. Raw sources, documents, versions, conflict
   * evidence and source cache remain intact; the backup can recover all rows. */
  clearHistory(taskIds?: string[]): HistoryClearResult {
    const tasks = this.tasks();
    if (this.activeTurns.size || tasks.some(task => task.status === 'running' || task.status === 'queued')) throw new Error('请先暂停或等待任务结束后清理对话记录。');
    const requested = taskIds ? cleanList(taskIds) : tasks.map(task => task.id);
    for (const taskId of requested) this.task(taskId);
    const conflictOwners = this.conflictOwners();
    const preservedTaskIds = requested.filter(taskId => conflictOwners.has(taskId));
    const selected = tasks.filter(task => requested.includes(task.id) && !conflictOwners.has(task.id));
    const selectedIds = new Set(selected.map(task => task.id));
    const result: HistoryClearResult = { deletedTasks: 0, deletedMessages: 0, deletedRecords: 0, preservedTaskIds, ...(preservedTaskIds.length ? { reason: '未裁决冲突所属的对话及证据已保留，避免丢失处理入口。' } : {}) };
    if (!selected.length) return result;
    const journals = (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[]).map(row => JSON.parse(row.value) as Journal);
    if (journals.some(journal => journal.taskId && selectedIds.has(journal.taskId))) throw new Error('所选对话仍有未完成的文档发布，请先恢复发布后清理。');
    const draftIds = new Set(this.drafts().filter(draft => selectedIds.has(draft.taskId)).map(draft => draft.draftId));
    const taskScoped = new Set(['message', 'event', 'turn', 'scan', 'scan_batch', 'task_input', 'api_usage', 'draft', 'draft_submission', 'maintenance_run', 'abandoned_publication']);
    const keyedByTask = new Set(['task', 'categories_read', 'round_boundary']);
    const rows = (this.db.prepare('SELECT kind,id,value FROM records').all() as { kind: string; id: string; value: string }[]).filter(row => {
      if (keyedByTask.has(row.kind)) return selectedIds.has(row.id);
      if (row.kind === 'draft_review_epoch') return draftIds.has(row.id);
      if (!taskScoped.has(row.kind)) return false;
      const value = JSON.parse(row.value) as { taskId?: string };
      return !!value.taskId && selectedIds.has(value.taskId);
    });
    const base = realpathSync(this.dataDir);
    const files = new Set<string>();
    const retainedFiles: string[] = [];
    const includeFile = (file: string) => {
      if (!existsSync(file)) return;
      const target = path.resolve(file), rel = path.relative(base, target);
      // Never follow a session path or junction into the user's other files.
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || path.resolve(realpathSync(target)).toLowerCase() !== target.toLowerCase()) {
        retainedFiles.push(file); return;
      }
      files.add(target);
    };
    for (const task of selected) {
      for (const file of [...(task.previousSessionFiles || []), ...(task.sessionFile ? [task.sessionFile] : [])]) {
        const sessionRelative = path.relative(path.join(base, 'sessions'), path.resolve(file));
        if (!sessionRelative || sessionRelative === '..' || sessionRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sessionRelative) || !file.endsWith('.jsonl')) {
          if (existsSync(file)) retainedFiles.push(file);
        } else includeFile(file);
      }
      includeFile(path.join(base, 'raw', `pending-${safeId(task.id)}.json`));
    }
    for (const draftId of draftIds) {
      includeFile(path.join(base, 'drafts', `${safeId(draftId)}.json`));
      includeFile(path.join(base, 'drafts', `${safeId(draftId)}.md`));
    }
    // An all-history clear also removes old Pi sessions no longer referenced by
    // a task after an earlier context reset. Runtime credentials are excluded.
    if (selected.length === tasks.length) {
      const sessions = path.join(base, 'sessions');
      if (!lstatSync(sessions).isSymbolicLink() && path.resolve(realpathSync(sessions)).toLowerCase() === sessions.toLowerCase()) {
        for (const entry of readdirSync(sessions, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.jsonl')) includeFile(path.join(sessions, entry.name));
      }
    }
    const backupRoot = path.join(base, 'backups');
    mkdirSync(backupRoot, { recursive: true });
    if (lstatSync(backupRoot).isSymbolicLink() || path.resolve(realpathSync(backupRoot)).toLowerCase() !== backupRoot.toLowerCase()) throw new Error('备份目录必须位于当前知识库内。');
    const backupPath = path.join(backupRoot, `conversation-clear-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    mkdirSync(backupPath);
    // VACUUM INTO includes committed WAL data and yields a consistent standalone
    // SQLite snapshot. No conversation rows are removed until all copies exist.
    this.db.prepare('VACUUM INTO ?').run(path.join(backupPath, 'app.sqlite'));
    const copied: { relativePath: string; sha256: string }[] = [];
    for (const file of files) {
      const relativePath = path.relative(base, file), destination = path.join(backupPath, 'files', relativePath);
      mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(file, destination);
      const checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== checksum) throw new Error('对话备份校验失败，原记录未删除。');
      copied.push({ relativePath, sha256: checksum });
    }
    const manifest = { schema: 1, createdAt: now(), selectedTaskIds: [...selectedIds], preservedTaskIds, files: copied, records: rows.map(row => ({ kind: row.kind, id: row.id })), retainedFiles, status: 'backed_up', note: '关闭应用后，可用 app.sqlite 及 files 下的对应文件恢复清理前状态。library、history、raw 来源和 source-cache 未被清理。' };
    this.atomic(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM records WHERE kind=? AND id=?');
      for (const row of rows) remove.run(row.kind, row.id);
    });
    for (const file of files) {
      try {
        // Recheck immediately before unlink; only individual regular files are
        // removed, never a computed directory or recursively traversed path.
        if (lstatSync(file).isSymbolicLink() || realpathSync(file).toLowerCase() !== file.toLowerCase()) retainedFiles.push(file);
        else unlinkSync(file);
      } catch { retainedFiles.push(file); }
    }
    this.recovered = this.conflicts().some(active) || this.drafts().some(draft => draft.status !== 'published') || this.tasks().some(task => task.status === 'paused');
    result.backupPath = backupPath; result.deletedTasks = selected.length; result.deletedMessages = rows.filter(row => row.kind === 'message').length; result.deletedRecords = rows.length;
    if (retainedFiles.length) result.retainedFiles = [...new Set(retainedFiles)];
    this.atomic(path.join(backupPath, 'manifest.json'), JSON.stringify({ ...manifest, status: 'cleared', completedAt: now(), retainedFiles: result.retainedFiles || [] }, null, 2));
    return result;
  }

  private maintenanceView(run: StoredMaintenanceRun): MaintenanceRun {
    const task = this.task(run.taskId);
    const input = this.currentMaintenanceItem(run);
    const done = run.items.filter(item => item.status === 'done');
    const merged = new Set(done.filter(item => item.outcome === 'merged').flatMap(item => item.mergedDocIds ?? []));
    return { ...run, items: run.items.map(({ comparedVersions: _versions, ...item }) => item),
      currentDocumentId: input?.documentId, currentDocumentTitle: input?.title,
      status: task.status, stage: task.stage, error: task.error, total: run.items.length,
      checked: done.length, mergedCount: merged.size, noChangeCount: done.filter(item => item.outcome === 'no_change').length,
      diffCount: this.conflicts().filter(conflict => conflict.taskId === run.taskId && conflict.status !== 'dismissed').length,
      updatedAt: task.updatedAt > run.updatedAt ? task.updatedAt : run.updatedAt,
      progressMessage: this.events(run.taskId).at(-1)?.message };
  }
  private currentMaintenanceItem(run: StoredMaintenanceRun): StoredMaintenanceItem | undefined {
    // Once an input is being handled, keep it pinned through comparisons and
    // interrupted drafts. Changes to an earlier completed item wait their turn.
    const pinned = run.policyVersion && run.policyVersion >= 4 ? run.items.find(item => item.status === 'pending' && item.documentId === run.currentDocumentId) : undefined;
    return pinned ?? run.items.find(item => item.status === 'pending');
  }
  maintenanceInput(taskId: string): DocumentMeta | undefined {
    const stored = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
    if (!stored || stored.completedAt) return undefined;
    const input = this.currentMaintenanceItem(this.refreshMaintenanceChecks(stored));
    return input ? this.get<StoredDocument>('document', input.documentId)?.meta : undefined;
  }
  /** Inspect bytes without importing external edits or bypassing the conflict
   * lock. A change to a certified document is always a pending check again. */
  private maintenanceVersionMatches(documentId: string, version: number): boolean {
    const stored = this.get<StoredDocument>('document', documentId);
    if (!stored || stored.meta.version !== version) return false;
    const file = this.libraryPath(documentId);
    return !existsSync(file) || hash(readFileSync(file, 'utf8')) === stored.hash;
  }
  private refreshMaintenanceChecks(run: StoredMaintenanceRun): StoredMaintenanceRun {
    if (run.completedAt) return run;
    const stale = run.items.filter(item => item.status === 'done' && item.outcome !== 'merged' && (
      !item.checkedVersion || !this.maintenanceVersionMatches(item.documentId, item.checkedVersion)
      || Object.entries(item.comparedVersions ?? {}).some(([documentId, version]) => Boolean(this.replacementId(documentId)) || !this.maintenanceVersionMatches(documentId, version))));
    const metadata = new Map(run.items.map(item => [item.documentId, this.get<StoredDocument>('document', item.documentId)?.meta]));
    const metadataChanged = run.items.some(item => {
      const current = metadata.get(item.documentId);
      return current && (current.title !== item.title || current.categoryId !== item.categoryId);
    });
    if (!stale.length && !metadataChanged) return run;
    const ids = new Set(stale.map(item => item.documentId));
    const next: StoredMaintenanceRun = { ...run, updatedAt: now(), currentDocumentTitle: (run.currentDocumentId && metadata.get(run.currentDocumentId)?.title) || run.currentDocumentTitle, items: run.items.map(item => {
      const current = metadata.get(item.documentId);
      const updated = current ? { ...item, title: current.title, categoryId: current.categoryId } : item;
      if (!ids.has(item.documentId)) return updated;
      const { checkedVersion: _checked, comparedVersions: _versions, outcome: _outcome, mergedDocIds: _merged, concept: _concept, summary: _summary, completedAt: _at, ...pending } = updated;
      return { ...pending, status: 'pending' };
    }) };
    this.transaction(() => {
      this.put('maintenance_run', run.taskId, next);
      for (const item of stale) {
        if (this.get<MaintenanceLedger>('maintenance_ledger', item.documentId)?.runId === run.id) this.db.prepare("DELETE FROM records WHERE kind='maintenance_ledger' AND id=?").run(item.documentId);
      }
      this.event(run.taskId, '维护进度', stale.length ? `${stale.length} 篇文档或比较依据在检查后发生变化，已恢复为待检查。` : '待维护文档的标题或归属目录已按当前书架刷新。', { documentIds: [...ids] });
    });
    return next;
  }
  maintenanceRun(taskId: string): MaintenanceRun | undefined {
    const run = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
    return run ? this.maintenanceView(this.refreshMaintenanceChecks(run)) : undefined;
  }
  maintenanceState(): MaintenanceState {
    const runs = this.all<StoredMaintenanceRun>('maintenance_run');
    const activeRun = runs.find(run => !run.completedAt);
    const run = activeRun ? this.refreshMaintenanceChecks(activeRun) : runs.at(-1);
    const documents = this.libraryDocuments();
    const checked = new Set(this.all<MaintenanceLedger>('maintenance_ledger').map(entry => entry.documentId));
    return { dataDir: this.dataDir, totalDocuments: documents.length, pendingCount: documents.filter(document => !checked.has(document.id)).length,
      lastCompletedAt: this.get<{ lastCompletedAt: string }>('maintenance_meta', 'state')?.lastCompletedAt,
      run: run ? this.maintenanceView(run) : undefined };
  }
  startMaintenance(): MaintenanceRun {
    this.assertAllowed('maintenance.start');
    const previous = this.all<StoredMaintenanceRun>('maintenance_run').find(run => !run.completedAt);
    if (previous) return this.maintenanceView(this.refreshMaintenanceChecks(previous));
    const checked = new Set(this.all<MaintenanceLedger>('maintenance_ledger').map(entry => entry.documentId));
    const documents = this.libraryDocuments().filter(document => !checked.has(document.id));
    if (!documents.length) throw new Error('没有新入库文档需要维护。');
    const task = this.createTask('维护书架：同概念合并与差异检查', documents.map(document => document.id), 'maintenance');
    const stamp = now();
    const run: StoredMaintenanceRun = { id: id(), taskId: task.id, policyVersion: 4, startedAt: stamp, updatedAt: stamp,
      currentDocumentId: documents[0].id, currentDocumentTitle: documents[0].title,
      items: documents.map(document => ({ documentId: document.id, title: document.title, categoryId: document.categoryId, initialVersion: document.version, status: 'pending' })) };
    this.put('maintenance_run', task.id, run);
    this.event(task.id, '维护进度', `本次固定检查 ${documents.length} 篇新入库文档；运行中新入库的文档留到下次维护。`);
    return this.maintenanceView(run);
  }
  pendingMaintenance(taskId: string): MaintenanceItem[] {
    const run = this.maintenanceRun(taskId);
    return run?.items.filter(item => item.status === 'pending') ?? [];
  }
  recordMaintenanceReports(taskId: string, reports: MaintenanceReport[]): MaintenanceRun {
    this.assertAllowed('maintenance.report', taskId);
    const task = this.task(taskId);
    const run = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
    if (task.retrievalMode !== 'maintenance' || !run) throw new Error('当前任务不是书架维护批次。');
    if (run.completedAt) throw new Error('维护批次已经完成，不能修改旧检查结果。');
    if (!Array.isArray(reports) || !reports.length || reports.length > 1000) throw new Error('维护报告每批须为 1 到 1000 项。');
    if (reports.length !== 1) throw new Error('维护逐篇推进，每次只提交当前输入的一条结论，完成后再处理下一篇。');
    if (this.drafts(taskId).some(draft => draft.status !== 'published')) throw new Error('当前维护仍有未发布草稿，请先完成自检和发布。');
    const seen = new Set<string>();
    const checked = reports.map(report => {
      if (!report || typeof report !== 'object') throw new Error('维护报告格式无效。');
      const documentId = safeId(required(report.documentId, '维护文档 ID', 101));
      if (seen.has(documentId)) throw new Error('同一批维护报告不能重复指定文档。');
      seen.add(documentId);
      const item = run.items.find(entry => entry.documentId === documentId);
      if (!item) throw new Error('维护报告只能处理本次固定批次中的文档。');
      if (!Number.isSafeInteger(report.version) || report.version < 1) throw new Error('维护报告必须提供已读正文的有效版本。');
      if (report.outcome !== 'merged' && report.outcome !== 'no_change') throw new Error('维护结果只能是 merged 或 no_change；疑似问题先核实并等待人工裁决。');
      if (report.outcome === 'no_change' && documentId !== this.currentMaintenanceItem(run)?.documentId) throw new Error('请先完成当前输入，不能跳过它登记其它待办文档。');
      if (!Array.isArray(report.comparedDocIds) || report.comparedDocIds.length > 1000 || report.comparedDocIds.some(value => typeof value !== 'string')) throw new Error('比较依据必须为文档 ID 数组，最多 1000 项，允许为空。');
      const comparedDocIds = cleanList(report.comparedDocIds).map(safeId).sort();
      if (comparedDocIds.includes(documentId)) throw new Error('比较依据不应重复列出当前维护文档。');
      if (report.mergedDocIds !== undefined && (!Array.isArray(report.mergedDocIds) || report.mergedDocIds.length > 1000 || report.mergedDocIds.some(value => typeof value !== 'string'))) throw new Error('合并目标必须为文档 ID 数组，最多 1000 项。');
      const mergedDocIds = cleanList(report.mergedDocIds ?? []).map(safeId).sort();
      if (report.outcome === 'no_change' && mergedDocIds.length) throw new Error('无需处理的报告不能宣称已合并文档。');
      const concept = report.concept === undefined ? undefined : required(report.concept, '同一概念', 500);
      if (report.outcome === 'merged' && (!concept || !mergedDocIds.length)) throw new Error('合并报告须说明同一概念并列出实际发布的目标文档。');
      const document = this.document(documentId);
      const compared = comparedDocIds.map(candidateId => this.document(candidateId));
      if (document.version !== report.version) throw new Error('维护文档在检查后已变化，请重新读取并检查。');
      if (report.outcome === 'merged') {
        // Completion is certified by the atomic merge publication, never by a
        // model saying it updated an ordinary document. Reports only refine it.
        const archive = this.get<DocumentArchive>('document_archive', documentId);
        if (!archive || archive.taskId !== taskId || item.outcome !== 'merged' || mergedDocIds.length !== 1 || mergedDocIds[0] !== this.replacementId(documentId)) throw new Error('合并报告必须对应本批实际发布的新整合文档和已归档原稿。');
        if (compared.some(candidate => !this.drafts(taskId).some(draft => draft.status === 'published' && draft.mergeFrom?.some(part => part.id === candidate.id)))) throw new Error('合并比较依据须是本批真实二合一的已读参与文档。');
      } else {
        this.assertDocumentActive(documentId);
        this.assertMaintenanceRead(taskId, document);
        for (const candidate of compared) { this.assertDocumentActive(candidate.id); this.assertMaintenanceRead(taskId, candidate); }
      }
      const completedAt = now();
      return { ...item, categoryId: document.categoryId, title: document.title, status: 'done' as const, checkedVersion: document.version,
        outcome: report.outcome, mergedDocIds, concept,
        comparedVersions: Object.fromEntries(compared.map(candidate => [candidate.id, candidate.version])), summary: required(report.summary, '维护合并、差异及处理结论', 12_000), completedAt };
    });
    const changed = new Map(checked.map(item => [item.documentId, item]));
    const items = run.items.map(item => changed.get(item.documentId) ?? item);
    const current = items.find(item => item.status === 'pending' && item.documentId === run.currentDocumentId) ?? items.find(item => item.status === 'pending');
    const next: StoredMaintenanceRun = { ...run, policyVersion: 4, updatedAt: now(), items, currentDocumentId: current?.documentId, currentDocumentTitle: current?.title };
    this.transaction(() => {
      this.put('maintenance_run', taskId, next);
      for (const item of checked) this.put('maintenance_ledger', item.documentId, { documentId: item.documentId, checkedVersion: item.checkedVersion!, runId: run.id, completedAt: item.completedAt! } satisfies MaintenanceLedger);
      this.event(taskId, '维护进度', `已检查 ${next.items.filter(item => item.status === 'done').length} / ${next.items.length} 篇新入库文档。`, { documentIds: checked.map(item => item.documentId) });
    });
    return this.maintenanceView(next);
  }
  finishMaintenance(taskId: string): MaintenanceRun {
    this.assertAllowed('maintenance.finish', taskId);
    const stored = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
    if (!stored || this.task(taskId).retrievalMode !== 'maintenance') throw new Error('当前任务不是书架维护批次。');
    if (stored.completedAt) return this.maintenanceView(stored);
    if (this.drafts(taskId).some(draft => draft.status !== 'published')) throw new Error('书架维护还有未发布草稿，不能标记完成。');
    const run = this.refreshMaintenanceChecks(stored);
    if (run.items.some(item => item.status !== 'done')) throw new Error('本次新增文档尚未全部检查，维护进度已保留。');
    const stamp = now();
    const next: StoredMaintenanceRun = { ...run, completedAt: stamp, updatedAt: stamp };
    this.transaction(() => {
      this.put('maintenance_run', taskId, next);
      this.put('maintenance_meta', 'state', { lastCompletedAt: stamp });
      this.updateTask(taskId, { status: 'completed', stage: 'maintenance_completed', error: undefined });
      this.event(taskId, '维护完成', `本次 ${next.items.length} 篇新入库文档全部检查完成。`);
    });
    return this.maintenanceView(next);
  }
  /** Explicit cleanup requested by the owner, not an automatic library migration. */
  resetMaintenanceHistory(): HistoryClearResult {
    this.assertAllowed('maintenance.reset');
    if (this.activeTurns.size || this.tasks().some(task => task.status === 'running' || task.status === 'queued')) throw new Error('请先暂停正在运行的任务，再清理维护记录。');
    const taskIds = this.tasks().filter(task => task.retrievalMode === 'maintenance').map(task => task.id);
    const result: HistoryClearResult = taskIds.length ? this.clearHistory(taskIds) : { deletedTasks: 0, deletedMessages: 0, deletedRecords: 0, preservedTaskIds: [] };
    if (result.preservedTaskIds.length) throw new Error('仍有未裁决的维护分歧，记录已保留。');
    if (!result.backupPath) {
      const backupRoot = path.join(this.dataDir, 'backups'); mkdirSync(backupRoot, { recursive: true });
      const backupPath = path.join(backupRoot, `before-maintenance-reset-${Date.now()}-${id()}.sqlite`);
      this.db.prepare('VACUUM INTO ?').run(backupPath); result.backupPath = backupPath;
    }
    this.transaction(() => {
      const removed = this.db.prepare("DELETE FROM records WHERE kind IN ('maintenance_run','maintenance_ledger','maintenance_meta')").run();
      result.deletedRecords += Number(removed.changes);
      for (const conflict of this.conflicts().filter(conflict => taskIds.includes(conflict.taskId))) {
        this.db.prepare("DELETE FROM records WHERE kind='conflict' AND id=?").run(conflict.id); result.deletedRecords++;
      }
      this.db.prepare("DELETE FROM records WHERE kind='migration' AND id='maintenance_merge_diff_v1'").run();
    });
    return result;
  }
  addMessage(taskId: string, role: Message['role'], content: string): Message {
    this.task(taskId);
    if (!['user', 'assistant', 'system'].includes(role)) throw new Error('无效的消息角色。');
    const message: Message = { id: id(), taskId, turnId: this.activeTurns.get(taskId)?.id, role, content, createdAt: now() };
    this.touchTurn(taskId);
    this.put('message', message.id, message); return message;
  }
  messages(taskId: string): Message[] { this.task(taskId); return this.all<Message>('message').filter(m => m.taskId === taskId); }
  event(taskId: string, stage: string, message: string, detail?: unknown): TaskEvent {
    this.task(taskId); const event: TaskEvent = { id: id(), taskId, turnId: this.activeTurns.get(taskId)?.id, stage, message, createdAt: now(), ...(detail === undefined ? {} : { detail }) };
    this.touchTurn(taskId);
    this.put('event', event.id, event); return event;
  }
  events(taskId: string): TaskEvent[] { this.task(taskId); return this.all<TaskEvent>('event').filter(e => e.taskId === taskId); }

  beginTurn(taskId: string, seed?: ResearchTurn): ResearchTurn {
    if (this.activeTurns.has(taskId)) throw new Error('当前提问仍在运行。');
    const user = this.messages(taskId).filter(message => message.role === 'user').at(-1);
    const turnId = seed?.id || user?.id || id();
    const previous = this.get<ResearchTurn>('turn', turnId) || seed;
    const stamp = now();
    const turn: ResearchTurn = {
      ...previous, id: turnId, taskId, userMessageId: user?.id,
      startedAt: previous?.startedAt || stamp, finishedAt: undefined,
      elapsedMs: previous?.elapsedMs || 0, runningSince: stamp, lastActivityAt: stamp,
      status: 'running', usage: undefined,
      inputs: previous?.inputs || [], publications: previous?.publications || [],
    };
    this.put('turn', turn.id, turn);
    if (user) this.put('message', user.id, { ...user, turnId });
    this.activeTurns.set(taskId, { id: turnId,
      inputs: new Map(this.taskInputs(taskId).map(input => [input.id, JSON.stringify(input)])),
      publications: new Set(this.drafts(taskId).filter(draft => draft.status === 'published').map(draft => `${draft.id}:${draft.publishedVersion || draft.version}`)),
    });
    return turn;
  }
  private touchTurn(taskId: string): void {
    const active = this.activeTurns.get(taskId); if (!active) return;
    const turn = this.get<ResearchTurn>('turn', active.id);
    if (turn) this.put('turn', turn.id, { ...turn, lastActivityAt: now() });
  }
  private turnSnapshot(turn: ResearchTurn): ResearchTurn {
    const active = this.activeTurns.get(turn.taskId); if (!active || active.id !== turn.id) return turn;
    const inputs = new Map((turn.inputs || []).map(input => [input.id, input]));
    for (const input of this.taskInputs(turn.taskId)) if (active.inputs.get(input.id) !== JSON.stringify(input)) inputs.set(input.id, input);
    const publications = new Map((turn.publications || []).map(item => [`${item.id}:${item.version}`, item]));
    for (const draft of this.drafts(turn.taskId)) {
      const version = draft.publishedVersion || draft.version, key = `${draft.id}:${version}`;
      if (draft.status === 'published' && !active.publications.has(key)) publications.set(key, { id: draft.id, title: draft.title, version, draftId: draft.draftId });
    }
    return { ...turn, status: this.task(turn.taskId).status, inputs: [...inputs.values()], publications: [...publications.values()] };
  }
  finishTurn(taskId: string): void {
    const active = this.activeTurns.get(taskId); if (!active) return;
    const stored = this.get<ResearchTurn>('turn', active.id);
    if (stored) {
      const stamp = now(), turn = this.turnSnapshot(stored);
      this.put('turn', turn.id, { ...turn, elapsedMs: turn.elapsedMs + Math.max(0, Date.parse(stamp) - Date.parse(turn.runningSince || stamp)), runningSince: undefined, finishedAt: stamp, lastActivityAt: stamp });
    }
    this.activeTurns.delete(taskId);
  }
  turns(taskId: string): ResearchTurn[] { return this.all<ResearchTurn>('turn').filter(turn => turn.taskId === taskId).map(turn => this.turnSnapshot(turn)); }
  recordUsage(taskId: string, turnId: string, usage: ApiUsageRecord): void {
    this.put('api_usage', `${taskId}:${usage.id}`, { ...usage, taskId, turnId });
    this.touchTurn(taskId);
  }
  usages(taskId: string): (ApiUsageRecord & { taskId: string; turnId: string })[] {
    return this.all<ApiUsageRecord & { taskId: string; turnId: string }>('api_usage').filter(usage => usage.taskId === taskId);
  }
  putRaw(raw: RawMaterial): RawMaterial {
    this.assertAllowed('source.read', raw.taskId); this.task(raw.taskId); safeId(raw.id);
    this.atomic(path.join(this.dataDir, 'raw', `${raw.id}.json`), JSON.stringify(raw, null, 2));
    this.put('raw', raw.id, raw);
    const task = this.task(raw.taskId);
    if (!task.sourceIds.includes(raw.id)) this.updateTask(task.id, { sourceIds: [...task.sourceIds, raw.id] });
    return raw;
  }
  raw(rawId: string): RawMaterial {
    const raw = this.get<RawMaterial>('raw', rawId); if (!raw) throw new Error('原始材料不存在。'); return raw;
  }
  raws(taskId: string): RawMaterial[] { this.task(taskId); return this.all<RawMaterial>('raw').filter(raw => raw.taskId === taskId); }

  /** Populate progress only when a task is explicitly started/resumed, never at application startup. */
  ensureTaskInputs(taskId: string): TaskInput[] {
    this.task(taskId);
    const raws = this.raws(taskId), materials = new Map(raws.map(raw => [raw.id, raw]));
    const entries = new Map(this.taskInputs(taskId).map(input => [input.id, input]));
    const changes = new Map<string, TaskInput>();
    for (const raw of raws) {
      const role = raw.metadata?.inputRole;
      if (role === 'context' || typeof raw.metadata?.retryOf === 'string') continue;
      const direct = role === 'input' || (typeof raw.metadata?.ingestKey === 'string' && !!raw.metadata.ingestKey && !(raw.kind === 'text' && /https?:\/\/[^\s<>"'`\u3000]+/i.test(raw.text)));
      if (!direct || entries.has(raw.id)) continue;
      const existing = this.get<TaskInput>('task_input', raw.id);
      if (existing && existing.taskId !== taskId) throw new Error('输入进度 ID 已属于其他任务，拒绝覆盖。');
      const input: TaskInput = { id: raw.id, taskId, sourceIds: [raw.id], status: 'pending', documentIds: [], updatedAt: now() };
      entries.set(input.id, input); changes.set(input.id, input);
    }
    for (const raw of raws) {
      if (raw.metadata?.inputRole === 'context') continue;
      let cursor: RawMaterial | undefined = raw;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        const input = entries.get(cursor.id);
        if (input) {
          if (!input.sourceIds.includes(raw.id)) {
            const updated = { ...input, sourceIds: [...input.sourceIds, raw.id], updatedAt: now() };
            entries.set(input.id, updated); changes.set(input.id, updated);
          }
          break;
        }
        const previous: unknown = cursor.metadata?.retryOf;
        cursor = typeof previous === 'string' ? materials.get(previous) : undefined;
      }
    }
    if (changes.size) this.transaction(() => { for (const input of changes.values()) this.put('task_input', input.id, input); });
    return this.taskInputs(taskId);
  }

  taskInputs(taskId: string): TaskInput[] {
    this.task(taskId); return this.all<TaskInput>('task_input').filter(input => input.taskId === taskId);
  }

  inputProgress(taskId: string): { total: number; pending: number; blocked: number; resolved: number; items: TaskInput[] } {
    const items = this.taskInputs(taskId), pending = items.filter(input => input.status === 'pending').length, blocked = items.filter(input => input.status === 'blocked').length;
    return { total: items.length, pending, blocked, resolved: items.length - pending - blocked, items };
  }

  /** Structured outcomes are model judgments; publication and source membership are independently verified. */
  recordInputOutcomes(taskId: string, outcomes: InputOutcome[]): TaskInput[] {
    this.assertAllowed('task.input_outcomes', taskId); this.task(taskId);
    const retryInputIds = this.task(taskId).retryInputIds;
    if (!Array.isArray(outcomes) || outcomes.length > 1000) throw new Error('输入处理结果必须为数组，单次最多 1000 项。');
    return this.transaction(() => {
      const seen = new Set<string>();
      const published = new Set(this.drafts(taskId).filter(draft => draft.status === 'published' && draft.publishedVersion).map(draft => draft.id));
      const updates = outcomes.map(outcome => {
        if (!outcome || typeof outcome !== 'object') throw new Error('输入处理结果格式无效。');
        const inputId = safeId(required(outcome.inputId, '输入 ID', 101));
        if (retryInputIds && !retryInputIds.includes(inputId)) throw new Error('本次只允许更新用户选择重试的材料，请保留其他输入的处理结果。');
        if (seen.has(inputId)) throw new Error('同一批结果不能重复指定同一个输入 ID。');
        seen.add(inputId);
        const input = this.get<TaskInput>('task_input', inputId);
        if (!input || input.taskId !== taskId) throw new Error('输入不属于当前任务，或尚未登记为用户直接提交的材料。');
        if (!['published', 'answered', 'skipped', 'blocked'].includes(outcome.status)) throw new Error('输入处理状态必须为 published、answered、skipped 或 blocked。');
        const reason = required(outcome.reason, '输入处理说明', 8000);
        if (outcome.documentIds !== undefined && (!Array.isArray(outcome.documentIds) || outcome.documentIds.length > 1000 || outcome.documentIds.some(value => typeof value !== 'string'))) throw new Error('关联文档 ID 必须为字符串数组，单项最多关联 1000 篇文档。');
        const documentIds = cleanList(outcome.documentIds).map(safeId).sort();
        if (outcome.status === 'published' && !documentIds.length) throw new Error('标记为已入库时必须提供至少一个本任务实际发布的文档 ID。');
        for (const documentId of documentIds) {
          const document = this.get<StoredDocument>('document', documentId);
          if (!document) throw new Error('输入处理结果关联了不存在的文档。');
          if (outcome.status === 'published') {
            if (!published.has(documentId)) throw new Error('已入库结果只能关联当前任务通过草稿正式发布的文档。');
            if (!document.meta.sources.some(source => input.sourceIds.includes(source.id))) throw new Error('关联文档没有引用该输入或其重新获取的来源，不能将该输入标记为已入库。');
          }
        }
        const unchanged = input.status === outcome.status && input.reason === reason && JSON.stringify([...input.documentIds].sort()) === JSON.stringify(documentIds);
        return { changed: !unchanged, input: unchanged ? input : { ...input, status: outcome.status, reason, documentIds, updatedAt: now() } satisfies TaskInput };
      });
      // Validate the entire batch before any progress is persisted.
      for (const update of updates) if (update.changed) this.put('task_input', update.input.id, update.input);
      const changed = updates.filter(update => update.changed);
      if (changed.length) this.event(taskId, '输入进度', `已记录 ${changed.length} 项输入的处理结果。`, { inputIds: changed.map(update => update.input.id) });
      return this.taskInputs(taskId);
    });
  }

  selectCategory(taskId: string, categoryId: string, previousRoundReason?: string): Scan {
    this.assertAllowed('category.select', taskId); const task = this.task(taskId);
    const read = this.get<{ version: number }>('categories_read', taskId);
    if (!read || read.version !== this.categoryVersion()) throw new Error('请先获取当前分类的名称、简介和归属说明。');
    const category = this.category(categoryId);
    if (!category.scopeConfirmed && task.retrievalMode !== 'maintenance') throw new Error('该分类的范围尚未确认，请先由用户编辑并确认含义，不能自动归入。');
    const unfinished = this.drafts(taskId).filter(draft => draft.status !== 'published');
    const refreshingMerge = task.retrievalMode === 'maintenance' && unfinished.length > 0 && unfinished.every(draft => draft.mergeFrom?.length);
    if (refreshingMerge && !unfinished.every(draft => draft.categoryId === categoryId || draft.mergeFrom!.some(part => this.get<StoredDocument>('document', part.id)?.meta.categoryId === categoryId))) throw new Error('请先完成当前合并草稿；现在只能重新扫描其目标目录或原稿目录。');
    if (task.retrievalMode === 'maintenance') {
      const input = this.maintenanceInput(taskId);
      if (!input) throw new Error('当前维护没有待整理输入。');
      if (input.categoryId !== categoryId) {
        const evidence = { ...input, body: '' };
        this.assertMaintenanceRead(taskId, evidence);
        required(previousRoundReason, '当前输入为何需要比较该目录的具体线索', 8000);
      }
    }
    const current = this.currentScan(taskId);
    if (current?.categoryId === categoryId) return this.publicScan(this.refreshScan(current));
    if (current) {
      const roundDrafts = this.all<Draft & { round?: number }>('draft').filter(d => d.taskId === taskId && d.round === current.round);
      if (roundDrafts.some(d => d.status !== 'published') && !refreshingMerge) throw new Error('当前分类仍有未发布草稿，请先完成自检和发布。同一任务可以顺序处理多个分类，但不能交叉处理尚未完成的草稿。');
      if (!roundDrafts.length) {
        if (!this.refreshScan(current).complete) throw new Error('当前分类的候选提供尚未完成；无草稿换分类前须完成当前范围，并说明本轮为何无需生成文档。');
        const reason = required(previousRoundReason, '结束无草稿轮次的说明（例如分类误选、没有可用内容或无需修改）', 8000);
        this.event(taskId, '结束分类轮次', `本轮没有生成草稿，继续处理下一分类：${reason}`, { round: current.round, categoryId: current.categoryId, nextCategoryId: categoryId });
      }
    }
    const nextRound = Math.max(0, ...this.all<StoredScan>('scan').filter(s => s.taskId === taskId).map(s => s.round)) + 1;
    const scope = task.retrievalMode === 'collection' ? 'identity' : 'category';
    const scan: StoredScan = { taskId, categoryId, metadataVersion: category.metadataVersion, total: scope === 'identity' ? 0 : this.documents(categoryId).length, providedIds: [], pages: [], readIds: [], complete: false, scope, round: nextRound, readVersions: {} };
    this.saveScan(scan); this.event(taskId, '确定分类', `本轮归属：${category.name}`); return this.publicScan(scan);
  }
  private refreshScan(scan: StoredScan): StoredScan {
    const category = this.category(scan.categoryId);
    if (scan.metadataVersion === category.metadataVersion) return scan;
    const maintaining = this.task(scan.taskId).retrievalMode === 'maintenance';
    const updated: StoredScan = { ...scan, metadataVersion: category.metadataVersion, total: scan.scope === 'identity' ? 0 : this.documents(scan.categoryId).length, providedIds: [], pages: [],
      readIds: maintaining ? scan.readIds : [], readVersions: maintaining ? scan.readVersions : {}, complete: false };
    this.saveScan(updated); this.event(scan.taskId, '扫描简介', scan.scope === 'identity' ? '分类目录已变化，请重新查询精确标识候选。' : '分类目录已变化，本轮简介扫描已重置，请完整重新读取。'); return updated;
  }
  /** Daily collection uses exact identifiers only. This result never represents
   * a completed semantic or whole-category scan. */
  scanCollectionCategory(taskId: string, categoryId: string, input: CollectionIdentity, previousRoundReason?: string): CategoryBatch {
    this.assertAllowed('category.scan', taskId);
    if (this.task(taskId).retrievalMode !== 'collection') throw new Error('精确标识查询仅适用于资料入库任务。');
    if (!input || typeof input !== 'object') throw new Error('请提供待入库主题的标题、别名或论文标识符。');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 500)) throw new Error('待入库主题标题最多 500 字符。');
    for (const list of [input.aliases, input.paperIds]) if (list !== undefined && (!Array.isArray(list) || list.length > 1000 || list.some(value => typeof value !== 'string' || value.length > 2000))) throw new Error('别名和论文标识符须为文字数组，最多 1000 项。');
    const query: CollectionIdentity = { title: input.title?.trim(), aliases: cleanList(input.aliases), paperIds: cleanList(input.paperIds) };
    if (!query.title && !query.aliases!.length && !query.paperIds!.length) throw new Error('精确候选查询至少需要一个非空标题、别名或论文标识符，不能用空查询跳过核对。');
    this.selectCategory(taskId, categoryId, previousRoundReason);
    const scan = this.refreshScan(this.currentScan(taskId)!);
    const names = new Set([query.title, ...query.aliases!].filter((name): name is string => Boolean(name)).map(normal));
    const papers = new Set(query.paperIds!.map(identity));
    const matches = this.documents(categoryId).filter(document => [document.title, ...document.aliases].some(name => names.has(normal(name))) || document.paperIds.some(paperId => papers.has(identity(paperId))));
    const providedIds = [...new Set([...scan.providedIds, ...matches.map(document => document.id)])];
    const result: CategoryBatch = { scope: 'identity', note: '只提供标题、别名或论文标识符精确匹配的候选；complete 仅表示本次精确候选已提供，不代表整个分类已扫描。',
      scan: { taskId, categoryId, metadataVersion: scan.metadataVersion, total: providedIds.length, provided: providedIds.length, complete: true },
      documents: matches.map(({ id, categoryId, title, description, aliases, paperIds, version }) => ({ id, categoryId, title, description, aliases, paperIds, version })), continuation: null };
    if (JSON.stringify(result).length > SCAN_BATCH_MAX_CHARACTERS) throw new Error('精确标识匹配的候选元数据超过输出预算，未记录查询完成。请使用更具体的标题或别名核对这些候选。');
    this.saveScan({ ...scan, identity: query, scope: 'identity', total: providedIds.length, providedIds, complete: true });
    this.event(taskId, '精确标识候选', `已提供 ${matches.length} 篇精确匹配候选；同概念合并与差异检查由书架维护执行。`, { categoryId, matched: matches.length, scope: 'identity' });
    return result;
  }
  scanPage(taskId: string, categoryId: string, page: number, pageSize = 40): { scan: Scan; documents: DocumentMeta[] } {
    this.assertAllowed('category.scan', taskId);
    if (this.task(taskId).retrievalMode === 'collection') throw new Error('资料入库不执行分类全量扫描，请查询精确标识候选。');
    const current = this.currentScan(taskId);
    if (!current || current.categoryId !== categoryId) throw new Error('必须先选定本轮唯一父节点，不能跨分类扫描。');
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('页码从 1 开始。');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('每页数量必须为 1 到 100。');
    const scan = this.refreshScan(current);
    const docs = this.documents(categoryId);
    const totalPages = Math.max(1, Math.ceil(docs.length / pageSize));
    if (page > totalPages) throw new Error(`页码超出范围，本次最多 ${totalPages} 页。`);
    const provided = docs.slice((page - 1) * pageSize, page * pageSize);
    scan.providedIds = [...new Set([...scan.providedIds, ...provided.map(d => d.id)])];
    scan.pages = [...new Set([...scan.pages, page])].sort((a, b) => a - b);
    scan.total = docs.length;
    scan.complete = docs.every(d => scan.providedIds.includes(d.id));
    this.saveScan(scan);
    this.event(taskId, '扫描简介', `已提供 ${scan.providedIds.length} / ${scan.total} 篇文档简介${scan.complete ? '，扫描完成' : ''}。`, this.publicScan(scan));
    return { scan: this.publicScan(scan), documents: provided };
  }
  /** The model chooses a category; the service owns pagination. A batch records
   * only complete summaries actually returned, never an unseen database walk. */
  scanCategoryBatch(taskId: string, categoryId: string, continuation?: string, maxCharacters = SCAN_BATCH_MAX_CHARACTERS, previousRoundReason?: string): CategoryBatch {
    this.assertAllowed('category.scan', taskId); this.task(taskId);
    if (this.task(taskId).retrievalMode === 'collection') throw new Error('资料入库不执行分类全量扫描，请查询精确标识候选。');
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1024 || maxCharacters > SCAN_BATCH_MAX_CHARACTERS) throw new Error(`简介批次预算必须为 1024 到 ${SCAN_BATCH_MAX_CHARACTERS} 字符。`);
    let request: StoredCategoryBatch | undefined;
    let key: string;
    let scan: StoredScan;
    if (continuation !== undefined) {
      if (typeof continuation !== 'string' || !/^[0-9a-f-]{36}$/i.test(continuation)) throw new Error('无效的简介续读令牌，请使用上次返回的 continuation。');
      key = continuation; request = this.get<StoredCategoryBatch>('scan_batch', key);
      if (!request || request.taskId !== taskId || request.categoryId !== categoryId) throw new Error('续读令牌不属于当前任务和分类。');
      const current = this.currentScan(taskId);
      if (!current || current.round !== request.round || current.categoryId !== categoryId) throw new Error('研究轮次已变化，请不带 continuation 重新扫描当前分类。');
      scan = this.refreshScan(current);
      if (scan.metadataVersion !== request.metadataVersion) throw new Error('分类目录版本已变化，旧续读令牌已失效；请不带 continuation 从头重新扫描。');
    } else {
      this.selectCategory(taskId, categoryId, previousRoundReason);
      scan = this.currentScan(taskId)!;
      key = `${taskId}:${scan.round}:${scan.metadataVersion}:first`;
      request = this.get<StoredCategoryBatch>('scan_batch', key);
    }
    if (request?.result) {
      if (JSON.stringify(request.result).length > maxCharacters) throw new Error('该批次已按更大的预算提供，请使用原预算重试，不能截断已有批次。');
      return request.result;
    }
    const progress = hash([...scan.providedIds].sort().join('\n'));
    if (request && request.progress !== progress) throw new Error('简介提供进度已变化，请不带 continuation 重新扫描；不能跳过未提供的条目。');
    request ??= { taskId, categoryId, round: scan.round, metadataVersion: scan.metadataVersion, offset: 0, batch: 1, progress };
    const batchRequest = request;
    const docs = this.documents(categoryId);
    if (batchRequest.offset > docs.length) throw new Error('简介续读位置已失效，请不带 continuation 重新扫描。');
    const nextToken = id();
    const provided = new Set(scan.providedIds);
    const summaries: DocumentSummary[] = [];
    let offset = batchRequest.offset;
    const makeResult = (documents: DocumentSummary[], end: number, delivered: Set<string>): CategoryBatch => ({
      scope: 'category',
      scan: { taskId, categoryId, metadataVersion: scan.metadataVersion, total: docs.length, provided: delivered.size, complete: docs.every(doc => delivered.has(doc.id)) },
      documents, continuation: end < docs.length ? nextToken : null,
    });
    let result = makeResult(summaries, offset, provided);
    while (offset < docs.length) {
      const { id: documentId, categoryId: parentId, title, description, aliases, paperIds, version } = docs[offset];
      const summary: DocumentSummary = { id: documentId, categoryId: parentId, title, description, aliases, paperIds, version };
      const candidateProvided = new Set([...provided, documentId]);
      const candidate = makeResult([...summaries, summary], offset + 1, candidateProvided);
      if (JSON.stringify(candidate).length > maxCharacters) break;
      summaries.push(summary); provided.add(documentId); offset += 1; result = candidate;
    }
    if (offset === batchRequest.offset && offset < docs.length) throw new Error(`文档“${docs[offset].title.slice(0, 100)}”的完整简介元数据超过本次 ${maxCharacters} 字符预算，未将该条目标为已提供。请缩短过长的标题、简介、别名或论文标识符后重新扫描。`);
    if (JSON.stringify(result).length > maxCharacters) throw new Error('当前简介批次状态超过字符预算，未记录扫描完成。');
    const updated: StoredScan = { ...scan, total: docs.length, providedIds: [...provided], pages: [...new Set([...scan.pages, batchRequest.batch])].sort((a, b) => a - b), complete: result.scan.complete };
    this.transaction(() => {
      this.saveScan(updated);
      this.put('scan_batch', key, { ...batchRequest, result } satisfies StoredCategoryBatch);
      if (result.continuation) this.put('scan_batch', result.continuation, { taskId, categoryId, round: scan.round, metadataVersion: scan.metadataVersion, offset, batch: batchRequest.batch + 1, progress: hash([...provided].sort().join('\n')) } satisfies StoredCategoryBatch);
      this.event(taskId, '扫描简介', `已提供 ${provided.size} / ${docs.length} 篇完整文档简介${updated.complete ? '，扫描完成' : ''}。`, this.publicScan(updated));
    });
    return result;
  }
  scans(taskId: string): Scan[] { this.task(taskId); return this.all<StoredScan>('scan').filter(s => s.taskId === taskId).sort((a, b) => a.round - b.round).map(s => this.publicScan(s)); }
  private assertMaintenanceRead(taskId: string, document: KnowledgeDocument): void {
    const boundary = this.get<{ after: number }>('round_boundary', taskId)?.after ?? 0;
    const scans = this.all<StoredScan>('scan').filter(item => item.taskId === taskId && item.categoryId === document.categoryId && item.round > boundary).sort((a, b) => b.round - a.round);
    const scan = scans[0];
    if (!scan || scan.scope === 'identity' || !scan.complete || scan.metadataVersion !== this.category(document.categoryId).metadataVersion || !scan.providedIds.includes(document.id)) throw new Error('请先完整阅读参与文档所属目录的全部概览，目录变化后须重新扫描。');
    if (!scans.some(item => item.readVersions[document.id] === document.version) || !this.maintenanceVersionMatches(document.id, document.version)) throw new Error('参与维护的文档尚未阅读最新正文或正文已变化，请重新阅读。');
  }
  /** A fresh human question may start a new round after an informational round
   * with no publication. Only call at the trusted user-message boundary. */
  beginResearchRound(taskId: string): boolean {
    this.assertAllowed('task.new_round', taskId); this.task(taskId);
    if (this.drafts(taskId).some(d => d.status !== 'published')) return false;
    const rounds = this.all<StoredScan>('scan').filter(s => s.taskId === taskId).map(s => s.round);
    this.put('round_boundary', taskId, { after: Math.max(0, ...rounds) });
    this.db.prepare("DELETE FROM records WHERE kind='categories_read' AND id=?").run(taskId);
    return true;
  }
  readCandidate(taskId: string, docId: string, comparisonReason?: string): KnowledgeDocument {
    this.assertAllowed('candidate.read', taskId);
    const task = this.task(taskId);
    const current = this.currentScan(taskId);
    const openConflicts = this.conflicts().filter(c => active(c) && c.taskId === taskId);
    if (openConflicts.length) {
      if (!openConflicts.some(c => c.docIds.includes(docId))) throw new Error('冲突核实期间只能阅读当前冲突涉及的知识文档。');
      return this.document(docId);
    }
    const input = task.retrievalMode === 'maintenance' ? this.maintenanceInput(taskId) : undefined;
    if (task.retrievalMode === 'maintenance') {
      if (!input) throw new Error('当前维护没有待整理输入，不能继续扩展阅读。');
      if (docId !== input.id) {
        this.assertMaintenanceRead(taskId, { ...input, body: '' });
        const reason = required(comparisonReason, '候选概览与当前输入的共同问题及待核对点', 2000);
        if (reason.length < 6) throw new Error('请说明概览中的具体比较线索，不能只说相关或同类。');
      }
    }
    if (task.retrievalMode === 'maintenance' || !task.selectedDocIds.includes(docId)) this.assertDocumentActive(docId);
    const doc = this.document(docId);
    if (task.retrievalMode === 'maintenance' || !task.selectedDocIds.includes(docId)) {
      if (!current || current.categoryId !== doc.categoryId) throw new Error('该文档不在本轮父节点内，也不是用户明确选中的文档。');
      const fresh = this.refreshScan(current);
      if (!fresh.complete || !fresh.providedIds.includes(docId)) throw new Error(fresh.scope === 'identity' ? '先查询当前分类的精确标识候选，只能读取匹配候选或用户明确选中的文档。' : '先完整获取该父节点下全部文档简介，再阅读候选正文。');
    }
    if (current && current.categoryId === doc.categoryId) {
      const fresh = this.refreshScan(current);
      fresh.readIds = [...new Set([...fresh.readIds, docId])]; fresh.readVersions[docId] = doc.version; this.saveScan(fresh);
    }
    const run = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
    if (run && !run.completedAt && input) this.put('maintenance_run', taskId, { ...run, policyVersion: 4, currentDocumentId: input.id, currentDocumentTitle: input.title, updatedAt: now() });
    this.event(taskId, input?.id === docId ? '阅读当前输入' : '阅读候选', `已读取《${doc.title}》v${doc.version}`, { documentId: docId, ...(input ? { inputDocumentId: input.id, comparisonReason: input.id === docId ? undefined : comparisonReason } : {}) });
    return doc;
  }

  putDraft(taskId: string, input: DocumentInput & { draftId?: string; mergeFromDocIds?: string[] }): Draft {
    this.assertAllowed('draft.write', taskId); this.task(taskId);
    const current = this.currentScan(taskId);
    if (!current || current.categoryId !== input.categoryId) throw new Error('草稿必须归属于本轮选定的唯一父节点。');
    const scan = this.refreshScan(current);
    if (!scan.complete) throw new Error(scan.scope === 'identity' ? '精确标识候选查询尚未完成，不能创建或修改草稿。' : '该分类的全部简介尚未提供，不能创建或修改草稿。');
    const previousDraft = input.draftId ? this.get<Draft & { round: number }>('draft', input.draftId) : undefined;
    if (input.draftId && (!previousDraft || previousDraft.taskId !== taskId)) throw new Error('草稿不存在或不属于当前任务。');
    if (previousDraft?.status === 'published') throw new Error('已发布草稿不可修改，请基于当前文档创建新的草稿。');
    if (previousDraft && (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[]).some(row => (JSON.parse(row.value) as Journal).draftId === previousDraft.draftId)) throw new Error('该草稿有尚未完成的发布，不能产生新修订。请用原 revision 和自检报告重试提交，或重启应用恢复后继续。');
    if (previousDraft && previousDraft.round !== scan.round && !(this.task(taskId).retrievalMode === 'maintenance' && previousDraft.mergeFrom?.length)) throw new Error('不能修改上一研究轮次的草稿。');
    if (previousDraft && previousDraft.categoryId !== input.categoryId) throw new Error('草稿父节点不可跨分类更改。');
    if (!previousDraft && this.task(taskId).retrievalMode === 'maintenance' && this.drafts(taskId).some(draft => draft.status !== 'published')) throw new Error('请先修订、自检并发布已经保存的合并草稿，再整理下一篇。');
    const docId = input.id ?? previousDraft?.id;
    if (previousDraft && input.id && input.id !== previousDraft.id) throw new Error('草稿文档 ID 不可更改。');
    const stored = docId ? this.get<StoredDocument>('document', docId) : undefined;
    if (input.id && !stored && !previousDraft) throw new Error('指定文档不存在；新建草稿请省略文档 ID。');
    const prior = stored ? this.document(stored.meta.id) : undefined;
    if (prior) this.assertDocumentActive(prior.id);
    if (prior && this.task(taskId).retrievalMode === 'maintenance') throw new Error('维护合并应新建整合文档并替换原节点，请省略原文档 ID 并指定 mergeFromDocIds。');
    const mergingIds = input.mergeFromDocIds === undefined ? previousDraft?.mergeFrom?.map(part => part.id) ?? [] : cleanList(input.mergeFromDocIds).map(safeId);
    if (mergingIds.length && (this.task(taskId).retrievalMode !== 'maintenance' || prior || input.expectedVersion !== 0 || mergingIds.length < 2 || mergingIds.length > 100)) throw new Error('二合一只能在维护任务中基于至少两篇原稿新建整合文档，不能覆盖旧文档。');
    if (this.task(taskId).retrievalMode === 'maintenance' && !prior && !mergingIds.length) throw new Error('没有合并对象时保留现有独立节点；新建整合文档必须指定至少两篇原稿。');
    const mergeDocuments = mergingIds.map(documentId => { this.assertDocumentActive(documentId); const document = this.document(documentId); this.assertMaintenanceRead(taskId, document); return document; });
    if (mergeDocuments.length) {
      const run = this.get<StoredMaintenanceRun>('maintenance_run', taskId);
      if (!run || run.completedAt || !mergeDocuments.some(document => run.items.some(item => item.documentId === document.id) || this.get<MaintenanceLedger>('maintenance_ledger', document.id)?.runId === run.id)) throw new Error('合并必须包含本批待整理文档或本批已生成的整合文档。');
      const input = this.currentMaintenanceItem(run);
      if (!input || !mergingIds.includes(input.documentId)) throw new Error('合并必须包含当前输入，完成本篇后再整理下一篇。');
    }
    if (prior && this.task(taskId).retrievalMode === 'collection' && !this.task(taskId).selectedDocIds.includes(prior.id) && !scan.providedIds.includes(prior.id)) throw new Error('资料入库只能更新已查询到的精确标识候选或用户明确选中的文档。');
    if (prior && (prior.categoryId !== input.categoryId || scan.readVersions[prior.id] !== prior.version)) throw new Error('更新前必须重新读取本分类候选的最新正文；不能覆盖未读或已变化的文档。');
    // document() may have imported an external edit and invalidated this scan.
    if (this.category(input.categoryId).metadataVersion !== scan.metadataVersion) throw new Error('扫描后文档发生变化，请重新扫描简介并阅读候选。');
    const mergedSources = [...new Map([...(prior?.sources ?? []), ...(input.sources ?? []), ...mergeDocuments.flatMap(document => document.sources)].map(source => [source.id, source])).values()];
    const doc = this.validateDocument({ ...input, id: docId, sources: mergedSources }, prior);
    // A paper may introduce several independently named methods. Shared paper
    // IDs require reading same-parent candidates, not automatic identity merging.
    if (!prior && !mergeDocuments.length && doc.paperIds.length) {
      const paperIds = new Set(doc.paperIds.map(identity));
      const unread = this.documents(input.categoryId).some(candidate => candidate.paperIds.some(p => paperIds.has(identity(p))) && scan.readVersions[candidate.id] !== candidate.version);
      if (unread) throw new Error('同一论文标识符还有未读的本分类候选。请先阅读这些正文，判断是同一方法还是具有独立名称和核心差异的方法。');
    }
    if (previousDraft && !prior) { doc.id = previousDraft.id; doc.createdAt = previousDraft.createdAt; }
    const selectedForSources = this.task(taskId).retrievalMode === 'maintenance' ? [] : this.task(taskId).selectedDocIds;
    const readIds = this.task(taskId).retrievalMode === 'maintenance' ? this.scans(taskId).flatMap(item => item.readIds) : scan.readIds;
    const knownDocs = [...new Set([...selectedForSources, ...readIds])];
    const knownSourceIds = new Set([...this.raws(taskId).map(r => r.id), ...(prior?.sources ?? []).map(s => s.id), ...knownDocs.flatMap(selected => this.get<StoredDocument>('document', selected)?.meta.sources.map(s => s.id) ?? [])]);
    if (doc.sources.some(s => !knownSourceIds.has(s.id))) throw new Error('草稿引用了未获取的来源。请先真实读取并保存原始材料，再引用其 ID。');
    const draft: Draft & { round: number } = { ...doc, draftId: previousDraft?.draftId ?? id(), taskId, baseVersion: input.expectedVersion, revision: (previousDraft?.revision ?? 0) + 1, status: 'draft', round: scan.round,
      ...(mergeDocuments.length ? { mergeFrom: mergeDocuments.map(document => ({ id: document.id, version: document.version })) } : {}) };
    this.assertIdentity(doc, taskId, draft.draftId, mergingIds);
    this.atomic(path.join(this.dataDir, 'drafts', `${draft.draftId}.json`), JSON.stringify(draft, null, 2));
    this.atomic(path.join(this.dataDir, 'drafts', `${draft.draftId}.md`), draft.body);
    this.put('draft', draft.draftId, draft); this.event(taskId, '修改草稿', `《${draft.title}》草稿第 ${draft.revision} 次修订已保存。`);
    return draft;
  }
  drafts(taskId?: string): Draft[] { return this.all<Draft>('draft').filter(d => !taskId || d.taskId === taskId); }
  reviewDraft(taskId: string, draftId: string, review: SelfReview): Draft {
    this.assertAllowed('draft.review', taskId);
    const draft = this.get<Draft>('draft', draftId);
    if (!draft || draft.taskId !== taskId) throw new Error('草稿不存在或不属于当前任务。');
    if (draft.status === 'published') throw new Error('已发布版本不能重新自检。');
    const fields: (keyof SelfReview)[] = ['materialUnderstanding', 'speculation', 'conditions', 'methodIdentity', 'conflicts', 'structure', 'metadataConsistency'];
    for (const field of fields) required(review[field], `自检项 ${field}`, 20_000);
    if (typeof review.passed !== 'boolean' || typeof review.fixes !== 'string') throw new Error('自检必须包含是否通过和集中修正说明。');
    const updated: Draft = { ...draft, review, status: review.passed ? 'reviewed' : 'draft' };
    this.atomic(path.join(this.dataDir, 'drafts', `${draftId}.json`), JSON.stringify(updated, null, 2)); this.put('draft', draftId, updated);
    this.event(taskId, '自检', `《${draft.title}》内容自检${review.passed ? '通过' : '发现问题，需要集中修正'}。`); return updated;
  }
  /** Submit the main model's review for one exact revision. Review persistence
   * is replay-safe; publication still uses the existing guarded durable journal. */
  private assertDraftRetryScope(taskId: string, draft: Draft): void {
    const retryInputIds = this.task(taskId).retryInputIds;
    if (!retryInputIds) return;
    const sources = new Set(this.taskInputs(taskId).filter(input => retryInputIds.includes(input.id)).flatMap(input => input.sourceIds));
    if (!draft.sources.some(source => sources.has(source.id))) throw new Error('本次只能发布引用了所选重试材料的草稿，其他草稿已保留。');
  }
  submitDraft(taskId: string, draftId: string, revision: number, review: SelfReview): { draft: Draft; document?: KnowledgeDocument } {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('提交自检必须提供草稿的正整数 revision。');
    const checked = checkedReview(review), fingerprint = hash(JSON.stringify(checked));
    this.task(taskId);
    let draft = this.get<Draft>('draft', draftId);
    if (!draft || draft.taskId !== taskId) throw new Error('草稿不存在或不属于当前任务。');
    this.assertDraftRetryScope(taskId, draft);
    if (draft.revision !== revision) throw new Error(`草稿已变化：当前修订 ${draft.revision}，提交基于修订 ${revision}。请重新阅读并自检当前修订。`);
    const pending = (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[]).some(row => {
      const journal = JSON.parse(row.value) as Journal; return journal.draftId === draftId && journal.taskId === taskId;
    });
    if (pending) { this.assertAllowed('draft.publish', taskId); this.recoverPublications(); draft = this.get<Draft>('draft', draftId)!; }
    if (draft.revision !== revision) throw new Error('恢复发布时草稿修订已变化，请重新读取当前草稿。');
    const reviewEpoch = this.get<{ value: number }>('draft_review_epoch', draftId)?.value ?? 0;
    const key = `${draftId}:${revision}:${reviewEpoch}`;
    const receipt = this.get<DraftSubmission>('draft_submission', key);
    if (receipt && (receipt.taskId !== taskId || receipt.fingerprint !== fingerprint)) throw new Error('此草稿修订已经提交了不同的自检报告，不能冒充同一次提交。请先修订草稿再提交新的自检。');
    if (draft.review && hash(JSON.stringify(checkedReview(draft.review))) !== fingerprint) throw new Error('此草稿修订已有不同的自检报告。请修订草稿后，对新的 revision 重新自检。');
    // Returning a previously committed version is a read, even if another
    // conflict has since locked the library. It never republishes or unlocks.
    if (draft.status === 'published') {
      if (!checked.passed || !draft.review?.passed || !draft.publishedVersion) throw new Error('已发布草稿的自检或版本记录不完整，无法确认重复提交。');
      return { draft, document: this.version(draft.id, draft.publishedVersion) };
    }
    this.assertAllowed('draft.review', taskId);
    if (!receipt) draft = this.transaction(() => {
      const reviewed = this.reviewDraft(taskId, draftId, checked);
      this.put('draft_submission', key, { taskId, draftId, revision, reviewEpoch, fingerprint, createdAt: now() } satisfies DraftSubmission);
      return reviewed;
    });
    else if (!draft.review || draft.review.passed !== checked.passed) throw new Error('此自检记录已失效，请重新读取草稿后提交。');
    if (!checked.passed) return { draft };
    const document = this.publishDraft(taskId, draftId);
    return { draft: this.get<Draft>('draft', draftId)!, document };
  }
  publishDraft(taskId: string, draftId: string): KnowledgeDocument {
    this.assertAllowed('draft.publish', taskId);
    const before = this.get<Draft>('draft', draftId);
    if (!before || before.taskId !== taskId) throw new Error('草稿不存在或不属于当前任务。');
    this.assertDraftRetryScope(taskId, before);
    const pending = (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[])
      .map(row => JSON.parse(row.value) as Journal).some(j => j.draftId === draftId && j.taskId === taskId);
    if (pending) this.recoverPublications();
    const draft = this.get<Draft & { round: number }>('draft', draftId);
    if (!draft || draft.taskId !== taskId) throw new Error('草稿不存在或不属于当前任务。');
    if (draft.status === 'published') {
      if (!draft.publishedVersion) throw new Error('已发布草稿缺少版本记录。');
      return this.version(draft.id, draft.publishedVersion);
    }
    if (draft.status !== 'reviewed' || !draft.review?.passed) throw new Error('草稿必须完成当前修订的七项内容自检，才能发布。');
    const scan = this.currentScan(taskId);
    if (!scan || scan.round !== draft.round || scan.categoryId !== draft.categoryId || !this.refreshScan(scan).complete) throw new Error('分类简介扫描已失效，请重新完整扫描。');
    const existing = this.get<StoredDocument>('document', draft.id);
    const prior = existing ? this.document(draft.id) : undefined;
    if ((prior?.version ?? 0) !== draft.baseVersion) throw new Error('研究期间文档被修改，草稿不能覆盖新版本。请重新读取正文并合并修改。');
    if (prior && scan.readVersions[prior.id] !== prior.version) throw new Error('请读取当前版本正文后再发布。');
    if (this.category(draft.categoryId).metadataVersion !== scan.metadataVersion) throw new Error('目录在扫描后变化，请重新扫描并确认候选。');
    for (const part of draft.mergeFrom ?? []) {
      this.assertDocumentActive(part.id); const participant = this.document(part.id);
      if (participant.version !== part.version) throw new Error('原稿在合并草稿生成后已变化，请重读并修订草稿。');
      this.assertMaintenanceRead(taskId, participant);
      if (participant.sources.some(source => !draft.sources.some(candidate => candidate.id === source.id))) throw new Error('整合文档必须保留两篇原稿的全部来源。');
    }
    this.assertIdentity(draft, taskId, draft.draftId, draft.mergeFrom?.map(part => part.id));
    const { draftId: _draftId, taskId: _taskId, baseVersion: _base, revision: _revision, status: _status, review: _review, publishedVersion: _published, round: _round, mergeFrom: _mergeFrom, ...doc } = draft;
    doc.version = draft.baseVersion + 1; doc.updatedAt = now();
    this.persistDocument(doc, prior, 'Agent 自检后发布', draft.draftId, taskId);
    this.event(taskId, '已发布', `《${doc.title}》v${doc.version} 已发布。`, { documentId: doc.id, version: doc.version }); return doc;
  }

  conflicts(): Conflict[] { return this.all<Conflict>('conflict').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  attachConflictSource(taskId: string, conflictId: string, sourceId: string): Conflict {
    this.assertAllowed('source.read', taskId);
    const conflict = this.get<Conflict>('conflict', conflictId);
    if (!conflict || conflict.taskId !== taskId || !active(conflict)) throw new Error('只能向当前任务尚未解决的冲突追加核实来源。');
    const raw = this.raw(sourceId);
    if (raw.taskId !== taskId) throw new Error('核实来源不属于当前任务。');
    const next: Conflict = { ...conflict, sourceIds: [...new Set([...conflict.sourceIds, sourceId])], updatedAt: now() };
    this.put('conflict', conflictId, next); return next;
  }
  reportConflict(taskId: string, input: { docIds: string[]; sourceIds: string[]; oldClaim: string; newClaim: string; reason: string; conditionsA?: string; conditionsB?: string }): Conflict {
    this.assertAllowed('conflict.report', taskId); const task = this.task(taskId);
    const docIds = cleanList(input.docIds); const sourceIds = cleanList(input.sourceIds);
    if (!docIds.length && !sourceIds.length) throw new Error('疑似冲突必须指明需要核实的文档或原始材料。');
    const scan = this.currentScan(taskId);
    for (const docId of docIds) {
      if (task.retrievalMode === 'maintenance') {
        this.assertDocumentActive(docId); this.assertMaintenanceRead(taskId, this.document(docId));
      } else {
        if (!task.selectedDocIds.includes(docId) && !scan?.readIds.includes(docId)) throw new Error('冲突只能关联用户明确指定或当前已经读取的候选文档。');
        this.document(docId);
      }
    }
    const allowedSources = new Set([...task.sourceIds, ...docIds.flatMap(d => this.get<StoredDocument>('document', d)?.meta.sources.map(s => s.id) ?? [])]);
    for (const sourceId of sourceIds) if (!allowedSources.has(sourceId)) throw new Error('冲突只能关联本次材料和已读文档的来源。');
    const oldClaim = required(input.oldClaim, '旧说法', 20_000); const newClaim = required(input.newClaim, '新说法', 20_000);
    const duplicate = this.conflicts().find(c => c.taskId === taskId && active(c) && normal(c.oldClaim) === normal(oldClaim) && normal(c.newClaim) === normal(newClaim));
    if (duplicate) return duplicate;
    const conflict: Conflict = { id: id(), taskId, docIds, sourceIds, oldClaim, newClaim, reason: required(input.reason, '冲突原因', 20_000), status: 'suspected', evidence: [], conditionsA: input.conditionsA, conditionsB: input.conditionsB, createdAt: now(), updatedAt: now() };
    this.transaction(() => {
      this.put('conflict', conflict.id, conflict);
      this.updateTask(taskId, { stage: '正在核实疑似冲突' });
      for (const run of this.all<StoredMaintenanceRun>('maintenance_run').filter(candidate => !candidate.completedAt)) {
        // Reports predating a newly discovered conflict cannot certify that its
        // eventual resolution has been incorporated in this maintenance run.
        const items = run.items.map(item => {
          if (item.status !== 'done' || item.outcome === 'merged') return item;
          const { checkedVersion: _checked, comparedVersions: _versions, outcome: _outcome, mergedDocIds: _merged, concept: _concept, summary: _summary, completedAt: _at, ...pending } = item;
          if (this.get<MaintenanceLedger>('maintenance_ledger', item.documentId)?.runId === run.id) this.db.prepare("DELETE FROM records WHERE kind='maintenance_ledger' AND id=?").run(item.documentId);
          return { ...pending, status: 'pending' as const };
        });
        this.put('maintenance_run', run.taskId, { ...run, items, updatedAt: now() });
        if (run.items.some(item => item.status === 'done')) this.event(run.taskId, '维护进度', '发现知识冲突，先前检查认证已失效；处理可信裁决后需要重新核对。');
      }
      for (const other of this.tasks()) if (other.id !== taskId && (other.status === 'running' || other.status === 'queued')) this.updateTask(other.id, { status: 'paused', stage: '因全局知识冲突暂停' });
      // A review performed before discovering a conflict cannot certify that
      // the conflict and its eventual human resolution were incorporated.
      for (const draft of this.drafts()) if (draft.status === 'reviewed' || (draft.status !== 'published' && draft.review)) {
        const { review: _review, ...unreviewed } = draft;
        this.put('draft', draft.draftId, { ...unreviewed, status: 'draft' });
        const epoch = this.get<{ value: number }>('draft_review_epoch', draft.draftId)?.value ?? 0;
        this.put('draft_review_epoch', draft.draftId, { value: epoch + 1 });
      }
    });
    this.event(taskId, '疑似冲突', '其他业务操作已暂停，正在核实对象、前提、时间、版本、指标及适用条件。', { conflictId: conflict.id }); return conflict;
  }
  reviewConflict(taskId: string, conflictId: string, input: { confirmed: boolean; review: string; evidence: SourceRef[]; conditionsA?: string; conditionsB?: string }): Conflict {
    this.assertAllowed('conflict.review', taskId);
    const conflict = this.get<Conflict>('conflict', conflictId);
    if (!conflict || conflict.taskId !== taskId) throw new Error('冲突不存在或不属于当前任务。');
    if (!active(conflict)) throw new Error('该冲突已结束。');
    if (conflict.status === 'confirmed' && !input.confirmed) throw new Error('已确认的真实冲突只能由明确的人类 A/B/C 裁决解锁。');
    if (typeof input.confirmed !== 'boolean') throw new Error('必须明确提交是否确认为真实冲突。');
    this.validateSources(input.evidence);
    const knownIds = new Set([...this.task(taskId).sourceIds, ...conflict.sourceIds, ...conflict.docIds.flatMap(d => this.get<StoredDocument>('document', d)?.meta.sources.map(s => s.id) ?? [])]);
    if (input.evidence.some(e => !knownIds.has(e.id))) throw new Error('核实证据必须来自已经获取的真实材料。');
    const next: Conflict = { ...conflict, status: input.confirmed ? 'confirmed' : 'dismissed', review: required(input.review, '核实说明', 30_000), evidence: input.evidence, conditionsA: input.conditionsA ?? conflict.conditionsA, conditionsB: input.conditionsB ?? conflict.conditionsB, updatedAt: now() };
    this.put('conflict', conflictId, next);
    this.updateTask(taskId, input.confirmed ? { status: 'waiting_user', stage: '等待用户裁决' } : { stage: this.conflicts().some(c => active(c) && c.taskId === taskId) ? '仍有冲突待处理' : '冲突已排除，继续研究' });
    this.event(taskId, input.confirmed ? '等待裁决' : '已排除疑似冲突', next.review!, { conflictId }); return next;
  }
  /** Trusted service/UI boundary only. Never expose this as an Agent tool. */
  resolveConflict(conflictId: string, decision: 'A' | 'B' | 'C', conditionsA?: string, conditionsB?: string): Conflict {
    this.assertAllowed('conflict.resolve');
    const conflict = this.get<Conflict>('conflict', conflictId);
    if (!conflict || conflict.status !== 'confirmed') throw new Error('只有已确认且等待裁决的冲突可以接收裁决。');
    if (!['A', 'B', 'C'].includes(decision)) throw new Error('有效裁决仅有 A、B、C。补充说明和追问不能解锁。');
    const a = conditionsA?.trim() || conflict.conditionsA?.trim(); const b = conditionsB?.trim() || conflict.conditionsB?.trim();
    if (decision === 'C') {
      if (!a || !b || a.length < 6 || b.length < 6 || normal(a) === normal(b) || /^(?:可能都对|场景不同吧?|条件不同|不知道|不确定|待确认|待补充)[。\s]*$/.test(a) || /^(?:可能都对|场景不同吧?|条件不同|不知道|不确定|待确认|待补充)[。\s]*$/.test(b)) throw new Error('选择 C 必须分别提供具体、不同的适用条件，不能用含糊描述解锁。');
    }
    const resolution = decision === 'A' ? `用户裁决 A：保留旧说法“${conflict.oldClaim}”。` : decision === 'B' ? `用户裁决 B：采纳新说法“${conflict.newClaim}”。` : `用户裁决 C：旧说法适用于“${a}”；新说法适用于“${b}”。`;
    const next: Conflict = { ...conflict, status: 'resolved', decision, conditionsA: a, conditionsB: b, resolution, updatedAt: now() };
    this.put('conflict', conflictId, next);
    const stillBlocked = this.conflicts().some(active);
    this.updateTask(conflict.taskId, { status: stillBlocked ? 'waiting_user' : 'paused', stage: stillBlocked ? '仍有冲突待裁决' : '已接收裁决，等待恢复原任务' });
    this.addMessage(conflict.taskId, 'system', resolution);
    this.event(conflict.taskId, '用户裁决', resolution, { conflictId, decision }); return next;
  }

  private persistDocument(next: KnowledgeDocument, previous: KnowledgeDocument | undefined, reason: string, draftId?: string, taskId?: string): void {
    safeId(next.id);
    const pending = (this.db.prepare('SELECT value FROM publication_journal').all() as { value: string }[])
      .map(row => JSON.parse(row.value) as Journal).some(j => j.next.id === next.id);
    if (pending) throw new Error('该文档有一次未完成的持久化操作。请重启应用恢复后再继续，当前修改尚未覆盖正文。');
    const draft = draftId ? this.get<Draft>('draft', draftId) : undefined;
    const journal: Journal = { id: id(), next, previous, reason, draftId, draftRevision: draft?.revision,
      draftReviewEpoch: draftId ? this.get<{ value: number }>('draft_review_epoch', draftId)?.value ?? 0 : undefined, taskId, mergeFrom: draft?.mergeFrom };
    this.db.prepare('INSERT INTO publication_journal(id,value) VALUES(?,?)').run(journal.id, JSON.stringify(journal));
    this.finishPublication(journal);
  }
  private snapshot(version: Version): void {
    const folder = path.join(this.dataDir, 'history', safeId(version.id));
    // Metadata may be revised after an uncommitted merge was abandoned while
    // its body stays identical. Full snapshot identity avoids mistaking that
    // recoverable output for an already committed immutable version.
    const stem = `v${version.version}-${hash(JSON.stringify(version)).slice(0, 24)}`;
    this.immutable(path.join(folder, `${stem}.md`), version.body);
    this.immutable(path.join(folder, `${stem}.json`), JSON.stringify(version, null, 2));
  }
  private assertMergePublication(journal: Journal): void {
    if (!journal.mergeFrom?.length) return;
    const draft = journal.draftId && this.get<Draft>('draft', journal.draftId);
    const epoch = journal.draftId ? this.get<{ value: number }>('draft_review_epoch', journal.draftId)?.value ?? 0 : undefined;
    if (!draft || draft.revision !== journal.draftRevision || !draft.review?.passed || !['reviewed', 'published'].includes(draft.status) || epoch !== journal.draftReviewEpoch) throw new Error('合并自检在中断或分歧裁决后已失效，请重新核对裁决并修订自检。');
    const run = journal.taskId && this.get<StoredMaintenanceRun>('maintenance_run', journal.taskId);
    if (!run || run.completedAt || journal.previous || journal.mergeFrom.length < 2) throw new Error('二合一发布缺少有效的维护批次或原稿。');
    const input = this.currentMaintenanceItem(run);
    if (!input || !journal.mergeFrom.some(part => part.id === input.documentId)) throw new Error('当前输入已变化，不能重放其它待办的旧合并意图。');
    for (const part of journal.mergeFrom) {
      const stored = this.get<StoredDocument>('document', part.id);
      const archive = this.get<DocumentArchive>('document_archive', part.id);
      if (!stored || part.id === journal.next.id || stored.meta.version !== part.version || !this.maintenanceVersionMatches(part.id, part.version) || (archive && archive.replacementId !== journal.next.id)) throw new Error('原稿在发布期间已变化或已被另一文档合并，不能归档或计为完成。');
      if (stored.meta.sources.some(source => !journal.next.sources.some(candidate => candidate.id === source.id))) throw new Error('整合文档缺少原稿来源，发布未完成。');
    }
  }
  private commitMaintenanceMerge(journal: Journal): void {
    if (!journal.mergeFrom?.length || !journal.taskId) return;
    const run = this.get<StoredMaintenanceRun>('maintenance_run', journal.taskId)!;
    const mergedIds = new Set(journal.mergeFrom.map(part => part.id));
    const stamp = journal.next.updatedAt;
    for (const part of journal.mergeFrom) {
      this.put('document_archive', part.id, { documentId: part.id, replacementId: journal.next.id, version: part.version, taskId: journal.taskId, mergedAt: stamp } satisfies DocumentArchive);
    }
    const items = run.items.map(item => {
      const participant = journal.mergeFrom!.find(part => part.id === item.documentId);
      const chained = item.outcome === 'merged' && item.mergedDocIds?.some(documentId => mergedIds.has(documentId));
      if (!participant && !chained) return item;
      const updated: StoredMaintenanceItem = { ...item, status: 'done', outcome: 'merged', checkedVersion: participant?.version ?? item.checkedVersion,
        mergedDocIds: [journal.next.id], concept: journal.next.title,
        summary: `已生成《${journal.next.title}》，重新整理标题、概览和正文；原节点已替换，原稿和来源已归档保留。`, completedAt: stamp,
        comparedVersions: participant ? Object.fromEntries(journal.mergeFrom!.filter(part => part.id !== item.documentId).map(part => [part.id, part.version])) : item.comparedVersions };
      this.put('maintenance_ledger', item.documentId, { documentId: item.documentId, checkedVersion: updated.checkedVersion!, runId: run.id, completedAt: stamp } satisfies MaintenanceLedger);
      return updated;
    });
    this.put('maintenance_ledger', journal.next.id, { documentId: journal.next.id, checkedVersion: journal.next.version, runId: run.id, completedAt: stamp } satisfies MaintenanceLedger);
    const current = items.find(item => item.status === 'pending' && item.documentId === run.currentDocumentId) ?? items.find(item => item.status === 'pending');
    this.put('maintenance_run', journal.taskId, { ...run, policyVersion: 4, items, currentDocumentId: current?.documentId, currentDocumentTitle: current?.title, updatedAt: stamp });
    this.event(journal.taskId, '二合一完成', `已生成《${journal.next.title}》，${journal.mergeFrom.length} 个原节点已替换为一个整合节点。`, { documentId: journal.next.id, archivedDocumentIds: [...mergedIds] });
  }
  private finishPublication(journal: Journal): void {
    const { next, previous, reason } = journal;
    this.assertMergePublication(journal);
    if (journal.draftId && journal.draftRevision !== undefined && this.get<Draft>('draft', journal.draftId)?.revision !== journal.draftRevision) throw new Error('发布记录与当前草稿修订不一致，已拒绝用旧自检发布或认证新修订。');
    const version: Version = { ...next, reason };
    const before = this.get<StoredDocument>('document', next.id);
    if (before && before.meta.version > next.version) throw new Error('发布恢复时发现更新版本，已保留最新内容。');
    if (before && before.meta.version === next.version && before.hash !== hash(next.body)) throw new Error('版本编号冲突，拒绝覆盖历史。');
    this.snapshot(version);
    const file = this.libraryPath(next.id);
    if (existsSync(file)) {
      const onDisk = hash(readFileSync(file, 'utf8'));
      if (onDisk !== hash(next.body) && (!previous || onDisk !== hash(previous.body))) throw new Error('写入前检测到外部 Markdown 修改，已保留外部内容。请重新读取并合并后重试。');
    }
    this.atomic(file, next.body);
    this.transaction(() => {
      this.assertMergePublication(journal);
      const existing = this.get<StoredDocument>('document', next.id);
      if (existing && existing.meta.version > next.version) throw new Error('发布恢复时发现更新版本，已保留最新内容。');
      if (existing && existing.meta.version === next.version && existing.hash !== hash(next.body)) throw new Error('版本编号冲突，拒绝覆盖历史。');
      const { body: _body, ...meta } = next;
      this.put('document', next.id, { meta, hash: hash(next.body) } satisfies StoredDocument);
      const storedVersion = this.db.prepare('SELECT value FROM versions WHERE doc_id=? AND version=?').get(next.id, next.version) as { value: string } | undefined;
      if (storedVersion && storedVersion.value !== JSON.stringify(version)) throw new Error('已存在不同内容的历史版本，拒绝覆盖。');
      this.db.prepare('INSERT OR IGNORE INTO versions(doc_id,version,value) VALUES(?,?,?)').run(next.id, next.version, JSON.stringify(version));
      const categoryVersions = new Map(this.all<Category>('category').map(category => [category.id, category.metadataVersion]));
      if (!existing || existing.meta.version < next.version) {
        const affected = new Set([next.categoryId, ...(previous ? [previous.categoryId] : []), ...(journal.mergeFrom ?? []).map(part => this.get<StoredDocument>('document', part.id)!.meta.categoryId)]);
        for (const categoryId of affected) this.bumpCategory(categoryId);
      }
      this.commitMaintenanceMerge(journal);
      if (journal.draftId) {
        const draft = this.get<Draft>('draft', journal.draftId);
        if (draft) this.put('draft', draft.draftId, { ...draft, status: 'published', publishedVersion: next.version });
      }
      if (journal.taskId) {
        const scans = journal.mergeFrom?.length ? this.all<StoredScan>('scan').filter(scan => scan.taskId === journal.taskId) : [this.currentScan(journal.taskId)].filter((scan): scan is StoredScan => Boolean(scan));
        for (const scan of scans) if (scan.complete && scan.metadataVersion === categoryVersions.get(scan.categoryId) && (scan.categoryId === next.categoryId || journal.mergeFrom?.some(part => this.get<StoredDocument>('document', part.id)?.meta.categoryId === scan.categoryId))) {
          // This exact metadata was returned by publication to the same task.
          scan.metadataVersion = this.category(scan.categoryId).metadataVersion;
          scan.providedIds = scan.providedIds.filter(documentId => !journal.mergeFrom?.some(part => part.id === documentId));
          if (scan.categoryId === next.categoryId) {
            scan.providedIds = [...new Set([...scan.providedIds, next.id])];
            scan.readIds = [...new Set([...scan.readIds, next.id])]; scan.readVersions[next.id] = next.version;
          }
          scan.total = scan.scope === 'identity' ? scan.providedIds.length : this.documents(scan.categoryId).length;
          this.saveScan(scan);
        }
      }
      this.db.prepare('DELETE FROM publication_journal WHERE id=?').run(journal.id);
    });
    if (journal.draftId) {
      const draft = this.get<Draft>('draft', journal.draftId);
      if (draft) this.atomic(path.join(this.dataDir, 'drafts', `${draft.draftId}.json`), JSON.stringify(draft, null, 2));
    }
  }
  private recoverPublications(): void {
    const rows = this.db.prepare('SELECT value FROM publication_journal ORDER BY rowid').all() as { value: string }[];
    // Recovery must respect the same business lock as ordinary publication.
    // The durable intent remains available until the human resolves conflicts.
    if (rows.length && this.conflicts().some(active)) { this.recovered = true; return; }
    for (const row of rows) {
      const journal = JSON.parse(row.value) as Journal;
      const file = this.libraryPath(journal.next.id);
      const fileHash = existsSync(file) ? hash(readFileSync(file, 'utf8')) : undefined;
      const allowedHashes = [hash(journal.next.body), journal.previous && hash(journal.previous.body)].filter(Boolean);
      if (journal.mergeFrom?.length) {
        try {
          this.assertMergePublication(journal);
          if (fileHash && !allowedHashes.includes(fileHash)) throw new Error('新整合正文被外部修改，需重新自检。');
          this.finishPublication(journal);
        } catch (error) {
          // Nothing was made public before the SQLite transaction committed.
          // Preserve any interrupted output as a recoverable draft, and leave
          // both original nodes active instead of replaying stale approval.
          if (this.get<StoredDocument>('document', journal.next.id)) throw error;
          if (existsSync(file)) {
            if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('中断合并正文路径异常，已停止恢复。');
            renameSync(file, path.join(this.dataDir, 'drafts', `recovered-${safeId(journal.id)}.md`));
          }
          const reason = error instanceof Error ? error.message : String(error);
          this.transaction(() => {
            this.put('abandoned_publication', journal.id, { ...journal, reason });
            this.db.prepare('DELETE FROM publication_journal WHERE id=?').run(journal.id);
            const draft = journal.draftId && this.get<Draft>('draft', journal.draftId);
            if (draft) {
              this.put('draft', draft.draftId, { ...draft, status: 'draft', review: undefined });
              const epoch = this.get<{ value: number }>('draft_review_epoch', draft.draftId)?.value ?? 0;
              this.put('draft_review_epoch', draft.draftId, { value: epoch + 1 });
            }
            if (journal.taskId) {
              this.updateTask(journal.taskId, { status: 'paused', stage: '合并依据已变化，请重新阅读并自检' });
              this.event(journal.taskId, '恢复', `二合一未发布，原节点与草稿已保留：${reason}`);
            }
          });
        }
        this.recovered = true;
        continue;
      }
      if (fileHash && !allowedHashes.includes(fileHash)) {
        // An external editor changed the file after the intent was recorded.
        // Preserve that file and abandon this publication; document() will
        // register the external body as a new version on its next read.
        this.put('abandoned_publication', journal.id, { ...journal, reason: '发布中断后发现外部修改，已保留外部正文。' });
        this.db.prepare('DELETE FROM publication_journal WHERE id=?').run(journal.id);
        if (!this.get<StoredDocument>('document', journal.next.id)) {
          // A newly created document has no prior row. Register the external
          // body under its intended stable ID so it cannot become an orphan.
          this.persistDocument({ ...journal.next, body: readFileSync(file, 'utf8'), updatedAt: now() }, undefined, '恢复中断发布时保留外部 Markdown 修改');
        }
        if (journal.taskId) {
          this.updateTask(journal.taskId, { status: 'paused', stage: '发现外部修改，请重新读取并合并' });
          this.event(journal.taskId, '恢复', '中断的发布未覆盖外部 Markdown 修改；草稿已保留。');
        }
      } else {
        this.finishPublication(journal);
      }
      this.recovered = true;
    }
  }

  private defaultCategories(): Category[] {
    const rows: Array<[string, string, string, string, string]> = [
      ['model-training', '模型训练', '模型如何学习、形成能力与改进：涵盖架构、学习理论、训练方法与模型能力研究。', '机器学习、强化学习、优化、预训练、微调、对齐、NLP、LLM、VLM、世界模型及具身模型的架构、训练与能力分析。细分主题写入文档标题、简介和正文，暂不拆成子分类。', '以规划、工具、记忆及任务执行系统为主要贡献的内容归 Agent；以分布式、算力、部署及运行效率为主要贡献的内容归 Infra。'],
      ['agent', 'Agent', '将模型组织成能够感知、规划、使用工具和完成任务的系统。', 'Agent 架构、规划、记忆、工具调用、任务编排、多智能体、具身行动闭环与系统自我改进。RSI 等缩写依据已明确的研究内容归属，不凭缩写推断含义。细分主题写入文档标题、简介和正文，暂不拆成子分类。', '以模型架构、参数或策略训练为主要贡献的内容归模型训练；通用模型服务、执行基础设施和资源调度归 Infra。'],
      ['infra', 'Infra', '支撑模型训练与 Agent 运行的系统、算力和工程基础设施。', '分布式训练、推理服务、编译器、算力、存储、数据管线、部署、监控、评测平台、通用运行环境与资源调度。细分主题写入文档标题、简介和正文，暂不拆成子分类。', '模型学习与能力方法归模型训练；Agent 的规划、记忆、工具策略与任务执行机制归 Agent。'],
    ];
    return rows.map(([categoryId, name, description, includes, excludes]) => ({ id: categoryId, parentId: null, name, description, includes, excludes, scopeConfirmed: true, metadataVersion: 1 }));
  }

  private seedCategories(): void {
    this.transaction(() => {
      for (const category of this.defaultCategories()) this.put('category', category.id, category);
    });
  }

  /** Upgrade only the untouched, empty nine-category starter library. Libraries
   * with user edits, tasks, documents, drafts or history keep their own taxonomy. */
  private migrateInitialCategories(): void {
    const previous = this.all<Category>('category');
    const legacy = new Map([
      ['machine-learning', '机器学习'], ['reinforcement-learning', '强化学习'], ['vlm', 'VLM'],
      ['rsi', 'RSI'], ['world-model', 'World Model'], ['embodied-ai', '具身智能'],
      ['ai-infra', 'AI Infra'], ['nlp', 'NLP'], ['agent', 'Agent'],
    ]);
    if (previous.length !== legacy.size || this.categoryVersion() !== 1 || previous.some(category =>
      legacy.get(category.id) !== category.name || category.parentId !== null || category.metadataVersion !== 1 || category.scopeConfirmed !== (category.id !== 'rsi'))) return;
    const hasContent = this.db.prepare("SELECT 1 FROM records WHERE kind <> 'category' LIMIT 1").get()
      || this.db.prepare('SELECT 1 FROM versions LIMIT 1').get()
      || this.db.prepare('SELECT 1 FROM publication_journal LIMIT 1').get();
    if (hasContent) return;
    this.transaction(() => {
      this.put('migration', 'three-broad-categories-v1', { at: now(), previousCategories: previous, previousCategoryVersion: 1 });
      this.db.prepare("DELETE FROM records WHERE kind='category'").run();
      for (const category of this.defaultCategories()) this.put('category', category.id, { ...category, metadataVersion: 2 });
      this.db.prepare("UPDATE counters SET value=value+1 WHERE id='categories'").run();
    });
  }
}
