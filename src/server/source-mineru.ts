import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { Agent, fetch as publicFetch } from 'undici';
import { Open } from 'unzipper';
import type { Settings } from '../shared/types.js';
import { cleanText, clip } from './source-content.js';
import { endpoint, providerRequest, validatePublicUrl } from './source-network.js';

export type MineruStage = 'configuration' | 'submit' | 'upload' | 'poll' | 'download' | 'extract';
export class MineruError extends Error {
  constructor(readonly stage: MineruStage, readonly code: string, message: string) {
    super(`[mineru:${stage}:${code}] ${message}`); this.name = 'MineruError';
  }
}
export interface MineruContent {
  text: string; coverage: string; partial: boolean; warnings: string[];
  files: { archive: string; markdown: string[]; images: string[]; metadata: string[] };
  pageCount?: number; modelVersion: string;
}

const MAX_PDF = 200_000_000;
const MAX_ZIP = 100 * 1024 * 1024;
const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.jp2']);

function checkSignal(signal: AbortSignal, stage: MineruStage): void {
  if (signal.aborted) throw new MineruError(stage, 'cancelled', '解析已取消或达到总处理时限；原始 PDF 已保留。');
}
async function withinBudget<T>(promise: PromiseLike<T>, signal: AbortSignal, stage: MineruStage): Promise<T> {
  checkSignal(signal, stage);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MineruError(stage, 'cancelled', '解析已取消或达到总处理时限。'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
function serviceBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new MineruError('configuration', 'invalid_url', 'MinerU 服务地址格式无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MineruError('configuration', 'invalid_url', 'MinerU 服务地址必须是无账号密码和查询参数的 HTTP(S) URL。');
  if (/(^|\.)mineru\.net$/i.test(url.hostname) && url.protocol !== 'https:') throw new MineruError('configuration', 'invalid_url', 'MinerU 官方服务必须使用 HTTPS。');
  return url;
}
function serviceError(code: unknown, stage: MineruStage): MineruError {
  const descriptions: Record<string, string> = {
    A0202: 'MinerU Token 无效，请检查配置。', A0211: 'MinerU Token 已过期，请更新配置。',
    '-60005': '文件超过 MinerU 大小限制。', '-60006': '文件超过 MinerU 页数限制，请拆分后导入。',
    '-60007': 'MinerU 模型服务暂时不可用。', '-60009': 'MinerU 任务队列已满，请稍后重试。',
    '-60018': 'MinerU 当日解析任务额度已用完。', '-60003': 'MinerU 无法读取此 PDF，请检查文件是否损坏。',
    '-60004': 'MinerU 收到空文件。', '-60013': '当前 MinerU Token 无权读取此任务。',
  };
  const key = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
  return new MineruError(stage, /^[A-Z0-9_-]{1,20}$/i.test(key) ? key : 'service_error', descriptions[key] ?? 'MinerU 未完成该请求，请检查文件、服务状态、Token 权限和额度；服务原始响应未展示。');
}

/** Reuse the shared public-network validation and DNS pinning for signed transfers. No API token is forwarded. */
async function transferPublic(value: string, method: 'GET' | 'PUT', signal: AbortSignal, body?: Buffer): Promise<Buffer> {
  const stage = method === 'PUT' ? 'upload' : 'download';
  let current = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    checkSignal(signal, stage);
    const target = await withinBudget(validatePublicUrl(current), signal, stage);
    checkSignal(signal, stage);
    if (target.url.protocol !== 'https:') throw new MineruError(stage, 'unsafe_url', '签名上传和结果下载必须使用公开 HTTPS 地址。');
    const dispatcher = new Agent({ connect: { timeout: 12_000, lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    } } });
    try {
      const response = await publicFetch(target.url, {
        dispatcher, method, signal, redirect: 'manual',
        ...(method === 'PUT' ? { body: Uint8Array.from(body!), headers: { 'content-length': String(body!.length) } } : { headers: { accept: 'application/zip,application/octet-stream' } }),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (method === 'PUT') throw new MineruError('upload', 'redirect', 'MinerU 签名上传地址要求重定向，已停止上传，请重新解析以获取新地址。');
        const location = response.headers.get('location');
        if (!location) throw new MineruError('download', 'redirect', '结果下载重定向没有目标地址。');
        current = new URL(location, target.url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MineruError(stage, `http_${response.status}`, method === 'PUT' ? 'PDF 上传失败，签名可能过期或服务拒绝请求；请重试解析。' : 'MinerU 结果文件下载失败，请稍后重试。');
      }
      if (method === 'PUT') { await response.body?.cancel(); return Buffer.alloc(0); }
      if (Number(response.headers.get('content-length') || 0) > MAX_ZIP) { await response.body?.cancel(); throw new MineruError('download', 'too_large', 'MinerU 结果 ZIP 超过 100 MB 上限。'); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        checkSignal(signal, 'download'); size += chunk.byteLength;
        if (size > MAX_ZIP) throw new MineruError('download', 'too_large', 'MinerU 结果 ZIP 超过 100 MB 上限。');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally { await dispatcher.destroy(); }
  }
  throw new MineruError('download', 'redirect_limit', 'MinerU 结果下载重定向次数过多。');
}

async function pausePolling(milliseconds: number, signal: AbortSignal): Promise<void> {
  checkSignal(signal, 'poll');
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new MineruError('poll', 'cancelled', '解析已取消或达到总处理时限。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Bound the central directory before asking a ZIP library to allocate its entry list. */
function validateZipDirectory(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.length > MAX_ZIP) throw new MineruError('extract', 'invalid_zip', 'MinerU 返回的 ZIP 为空、损坏或超过大小上限。');
  let offset = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { offset = index; break; }
  }
  if (offset < 0) throw new MineruError('extract', 'invalid_zip', 'MinerU 结果缺少有效 ZIP 目录。');
  const count = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 12), start = bytes.readUInt32LE(offset + 16);
  if (bytes.readUInt16LE(offset + 4) || bytes.readUInt16LE(offset + 6) || bytes.readUInt16LE(offset + 8) !== count
    || !count || count > MAX_ENTRIES || start === 0xffffffff || size === 0xffffffff || start + size > offset) {
    throw new MineruError('extract', 'zip_limits', 'MinerU 结果包含分卷、ZIP64、过多文件或无效目录；未解压。');
  }
}

function safeEntryPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.replace(/\/$/, '').split('/');
  if (!normalized || normalized.length > 2048 || normalized.startsWith('/') || parts.length > 16
    || parts.some(part => !part || part === '.' || part === '..' || part.length > 240 || /[\x00-\x1f<>:"|?*\uFFFD]/.test(part)
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new MineruError('extract', 'unsafe_path', 'MinerU ZIP 含有不安全的文件路径，已停止解压。');
  }
  return parts.join('/');
}

function pagesFromJson(value: unknown): { count?: number; dropped: number } {
  if (!value || typeof value !== 'object') return { dropped: 0 };
  const data = value as Record<string, unknown>;
  const pages = Array.isArray(data.pdf_info) ? data.pdf_info : Array.isArray(data.pages) ? data.pages : undefined;
  if (pages) return { count: pages.length || undefined, dropped: pages.filter(page => page?.need_drop === true).length };
  if (Array.isArray(value)) {
    let highest = -1;
    for (const item of value) if (item && typeof item === 'object' && Number.isSafeInteger(item.page_idx) && item.page_idx >= 0 && item.page_idx < 100_000) highest = Math.max(highest, item.page_idx);
    return { count: highest >= 0 ? highest + 1 : undefined, dropped: 0 };
  }
  return { dropped: 0 };
}

function resolveMarkdownImages(markdown: string, markdownFile: string, images: string[]): string {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const saved = new Map(images.map(file => [key(path.resolve(file)), file]));
  const image = /(!\[[^\]\n]*\]\()\s*(?:<([^>\n]+)>|([^\s)\n]+))(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g;
  return markdown.replace(image, (original: string, prefix: string, wrapped: string | undefined, plain: string | undefined, title: string | undefined) => {
    const value = wrapped ?? plain ?? '';
    if (/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(value)) return original;
    let relative: string;
    try { relative = decodeURIComponent(value); } catch { return original; }
    const target = saved.get(key(path.resolve(path.dirname(markdownFile), relative.replace(/[/\\]/g, path.sep))));
    if (!target) return original;
    const encoded = target.replace(/\\/g, '/').split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part
      : encodeURIComponent(part).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
    return `${prefix}${encoded}${title ?? ''})`;
  });
}

async function unpackResult(bytes: Buffer, directory: string, signal: AbortSignal): Promise<{
  files: MineruContent['files']; markdown: string; pageCount?: number; droppedPages: number; warnings: string[];
}> {
  validateZipDirectory(bytes); checkSignal(signal, 'extract');
  // unzipper 0.12.5 accepts the documented directory options; its DefinitelyTyped overload omits them.
  const openBuffer = Open.buffer as (input: Buffer, options: { tailSize: number }) => ReturnType<typeof Open.buffer>;
  const archive = await withinBudget(openBuffer(bytes, { tailSize: Math.min(bytes.length, 65_557) }), signal, 'extract');
  if (archive.files.length > MAX_ENTRIES) throw new MineruError('extract', 'zip_limits', 'MinerU ZIP 文件数量超过 2000 项上限。');
  let declaredTotal = 0; const paths = new Set<string>();
  const entries = archive.files.map(entry => {
    const relative = safeEntryPath(entry.path), mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (paths.has(relative.toLowerCase()) || mode === 0o120000 || (mode && mode !== 0o100000 && mode !== 0o040000)) throw new MineruError('extract', 'unsafe_entry', 'MinerU ZIP 含重复路径、链接或特殊文件，已停止解压。');
    paths.add(relative.toLowerCase());
    if ((entry.flags & 1) || ![0, 8].includes(entry.compressionMethod)) throw new MineruError('extract', 'unsupported_zip', 'MinerU ZIP 使用加密或不支持的压缩格式。');
    if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize) || entry.uncompressedSize < 0 || entry.compressedSize < 0
      || entry.uncompressedSize > MAX_ENTRY || entry.uncompressedSize / Math.max(1, entry.compressedSize) > 500) throw new MineruError('extract', 'zip_limits', 'MinerU ZIP 单文件大小或压缩膨胀比例超过安全上限。');
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > MAX_UNPACKED) throw new MineruError('extract', 'zip_limits', 'MinerU ZIP 解压后超过 256 MB 上限。');
    return { entry, relative, extension: path.extname(relative).toLowerCase() };
  });
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(path.join(directory, 'result-'));
  const files: MineruContent['files'] = { archive: path.join(work, 'result.zip'), markdown: [], images: [], metadata: [] };
  await writeFile(files.archive, bytes, { flag: 'wx' });
  const output = path.join(work, 'extracted'); await mkdir(output);
  const markdowns: { relative: string; filePath: string; text: string }[] = [];
  let actualTotal = 0, pageCount: number | undefined, droppedPages = 0;
  const warnings: string[] = [];
  for (const { entry, relative, extension } of entries) {
    checkSignal(signal, 'extract');
    if (entry.type === 'Directory' || !['.md', '.json'].includes(extension) && !imageExtensions.has(extension)) continue;
    const target = path.resolve(output, relative), location = path.relative(output, target);
    if (!location || location.startsWith('..') || path.isAbsolute(location)) throw new MineruError('extract', 'unsafe_path', 'MinerU 结果路径超出保存目录。');
    const stream = entry.stream(), chunks: Buffer[] = []; let size = 0, checksum = 0;
    const abort = () => stream.destroy(new MineruError('extract', 'cancelled', '结果解压已取消或达到总处理时限。'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) {
        checkSignal(signal, 'extract'); const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length; actualTotal += buffer.length;
        if (size > MAX_ENTRY || size > entry.uncompressedSize || actualTotal > MAX_UNPACKED) throw new MineruError('extract', 'zip_limits', 'MinerU ZIP 实际解压数据超过声明或大小上限。');
        checksum = crc32(buffer, checksum); chunks.push(buffer);
      }
      if (size !== entry.uncompressedSize || checksum !== (entry.crc32 >>> 0)) throw new MineruError('extract', 'corrupt_entry', 'MinerU ZIP 内容校验失败，未作为有效材料使用。');
    } finally { signal.removeEventListener('abort', abort); stream.destroy(); }
    const data = Buffer.concat(chunks);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx' });
    if (extension === '.md') { files.markdown.push(target); markdowns.push({ relative, filePath: target, text: data.toString('utf8') }); }
    else if (extension === '.json') {
      files.metadata.push(target);
      if (/(?:layout|middle|content_list)(?:[^/]*)\.json$/i.test(relative)) {
        try {
          const pages = pagesFromJson(JSON.parse(data.toString('utf8')));
          if (pages.count !== undefined) pageCount = Math.max(pageCount ?? 0, pages.count);
          droppedPages = Math.max(droppedPages, pages.dropped);
        } catch { warnings.push('部分结构 JSON 无法解析；原 JSON 已保留，未推断其页数。'); }
      }
    } else files.images.push(target);
  }
  const preferred = markdowns.filter(item => path.posix.basename(item.relative).toLowerCase() === 'full.md');
  const candidates = preferred.length ? preferred : markdowns;
  candidates.sort((a, b) => a.relative.length - b.relative.length || a.relative.localeCompare(b.relative));
  const primary = candidates[0];
  const markdown = primary ? cleanText(resolveMarkdownImages(primary.text, primary.filePath, files.images)) : '';
  if (!markdown) throw new MineruError('extract', 'empty_markdown', 'MinerU 完成任务但未返回有效 Markdown 正文；结果文件和原始 PDF 已保留。');
  if (candidates.length > 1) warnings.push('结果包含多份 Markdown，正文使用首份 full.md（若无则最短路径文档）；所有 Markdown 均已保存。');
  return { files, markdown, pageCount, droppedPages, warnings };
}

/** Cloud v4: local file upload -> automatic task -> bounded polling -> Markdown/JSON/images. No secondary model calls. */
export async function parsePdfWithMineru(bytes: Buffer, name: string, directory: string, config: Settings['paperParsing']['mineru'], progress?: (message: string) => void, externalSignal?: AbortSignal): Promise<MineruContent> {
  const base = serviceBase(config.baseUrl);
  if (!config.apiToken?.trim()) throw new MineruError('configuration', 'missing_token', '尚未配置 MinerU Token，原始 PDF 已保留。');
  if (!['vlm', 'pipeline'].includes(config.model)) throw new MineruError('configuration', 'invalid_model', 'PDF 解析只支持 MinerU vlm 或 pipeline 模型。');
  if (!bytes.length || bytes.length > MAX_PDF || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new MineruError('configuration', 'invalid_pdf', '文件为空、不是有效 PDF 标头或超过 200 MB 上传上限。');
  const timeoutSeconds = Number(config.timeoutSeconds), pollIntervalSeconds = Number(config.pollIntervalSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 || !Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 1 || pollIntervalSeconds > 60) throw new MineruError('configuration', 'invalid_timeout', 'MinerU 总时限需为 1–3600 秒，轮询间隔需为 1–60 秒。');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  let stage: MineruStage = 'submit';
  const api = async (suffix: string, method: 'GET' | 'POST', body?: unknown): Promise<any> => {
    checkSignal(signal, stage);
    const url = new URL(endpoint(base.href, suffix));
    // Only the explicitly configured API origin receives the token; response-provided URLs never enter this function.
    if (url.origin !== base.origin) throw new MineruError(stage, 'invalid_origin', 'MinerU API 请求目标与配置不一致。');
    const result = await providerRequest(url.href, { method, signal, headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      method === 'POST' && suffix === 'file-urls/batch' ? { purpose: 'parsing', provider: 'mineru', model: config.model } : undefined);
    if (!result || result.code !== 0 || !result.data || typeof result.data !== 'object') throw serviceError(result?.code, stage);
    return result.data;
  };
  try {
    progress?.('正在向 MinerU 申请 PDF 上传位置');
    const fileName = path.basename(name).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 180).replace(/\.pdf$/i, '') + '.pdf';
    const dataId = randomUUID();
    const submitted = await api('file-urls/batch', 'POST', { files: [{ name: fileName, data_id: dataId, is_ocr: true }], model_version: config.model, enable_formula: true, enable_table: true });
    if (typeof submitted.batch_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.batch_id) || !Array.isArray(submitted.file_urls) || submitted.file_urls.length !== 1 || typeof submitted.file_urls[0] !== 'string') throw new MineruError('submit', 'invalid_response', 'MinerU 未返回单文件上传位置或有效批次编号。');
    stage = 'upload'; progress?.('正在上传原始 PDF 到 MinerU');
    await transferPublic(submitted.file_urls[0], 'PUT', signal, bytes);
    stage = 'poll'; let zipUrl: string | undefined, pageCount: number | undefined, extractedPages: number | undefined, previousProgress = '';
    while (!zipUrl) {
      checkSignal(signal, 'poll');
      const state = await api(`extract-results/batch/${encodeURIComponent(submitted.batch_id)}`, 'GET');
      if (state.batch_id !== undefined && state.batch_id !== submitted.batch_id) throw new MineruError('poll', 'invalid_response', 'MinerU 返回的批次与当前任务不一致。');
      const results = state.extract_result;
      if (!Array.isArray(results) || results.length > 1) throw new MineruError('poll', 'invalid_response', 'MinerU 未返回当前 PDF 的唯一解析状态。');
      if (!results.length) { await pausePolling(pollIntervalSeconds * 1000, signal); continue; }
      const item = results[0];
      if (item.data_id !== undefined && item.data_id !== dataId) throw new MineruError('poll', 'invalid_response', 'MinerU 返回的文件标识与当前 PDF 不一致。');
      const pages = item.extract_progress;
      if (Number.isSafeInteger(pages?.total_pages) && pages.total_pages > 0) pageCount = pages.total_pages;
      if (Number.isSafeInteger(pages?.extracted_pages) && pages.extracted_pages >= 0) extractedPages = pages.extracted_pages;
      if (item.state === 'failed') throw new MineruError('poll', 'parse_failed', 'MinerU 报告 PDF 解析失败；可能是文件损坏、受保护或超过服务限制。原始 PDF 已保留。');
      if (item.state === 'done') {
        if (typeof item.full_zip_url !== 'string' || !item.full_zip_url) throw new MineruError('poll', 'missing_result', 'MinerU 报告完成但没有结果文件地址。');
        zipUrl = item.full_zip_url; break;
      }
      const labels: Record<string, string> = { 'waiting-file': '正在等待 MinerU 确认文件上传', pending: 'MinerU 正在排队解析', running: 'MinerU 正在解析 PDF', converting: 'MinerU 正在整理解析结果' };
      if (!labels[item.state]) throw new MineruError('poll', 'unknown_state', 'MinerU 返回未知任务状态，已停止等待。');
      const label = labels[item.state] + (pageCount ? `（已处理 ${extractedPages ?? 0}/${pageCount} 页）` : '');
      if (label !== previousProgress) { progress?.(label); previousProgress = label; }
      await pausePolling(pollIntervalSeconds * 1000, signal);
    }
    stage = 'download'; progress?.('正在下载 MinerU Markdown、图片与结构结果');
    if (!zipUrl) throw new MineruError('poll', 'missing_result', 'MinerU 未提供可下载的结果文件。');
    const zip = await transferPublic(zipUrl, 'GET', signal);
    stage = 'extract'; progress?.('正在保存 MinerU Markdown、图片与结构结果');
    const result = await unpackResult(zip, directory, signal);
    pageCount = result.pageCount ?? pageCount;
    const clipped = clip(result.markdown), warnings = result.warnings;
    if (clipped.clipped) warnings.push('材料正文超过 40 万字符，提供的正文已截断；完整 Markdown 已保存。');
    if (result.droppedPages) warnings.push(`结构结果标记了 ${result.droppedPages} 个被舍弃页面，不能视为完整解析。`);
    // Earlier running progress can lag the eventual done state; do not treat it as final page coverage.
    const coverage = `MinerU ${config.model} 云解析返回完成：取得 Markdown 正文${pageCount ? `，结果记录 ${pageCount} 页` : '，服务未提供可核实的页数'}；已保存 ${result.files.images.length} 张图像及 ${result.files.metadata.length} 份结构 JSON。表格、公式和正文来自解析结果，仍可能有识别错误；图像原件已保留，但未进行额外逐图视觉解读${warnings.length ? '；' + warnings.join('；') : ''}。`;
    checkSignal(signal, 'extract');
    return { text: clipped.text, coverage, partial: clipped.clipped || result.droppedPages > 0 || warnings.length > 0, warnings, files: result.files, pageCount, modelVersion: config.model };
  } catch (error) {
    if (externalSignal?.aborted) throw new MineruError(stage, 'cancelled', 'MinerU 解析已取消；原始 PDF 和已保存材料仍保留。');
    if (controller.signal.aborted) throw new MineruError(stage, 'timeout', `MinerU 处理达到 ${timeoutSeconds} 秒总时限；原始 PDF 已保留，可稍后重新解析。`);
    if (error instanceof MineruError) throw error;
    const status = error instanceof Error ? error.message.match(/HTTP (\d{3})/)?.[1] : undefined;
    throw new MineruError(stage, status ? `http_${status}` : 'request_failed', stage === 'extract' ? 'MinerU 结果解压或保存失败，未将其作为完整材料；原始 PDF 已保留。' : 'MinerU 请求失败，请检查网络、服务地址、Token 权限或配额；原始 PDF 已保留。');
  } finally { clearTimeout(timer); }
}
