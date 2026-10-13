import { randomUUID } from 'node:crypto';
import { BrowserMediaError, browserArticlePlatform, sanitizeBrowserMediaDiagnostics, type BrowserArticleResult, type BrowserMediaErrorCode, type BrowserMediaResult } from '../shared/browser-media';

export interface BrowserMediaRequest {
  url: string;
  directory: string;
  cookiesPath?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export type BrowserMediaReader = (request: BrowserMediaRequest) => Promise<BrowserMediaResult>;
interface ParentPort {
  on(event: 'message', handler: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function articleResult(value: BrowserArticleResult): BrowserArticleResult | undefined {
  if (!['wechat', 'xiaohongshu'].includes(value.platform) || browserArticlePlatform(value.pageUrl) !== value.platform
    || value.acquiredBy !== 'browser' || typeof value.title !== 'string' || value.title.length > 4000
    || typeof value.text !== 'string' || value.text.length > 400_000 || typeof value.contentComplete !== 'boolean'
    || !Number.isSafeInteger(value.imageCount) || value.imageCount < 0 || value.imageCount > 100_000
    || !Array.isArray(value.images) || value.images.length > 24) return;
  const indices = new Set<number>();
  for (const image of value.images) {
    if (!image || !Number.isSafeInteger(image.index) || image.index < 1 || image.index > value.imageCount || indices.has(image.index)
      || (image.filePath !== undefined && (typeof image.filePath !== 'string' || image.filePath.length > 32_768))
      || (image.mimeType !== undefined && !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.mimeType))
      || (image.error !== undefined && typeof image.error !== 'string')) return;
    indices.add(image.index);
  }
  return {
    kind: 'article', platform: value.platform, pageUrl: value.pageUrl, acquiredBy: 'browser',
    title: value.title, text: value.text, contentComplete: value.contentComplete,
    author: typeof value.author === 'string' ? value.author.slice(0, 1000) : undefined,
    imageCount: value.imageCount,
    images: value.images.map(image => ({ index: image.index, filePath: image.filePath, mimeType: image.mimeType, error: image.error?.slice(0, 500) })),
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((item): item is string => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 500)) : undefined,
    diagnostics: sanitizeBrowserMediaDiagnostics(value.diagnostics),
  };
}

/** Private utility-process channel. It is never exposed as an agent or renderer tool. */
export function createBrowserMediaClient(parent: ParentPort): { read: BrowserMediaReader; close: () => void } {
  const requests = new Map<string, {
    finish: (error?: Error, result?: BrowserMediaResult) => void;
    progress?: (message: string) => void;
  }>();
  parent.on('message', event => {
    const message = event.data as { kind?: string; id?: string; message?: string; result?: BrowserMediaResult; error?: { code?: string; message?: string; diagnostics?: unknown } } | null;
    if (!message?.id) return;
    const request = requests.get(message.id);
    if (!request) return;
    if (message.kind === 'browser-media-progress' && typeof message.message === 'string') request.progress?.(message.message.slice(0, 500));
    if (message.kind === 'browser-media-response') {
      if (message.error) {
        const knownCodes: BrowserMediaErrorCode[] = ['unsupported', 'access', 'cookies', 'identity', 'request', 'download', 'partial', 'size', 'timeout', 'cancelled', 'busy'];
        const candidate = message.error.code?.replace(/^browser_/, '') as BrowserMediaErrorCode | undefined;
        const code: BrowserMediaErrorCode = candidate && knownCodes.includes(candidate) ? candidate : 'download';
        request.finish(new BrowserMediaError(code, typeof message.error.message === 'string' ? message.error.message : '[browser_failed] 浏览器获取未完成。', sanitizeBrowserMediaDiagnostics(message.error.diagnostics)));
      } else request.finish(undefined, message.result ? { ...message.result, diagnostics: sanitizeBrowserMediaDiagnostics(message.result.diagnostics) } : undefined);
    }
  });
  const read: BrowserMediaReader = request => new Promise((resolve, reject) => {
    request.signal?.throwIfAborted();
    const id = randomUUID();
    const cancel = () => {
      parent.postMessage({ kind: 'browser-media-cancel', id });
      finish(request.signal?.aborted ? new BrowserMediaError('cancelled', '任务已暂停，浏览器获取已取消。') : new BrowserMediaError('timeout', '浏览器获取超时，已停止；需要登录或验证的来源可以重新获取。'));
    };
    // Interactive article requests include time for the user to log in or complete the site's challenge.
    const timer = setTimeout(cancel, browserArticlePlatform(request.url) ? 15 * 60_000 : 5 * 60_000);
    const finish = (error?: Error, result?: BrowserMediaResult) => {
      if (!requests.delete(id)) return;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else if (result?.kind === 'article') {
        const article = articleResult(result);
        if (article) resolve(article);
        else reject(new BrowserMediaError('partial', '浏览器返回的文章数据不完整，未作为正文接收。'));
      }
      else if (result?.kind === 'note' && Array.isArray(result.images) && Number.isSafeInteger(result.imageCount) && result.imageCount >= 0) resolve(result);
      else if (result && result.kind !== 'note' && result.filePath && result.mimeType) resolve(result);
      else reject(new Error('[browser_failed] 浏览器没有返回可用媒体文件。'));
    };
    requests.set(id, { finish, progress: request.onProgress });
    request.signal?.addEventListener('abort', cancel, { once: true });
    parent.postMessage({ kind: 'browser-media-request', id, url: request.url, directory: request.directory, cookiesPath: request.cookiesPath });
  });
  return { read, close: () => {
    for (const [id, request] of requests) {
      parent.postMessage({ kind: 'browser-media-cancel', id });
      request.finish(new Error('本地服务正在关闭，浏览器获取已取消。'));
    }
  } };
}
