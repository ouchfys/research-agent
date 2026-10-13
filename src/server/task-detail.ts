import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ResearchTurn, TaskDetail, TurnPublication } from '../shared/types.js';
import type { ApiUsageRecord } from '../shared/usage.js';
import type { Store } from './store.js';
import { piUsageRecord, summarizeUsage } from './usage.js';

const sessionCache = new Map<string, { stamp: string; records: ApiUsageRecord[]; incomplete: boolean }>();

// Historical sessions contain real text usage, but never recorded all media or
// search requests. Read them without rewriting the original Pi history.
function historicalUsage(store: Store, sessionFile?: string) {
  if (!sessionFile) return { records: [] as ApiUsageRecord[], incomplete: false };
  try {
    const rel = relative(resolve(store.dataDir, 'sessions'), resolve(sessionFile));
    if (rel.startsWith('..') || isAbsolute(rel)) return { records: [], incomplete: true };
    const info = statSync(sessionFile), stamp = `${info.mtimeMs}:${info.size}`;
    const cached = sessionCache.get(sessionFile); if (cached?.stamp === stamp) return cached;
    const records: ApiUsageRecord[] = [];
    let incomplete = false, lastModel = 'unknown';
    for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line), message = entry.message;
        if (entry.type === 'model_change') lastModel = String(entry.modelId || 'unknown');
        if (message?.role === 'assistant' && message.usage) {
          const model = String(message.model || 'unknown');
          lastModel = model;
          // The old "shelf-text" alias did not preserve its billing endpoint.
          // A familiar model name alone cannot prove which supplier charged it.
          records.push(piUsageRecord(message, 'agent', { provider: 'custom', model, baseUrl: '' }));
        }
        if (entry.type === 'compaction' && entry.details?.shelfPrefixCompaction === 1) {
          // This compaction already records each physical request. Recover those
          // same IDs, never add the native aggregate as another billed request.
          if (!Array.isArray(entry.details.usageRecords)) incomplete = true;
          else for (const usageMessage of entry.details.usageRecords) {
            if (!usageMessage || typeof usageMessage.responseId !== 'string' || !usageMessage.responseId || !Number.isFinite(usageMessage.timestamp)) { incomplete = true; continue; }
            records.push(piUsageRecord(usageMessage, 'compaction', {
              provider: 'custom', model: String(usageMessage.model || lastModel), baseUrl: '',
            }, { aggregated: false }));
          }
        } else if (entry.type === 'compaction' && entry.usage) records.push(piUsageRecord({
          provider: 'shelf-text', model: lastModel, usage: entry.usage, timestamp: Date.parse(entry.timestamp),
          responseId: `compaction:${entry.id}`, stopReason: 'stop',
        }, 'compaction', { provider: 'custom', model: lastModel, baseUrl: '' }));
      } catch { incomplete = true; }
    }
    const value = { stamp, records, incomplete }; sessionCache.set(sessionFile, value);
    if (sessionCache.size > 12) sessionCache.delete(sessionCache.keys().next().value!);
    return value;
  } catch { return { records: [], incomplete: true }; }
}

export function taskDetail(store: Store, taskId: string): TaskDetail {
  const task = store.task(taskId), messages = store.messages(taskId), events = store.events(taskId);
  const drafts = store.drafts(taskId), sources = store.raws(taskId), inputs = store.taskInputs(taskId);
  const saved = store.turns(taskId), savedByUser = new Map(saved.map(turn => [turn.userMessageId, turn]));
  const users = messages.filter(message => message.role === 'user');
  const turns: ResearchTurn[] = users.map(user => savedByUser.get(user.id) || {
    id: user.id, taskId, userMessageId: user.id, startedAt: user.createdAt,
    elapsedMs: 0, status: 'completed', legacy: true, usageHistoryIncomplete: true,
    inputs: [], publications: [],
  });
  for (const turn of saved) if (!turn.userMessageId || !users.some(user => user.id === turn.userMessageId)) turns.push(turn);
  if (!turns.length && (messages.length || events.length)) turns.push({ id: `legacy-${taskId}`, taskId, startedAt: task.createdAt, elapsedMs: 0, status: task.status, legacy: true, usageHistoryIncomplete: true, inputs: [], publications: [] });
  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const at = (stamp: string) => [...turns].reverse().find(turn => turn.startedAt <= stamp) || turns[0];
  const assignedMessages = messages.map(message => ({ ...message, turnId: byId.has(message.turnId || '') ? message.turnId : at(message.createdAt)?.id }));
  const assignedEvents = events.map(event => ({ ...event, turnId: byId.has(event.turnId || '') ? event.turnId : at(event.createdAt)?.id }));
  const storedIds = new Set(saved.map(turn => turn.id));
  // Legacy boundaries are reconstructed from actual activity timestamps. They
  // cannot exclude pauses precisely, so the UI labels those durations "约".
  for (const turn of turns) if (!storedIds.has(turn.id)) {
    const activity = [...assignedMessages, ...assignedEvents].filter(item => item.turnId === turn.id).map(item => item.createdAt).sort();
    turn.finishedAt = activity.at(-1) || turn.startedAt;
    turn.elapsedMs = Math.max(0, Date.parse(turn.finishedAt) - Date.parse(turn.startedAt));
    turn.status = turn === turns.at(-1) ? task.status : 'completed';
    turn.inputs = inputs.filter(input => at(input.updatedAt)?.id === turn.id);
    const publications = new Map<string, TurnPublication>();
    for (const event of assignedEvents) {
      if (event.turnId !== turn.id || !['published', '已发布'].includes(event.stage)) continue;
      const detail = event.detail as { documentId?: string; version?: number; draftId?: string } | undefined;
      if (!detail?.documentId || !detail.version) continue;
      const draft = drafts.find(item => item.id === detail.documentId);
      const title = draft?.title || event.message.replace(/^已发布：/, '').replace(/^《|》v\d+ 已发布。$/g, '');
      publications.set(`${detail.documentId}:${detail.version}`, { id: detail.documentId, version: detail.version, title, draftId: detail.draftId });
    }
    turn.publications = [...publications.values()];
  }
  const ledger = store.usages(taskId), historical = historicalUsage(store, task.sessionFile);
  const recorded = new Set(ledger.map(record => record.id));
  for (const turn of turns) {
    const recovered = historical.records.filter(record => !recorded.has(record.id) && at(record.createdAt)?.id === turn.id);
    turn.usage = summarizeUsage([...ledger.filter(record => record.turnId === turn.id), ...recovered]);
    if (recovered.length || (historical.incomplete && turn.legacy)) turn.usageHistoryIncomplete = true;
  }
  return { task, messages: assignedMessages, events: assignedEvents, scans: store.scans(taskId), drafts, sources, inputs, turns, conflicts: store.conflicts().filter(conflict => conflict.taskId === taskId) };
}
