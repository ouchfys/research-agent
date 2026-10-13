import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, CircleDashed, Clock3, LoaderCircle, MessageSquare, Minus, X } from 'lucide-react';
import type { DocumentMeta, Message, RawMaterial, ResearchTurn, TaskDetail, TaskEvent, TaskInput } from '../shared/types';
import type { UsageGroupSummary, UsageSummary, UsageTotals } from '../shared/usage';
import { dateText, Markdown } from './ui';

interface Props {
  detail: TaskDetail;
  streaming: string;
  documents: Record<string, DocumentMeta>;
  onDocument: (id: string) => void;
  onRaw: (id: string) => void;
}
interface TurnView { turn: ResearchTurn; messages: Message[]; events: TaskEvent[] }
type ConversationEntry = { kind: 'turn'; view: TurnView; time: string } | { kind: 'message'; message: Message; time: string };
type ProcessEntry = { kind: 'message'; message: Message; time: string } | { kind: 'event'; event: TaskEvent; time: string };

function chronology(left: {time: string}, right: {time: string}) { return Date.parse(left.time) - Date.parse(right.time); }

export default function ResearchConversation({ detail, streaming, documents, onDocument, onRaw }: Props) {
  const { entries, unassignedEvents, activeTurnId } = useMemo(() => {
    const views = new Map((detail.turns || []).map(turn => [turn.id, { turn, messages: [] as Message[], events: [] as TaskEvent[] }]));
    const userTurns = new Map((detail.turns || []).filter(turn => turn.userMessageId).map(turn => [turn.userMessageId!, turn.id]));
    const orphanMessages: Message[] = [];
    const orphanEvents: TaskEvent[] = [];
    for (const message of detail.messages) {
      const view = views.get(message.turnId || userTurns.get(message.id) || '');
      if (view) view.messages.push(message); else orphanMessages.push(message);
    }
    for (const event of detail.events) {
      const view = views.get(event.turnId || '');
      if (view) view.events.push(event); else orphanEvents.push(event);
    }
    const entries: ConversationEntry[] = [...views.values()].map(view => ({ kind: 'turn', view, time: view.messages.find(message => message.id === view.turn.userMessageId)?.createdAt || view.turn.startedAt }));
    entries.push(...orphanMessages.map(message => ({ kind: 'message' as const, message, time: message.createdAt })));
    entries.sort(chronology);
    const activeTurn = [...views.values()].filter(view => view.turn.status === 'running' || view.turn.status === 'queued').sort((a, b) => Date.parse(b.turn.startedAt) - Date.parse(a.turn.startedAt))[0];
    return { entries, unassignedEvents: orphanEvents, activeTurnId: activeTurn?.turn.id };
  }, [detail]);

  return <div className="research-conversation" role="log" aria-label="研究对话">
    {entries.map(entry => entry.kind === 'message'
      ? <ConversationMessage key={`message-${entry.message.id}`} message={entry.message} />
      : <ResearchTurnView key={`turn-${entry.view.turn.id}`} view={entry.view} streaming={entry.view.turn.id === activeTurnId ? streaming : ''} sources={detail.sources} documents={documents} onDocument={onDocument} onRaw={onRaw} />)}
    {unassignedEvents.length > 0 && <details className="turn-process disclosure unassigned-process"><summary><Clock3 size={14} aria-hidden="true" /><span>未归属回合的历史记录</span><ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" /></summary><div className="turn-process-body">{unassignedEvents.map(event => <ProcessEvent key={event.id} event={event} />)}</div></details>}
  </div>;
}

function elapsedText(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', !hours && (!minutes || remainder) ? `${remainder} 秒` : ''].filter(Boolean).join(' ');
}

function ResearchTurnView({ view, streaming, sources, documents, onDocument, onRaw }: { view: TurnView; streaming: string; sources: RawMaterial[]; documents: Record<string, DocumentMeta>; onDocument: Props['onDocument']; onRaw: Props['onRaw'] }) {
  const { turn } = view;
  const active = turn.status === 'running' || turn.status === 'queued';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !turn.runningSince) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, turn.runningSince]);
  const runningStart = turn.runningSince ? Date.parse(turn.runningSince) : NaN;
  const elapsedMs = Math.max(0, turn.elapsedMs || 0) + (active && Number.isFinite(runningStart) ? Math.max(0, now - runningStart) : 0);
  const sortedMessages = useMemo(() => [...view.messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), [view.messages]);
  const finalMessage = active ? undefined : [...sortedMessages].reverse().find(message => message.role === 'assistant');
  const process = useMemo<ProcessEntry[]>(() => [
    ...sortedMessages.filter(message => message.role !== 'user' && message.id !== finalMessage?.id).map(message => ({ kind: 'message' as const, message, time: message.createdAt })),
    ...view.events.map(event => ({ kind: 'event' as const, event, time: event.createdAt })),
  ].sort(chronology), [sortedMessages, finalMessage?.id, view.events]);
  const stateLabel = active ? '研究中' : turn.status === 'waiting_user' ? '等待回复' : turn.status === 'paused' ? '已暂停' : turn.status === 'failed' ? '执行失败' : turn.status === 'unconfigured' ? '待配置模型' : '';
  const durationLabel = turn.legacy && elapsedMs === 0 ? '用时未记录' : `用时${turn.legacy ? '约' : ''} ${elapsedText(elapsedMs)}`;

  return <section className="research-turn" aria-label="一轮研究">
    {sortedMessages.filter(message => message.role === 'user').map(message => <ConversationMessage key={message.id} message={message} />)}
    <details className="turn-process disclosure">
      <summary title={turn.legacy ? '历史回合的用时根据记录时间估算。' : '累计实际运行时间，不包含暂停等待。'}>{active ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Clock3 size={14} aria-hidden="true" />}<span>{durationLabel}</span><ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />{stateLabel && <span className={`turn-run-state ${turn.status === 'failed' ? 'has-error' : ''}`}>{stateLabel}</span>}</summary>
      <div className="turn-process-body">{process.length ? process.map(entry => entry.kind === 'message' ? <ConversationMessage key={`message-${entry.message.id}`} message={entry.message} /> : <ProcessEvent key={`event-${entry.event.id}`} event={entry.event} />) : <p className="process-empty">{active ? '正在准备这一轮研究。' : '这一轮没有更多过程记录。'}</p>}{streaming && <article className="message message-assistant streaming"><header><span>研究助手</span><span className="muted">正在输出</span></header><Markdown compact>{streaming}</Markdown></article>}</div>
    </details>
    {finalMessage && <div className="turn-final"><Markdown compact>{finalMessage.content}</Markdown></div>}
    <TurnResults turn={turn} sources={sources} documents={documents} onDocument={onDocument} onRaw={onRaw} />
    <TurnUsage usage={turn.usage} incomplete={turn.usageHistoryIncomplete} active={active} />
  </section>;
}

function ConversationMessage({ message }: {message: Message}) {
  return <article className={`message message-${message.role}`}><header><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? '研究助手' : '任务记录'}</span><time>{dateText(message.createdAt)}</time></header>{message.role === 'assistant' ? <Markdown compact>{message.content}</Markdown> : <p className="message-text">{message.content}</p>}</article>;
}

function ProcessEvent({ event }: {event: TaskEvent}) {
  return <div className={`progress-event ${event.stage === 'error' ? 'process-event-error' : ''}`}><span className="event-dot" aria-hidden="true" /><div><p>{event.message}</p><time>{dateText(event.createdAt)}</time></div></div>;
}

const inputStatusLabels: Record<TaskInput['status'], string> = { pending: '待处理', published: '已发布', answered: '已在对话回答', skipped: '已跳过', blocked: '处理失败' };

function TurnResults({ turn, sources, documents, onDocument, onRaw }: {turn: ResearchTurn; sources: RawMaterial[]; documents: Record<string, DocumentMeta>; onDocument: Props['onDocument']; onRaw: Props['onRaw']}) {
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const publications = new Map<string, {id: string; title: string; version?: number}>();
  for (const publication of turn.publications || []) {
    const previous = publications.get(publication.id);
    if (!previous || !previous.version || publication.version >= previous.version) publications.set(publication.id, publication);
  }
  for (const input of turn.inputs || []) {
    if (input.status !== 'published') continue;
    for (const id of input.documentIds) if (!publications.has(id)) publications.set(id, { id, title: documents[id]?.title || '关联文档' });
  }
  const outcomes = (turn.inputs || []).flatMap(input => {
    if (input.status === 'published') return [];
    const linkedSources = input.sourceIds.map(id => sourceMap.get(id)).filter((source): source is RawMaterial => Boolean(source));
    // A textual instruction answered in the final reply is not a new artifact.
    if (input.status === 'answered' && (!linkedSources.length || linkedSources.every(source => source.kind === 'text' && !source.url))) return [];
    const reversed = [...linkedSources].reverse();
    const source = reversed.find(item => item.title && !/^https?:\/\//i.test(item.title)) || reversed[0];
    return [{ input, source, title: source?.title || source?.url || '提交的材料' }];
  });
  if (!publications.size && !outcomes.length) return null;

  return <div className="turn-results" aria-label="本轮结果">
    {[...publications.values()].map(publication => <button key={publication.id} type="button" className="result-card result-success" onClick={() => onDocument(publication.id)}><Check size={18} aria-hidden="true" /><span><strong>{publication.title}</strong><small>{publication.version === undefined ? '已关联文档' : `已发布 v${publication.version}`} · 打开文档</small></span></button>)}
    {outcomes.map(({ input, source, title }) => {
      const contents = <>{input.status === 'blocked' ? <X size={18} aria-hidden="true" /> : input.status === 'pending' ? <CircleDashed size={18} aria-hidden="true" /> : input.status === 'skipped' ? <Minus size={18} aria-hidden="true" /> : <MessageSquare size={17} aria-hidden="true" />}<span><strong>{title}</strong><small>{inputStatusLabels[input.status]}{source ? ' · 查看材料' : ''}</small>{input.status === 'blocked' && input.reason && <span className="result-reason" title={input.reason}>{input.reason}</span>}</span></>;
      const className = `result-card ${input.status === 'blocked' ? 'result-failure' : 'result-neutral'}`;
      return source ? <button key={input.id} type="button" className={className} onClick={() => onRaw(source.id)}>{contents}</button> : <div key={input.id} className={className}>{contents}</div>;
    })}
  </div>;
}

function currency(value: number) {
  if (value > 0 && value < .000001) return '¥<0.000001';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}
function costLabel(usage: UsageTotals, incomplete = false) {
  if (!usage.requests) return '暂无用量记录';
  const partial = usage.hasUnknown || incomplete;
  if (partial && usage.estimatedMinCny === 0 && usage.estimatedMaxCny === 0) return '暂不可计价';
  const range = Math.abs(usage.estimatedMaxCny - usage.estimatedMinCny) > .0000001;
  return `${partial ? '已知部分' : '估算'} ${currency(usage.estimatedMinCny)}${range ? `–${currency(usage.estimatedMaxCny)}` : ''}`;
}
function number(value: number) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value); }
const purposeLabels: Record<UsageGroupSummary['purpose'], string> = { agent: '主模型', compaction: '上下文整理', vision: '视觉理解', asr: '语音转写', search: '联网搜索', parsing: 'PDF 解析' };

export function TurnUsage({ usage, incomplete, active, label = '本轮 API' }: {usage?: UsageSummary; incomplete?: boolean; active: boolean; label?: string}) {
  return <details className="turn-usage disclosure">
    <summary><span>{label}</span><strong>{usage ? costLabel(usage, incomplete) : active ? '等待用量回传' : '费用未记录'}</strong><ChevronDown size={12} className="disclosure-chevron" aria-hidden="true" />{usage && usage.requests > 0 && <span className="usage-request-count">{usage.requests} 条用量记录</span>}{(usage?.hasUnknown || incomplete) && <span className="usage-unknown">{usage?.hasUnknown && <span>另有未计价请求或服务费{usage.unknownRequests ? `（${usage.unknownRequests} 条记录）` : ''}。</span>}{incomplete && <span>历史费用未完整记录。</span>}</span>}</summary>
    <div className="turn-usage-body">{usage && usage.requests > 0 ? <><UsageMetrics usage={usage} />{usage.groups.map(group => <section className="usage-group" key={`${group.purpose}:${group.provider}:${group.model}`}><header><span>{purposeLabels[group.purpose]}</span><strong>{costLabel(group)}</strong></header><p className="usage-model">{group.provider} · {group.model}</p><UsageMetrics usage={group} />{group.hasUnknown && <p className="field-help">含未计价部分；未知用量不按零计费。</p>}</section>)}</> : <p className="field-help">{active ? 'API 返回真实用量后会在这里更新。' : '这一轮没有足够的用量记录，不能据此判断为免费。'}</p>}<p className="usage-estimate-note">这里只显示已记录的用量。金额按模型价格估算，以服务商账单为准。DeepSeek 费用区间来自公开高峰与低峰单价，并非随机误差。缓存命中与未命中属于输入 token，不重复相加。</p></div>
  </details>;
}

function UsageMetrics({ usage }: {usage: UsageTotals}) {
  return <dl className="usage-metrics"><div><dt>用量记录</dt><dd>成功 {usage.successfulRequests} 条{usage.failedRequests > 0 ? ` / 失败 ${usage.failedRequests} 条` : ''}</dd></div><div><dt>输入 / 输出</dt><dd>{number(usage.inputTokens)} / {number(usage.outputTokens)} tokens</dd></div>{(usage.cacheReadTokens > 0 || usage.cacheMissTokens > 0) && <div><dt>输入缓存命中 / 未命中</dt><dd>{number(usage.cacheReadTokens)} / {number(usage.cacheMissTokens)}</dd></div>}{usage.cacheWriteTokens > 0 && <div><dt>输入缓存写入</dt><dd>{number(usage.cacheWriteTokens)} tokens</dd></div>}{usage.audioSeconds > 0 && <div><dt>音频时长</dt><dd>{number(usage.audioSeconds)} 秒</dd></div>}</dl>;
}
