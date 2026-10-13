import { parseHTML } from 'linkedom';
import { cleanText, clip } from './source-content.js';
import { renderArticleMarkdown } from '../shared/article-markdown.js';

export type ArticlePlatform = 'wechat' | 'xiaohongshu';
export interface PlatformArticle {
  platform: ArticlePlatform;
  title: string;
  text: string;
  author?: string;
  images: string[];
  imageCount: number;
  contentComplete: boolean;
  needsBrowser?: boolean;
  isVideo: boolean;
  reason?: string;
}

export function articlePlatform(value: string): ArticlePlatform | undefined {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (host === 'mp.weixin.qq.com') return 'wechat';
    if (/(^|\.)xiaohongshu\.com$/.test(host) || host === 'xhslink.com') return 'xiaohongshu';
  } catch { /* Invalid URLs are handled by the network boundary. */ }
}

export function xiaohongshuId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return;
    return url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1].toLowerCase();
  } catch { return; }
}

function imageUrl(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) return '';
  try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

function xhsImage(value: unknown, base: string): string {
  if (!value || typeof value !== 'object') return imageUrl(value, base);
  const image = value as Record<string, any>;
  const candidates = [image.urlDefault, image.urlPre, image.url, ...(Array.isArray(image.infoList) ? image.infoList.map((item: any) => item?.url) : [])];
  return candidates.map(value => imageUrl(value, base)).find(Boolean) || '';
}

function visiblyPresent(node: any): boolean {
  for (let current = node; current?.nodeType === 1; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(current.getAttribute('style') || '') || /(?:^|\s)(?:hidden|hide|dn)(?:\s|$)/.test(current.getAttribute('class') || '')) return false;
  }
  return true;
}

/** Replace the JS-only undefined literal outside quoted strings; never execute page code. */
function jsonState(source: string): unknown {
  let output = '', quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (source.startsWith('undefined', index) && /[\s:[,]/.test(source[index - 1] || ' ') && /[\s,}\]]/.test(source[index + 9] || ' ')) { output += 'null'; index += 8; }
    else output += char;
  }
  return JSON.parse(output);
}

/** Extract just the assigned object, including when other JavaScript follows it. */
function initialStateObject(script: string): string | undefined {
  const assignment = /(?:^|[;\s{}])(?:window\.)?__INITIAL_STATE__\s*=\s*/g;
  for (const match of script.matchAll(assignment)) {
    const start = match.index! + match[0].length;
    if (script[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < script.length; index++) {
      const char = script[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') { if (++depth > 200) return; }
      else if (char === '}' && --depth === 0) return script.slice(start, index + 1);
    }
  }
}

/** Require the requested note identity; recommendation objects are never substituted. */
export function platformArticleContent(html: string, finalUrl: string, submittedUrl: string): PlatformArticle {
  const platform = articlePlatform(submittedUrl) || articlePlatform(finalUrl) || 'wechat';
  const empty: PlatformArticle = { platform, title: '', text: '', images: [], imageCount: 0, contentComplete: false, isVideo: false };
  if (articlePlatform(finalUrl) !== platform) return { ...empty, reason: '链接跳转到了其他平台，未将该页面作为目标正文。' };
  const pathname = new URL(finalUrl).pathname;
  if (/captcha|verify|login|passport|security/i.test(pathname)) return { ...empty, reason: '链接返回登录或验证页面，未取得目标正文。' };
  const { document } = parseHTML(html);
  if (platform === 'wechat') {
    const root = document.querySelector('#js_content');
    if (!root) return { ...empty, reason: '公众号页面没有返回 #js_content 文章主体，可能是访问提示或动态页面。' };
    // Only inspect dedicated controls, not occurrences of “付费/阅读” inside the article itself.
    const gated = [...document.querySelectorAll('#js_content_hide,#js_read_more,.read-more,.read_more,#js_pay_area,.pay_read_box,.pay_read_area')].some(node => {
      const text = cleanText(node.textContent);
      return visiblyPresent(node) && text.length <= 500 && /展开(?:全文|阅读|更多)?|阅读(?:更多|全文|剩余)|继续阅读|付费(?:阅读|后|内容)|购买(?:后|全文|阅读)|订阅(?:后|解锁)|解锁(?:全文|后续)/.test(text);
    });
    for (const node of root.querySelectorAll('script,style,noscript,iframe,form,button')) node.remove();
    // Shared with the browser path: retain structure, links and numbered image positions.
    const rendered = renderArticleMarkdown(root as unknown as Element, finalUrl);
    const images = rendered.images.map(image => image.url);
    const body = { text: rendered.hasText ? rendered.text : '', clipped: rendered.truncated || rendered.structureLimited };
    const articleTitle = cleanText(document.querySelector('#activity-name')?.textContent), title = articleTitle || cleanText(document.title);
    if (!articleTitle && /^(?:未知错误|环境异常|安全验证|访问验证|微信公众平台|登录)(?:\s*[-|].*)?$/.test(title) && body.text.length < 1000) return { ...empty, reason: '公众号返回访问提示页，未将提示文字作为文章正文。' };
    if (!body.text && !images.some(Boolean)) return { ...empty, title, reason: '公众号文章主体为空，且没有可读取的正文配图。' };
    return { ...empty, title, text: body.text, author: cleanText(document.querySelector('#js_name,.rich_media_meta_nickname')?.textContent), images, imageCount: rendered.imageCount, contentComplete: !body.clipped && !gated, needsBrowser: gated, reason: gated ? '页面存在展开全文或付费阅读控件，当前仅保存可取得的正文范围；不会自动购买内容。' : body.clipped ? '静态正文达到 40 万字符或结构提取上限；剩余内容未完整提供。' : undefined };
  }
  const expectedId = xiaohongshuId(submittedUrl) || xiaohongshuId(finalUrl);
  if (!expectedId) return { ...empty, reason: '小红书页面未解析到可核对的目标笔记编号。' };
  const finalId = xiaohongshuId(finalUrl);
  if (finalId && finalId !== expectedId) return { ...empty, reason: '跳转后的笔记编号与用户提交的链接不一致。' };
  let selected: Record<string, any> | undefined;
  for (const script of [...document.querySelectorAll('script')].slice(0, 200)) {
    const source = script.textContent || '';
    if (source.length > 8 * 1024 * 1024) continue;
    const object = initialStateObject(source);
    if (!object) continue;
    try {
      const state = jsonState(object) as any;
      const map = state?.note?.noteDetailMap;
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const [key, value] of Object.entries(map).slice(0, 200)) {
        const note = (value as any)?.note;
        if (!note || typeof note !== 'object') continue;
        const declared = String(note.noteId || note.note_id || note.id || '').toLowerCase();
        if (declared ? declared !== expectedId : key.toLowerCase().split('_')[0] !== expectedId) continue;
        const count = Array.isArray(note.imageList) ? note.imageList.length : 0, selectedCount = Array.isArray(selected?.imageList) ? selected.imageList.length : 0;
        if (!selected || count > selectedCount || (count === selectedCount && cleanText(note.desc).length > cleanText(selected.desc).length)) selected = note;
      }
    } catch { /* Unsupported script shapes remain unavailable and can use the browser path. */ }
  }
  if (!selected) return { ...empty, reason: '页面内嵌状态未提供与该链接编号一致的笔记，未读取其他推荐笔记。' };
  const imageList = Array.isArray(selected.imageList) ? selected.imageList : [];
  const description = clip(cleanText(selected.desc)), title = cleanText(selected.title);
  if (!description.text && !imageList.length && selected.type !== 'video') return { ...empty, title, reason: '目标笔记仅有标题，没有正文或图片列表。' };
  return { ...empty, title, text: description.text, author: cleanText(selected.user?.nickname), images: imageList.slice(0, 24).map(value => xhsImage(value, finalUrl)), imageCount: imageList.length, contentComplete: !description.clipped && selected.type !== 'video', isVideo: selected.type === 'video', reason: selected.type === 'video' ? '这里只取得视频笔记的发布文字和封面，视频内容需单独获取。' : description.clipped ? '静态正文达到 40 万字符上限。' : undefined };
}
