/** Quantities come from provider responses. Prices are estimates, never a billing statement. */
export type UsagePurpose = 'agent' | 'compaction' | 'vision' | 'asr' | 'search' | 'parsing';

export interface ApiUsageRecord {
  id: string;
  source: 'pi' | 'provider';
  purpose: UsagePurpose;
  provider: string;
  model: string;
  startedAt: string;
  createdAt: string;
  status: 'ok' | 'error';
  /** Total input, including cached input. Cache fields are subsets, not additional input. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
  audioSeconds?: number;
  usageReported: boolean;
  /** Known component subtotal; absent if no component can be priced. */
  estimatedMinCny?: number;
  estimatedMaxCny?: number;
  unknownReasons: string[];
  pricingVersion?: string;
  pricingSources?: string[];
  errorCode?: string;
  /** Native compaction can combine multiple API requests into one usage event. */
  aggregated?: boolean;
  notes?: string[];
}

export interface UsageTotals {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  audioSeconds: number;
  /** Sum of known components only. Show unknownRequests/hasUnknown alongside this range. */
  estimatedMinCny: number;
  estimatedMaxCny: number;
  unknownRequests: number;
  hasUnknown: boolean;
}
export interface UsageGroupSummary extends UsageTotals {
  purpose: UsagePurpose;
  provider: string;
  model: string;
}
export interface UsageSummary extends UsageTotals { groups: UsageGroupSummary[] }
