import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsDialog from '../../../src/renderer/SettingsDialog';
import '../../../src/renderer/styles.css';
import type { PublicSettings, ShelfAPI } from '../../../src/shared/types';

// UI-only public fixtures. This preview never contacts the app service or real APIs.
let configuration: PublicSettings = {
  text: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', configured: true, hasKey: true },
  vision: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', useTextModel: false, configured: true, hasKey: true },
  mediaVision: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', configured: true, hasKey: true },
  transcription: { provider: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-asr-flash', protocol: 'dashscope', configured: true, hasKey: true },
  search: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-flash', configured: true, hasKey: true },
  paperParsing: { arxivHtmlBaseUrl: 'https://arxiv.org/html', arxivHtmlTimeoutSeconds: 60, mineru: { baseUrl: 'https://mineru.net/api/v4', model: 'vlm', hasToken: false, configured: false, source: 'none', timeoutSeconds: 600, pollIntervalSeconds: 4 } },
  dataDir: 'E:\\研究资料\\个人知识库', ytDlpPath: 'C:\\研究书架\\tools\\yt-dlp.exe', ffmpegPath: 'C:\\研究书架\\tools\\ffmpeg.exe', mediaCookiesPath: '',
  providers: { deepseek: { hasKey: true, source: 'saved' }, aliyun: { hasKey: true, source: 'env' } }, envFile: 'E:\\研究书架\\.env',
};
// Legacy selection remains editable: the user can uncheck sharing with a text-only model.
if (new URLSearchParams(location.search).has('legacyVision')) configuration.vision.useTextModel = true;
const qa = { calls: [] as string[], opened: [] as string[], closed: false, get settings() { return structuredClone(configuration); } };
Object.assign(window, { __settingsQa: qa });
window.shelf = {
  async call(method, payload: any) {
    qa.calls.push(method);
    if (method === 'storage.inspect') {
      const current = payload.dataDir === configuration.dataDir;
      const library = payload.dataDir.includes('已有库');
      const invalid = payload.dataDir.includes('不可用');
      return { requestedPath: payload.dataDir, targetPath: payload.dataDir, status: current ? 'current' : invalid ? 'invalid' : library ? 'library' : 'empty', exists: true, canCopy: !current && !library && !invalid, canOpen: !current && !invalid, recommendedMode: library ? 'open' : 'move', message: current ? '这是正在使用的知识库。' : invalid ? '目录内有其他文件，请选择空文件夹或已有知识库。' : library ? '可以打开这个知识库；当前库会保留。' : '可以复制当前资料，或新建一个空知识库。', ...(library ? { documentCount: 24 } : {}) };
    }
    if (method === 'settings.save') {
      const patch = payload.settings;
      for (const name of ['text', 'vision', 'transcription']) if (patch[name]) { const { apiKey: _key, ...model } = patch[name]; configuration[name] = { ...configuration[name], ...model }; }
      for (const provider of ['deepseek', 'aliyun'] as const) if (patch.providerKeys?.[provider]?.trim()) configuration.providers[provider] = { hasKey: true, source: 'saved' };
      if (patch.paperParsing) { const { apiToken, ...mineru } = patch.paperParsing.mineru; configuration.paperParsing = { ...patch.paperParsing, mineru: { ...configuration.paperParsing.mineru, ...mineru, ...(apiToken?.trim() ? { hasToken: true, configured: true, source: 'saved' } : {}) } }; }
      for (const name of ['ytDlpPath', 'ffmpegPath', 'mediaCookiesPath']) if (name in patch) configuration[name] = patch[name];
      return structuredClone(configuration);
    }
    if (method === 'storage.switch') { configuration.dataDir = payload.dataDir; return structuredClone(configuration); }
    if (method === 'settings.reload-env') return structuredClone(configuration);
    throw new Error(`Unexpected preview method: ${method}`);
  },
  async chooseDirectory() { return 'D:\\新的知识库'; }, async importEnv() { qa.calls.push('importEnv'); return structuredClone(configuration); },
  async openPath(path: string) { qa.opened.push(path); }, async openExternal(url: string) { qa.opened.push(url); }, async chooseFiles() { return []; }, onEvent() { return () => {}; },
} as ShelfAPI;

function Preview() {
  const [settings, setSettings] = useState(configuration);
  const [open, setOpen] = useState(true);
  return <><p style={{ padding: 24, color: '#5b6473', fontSize: 13 }}>设置界面隔离预览 · 所有密钥与文件操作均为示例</p>{open ? <SettingsDialog settings={settings} close={() => { qa.closed = true; setOpen(false); }} saved={async () => setSettings(structuredClone(configuration))} locked={false} /> : <button className="secondary" onClick={() => { qa.closed = false; setOpen(true); }}>重新打开设置</button>}</>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
