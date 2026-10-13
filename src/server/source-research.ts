import { DOMParser } from 'linkedom';
import type { Settings } from '../shared/types.js';
import { DEEPSEEK_SEARCH } from '../shared/providers.js';
import { download, endpoint, providerRequest, publicJson } from './source-network.js';
import { cleanText, plainHtml } from './source-content.js';
import { arxivHtmlUrl, arxivIdentity } from './source-arxiv.js';

export interface PaperCandidate {
  id: string; title: string; authors: string[]; year: number | null; abstract: string; url: string;
  pdfUrl?: string; htmlUrl?: string; provider: 'Crossref' | 'OpenAlex' | 'arXiv'; warnings?: string[];
}
export interface SearchResult { title: string; url: string; description: string; publishedAt?: string }
export interface WebSearchResponse { provider: 'deepseek'; model: string; results: SearchResult[]; warnings: string[]; truncated: boolean }
function validHttp(value: unknown): string {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export async function searchWeb(query: string, settings: Settings, signal?: AbortSignal): Promise<WebSearchResponse> {
  if (!query.trim() || query.length > 1000) throw new Error('搜索词应为 1–1000 个字符。');
  if (signal?.aborted) throw new Error('联网搜索已取消。');
  const apiKey = settings.search.apiKey;
  if (!apiKey) throw new Error('联网搜索需要 DeepSeek 官方密钥。请在设置中读取已有 .env，或配置 DeepSeek 官方密钥，无需单独配置搜索服务。');
  // Same official server-tool protocol as DSH; one auxiliary model request,
  // without a second agent loop or sending library/session contents.
  const data = await providerRequest(endpoint(DEEPSEEK_SEARCH.baseUrl, 'messages'), {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_SEARCH.model, max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query.trim()}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  }, { purpose: 'search', provider: DEEPSEEK_SEARCH.provider, model: DEEPSEEK_SEARCH.model });
  if (signal?.aborted) throw new Error('联网搜索已取消。');
  if (!data || data.type === 'error' || !Array.isArray(data.content)) throw new Error('DeepSeek 官方搜索没有返回可解析的结构化响应。');
  const blocks: any[] = data.content;
  const resultBlocks = blocks.filter(block => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) throw new Error('DeepSeek 本次未返回结构化搜索结果，可能未触发官方搜索或账号暂不支持。未将模型生成的回答当作搜索结果，请稍后重试。');

  // Only explicit citation excerpts can supply snippets. Generated block.text
  // is never scraped for URLs or substituted for external source evidence.
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      const url = validHttp(citation?.url), snippet = cleanText(citation?.cited_text);
      if (url && snippet && !snippets.has(url)) snippets.set(url, snippet);
    }
  }
  const warnings = new Set<string>(), seen = new Set<string>(), results: SearchResult[] = [];
  let incomplete = false, clipped = false;
  for (const block of resultBlocks) {
    if (!Array.isArray(block.content)) {
      const code = block.content?.error_code;
      const detail = typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code) ? `（${code}）` : '';
      warnings.add(`DeepSeek 的部分搜索未成功返回结果${detail}。`); incomplete = true; continue;
    }
    for (const item of block.content) {
      const url = validHttp(item?.url);
      if (item?.type !== 'web_search_result' || !url) { warnings.add('服务返回的部分搜索条目格式不兼容，已跳过。'); incomplete = true; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const description = snippets.get(url) || '', title = cleanText(item.title), publishedAt = cleanText(item.page_age);
      clipped ||= description.length > 5000 || title.length > 1000 || publishedAt.length > 100;
      results.push({ title: title.slice(0, 1000), url, description: description.slice(0, 5000), ...(publishedAt ? { publishedAt: publishedAt.slice(0, 100) } : {}) });
    }
  }
  if (data.stop_reason === 'max_tokens' || data.stop_reason === 'pause_turn') { warnings.add('搜索请求在完整结束前停止；当前结果仅覆盖已返回部分。'); incomplete = true; clipped = true; }
  if (!results.length && incomplete) throw new Error(`DeepSeek 官方搜索本次未取得有效结果。${[...warnings].join(' ')} 不能据此判断没有相关来源。`);
  const visible = results.slice(0, 8);
  if (visible.some(item => !item.description)) warnings.add('部分来源未提供引用片段，description 留空；需要读取对应 URL 获取正文。');
  if (clipped) warnings.add('部分响应或字段因长度限制未完整返回；需要读取对应 URL 获取正文。');
  return { provider: DEEPSEEK_SEARCH.provider, model: DEEPSEEK_SEARCH.model, results: visible, warnings: [...warnings], truncated: clipped || results.length > visible.length };
}

function crossrefPaper(item: any): PaperCandidate {
  const year = item.published?.['date-parts']?.[0]?.[0] ?? item['published-print']?.['date-parts']?.[0]?.[0] ?? null;
  return { id: item.DOI || item.URL, title: plainHtml(item.title?.[0]), authors: (item.author || []).map((author: any) => cleanText([author.given, author.family].filter(Boolean).join(' ') || author.name)), year,
    abstract: plainHtml(item.abstract) || '该元数据记录没有提供摘要；需要读取可访问原文。', url: validHttp(item.URL) || `https://doi.org/${item.DOI}`, pdfUrl: item.link?.find((link: any) => link['content-type'] === 'application/pdf')?.URL, provider: 'Crossref' };
}

async function crossref(query: string): Promise<PaperCandidate[]> {
  const doi = query.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)/i)?.[1]?.replace(/[.,;，。；]+$/, '');
  if (doi) { const data = await publicJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`); return [crossrefPaper(data.message)]; }
  const data = await publicJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=8`);
  return (data.message?.items || []).map(crossrefPaper);
}

async function openalex(query: string): Promise<PaperCandidate[]> {
  const data = await publicJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=8`);
  return (data.results || []).map((item: any): PaperCandidate => {
    const words: string[] = [];
    if (item.abstract_inverted_index) for (const [word, positions] of Object.entries(item.abstract_inverted_index)) for (const position of positions as number[]) if (position < 20_000) words[position] = word;
    return { id: item.doi || item.id, title: cleanText(item.display_name), authors: (item.authorships || []).map((author: any) => cleanText(author.author?.display_name)), year: item.publication_year || null,
      abstract: words.join(' ') || '该元数据记录没有提供摘要；需要读取可访问原文。', url: validHttp(item.primary_location?.landing_page_url || item.doi || item.id), pdfUrl: validHttp(item.best_oa_location?.pdf_url) || undefined, provider: 'OpenAlex' };
  });
}

let arxivNextRequest = 0;
async function arxiv(query: string): Promise<PaperCandidate[]> {
  const wait = Math.max(0, arxivNextRequest - Date.now());
  arxivNextRequest = Date.now() + wait + 3100;
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  const id = query.match(/(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i)?.[1];
  const parameter = id ? `id_list=${encodeURIComponent(id)}` : `search_query=${encodeURIComponent(`all:${query}`)}`;
  const response = await download(`https://export.arxiv.org/api/query?${parameter}&start=0&max_results=8`, { maxBytes: 4 * 1024 * 1024 });
  const xml = new DOMParser().parseFromString(response.bytes.toString('utf8'), 'text/xml');
  return [...xml.querySelectorAll('entry')].filter(entry => !entry.querySelector('id')?.textContent?.includes('/api/errors')).map(entry => {
    const url = cleanText(entry.querySelector('id')?.textContent).replace(/^http:/, 'https:');
    const published = cleanText(entry.querySelector('published')?.textContent);
    return { id: url.replace(/^.*\/abs\//, ''), title: cleanText(entry.querySelector('title')?.textContent).replace(/\s+/g, ' '), authors: [...entry.querySelectorAll('author name')].map(author => cleanText(author.textContent)),
      year: published ? Number(published.slice(0, 4)) : null, abstract: cleanText(entry.querySelector('summary')?.textContent), url, pdfUrl: url.replace('/abs/', '/pdf/'), provider: 'arXiv' as const };
  });
}

export async function searchPapers(query: string, settings?: Settings): Promise<PaperCandidate[]> {
  if (!query.trim() || query.length > 1000) throw new Error('论文检索词应为 1–1000 个字符。');
  const names = ['Crossref', 'OpenAlex', 'arXiv'];
  const results = await Promise.allSettled([crossref(query), openalex(query), arxiv(query)]);
  const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`${names[index]} 暂时不可访问；当前候选列表不包含该服务。`] : []);
  if (results.every(result => result.status === 'rejected')) throw new Error('Crossref、OpenAlex 和 arXiv 本次均不可访问，未获得论文候选；请检查网络后重试。');
  // Preserve separate provider records and versions. Similar titles are never silently merged.
  const htmlBaseUrl = settings?.paperParsing.arxivHtmlBaseUrl || 'https://arxiv.org/html';
  const candidates = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).filter(item => item.title && item.url).map(item => {
    const paper = arxivIdentity(item.url, htmlBaseUrl) || (item.pdfUrl ? arxivIdentity(item.pdfUrl, htmlBaseUrl) : undefined);
    return { ...item, ...(paper ? { htmlUrl: arxivHtmlUrl(paper, htmlBaseUrl) } : {}), ...(warnings.length ? { warnings } : {}) };
  });
  if (!candidates.length && warnings.length) throw new Error(`${warnings.join(' ')} 其余服务未返回匹配结果；不能据此断定没有相关论文。`);
  return candidates;
}
