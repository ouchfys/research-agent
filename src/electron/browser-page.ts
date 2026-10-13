import { BrowserWindow, Menu, session, type Session } from 'electron';
import { isAbsolute } from 'node:path';
import { BrowserMediaError, browserArticlePlatform, type BrowserArticleResult, type BrowserMediaDiagnostic } from '../shared/browser-media';
import { downloadCandidate, startPinnedProxy, type BrowserMediaOptions } from './browser-media';
import { browserUserAgent, safeBrowserError } from './browser-media-diagnostics';
import { articleSnapshotScript, type ArticleSnapshot } from './browser-page-data';

type Platform = BrowserArticleResult['platform'];
const TOTAL_BUDGET = 14 * 60_000 + 45_000;
const VALIDATION_BUDGET = 10 * 60_000;
const queues = new Map<Platform, Promise<void>>();
// Native session mutations cannot be interrupted. A cancelled owner may return,
// but the next owner must wait for late mutations before reusing its partition.
const sessionOperations = new Map<Platform, Set<Promise<unknown>>>();
function sessionOperation<T>(platform: Platform, work: Promise<T>): Promise<T> {
  let pending = sessionOperations.get(platform);
  if (!pending) { pending = new Set(); sessionOperations.set(platform, pending); }
  pending.add(work);
  const done = () => { pending!.delete(work); if (!pending!.size && sessionOperations.get(platform) === pending) sessionOperations.delete(platform); };
  void work.then(done, done);
  return work;
}
const NETWORK_ROOTS: Record<Platform, string[]> = {
  wechat: ['weixin.qq.com', 'wx.qq.com', 'qpic.cn', 'qlogo.cn', 'gtimg.com', 'captcha.qq.com', 'captcha.qcloud.com', 'ptlogin2.qq.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com', 'xhscdn.net', 'xhsimg.com', 'xhslink.com'],
};

function allowedPageUrl(platform: Platform, value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (value.length > 16_384 || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
    if (!NETWORK_ROOTS[platform].some(root => url.hostname === root || url.hostname.endsWith('.' + root))) return;
    return url;
  } catch { return; }
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
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Cancellation releases a queued slot without ever overlapping a live platform session. */
async function withPlatformQueue<T>(platform: Platform, signal: AbortSignal, waiting: () => void, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(platform) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  const queued = queues.has(platform);
  queues.set(platform, tail);
  void tail.then(() => { if (queues.get(platform) === tail) queues.delete(platform); });
  try {
    if (queued) waiting();
    await bounded(previous, signal);
    signal.throwIfAborted();
    return await work();
  } finally { release(); }
}

function articleIdentity(url: URL): string | undefined {
  if (url.hostname !== 'mp.weixin.qq.com') return;
  const slug = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if (slug) return 'slug:' + slug;
  if (url.pathname !== '/s' && url.pathname !== '/s/') return;
  const biz = url.searchParams.get('__biz'), mid = url.searchParams.get('mid'), index = url.searchParams.get('idx');
  if (biz && mid && index) return JSON.stringify([biz, mid, index]);
}
function authenticationUrl(platform: Platform, url: URL): boolean {
  if (platform === 'wechat') return url.hostname === 'open.weixin.qq.com'
    || /(?:^|\.)(?:captcha\.qq\.com|captcha\.qcloud\.com|ptlogin2\.qq\.com)$/.test(url.hostname)
    || (url.hostname === 'mp.weixin.qq.com' && /^\/(?:mp\/(?:wappoc_appmsgcaptcha|verify|appmsgcaptcha|appmsg\/verify)|cgi-bin\/(?:login|bizlogin|readtemplate))\b/i.test(url.pathname));
  return /(?:^|\.)xiaohongshu\.com$/.test(url.hostname) && /^\/(?:login|signin|auth|captcha|verify|website-login)(?:\/|$)/i.test(url.pathname);
}

export async function acquireBrowserPage(options: BrowserMediaOptions): Promise<BrowserArticleResult> {
  const platform = browserArticlePlatform(options.url);
  if (!platform) throw new BrowserMediaError('unsupported', '浏览器文章获取只支持微信公众号文章和带明确笔记编号的小红书链接。');
  if (!isAbsolute(options.directory)) throw new BrowserMediaError('download', '文章保存位置无效。');
  const requested = new URL(options.url);
  const noteId = platform === 'xiaohongshu' ? requested.pathname.match(/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase() : undefined;
  const initialIdentity = platform === 'wechat' ? articleIdentity(requested) : noteId;
  if (!initialIdentity) throw new BrowserMediaError('identity', '文章链接缺少可核对的目标编号，请提供完整文章或笔记链接。');
  const started = Date.now(), deadline = started + TOTAL_BUDGET;
  const budget = AbortSignal.timeout(TOTAL_BUDGET);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const progress = (message: string) => { try { options.onProgress?.(message); } catch { /* Status delivery cannot cancel cleanup. */ } };
  try {
    return await withPlatformQueue(platform, signal, () => progress('正在等待同平台的浏览器获取完成；暂停任务可取消等待。'), () => acquirePage(platform, requested, initialIdentity, noteId, options, signal, deadline, progress));
  } catch (error) {
    if (options.signal?.aborted) throw new BrowserMediaError('cancelled', '浏览器文章获取已取消。');
    if (signal.aborted) throw new BrowserMediaError('timeout', '浏览器文章获取超过总等待时间，已停止；已保存的来源保持不变。');
    if (error instanceof BrowserMediaError) throw error;
    throw new BrowserMediaError('access', '浏览器文章获取失败，未返回登录页或其他文章作为正文。');
  }
}

async function acquirePage(platform: Platform, requested: URL, initialIdentity: string, noteId: string | undefined, options: BrowserMediaOptions, outerSignal: AbortSignal, deadline: number, progress: (message: string) => void): Promise<BrowserArticleResult> {
  const allowUrl = (value: string) => allowedPageUrl(platform, value);
  const closed = new AbortController(), lifecycle = new AbortController(), signal = AbortSignal.any([outerSignal, closed.signal, lifecycle.signal]);
  const identities = new Set([initialIdentity]);
  const targetUrl = (url: URL) => platform === 'wechat' ? !!articleIdentity(url) && identities.has(articleIdentity(url)!)
    : ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname) && url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase() === noteId;
  const loginLanding = (url: URL) => platform === 'wechat' ? url.pathname === '/' && url.hostname === 'mp.weixin.qq.com'
    : ['/', '/explore', '/explore/'].includes(url.pathname) && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname);
  const allowedMain = (url: URL) => targetUrl(url) || authenticationUrl(platform, url) || loginLanding(url);
  let ses: Session | undefined, window: BrowserWindow | undefined, proxy: Awaited<ReturnType<typeof startPinnedProxy>> | undefined;
  let closing = false, shownAt = 0, phase = '初始化浏览器';
  const diagnostics: BrowserMediaDiagnostic[] = [];
  const preventDownload = (event: Electron.Event) => event.preventDefault();
  const destroyWindow = () => {
    closing = true;
    if (window && !window.isDestroyed()) window.destroy();
  };
  signal.addEventListener('abort', destroyWindow, { once: true });
  const step = async <T>(work: (stepSignal: AbortSignal) => Promise<T>, milliseconds = 20_000) => {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), milliseconds);
    const stepSignal = AbortSignal.any([signal, timeout.signal]);
    try { return await bounded(work(stepSignal), stepSignal); }
    catch (error) {
      if (!signal.aborted && timeout.signal.aborted) throw new BrowserMediaError('timeout', `${phase}超时，当前获取已停止。`);
      throw error;
    } finally { clearTimeout(timer); }
  };
  try {
    signal.throwIfAborted();
    const priorOperations = sessionOperations.get(platform);
    if (priorOperations?.size) await bounded(Promise.allSettled([...priorOperations]), signal);
    signal.throwIfAborted();
    progress('正在使用隔离浏览器加载目标文章。');
    proxy = await step(stepSignal => startPinnedProxy(stepSignal, allowUrl));
    ses = session.fromPartition('persist:research-shelf-page-' + platform, { cache: false });
    // Login remains inside this platform's Chromium partition; no external profile is read.
    ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', preventDownload);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = allowUrl(details.url);
      callback({ cancel: signal.aborted || !url || ['webSocket', 'object'].includes(details.resourceType) || (details.resourceType === 'mainFrame' && !allowedMain(url)) });
    });
    // A short WeChat /s/token can redirect to its query-form identity. Only follow
    // an observed response from an already accepted article, never a clicked article.
    ses.webRequest.onBeforeRedirect(details => {
      if (platform !== 'wechat' || details.resourceType !== 'mainFrame' || identities.size >= 8) return;
      const from = allowUrl(details.url), to = allowUrl(details.redirectURL);
      if (!from || !to || !targetUrl(from) || !articleIdentity(from)?.startsWith('slug:')) return;
      const identity = articleIdentity(to);
      if (identity && !identity.startsWith('slug:')) identities.add(identity);
    });
    await step(() => sessionOperation(platform, ses!.closeAllConnections()));
    await step(() => sessionOperation(platform, ses!.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:' + proxy!.port, proxyBypassRules: '<-loopback>' })));
    window = new BrowserWindow({ show: false, width: 1100, height: 820, title: platform === 'wechat' ? '微信公众号文章' : '小红书笔记', webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      backgroundThrottling: false, disableDialogs: true, autoplayPolicy: 'user-gesture-required',
    } });
    window.on('closed', () => { if (!closing) closed.abort(new BrowserMediaError('cancelled', '你已关闭文章浏览器窗口，本次获取已取消。')); });
    const contents = window.webContents;
    const openOriginal = () => {
      if (signal.aborted || contents.isDestroyed()) return;
      progress('正在重新打开本次提交的原文章，继续检查正文。');
      void contents.loadURL(requested.href).catch(() => undefined);
    };
    window.setMenu(Menu.buildFromTemplate([{ label: '文章', submenu: [{ label: '重新打开原文章', click: openOriginal }, { type: 'separator' }, { label: '取消本次获取', role: 'close' }] }]));
    contents.setAudioMuted(true);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(details => {
      const url = allowUrl(details.url);
      if (url && authenticationUrl(platform, url) && !signal.aborted) void contents.loadURL(url.href).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback(); });
    const navigation = (event: Electron.Event, value: string) => {
      const url = allowUrl(value);
      if (!url || !allowedMain(url)) event.preventDefault();
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('will-frame-navigate', event => {
      const url = allowUrl(event.url);
      if (!url || (event.isMainFrame && !allowedMain(url))) event.preventDefault();
    });
    const show = () => {
      if (shownAt || window!.isDestroyed()) return;
      shownAt = Date.now();
      window!.show(); window!.focus();
      progress('请在弹出的窗口完成登录或验证，完成后自动继续；关闭窗口取消本次获取。');
    };
    phase = '加载目标正文';
    const discoveryStarted = Date.now();
    void contents.loadURL(requested.href).catch(() => undefined);
    let lastFingerprint = '', stableSince = 0, result: ArticleSnapshot | undefined, restoredAt = 0, restores = 0;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (shownAt && Date.now() - shownAt >= VALIDATION_BUDGET) throw new BrowserMediaError('timeout', '等待登录或验证超过 10 分钟，尚未取得目标正文，本次获取已停止。');
      if (!shownAt && Date.now() - discoveryStarted >= 90_000) throw new BrowserMediaError('timeout', '自动加载文章超过 90 秒，尚未取得目标正文。');
      let snapshot: ArticleSnapshot | undefined;
      try {
        snapshot = await step(() => contents.executeJavaScript(articleSnapshotScript(platform, noteId), false), 4000) as ArticleSnapshot;
      } catch { /* Navigation may replace the execution context. Retry within the same bounded acquisition. */ }
      signal.throwIfAborted();
      const currentUrl = snapshot && allowUrl(snapshot.pageUrl);
      const matched = !!currentUrl && targetUrl(currentUrl) && snapshot?.matched === true;
      if (matched && snapshot) {
        // Accept a canonical identity only when it was read in the already matched short article.
        const canonical = snapshot.canonical && allowUrl(snapshot.canonical);
        if (platform === 'wechat' && initialIdentity.startsWith('slug:') && canonical) {
          const identity = articleIdentity(canonical);
          if (identity && !identity.startsWith('slug:')) identities.add(identity);
        }
        const useful = snapshot.text.trim().length > 0 || snapshot.images.some(image => image.url);
        if (useful && !snapshot.challenge) {
          const fingerprint = JSON.stringify([snapshot.title, snapshot.text, snapshot.imageCount, snapshot.images]);
          if (!stableSince || fingerprint !== lastFingerprint) { lastFingerprint = fingerprint; stableSince = Date.now(); }
          result = snapshot;
          if (Date.now() - stableSince >= 2500) break;
        } else { result = undefined; stableSince = 0; }
      } else { result = undefined; stableSince = 0; }
      if (snapshot?.unavailable && !snapshot.challenge && !result && Date.now() - discoveryStarted > 3000) throw new BrowserMediaError('access', '目标页面显示内容已删除或当前无法查看，未取得正文。');
      if (snapshot?.challenge || (!result && Date.now() - discoveryStarted >= 6000)) show();
      // A completed login may leave the window on its login landing page. Return
      // only to the user's original URL, with no automated login or CAPTCHA action.
      if (shownAt && currentUrl && !targetUrl(currentUrl) && !snapshot?.challenge && (loginLanding(currentUrl) || snapshot?.loginCompleted) && restores < 2 && Date.now() - shownAt > 2500 && Date.now() - restoredAt > 10_000) {
        restoredAt = Date.now(); restores++;
        openOriginal();
      }
      await delay(850, signal);
    }
    if (!result) throw new BrowserMediaError('identity', '浏览器没有取得能确认属于目标文章的正文或配图，未使用推荐内容代替。');
    signal.throwIfAborted();
    const finalUrl = allowUrl(result.pageUrl);
    if (!finalUrl || !targetUrl(finalUrl)) throw new BrowserMediaError('identity', '浏览器页面与提交的目标文章不一致，获取已停止。');
    contents.stop();
    destroyWindow();
    progress('已取得目标文章内容，正在保存正文配图。');
    phase = '保存文章配图';
    const images: BrowserArticleResult['images'] = [], limitations = [...result.limitations];
    const imageDeadline = Math.min(deadline - 1000, Date.now() + 120_000);
    const slots = result.images.filter(image => Number.isInteger(image.index) && image.index >= 1 && image.index <= 24).slice(0, 24);
    for (let position = 0; position < slots.length; position++) {
      const image = slots[position];
      signal.throwIfAborted();
      if (Date.now() >= imageDeadline) { images.push({ index: image.index, error: '配图获取时间已用尽，未下载此图片。' }); continue; }
      const began = Date.now();
      const diagnostic: BrowserMediaDiagnostic = { stage: 'url', outcome: 'failed', candidateIndex: image.index, elapsedMs: 0, bytesReceived: 0 };
      diagnostics.push(diagnostic);
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(25_000, Math.floor((imageDeadline - Date.now()) / (slots.length - position))))) ]);
      try {
        const candidate = allowUrl(image.url.replace(/^http:\/\//i, 'https://'));
        if (!candidate) throw new BrowserMediaError('access', '这一配图位置没有允许获取的 HTTPS 平台图片地址。');
        const downloaded = await downloadCandidate({ url: candidate.href, audioOnly: false, priority: 0 }, ses, options, finalUrl.href, attemptSignal, diagnostic, true, allowUrl);
        signal.throwIfAborted();
        images.push({ index: image.index, filePath: downloaded.filePath, mimeType: downloaded.mimeType });
        diagnostic.outcome = 'ok';
      } catch (error) {
        if (signal.aborted) throw error;
        Object.assign(diagnostic, safeBrowserError(error));
        const message = error instanceof BrowserMediaError ? error.message : attemptSignal.aborted ? '配图下载超时，未保存不完整文件。' : '配图下载失败，未保存为完整图片。';
        images.push({ index: image.index, error: message });
      } finally { diagnostic.elapsedMs = Date.now() - began; }
    }
    const saved = images.filter(image => image.filePath).length;
    if (images.some(image => image.error)) limitations.push(`本次保存 ${saved}/${result.imageCount} 张配图；未成功的位置保留独立错误。`);
    if (!result.text.trim() && !saved) throw new BrowserMediaError('download', '目标文章没有可保存的正文，配图也未获取成功；未作为成功材料返回。', diagnostics);
    progress(`浏览器已保存目标正文与 ${saved} 张配图。`);
    // A logged-in page may add session credentials to its URL. Keep the submitted
    // source URL outside this process; the live URL is used only for local identity/referer.
    return { kind: 'article', platform, pageUrl: requested.href, acquiredBy: 'browser', title: result.title || (platform === 'wechat' ? '微信公众号文章' : '小红书笔记'),
      text: result.text, author: result.author, imageCount: result.imageCount, images, contentComplete: result.contentComplete,
      ...(limitations.length ? { limitations: [...new Set(limitations)] } : {}), diagnostics };
  } catch (error) {
    if (closed.signal.aborted) throw closed.signal.reason;
    if (outerSignal.aborted) throw error;
    if (error instanceof BrowserMediaError) throw error;
    throw new BrowserMediaError('access', `${phase}失败，未返回登录页或其他文章作为正文。`, diagnostics);
  } finally {
    signal.removeEventListener('abort', destroyWindow);
    lifecycle.abort();
    destroyWindow();
    proxy?.close();
    if (ses) {
      ses.removeListener('will-download', preventDownload);
      ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
      ses.webRequest.onBeforeRedirect(null);
      // Preserve this platform's login while blocking background requests between acquisitions.
      await bounded(Promise.allSettled([sessionOperation(platform, ses.closeAllConnections()), sessionOperation(platform, ses.cookies.flushStore())]), AbortSignal.timeout(4000)).catch(() => undefined);
    }
  }
}
