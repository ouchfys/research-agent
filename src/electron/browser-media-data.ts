export interface MediaCandidate { url: string; audioOnly: boolean; priority: number }
export interface NoteCandidate {
  description?: string;
  author?: string;
  imageCount: number;
  images: Array<{ index: number; urls: string[] }>;
}

function noteImageLists(object: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = [];
  if (Array.isArray(object.images)) lists.push(object.images);
  for (const key of ['image_post_info', 'imagePostInfo']) {
    const post = object[key];
    if (post && typeof post === 'object' && Array.isArray((post as Record<string, unknown>).images)) lists.push((post as { images: unknown[] }).images);
  }
  return lists;
}
function isNote(object: Record<string, unknown>): boolean {
  return [2, 68].includes(Number(object.aweme_type ?? object.awemeType)) || noteImageLists(object).some(images => images.length > 0);
}

export function targetKind(state: unknown, awemeId: string): 'video' | 'note' | undefined {
  const queue: unknown[] = [state];
  let scanned = 0, video = false;
  while (queue.length && scanned++ < 40_000) {
    const item = queue.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { queue.push(...item.slice(0, 2000)); continue; }
    const object = item as Record<string, unknown>;
    if (String(object.aweme_id ?? object.awemeId ?? '') === awemeId) {
      if (isNote(object)) return 'note';
      if (object.video && typeof object.video === 'object') video = true;
    }
    for (const [key, value] of Object.entries(object)) if (!/music|comments|author|cover|avatar/i.test(key) && value && typeof value === 'object') queue.push(value);
  }
  return video ? 'video' : undefined;
}

const ROOTS = ['douyin.com', 'iesdouyin.com', 'douyinvod.com', 'idouyinvod.com', 'douyinstatic.com', 'douyinpic.com', 'bytecdn.cn', 'ibyteimg.com', 'byteimg.com', 'pstatp.com', 'snssdk.com', 'amemv.com', 'bytedance.com', 'bytedance.net', 'bytegoofy.com', 'bytefcdn.com', 'byteeffecttos.com', 'bytegecko.com'];
export function allowedBrowserUrl(value: string): URL | undefined {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
    if (!ROOTS.some(root => host === root || host.endsWith('.' + root))) return;
    return url;
  } catch { return; }
}

function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return;
  const url = allowedBrowserUrl(value.replace(/^http:\/\//, 'https://'));
  if (!url || /\.(?:m3u8|mpd)(?:$|[?#])/i.test(url.href)) return;
  return url.href;
}

function noteImageUrls(value: unknown): string[] {
  const candidates: unknown[] = [];
  const addresses = (object: Record<string, unknown>) => {
    for (const key of ['url_list', 'urlList']) if (Array.isArray(object[key])) candidates.push(...(object[key] as unknown[]).slice(0, 12));
    if (typeof object.url === 'string') candidates.push(object.url);
  };
  if (typeof value === 'string') candidates.push(value);
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    addresses(object);
    for (const key of ['display_image', 'displayImage', 'origin_image', 'originImage']) {
      const image = object[key];
      if (image && typeof image === 'object' && !Array.isArray(image)) addresses(image as Record<string, unknown>);
    }
  }
  return [...new Set(candidates.map(mediaUrl).filter((url): url is string => !!url))].slice(0, 12);
}

/** Preserve one exact work's complete list and original positions; never enumerate page-wide images. */
export function noteFromState(state: unknown, awemeId: string): NoteCandidate | undefined {
  const queue: unknown[] = [state];
  let scanned = 0, confirmed = false, best: NoteCandidate | undefined, description: string | undefined, author: string | undefined;
  const text = (value: unknown, maximum: number): string | undefined => typeof value === 'string' ? value.trim().slice(0, maximum) || undefined : undefined;
  while (queue.length && scanned++ < 40_000) {
    const item = queue.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { queue.push(...item.slice(0, 2000)); continue; }
    const object = item as Record<string, unknown>;
    if (String(object.aweme_id ?? object.awemeId ?? '') === awemeId) {
      description ||= text(object.desc, 20_000) || text(object.description, 20_000) || text(object.title, 20_000);
      if (object.author && typeof object.author === 'object') {
        const owner = object.author as Record<string, unknown>;
        author ||= text(owner.nickname, 200) || text(owner.nickName, 200);
      }
      if (isNote(object)) {
        confirmed = true;
        for (const list of noteImageLists(object)) {
          const candidate: NoteCandidate = { imageCount: list.length, images: list.slice(0, 24).map((image, index) => ({ index: index + 1, urls: noteImageUrls(image) })) };
          if (!best || candidate.imageCount > best.imageCount || (candidate.imageCount === best.imageCount && candidate.images.filter(image => image.urls.length).length > best.images.filter(image => image.urls.length).length)) best = candidate;
        }
      }
    }
    for (const [key, value] of Object.entries(object)) if (!/music|comments|author|cover|avatar/i.test(key) && value && typeof value === 'object') queue.push(value);
  }
  return confirmed ? { ...(best || { imageCount: 0, images: [] }), ...(description ? { description } : {}), ...(author ? { author } : {}) } : undefined;
}

/** Only video-owned addresses under an exact aweme_id are accepted; root music is never traversed. */
export function candidatesFromState(state: unknown, awemeId: string): MediaCandidate[] {
  const candidates: MediaCandidate[] = [], queue: unknown[] = [state];
  let scanned = 0;
  while (queue.length && scanned++ < 40_000) {
    const item = queue.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { queue.push(...item.slice(0, 2000)); continue; }
    const object = item as Record<string, unknown>;
    const identity = object.aweme_id ?? object.awemeId;
    if (String(identity || '') === awemeId && !isNote(object)) {
      const video = object.video;
      if (video && typeof video === 'object') {
        const walk = (entry: unknown, path: string, depth: number): void => {
          if (!entry || depth > 9 || candidates.length >= 48) return;
          if (typeof entry === 'string') {
            const url = mediaUrl(entry);
            if (url && /(?:play.?addr|audio|bit.?rate|url.?list)/i.test(path)) candidates.push({ url, audioOnly: /audio/i.test(path) || /media-audio-/i.test(url), priority: /audio/i.test(path) ? 50 : /bit.?rate/i.test(path) ? 90 : 100 });
            else if (/(?:video.?model)$/i.test(path) && entry.length < 2 * 1024 * 1024) { try { walk(JSON.parse(entry), path, depth + 1); } catch { /* Not JSON. */ } }
            return;
          }
          if (Array.isArray(entry)) { entry.slice(0, 30).forEach(value => walk(value, path, depth + 1)); return; }
          if (typeof entry !== 'object') return;
          for (const [key, value] of Object.entries(entry as object)) {
            if (/music|cover|thumbnail|image|avatar|download_addr/i.test(key)) continue;
            if (depth === 0 && !/play.?addr|bit.?rate|audio|video.?model/i.test(key)) continue;
            walk(value, path + '.' + key, depth + 1);
          }
        };
        walk(video, 'video', 0);
      }
    }
    for (const [key, value] of Object.entries(object)) if (!/music|comments|author|cover|avatar/i.test(key) && value && typeof value === 'object') queue.push(value);
  }
  return candidates;
}

/** Parse data, never evaluate a script supplied by the site. */
export function parsePageState(text: string): unknown {
  if (!text || text.length > 8 * 1024 * 1024) return;
  for (const value of [text, (() => { try { return decodeURIComponent(text); } catch { return ''; } })()]) {
    try { return JSON.parse(value); } catch { /* Try JSON-only assignment below. */ }
    const assignment = value.match(/(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__|__NEXT_DATA__)\s*=\s*/);
    if (!assignment || assignment.index === undefined) continue;
    const start = assignment.index + assignment[0].length;
    if (value[start] !== '{' && value[start] !== '[') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let at = start; at < value.length; at++) {
      const char = value[at];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) { try { return JSON.parse(value.slice(start, at + 1)); } catch { break; } }
    }
  }
}

/** Executed in the isolated site's renderer; it returns bounded data, not executable site code. */
export function pageSnapshot(awemeId: string): { states: string[]; media: { url: string; audioOnly: boolean }[]; challenge: boolean } {
  const states: string[] = [], media: { url: string; audioOnly: boolean }[] = [];
  let size = 0;
  const keep = (text: string) => { if (text && text.length <= 8 * 1024 * 1024 && size + text.length <= 16 * 1024 * 1024) { states.push(text); size += text.length; } };
  for (const script of Array.from(document.querySelectorAll('script')).slice(0, 300)) {
    const text = script.textContent || '';
    if (['RENDER_DATA', '__NEXT_DATA__'].includes(script.id) || script.type === 'application/json' || /(?:_ROUTER_DATA|__INITIAL_STATE__)\s*=/.test(text.slice(0, 300))) keep(text);
  }
  for (const name of ['_ROUTER_DATA', '__INITIAL_STATE__', '__NEXT_DATA__']) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (descriptor?.value && typeof descriptor.value === 'object') { try { keep(JSON.stringify(descriptor.value)); } catch { /* Cyclic state is not a candidate. */ } }
  }
  for (const element of Array.from(document.querySelectorAll('video,audio')).slice(0, 30)) {
    let container: Element | null = element, matched = false;
    for (let level = 0; container && level < 7; level++, container = container.parentElement) {
      const explicit = container.getAttribute('data-aweme-id') || container.getAttribute('data-video-id');
      if (explicit) { matched = explicit === awemeId; break; }
      const links = Array.from(container.querySelectorAll('a[href*="/video/"]')).slice(0, 12);
      const ids = new Set(links.map(link => { try { return new URL((link as HTMLAnchorElement).href).pathname.match(/^\/video\/(\d+)/)?.[1]; } catch { return undefined; } }).filter(Boolean));
      if (ids.size === 1 && ids.has(awemeId) && container.querySelectorAll('video').length <= 1) { matched = true; break; }
    }
    // A page-level URL or a first video alone does not establish work identity.
    if (!matched) continue;
    const node = element as HTMLMediaElement;
    const urls = [node.currentSrc, node.src, ...Array.from(element.querySelectorAll('source')).map(source => source.src)];
    for (const url of urls) if (/^https:\/\//.test(url)) media.push({ url, audioOnly: element.tagName === 'AUDIO' });
  }
  const pageText = (document.body?.innerText || '').slice(0, 20_000);
  return { states, media, challenge: /完成验证|拖动滑块|安全验证|扫码登录后|请先登录后观看/.test(pageText) };
}
