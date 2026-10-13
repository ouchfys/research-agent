export interface ArticleMarkdownOptions {
  maxCharacters?: number;
  maxNodes?: number;
  maxDepth?: number;
  visibleOnly?: boolean;
}
export interface ArticleMarkdown {
  text: string;
  images: Array<{ index: number; url: string }>;
  imageCount: number;
  hasText: boolean;
  truncated: boolean;
  structureLimited: boolean;
}

/**
 * Self-contained: also serialized into Chromium beside articleSnapshot.
 * Keep runtime dependencies inside this function; never evaluate article scripts.
 * Images retain their DOM positions as numbered markers, with URLs in the image list.
 */
export function renderArticleMarkdown(root: Element, baseUrl: string, options: ArticleMarkdownOptions = {}): ArticleMarkdown {
  const maximum = options.maxCharacters ?? 400_000, maxNodes = options.maxNodes ?? 100_000, maxDepth = options.maxDepth ?? 100;
  let visited = 0, structureLimited = false, truncated = false, hasText = false;
  const imageNodes = root.querySelectorAll('img'), imageIndices = new Map<Element, number>();
  const safeUrl = (value: string | null): string => {
    if (!value || value.length > 16_384) return '';
    try {
      const url = new URL(value, baseUrl);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const images: Array<{ index: number; url: string }> = [];
  for (let index = 0; index < Math.min(imageNodes.length, maxNodes); index++) {
    const node = imageNodes[index]; imageIndices.set(node, index + 1);
    if (index < 24) images.push({ index: index + 1, url: safeUrl(node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src')) });
  }
  const escape = (value: string) => value.replace(/([\\`*_[\]<>#|])/g, '\\$1');
  const bound = (value: string) => {
    if (value.length <= maximum) return value;
    truncated = true;
    let end = maximum;
    if (/[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    return value.slice(0, end);
  };
  const hidden = (node: Element) => {
    if (!options.visibleOnly) return false;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true;
    const view = node.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden';
    }
    return false;
  };
  const children = (node: Node, depth: number): string => {
    let output = '';
    for (const child of Array.from(node.childNodes)) {
      const part = render(child, depth + 1);
      if (output.endsWith('\n') && part.startsWith('\n')) output = output.replace(/\n+$/, '\n\n') + part.replace(/^\n+/, '');
      else output += part;
      if (output.length > maximum) return bound(output);
      if (structureLimited) break;
    }
    return output;
  };
  const block = (value: string) => value.trim() ? '\n\n' + value.trim() + '\n\n' : '';
  const codeFence = (text: string, minimum: number) => {
    let width = minimum;
    for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    return '`'.repeat(width);
  };
  const listItem = (node: Element, depth: number, marker: string) => {
    if (++visited > maxNodes || depth > maxDepth) { structureLimited = true; return ''; }
    const content = children(node, depth).trim();
    if (!content) return '';
    const padding = ' '.repeat(marker.length + 1);
    return marker + ' ' + content.replace(/\n/g, '\n' + padding);
  };
  const render = (node: Node, depth: number): string => {
    if (++visited > maxNodes || depth > maxDepth) { structureLimited = true; return ''; }
    if (node.nodeType === 3) {
      const text = (node.textContent || '').replace(/\s+/g, ' ');
      if (text.trim()) hasText = true;
      return escape(text);
    }
    if (node.nodeType !== 1) return '';
    const element = node as Element, tag = element.localName.toLowerCase();
    if (['script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea', 'template'].includes(tag) || hidden(element)) return '';
    if (tag === 'img') {
      const index = imageIndices.get(element), alt = (element.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      return index ? block('[正文配图 ' + index + (alt ? '：' + escape(alt) : '') + ']') : '';
    }
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'pre') {
      const text = bound((element.textContent || '').replace(/\r\n?/g, '\n'));
      if (text.trim()) hasText = true;
      const fence = codeFence(text, 3);
      const language = element.querySelector('code')?.getAttribute('class')?.match(/(?:^|\s)language-([a-z0-9_#+.-]{1,30})(?:\s|$)/i)?.[1] || '';
      return '\n\n' + fence + language + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence + '\n\n';
    }
    if (tag === 'code') {
      const text = bound((element.textContent || '').replace(/\r\n?/g, '\n'));
      if (text.trim()) hasText = true;
      const fence = codeFence(text, 1);
      return fence + ' ' + text.replace(/\n/g, ' ') + ' ' + fence;
    }
    if (tag === 'ul' || tag === 'ol') {
      const rows: string[] = []; let position = Number(element.getAttribute('start') || 1), characters = 0;
      if (!Number.isSafeInteger(position)) position = 1;
      for (const item of Array.from(element.children)) {
        if (hidden(item)) continue;
        let row: string;
        if (item.localName.toLowerCase() !== 'li') row = render(item, depth + 1);
        else {
          const specified = item.getAttribute('value');
          if (specified !== null && Number.isSafeInteger(Number(specified))) position = Number(specified);
          row = listItem(item, depth + 1, tag === 'ol' ? String(position++) + '.' : '-');
        }
        rows.push(row); characters += row.length + 1;
        if (characters > maximum) { truncated = true; break; }
        if (structureLimited) break;
      }
      return block(bound(rows.filter(Boolean).join('\n')));
    }
    if (tag === 'table') {
      const rows: string[][] = []; let characters = 0;
      for (const row of Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element)) {
        if (++visited > maxNodes || depth + 1 > maxDepth) { structureLimited = true; break; }
        if (hidden(row)) continue;
        const cells: string[] = [];
        for (const cell of Array.from(row.children)) {
          if (!['th', 'td'].includes(cell.localName.toLowerCase()) || hidden(cell)) continue;
          if (++visited > maxNodes || depth + 2 > maxDepth) { structureLimited = true; break; }
          const span = [Number(cell.getAttribute('rowspan')) > 1 ? '跨' + cell.getAttribute('rowspan') + '行' : '', Number(cell.getAttribute('colspan')) > 1 ? '跨' + cell.getAttribute('colspan') + '列' : ''].filter(Boolean).join('、');
          const value = children(cell, depth + 2).trim().replace(/\n+/g, ' / ').replace(/(?<!\\)\|/g, '\\|') + (span ? ' [' + span + ']' : '');
          cells.push(value); characters += value.length + 3;
          if (characters > maximum) { truncated = true; break; }
          if (structureLimited) break;
        }
        if (cells.length) rows.push(cells);
        if (characters > maximum) { truncated = true; break; }
        if (structureLimited) break;
      }
      if (!rows.length) return '';
      const width = rows.reduce((count, row) => Math.max(count, row.length), 0);
      let table = '';
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        table += '| ' + [...row, ...Array(Math.max(0, width - row.length)).fill('')].join(' | ') + ' |\n';
        if (index === 0) table += '| ' + Array(width).fill('---').join(' | ') + ' |\n';
        if (table.length > maximum) { table = bound(table); break; }
      }
      const caption = element.querySelector('caption');
      return block((caption ? children(caption, depth + 1).trim() + '\n\n' : '') + table);
    }
    const content = children(element, depth);
    if (/^h[1-6]$/.test(tag)) return block('#'.repeat(Number(tag[1])) + ' ' + content.trim().replace(/\n+/g, ' '));
    if (tag === 'blockquote') return block(content.trim().split('\n').map(line => line ? '> ' + line : '>').join('\n'));
    if (tag === 'li') return block('- ' + content.trim().replace(/\n/g, '\n  '));
    if (tag === 'a') {
      const url = safeUrl(element.getAttribute('href'));
      if (!url || !content.trim()) return content;
      const onlyImage = element.children.length === 1 && element.children[0].localName.toLowerCase() === 'img';
      const image = onlyImage ? element.children[0] : undefined;
      if (image && url === safeUrl(image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src'))) return content;
      return '[' + content.trim().replace(/\n+/g, ' ') + '](<' + url.replace(/[<>\r\n]/g, value => encodeURIComponent(value)) + '>)';
    }
    if (['strong', 'b'].includes(tag)) return content.trim() ? '**' + content.trim() + '**' : '';
    if (['em', 'i'].includes(tag)) return content.trim() ? '*' + content.trim() + '*' : '';
    if (['p', 'section', 'div', 'article', 'figure', 'figcaption', 'header', 'footer', 'dl', 'dt', 'dd'].includes(tag)) return block(content);
    return content;
  };
  const text = bound(render(root, 0).trim());
  return { text, images, imageCount: imageNodes.length, hasText, truncated, structureLimited };
}
