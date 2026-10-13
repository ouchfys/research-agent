export interface ArxivIdentity { id: string; baseId: string; version?: number; kind: 'abs'|'pdf'|'html'; absUrl: string; pdfUrl: string }
const PAPER_ID = /^(\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v([1-9]\d*))?$/i;

/** Recognize an arXiv identifier only from an arXiv URL or the explicitly configured HTML origin/path. */
export function arxivIdentity(value: string, htmlBaseUrl?: string): ArxivIdentity | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  let kind: ArxivIdentity['kind'] | undefined, path = '';
  if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
    const match = url.pathname.match(/^\/(abs|pdf|html)\/(.+?)\/?$/i);
    if (match) { kind = match[1].toLowerCase() as ArxivIdentity['kind']; path = match[2]; }
  }
  if (!kind && htmlBaseUrl) {
    try {
      const base = new URL(htmlBaseUrl), prefix = base.pathname.replace(/\/+$/, '') + '/';
      if (url.origin === base.origin && url.pathname.startsWith(prefix)) { kind = 'html'; path = url.pathname.slice(prefix.length).replace(/\/+$/, ''); }
    } catch { return undefined; }
  }
  if (!kind) return undefined;
  try { path = decodeURIComponent(path).replace(/\.pdf$/i, ''); } catch { return undefined; }
  const match = PAPER_ID.exec(path);
  if (!match) return undefined;
  const baseId = match[1], version = match[2] ? Number(match[2]) : undefined;
  if (version !== undefined && !Number.isSafeInteger(version)) return undefined;
  const id = baseId + (version ? 'v' + version : '');
  return { id, baseId, version, kind, absUrl: 'https://arxiv.org/abs/' + id, pdfUrl: 'https://arxiv.org/pdf/' + id };
}

export function arxivHtmlUrl(paper: ArxivIdentity, baseUrl = 'https://arxiv.org/html'): string {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('arXiv HTML 根地址必须为无账号密码、查询参数和片段的 HTTP(S) 地址。');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/' + paper.id.split('/').map(encodeURIComponent).join('/');
  return base.href;
}

/** Versioned input must never silently become a different paper/version after a redirect. */
export function assertArxivTarget(expected: ArxivIdentity, actualUrl: string, htmlBaseUrl?: string): void {
  const actual = arxivIdentity(actualUrl, htmlBaseUrl);
  if (actual && (actual.baseId.toLowerCase() !== expected.baseId.toLowerCase() || (expected.version !== undefined && actual.version !== expected.version))) throw new Error('来源跳转到了不同的 arXiv 论文或版本，已拒绝替代指定材料。');
}
