import type { BrowserMediaDiagnostic } from '../shared/browser-media';

const PRODUCT = 'ResearchBookshelf/0.1.0';

/** Keep Chromium/platform details, replacing the entire non-ASCII product token. */
export function browserUserAgent(original: string): string {
  const tokens = original.replace(/[\x00-\x1f\x7f]/g, ' ').split(/\s+/);
  const value = tokens.map(token => {
    if (/[^\x20-\x7e]/.test(token) && /^[^/]+\/[^/]+$/.test(token)) return PRODUCT;
    return token.replace(/[^\x21-\x7e]/g, '');
  }).filter(Boolean).join(' ');
  return value || PRODUCT;
}

const ERROR_NAMES = new Set([
  'BrowserMediaError',
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
  'AggregateError', 'AbortError', 'TimeoutError', 'DOMException',
  'UndiciError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'HeadersOverflowError',
  'BodyTimeoutError', 'InvalidArgumentError', 'InvalidReturnValueError', 'InformationalError',
  'RequestContentLengthMismatchError', 'ResponseContentLengthMismatchError',
  'ClientDestroyedError', 'ClientClosedError', 'SocketError', 'NotSupportedError',
  'MissingUpstreamError', 'HTTPParserError', 'ResponseExceededMaxSizeError',
  'RequestRetryError', 'ResponseError', 'SecureProxyConnectionError', 'ProxyConnectionError',
  'MaxOriginsReachedError', 'Socks5ProxyError', 'MessageSizeExceededError',
]);
const ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EIO',
  'EBUSY', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENOMEM', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'ENOBUFS', 'EADDRNOTAVAIL', 'EADDRINUSE', 'ABORT_ERR',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_URL', 'ERR_INVALID_PROTOCOL',
  'ERR_INVALID_HTTP_TOKEN', 'ERR_INVALID_CHAR', 'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_UNESCAPED_CHARACTERS', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PROTOCOL_ERROR',
  'UND_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_INVALID_ARG', 'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_ABORT', 'UND_ERR_ABORTED', 'UND_ERR_INFO', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_SOCKET', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_BPL_MISSING_UPSTREAM',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE', 'UND_ERR_REQ_RETRY', 'UND_ERR_RESPONSE', 'UND_ERR_PRX_TLS',
  'UND_ERR_PRX_CONN', 'UND_ERR_MAX_ORIGINS_REACHED', 'UND_ERR_SOCKS5', 'UND_ERR_WS_MESSAGE_SIZE_EXCEEDED',
  'HPE_INVALID_HEADER_TOKEN', 'HPE_INVALID_CONTENT_LENGTH', 'HPE_UNEXPECTED_CONTENT_LENGTH',
  'HPE_INVALID_CHUNK_SIZE', 'HPE_INVALID_EOF_STATE', 'HPE_INVALID_STATUS', 'HPE_INVALID_VERSION',
]);

function allowed(value: unknown, values: Set<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined;
}
function property(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** Do not read or return messages, stacks, paths, request headers or URL-bearing fields. */
export function safeBrowserError(error: unknown): { errorName?: string; errorCode?: string; causeCode?: string } {
  const errorName = allowed(property(error, 'name'), ERROR_NAMES);
  const errorCode = allowed(property(error, 'code'), ERROR_CODES);
  const causeCode = allowed(property(property(error, 'cause'), 'code'), ERROR_CODES);
  return {
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

const STAGES: Record<BrowserMediaDiagnostic['stage'], string> = {
  initialize: '初始化', url: '媒体地址校验', dns: '公网地址解析', cookies: '读取站点 Cookies',
  request_headers: '准备请求头', connect: '请求媒体', response: '检查媒体响应',
  file_open: '创建临时文件', stream: '读取媒体数据', file_write: '写入媒体文件',
  file_close: '关闭媒体文件', file_rename: '保存完整媒体',
};
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function formatBrowserDiagnostic(diagnostic: BrowserMediaDiagnostic): string {
  const label = Object.prototype.hasOwnProperty.call(STAGES, diagnostic.stage) ? STAGES[diagnostic.stage] : '媒体处理';
  const parts = [`${label}${diagnostic.outcome === 'ok' ? '完成' : '失败'}`];
  const candidate = count(diagnostic.candidateIndex);
  if (candidate !== undefined && candidate > 0) parts.push(`${diagnostic.audioOnly === true ? '音轨' : '视频'}候选 ${candidate}`);
  const elapsed = count(diagnostic.elapsedMs), bytes = count(diagnostic.bytesReceived), status = count(diagnostic.httpStatus);
  if (elapsed !== undefined) parts.push(`耗时 ${elapsed} ms`);
  if (status !== undefined && status >= 100 && status <= 599) parts.push(`HTTP ${status}`);
  if (bytes !== undefined) parts.push(`已接收 ${bytes} bytes`);
  const errorName = allowed(diagnostic.errorName, ERROR_NAMES), errorCode = allowed(diagnostic.errorCode, ERROR_CODES), causeCode = allowed(diagnostic.causeCode, ERROR_CODES);
  if (errorName) parts.push(errorName);
  if (errorCode) parts.push(`错误码 ${errorCode}`);
  if (causeCode) parts.push(`原因码 ${causeCode}`);
  if (diagnostic.userAgentNormalized === true) parts.push('User-Agent 已规范化');
  return parts.join('；') + '。';
}
