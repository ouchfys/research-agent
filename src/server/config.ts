import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'dotenv';
import type { EndpointConfig, ModelProvider, PaperParsingConfig, Settings, SettingsPatch, PublicSettings } from '../shared/types';
import { DEEPSEEK_SEARCH, inferProvider, modelPreset, PROVIDERS } from '../shared/providers';

type OfficialProvider = 'aliyun' | 'deepseek';
type KeySources = Record<OfficialProvider, 'env' | 'saved' | 'none'>;
type SavedConfig = Partial<Settings> & { schemaVersion?: number; providerKeys?: Partial<Record<OfficialProvider, string>>; credentialSources?: Partial<KeySources>; paperTokenSource?: 'env'|'saved'|'none'; envFile?: string; pendingDataDir?: string };
const official = (provider: ModelProvider): provider is OfficialProvider => provider !== 'custom';
function mediaVisionEndpoint(value: Pick<Settings, 'text' | 'vision'>): EndpointConfig {
  const endpoint = value.vision.useTextModel ? value.text : value.vision;
  return { provider: endpoint.provider || inferProvider(endpoint.baseUrl), baseUrl: endpoint.baseUrl, model: endpoint.model, apiKey: endpoint.apiKey };
}
const PAPER_PARSING: PaperParsingConfig = { arxivHtmlBaseUrl: 'https://arxiv.org/html', arxivHtmlTimeoutSeconds: 60, mineru: { baseUrl: 'https://mineru.net/api/v4', model: 'vlm', apiToken: '', timeoutSeconds: 600, pollIntervalSeconds: 4 } };
type PaperParsingPatch = Partial<Omit<PaperParsingConfig, 'mineru'>> & { mineru?: Partial<PaperParsingConfig['mineru']> };
function readEnv(file: string): Record<string, string> {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    return parse(readFileSync(file, 'utf8'));
  } catch { throw new Error('无法读取配置文件，请选择可读取且不超过 1 MB 的本地 .env 文件。'); }
}
function readSaved(file: string): SavedConfig {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as SavedConfig;
  } catch { throw new Error('本地设置文件无法读取，请检查 settings.json 的格式或恢复其备份。'); }
}
function credential(value: unknown, label: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 16_384) throw new Error(`${label}格式无效，请粘贴单行密钥。`);
  return value.trim();
}
function envValue(env: Record<string, string | undefined>, ...names: string[]): string {
  const normalized = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase().replace(/[-_]/g, ''), value?.trim() || '']));
  for (const name of names) { const value = normalized.get(name.toLowerCase().replace(/[-_]/g, '')); if (value) return value; }
  return '';
}
function paperUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}需要完整的 HTTP 或 HTTPS 地址。`);
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw new Error(`${label}需要不含账号、密钥、查询参数或片段的 HTTP 或 HTTPS 地址。`); }
}
function paperSeconds(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label}应为 1–${maximum} 秒之间的整数。`);
  return value;
}
function applyPaperParsing(prior: PaperParsingConfig, patch: PaperParsingPatch = {}): PaperParsingConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || (patch.mineru !== undefined && (!patch.mineru || typeof patch.mineru !== 'object' || Array.isArray(patch.mineru)))) throw new Error('论文解析配置格式无效。');
  const mineru = patch.mineru || {}, token = mineru.apiToken;
  if (token !== undefined && (typeof token !== 'string' || /[\r\n]/.test(token) || token.length > 16_384)) throw new Error('MinerU Token 格式无效。');
  const model = mineru.model ?? prior.mineru.model;
  if (typeof model !== 'string' || !model.trim() || model.trim().length > 120 || /[\r\n]/.test(model)) throw new Error('MinerU 模型版本应为 1–120 个字符的标识。');
  const baseUrl = paperUrl(mineru.baseUrl ?? prior.mineru.baseUrl, 'MinerU API 地址');
  const sameOrigin = new URL(baseUrl).origin === new URL(prior.mineru.baseUrl).origin;
  const result: PaperParsingConfig = {
    arxivHtmlBaseUrl: paperUrl(patch.arxivHtmlBaseUrl ?? prior.arxivHtmlBaseUrl, 'arXiv HTML 地址'),
    arxivHtmlTimeoutSeconds: paperSeconds(patch.arxivHtmlTimeoutSeconds ?? prior.arxivHtmlTimeoutSeconds, 'arXiv HTML 超时', 300),
    mineru: { baseUrl, model: model.trim(), apiToken: token?.trim() || (sameOrigin ? prior.mineru.apiToken : ''),
      timeoutSeconds: paperSeconds(mineru.timeoutSeconds ?? prior.mineru.timeoutSeconds, 'MinerU 总超时', 3600),
      pollIntervalSeconds: paperSeconds(mineru.pollIntervalSeconds ?? prior.mineru.pollIntervalSeconds, 'MinerU 轮询间隔', 60) },
  };
  if (result.mineru.pollIntervalSeconds > result.mineru.timeoutSeconds) throw new Error('MinerU 轮询间隔不能超过总超时。');
  return result;
}
function paperParsingFromEnv(prior: PaperParsingConfig, env: Record<string, string | undefined>): { value: PaperParsingConfig; found: boolean } {
  const arxivBase = envValue(env, 'ARXIV_HTML_BASE_URL'), arxivTimeout = envValue(env, 'ARXIV_HTML_TIMEOUT_SECONDS');
  const baseUrl = envValue(env, 'MINERU_API_BASE_URL'), model = envValue(env, 'MINERU_MODEL_VERSION'), apiToken = envValue(env, 'MINERU_API_TOKEN');
  const timeout = envValue(env, 'MINERU_TIMEOUT_SECONDS'), interval = envValue(env, 'MINERU_POLL_INTERVAL_SECONDS');
  const patch: PaperParsingPatch = { ...(arxivBase ? { arxivHtmlBaseUrl: arxivBase } : {}), ...(arxivTimeout ? { arxivHtmlTimeoutSeconds: Number(arxivTimeout) } : {}), mineru: {
    ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}), ...(apiToken ? { apiToken } : {}),
    ...(timeout ? { timeoutSeconds: Number(timeout) } : {}), ...(interval ? { pollIntervalSeconds: Number(interval) } : {}),
  } };
  return { value: applyPaperParsing(prior, patch), found: Boolean(arxivBase || arxivTimeout || baseUrl || model || apiToken || timeout || interval) };
}
function keysFromEnv(env: Record<string, string | undefined>): Record<OfficialProvider, string> {
  return { aliyun: envValue(env, 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'BAILIAN_API_KEY', 'ALIYUN_BAILIAN_API_KEY'), deepseek: envValue(env, 'DEEPSEEK_API_KEY', 'DEEPSEEK_API') };
}
function findBinary(name: string): string {
  const directories = [process.env.SHELF_TOOLS_DIR || join(process.env.SHELF_PROJECT_DIR || process.cwd(), 'tools'), ...(process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) directories.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  for (const directory of directories) {
    const file = join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? `${name}.exe` : name);
    try { if (statSync(file).isFile()) return file; } catch { /* Optional program is not installed here. */ }
  }
  return '';
}
function toolPath(configured: string, name: string): string {
  try { if (configured && isAbsolute(configured) && statSync(configured).isFile()) return configured; } catch { /* Fall through to bundled tools and PATH. */ }
  return findBinary(name);
}
function cookieFilePath(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (!isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value)) throw new Error('Cookies 文件需要本机文件的绝对路径。');
  try { if (!statSync(value).isFile()) throw new Error(); } catch { throw new Error('Cookies 文件不存在或无法读取，请检查文件路径。'); }
  return resolve(value);
}

export class Config {
  private value: Settings;
  private providerKeys: Record<OfficialProvider, string> = { aliyun: '', deepseek: '' };
  private credentialSources: KeySources = { aliyun: 'none', deepseek: 'none' };
  private paperTokenSource: 'env'|'saved'|'none' = 'none';
  private envFile?: string;
  private pendingDataDir?: string;
  private activeDir: string;
  readonly file: string;
  get activeDataDir(): string { return this.activeDir; }

  constructor(configDir: string, defaultDataDir: string) {
    mkdirSync(configDir, { recursive: true }); this.file = join(configDir, 'settings.json');
    const saved = readSaved(this.file);
    const candidate = process.env.SHELF_ENV_FILE || saved.envFile || join(process.env.SHELF_PROJECT_DIR || process.cwd(), '.env');
    const env = { ...(existsSync(candidate) ? readEnv(candidate) : {}), ...process.env };
    if (existsSync(candidate)) this.envFile = resolve(candidate); else if (saved.envFile) this.envFile = saved.envFile;
    const envKeys = keysFromEnv(env);
    for (const provider of ['aliyun', 'deepseek'] as const) {
      const explicitSaved = saved.credentialSources?.[provider] === 'saved' && saved.providerKeys?.[provider];
      this.providerKeys[provider] = explicitSaved || envKeys[provider] || saved.providerKeys?.[provider] || '';
      this.credentialSources[provider] = explicitSaved ? 'saved' : envKeys[provider] ? 'env' : this.providerKeys[provider] ? saved.credentialSources?.[provider] || 'saved' : 'none';
    }
    const textProvider: ModelProvider = env.TEXT_BASE_URL ? inferProvider(env.TEXT_BASE_URL) : this.providerKeys.deepseek ? 'deepseek' : 'aliyun';
    const text: Settings['text'] = { provider: textProvider, baseUrl: env.TEXT_BASE_URL || PROVIDERS[textProvider].baseUrl, model: env.TEXT_MODEL || (textProvider === 'deepseek' ? 'deepseek-flash' : 'qwen3.8-flash'), apiKey: env.TEXT_API_KEY || '' };
    const vision: Settings['vision'] = { provider: env.VISION_BASE_URL ? inferProvider(env.VISION_BASE_URL) : 'aliyun', baseUrl: env.VISION_BASE_URL || PROVIDERS.aliyun.baseUrl, model: env.VISION_MODEL || 'qwen3.8-flash', apiKey: env.VISION_API_KEY || '', useTextModel: env.VISION_USE_TEXT_MODEL ? env.VISION_USE_TEXT_MODEL !== 'false' : !env.VISION_MODEL && !env.VISION_BASE_URL && !env.VISION_API_KEY };
    const defaults: Settings = {
      text, vision,
      mediaVision: { ...mediaVisionEndpoint({ text, vision }), apiKey: '' },
      transcription: { provider: env.TRANSCRIPTION_BASE_URL ? inferProvider(env.TRANSCRIPTION_BASE_URL) : 'aliyun', baseUrl: env.TRANSCRIPTION_BASE_URL || PROVIDERS.aliyun.baseUrl, model: env.TRANSCRIPTION_MODEL || 'qwen3-asr-flash', apiKey: env.TRANSCRIPTION_API_KEY || '', protocol: env.TRANSCRIPTION_PROTOCOL === 'openai' ? 'openai' : 'dashscope' },
      search: { ...DEEPSEEK_SEARCH, apiKey: '' },
      paperParsing: structuredClone(PAPER_PARSING),
      dataDir: resolve(env.SHELF_DATA_DIR || defaultDataDir), ytDlpPath: env.YT_DLP_PATH || '', ffmpegPath: env.FFMPEG_PATH || '', mediaCookiesPath: saved.mediaCookiesPath || env.MEDIA_COOKIES_PATH || '',
    };
    // An old directory-only save also persisted untouched empty model defaults.
    const legacyEmpty = !saved.schemaVersion && !saved.text?.apiKey && (!saved.text?.model || saved.text.model === 'qwen-plus');
    // Search always uses DeepSeek's official capability and shared provider key.
    // Legacy saved.search and SEARCH_* variables are deliberately not migrated:
    // a third-party credential must never become a DeepSeek credential.
    this.value = { ...defaults, ...saved, text: { ...defaults.text, ...(legacyEmpty ? {} : saved.text) }, vision: { ...defaults.vision, ...(legacyEmpty && !saved.vision?.apiKey ? {} : saved.vision) }, mediaVision: defaults.mediaVision, transcription: { ...defaults.transcription, ...saved.transcription }, search: { ...DEEPSEEK_SEARCH, apiKey: '' }, ytDlpPath: saved.ytDlpPath || defaults.ytDlpPath, ffmpegPath: saved.ffmpegPath || defaults.ffmpegPath, mediaCookiesPath: saved.mediaCookiesPath ?? defaults.mediaCookiesPath };
    this.value.paperParsing = paperParsingFromEnv(applyPaperParsing(PAPER_PARSING, saved.paperParsing), env).value;
    const envPaperToken = envValue(env, 'MINERU_API_TOKEN'), savedPaperToken = saved.paperParsing?.mineru?.apiToken;
    const savedPaperPreferred = saved.paperTokenSource === 'saved' && savedPaperToken && new URL(saved.paperParsing?.mineru?.baseUrl || PAPER_PARSING.mineru.baseUrl).origin === new URL(this.value.paperParsing.mineru.baseUrl).origin;
    if (savedPaperPreferred) this.value.paperParsing.mineru.apiToken = savedPaperToken;
    this.paperTokenSource = savedPaperPreferred ? 'saved' : envPaperToken ? 'env' : this.value.paperParsing.mineru.apiToken ? saved.paperTokenSource || 'saved' : 'none';
    this.pendingDataDir = saved.pendingDataDir;
    if (!saved.schemaVersion && saved.dataDir && resolve(saved.dataDir) !== resolve(defaultDataDir) && !existsSync(join(saved.dataDir, 'app.sqlite'))) { this.pendingDataDir = resolve(saved.dataDir); this.value.dataDir = defaults.dataDir; }
    for (const name of ['text', 'vision', 'transcription'] as const) {
      const endpoint = this.value[name]; endpoint.provider = inferProvider(endpoint.baseUrl);
      if (official(endpoint.provider) && endpoint.apiKey) {
        if (!this.providerKeys[endpoint.provider] || saved[name]?.apiKey) { this.providerKeys[endpoint.provider] = endpoint.apiKey; this.credentialSources[endpoint.provider] = saved[name]?.apiKey ? 'saved' : 'env'; }
        endpoint.apiKey = '';
      }
      if (endpoint.provider === 'deepseek' && endpoint.model === 'deepseek-v4.1-flash') endpoint.model = 'deepseek-flash';
    }
    // Historical mediaVision values never change the selected visual model or supply credentials.
    this.value.mediaVision = { ...mediaVisionEndpoint(this.value), apiKey: '' };
    this.value.dataDir = resolve(this.value.dataDir); this.activeDir = this.value.dataDir; this.persist();
  }
  private effectiveEndpoint(value: EndpointConfig, keys = this.providerKeys): EndpointConfig {
    const provider = value.provider || inferProvider(value.baseUrl);
    return { ...value, provider, apiKey: official(provider) && inferProvider(value.baseUrl) === provider ? keys[provider] : value.apiKey };
  }
  private validateModelSelection(value: Settings, keys: Record<OfficialProvider, string>): EndpointConfig {
    if (value.transcription.provider === 'aliyun') value.transcription.protocol = 'dashscope';
    if (value.transcription.provider === 'deepseek') throw new Error('DeepSeek 官方提供文本与图片能力；语音转写请选择阿里云 Qwen ASR 或其他转写服务。');
    if (!['dashscope', 'openai'].includes(value.transcription.protocol)) throw new Error('不支持的转写协议。');
    const visual = this.effectiveEndpoint(mediaVisionEndpoint(value), keys);
    if (modelPreset(visual.provider, visual.model)?.image === false) throw new Error(value.vision.useTextModel ? '当前研究主模型不支持图片。请在“视觉辅助”中取消“使用研究主模型理解图片”，并选择支持图片的模型。' : '当前视觉辅助模型不支持图片，请在“视觉辅助”中选择支持图片的模型。');
    return visual;
  }
  get(): Settings {
    const value = this.value, text = this.effectiveEndpoint(value.text);
    const vision = value.vision.useTextModel ? { ...text, useTextModel: true } : { ...this.effectiveEndpoint(value.vision), useTextModel: false };
    // Enumerate fields: the private provider key store never reaches the renderer.
    return { text, vision, mediaVision: mediaVisionEndpoint({ text, vision }), transcription: { ...this.effectiveEndpoint(value.transcription), protocol: value.transcription.protocol }, search: { ...DEEPSEEK_SEARCH, apiKey: this.providerKeys.deepseek }, paperParsing: structuredClone(value.paperParsing), dataDir: this.activeDir, ytDlpPath: toolPath(value.ytDlpPath, 'yt-dlp'), ffmpegPath: toolPath(value.ffmpegPath, 'ffmpeg'), mediaCookiesPath: value.mediaCookiesPath };
  }
  public(): PublicSettings {
    const value = this.get();
    const { apiToken, ...mineru } = value.paperParsing.mineru;
    const paperParsing: PublicSettings['paperParsing'] = { arxivHtmlBaseUrl: value.paperParsing.arxivHtmlBaseUrl, arxivHtmlTimeoutSeconds: value.paperParsing.arxivHtmlTimeoutSeconds, mineru: { ...mineru, hasToken: Boolean(apiToken), configured: Boolean(apiToken && mineru.baseUrl && mineru.model), source: this.paperTokenSource } };
    const endpoint = <T extends { apiKey: string; model?: string; baseUrl: string }>(v: T) => { const { apiKey, ...rest } = v; return { ...rest, hasKey: !!apiKey, configured: !!(apiKey && v.baseUrl && v.model) }; };
    return { text: endpoint(value.text), vision: endpoint(value.vision), mediaVision: endpoint(value.mediaVision), transcription: endpoint(value.transcription), search: endpoint(value.search), paperParsing, dataDir: this.activeDir, ytDlpPath: value.ytDlpPath, ffmpegPath: value.ffmpegPath, mediaCookiesPath: value.mediaCookiesPath, providers: { aliyun: { hasKey: !!this.providerKeys.aliyun, source: this.credentialSources.aliyun }, deepseek: { hasKey: !!this.providerKeys.deepseek, source: this.credentialSources.deepseek } }, envFile: this.envFile, pendingDataDir: this.pendingDataDir };
  }
  private persist(value = this.value, keys = this.providerKeys, sources = this.credentialSources, envFile = this.envFile, pendingDataDir = this.pendingDataDir, paperTokenSource = this.paperTokenSource): void {
    // Keep the legacy field readable without persisting a second, independent media credential.
    const saved: SavedConfig = { schemaVersion: 6, text: value.text, vision: value.vision, mediaVision: { ...mediaVisionEndpoint(value), apiKey: '' }, transcription: value.transcription, search: { ...DEEPSEEK_SEARCH, apiKey: '' }, paperParsing: value.paperParsing, paperTokenSource, dataDir: value.dataDir, ytDlpPath: value.ytDlpPath, ffmpegPath: value.ffmpegPath, mediaCookiesPath: value.mediaCookiesPath, providerKeys: keys, credentialSources: sources, envFile, pendingDataDir };
    const temporary = this.file + '.tmp'; writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 }); renameSync(temporary, this.file);
  }
  save(patch: SettingsPatch): PublicSettings {
    const next = structuredClone(this.value), keys = { ...this.providerKeys }, sources = { ...this.credentialSources };
    const incomingKeys = new Map<OfficialProvider, string>();
    const setOfficialKey = (provider: OfficialProvider, value: unknown) => {
      const key = credential(value, PROVIDERS[provider].label + ' API Key');
      if (!key) return;
      if (incomingKeys.has(provider) && incomingKeys.get(provider) !== key) throw new Error('同一提供方填写了不同的 API Key，请只在“服务密钥”中填写一次。');
      incomingKeys.set(provider, key); keys[provider] = key; sources[provider] = 'saved';
    };
    if (patch.providerKeys !== undefined) {
      if (!patch.providerKeys || typeof patch.providerKeys !== 'object' || Array.isArray(patch.providerKeys) || Object.keys(patch.providerKeys).some(key => !['aliyun', 'deepseek'].includes(key))) throw new Error('服务密钥配置格式无效。');
      for (const provider of ['aliyun', 'deepseek'] as const) if (patch.providerKeys[provider] !== undefined) setOfficialKey(provider, patch.providerKeys[provider]);
    }
    for (const name of ['text', 'vision', 'transcription'] as const) {
      const incoming = patch[name]; if (!incoming) continue;
      const prior = next[name], provider = incoming.provider || (incoming.baseUrl ? inferProvider(incoming.baseUrl) : prior.provider) || 'custom';
      if (!['aliyun', 'deepseek', 'custom'].includes(provider)) throw new Error('请选择支持的模型提供方。');
      if (provider === 'custom' && incoming.baseUrl && incoming.baseUrl.trim() !== prior.baseUrl) prior.apiKey = '';
      if (provider !== prior.provider) { prior.baseUrl = PROVIDERS[provider].baseUrl; prior.apiKey = ''; }
      prior.provider = provider;
      for (const field of ['baseUrl', 'model'] as const) if (typeof incoming[field] === 'string') prior[field] = incoming[field].trim();
      if (prior.baseUrl) {
        const url = new URL(prior.baseUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址需要不含密钥、查询参数的 HTTP 或 HTTPS 地址。');
        if (official(provider) && inferProvider(prior.baseUrl) !== provider) throw new Error('官方提供方只能使用对应官方地址；其他地址请选择“其他兼容服务”并单独填写密钥。');
      }
      if (incoming.apiKey !== undefined) {
        const key = credential(incoming.apiKey, 'API Key');
        if (official(provider)) { setOfficialKey(provider, key); prior.apiKey = ''; }
        else if (key) prior.apiKey = key;
      }
      if (provider === 'deepseek' && prior.model === 'deepseek-v4.1-flash') prior.model = 'deepseek-flash';
    }
    if (typeof patch.vision?.useTextModel === 'boolean') next.vision.useTextModel = patch.vision.useTextModel;
    if (patch.transcription?.protocol) next.transcription.protocol = patch.transcription.protocol;
    if (patch.search) {
      for (const field of ['provider', 'baseUrl', 'model'] as const) if (patch.search[field] !== undefined && patch.search[field] !== DEEPSEEK_SEARCH[field]) throw new Error('联网搜索固定使用 DeepSeek 官方服务，无需另选提供方、地址或模型。');
      if (patch.search.apiKey?.trim()) throw new Error('联网搜索复用 DeepSeek 官方密钥，请在模型服务中配置或导入 DEEPSEEK_API_KEY，无需单独填写搜索密钥。');
    }
    next.search = { ...DEEPSEEK_SEARCH, apiKey: '' };
    const mediaVision = this.validateModelSelection(next, keys);
    if (patch.mediaVision !== undefined) {
      const incoming = patch.mediaVision;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('媒体画面识别跟随视觉辅助，请在“视觉辅助”中配置模型和密钥。');
      const expected: Record<string, unknown> = { provider: mediaVision.provider, baseUrl: mediaVision.baseUrl, model: mediaVision.model, hasKey: Boolean(mediaVision.apiKey), configured: Boolean(mediaVision.apiKey && mediaVision.baseUrl && mediaVision.model) };
      for (const [field, value] of Object.entries(incoming)) {
        // Empty credentials from older settings forms are a no-op, never a separate key.
        if (field === 'apiKey') {
          if (typeof value !== 'string' || value.trim()) throw new Error('媒体画面识别复用视觉辅助的密钥，请在“视觉辅助”中配置，不要单独填写媒体密钥。');
        } else if (!Object.hasOwn(expected, field) || value !== expected[field]) throw new Error('媒体画面识别跟随视觉辅助，请在“视觉辅助”中配置模型和密钥。');
      }
    }
    next.mediaVision = { ...mediaVisionEndpoint(next), apiKey: '' };
    if (patch.paperParsing !== undefined) next.paperParsing = applyPaperParsing(next.paperParsing, patch.paperParsing);
    if (typeof patch.mediaCookiesPath === 'string') next.mediaCookiesPath = cookieFilePath(patch.mediaCookiesPath);
    for (const field of ['ytDlpPath', 'ffmpegPath'] as const) if (typeof patch[field] === 'string') next[field] = patch[field].trim();
    if (patch.dataDir && resolve(patch.dataDir) !== this.activeDir) throw new Error('请在“数据与工具”中使用“切换位置”，以安全搬迁或打开知识库。');
    const paperTokenSource = !next.paperParsing.mineru.apiToken ? 'none' : patch.paperParsing?.mineru?.apiToken?.trim() ? 'saved' : this.paperTokenSource;
    this.persist(next, keys, sources, this.envFile, this.pendingDataDir, paperTokenSource); this.value = next; this.providerKeys = keys; this.credentialSources = sources; this.paperTokenSource = paperTokenSource; return this.public();
  }
  activateDataDir(dataDir: string): PublicSettings {
    if (!isAbsolute(dataDir)) throw new Error('数据目录需要绝对路径。');
    const next = { ...this.value, dataDir: resolve(dataDir) }, previousPending = this.pendingDataDir; this.pendingDataDir = undefined;
    try { this.persist(next); } catch (error) { this.pendingDataDir = previousPending; throw error; }
    this.value = next; this.activeDir = next.dataDir; return this.public();
  }
  importEnvFile(filePath: string): PublicSettings {
    if (!isAbsolute(filePath)) throw new Error('请选择本地 .env 配置文件。');
    const env = readEnv(filePath), incomingKeys = keysFromEnv(env), keys = { ...this.providerKeys }, sources = { ...this.credentialSources }, next = structuredClone(this.value);
    const paper = paperParsingFromEnv(next.paperParsing, env); next.paperParsing = paper.value;
    let found = paper.found;
    for (const provider of ['aliyun', 'deepseek'] as const) if (incomingKeys[provider]) { keys[provider] = incomingKeys[provider]; sources[provider] = 'env'; found = true; }
    // Pick an available initial provider before applying explicit model fields,
    // so TEXT_MODEL never gets discarded by a later default-model assignment.
    if (!this.get().text.apiKey && keys.deepseek && !envValue(env, 'TEXT_API_KEY', 'TEXT_BASE_URL')) { next.text = { provider: 'deepseek', baseUrl: PROVIDERS.deepseek.baseUrl, model: 'deepseek-flash', apiKey: '' }; next.vision.useTextModel = true; }
    for (const [name, prefix] of [['text', 'TEXT'], ['vision', 'VISION'], ['transcription', 'TRANSCRIPTION']] as const) {
      const baseUrl = envValue(env, `${prefix}_BASE_URL`), model = envValue(env, `${prefix}_MODEL`), apiKey = envValue(env, `${prefix}_API_KEY`);
      if (!baseUrl && !model && !apiKey) continue;
      found = true; const target = next[name];
      if (baseUrl && baseUrl !== target.baseUrl) { target.baseUrl = baseUrl; target.apiKey = ''; }
      const url = new URL(target.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('配置文件中的模型服务地址无效。');
      target.provider = inferProvider(target.baseUrl);
      if (model) target.model = model;
      if (apiKey) {
        const key = credential(apiKey, `${prefix}_API_KEY`);
        if (official(target.provider)) { keys[target.provider] = key; sources[target.provider] = 'env'; target.apiKey = ''; }
        else target.apiKey = key;
      }
    }
    const useTextModel = envValue(env, 'VISION_USE_TEXT_MODEL'), protocol = envValue(env, 'TRANSCRIPTION_PROTOCOL');
    if (useTextModel) { if (!['true', 'false'].includes(useTextModel.toLowerCase())) throw new Error('VISION_USE_TEXT_MODEL 需要填写 true 或 false。'); next.vision.useTextModel = useTextModel.toLowerCase() === 'true'; found = true; }
    else if (envValue(env, 'VISION_MODEL', 'VISION_BASE_URL', 'VISION_API_KEY')) next.vision.useTextModel = false;
    if (protocol) { if (!['dashscope', 'openai'].includes(protocol)) throw new Error('不支持的转写协议。'); next.transcription.protocol = protocol as 'dashscope'|'openai'; found = true; }
    if (next.text.provider === 'deepseek' && next.text.model === 'deepseek-v4.1-flash') next.text.model = 'deepseek-flash';
    if (next.vision.provider === 'deepseek' && next.vision.model === 'deepseek-v4.1-flash') next.vision.model = 'deepseek-flash';
    if (!found) throw new Error('没有找到可用模型或论文解析配置。支持 DASHSCOPE_API_KEY、DEEPSEEK_API_KEY、MINERU_API_TOKEN、ARXIV_HTML_* 和 MINERU_*，以及已有模型密钥别名。');
    this.validateModelSelection(next, keys);
    next.mediaVision = { ...mediaVisionEndpoint(next), apiKey: '' };
    const associated = resolve(filePath), paperTokenSource = !next.paperParsing.mineru.apiToken ? 'none' : envValue(env, 'MINERU_API_TOKEN') ? 'env' : this.paperTokenSource;
    this.persist(next, keys, sources, associated, this.pendingDataDir, paperTokenSource); this.value = next; this.providerKeys = keys; this.credentialSources = sources; this.envFile = associated; this.paperTokenSource = paperTokenSource; return this.public();
  }
  reloadEnv(): PublicSettings {
    if (!this.envFile || !existsSync(this.envFile)) throw new Error('尚未关联可读取的 .env 文件，请点击“导入 .env”。');
    return this.importEnvFile(this.envFile);
  }
  redact(input: unknown): string {
    let text = input instanceof Error ? input.message : String(input);
    for (const value of [this.providerKeys.aliyun, this.providerKeys.deepseek, this.value.text.apiKey, this.value.vision.apiKey, this.value.transcription.apiKey, this.value.paperParsing.mineru.apiToken]) if (value) text = text.split(value).join('[密钥已隐藏]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [密钥已隐藏]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]').replace(/(MINERU_API_TOKEN\s*[=:]\s*)\S+/gi, '$1[密钥已隐藏]');
  }
}
