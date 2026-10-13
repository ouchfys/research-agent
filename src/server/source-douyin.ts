import { parseHTML } from 'linkedom';
import { cleanText } from './source-content.js';

export interface DouyinDetail { id: string; description: string; author: string; images: string[]; isNote: boolean; duration?: number }
export function douyinIdentity(value: string): { id?: string; isNote: boolean; canonicalUrl?: string } {
  const url = new URL(value);
  if (!/(^|\.)douyin\.com$/i.test(url.hostname)) return { isNote: false };
  const match = url.pathname.match(/\/(?:share\/)?(video|note)\/(\d+)/);
  const id = match?.[2] || url.searchParams.get('modal_id') || url.searchParams.get('aweme_id') || undefined;
  if (!id || !/^\d{8,30}$/.test(id)) return { isNote: match?.[1] === 'note' };
  const isNote = match?.[1] === 'note';
  return { id, isNote, canonicalUrl: `https://www.douyin.com/${isNote ? 'note' : 'video'}/${id}` };
}
function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
function imageFromSlot(value: unknown): string {
  const direct = imageUrl(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, any>;
  const choices = [item.url_list, item.urlList, item.display_image?.url_list, item.display_image?.urlList,
    item.displayImage?.url_list, item.displayImage?.urlList, item.url, item.display_image?.url, item.displayImage?.url];
  for (const choice of choices) {
    for (const candidate of Array.isArray(choice) ? choice : [choice]) {
      const url = imageUrl(candidate);
      if (url) return url;
    }
  }
  return '';
}
function usableImages(images: string[]): number { return images.reduce((count, url) => count + Number(!!url), 0); }
function compareImages(left: string[], right: string[]): number {
  // Preserve the most complete page sequence; URL coverage breaks equal-length ties.
  return left.length - right.length || usableImages(left) - usableImages(right);
}
function preferDetail(candidate: DouyinDetail, current?: DouyinDetail): DouyinDetail {
  if (!current) return candidate;
  const comparison = compareImages(candidate.images, current.images)
    || Number(candidate.isNote) - Number(current.isNote)
    || Number(!!candidate.description) - Number(!!current.description)
    || Number(!!candidate.author) - Number(!!current.author)
    || Number(!!candidate.duration) - Number(!!current.duration);
  return comparison > 0 ? candidate : current;
}
/** Only extract the requested work; recommendations and nearby works must not become its content. */
export function douyinDetail(state: unknown, id: string): DouyinDetail | undefined {
  const queue: unknown[] = [state];
  let selected: DouyinDetail | undefined;
  for (let index = 0; index < queue.length && index < 30_000; index++) {
    const value = queue[index];
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { if (queue.length < 30_000) queue.push(...value.slice(0, 1000)); continue; }
    const entry = value as Record<string, any>;
    const identity = entry.aweme_id ?? entry.awemeId ?? entry.itemId ?? entry.id;
    if (String(identity ?? '') === id) {
      let images: string[] = [], hasList = false;
      for (const list of [entry.images, entry.image_post_info?.images, entry.imagePostInfo?.images]) {
        if (!Array.isArray(list)) continue;
        hasList = true;
        const candidate = Array.from(list, imageFromSlot);
        if (compareImages(candidate, images) > 0) images = candidate;
      }
      const description = cleanText(entry.desc ?? entry.description);
      const isNote = hasList || [2, 68].includes(Number(entry.aweme_type ?? entry.awemeType));
      if (description || images.length || entry.video || isNote) selected = preferDetail({
        id, description, author: cleanText(entry.author?.nickname ?? entry.authorInfo?.nickname), images, isNote,
        duration: Number.isFinite(Number(entry.video?.duration)) && Number(entry.video?.duration) > 0 ? Number(entry.video.duration) / 1000 : undefined,
      }, selected);
    }
    if (queue.length < 30_000) queue.push(...Object.values(entry).filter(item => item && typeof item === 'object').slice(0, 500));
  }
  return selected;
}
function assignedJson(script: string): unknown {
  const start = script.search(/(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__|__NEXT_DATA__)\s*=/);
  if (start < 0) return undefined;
  const first = script.indexOf('{', start);
  if (first < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let index = first; index < script.length; index++) {
    const char = script[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { try { return JSON.parse(script.slice(first, index + 1)); } catch { return undefined; } }
  }
  return undefined;
}
/** JSON-only parsing: never evaluate platform scripts or solve access challenges. */
export function douyinFromHtml(html: string, id: string): DouyinDetail | undefined {
  const { document } = parseHTML(html);
  let selected: DouyinDetail | undefined;
  for (const script of [...document.querySelectorAll('script')].slice(0, 200)) {
    const text = script.textContent || '';
    if (!text || text.length > 8 * 1024 * 1024) continue;
    let state: unknown;
    try {
      if (script.id === 'RENDER_DATA') state = JSON.parse(decodeURIComponent(text));
      else if (script.id === '__NEXT_DATA__' || script.getAttribute('type') === 'application/json') state = JSON.parse(text);
      else state = assignedJson(text);
    } catch { continue; }
    const detail = douyinDetail(state, id);
    if (detail) selected = preferDetail(detail, selected);
  }
  return selected;
}
