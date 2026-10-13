import type { ModelProvider } from './types';

export const PROVIDERS: Record<ModelProvider, { label: string; baseUrl: string }> = {
  deepseek: { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com' },
  aliyun: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  custom: { label: '其他兼容服务', baseUrl: '' },
};
export interface ModelPreset { id: string; label: string; image: boolean; contextWindow: number }
// Official documented identifiers, checked 2026-10-05. Provider identifiers are
// intentionally separate: DeepSeek's own API uses deepseek-flash and deepseek-v4-pro.
export const MODEL_PRESETS: Record<ModelProvider, ModelPreset[]> = {
  deepseek: [
    { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash · 文本与图片', image: true, contextWindow: 1048576 },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro · 文本', image: false, contextWindow: 1048576 },
  ],
  aliyun: [
    { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash · 文本与图片', image: true, contextWindow: 1000000 },
    { id: 'qwen3.8-max', label: 'Qwen3.8 Max · 文本与图片', image: true, contextWindow: 1000000 },
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash（百炼）· 文本与图片', image: true, contextWindow: 1048576 },
  ],
  custom: [],
};
export const ASR_PRESETS = [{ id: 'qwen3-asr-flash', label: 'Qwen3 ASR Flash · 录音转文字' }];
export const DEEPSEEK_SEARCH = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-flash' } as const;
export function inferProvider(baseUrl: string): ModelProvider {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === 'api.deepseek.com') return 'deepseek';
    if (/^(?:[a-z0-9-]+\.)?(?:dashscope|dashscope-intl|dashscope-us)\.aliyuncs\.com$/.test(hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(hostname)) return 'aliyun';
  } catch { /* Incomplete custom endpoint remains editable. */ }
  return 'custom';
}
export function modelPreset(provider: ModelProvider | undefined, id: string): ModelPreset | undefined {
  return MODEL_PRESETS[provider || 'custom'].find(model => model.id === id);
}
