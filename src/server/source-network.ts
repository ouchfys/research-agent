import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as boundedFetch } from 'undici';
import { providerUsageRecorder, type ProviderUsageDescriptor } from './usage.js';

const AGENT = 'ResearchBookshelf/0.1 (+local personal research; manual requests)';
export interface Download { bytes: Buffer; url: string; mimeType: string; status: number }

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2))
      || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0)
      || (a === 100 && b >= 64 && b <= 127));
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    // Only global-unicast IPv6; exclude documentation and transition ranges.
    return /^[23]/.test(v) && !/^2001:(?:db8|0|10|20)(?=:)/.test(v) && !/^2002:/.test(v);
  }
  return false;
}

export async function validatePublicUrl(value: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('来源只接受无账号密码的 HTTP(S) URL。');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new Error('来源 URL 使用了不支持的端口。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('不能读取本机或私有网络来源。');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('来源域名解析超时。')), 10_000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('不能读取本机、保留地址或私有网络来源。');
  return { url, ...addresses[0] };
}

/** DNS is checked and pinned for every redirect. Untrusted sources cannot choose a local destination. */
type DownloadOptions = { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string>; allowHttpError?: boolean; signal?: AbortSignal };
export async function download(value: string, options: DownloadOptions = {}): Promise<Download> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await downloadOnce(value, options); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : '';
      if (attempt || !/fetch failed|timeout|timed out|aborted|HTTP (?:429|5\d\d)/i.test(message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
}

async function downloadOnce(value: string, options: DownloadOptions): Promise<Download> {
  let current = value;
  const limit = options.maxBytes ?? 12 * 1024 * 1024;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 35_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (let redirect = 0; redirect <= 6; redirect++) {
    signal.throwIfAborted();
    const target = await validatePublicUrl(current);
    signal.throwIfAborted();
    const dispatcher = new Agent({ connect: { timeout: 12_000, lookup: (_hostname, opts, cb) => {
      if (opts.all) cb(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    } } });
    try {
      const response = await boundedFetch(target.url, { dispatcher, signal, redirect: 'manual', headers: { 'user-agent': AGENT, accept: '*/*', ...options.headers } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('来源返回重定向，但没有目标地址。');
        current = new URL(location, target.url).href;
        continue;
      }
      if (!response.ok && !options.allowHttpError) { await response.body?.cancel(); throw new Error(`来源返回 HTTP ${response.status}（可能需要登录、已删除、限流或不可访问）。`); }
      if (Number(response.headers.get('content-length') || 0) > limit) { await response.body?.cancel(); throw new Error(`来源超过 ${Math.round(limit / 1024 / 1024)} MB 获取上限。`); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) throw new Error(`来源超过 ${Math.round(limit / 1024 / 1024)} MB 获取上限。`);
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      return { bytes: Buffer.concat(chunks), url: target.url.href, mimeType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), status: response.status };
    } finally { await dispatcher.close(); }
  }
  throw new Error('来源重定向次数超过 6 次。');
}

export async function publicJson(value: string, headers?: Record<string, string>): Promise<any> {
  const result = await download(value, { maxBytes: 8 * 1024 * 1024, headers });
  try { return JSON.parse(result.bytes.toString('utf8')); } catch { throw new Error('来源没有返回可解析的 JSON。'); }
}

export function endpoint(base: string, suffix: string): string {
  const normalized = base.replace(/\/+$/, ''), tail = suffix.replace(/^\/+/, '');
  const url = new URL(normalized.endsWith('/' + tail) ? normalized : normalized + '/' + tail);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务地址必须是无账号密码的 HTTP(S) URL。');
  return url.href;
}

/** Explicitly user-configured services may be local. Never follow redirects carrying API credentials. */
export async function providerRequest(url: string, init: RequestInit = {}, usageDescriptor?: ProviderUsageDescriptor): Promise<any> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('服务地址必须是 HTTP(S) URL。');
  const timeout = AbortSignal.timeout(120_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  init.signal?.throwIfAborted();
  const usage = usageDescriptor ? providerUsageRecorder({ ...usageDescriptor, baseUrl: url }) : undefined;
  let errorCode = 'network_error';
  try {
    let response: Response;
    try { response = await fetch(target, { ...init, signal, redirect: 'error' }); }
    catch (error) {
      errorCode = init.signal?.aborted ? 'cancelled' : signal.aborted ? 'timeout' : 'network_error';
      throw new Error(init.signal?.aborted ? '服务请求已取消。' : error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? '服务请求超时，请检查网络、模型和服务区域。' : '无法连接已配置的服务，请检查服务地址、网络和证书。');
    }
    if (!response.ok) { errorCode = `http_${response.status}`; await response.body?.cancel(); throw new Error(`已配置服务返回 HTTP ${response.status}；请检查密钥、区域、模型权限或配额。`); }
    errorCode = 'response_read_error';
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 8 * 1024 * 1024) { errorCode = 'response_too_large'; await reader.cancel(); throw new Error('服务响应超过 8 MB 上限。'); }
      chunks.push(part.value);
    }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { errorCode = 'invalid_json'; throw new Error('已配置服务没有返回可解析的 JSON。'); }
    usage?.success(result); return result;
  } catch (error) { usage?.error(init.signal?.aborted ? 'cancelled' : signal.aborted ? 'timeout' : errorCode); throw error; }
}
