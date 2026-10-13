export interface BrowserMediaDiagnostic {
  stage: 'initialize' | 'url' | 'dns' | 'cookies' | 'request_headers' | 'connect' | 'response' | 'file_open' | 'stream' | 'file_write' | 'file_close' | 'file_rename';
  outcome: 'ok' | 'failed';
  candidateIndex?: number;
  audioOnly?: boolean;
  elapsedMs: number;
  bytesReceived: number;
  httpStatus?: number;
  errorName?: string;
  errorCode?: string;
  causeCode?: string;
  userAgentNormalized?: boolean;
}

/** Copy only the private diagnostic contract; never forward arbitrary error or network properties. */
export function sanitizeBrowserMediaDiagnostics(value: unknown): BrowserMediaDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const stages = new Set<BrowserMediaDiagnostic['stage']>(['initialize', 'url', 'dns', 'cookies', 'request_headers', 'connect', 'response', 'file_open', 'stream', 'file_write', 'file_close', 'file_rename']);
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const errorCode = (value: unknown): value is string => typeof value === 'string' && /^(?:[A-Z][A-Z0-9_]{0,79}|net::ERR_[A-Z0-9_]{1,64}|-\d{1,8})$/.test(value);
  const result: BrowserMediaDiagnostic[] = [];
  // Four video candidates may precede recognition of a gallery, followed by 24 image slots.
  for (const candidate of value.slice(0, 29)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    if (!stages.has(item.stage as BrowserMediaDiagnostic['stage']) || (item.outcome !== 'ok' && item.outcome !== 'failed') || !finite(item.elapsedMs) || !finite(item.bytesReceived)) continue;
    const diagnostic: BrowserMediaDiagnostic = {
      stage: item.stage as BrowserMediaDiagnostic['stage'], outcome: item.outcome as BrowserMediaDiagnostic['outcome'],
      elapsedMs: Math.min(Math.round(item.elapsedMs), 86_400_000), bytesReceived: Math.min(Math.round(item.bytesReceived), Number.MAX_SAFE_INTEGER),
    };
    if (typeof item.candidateIndex === 'number' && Number.isInteger(item.candidateIndex) && item.candidateIndex >= 1 && item.candidateIndex <= 24) diagnostic.candidateIndex = item.candidateIndex;
    if (typeof item.audioOnly === 'boolean') diagnostic.audioOnly = item.audioOnly;
    if (typeof item.httpStatus === 'number' && Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599) diagnostic.httpStatus = item.httpStatus;
    // The main-process helper already selects known error names/codes; these are shape checks, not another drifting allowlist.
    if (typeof item.errorName === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(item.errorName)) diagnostic.errorName = item.errorName;
    if (errorCode(item.errorCode)) diagnostic.errorCode = item.errorCode;
    if (errorCode(item.causeCode)) diagnostic.causeCode = item.causeCode;
    if (typeof item.userAgentNormalized === 'boolean') diagnostic.userAgentNormalized = item.userAgentNormalized;
    result.push(diagnostic);
  }
  return result;
}

export interface BrowserVideoResult {
  kind?: 'video';
  filePath: string;
  mimeType: string;
  pageUrl: string;
  acquiredBy: 'browser';
  audioOnly: boolean;
  diagnostics?: BrowserMediaDiagnostic[];
}

export interface BrowserNoteResult {
  kind: 'note';
  pageUrl: string;
  acquiredBy: 'browser';
  description?: string;
  author?: string;
  imageCount: number;
  images: Array<{ index: number; filePath?: string; mimeType?: string; error?: string }>;
  diagnostics?: BrowserMediaDiagnostic[];
}

/** Article data only: browser credentials and arbitrary page state never leave the main process. */
export interface BrowserArticleResult {
  kind: 'article';
  platform: 'wechat' | 'xiaohongshu';
  pageUrl: string;
  acquiredBy: 'browser';
  title: string;
  text: string;
  author?: string;
  imageCount: number;
  images: Array<{ index: number; filePath?: string; mimeType?: string; error?: string }>;
  /** Text extraction completeness; image coverage is recorded independently. */
  contentComplete: boolean;
  limitations?: string[];
  diagnostics?: BrowserMediaDiagnostic[];
}

export function browserArticlePlatform(value: string): BrowserArticleResult['platform'] | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
    if (url.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/[A-Za-z0-9_-]+)?\/?$/.test(url.pathname)) return 'wechat';
    if (['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{24}\/?$/i.test(url.pathname)) return 'xiaohongshu';
  } catch { /* Only supported public article links can enter the interactive browser. */ }
}

export type BrowserMediaResult = BrowserVideoResult | BrowserNoteResult | BrowserArticleResult;

export type BrowserMediaErrorCode = 'unsupported' | 'access' | 'cookies' | 'identity' | 'request' | 'download' | 'partial' | 'size' | 'timeout' | 'cancelled' | 'busy';

/** Messages are safe to persist: no cookie contents, signed media URLs or raw browser errors. */
export class BrowserMediaError extends Error {
  constructor(readonly code: BrowserMediaErrorCode, message: string, readonly diagnostics: BrowserMediaDiagnostic[] = []) {
    super(message);
    this.name = 'BrowserMediaError';
  }
}
