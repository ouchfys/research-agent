import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MIGRATION = 'maintenance_merge_diff_v1';
type Row = { id: string; value: string };

/** Remove obsolete semantic links, without pretending they are concept-level
 * comparisons. Completed reports remain history; unfinished certifications
 * must be repeated under the new policy. The SQLite backup includes WAL data. */
export function migrateMaintenanceRelations(db: DatabaseSync, dataDir: string): { migrated: number; removedPairs: number; backupPath?: string } {
  if (db.prepare("SELECT 1 FROM records WHERE kind='migration' AND id=?").get(MIGRATION)) return { migrated: 0, removedPairs: 0 };
  const rows = db.prepare("SELECT id,value FROM records WHERE kind='maintenance_run'").all() as Row[];
  const legacy = rows.map(row => ({ row, run: JSON.parse(row.value) })).filter(({ run }) =>
    Array.isArray(run.items) && run.items.some((item: Record<string, unknown>) => 'relatedDocIds' in item || 'relatedVersions' in item));
  const pairs = new Set<string>();
  let backupPath: string | undefined;
  if (legacy.length) {
    const directory = path.join(path.resolve(dataDir), 'backups');
    mkdirSync(directory, { recursive: true });
    backupPath = path.join(directory, `before-merge-diff-${Date.now()}-${randomUUID()}.sqlite`);
    db.prepare('VACUUM INTO ?').run(backupPath);
  }
  const publishedTasks = new Set((db.prepare("SELECT value FROM records WHERE kind='draft'").all() as { value: string }[])
    .map(row => JSON.parse(row.value)).filter(draft => draft.status === 'published').map(draft => draft.taskId));
  const update = db.prepare("UPDATE records SET value=? WHERE kind='maintenance_run' AND id=?");
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row, run } of legacy) {
      run.items = run.items.map((item: Record<string, any>) => {
        for (const candidate of item.relatedDocIds ?? []) pairs.add([item.documentId, candidate].sort().join(':'));
        const { relatedDocIds: _ids, relatedVersions: _versions, ...clean } = item;
        if (!run.completedAt && item.status === 'done') {
          delete clean.checkedVersion; delete clean.completedAt; delete clean.outcome;
          delete clean.mergedDocIds; delete clean.concept; delete clean.comparedVersions;
          clean.status = 'pending';
          db.prepare("DELETE FROM records WHERE kind='maintenance_ledger' AND id=? AND json_extract(value,'$.runId')=?").run(item.documentId, run.id);
        } else if (run.completedAt && item.status === 'done' && item.initialVersion === item.checkedVersion && !publishedTasks.has(run.taskId)) {
          clean.outcome = 'no_change';
        }
        return clean;
      });
      delete run.relationCount;
      run.policyVersion = 2;
      update.run(JSON.stringify(run), row.id);
    }
    db.prepare("INSERT INTO records(kind,id,value) VALUES('migration',?,?)").run(MIGRATION, JSON.stringify({ at: new Date().toISOString(), runs: legacy.length, removedPairs: pairs.size, backupPath }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { migrated: legacy.length, removedPairs: pairs.size, backupPath };
}
