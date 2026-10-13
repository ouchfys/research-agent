import type { BrowserArticleResult } from '../shared/browser-media';
import { renderArticleMarkdown } from '../shared/article-markdown';

export interface ArticleSnapshot {
  pageUrl: string;
  canonical?: string;
  title: string;
  text: string;
  author?: string;
  imageCount: number;
  images: Array<{ index: number; url: string }>;
  matched: boolean;
  challenge: boolean;
  loginCompleted: boolean;
  unavailable: boolean;
  contentComplete: boolean;
  limitations: string[];
}

/** Runs in Chromium. Return only the target article, never cookies or arbitrary page state. */
export function articleSnapshot(platform: BrowserArticleResult['platform'], noteId: string | undefined, renderArticle: typeof renderArticleMarkdown): ArticleSnapshot {
  const maximum = 400_000;
  const clean = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\t\u00a0]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit) : '';
  const visible = (node: Element | null) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const textOf = (node: Element | null) => node instanceof HTMLElement ? node.innerText : node?.textContent || '';
  const result: ArticleSnapshot = {
    pageUrl: location.href, title: '', text: '', imageCount: 0, images: [], matched: false,
    challenge: false, loginCompleted: false, unavailable: false, contentComplete: false, limitations: [],
  };
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || document.querySelector('meta[property="og:url"]')?.getAttribute('content');
  if (canonical && canonical.length <= 16_384) result.canonical = canonical;
  const bodyText = clean(textOf(document.body), 30_000);
  const login = [...document.querySelectorAll('[role="dialog"],.login-container,.login-modal,.reds-login,.verify-container,.captcha-container,#js_verify,#captcha')].slice(0, 100);
  result.challenge = login.some(node => visible(node) && /登录|登陆|扫码|验证|验证码|安全校验/.test(textOf(node)));
  result.loginCompleted = /登录成功|登陆成功|验证通过|验证成功|已成功登录/.test(bodyText);
  const imageUrl = (image: Element) => image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src') || '';
  if (platform === 'wechat') {
    const root = document.querySelector('#js_content');
    result.matched = !!root && location.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/|$)/.test(location.pathname);
    if (result.matched && root) {
      const rendered = renderArticle(root, location.href, { maxCharacters: maximum, visibleOnly: true });
      result.title = clean(textOf(document.querySelector('#activity-name')), 1000);
      result.author = clean(textOf(document.querySelector('#js_name,.rich_media_meta_nickname')), 1000) || undefined;
      result.text = rendered.hasText ? rendered.text : '';
      result.imageCount = rendered.imageCount;
      result.images = rendered.images;
      const folded = [...document.querySelectorAll('#js_content_hide,#js_read_more,.read-more,.read_more')].some(visible);
      result.contentComplete = !rendered.truncated && !rendered.structureLimited && !folded;
      if (rendered.truncated) result.limitations.push('结构化正文超过 40 万字符，仅保留前 40 万字符。');
      if (rendered.structureLimited) result.limitations.push('正文超过结构提取上限，未读取后续节点。');
      if (folded) result.limitations.push('页面仍显示展开或继续阅读区域，正文可能未完整展开。');
      if (root.querySelector('video,iframe.qq_video,iframe[data-src*="video"],mp-video')) result.limitations.push('本文包含视频，本次浏览器文章获取仅保留文字与配图。');
    }
  } else {
    const locationId = location.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase();
    if (locationId === noteId?.toLowerCase()) {
      type Item = Record<string, unknown>;
      let best: Item | undefined;
      let bestScore = -1;
      const initial = Object.getOwnPropertyDescriptor(window, '__INITIAL_STATE__')?.value;
      const noteRoot = initial && typeof initial === 'object' ? (initial as Item).note : undefined;
      const map = noteRoot && typeof noteRoot === 'object' ? (noteRoot as Item).noteDetailMap : undefined;
      const queue: Array<{ value: unknown; exact: boolean }> = [{ value: initial, exact: false }];
      if (map && typeof map === 'object' && noteId) queue.unshift({ value: (map as Item)[noteId], exact: true });
      const seen = new WeakSet<object>();
      let scanned = 0;
      const listOf = (item: Item): unknown[] => Array.isArray(item.imageList) ? item.imageList : Array.isArray(item.image_list) ? item.image_list : [];
      for (let cursor = 0; cursor < queue.length && scanned++ < 8000; cursor++) {
        const { value, exact } = queue[cursor];
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const child of value.slice(0, 200)) if (queue.length < 12_000) queue.push({ value: child, exact: false });
          continue;
        }
        const item = value as Item;
        const id = String(item.noteId ?? item.note_id ?? item.id ?? '').toLowerCase();
        const matches = id === noteId?.toLowerCase() || (exact && !id);
        if (matches) {
          const score = (typeof item.desc === 'string' ? item.desc.length : typeof item.description === 'string' ? item.description.length : 0) + listOf(item).length * 1000;
          if ((typeof item.desc === 'string' || typeof item.description === 'string' || listOf(item).length) && score > bestScore) { best = item; bestScore = score; }
        }
        for (const [key, child] of Object.entries(item)) {
          if (queue.length >= 12_000) break;
          if (/^(?:user|author|comments?|recommend|recommendations|related|feed)$/i.test(key)) continue;
          if (child && typeof child === 'object') queue.push({ value: child, exact: matches && key === 'note' });
        }
      }
      if (best) {
        const fullText = typeof best.desc === 'string' ? best.desc : typeof best.description === 'string' ? best.description : '';
        result.title = clean(best.title, 1000);
        result.text = clean(fullText, maximum);
        const user = best.user && typeof best.user === 'object' ? best.user as Item : undefined;
        result.author = clean(user?.nickname ?? user?.nickName, 1000) || undefined;
        result.matched = true;
        result.contentComplete = fullText.length <= maximum;
        if (fullText.length > maximum) result.limitations.push('正文超过 40 万字符，仅保留前 40 万字符。');
        const list = listOf(best);
        if (best.type === 'video' || best.modelType === 'video') {
          result.contentComplete = false;
          result.limitations.push('目标为视频笔记，本次文章获取仅保留文字说明；未将封面当作视频画面。');
        }
        else {
          result.imageCount = list.length;
          result.images = list.slice(0, 24).map((value, index) => {
            const item = value && typeof value === 'object' ? value as Item : {};
            const info = Array.isArray(item.infoList) ? item.infoList : [];
            const original = info.find(value => value && typeof value === 'object' && /(?:WB_DFT|ORIGIN)/i.test(String((value as Item).imageScene || ''))) as Item | undefined;
            const candidates = [original?.url, item.urlDefault, item.url_default, item.urlPre, item.url, ...info.slice(0, 8).map(value => value && typeof value === 'object' ? (value as Item).url : '')];
            return { index: index + 1, url: candidates.find((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value)) || '' };
          });
        }
      } else {
        // A visible detail container is usable only while the address names the exact submitted note.
        const root = document.querySelector('#noteContainer,.note-container,.note-detail');
        const description = root?.querySelector('#detail-desc,.desc,.note-text');
        if (root && description) {
          const fullText = textOf(description);
          result.matched = true;
          result.title = clean(textOf(root.querySelector('#detail-title,.title')), 1000);
          result.text = clean(fullText, maximum);
          result.author = clean(textOf(root.querySelector('.author-wrapper .username,.author .name')), 1000) || undefined;
          result.limitations.push('页面未提供目标笔记的完整状态，正文取自目标笔记可见区域，未确认为完整正文。');
          if (fullText.length > maximum) result.limitations.push('正文超过 40 万字符，仅保留前 40 万字符。');
          const images = root.querySelectorAll('.note-slider .swiper-slide:not(.swiper-slide-duplicate) img,.media-container .swiper-slide:not(.swiper-slide-duplicate) img');
          const indexed = new Map<number, string>();
          for (const image of [...images].slice(0, 100)) {
            const rawPosition = image.closest('[data-swiper-slide-index]')?.getAttribute('data-swiper-slide-index');
            const position = rawPosition === null || rawPosition === undefined ? NaN : Number(rawPosition);
            const index = Number.isSafeInteger(position) && position >= 0 && position < 1000 ? position + 1 : indexed.size + 1;
            if (!indexed.has(index)) indexed.set(index, imageUrl(image));
          }
          const ordered = [...indexed].sort(([a], [b]) => a - b);
          result.imageCount = ordered.length ? Math.max(...ordered.map(([index]) => index)) : 0;
          result.images = Array.from({ length: Math.min(24, result.imageCount) }, (_, position) => ({ index: position + 1, url: indexed.get(position + 1) || '' }));
          if (ordered.length) result.limitations.push('配图来自目标笔记已加载的轮播区域；页面未提供完整图片列表，总数可能更大。');
        }
      }
    }
  }
  if (!result.matched || (!result.text && !result.images.length)) {
    result.challenge ||= /环境异常|请.{0,10}验证|完成.{0,10}验证|安全验证|验证码|扫码登录|登录后.{0,12}(?:查看|浏览)/.test(bodyText);
    result.unavailable = /内容已删除|笔记已删除|该内容无法查看|该内容已被发布者删除|内容暂时无法查看|笔记不存在/.test(bodyText);
  }
  if (result.imageCount > 24) result.limitations.push(`正文配图共 ${result.imageCount} 张，本次最多保存前 24 张。`);
  return result;
}

/** Inject both self-contained functions; serialized snapshots cannot capture module imports. */
export function articleSnapshotScript(platform: BrowserArticleResult['platform'], noteId?: string): string {
  return '(' + articleSnapshot.toString() + ')(' + JSON.stringify(platform) + ',' + JSON.stringify(noteId ?? null) + ',(' + renderArticleMarkdown.toString() + '))';
}
