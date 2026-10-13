import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Settings } from '../shared/types.js';

export type MediaFailureCode = 'cancelled' | 'missing_tool' | 'cookies_required' | 'cookies_invalid' | 'access_denied' | 'extractor' | 'download' | 'ffmpeg' | 'asr' | 'vision';
export interface MediaDiagnostic {
  phase: 'extractor' | 'download' | 'ffmpeg' | 'cookies';
  reason: 'fresh_cookies_requested' | 'login_requested' | 'http_access_denied' | 'http_error' | 'unsupported_url' | 'no_formats' | 'extractor_failed' | 'download_failed' | 'ffmpeg_failed' | 'missing_tool' | 'cookies_unreadable' | 'cookies_format' | 'invalid_response';
  httpStatus?: number;
  exitCode?: number;
}
export class MediaFailure extends Error {
  constructor(readonly code: MediaFailureCode, message: string, readonly diagnostic?: MediaDiagnostic) { super(`[${code}] ${message}`); this.name = 'MediaFailure'; }
}
export function checkMediaSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaFailure('cancelled', '媒体获取或识别已取消，已保存的原始材料仍保留。');
}

/** Only fixed labels and numeric status codes survive classification; raw stderr never leaves this function. */
function processFailure(code: MediaFailureCode, stderr: string, exitCode: number | null): MediaFailure {
  const phase = code === 'extractor' ? 'extractor' : code === 'download' ? 'download' : 'ffmpeg';
  const explicitErrors = stderr.split(/\r?\n/).filter(line => /\bERROR\b|\bHTTP Error\b|\bExtractorError\b/i.test(line)).join('\n');
  const message = explicitErrors || stderr;
  const statusMatch = message.match(/\bHTTP(?:\s+Error|\s+status(?:\s+code)?)?\s*[:=]?\s*([45]\d{2})\b/i);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  const detail = (reason: MediaDiagnostic['reason']): MediaDiagnostic => ({ phase, reason,
    ...(httpStatus === undefined ? {} : { httpStatus }), ...(exitCode === null ? {} : { exitCode }) });
  const statusText = httpStatus === undefined ? '' : `（HTTP ${httpStatus}）`;
  if (phase === 'ffmpeg') return new MediaFailure('ffmpeg', 'FFmpeg/ffprobe 无法处理该文件或音轨；原文件已保留。', detail('ffmpeg_failed'));
  if (/(?:ffmpeg|ffprobe).{0,70}(?:not found|not installed|does not exist|could not be found)/i.test(message)) return new MediaFailure('missing_tool', 'yt-dlp 需要可用的 FFmpeg/ffprobe 才能合并音视频，请检查媒体程序设置。', detail('missing_tool'));
  if (/postprocessing|ffmpeg exited|error while (?:merging|converting)/i.test(message)) return new MediaFailure('ffmpeg', '已尝试获取媒体，但 FFmpeg 合并或封装失败；请检查媒体程序或手动导入。', detail('ffmpeg_failed'));
  // Douyin's explicit "Fresh cookies ... are needed" hint does not mean account login is mandatory.
  const cookieHint = message.split(/\r?\n/).some(line => !/\bcookies\b[^\r\n]{0,20}\b(?:not needed|not required)\b/i.test(line)
    && (/\bfresh\s+cookies\b[^\r\n]{0,100}\b(?:needed|required)\b|\bcookies\s+(?:(?:are|have)\s+)?(?:needed|required|expired)\b|\b(?:need|require)[^\r\n]{0,20}\b(?:valid|fresh)\s+cookies\b/i.test(line)));
  if (cookieHint) {
    return new MediaFailure('cookies_required', `提取器明确提示需要有效或更新的 Cookies${statusText}，这不等于作品必须登录；可以尝试浏览器获取，或指定本人导出的 Cookies 文件。`, detail('fresh_cookies_requested'));
  }
  if (httpStatus === 401 || httpStatus === 403) return new MediaFailure('access_denied', `媒体访问被服务拒绝${statusText}；仅凭此状态无法判断是否需要登录、Cookies 是否过期或是否触发访问限制。`, detail('http_access_denied'));
  if (/\b(?:log[ -]?in|sign[ -]?in)\s+(?:is\s+)?(?:required|needed)\b|\b(?:requires?|needs?)\s+(?:authentication|login)\b|(?:必须|需要|请先)登录/i.test(message)) {
    return new MediaFailure('access_denied', '提取器返回登录或账户权限提示，尚未取得作品内容；可以尝试浏览器获取，不能据此保证登录后一定可读。', detail('login_requested'));
  }
  if (/\bunsupported URL\b|\bno suitable extractor\b/i.test(message)) return new MediaFailure('extractor', '当前 yt-dlp 提取器未识别这个作品地址；可以尝试浏览器获取。', detail('unsupported_url'));
  if (/\bno (?:video )?formats\b|\brequested format is not available\b/i.test(message)) return new MediaFailure('extractor', '提取器未提供当前可下载的音视频格式；不能据此认定作品需要登录。', detail('no_formats'));
  if (httpStatus !== undefined) return new MediaFailure(code, `平台请求失败${statusText}，尚未取得可用媒体；原始服务消息未展示。`, detail('http_error'));
  return new MediaFailure(code, phase === 'extractor' ? 'yt-dlp 未取得可用作品信息；具体原因尚未确定，可以尝试浏览器获取。'
    : 'yt-dlp 音视频获取未完成，可能仍停在作品信息提取阶段；具体原因尚未确定，可以尝试浏览器获取。', detail(phase === 'extractor' ? 'extractor_failed' : 'download_failed'));
}

interface ProcessOptions { code?: MediaFailureCode; timeoutMs?: number; maxBytes?: number; directory?: string; maxDiskBytes?: number; signal?: AbortSignal }
async function directorySize(directory: string, depth = 0): Promise<number> {
  if (depth > 4) throw new Error('depth');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length > 5000) throw new Error('count');
  let bytes = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('symlink');
    // Fragment files are removed concurrently by yt-dlp after merging; that is not a failed download.
    bytes += entry.isDirectory() ? await directorySize(file, depth + 1) : await stat(file).then(info => info.size).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    });
  }
  return bytes;
}

/** Shell-free execution; neither raw stderr nor signed media URLs become user-visible errors. */
export async function runMediaBinary(executable: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  checkMediaSignal(options.signal);
  if (!executable.trim()) throw new MediaFailure('missing_tool', '尚未配置所需的媒体程序。');
  const code = options.code ?? 'ffmpeg';
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', size = 0, settled = false, stopping = false, checking = false;
    const decoder = new StringDecoder('utf8');
    let failure: Error | undefined, forceTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(diskTimer); if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(stdout);
    };
    const stop = (error: Error) => {
      if (settled || stopping) return;
      stopping = true; failure = error;
      // yt-dlp can spawn FFmpeg. Terminate the entire tree on Windows before cleaning temporary cookies.
      if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
        const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env });
        killer.on('error', () => child.kill('SIGKILL'));
      } else child.kill('SIGKILL');
      forceTimer = setTimeout(() => { child.kill('SIGKILL'); finish(error); }, 5000);
    };
    const abort = () => stop(new MediaFailure('cancelled', '媒体子进程已取消，已保存的原始材料仍保留。'));
    const timer = setTimeout(() => stop(new MediaFailure(code, '媒体处理超时，已中止；已完成的材料会保留。')), options.timeoutMs ?? 120_000);
    const diskTimer = setInterval(() => {
      if (!options.directory || checking || settled || stopping) return;
      checking = true;
      void directorySize(options.directory).then(bytes => {
        if (bytes > (options.maxDiskBytes ?? 1024 * 1024 * 1024)) stop(new MediaFailure(code, '媒体临时文件超过 1 GB 上限，已中止下载。'));
      }).catch(() => stop(new MediaFailure(code, '无法安全检查媒体临时文件，已中止处理。'))).finally(() => { checking = false; });
    }, 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new MediaFailure(code, '媒体程序响应超过大小上限。'));
      else stdout += decoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768); });
    child.on('error', () => finish(new MediaFailure('missing_tool', '无法启动媒体程序，请检查 yt-dlp、FFmpeg 或 ffprobe 路径。')));
    child.on('close', exitCode => {
      if (failure) return finish(failure);
      if (exitCode === 0) { stdout += decoder.end(); return finish(); }
      finish(processFailure(code, stderr, exitCode));
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export function platformMediaUrl(value: string): { url: string; extractor: string; domains: string[] } {
  let url: URL;
  try { url = new URL(value); } catch { throw new MediaFailure('download', '视频链接格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new MediaFailure('download', '视频来源只接受公开平台的 HTTP(S) 链接。');
  const host = url.hostname.toLowerCase();
  if (/(^|\.)bilibili\.com$/.test(host) || host === 'b23.tv') return { url: url.href, extractor: 'BiliBili.*', domains: ['bilibili.com', 'b23.tv'] };
  if (/(^|\.)douyin\.com$/.test(host)) return { url: url.href, extractor: 'Douyin', domains: ['douyin.com'] };
  if (/(^|\.)xiaohongshu\.com$/.test(host) || host === 'xhslink.com') return { url: url.href, extractor: 'XiaoHongShu', domains: ['xiaohongshu.com', 'xhslink.com'] };
  throw new MediaFailure('download', '外部媒体解析仅支持 B 站、抖音和小红书公开链接。');
}

/** Only an explicitly configured Netscape file is read. The original cookie jar is never modified. */
export async function withPlatformCookies<T>(settings: Settings, domains: string[], action: (args: string[]) => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkMediaSignal(signal);
  if (!settings.mediaCookiesPath) return action(['--no-cookies']);
  let data: string;
  try {
    const info = await stat(settings.mediaCookiesPath);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('size');
    data = await readFile(settings.mediaCookiesPath, 'utf8');
  } catch { throw new MediaFailure('cookies_invalid', '无法读取设置中的 Cookies 文件，或文件超过 2 MB；这属于本地配置问题，不代表作品要求登录。', { phase: 'cookies', reason: 'cookies_unreadable' }); }
  checkMediaSignal(signal);
  if (!/^# (?:Netscape )?HTTP Cookie File/m.test(data.replace(/^\uFEFF/, ''))) throw new MediaFailure('cookies_invalid', 'Cookies 文件不是 Netscape 格式；不会读取浏览器登录数据库。', { phase: 'cookies', reason: 'cookies_format' });
  const lines = data.split(/\r?\n/).filter(line => {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return false;
    const fields = line.replace(/^#HttpOnly_/, '').split('\t');
    if (fields.length !== 7) return false;
    const domain = fields[0].replace(/^\./, '').toLowerCase();
    return domains.some(root => domain === root || domain.endsWith('.' + root));
  });
  if (!lines.length) return action(['--no-cookies']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-shelf-cookies-'));
  const file = path.join(directory, 'cookies.txt');
  try {
    await writeFile(file, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    checkMediaSignal(signal);
    return await action(['--cookies', file]);
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

export function ytDlpArguments(extractor: string): string[] {
  return ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-cookies-from-browser', '--no-playlist', '--playlist-items', '1', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1', '--fragment-retries', '1', '--abort-on-unavailable-fragments', '--use-extractors', extractor];
}
