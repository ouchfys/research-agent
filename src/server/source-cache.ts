import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RawMaterial, Settings, Upload } from '../shared/types.js';
import { arxivIdentity } from './source-arxiv.js';
import { douyinIdentity } from './source-douyin.js';
import { xiaohongshuId } from './source-article.js';

// Bump when acquisition/parsing prompts, output shape or processing limits change.
const PIPELINE_VERSION = 'sources-2026-10-08-v1';
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT = 'acquisition-cache.json';
const MAX_MANIFEST_FILES = 10_000;
export interface SourceCacheIdentity { key: string; maxAge: number; uploadHash?: string }
interface Artifact { name: string; bytes: number; sha256: string }
interface Snapshot { version: string; key: string; capturedAt: number; raw: RawMaterial; artifacts: Artifact[] }
interface Pointer { attempt: string; startedAt: number; state: 'running'|'complete'|'failed'; sourceId?: string; capturedAt?: number; snapshotHash?: string }
export interface CacheTicket { identity: SourceCacheIdentity; key: string; attempt: string; startedAt: number }

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function digestFile(file: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
  signal?.throwIfAborted();
  return digest.digest('hex');
}
async function jsonFile<T>(file: string, maxBytes: number): Promise<T> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) throw new Error('Invalid cache record');
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), 'utf8');
  await rename(temporary, file);
}

/** Identity normalization preserves content selectors (Bilibili part, arXiv version). */
export function sourceUrlIdentity(value: string, settings: Settings): SourceCacheIdentity | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const paper = arxivIdentity(url.href, settings.paperParsing.arxivHtmlBaseUrl);
    if (paper) return { key: 'arxiv:' + paper.id, maxAge: paper.version ? 90 * DAY : DAY };
    const douyin = douyinIdentity(url.href);
    if (douyin.id) return { key: 'douyin:' + douyin.id, maxAge: 7 * DAY };
    const xhs = xiaohongshuId(url.href);
    if (xhs) return { key: 'xiaohongshu:' + xhs, maxAge: DAY };
    if (/(^|\.)bilibili\.com$/i.test(url.hostname)) {
      const video = url.pathname.match(/\/video\/(BV[\w]+|av\d+)/i)?.[1];
      const part = Number(url.searchParams.get('p') || 1);
      if (video && Number.isSafeInteger(part) && part > 0) return { key: 'bilibili:' + video + ':p=' + part, maxAge: 7 * DAY };
    }
    // Do not discard arbitrary query strings or SPA fragments.
    return { key: 'url:' + url.href, maxAge: DAY };
  } catch { return; }
}

export async function sourceUploadIdentity(upload: Upload, signal?: AbortSignal): Promise<SourceCacheIdentity | undefined> {
  let digest: string;
  if (upload.localPath) {
    const file = await realpath(upload.localPath), before = await stat(file);
    if (!before.isFile() || before.size <= 0 || before.size > 512 * 1024 * 1024) return;
    digest = await digestFile(file, signal);
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
  } else {
    const data = (upload.data || '').replace(/^data:[^;]+;base64,/, '');
    if (data.length > Math.ceil(32 * 1024 * 1024 * 4 / 3) + 8 || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(data)) return;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) return;
    digest = hash(bytes);
  }
  // Filename can affect subtitle parsing, the document title and vision instructions.
  return { key: JSON.stringify(['upload', path.basename(upload.name), upload.mimeType, digest]), maxAge: 0, uploadHash: digest };
}

/** A fallback failure is harmless if the final acquisition completed successfully. */
export function reusableSource(raw: RawMaterial): boolean {
  if (!raw.text.trim() || raw.text.length >= 400_000 || raw.error || raw.status === 'unavailable') return false;
  const meta = raw.metadata || {};
  if (meta.fullText === false || meta.contentComplete === false || meta.subtitleClipped === true) return false;
  const images = Array.isArray(meta.cachedImages) ? meta.cachedImages : [];
  if (images.some(image => !image || typeof image !== 'object' || !(image as any).filePath || (image as any).error)) return false;
  if (raw.status === 'available') return true;
  if (raw.kind === 'image') return !!raw.filePath;
  if (Number(meta.imageCount) > 0) return Number(meta.imageCount) <= 24 && Number(meta.recognizedImages) === Number(meta.imageCount);
  // Video remains partial because frames are sampled. This flag refers to successful
  // processing of the requested window, never to having watched every video frame.
  return meta.mediaProcessingComplete === true;
}

/** Cache is local to one library. Neither credentials nor model conversation are stored. */
export class SourceCache {
  private readonly indexDir: string;
  private readonly pending = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly rawDir: string) { this.indexDir = path.join(path.dirname(rawDir), 'source-cache'); }

  async ticket(identity: SourceCacheIdentity, settings: Settings, browserAvailable: boolean, signal?: AbortSignal): Promise<CacheTicket> {
    const endpoint = (config: Settings['vision'] | Settings['transcription'] | Settings['mediaVision']) => ({
      provider: config.provider, baseUrl: config.baseUrl, model: config.model, configured: !!config.apiKey,
      ...('protocol' in config ? { protocol: config.protocol } : {}),
    });
    const binary = async (file: string) => {
      if (!file) return null;
      try { const info = await stat(file); return [file, info.size, info.mtimeMs]; } catch { return [file, 'unavailable']; }
    };
    let cookies = '';
    if (settings.mediaCookiesPath) {
      try { const info = await stat(settings.mediaCookiesPath); cookies = info.size <= 2 * 1024 * 1024 ? await digestFile(settings.mediaCookiesPath, signal) : 'oversized'; }
      catch { signal?.throwIfAborted(); cookies = 'unavailable'; }
    }
    const [ytDlp, ffmpeg] = await Promise.all([binary(settings.ytDlpPath), binary(settings.ffmpegPath)]);
    const fingerprint = hash(JSON.stringify({ version: PIPELINE_VERSION, browserAvailable, ytDlp, ffmpeg, cookies,
      vision: endpoint(settings.vision), mediaVision: endpoint(settings.mediaVision), asr: endpoint(settings.transcription),
      paper: { ...settings.paperParsing, mineru: { ...settings.paperParsing.mineru, apiToken: undefined, configured: !!settings.paperParsing.mineru.apiToken } },
    }));
    return { identity, key: hash(identity.key + '\n' + fingerprint), attempt: randomUUID(), startedAt: Date.now() };
  }

  private pointerPath(ticket: CacheTicket): string { return path.join(this.indexDir, ticket.key + '.json'); }
  private async writePointer(ticket: CacheTicket, pointer: Pointer, finished = false): Promise<void> {
    const prior = this.writes.get(ticket.key) || Promise.resolve();
    const write = prior.catch(() => {}).then(async () => {
      if (this.pending.get(ticket.key) !== ticket.attempt) return;
      await atomicJson(this.pointerPath(ticket), pointer);
      if (finished && this.pending.get(ticket.key) === ticket.attempt) this.pending.delete(ticket.key);
    });
    this.writes.set(ticket.key, write);
    try { await write; }
    finally { if (this.writes.get(ticket.key) === write) this.writes.delete(ticket.key); }
  }
  async begin(ticket: CacheTicket): Promise<void> {
    this.pending.set(ticket.key, ticket.attempt);
    await this.writePointer(ticket, { attempt: ticket.attempt, startedAt: ticket.startedAt, state: 'running' });
  }

  private async root(id: string): Promise<string> {
    if (!UUID.test(id)) throw new Error('Invalid source ID');
    const root = await realpath(this.rawDir), target = path.join(root, id);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(target))) throw new Error('Invalid source directory');
    return target;
  }

  private async artifacts(directory: string, signal?: AbortSignal): Promise<Artifact[]> {
    const files: Artifact[] = [];
    let bytes = 0;
    const walk = async (folder: string) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const file = path.join(folder, entry.name), name = path.relative(directory, file);
        if ([SNAPSHOT, 'source.json', 'content.md'].includes(name) || /\.(?:tmp|part|ytdl)$/i.test(entry.name)) continue;
        const info = await lstat(file);
        if (info.isSymbolicLink() || !inside(directory, await realpath(file))) throw new Error('Cache contains an unsafe path');
        if (info.isDirectory()) await walk(file);
        else {
          if (!info.isFile() || files.length >= MAX_MANIFEST_FILES) throw new Error('Invalid cache artifact');
          bytes += info.size;
          if (bytes > 2 * 1024 * 1024 * 1024) throw new Error('Cache artifacts exceed limit');
          files.push({ name, bytes: info.size, sha256: await digestFile(file, signal) });
        }
      }
    };
    await walk(directory);
    return files;
  }

  async finish(ticket: CacheTicket, raw?: RawMaterial, signal?: AbortSignal): Promise<void> {
    if (this.pending.get(ticket.key) !== ticket.attempt) return;
    let pointer: Pointer = { attempt: ticket.attempt, startedAt: ticket.startedAt, state: 'failed' };
    if (raw && reusableSource(raw)) {
      const directory = await this.root(raw.id), artifacts = await this.artifacts(directory, signal);
      if (!artifacts.length) throw new Error('No preserved source artifacts');
      if (ticket.identity.uploadHash && (!raw.filePath || await digestFile(raw.filePath, signal) !== ticket.identity.uploadHash)) throw new Error('Imported file changed during capture');
      const snapshot: Snapshot = { version: PIPELINE_VERSION, key: ticket.key, capturedAt: ticket.startedAt, raw, artifacts };
      const data = JSON.stringify(snapshot);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('Cache snapshot exceeds limit');
      await writeFile(path.join(directory, SNAPSHOT), data, 'utf8');
      pointer = { ...pointer, state: 'complete', sourceId: raw.id, capturedAt: ticket.startedAt, snapshotHash: hash(data) };
    }
    signal?.throwIfAborted();
    await this.writePointer(ticket, pointer, true);
  }

  async reuse(ticket: CacheTicket, taskId: string, signal?: AbortSignal): Promise<RawMaterial | undefined> {
    let destination: string | undefined;
    try {
      if (this.pending.has(ticket.key)) return;
      const pointer = await jsonFile<Pointer>(this.pointerPath(ticket), 8192);
      if (pointer.state !== 'complete' || !pointer.sourceId || !pointer.capturedAt || pointer.capturedAt > Date.now()
        || ticket.identity.maxAge > 0 && Date.now() - pointer.capturedAt > ticket.identity.maxAge) return;
      const directory = await this.root(pointer.sourceId), record = path.join(directory, SNAPSHOT);
      const snapshot = await jsonFile<Snapshot>(record, 8 * 1024 * 1024);
      if (hash(await readFile(record)) !== pointer.snapshotHash || snapshot.version !== PIPELINE_VERSION || snapshot.key !== ticket.key
        || snapshot.capturedAt !== pointer.capturedAt || snapshot.raw.id !== pointer.sourceId || !reusableSource(snapshot.raw)
        || !Array.isArray(snapshot.artifacts) || !snapshot.artifacts.length || snapshot.artifacts.length > MAX_MANIFEST_FILES) return;
      const validated = new Map<string, Artifact>();
      for (const artifact of snapshot.artifacts) {
        signal?.throwIfAborted();
        if (typeof artifact.name !== 'string' || path.isAbsolute(artifact.name)) return;
        const file = path.resolve(directory, artifact.name);
        if (!inside(directory, file) || !inside(directory, await realpath(file))) return;
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes || await digestFile(file, signal) !== artifact.sha256) return;
        validated.set(file, artifact);
      }
      const verifyReferences = (value: unknown, fileField = false): void => {
        if (typeof value === 'string' && path.isAbsolute(value)
          && (fileField || /[/\\]raw[/\\][0-9a-f-]{36}[/\\]/i.test(value) || inside(directory, path.resolve(value)))) {
          if (!validated.has(path.resolve(value))) throw new Error('Source references a missing or relocated artifact');
        } else if (Array.isArray(value)) value.forEach(item => verifyReferences(item, fileField));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
          verifyReferences(item, /(?:path|file|files)$/i.test(key) || ['archive', 'markdown', 'images', 'metadata'].includes(key));
        }
      };
      if (snapshot.raw.filePath && !validated.has(path.resolve(snapshot.raw.filePath))) return;
      verifyReferences(snapshot.raw.metadata);
      // Cache snapshots intentionally remain immutable when a library is moved.
      // Old absolute Markdown links invalidate the entry rather than pointing back.
      remapMarkdownImages(snapshot.raw.text, new Map([...validated.keys()].map(file => [file, file])));
      if (snapshot.raw.taskId === taskId) {
        // Preserve the input ID when recovering an interrupted batch in this task.
        // Ingestion/refresh attaches input lineage after the immutable capture is saved.
        const current = await jsonFile<RawMaterial>(path.join(directory, 'source.json'), 8 * 1024 * 1024);
        if (current.id !== snapshot.raw.id || current.taskId !== taskId) return;
        const metadata = { ...snapshot.raw.metadata };
        for (const field of ['ingestKey', 'inputRole', 'retryOf', 'originalTaskId']) {
          if (current.metadata?.[field] !== undefined) metadata[field] = current.metadata[field];
        }
        if (this.pending.has(ticket.key)) return;
        return this.markReused({ ...snapshot.raw, metadata }, snapshot);
      }
      const id = randomUUID();
      destination = path.join(await realpath(this.rawDir), id);
      await mkdir(destination);
      const mapping = new Map<string, string>();
      for (const [file, artifact] of validated) {
        signal?.throwIfAborted();
        const target = path.join(destination, artifact.name);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file, target);
        if (await digestFile(target, signal) !== artifact.sha256) throw new Error('Artifact changed while copying');
        mapping.set(file, target);
      }
      const remap = (value: unknown): any => {
        if (typeof value === 'string') {
          if (path.isAbsolute(value) && inside(directory, path.resolve(value))) {
            const mapped = mapping.get(path.resolve(value));
            if (!mapped) throw new Error('Source references a missing artifact');
            return mapped;
          }
          return value;
        }
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
        return value;
      };
      const original = snapshot.raw;
      const meta = { ...original.metadata };
      for (const field of ['ingestKey', 'inputRole', 'retryOf', 'originalTaskId', 'acquisitionCache']) delete meta[field];
      const raw: RawMaterial = { ...original, id, taskId, createdAt: new Date().toISOString(), metadata: remap(meta), filePath: remap(original.filePath),
        text: remapMarkdownImages(original.text, mapping) };
      signal?.throwIfAborted();
      if (this.pending.has(ticket.key)) throw new Error('A newer acquisition is in progress');
      return this.markReused(raw, snapshot);
    } catch {
      if (destination && inside(path.resolve(this.rawDir), path.resolve(destination))) await rm(destination, { recursive: true, force: true }).catch(() => {});
      signal?.throwIfAborted();
      return;
    }
  }

  private markReused(raw: RawMaterial, snapshot: Snapshot): RawMaterial {
    raw.coverage = `复用 ${new Date(snapshot.capturedAt).toISOString()} 保存的本地获取结果；本次未重新访问来源或调用识别模型。${snapshot.raw.coverage}`;
    raw.metadata = { ...raw.metadata, acquisitionCache: { reused: true, sourceId: snapshot.raw.id, capturedAt: new Date(snapshot.capturedAt).toISOString(), version: PIPELINE_VERSION },
      stages: [...(raw.metadata?.stages || []), { name: 'cache', status: 'ok', detail: '已校验原件与识别产物；前面的获取阶段属于原始采集，本次未再次执行。' }] };
    return raw;
  }
}

/** Remap only local Markdown image destinations, including MinerU's URI-encoded paths. */
function remapMarkdownImages(text: string, mapping: Map<string, string>): string {
  return text.replace(/(!\[[^\]\n]*\]\()\s*(?:<([^>\n]+)>|([^\s)\n]+))(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g,
    (original, prefix: string, wrapped: string | undefined, plain: string | undefined, title: string | undefined) => {
      let decoded: string;
      try { decoded = decodeURIComponent(wrapped ?? plain ?? ''); } catch { return original; }
      if (!path.isAbsolute(decoded)) return original;
      const target = mapping.get(path.resolve(decoded));
      if (!target) throw new Error('Markdown references a missing or relocated local image');
      const encoded = target.replace(/\\/g, '/').split('/').map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part
        : encodeURIComponent(part).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
      return `${prefix}${encoded}${title ?? ''})`;
    });
}
