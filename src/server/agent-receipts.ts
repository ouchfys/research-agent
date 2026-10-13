import type { MaterialStage, RawMaterial } from '../shared/types.js';

export type MaterialReadDetail = 'content' | 'acquisition';
export interface MaterialReadOptions { offset?: number; detail?: MaterialReadDetail }
export const MATERIAL_PAGE_CHARACTERS = 18_000;

const STATUSES = new Set<MaterialStage['status']>(['ok', 'partial', 'failed', 'skipped']);
const META_BUDGET = 5_000;
const IMPORTANT_METADATA = [
  // Evidence boundaries and source identity precede optional descriptive metadata.
  'fullText', 'contentComplete', 'paperFormat', 'arxivId', 'requestedVersion', 'doi', 'paperId',
  'platform', 'bvid', 'aid', 'cid', 'part', 'parts', 'awemeId', 'noteType',
  'hasTranscript', 'subtitleComplete', 'subtitleClipped', 'subtitleLanguage',
  'subtitleFirstSeconds', 'subtitleLastSeconds', 'duration', 'durationSeconds', 'processedSeconds',
  'imageCount', 'recognizedImages', 'mathCount', 'tableCount', 'parser',
  'acquiredBy', 'recognitionImageSource', 'httpStatus', 'retryOf',
  'author', 'authors', 'limitations', 'description', 'submittedUrl',
] as const;

function resource(id: string, detail: MaterialReadDetail, offset = 0) {
  return { kind: 'material' as const, id, detail, offset };
}

/** UTF-16 offsets match the persisted JS string; continuation never splits a surrogate pair. */
function page(text: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('材料读取位置超出当前内容范围，请使用对应 detail 返回的 nextOffset。');
  const betweenSurrogates = (position: number) => position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position]);
  if (betweenSurrogates(offset)) throw new Error('材料读取位置位于字符内部，请使用返回的 nextOffset。');
  let end = Math.min(text.length, offset + MATERIAL_PAGE_CHARACTERS);
  if (betweenSurrogates(end)) end--;
  return { text: text.slice(offset, end), offset, totalCharacters: text.length, nextOffset: end < text.length ? end : null };
}

function preview(value: string, limit: number, field: string, reduced: Set<string>): string {
  if (value.length <= limit) return value;
  reduced.add(field);
  let end = limit;
  if (/[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
  return value.slice(0, end) + '…（完整字段见获取详情）';
}

function diagnostic(value: string, limit: number, field: string, reduced: Set<string>): string {
  // Files remain available in explicit acquisition detail, never as a callable resource path.
  const safe = value.replace(/\b[A-Za-z]:[\\/][^\r\n\s"'<>，；。]+/g, '[本地路径]');
  if (safe !== value) reduced.add(field + ':localPath');
  return preview(safe, limit, field, reduced);
}

function summaryValue(value: unknown, limit: number, field: string, reduced: Set<string>): unknown {
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return preview(value, limit, field, reduced);
  if (Array.isArray(value)) {
    const values: unknown[] = []; let remaining = limit;
    for (let index = 0; index < value.length; index++) {
      if (index >= 12 || remaining < 40) { reduced.add(field); break; }
      const item = summaryValue(value[index], Math.min(remaining, 240), field + '[' + index + ']', reduced);
      if (item === undefined) { reduced.add(field); continue; }
      values.push(item); remaining -= JSON.stringify(item).length;
    }
    return values;
  }
  // Do not serialize arbitrary nested metadata into the default receipt.
  if (value !== undefined) reduced.add(field);
  return undefined;
}

function sourceMetadata(raw: RawMaterial, reduced: Set<string>) {
  const stored = raw.metadata || {}, result: Record<string, unknown> = {};
  let size = 0;
  for (const key of IMPORTANT_METADATA) {
    if (stored[key] === undefined || (key === 'submittedUrl' && stored[key] === raw.url)) continue;
    const limit = key === 'description' ? 1_200 : key === 'limitations' || key === 'authors' ? 800 : key === 'submittedUrl' ? 2_000 : 240;
    // A cut URL is not a valid citation. Keep it only in the paginated original details.
    if (key === 'submittedUrl' && typeof stored[key] === 'string' && stored[key].length > limit) { reduced.add('metadata.' + key); continue; }
    const value = summaryValue(stored[key], limit, 'metadata.' + key, reduced);
    if (value === undefined) continue;
    const characters = key.length + JSON.stringify(value).length;
    if (size + characters > META_BUDGET) { reduced.add('metadata.' + key); continue; }
    result[key] = value; size += characters;
  }
  const mineru = stored.mineru;
  if (mineru && typeof mineru === 'object' && !Array.isArray(mineru)) {
    const details = mineru as Record<string, unknown>, brief: Record<string, unknown> = {};
    for (const key of ['model', 'pageCount', 'warnings']) {
      const value = summaryValue(details[key], key === 'warnings' ? 600 : 160, 'metadata.mineru.' + key, reduced);
      if (value !== undefined) brief[key] = value;
    }
    if (Object.keys(brief).length) result.mineru = brief;
    // The full parser file inventory is retained in acquisition details.
    if (Object.keys(details).some(key => !['model', 'pageCount', 'warnings'].includes(key))) reduced.add('metadata.mineru');
  }
  return { metadata: result, omittedMetadataFields: Object.keys(stored).filter(key => key !== 'stages' && !(key in result) && !['trust', 'instructionsAreData'].includes(key)).length };
}

function stageSummary(raw: RawMaterial, reduced: Set<string>) {
  const stages = Array.isArray(raw.metadata?.stages) ? raw.metadata.stages : [];
  const groups = new Map<string, { name: string; status: MaterialStage['status']; count: number }>();
  const failed: MaterialStage[] = [];
  const totals = { ok: 0, partial: 0, failed: 0, skipped: 0 };
  for (const stage of stages) {
    if (!stage || typeof stage.name !== 'string' || !STATUSES.has(stage.status)) continue;
    totals[stage.status]++;
    // Repeated frame/image slots carry a count, not 24 copies of the same successful phase.
    const name = preview(stage.name.replace(/[-_]\d+$/, ''), 70, 'stages.name', reduced), key = name + ':' + stage.status;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { name, status: stage.status, count: 1 });
    if (stage.status === 'failed') failed.push(stage);
  }
  const allGroups = [...groups.values()];
  const selectedGroups = allGroups.length <= 20 ? allGroups : [...allGroups.slice(0, 10), ...allGroups.slice(-10)];
  if (allGroups.length > selectedGroups.length) reduced.add('metadata.stages');
  const examples: Array<{ name: string; detail: string }> = [], seen = new Set<string>();
  // Retain recent failure causes; early failures may already have succeeded via a fallback.
  for (let index = failed.length - 1; index >= 0 && examples.length < 5; index--) {
    const item = failed[index], detail = diagnostic(typeof item.detail === 'string' ? item.detail : '', 240, 'stages.failures', reduced);
    const name = preview(item.name.replace(/[-_]\d+$/, ''), 70, 'stages.name', reduced), key = name + ':' + detail;
    if (!seen.has(key)) { seen.add(key); examples.push({ name, detail }); }
  }
  return { total: stages.length, ...totals, groups: selectedGroups, omittedGroups: allGroups.length - selectedGroups.length,
    failureExamples: examples.reverse(), failureExamplesAreExhaustive: failed.length === examples.length };
}

/** Small source/evidence header. All shortened fields remain recoverable through acquisition details. */
export function materialReceiptSummary(raw: RawMaterial) {
  const reduced = new Set<string>();
  const title = preview(raw.title, 600, 'title', reduced);
  const coverage = diagnostic(raw.coverage, 1_800, 'coverage', reduced);
  const error = raw.error ? diagnostic(raw.error, 480, 'error', reduced) : undefined;
  const url = raw.url && raw.url.length <= 4_000 ? raw.url : undefined;
  if (raw.url && !url) reduced.add('url');
  const metadata = sourceMetadata(raw, reduced), stages = stageSummary(raw, reduced);
  return { id: raw.id, title, kind: raw.kind, url, status: raw.status, coverage, error,
    mimeType: raw.mimeType, createdAt: raw.createdAt, metadata: metadata.metadata, stages,
    acquisitionSummary: { omittedMetadataFields: metadata.omittedMetadataFields, shortenedFields: [...reduced],
      detail: '这里只提供获取摘要；正文不在摘要中删减，省略字段和完整阶段记录可用 acquisitionDetails 分页读取。' },
    acquisitionDetails: resource(raw.id, 'acquisition') };
}

/**
 * This function does not acquire, rewrite, summarize or mark content as read.
 * Authorization and Store read tracking remain the caller's responsibility.
 * `content` and `acquisition` have independent offsets; refresh creates a new material ID.
 */
export function materialReadReceipt(raw: RawMaterial, options: MaterialReadOptions = {}) {
  const offset = options.offset ?? 0, detail = options.detail ?? 'content';
  if (detail !== 'content' && detail !== 'acquisition') throw new Error('材料 detail 只支持 content 或 acquisition。');
  if (detail === 'acquisition') {
    const { text: _body, ...acquisition } = raw;
    // Deliberately complete and lossless for stored JSON metadata. Large detail has recoverable pages.
    const serialized = JSON.stringify(acquisition, null, 2), current = page(serialized, offset);
    return { id: raw.id, detail, format: 'json_fragment' as const, ...current,
      resource: resource(raw.id, detail, offset),
      ...(offset === 0 ? { instructions: 'text 是完整来源获取记录 JSON 的一段；按 nextOffset 继续并顺序拼接可恢复全部字段。科研正文通过 content 单独读取，本地路径只是原件位置，不是工具可读资源。', contentResource: resource(raw.id, 'content') } : {}),
      trust: 'untrusted_source_data' as const };
  }
  const current = page(raw.text, offset);
  const header = offset === 0 ? materialReceiptSummary(raw) : { id: raw.id, status: raw.status,
    evidenceBoundary: { fullText: raw.metadata?.fullText, contentComplete: raw.metadata?.contentComplete },
    acquisitionDetails: resource(raw.id, 'acquisition') };
  return { ...header, detail, ...current, resource: resource(raw.id, detail, offset), trust: 'untrusted_source_data' as const };
}
