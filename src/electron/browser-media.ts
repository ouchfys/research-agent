import { BrowserWindow, session, type Session } from 'electron';
import { createServer, createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Agent, Headers, fetch as pinnedFetch } from 'undici';
import { validatePublicUrl } from '../server/source-network';
import { BrowserMediaError, type BrowserMediaDiagnostic, type BrowserMediaResult, type BrowserNoteResult, type BrowserVideoResult } from '../shared/browser-media';
import { allowedBrowserUrl, candidatesFromState, noteFromState, pageSnapshot, parsePageState, targetKind, type MediaCandidate, type NoteCandidate } from './browser-media-data';
import { browserUserAgent, formatBrowserDiagnostic, safeBrowserError } from './browser-media-diagnostics';

export interface BrowserMediaOptions {
  url: string;
  /** The main process validates this existing per-source directory before calling. */
  directory: string;
  cookiesPath?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}
const MAX_MEDIA = 512 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_STATE = 8 * 1024 * 1024;

function abortError(external?: AbortSignal, phase = '浏览器媒体获取'): BrowserMediaError {
  return external?.aborted ? new BrowserMediaError('cancelled', '浏览器媒体获取已取消。') : new BrowserMediaError('timeout', `${phase}超时，未返回不完整文件。`);
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Every Chromium connection is DNS-validated and pinned, not just its URL preflight. */
export async function startPinnedProxy(signal: AbortSignal, allowUrl: (value: string) => URL | undefined = allowedBrowserUrl): Promise<{ port: number; close(): void }> {
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    if (signal.aborted || sockets.size >= 128) { client.destroy(); return; }
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.once('close', () => sockets.delete(client));
    client.setTimeout(8000, () => client.destroy());
    let received = Buffer.alloc(0), handled = false;
    const receive = (part: Buffer) => {
      if (handled) return;
      received = Buffer.concat([received, part]);
      const end = received.indexOf('\r\n\r\n');
      if (received.length > 8192 || (end < 0 && received.length >= 8192)) { client.destroy(); return; }
      if (end < 0) return;
      handled = true; client.removeListener('data', receive); client.pause();
      const first = received.subarray(0, end).toString('ascii').split('\r\n')[0];
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/i.exec(first);
      const allowed = match && allowUrl('https://' + match[1] + '/');
      if (!allowed) { client.destroy(); return; }
      const remaining = received.subarray(end + 4);
      void bounded(validatePublicUrl(allowed.href), signal).then(target => {
        if (client.destroyed || signal.aborted) return;
        const upstream = createConnection({ host: target.address, family: target.family, port: 443 });
        sockets.add(upstream);
        upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
        client.once('close', () => upstream.destroy());
        upstream.on('error', () => { upstream.destroy(); client.destroy(); });
        upstream.setTimeout(15_000, () => upstream.destroy());
        upstream.once('connect', () => {
          if (client.destroyed || signal.aborted) { upstream.destroy(); return; }
          client.setTimeout(30_000); upstream.setTimeout(30_000);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (remaining.length) upstream.write(remaining);
          client.pipe(upstream); upstream.pipe(client); client.resume();
        });
      }).catch(() => client.destroy());
    };
    client.on('data', receive);
  });
  const close = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); server.close(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); server.on('error', () => close()); resolve(); });
    }), signal);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('proxy');
    return { port: address.port, close: () => { signal.removeEventListener('abort', close); close(); } };
  } catch (error) { signal.removeEventListener('abort', close); close(); throw error; }
}

/** Only an explicitly selected Netscape file is read; external browser profiles are never opened. */
async function importCookies(ses: Session, filePath: string, signal: AbortSignal): Promise<void> {
  if (!isAbsolute(filePath)) throw new BrowserMediaError('cookies', 'Cookies 文件必须是手动配置的本地绝对路径。');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(filePath, 'r');
    const info = await file.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('size');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      signal.throwIfAborted();
      const part = await file.read(buffer, count, buffer.length - count, count);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    if (count > 2 * 1024 * 1024) throw new Error('size');
    const text = buffer.subarray(0, count).toString('utf8');
    if (!/^#\s*(?:Netscape HTTP Cookie File|HTTP Cookie File)/m.test(text)) throw new Error('format');
    let imported = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      const fields = line.replace(/^#HttpOnly_/, '').split('\t');
      if (fields.length !== 7) continue;
      const [rawDomain, includeSubdomains, path, secure, expires, name, value] = fields;
      const domain = rawDomain.replace(/^\./, '').toLowerCase();
      if (domain !== 'douyin.com' && !domain.endsWith('.douyin.com')) continue;
      if (!/^[a-z0-9.-]+$/.test(domain) || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || /[\x00-\x20\x7f;]/.test(value) || !path.startsWith('/') || /[\r\n]/.test(path)) continue;
      const expirationDate = Number(expires);
      if (!Number.isFinite(expirationDate) || (expirationDate > 0 && expirationDate <= Date.now() / 1000)) continue;
      signal.throwIfAborted();
      await bounded(ses.cookies.set({
        url: 'https://' + domain + path, name, value, path,
        ...(includeSubdomains === 'TRUE' ? { domain: '.' + domain } : {}),
        secure: secure === 'TRUE', httpOnly: line.startsWith('#HttpOnly_'),
        ...(expirationDate > 0 ? { expirationDate } : {}),
      }), signal);
      if (++imported > 2000) throw new Error('count');
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof BrowserMediaError) throw error;
    throw new BrowserMediaError('cookies', '无法读取所配置的 Netscape Cookies 文件，或文件超过 2 MB；请检查后重试。');
  } finally { await file?.close(); }
}

function mediaFormat(head: Buffer, mime: string, audioHint: boolean): { mimeType: string; extension: string; audioOnly: boolean } | undefined {
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    const brand = head.toString('ascii', 8, 12);
    const audioOnly = audioHint || mime.startsWith('audio/') || /M4A |M4B |F4A /i.test(brand);
    return { mimeType: audioOnly ? 'audio/mp4' : 'video/mp4', extension: audioOnly ? '.m4a' : '.mp4', audioOnly };
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { mimeType: audioHint || mime.startsWith('audio/') ? 'audio/webm' : 'video/webm', extension: '.webm', audioOnly: audioHint || mime.startsWith('audio/') };
  if (head.subarray(0, 4).toString('ascii') === 'OggS') return { mimeType: 'audio/ogg', extension: '.ogg', audioOnly: true };
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') return { mimeType: 'audio/flac', extension: '.flac', audioOnly: true };
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return { mimeType: 'audio/wav', extension: '.wav', audioOnly: true };
  if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { mimeType: 'audio/mpeg', extension: '.mp3', audioOnly: true };
}

function imageFormat(head: Buffer, mime: string): { mimeType: string; extension: string; audioOnly: false } | undefined {
  let format: { mimeType: string; extension: string } | undefined;
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) format = { mimeType: 'image/jpeg', extension: '.jpg' };
  else if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) format = { mimeType: 'image/png', extension: '.png' };
  else if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') format = { mimeType: 'image/webp', extension: '.webp' };
  else if (/^GIF8[79]a$/.test(head.toString('ascii', 0, 6))) format = { mimeType: 'image/gif', extension: '.gif' };
  if (!format) return;
  const declared = mime === 'image/jpg' || mime === 'image/pjpeg' ? 'image/jpeg' : mime === 'image/x-png' ? 'image/png' : mime;
  if (declared && declared !== 'application/octet-stream' && declared !== format.mimeType) return;
  return { ...format, audioOnly: false };
}

/** Full GET with the isolated session's current cookies; headers are rebuilt on every redirect. */
export async function downloadCandidate(candidate: MediaCandidate, ses: Session, options: BrowserMediaOptions, pageUrl: string, signal: AbortSignal, diagnostic: BrowserMediaDiagnostic, image = false, allowUrl: (value: string) => URL | undefined = allowedBrowserUrl): Promise<Pick<BrowserVideoResult, 'filePath' | 'mimeType' | 'audioOnly'>> {
  let current = candidate.url;
  const stem = join(options.directory, (image ? 'browser-image-' : 'browser-media-') + randomUUID()), partialPath = stem + '.part';
  const maximum = image ? MAX_IMAGE : MAX_MEDIA, sizeMessage = image ? '作品图片超过 10 MB 获取上限。' : '作品媒体超过 512 MB 获取上限。';
  const formatFor = (head: Buffer, mime: string) => image ? imageFormat(head, mime) : mediaFormat(head, mime, candidate.audioOnly);
  let completed = false;
  try {
    for (let hop = 0; hop <= 6; hop++) {
      diagnostic.stage = 'url';
      delete diagnostic.httpStatus;
      signal.throwIfAborted();
      const allowed = allowUrl(current);
      if (!allowed) throw new BrowserMediaError('access', '媒体跳转到了不支持的网络地址，浏览器获取已停止。');
      diagnostic.stage = 'dns';
      const target = await bounded(validatePublicUrl(allowed.href), signal);
      diagnostic.stage = 'connect';
      const dispatcher = new Agent({ connect: { timeout: 12_000, lookup: (_hostname, opts, cb) => {
        if (opts.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      } } });
      try {
        diagnostic.stage = 'cookies';
        const cookies = await bounded(ses.cookies.get({ url: target.url.href }), signal);
        const cookieHeader = cookies.filter(cookie => !/[\x00-\x20\x7f;]/.test(cookie.name + cookie.value)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
        if (cookieHeader.length > 65_536) throw new BrowserMediaError('cookies', '当前站点 Cookies 过大，无法安全获取媒体。');
        diagnostic.stage = 'request_headers';
        const userAgent = ses.getUserAgent();
        if (!userAgent || /[^\x20-\x7e]/.test(userAgent)) throw new BrowserMediaError('request', '浏览器标识包含无效请求头字符；未发送媒体请求。');
        if (/[^\x20-\xff]/.test(cookieHeader)) throw new BrowserMediaError('request', '平台会话 Cookies 包含下载器不支持的请求头字符；未发送媒体请求。');
        // Construct headers separately so a conversion failure cannot be reported as a network failure.
        const headers = new Headers({
          'user-agent': userAgent, accept: '*/*', 'accept-encoding': 'identity', referer: pageUrl,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        });
        diagnostic.stage = 'connect';
        const response = await pinnedFetch(target.url, { dispatcher, signal, redirect: 'manual', headers });
        diagnostic.stage = 'response';
        diagnostic.httpStatus = response.status;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location) throw new BrowserMediaError('download', '媒体返回了无法跟随的跳转。');
          current = new URL(location, target.url).href;
          continue;
        }
        if (response.status !== 200 && response.status !== 206) { await response.body?.cancel(); throw new BrowserMediaError('access', `作品媒体返回 HTTP ${response.status}；未取得完整媒体，不能据此断言需要登录。`); }
        const contentLength = response.headers.get('content-length');
        let expected = contentLength === null ? undefined : Number(contentLength);
        if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0)) throw new BrowserMediaError('partial', '媒体返回了无效的完整长度，未保存为成功结果。');
        const range = response.headers.get('content-range');
        if (response.status === 206) {
          const full = range?.match(/^bytes 0-(\d+)\/(\d+)$/i);
          if (!full || !Number.isSafeInteger(Number(full[2])) || Number(full[1]) + 1 !== Number(full[2]) || (expected !== undefined && expected !== Number(full[2]))) throw new BrowserMediaError('partial', '浏览器只取得媒体片段，未将分段响应当作完整文件。');
          expected = Number(full[2]);
        } else if (range) throw new BrowserMediaError('partial', '媒体响应包含不明确的分段范围，未保存为成功结果。');
        if (expected !== undefined && expected > maximum) throw new BrowserMediaError('size', sizeMessage);
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const encoding = response.headers.get('content-encoding');
        if (/text\/|json|html|mpegurl|dash\+xml/.test(mime) || (encoding && encoding !== 'identity')) throw new BrowserMediaError('download', '媒体地址返回了页面、播放清单或不支持的内容。');
        if (!response.body) throw new BrowserMediaError('download', '媒体响应为空。');
        diagnostic.stage = 'file_open';
        const file = await open(partialPath, 'wx');
        let size = 0, head = Buffer.alloc(0);
        let failed = false;
        try {
          diagnostic.stage = 'stream';
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            size += chunk.byteLength;
            diagnostic.bytesReceived = size;
            diagnostic.stage = 'response';
            if (size > maximum) throw new BrowserMediaError('size', sizeMessage);
            if (head.length < 4096) head = Buffer.concat([head, Buffer.from(chunk).subarray(0, 4096 - head.length)]);
            if (head.length >= 12 && !formatFor(head, mime)) throw new BrowserMediaError('download', image ? '图片响应的数据签名或内容类型不匹配，未保存为图片。' : '媒体响应不是可识别的完整音视频文件。');
            diagnostic.stage = 'file_write';
            await file.writeFile(chunk);
            diagnostic.stage = 'stream';
          }
          signal.throwIfAborted();
          diagnostic.stage = 'response';
          if (!size || (expected !== undefined && size !== expected)) throw new BrowserMediaError('partial', '媒体下载长度不完整，已丢弃临时文件。');
        } catch (error) { failed = true; throw error; }
        finally {
          // A close failure must not replace the original stream/write failure.
          if (failed) await file.close().catch(() => undefined);
          else { diagnostic.stage = 'file_close'; await file.close(); }
        }
        diagnostic.stage = 'response';
        const format = formatFor(head, mime);
        if (!format) throw new BrowserMediaError('download', image ? '未取得可识别的 JPEG、PNG、WebP 或 GIF 图片。' : '未取得可识别的音视频文件。');
        const filePath = stem + format.extension;
        diagnostic.stage = 'file_rename';
        await rename(partialPath, filePath); completed = true;
        return { filePath, mimeType: format.mimeType, audioOnly: format.audioOnly };
      } finally { await dispatcher.destroy().catch(() => undefined); }
    }
    throw new BrowserMediaError('download', '媒体跳转次数超过获取上限。');
  } finally { if (!completed) await unlink(partialPath).catch(() => undefined); }
}

async function downloadNoteImages(note: NoteCandidate, ses: Session, options: BrowserMediaOptions, pageUrl: string, signal: AbortSignal, deadline: number, diagnostics: BrowserMediaDiagnostic[], userAgentNormalized: boolean): Promise<BrowserNoteResult> {
  const images: BrowserNoteResult['images'] = [];
  const progress = (message: string) => { try { options.onProgress?.(message); } catch { /* Progress cannot interrupt acquisition. */ } };
  for (const image of note.images.slice(0, 24)) {
    if (options.signal?.aborted) throw abortError(options.signal);
    if (signal.aborted || Date.now() >= deadline) break;
    const started = Date.now();
    const diagnostic: BrowserMediaDiagnostic = { stage: 'url', outcome: 'failed', candidateIndex: image.index, elapsedMs: 0, bytesReceived: 0, userAgentNormalized };
    diagnostics.push(diagnostic);
    const remaining = note.images.length - images.length;
    const budget = Math.max(1, Math.min(25_000, Math.floor((deadline - Date.now() - 1000) / remaining)));
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
    progress(`正在下载图文作品第 ${image.index}/${note.imageCount} 张图片。`);
    try {
      const url = image.urls[0];
      if (!url) throw new BrowserMediaError('identity', '目标作品的这一图片位置没有可访问的图片地址，保留原序号。');
      const result = await downloadCandidate({ url, audioOnly: false, priority: 0 }, ses, options, pageUrl, attemptSignal, diagnostic, true);
      if (options.signal?.aborted) throw abortError(options.signal);
      diagnostic.outcome = 'ok'; diagnostic.elapsedMs = Date.now() - started;
      images.push({ index: image.index, filePath: result.filePath, mimeType: result.mimeType });
    } catch (error) {
      diagnostic.elapsedMs = Date.now() - started;
      Object.assign(diagnostic, safeBrowserError(error));
      if (options.signal?.aborted) throw new BrowserMediaError('cancelled', '浏览器图文获取已取消。', diagnostics);
      const failure = error instanceof BrowserMediaError ? error : attemptSignal.aborted ? new BrowserMediaError('timeout', '此图片下载超时，未保存不完整文件。')
        : new BrowserMediaError(diagnostic.stage === 'request_headers' ? 'request' : 'download', '此图片获取失败，未保存为完整图片。');
      // candidateIndex identifies an image here; omit the formatter's video/audio candidate label.
      const message = `第 ${image.index} 张图片：${failure.message} ${formatBrowserDiagnostic({ ...diagnostic, candidateIndex: undefined })}`;
      images.push({ index: image.index, error: message });
      progress(message);
      if (signal.aborted || failure.code === 'request') break;
    }
  }
  const saved = images.filter(image => image.filePath).length;
  progress(`浏览器图文获取完成：已保存 ${saved} 张图片，目标列表共 ${note.imageCount} 张；后续按实际保存范围识别。`);
  return { kind: 'note', pageUrl, acquiredBy: 'browser', description: note.description, author: note.author, imageCount: note.imageCount, images, diagnostics };
}

export async function acquireBrowserMedia(options: BrowserMediaOptions): Promise<BrowserMediaResult> {
  let requested: URL;
  try { requested = new URL(options.url); } catch { throw new BrowserMediaError('unsupported', '浏览器媒体获取只支持抖音作品的完整视频或图文链接。'); }
  const workPath = requested.pathname.match(/^\/(video|note)\/(\d{8,30})\/?$/), identity = workPath?.[2];
  if (requested.protocol !== 'https:' || requested.hostname !== 'www.douyin.com' || requested.username || requested.password || requested.port || !identity) throw new BrowserMediaError('unsupported', '浏览器媒体获取目前只支持 www.douyin.com/video/作品编号 或 www.douyin.com/note/作品编号。');
  if (!isAbsolute(options.directory)) throw new BrowserMediaError('download', '媒体保存位置无效。');
  const pageUrl = 'https://www.douyin.com/' + workPath![1] + '/' + identity;
  const matchesWork = (url: URL) => url.hostname === 'www.douyin.com' && [ '/video/' + identity, '/note/' + identity ].includes(url.pathname.replace(/\/$/, ''));
  const started = Date.now(), deadline = started + 180_000, timeout = AbortSignal.timeout(180_000), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const diagnostics: BrowserMediaDiagnostic[] = [];
  let userAgentNormalized = false;
  let ses: Session | undefined, window: BrowserWindow | undefined, proxy: Awaited<ReturnType<typeof startPinnedProxy>> | undefined;
  let phase = '初始化浏览器环境';
  const progress = (message: string) => { try { options.onProgress?.(message); } catch { /* Progress cannot prevent cleanup. */ } };
  const step = async <T>(name: string, work: (stepSignal: AbortSignal) => Promise<T>, limitMs = 15_000): Promise<T> => {
    phase = name;
    progress(`正在${name}。`);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limitMs);
    const stepSignal = AbortSignal.any([signal, controller.signal]);
    try { return await bounded(work(stepSignal), stepSignal); }
    catch (error) {
      if (signal.aborted) throw abortError(options.signal, phase);
      if (controller.signal.aborted) throw new BrowserMediaError('timeout', `${name}超过 ${limitMs / 1000} 秒，已停止；这不是平台要求登录的证据。`);
      throw error;
    } finally { clearTimeout(timer); }
  };
  const destroyWindow = () => { if (window && !window.isDestroyed()) window.destroy(); };
  signal.addEventListener('abort', destroyWindow, { once: true });
  try {
    signal.throwIfAborted();
    proxy = await step('创建浏览器隔离网络', stepSignal => startPinnedProxy(stepSignal));
    ses = session.fromPartition('research-shelf-media-' + randomUUID(), { cache: false });
    // Electron puts productName in its default UA. A Chinese productName cannot be
    // passed through Undici's ByteString headers. Use the same ASCII UA in both paths.
    const originalUserAgent = ses.getUserAgent(), userAgent = browserUserAgent(originalUserAgent);
    userAgentNormalized = originalUserAgent !== userAgent;
    ses.setUserAgent(userAgent);
    await step('配置浏览器网络连接', () => ses!.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:' + proxy!.port, proxyBypassRules: '<-loopback>' }));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = allowedBrowserUrl(details.url);
      const main = details.resourceType === 'mainFrame';
      callback({ cancel: signal.aborted || !url || ['webSocket', 'object'].includes(details.resourceType) || (main && !matchesWork(url)) });
    });
    if (options.cookiesPath) await step('导入已配置的平台 Cookies', stepSignal => importCookies(ses!, options.cookiesPath!, stepSignal));
    phase = '创建浏览器页面';
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
      disableDialogs: true,
    } });
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('login', (event, _responseDetails, _authInfo, callback) => { event.preventDefault(); callback(); });
    const allowNavigation = (event: Electron.Event, value: string) => {
      const url = allowedBrowserUrl(value);
      if (!url || !matchesWork(url)) event.preventDefault();
    };
    contents.on('will-navigate', allowNavigation); contents.on('will-redirect', allowNavigation);
    contents.on('will-frame-navigate', event => {
      if (!allowedBrowserUrl(event.url)) event.preventDefault();
    });
    contents.once('did-start-loading', () => progress('浏览器已开始加载目标作品页。'));
    contents.once('did-finish-load', () => progress('浏览器页面加载完成，正在核对作品数据与媒体地址。'));
    contents.on('did-navigate', (_event, _url, httpResponseCode) => {
      if (Number.isInteger(httpResponseCode) && httpResponseCode > 0) progress(`浏览器主页面返回 HTTP ${httpResponseCode}；这还不代表已取得媒体。`);
    });
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (!signal.aborted && isMainFrame && errorCode !== -3) progress(`浏览器主页面加载失败（网络错误码 ${errorCode}），继续检查已取得的作品数据。`);
    });
    const candidates = new Map<string, MediaCandidate>();
    const keep = (items: MediaCandidate[]) => {
      for (const item of items) {
        if (!allowedBrowserUrl(item.url) || candidates.size >= 64) continue;
        const previous = candidates.get(item.url);
        if (!previous || previous.priority < item.priority) candidates.set(item.url, item);
      }
    };
    const requests = new Set<string>(), pendingBodies = new Set<Promise<void>>();
    let bodyCount = 0, challenge = false, confirmedVideo = false, confirmedNote = false;
    let note: NoteCandidate | undefined, noteUpdatedAt = 0;
    const stateCandidates = (state: unknown) => {
      const kind = targetKind(state, identity);
      confirmedNote ||= kind === 'note'; confirmedVideo ||= kind === 'video';
      const found = noteFromState(state, identity);
      if (found) {
        confirmedNote = true;
        if (!note || found.imageCount > note.imageCount || (found.imageCount === note.imageCount && found.images.filter(image => image.urls.length).length > note.images.filter(image => image.urls.length).length)) {
          note = { ...found, description: found.description || note?.description, author: found.author || note?.author };
          noteUpdatedAt = Date.now();
        } else note = { ...note, description: note.description || found.description, author: note.author || found.author };
      }
      if (!confirmedNote) keep(candidatesFromState(state, identity));
    };
    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_event, method: string, params: Record<string, any>) => {
      if (signal.aborted || contents.isDestroyed()) return;
      if (method === 'Network.responseReceived' && bodyCount < 40) {
        const response = params.response;
        const url = response && allowedBrowserUrl(String(response.url || ''));
        if (url && /(?:^|\.)douyin\.com$/.test(url.hostname) && /aweme|detail|feed/i.test(url.pathname) && /json/i.test(String(response.mimeType)) && Number(response.status) === 200 && Number(response.headers?.['content-length'] || 0) <= MAX_STATE) requests.add(String(params.requestId));
      }
      if (method === 'Network.loadingFailed') requests.delete(String(params.requestId));
      if (method === 'Network.loadingFinished' && requests.delete(String(params.requestId)) && Number(params.encodedDataLength) <= MAX_STATE && bodyCount++ < 40) {
        const operation = bounded(contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }), signal).then(result => {
          if (signal.aborted || typeof result.body !== 'string' || result.body.length > MAX_STATE * 1.4) return;
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          stateCandidates(parsePageState(body));
        }).catch(() => undefined);
        pendingBodies.add(operation); void operation.finally(() => pendingBodies.delete(operation));
      }
    });
    await step('启动作品页面与网络监听', stepSignal => {
      // Electron can defer a CDP response until the target's first navigation. Queue the
      // listener first, then START navigation before awaiting its readiness.
      const listening = bounded(contents.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 24 * 1024 * 1024, maxResourceBufferSize: MAX_STATE }), stepSignal);
      void contents.loadURL(pageUrl).catch(() => undefined);
      return listening;
    }, 20_000);
    phase = '加载页面并发现作品媒体';
    progress('浏览器网络监听已就绪，正在查找属于该作品的媒体。');
    const discoveryDeadline = Date.now() + 65_000;
    let firstFound = 0;
    while (Date.now() < discoveryDeadline && !contents.isDestroyed()) {
      signal.throwIfAborted();
      try {
        const snapshot = await bounded(contents.executeJavaScript('(' + pageSnapshot.toString() + ')(' + JSON.stringify(identity) + ')', false), AbortSignal.any([signal, AbortSignal.timeout(4000)])) as ReturnType<typeof pageSnapshot>;
        if (snapshot && Array.isArray(snapshot.states)) for (const state of snapshot.states.slice(0, 320)) if (typeof state === 'string') stateCandidates(parsePageState(state));
        // A linked audio element alone could be a gallery soundtrack. The exact-ID state
        // must additionally confirm a video work before DOM addresses become candidates.
        if (confirmedVideo && !confirmedNote && snapshot && Array.isArray(snapshot.media)) keep(snapshot.media.slice(0, 60).filter(item => typeof item.url === 'string').map(item => ({ url: item.url, audioOnly: item.audioOnly === true, priority: item.audioOnly ? 60 : 110 })));
        challenge ||= snapshot?.challenge === true;
      } catch { /* Navigation can replace the execution context; the next snapshot retries. */ }
      if (confirmedNote) {
        if (note?.imageCount && Date.now() - noteUpdatedAt >= 2500) break;
      } else {
        if (candidates.size && !firstFound) firstFound = Date.now();
        if (firstFound && Date.now() - firstFound >= 2500) break;
      }
      await delay(900, signal);
    }
    // Consume already captured exact-work responses before deciding between a video and a gallery.
    if (pendingBodies.size) await bounded(Promise.allSettled([...pendingBodies]), AbortSignal.any([signal, AbortSignal.timeout(3000)])).catch(() => undefined);
    signal.throwIfAborted();
    const acquireNote = async () => {
      contents.stop();
      if (!note?.images.length) {
        progress('已确认目标作品为图文，但尚未取得图片列表；保留已获取的描述。');
        diagnostics.push({ stage: 'response', outcome: 'failed', elapsedMs: Date.now() - started, bytesReceived: 0, userAgentNormalized });
      }
      return downloadNoteImages(note || { imageCount: 0, images: [] }, ses!, options, 'https://www.douyin.com/note/' + identity, signal, deadline, diagnostics, userAgentNormalized);
    };
    if (confirmedNote) return await acquireNote();
    if (!candidates.size) throw new BrowserMediaError(challenge ? 'access' : 'identity', challenge ? '抖音页面要求登录或验证，当前浏览器未取得此作品的媒体；可配置手动导出的 Cookies 或导入本地文件。' : '浏览器未找到能确认属于此作品的音视频地址；未使用推荐作品或背景音乐代替。');
    contents.stop();
    progress('已确认作品媒体地址，正在下载完整文件。');
    let lastError: BrowserMediaError | undefined;
    const ordered = [...candidates.values()].sort((left, right) => right.priority - left.priority);
    const videos = ordered.filter(item => !item.audioOnly).slice(0, 2), audios = ordered.filter(item => item.audioOnly).slice(0, 2);
    // Reserve an early attempt and time budget for a complete audio-only rendition.
    const attempts = [videos[0], audios[0], videos[1], audios[1]].filter((item): item is MediaCandidate => !!item);
    for (let index = 0; index < attempts.length; index++) {
      const candidate = attempts[index];
      signal.throwIfAborted();
      if (confirmedNote) return await acquireNote();
      phase = `下载作品${candidate.audioOnly ? '音轨' : '视频'}（候选 ${index + 1}/${attempts.length}）`;
      progress(`正在${phase}。`);
      const attemptStarted = Date.now();
      const diagnostic: BrowserMediaDiagnostic = { stage: 'url', outcome: 'failed', candidateIndex: index + 1, audioOnly: candidate.audioOnly, elapsedMs: 0, bytesReceived: 0, userAgentNormalized };
      diagnostics.push(diagnostic);
      const budget = Math.max(1, Math.min(90_000, Math.floor((deadline - Date.now() - 1000) / (attempts.length - index))));
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
      try {
        const result = await downloadCandidate(candidate, ses, options, pageUrl, attemptSignal, diagnostic);
        if (confirmedNote) { await unlink(result.filePath).catch(() => undefined); return await acquireNote(); }
        signal.throwIfAborted();
        diagnostic.outcome = 'ok';
        diagnostic.elapsedMs = Date.now() - attemptStarted;
        progress(result.audioOnly ? '浏览器已取得此作品的完整音轨，将继续语音转写。' : '浏览器已取得此作品的完整视频，将继续转写和画面识别。');
        return { ...result, kind: 'video', pageUrl, acquiredBy: 'browser', diagnostics };
      } catch (error) {
        diagnostic.elapsedMs = Date.now() - attemptStarted;
        Object.assign(diagnostic, safeBrowserError(error));
        const failure = error instanceof BrowserMediaError ? error : attemptSignal.aborted ? abortError(options.signal, phase)
          : new BrowserMediaError(diagnostic.stage === 'request_headers' ? 'request' : 'download', '媒体获取发生异常，未取得完整文件。');
        lastError = new BrowserMediaError(failure.code, `${failure.message} ${formatBrowserDiagnostic(diagnostic)}`, diagnostics);
        if (!signal.aborted) progress(`${phase}失败：${lastError.message}`);
        // Retrying another address cannot repair invalid headers or a confirmed gallery.
        if (failure.code === 'request' || failure.code === 'unsupported') break;
      }
    }
    if (lastError instanceof BrowserMediaError) throw lastError;
    throw new BrowserMediaError('download', '已发现作品媒体地址，但未取得完整文件；发现地址不能证明媒体可下载。', diagnostics);
  } catch (error) {
    if (!diagnostics.length) diagnostics.push({ stage: 'initialize', outcome: 'failed', elapsedMs: Date.now() - started, bytesReceived: 0, userAgentNormalized, ...safeBrowserError(error) });
    const failure = signal.aborted ? abortError(options.signal, phase) : error instanceof BrowserMediaError ? error
      : new BrowserMediaError('access', `${phase}失败，浏览器未返回作品媒体；不能据此判断作品是否要求登录。 ${formatBrowserDiagnostic(diagnostics[diagnostics.length - 1])}`);
    throw new BrowserMediaError(failure.code, failure.message, diagnostics);
  } finally {
    signal.removeEventListener('abort', destroyWindow);
    if (window && !window.isDestroyed()) { if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach(); window.destroy(); }
    proxy?.close();
    if (ses) {
      ses.webRequest.onBeforeRequest(null);
      await bounded(Promise.allSettled([ses.closeAllConnections(), ses.clearCache(), ses.clearStorageData()]), AbortSignal.timeout(4000)).catch(() => undefined);
    }
  }
}
