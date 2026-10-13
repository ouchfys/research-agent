import { Readability } from '@mozilla/readability';
import { DOMParser, parseHTML } from 'linkedom';
import { join } from 'node:path';
import type { Settings } from '../shared/types.js';
import { parsePdfWithMineru } from './source-mineru.js';

export const MAX_TEXT = 400_000;
export function cleanText(value: unknown): string { return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim() : ''; }
export function plainHtml(value: unknown): string {
  const { document } = parseHTML(`<html><body>${String(value ?? '')}</body></html>`);
  for (const node of document.querySelectorAll('script,style,noscript,iframe')) node.remove();
  return cleanText(document.body.textContent);
}
export function clip(value: string): { text: string; clipped: boolean } { return { text: value.slice(0, MAX_TEXT), clipped: value.length > MAX_TEXT }; }
export interface HtmlContent { title: string; description: string; body: string; images: string[]; isVideo: boolean; blocked: boolean; author?: string }
export function htmlContent(html: string, url: string): HtmlContent {
  const { document } = parseHTML(html);
  const meta = (...names: string[]) => {
    for (const name of names) { const value = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content'); if (value) return cleanText(value); }
    return '';
  };
  const title = cleanText(document.querySelector('#activity-name')?.textContent) || meta('og:title', 'twitter:title') || cleanText(document.title) || new URL(url).hostname;
  const description = meta('og:description', 'description', 'twitter:description');
  let body = '', author = meta('author'), isVideo = meta('og:type').startsWith('video');
  const images: string[] = [];
  const addImage = (raw: string | null) => { try { const image = new URL(raw || '', url); if (raw && ['http:', 'https:'].includes(image.protocol) && !images.includes(image.href)) images.push(image.href); } catch { /* Non-URL image attributes are not media sources. */ } };
  addImage(meta('og:image'));
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || '{}');
      const entries = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      for (const entry of entries) {
        if (entry['@type'] === 'VideoObject') isVideo = true;
        if (typeof entry.articleBody === 'string' && entry.articleBody.length > body.length) body = cleanText(entry.articleBody);
        if (!author && entry.author) author = String(entry.author.name || '');
      }
    } catch { /* Structured data is optional and never evaluated as code. */ }
  }
  const wechat = document.querySelector('#js_content');
  const readableRoot = wechat || document.querySelector('article,main') || document.body;
  for (const img of readableRoot?.querySelectorAll('img') || []) addImage(img.getAttribute('data-src') || img.getAttribute('src'));
  if (wechat) { for (const node of wechat.querySelectorAll('p,section,br')) node.append('\n'); body = cleanText(wechat.textContent); }
  else {
    try {
      const article = new Readability(document.cloneNode(true) as unknown as Document, { charThreshold: 80, maxElemsToParse: 40_000 }).parse();
      if (article && cleanText(article.textContent).length > body.length) body = cleanText(article.textContent);
      author ||= article?.byline || '';
    } catch { /* Leave metadata-only coverage if the DOM cannot be extracted. */ }
  }
  const blocked = body.length < 160 && /验证|访问受限|登录|captcha|access denied|sign in|enable javascript/i.test(`${title} ${body} ${description}`);
  return { title, description, body, images: images.slice(0, 24), isVideo, blocked, author };
}

export interface ArxivHtmlContent { title: string; text: string; images: string[]; headings: string[]; mathCount: number; tableCount: number; partial: boolean; fullText: boolean; reason?: string; declaredUrl?: string }
/** Extract the paper article itself, preserving its structure rather than a landing-page summary. */
export function arxivHtmlContent(html: string, url: string): ArxivHtmlContent {
  const { document } = parseHTML(html);
  const meta = (name: string) => cleanText(document.querySelector(`meta[name="${name}"]`)?.getAttribute('content'));
  const article = document.querySelector('article.ltx_document, .ltx_document, article');
  const title = meta('citation_title') || cleanText(article?.querySelector('h1,.ltx_title_document')?.textContent) || cleanText(document.title);
  const declaredUrl = meta('citation_pdf_url') || document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined;
  const empty: ArxivHtmlContent = { title, text: '', images: [], headings: [], mathCount: 0, tableCount: 0, partial: true, fullText: false, declaredUrl };
  if (!article) return { ...empty, reason: 'HTML 没有论文 article 正文，可能是摘要页、转换失败页或访问提示。' };
  // Read TeX data before removing scripts. These strings are never evaluated.
  for (const script of article.querySelectorAll('script[type^="math/tex"]')) {
    const replacement = document.createElement('span'); replacement.setAttribute('data-shelf-tex', script.textContent || ''); script.replaceWith(replacement);
  }
  for (const node of article.querySelectorAll('script,style,noscript,iframe,nav,button,form,.ltx_page_navbar,.ltx_page_header,.ltx_page_footer')) node.remove();
  const images: string[] = [], headings: string[] = [];
  let mathCount = 0, tableCount = 0, visited = 0, limited = false;
  const line = (value: unknown) => cleanText(value).replace(/\s+/g, ' ');
  const children = (node: any, depth: number): string => [...node.childNodes].map(child => render(child, depth + 1)).join('');
  const render = (node: any, depth = 0): string => {
    if (++visited > 150_000 || depth > 120) { limited = true; return ''; }
    if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = String(node.localName || node.nodeName).toLowerCase();
    if (tag === 'math' || node.hasAttribute('data-shelf-tex')) {
      mathCount++;
      const tex = cleanText(node.getAttribute('alttext') || node.getAttribute('data-shelf-tex') || node.querySelector('annotation[encoding="application/x-tex"],annotation[encoding="application/tex"]')?.textContent);
      const formula = tex || line(node.textContent);
      return node.getAttribute('display') === 'block' ? '\n\n$$\n' + formula + '\n$$\n\n' : ' $' + formula + '$ ';
    }
    if (/^h[1-6]$/.test(tag)) {
      const content = cleanText(children(node, depth)); if (content) headings.push(content);
      return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content + '\n\n';
    }
    if (tag === 'table') {
      tableCount++;
      const rows = [...node.querySelectorAll('tr')].filter((row: any) => row.closest('table') === node);
      const lines = rows.map((row: any, index: number) => {
        const cells = [...row.children].filter((cell: any) => ['td', 'th'].includes(String(cell.localName).toLowerCase())).map((cell: any) => {
          const span = [Number(cell.getAttribute('rowspan')) > 1 ? '跨' + cell.getAttribute('rowspan') + '行' : '', Number(cell.getAttribute('colspan')) > 1 ? '跨' + cell.getAttribute('colspan') + '列' : ''].filter(Boolean).join('、');
          const content = cleanText(children(cell, depth)).replace(/\n+/g, ' / ').replace(/\|/g, '\\|');
          return (cell.localName === 'th' ? '[表头] ' : '') + content + (span ? ' [' + span + ']' : '');
        });
        return '第 ' + (index + 1) + ' 行 | ' + cells.join(' | ');
      });
      const caption = cleanText(node.querySelector('caption')?.textContent);
      return '\n\n' + (caption ? caption + '\n' : '') + '[表格；按原行列顺序]\n' + lines.join('\n') + '\n\n';
    }
    if (tag === 'img') {
      const source = node.getAttribute('src') || node.getAttribute('data-src');
      if (source) try { const image = new URL(source, url); if (['http:', 'https:'].includes(image.protocol) && !image.username && !image.password && !images.includes(image.href)) images.push(image.href); } catch { /* Invalid image paths are not evidence. */ }
      const alternate = line(node.getAttribute('alt'));
      return alternate ? '\n[图片替代文字：' + alternate + '；未视觉识别]\n' : '\n[图片；未视觉识别]\n';
    }
    if (tag === 'br') return '\n';
    if (tag === 'pre') {
      const content = String(node.textContent || '');
      const fence = '`'.repeat([...content.matchAll(/`+/g)].reduce((length, match) => Math.max(length, match[0].length + 1), 3));
      return '\n\n' + fence + '\n' + content + '\n' + fence + '\n\n';
    }
    const content = children(node, depth);
    if (tag === 'li') return '\n- ' + content.trim() + '\n';
    if (['p', 'section', 'div', 'figure', 'figcaption', 'blockquote', 'ul', 'ol', 'dl', 'dt', 'dd'].includes(tag)) return '\n\n' + content.trim() + '\n\n';
    return content;
  };
  const result = clip(cleanText(render(article)));
  const sections = article.querySelectorAll('section.ltx_section,section.ltx_appendix,.ltx_section,.ltx_appendix');
  const nonAbstractHeadings = headings.filter(heading => !/^(?:abstract|摘要|references|参考文献|bibliography)\s*$/i.test(heading));
  const fullText = result.text.length >= 300 && (sections.length > 0 || nonAbstractHeadings.length >= 2);
  return { title, text: fullText ? result.text : '', images, headings, mathCount, tableCount, partial: result.clipped || limited, fullText, declaredUrl,
    ...(!fullText ? { reason: 'HTML 中没有确认到摘要以外的论文主体结构，未当作全文使用。' } : {}) };
}

export function arxivAbstractContent(html: string): { title: string; text: string; authors: string[]; declaredUrl?: string } {
  const { document } = parseHTML(html);
  const meta = (name: string) => cleanText(document.querySelector(`meta[name="${name}"]`)?.getAttribute('content'));
  const title = meta('citation_title') || cleanText(document.querySelector('h1.title')?.textContent).replace(/^Title:\s*/i, '');
  const abstract = document.querySelector('blockquote.abstract');
  abstract?.querySelector('.descriptor')?.remove();
  const text = cleanText(abstract?.textContent);
  const authors = [...document.querySelectorAll('meta[name="citation_author"]')].map(node => cleanText(node.getAttribute('content'))).filter(Boolean);
  return { title, text, authors, declaredUrl: meta('citation_pdf_url') || undefined };
}

export async function pdfContent(bytes: Buffer, options: { name: string; directory: string; settings: Settings; onProgress?: (message: string) => void; signal?: AbortSignal }): Promise<{ text: string; coverage: string; partial: boolean; metadata: Record<string, unknown> }> {
  const result = await parsePdfWithMineru(bytes, options.name, join(options.directory, 'mineru'), options.settings.paperParsing.mineru, options.onProgress, options.signal);
  return { text: result.text, coverage: result.coverage, partial: result.partial,
    metadata: { parser: 'mineru', mineru: { model: result.modelVersion, pageCount: result.pageCount, files: result.files, warnings: result.warnings } } };
}

export interface SubtitleContent { text: string; cueCount: number; firstSeconds?: number; lastSeconds?: number; clipped: boolean }
function subtitleSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const input = value.trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?ms$/.test(input)) return Number(input.slice(0, -2)) / 1000;
  if (/^\d+(?:\.\d+)?s?$/.test(input)) return Number(input.replace(/s$/, ''));
  const parts = input.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(number => !Number.isFinite(number) || number < 0)) return undefined;
  return parts.reduce((total, number) => total * 60 + number, 0);
}
function subtitleTimestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}
/** Parse known subtitle formats without dropping timing or treating arbitrary JSON/HTML as captions. */
export function parseSubtitle(value: string, ext = ''): SubtitleContent {
  const cues: { start?: number; end?: number; text: string }[] = [];
  const add = (text: unknown, start?: unknown, end?: unknown) => {
    const content = typeof text === 'string' ? plainHtml(text.replace(/\\[Nn]/g, '\n').replace(/\{\\[^}]*\}/g, '')) : '';
    if (content) cues.push({ text: content, start: subtitleSeconds(start), end: subtitleSeconds(end) });
  };
  const source = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let json = false;
  try {
    const data = JSON.parse(source); json = true;
    if (Array.isArray(data.body)) for (const line of data.body) add(line?.content, line?.from, line?.to);
    else if (Array.isArray(data.events)) for (const line of data.events) {
      const start = Number(line?.tStartMs) / 1000;
      add(Array.isArray(line?.segs) ? line.segs.map((segment: any) => segment?.utf8 || '').join('') : '', start, start + Number(line?.dDurationMs || 0) / 1000);
    }
    else if (Array.isArray(data.utterances)) for (const line of data.utterances) add(line?.text, Number(line?.start_time) / 1000, Number(line?.end_time) / 1000);
    else if (Array.isArray(data.segments)) for (const line of data.segments) add(line?.text, line?.start, line?.end);
  } catch { /* Non-JSON subtitle formats below. */ }
  if (!json && /(?:^|\n)\[Events\]/i.test(source)) {
    const section = source.split(/(?:^|\n)\[Events\]\s*\n/i)[1]?.split(/\n\[/)[0] || '';
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    for (const line of section.split('\n')) {
      if (/^Format:/i.test(line)) fields = line.slice(line.indexOf(':') + 1).split(',').map(field => field.trim().toLowerCase());
      if (!/^Dialogue:/i.test(line)) continue;
      const values = line.slice(line.indexOf(':') + 1).trim().split(',');
      const textIndex = fields.indexOf('text');
      if (textIndex < 0) continue;
      add(values.slice(textIndex).join(','), values[fields.indexOf('start')], values[fields.indexOf('end')]);
    }
  } else if (!json && (/ttml|srv|xml/i.test(ext) || /^\s*<\?xml|^\s*<tt[ >]|^\s*<transcript[ >]/i.test(source))) {
    const xml = new DOMParser().parseFromString(source, 'text/xml');
    for (const node of xml.querySelectorAll('p,text')) {
      const start = subtitleSeconds(node.getAttribute('begin') || node.getAttribute('start'));
      const end = subtitleSeconds(node.getAttribute('end'));
      const duration = subtitleSeconds(node.getAttribute('dur'));
      add(node.textContent, start, end ?? (start !== undefined && duration !== undefined ? start + duration : undefined));
    }
  } else if (!json && !cues.length) {
    const timing = /^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d+)\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d+)[^\n]*\n/gm;
    const matches = [...source.matchAll(timing)];
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index], start = match.index! + match[0].length;
      const content = source.slice(start, matches[index + 1]?.index ?? source.length).split(/\n\s*\n/)[0];
      add(content, match[1], match[2]);
    }
  }
  const rendered = cues.map(cue => `${cue.start !== undefined ? `[${subtitleTimestamp(cue.start)}${cue.end !== undefined ? ` → ${subtitleTimestamp(cue.end)}` : ''}] ` : ''}${cue.text}`).join('\n');
  const result = clip(rendered);
  const starts = cues.flatMap(cue => cue.start === undefined ? [] : [cue.start]), ends = cues.flatMap(cue => cue.end === undefined ? [] : [cue.end]);
  return { ...result, cueCount: cues.length, firstSeconds: starts.length ? starts.reduce((lowest, item) => Math.min(lowest, item)) : undefined, lastSeconds: ends.length ? ends.reduce((highest, item) => Math.max(highest, item)) : undefined };
}
