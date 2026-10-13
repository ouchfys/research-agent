import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, FolderOpen, Info, KeyRound, RefreshCw, Save, Settings2, SlidersHorizontal } from 'lucide-react';
import type { ModelProvider, PublicSettings, Settings, StorageInspection } from '../shared/types';
import { ASR_PRESETS, inferProvider, modelPreset, MODEL_PRESETS, PROVIDERS } from '../shared/providers';
import { ErrorNotice, errorText, Modal } from './ui';
import './settings.css';

interface Props { settings: PublicSettings; close: () => void; saved: () => Promise<void>; locked: boolean }
type Endpoint = 'text' | 'vision' | 'transcription';
type Section = 'keys' | 'models' | 'storage' | 'advanced';
const sections = [{ id: 'keys', label: 'API 密钥', icon: KeyRound }, { id: 'models', label: '模型分工', icon: SlidersHorizontal }, { id: 'storage', label: '文件存放', icon: FolderOpen }, { id: 'advanced', label: '高级设置', icon: Settings2 }] as const;
const labels: Record<Endpoint, string> = { text: '研究主模型', vision: '图片理解', transcription: '语音转写' };
const descriptions: Record<Endpoint, string> = { text: '阅读材料、研究对话和整理知识文档。', vision: '识别图片、图文作品和视频抽样画面。', transcription: '将录音与视频中的语音转成文字。' };
const emptyKeys = () => ({ deepseek: '', aliyun: '' });
function editable(settings: PublicSettings): Settings {
  const endpoint = (item: PublicSettings['text']) => ({ provider: item.provider, model: item.model, baseUrl: item.baseUrl, apiKey: '' });
  const { hasToken: _hasToken, configured: _configured, source: _source, ...mineru } = settings.paperParsing.mineru;
  return { text: endpoint(settings.text), vision: { ...endpoint(settings.vision), useTextModel: settings.vision.useTextModel }, mediaVision: endpoint(settings.mediaVision), transcription: { ...endpoint(settings.transcription), protocol: settings.transcription.protocol }, search: { ...settings.search, apiKey: '' }, paperParsing: { ...settings.paperParsing, mineru: { ...mineru, apiToken: '' } }, dataDir: settings.dataDir, ytDlpPath: settings.ytDlpPath, ffmpegPath: settings.ffmpegPath, mediaCookiesPath: settings.mediaCookiesPath };
}
function fingerprint(settings: Settings) { const { dataDir: _dataDir, search: _search, mediaVision: _mediaVision, ...form } = settings; return JSON.stringify(form); }
function providerOf(endpoint: { provider?: ModelProvider; baseUrl: string }) { return endpoint.provider || inferProvider(endpoint.baseUrl); }
function sourceText(source?: 'env' | 'saved' | 'none') { return source === 'env' ? '来自 .env 文件' : source === 'saved' ? '已保存在本机' : '尚未填写'; }

function SecretInput({ label, value, onChange, hasKey, disabled, hint }: { label: string; value: string; onChange: (value: string) => void; hasKey: boolean; disabled: boolean; hint?: string }) {
  const [visible, setVisible] = useState(false);
  return <label className="settings-secret-label">{label}<span className="settings-secret"><input type={visible ? 'text' : 'password'} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder={hasKey ? '已配置；输入新密钥可替换，留空保留' : '粘贴你的 API 密钥'} /><button type="button" className="icon-button" disabled={disabled || !value} aria-label={visible ? `隐藏${label}` : `显示${label}`} title={visible ? '隐藏新输入的密钥' : '仅显示新输入的密钥'} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>{hint && <span className="field-help">{hint}</span>}</label>;
}

export default function SettingsDialog({ settings, close, saved, locked }: Props) {
  const [section, setSection] = useState<Section>('keys');
  const [value, setValue] = useState<Settings>(() => editable(settings));
  const [baseline, setBaseline] = useState(() => fingerprint(editable(settings)));
  const [known, setKnown] = useState(settings);
  const [providerKeys, setProviderKeys] = useState(emptyKeys);
  const [destination, setDestination] = useState(settings.pendingDataDir || '');
  const [storageMode, setStorageMode] = useState<'move' | 'open'>('move');
  const [preview, setPreview] = useState<StorageInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState<'save' | 'env' | 'storage' | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);
  const dirty = baseline !== fingerprint(value) || Boolean(providerKeys.deepseek.trim() || providerKeys.aliyun.trim());
  const disabled = locked || Boolean(busy);
  useEffect(() => { setKnown(settings); }, [settings]);
  useEffect(() => { if (dirty) setSuccess(''); }, [dirty]);
  useEffect(() => { if (error || success) pageRef.current?.scrollTo({ top: 0 }); }, [error, success]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (section !== 'storage' || !destination.trim()) { setInspecting(false); return; }
    setInspecting(true);
    const timer = setTimeout(() => {
      window.shelf.call<StorageInspection>('storage.inspect', { dataDir: destination.trim() }).then(result => {
        if (!active) return;
        setPreview(result);
        if (result.recommendedMode) setStorageMode(result.recommendedMode);
      }).catch(cause => {
        if (active) setPreview({ requestedPath: destination.trim(), exists: false, status: 'invalid', canCopy: false, canOpen: false, message: errorText(cause) });
      }).finally(() => { if (active) setInspecting(false); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [destination, section, known.dataDir]);

  function apply(next: PublicSettings) { const form = editable(next); setKnown(next); setValue(form); setBaseline(fingerprint(form)); setProviderKeys(emptyKeys()); setCloseRequested(false); }
  function reset() { apply(known); setError(''); setSuccess('已还原为当前保存的配置。'); }
  function requestClose() { if (busy) return; if (dirty) setCloseRequested(true); else close(); }
  function keyState(name: Endpoint) {
    const provider = providerOf(value[name]);
    if (provider !== 'custom') return { hasKey: Boolean(providerKeys[provider].trim() || known.providers[provider].hasKey), text: providerKeys[provider].trim() ? '新密钥待保存' : sourceText(known.providers[provider].source) };
    const unchanged = providerOf(known[name]) === 'custom' && known[name].baseUrl === value[name].baseUrl;
    return { hasKey: Boolean(value[name].apiKey.trim() || (unchanged && known[name].hasKey)), text: value[name].apiKey.trim() ? '新密钥待保存' : unchanged && known[name].hasKey ? '已保存在本机' : '尚未填写' };
  }
  function updateEndpoint(name: Endpoint, patch: Partial<Settings[Endpoint]>) {
    setValue(current => {
      const next = { ...current, [name]: { ...current[name], ...patch } };
      if (name === 'text' && next.vision.useTextModel !== false && modelPreset(providerOf(next.text), next.text.model)?.image === false) {
        const provider = providerOf(next.text), fallback = MODEL_PRESETS[provider].find(model => model.image);
        next.vision = { ...next.vision, useTextModel: false, ...(fallback ? { provider, model: fallback.id, baseUrl: next.text.baseUrl, apiKey: '' } : {}) };
      }
      return next;
    });
    setSuccess('');
  }
  function changeProvider(name: Endpoint, provider: ModelProvider) {
    const presets = name === 'transcription' ? provider === 'aliyun' ? ASR_PRESETS : [] : MODEL_PRESETS[provider].filter(model => name !== 'vision' || model.image);
    updateEndpoint(name, { provider, baseUrl: PROVIDERS[provider].baseUrl, model: presets[0]?.id || '', apiKey: '', ...(name === 'transcription' ? { protocol: provider === 'aliyun' ? 'dashscope' : 'openai' } : {}) });
  }
  async function submit(closeAfter = false) {
    if (disabled) return;
    if (!dirty) { if (closeAfter) close(); return; }
    setBusy('save'); setError(''); setSuccess('');
    try {
      const patch = { text: value.text, vision: value.vision, transcription: value.transcription, providerKeys, paperParsing: value.paperParsing, ...(value.ytDlpPath !== known.ytDlpPath ? { ytDlpPath: value.ytDlpPath } : {}), ...(value.ffmpegPath !== known.ffmpegPath ? { ffmpegPath: value.ffmpegPath } : {}), ...(value.mediaCookiesPath !== known.mediaCookiesPath ? { mediaCookiesPath: value.mediaCookiesPath } : {}) };
      const next = await window.shelf.call<PublicSettings>('settings.save', { settings: patch });
      apply(next); await saved(); setSuccess('配置已保存，下次调用立即生效。');
      if (closeAfter) close();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  }
  async function readEnv(choose: boolean) {
    if (dirty || disabled) return;
    setBusy('env'); setError(''); setSuccess('');
    try {
      const next = choose ? await window.shelf.importEnv() : await window.shelf.call<PublicSettings>('settings.reload-env');
      if (next) { apply(next); await saved(); setSuccess('已读取配置文件，密钥和模型选择已更新。'); }
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  }
  async function chooseDirectory() {
    setError('');
    try { const path = await window.shelf.chooseDirectory(); if (path) { setDestination(path); setPreview(null); setSuccess(''); } } catch (cause) { setError(errorText(cause)); }
  }
  async function switchStorage() {
    if (disabled || dirty || inspecting || !preview || !(storageMode === 'move' ? preview.canCopy : preview.canOpen)) return;
    setBusy('storage'); setError(''); setSuccess('');
    try {
      const next = await window.shelf.call<PublicSettings>('storage.switch', { dataDir: destination.trim(), mode: storageMode });
      apply(next); setDestination(''); setPreview(null); await saved();
      setSuccess(storageMode === 'move' ? '资料已复制，现在使用新位置。原文件夹仍完整保留。' : '已切换到所选知识库，当前文件位置已更新。');
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  }
  function endpointFields(name: Endpoint) {
    const provider = providerOf(value[name]);
    const presets = name === 'transcription' ? provider === 'aliyun' ? ASR_PRESETS : [] : MODEL_PRESETS[provider].filter(model => name !== 'vision' || model.image);
    const presetModel = presets.some(item => item.id === value[name].model);
    const key = keyState(name);
    return <>
      <div className="settings-model-fields"><label>服务商<select aria-label={`${labels[name]}服务商`} disabled={disabled} value={provider} onChange={event => changeProvider(name, event.target.value as ModelProvider)}>{(Object.keys(PROVIDERS) as ModelProvider[]).filter(item => name !== 'transcription' || item !== 'deepseek').map(item => <option key={item} value={item}>{PROVIDERS[item].label}</option>)}</select></label>
        {presets.length > 0 && <label>模型<select aria-label={`${labels[name]}模型`} disabled={disabled} value={presetModel ? value[name].model : '__custom'} onChange={event => updateEndpoint(name, { model: event.target.value === '__custom' ? '' : event.target.value })}>{presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="__custom">其他模型（手动填写）</option></select></label>}
        {!presetModel && <label>模型 ID<input aria-label={`${labels[name]}模型 ID`} disabled={disabled} value={value[name].model} onChange={event => updateEndpoint(name, { model: event.target.value })} autoComplete="off" spellCheck={false} placeholder="服务商提供的模型名称" /></label>}
      </div>
      {provider === 'custom' ? <><label>服务地址<input disabled={disabled} type="url" value={value[name].baseUrl} onChange={event => updateEndpoint(name, { baseUrl: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} /></label><SecretInput label={`${labels[name]} API Key`} value={value[name].apiKey} onChange={apiKey => updateEndpoint(name, { apiKey })} hasKey={key.hasKey} disabled={disabled} /></> : null}
      <p className="settings-key-state"><span className={`status-dot ${key.hasKey ? 'is-ready' : ''}`} />{key.hasKey ? `${provider === 'custom' ? '密钥' : PROVIDERS[provider].label} · ${key.text}` : '还没有可用的密钥'}{provider !== 'custom' && <button type="button" className="text-button" onClick={() => setSection('keys')}>{key.hasKey ? '管理密钥' : '填写密钥'}</button>}</p>
      <details className="settings-inline-details"><summary>连接设置</summary><div className="settings-advanced-body">{provider !== 'custom' && <label>API 地址<input disabled={disabled} type="url" value={value[name].baseUrl} onChange={event => updateEndpoint(name, { baseUrl: event.target.value })} autoComplete="off" spellCheck={false} /><span className="field-help">已填写官方地址。百炼密钥与地址需属于同一地域。</span></label>}{name === 'transcription' && <label>转写协议<select disabled={disabled} value={value.transcription.protocol} onChange={event => updateEndpoint(name, { protocol: event.target.value as 'openai' | 'dashscope' })}><option value="dashscope">阿里云 Qwen ASR</option><option value="openai">OpenAI 兼容音频转写</option></select></label>}</div></details>
    </>;
  }

  return <Modal title="设置" close={requestClose} wide><form className="settings-shell" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <nav className="settings-navigation" aria-label="设置分组">{sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => { setSection(id); setError(''); }}><Icon size={17} /><span>{label}</span></button>)}<p>配置只保存在本机</p></nav>
    <div className="settings-page" key={section} ref={pageRef}>
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}{success && <div className="notice success" role="status"><Check size={17} />{success}</div>}{locked && <div className="notice warning">请先处理知识冲突，再修改配置。</div>}
      {section === 'keys' && <>
        <header className="settings-page-heading"><h3>连接你的 AI 服务</h3><p>每个服务商只填一次，模型会共用对应密钥。</p></header>
        {(['deepseek', 'aliyun'] as const).map(provider => <section className="settings-provider" key={provider}>
          <div className="settings-row-heading"><h4>{PROVIDERS[provider].label}</h4><span className={`settings-credential-state ${providerKeys[provider].trim() ? 'pending' : known.providers[provider].hasKey ? 'ready' : ''}`}>{providerKeys[provider].trim() ? '新密钥待保存' : sourceText(known.providers[provider].source)}</span></div>
          <div className="settings-provider-help"><p className="field-help">{provider === 'deepseek' ? '用于 DeepSeek 模型和联网搜索。' : '用于 Qwen 语音转写及百炼上的文本、视觉模型。'}</p><button type="button" className="text-button" onClick={() => void window.shelf.openExternal(provider === 'deepseek' ? 'https://platform.deepseek.com/api_keys' : 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key').catch(cause => setError(errorText(cause)))}>{provider === 'deepseek' ? '获取 API Key' : '获取 API Key（北京）'}</button></div>
          <SecretInput label={`${provider === 'deepseek' ? 'DeepSeek' : '阿里云百炼'} API Key`} value={providerKeys[provider]} onChange={key => { setProviderKeys(current => ({ ...current, [provider]: key })); setSuccess(''); }} hasKey={known.providers[provider].hasKey} disabled={disabled} />
        </section>)}
        <details className="settings-detail-section"><summary><span>PDF 论文解析</span><span className={known.paperParsing.mineru.hasToken ? 'settings-detail-ready' : 'muted'}>{known.paperParsing.mineru.hasToken ? 'MinerU 已配置' : '可选 · MinerU Token'}</span></summary><div className="settings-advanced-body"><p className="field-help">arXiv 优先读取 HTML 正文。需要解析 PDF 时，上传原文件到 MinerU 服务。</p><SecretInput label="MinerU Token" value={value.paperParsing.mineru.apiToken} onChange={apiToken => { setValue(current => ({ ...current, paperParsing: { ...current.paperParsing, mineru: { ...current.paperParsing.mineru, apiToken } } })); setSuccess(''); }} hasKey={known.paperParsing.mineru.hasToken} disabled={disabled} /><p className="settings-key-state"><span className={`status-dot ${known.paperParsing.mineru.hasToken ? 'is-ready' : ''}`} />{value.paperParsing.mineru.apiToken.trim() ? '新 Token 待保存' : known.paperParsing.mineru.hasToken ? '已配置，留空保留' : '尚未配置，PDF 解析暂不可用'}</p></div></details>
        <p className="settings-security-note"><Info size={15} />已有密钥不会返回界面；“已配置”表示已保存，未进行付费调用测试。</p>
        <button type="button" className="text-button settings-next" onClick={() => setSection('models')}>查看模型分工</button>
      </>}
      {section === 'models' && <>
        <header className="settings-page-heading"><h3>让不同模型各司其职</h3><p>选择模型即可，官方连接地址已自动填写。</p></header>
        {(['text', 'vision', 'transcription'] as const).map(name => <section className="settings-model-role" key={name}><div className="settings-role-heading"><h4>{labels[name]}</h4><p>{descriptions[name]}</p></div>
          {name === 'vision' && <><label className="checkbox-label"><input type="checkbox" disabled={disabled || (value.vision.useTextModel === false && modelPreset(providerOf(value.text), value.text.model)?.image === false)} checked={value.vision.useTextModel !== false} onChange={event => updateEndpoint('vision', { useTextModel: event.target.checked })} /><span>与研究主模型共用</span></label>{modelPreset(providerOf(value.text), value.text.model)?.image === false && <p className="field-help">{value.vision.useTextModel === false ? '当前主模型仅支持文本，图片使用下方独立模型。' : '当前主模型不支持图片，请取消共用，再选择独立的视觉模型。'}</p>}{value.vision.useTextModel !== false && <p className="settings-model-summary">{MODEL_PRESETS[providerOf(value.text)].find(item => item.id === value.text.model)?.label || value.text.model || '请先选择研究主模型'}</p>}</>}
          {(name !== 'vision' || value.vision.useTextModel === false) && endpointFields(name)}
        </section>)}
        <div className="settings-search-note"><h4>联网搜索</h4><p>使用 DeepSeek 官方搜索，共用 DeepSeek 密钥，无需另外配置。搜索请求单独计费。</p></div>
      </>}
      {section === 'storage' && <>
        <header className="settings-page-heading"><h3>文件存放在哪里</h3><p>文档、来源、版本和对话一起保存在知识库文件夹中。</p></header>
        <section className="settings-current-library"><div className="settings-row-heading"><h4>正在使用</h4><button type="button" className="text-button" onClick={() => void window.shelf.openPath(known.dataDir).catch(cause => setError(errorText(cause)))}><FolderOpen size={15} />打开文件夹</button></div><code>{known.dataDir}</code></section>
        <section className="settings-storage-change"><h4>选择新的存放位置</h4><p className="field-help">切换立即生效，无需重启。</p>
          <div className="settings-destination"><button type="button" className="secondary" disabled={disabled} onClick={() => void chooseDirectory()}><FolderOpen size={16} />选择文件夹</button><span>{destination ? '已选择目标位置' : '推荐使用文件夹选择器'}</span></div>
          <label>目标文件夹<input disabled={disabled} value={destination} onChange={event => { setDestination(event.target.value); setPreview(null); setSuccess(''); }} placeholder="选择文件夹，或粘贴完整路径" autoComplete="off" spellCheck={false} /></label>
          {inspecting && <p className="settings-storage-preview" role="status">正在检查目标文件夹…</p>}
          {preview && !inspecting && <div className={`settings-storage-preview ${preview.status === 'invalid' ? 'invalid' : ''}`} role="status"><strong>{preview.status === 'library' ? `已有知识库${preview.documentCount === undefined ? '' : ` · ${preview.documentCount} 篇文档`}` : preview.status === 'current' ? '这是当前知识库' : preview.status === 'invalid' ? '此位置暂不可用' : preview.status === 'empty' ? '这是一个空文件夹' : '将创建新文件夹'}</strong><p>{preview.message}</p>{preview.targetPath && preview.targetPath !== destination.trim() && <code>{preview.targetPath}</code>}</div>}
          <fieldset className="settings-storage-modes" disabled={disabled || inspecting}><legend>如何使用这个位置</legend><label className={storageMode === 'move' ? 'selected' : ''}><input type="radio" name="storage-mode" value="move" checked={storageMode === 'move'} disabled={Boolean(preview && !preview.canCopy)} onChange={() => setStorageMode('move')} /><span><strong>把当前资料复制到新位置</strong><small>适合更换磁盘。复制完整知识库，保留原文件夹。</small></span></label><label className={storageMode === 'open' ? 'selected' : ''}><input type="radio" name="storage-mode" value="open" checked={storageMode === 'open'} disabled={Boolean(preview && !preview.canOpen)} onChange={() => setStorageMode('open')} /><span><strong>打开另一个知识库</strong><small>已有资料直接打开；空文件夹会创建空库。</small></span></label></fieldset>
          {dirty && <p className="settings-unsaved-hint">先保存或还原下方未保存的配置，再切换知识库。</p>}
          <button type="button" className="primary settings-storage-apply" disabled={disabled || dirty || inspecting || !preview || !(storageMode === 'move' ? preview.canCopy : preview.canOpen)} onClick={() => void switchStorage()}><FolderOpen size={16} />{busy === 'storage' ? '正在切换，请稍候…' : storageMode === 'move' ? '复制资料并切换' : preview?.status === 'library' ? '打开这个知识库' : '创建空库并切换'}</button>
        </section>
      </>}
      {section === 'advanced' && <>
        <header className="settings-page-heading"><h3>高级设置</h3><p>常用功能已自动配置，通常无需修改这些选项。</p></header>
        <details className="settings-detail-section"><summary><span>从 .env 导入配置</span><span className="muted">可选</span></summary><div className="settings-advanced-body"><p className="field-help">适合已有配置文件的用户。读取后会更新密钥、模型和论文解析设置。</p>{known.envFile && <p className="settings-env-path">已关联文件<code>{known.envFile}</code></p>}{dirty && <p className="settings-unsaved-hint">先保存或还原未保存的修改，再读取配置文件。</p>}<div className="settings-actions">{known.envFile && <button type="button" className="secondary" disabled={disabled || dirty} onClick={() => void readEnv(false)}><RefreshCw size={15} />{busy === 'env' ? '读取中…' : '重新读取'}</button>}<button type="button" className="secondary" disabled={disabled || dirty} onClick={() => void readEnv(true)}><FolderOpen size={15} />选择 .env 文件</button></div></div></details>
        <details className="settings-detail-section"><summary><span>媒体下载与识别</span><span className={known.ytDlpPath && known.ffmpegPath ? 'settings-detail-ready' : 'muted'}>{known.ytDlpPath && known.ffmpegPath ? '工具已就绪' : '自动查找'}</span></summary><div className="settings-advanced-body"><p className="field-help">完整安装包自带 yt-dlp、FFmpeg 和 FFprobe。分别负责下载媒体、提取音轨与画面，留空会自动查找。</p><label>yt-dlp 路径<input disabled={disabled} value={value.ytDlpPath} onChange={event => setValue(current => ({ ...current, ytDlpPath: event.target.value }))} placeholder="自动查找 yt-dlp.exe" spellCheck={false} /></label><label>FFmpeg 路径<input disabled={disabled} value={value.ffmpegPath} onChange={event => setValue(current => ({ ...current, ffmpegPath: event.target.value }))} placeholder="自动查找 ffmpeg.exe" spellCheck={false} /></label><label>Cookies 文件（可选）<input disabled={disabled} value={value.mediaCookiesPath} onChange={event => setValue(current => ({ ...current, mediaCookiesPath: event.target.value }))} placeholder="本人导出的 Netscape cookies.txt 完整路径" autoComplete="off" spellCheck={false} /></label><p className="field-help">仅在来源需要登录时使用。不会自动读取其他浏览器的登录状态；清空并保存即可停用。</p></div></details>
        <details className="settings-detail-section"><summary><span>论文解析连接</span></summary><div className="settings-advanced-body"><label>arXiv HTML 地址<input disabled={disabled} type="url" value={value.paperParsing.arxivHtmlBaseUrl} onChange={event => setValue(current => ({ ...current, paperParsing: { ...current.paperParsing, arxivHtmlBaseUrl: event.target.value } }))} spellCheck={false} /></label><label>MinerU API 地址<input disabled={disabled} type="url" value={value.paperParsing.mineru.baseUrl} onChange={event => setValue(current => ({ ...current, paperParsing: { ...current.paperParsing, mineru: { ...current.paperParsing.mineru, baseUrl: event.target.value } } }))} spellCheck={false} /></label><label>MinerU 模型<input disabled={disabled} value={value.paperParsing.mineru.model} onChange={event => setValue(current => ({ ...current, paperParsing: { ...current.paperParsing, mineru: { ...current.paperParsing.mineru, model: event.target.value } } }))} spellCheck={false} /></label><p className="field-help">Token 在“API 密钥 → PDF 论文解析”填写。</p></div></details>
      </>}
    </div>
    <footer className="settings-footer">
      {closeRequested ? <div className="settings-close-prompt" role="alert"><strong>有未保存的修改</strong><div><button type="button" className="text-button" onClick={() => setCloseRequested(false)}>继续编辑</button><button type="button" className="secondary" disabled={Boolean(busy)} onClick={close}>放弃修改并关闭</button><button type="button" className="primary" disabled={disabled} onClick={() => void submit(true)}><Save size={16} />保存并关闭</button></div></div> : <><span className={`settings-save-state ${dirty ? 'pending' : ''}`} role="status">{busy ? busy === 'save' ? '正在保存…' : busy === 'storage' ? '正在切换知识库…' : '正在读取配置…' : dirty ? '有未保存的修改' : '配置已保存'}</span><div className="settings-footer-actions">{dirty && <button type="button" className="text-button" disabled={disabled} onClick={reset}>还原修改</button>}<button className="secondary" type="button" disabled={Boolean(busy)} onClick={requestClose}>关闭</button><button className="primary" type="submit" disabled={disabled || !dirty}><Save size={16} />{busy === 'save' ? '保存中…' : '保存配置'}</button></div></>}
    </footer>
  </form></Modal>;
}
