import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiUsageRecord, UsageGroupSummary, UsagePurpose, UsageSummary, UsageTotals } from '../shared/usage.js';

export type UsageSink = (record: ApiUsageRecord) => void;
export interface UsageConfig { provider?: string; baseUrl?: string; model?: string }
export interface ProviderUsageDescriptor extends UsageConfig { purpose: UsagePurpose; model: string }
const storage = new AsyncLocalStorage<UsageSink>();
export function withUsage<T>(sink: UsageSink, work: () => Promise<T>): Promise<T> { return storage.run(sink, work); }

const PRICING_VERSION = '2026-10-06';
const DEEPSEEK_PRICE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const QWEN_ASR_PRICE = 'https://help.aliyun.com/zh/model-studio/qwen3-asr-flash';
type ObjectData = Record<string, any>;
function object(value: unknown): ObjectData { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {}; }
function quantity(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function firstNumber(...values: unknown[]): number | undefined { for (const value of values) { const number = quantity(value); if (number !== undefined) return number; } }
function safeLabel(value: unknown, fallback: string): string { return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : fallback; }
function hostname(baseUrl?: string): string { try { return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ''; } catch { return ''; } }
function providerName(config: UsageConfig): string {
  const host = hostname(config.baseUrl);
  if (host) return host === 'api.deepseek.com' ? 'deepseek' : /(?:^|\.)aliyuncs\.com$/.test(host) ? 'aliyun'
    : /(?:^|\.)mineru\.net$/.test(host) ? 'mineru' : 'custom';
  return safeLabel(config.provider, 'unknown');
}
function emit(sink: UsageSink | undefined, record: ApiUsageRecord): void {
  // A failed ledger write must not cause the already-completed model request to be repeated.
  try { sink?.(record); } catch { /* Persistence policy belongs to the supplied sink. */ }
}
function addUnknown(record: ApiUsageRecord, reason: string): void { if (!record.unknownReasons.includes(reason)) record.unknownReasons.push(reason); }

function providerQuantities(response: unknown, purpose: UsagePurpose): Partial<ApiUsageRecord> {
  const result = object(response), usage = object(result.usage), details = object(usage.prompt_tokens_details);
  const outputTokens = firstNumber(usage.completion_tokens, usage.output_tokens);
  let inputTokens = quantity(usage.prompt_tokens);
  let cacheReadTokens = firstNumber(usage.prompt_cache_hit_tokens, details.cached_tokens, usage.cached_tokens, usage.cache_read_input_tokens);
  const cacheWriteTokens = firstNumber(details.cache_write_tokens, usage.cache_creation_input_tokens);
  let cacheMissTokens = quantity(usage.prompt_cache_miss_tokens);
  if (inputTokens === undefined && quantity(usage.input_tokens) !== undefined) {
    // Anthropic input_tokens excludes cache reads/writes, unlike OpenAI prompt_tokens.
    cacheMissTokens = quantity(usage.input_tokens);
    inputTokens = cacheMissTokens! + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  }
  if (inputTokens === undefined && cacheReadTokens !== undefined && cacheMissTokens !== undefined) inputTokens = cacheReadTokens + cacheMissTokens + (cacheWriteTokens ?? 0);
  if (cacheReadTokens === undefined && inputTokens !== undefined && cacheMissTokens !== undefined && inputTokens >= cacheMissTokens + (cacheWriteTokens ?? 0)) cacheReadTokens = inputTokens - cacheMissTokens - (cacheWriteTokens ?? 0);
  if (cacheMissTokens === undefined && inputTokens !== undefined && cacheReadTokens !== undefined && inputTokens >= cacheReadTokens + (cacheWriteTokens ?? 0)) cacheMissTokens = inputTokens - cacheReadTokens - (cacheWriteTokens ?? 0);
  const audioSeconds = purpose === 'asr' ? firstNumber(usage.seconds, usage.audio_seconds, usage.duration, result.duration) : undefined;
  const usageReported = [inputTokens, outputTokens, cacheReadTokens, cacheMissTokens, audioSeconds].some(value => value !== undefined);
  return { inputTokens, outputTokens, cacheReadTokens, cacheMissTokens, cacheWriteTokens, audioSeconds, usageReported };
}

function estimate(record: ApiUsageRecord, config: UsageConfig): ApiUsageRecord {
  const host = hostname(config.baseUrl);
  if (!record.usageReported) addUnknown(record, 'usage_missing');
  if (record.status === 'error' && !record.usageReported) addUnknown(record, 'failed_request_charge_unknown');
  if (record.purpose === 'search') addUnknown(record, 'search_service_price_unknown');
  // A custom gateway may bill differently even when its model string matches an official model.
  const officialDeepSeek = record.provider === 'deepseek' && (!host || host === 'api.deepseek.com');
  const pro = record.model === 'deepseek-v4-pro';
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(record.model);
  if (officialDeepSeek && (pro || flash) && record.purpose !== 'asr') {
    record.pricingVersion = PRICING_VERSION; record.pricingSources = [DEEPSEEK_PRICE];
    const effectiveAt = Date.parse(pro ? '2026-08-16T16:00:00Z' : '2026-09-10T04:00:00Z');
    if (Date.parse(record.startedAt) < effectiveAt) { addUnknown(record, 'historical_price_unavailable'); return record; }
    // Official off-peak / peak rates in CNY per million tokens. No holiday-calendar guess.
    const hit = pro ? 0.15 : 0.02, miss = pro ? 4.5 : 1, output = pro ? 13.5 : 4;
    let min = 0, max = 0, priced = false;
    if (record.inputTokens !== undefined) {
      const total = record.inputTokens, read = record.cacheReadTokens, uncached = record.cacheMissTokens, write = record.cacheWriteTokens ?? 0;
      if (read !== undefined && uncached !== undefined && read + uncached + write === total) {
        min += (read * hit + uncached * miss) / 1_000_000;
        max += (read * hit + uncached * miss) * 2 / 1_000_000;
        if (write) addUnknown(record, 'cache_write_price_unknown');
      } else {
        // Known total, unknown cache distribution: include both extremes instead of inventing hits.
        min += total * hit / 1_000_000; max += total * miss * 2 / 1_000_000;
        addUnknown(record, 'cache_breakdown_missing');
      }
      priced = true;
    } else addUnknown(record, 'input_usage_missing');
    if (record.outputTokens !== undefined) {
      min += record.outputTokens * output / 1_000_000; max += record.outputTokens * output * 2 / 1_000_000; priced = true;
    } else addUnknown(record, 'output_usage_missing');
    if (priced && record.usageReported) { record.estimatedMinCny = min; record.estimatedMaxCny = max; }
    return record;
  }
  const qwenAsr = /^(?:qwen3-asr-flash|qwen3-asr-flash-2025-09-08|qwen3-asr-flash-2026-02-10)$/.test(record.model);
  if (record.provider === 'aliyun' && record.purpose === 'asr' && qwenAsr) {
    record.pricingVersion = PRICING_VERSION; record.pricingSources = [QWEN_ASR_PRICE];
    const rate = host === 'dashscope.aliyuncs.com' || /\.cn-beijing\.maas\.aliyuncs\.com$/.test(host) ? 0.00022
      : host === 'dashscope-intl.aliyuncs.com' || /\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(host) ? 0.00026 : undefined;
    if (rate === undefined) addUnknown(record, 'region_price_unknown');
    if (record.audioSeconds === undefined) addUnknown(record, 'audio_duration_missing');
    if (rate !== undefined && record.audioSeconds !== undefined) {
      // Published list price; promotional/free quotas and actual balance deductions are not observable here.
      record.estimatedMinCny = record.audioSeconds * rate; record.estimatedMaxCny = record.audioSeconds * rate;
    }
    return record;
  }
  addUnknown(record, 'model_price_unknown');
  return record;
}

/** One recorder per physical fetch. Calling success/error twice never writes two records. */
export function providerUsageRecorder(config: ProviderUsageDescriptor): { success(response: unknown): void; error(code: string): void } {
  const sink = storage.getStore(), id = randomUUID(), startedAt = new Date().toISOString();
  let recorded = false;
  const finish = (status: ApiUsageRecord['status'], response?: unknown, errorCode?: string) => {
    if (recorded) return; recorded = true;
    const quantities = providerQuantities(response, config.purpose);
    const record: ApiUsageRecord = { id, source: 'provider', purpose: config.purpose, provider: providerName(config), model: safeLabel(config.model, 'unknown'),
      startedAt, createdAt: new Date().toISOString(), status, usageReported: false, ...quantities, unknownReasons: [],
      ...(config.purpose === 'parsing' ? { notes: ['MinerU 解析提交记录，不代表解析完成或实际扣费；后续轮询不重复计量。'] } : {}),
      ...(errorCode ? { errorCode: safeLabel(errorCode, 'request_error') } : {}) };
    emit(sink, estimate(record, config));
  };
  return {
    success(response) {
      const result = object(response), failed = result.type === 'error' || !!result.error || (config.purpose === 'parsing' && result.code !== 0);
      finish(failed ? 'error' : 'ok', response, failed ? 'provider_error' : undefined);
    },
    error(code) { finish('error', undefined, code); },
  };
}

/** Pure conversion also supports recovering old Pi message records without replaying a request. */
export function piUsageRecord(message: unknown, purpose: UsagePurpose = 'agent', config: UsageConfig = {}, options: { aggregated?: boolean } = {}): ApiUsageRecord {
  const item = object(message), usage = object(item.usage), selected = { ...config, provider: config.provider ?? item.provider, model: config.model ?? item.model };
  const provider = providerName(selected), model = safeLabel(selected.model, 'unknown');
  const timestamp = quantity(item.timestamp), date = timestamp === undefined ? new Date() : new Date(timestamp);
  const createdAt = Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  const stableId = typeof item.responseId === 'string' && item.responseId ? item.responseId : timestamp === undefined ? randomUUID()
    : `${timestamp}:${safeLabel(item.provider, 'unknown')}:${safeLabel(item.model, 'unknown')}`;
  const id = 'pi-' + createHash('sha256').update(`${purpose}:${stableId}`).digest('hex');
  const input = quantity(usage.input), outputTokens = quantity(usage.output), cacheReadTokens = quantity(usage.cacheRead), cacheWriteTokens = quantity(usage.cacheWrite);
  // Pi input is uncached input. Cost is intentionally ignored: app model presets historically store zeros.
  const inputTokens = input === undefined ? undefined : input + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  // Pi initializes usage to zeros before receiving an API response; those placeholders are not free usage.
  const usageReported = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(value => value !== undefined && value > 0);
  const status = item.stopReason === 'error' || item.stopReason === 'aborted' ? 'error' : 'ok';
  const record: ApiUsageRecord = { id, source: 'pi', purpose, provider, model, startedAt: createdAt, createdAt, status, usageReported, unknownReasons: [],
    ...(usageReported ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheMissTokens: input } : {}),
    ...(purpose === 'compaction' ? options.aggregated === false
      ? { aggregated: false, notes: ['上下文整理的一次实际模型请求，未重复计入压缩汇总。'] }
      : { aggregated: true, notes: ['Pi 原生压缩用量可能汇总多个请求；调用记录数不等于物理请求数。'] } : {}),
    ...(status === 'error' ? { errorCode: item.stopReason === 'aborted' ? 'pi_aborted' : 'pi_error' } : {}) };
  return estimate(record, selected);
}
export function recordPiUsage(message: unknown, purpose: UsagePurpose = 'agent', config: UsageConfig = {}, options: { aggregated?: boolean } = {}): ApiUsageRecord {
  const record = piUsageRecord(message, purpose, config, options); emit(storage.getStore(), record); return record;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, cacheWriteTokens: 0,
    audioSeconds: 0, estimatedMinCny: 0, estimatedMaxCny: 0, unknownRequests: 0, hasUnknown: false };
}
function addTotals(total: UsageTotals, item: ApiUsageRecord): void {
  total.requests++; item.status === 'ok' ? total.successfulRequests++ : total.failedRequests++;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheMissTokens', 'cacheWriteTokens', 'audioSeconds', 'estimatedMinCny', 'estimatedMaxCny'] as const) total[key] += quantity(item[key]) ?? 0;
  if (item.unknownReasons.length || item.estimatedMinCny === undefined || item.estimatedMaxCny === undefined) { total.unknownRequests++; total.hasUnknown = true; }
}
export function summarizeUsage(records: readonly ApiUsageRecord[]): UsageSummary {
  const summary: UsageSummary = { ...emptyTotals(), groups: [] }, groups = new Map<string, UsageGroupSummary>();
  // A replayed message or ledger restoration must not inflate counts; latest copy wins.
  for (const item of new Map(records.map(record => [record.id, record])).values()) {
    addTotals(summary, item);
    const key = JSON.stringify([item.purpose, item.provider, item.model]);
    let group = groups.get(key);
    if (!group) { group = { ...emptyTotals(), purpose: item.purpose, provider: item.provider, model: item.model }; groups.set(key, group); }
    addTotals(group, item);
  }
  summary.groups = [...groups.values()]; return summary;
}
