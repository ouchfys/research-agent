export interface Category { id: string; parentId: string | null; name: string; description: string; includes: string; excludes: string; scopeConfirmed: boolean; metadataVersion: number; count?: number }
export interface SourceRef { id: string; title: string; url?: string; kind: string; coverage: string; accessedAt: string }
export interface DocumentMeta { id: string; categoryId: string; title: string; description: string; aliases: string[]; paperIds: string[]; sources: SourceRef[]; version: number; createdAt: string; updatedAt: string }
export interface KnowledgeDocument extends DocumentMeta { body: string; archivedIntoId?: string }
export interface Version extends KnowledgeDocument { reason: string }
export interface Draft extends KnowledgeDocument { draftId: string; taskId: string; baseVersion: number; revision: number; status: 'draft'|'reviewed'|'published'; review?: SelfReview; publishedVersion?: number; mergeFrom?: Array<{ id: string; version: number }> }
export interface SelfReview { materialUnderstanding: string; speculation: string; conditions: string; methodIdentity: string; conflicts: string; structure: string; metadataConsistency: string; passed: boolean; fixes: string }
export interface Scan { taskId: string; categoryId: string; metadataVersion: number; total: number; providedIds: string[]; pages: number[]; readIds: string[]; complete: boolean; scope?: 'category'|'identity' }
export type TaskStatus = 'queued'|'running'|'waiting_user'|'paused'|'failed'|'completed'|'unconfigured';
export interface Task { id: string; title: string; kind?: 'research'|'ingestion'; status: TaskStatus; stage: string; selectedDocIds: string[]; sourceIds: string[]; retrievalMode?: 'collection'|'maintenance'; sessionFile?: string; previousSessionFiles?: string[]; retrySourceIds?: string[]; retryInputIds?: string[]; inputSummary?: { total: number; published: number; blocked: number; pending: number }; error?: string; createdAt: string; updatedAt: string }
export interface HistoryClearResult { backupPath?: string; deletedTasks: number; deletedMessages: number; deletedRecords: number; preservedTaskIds: string[]; reason?: string; retainedFiles?: string[] }
export type MaintenanceOutcome = 'merged'|'no_change';
export interface MaintenanceReport { documentId: string; version: number; outcome: MaintenanceOutcome; comparedDocIds: string[]; mergedDocIds?: string[]; concept?: string; summary: string }
export interface MaintenanceItem { documentId: string; title: string; categoryId: string; initialVersion: number; status: 'pending'|'done'; checkedVersion?: number; outcome?: MaintenanceOutcome; mergedDocIds?: string[]; concept?: string; summary?: string; completedAt?: string }
export interface MaintenanceRun { id: string; taskId: string; status: TaskStatus; stage: string; error?: string; items: MaintenanceItem[]; total: number; checked: number; mergedCount: number; noChangeCount: number; diffCount: number; legacyChecks?: boolean; currentDocumentId?: string; currentDocumentTitle?: string; progressMessage?: string; startedAt: string; updatedAt: string; completedAt?: string }
export interface MaintenanceState { dataDir: string; totalDocuments: number; pendingCount: number; lastCompletedAt?: string; run?: MaintenanceRun }
export interface TaskInput { id: string; taskId: string; sourceIds: string[]; status: 'pending'|'published'|'answered'|'skipped'|'blocked'; reason?: string; documentIds: string[]; updatedAt: string }
export interface InputOutcome { inputId: string; status: 'published'|'answered'|'skipped'|'blocked'; reason: string; documentIds?: string[] }
export interface Message { id: string; taskId: string; turnId?: string; role: 'user'|'assistant'|'system'; content: string; createdAt: string }
export interface TaskEvent { id: string; taskId: string; turnId?: string; stage: string; message: string; createdAt: string; detail?: unknown }
export interface TurnPublication { id: string; title: string; version: number; draftId?: string }
export interface ResearchTurn {
  id: string; taskId: string; userMessageId?: string; startedAt: string; finishedAt?: string;
  elapsedMs: number; runningSince?: string; lastActivityAt?: string; status: TaskStatus; legacy?: boolean;
  inputs?: TaskInput[]; publications?: TurnPublication[];
  usage?: import('./usage').UsageSummary; usageHistoryIncomplete?: boolean;
}
export interface Conflict { id: string; taskId: string; docIds: string[]; sourceIds: string[]; oldClaim: string; newClaim: string; reason: string; status: 'suspected'|'confirmed'|'dismissed'|'resolved'; review?: string; evidence: SourceRef[]; conditionsA?: string; conditionsB?: string; decision?: 'A'|'B'|'C'; resolution?: string; createdAt: string; updatedAt: string }
export interface MaterialStage { name: string; status: 'ok'|'partial'|'failed'|'skipped'; detail: string }
export interface RawMaterial { id: string; taskId: string; kind: string; title: string; url?: string; text: string; coverage: string; status: 'available'|'partial'|'unavailable'; error?: string; filePath?: string; mimeType?: string; createdAt: string; metadata?: Record<string, unknown> & { stages?: MaterialStage[] } }
export type ModelProvider = 'deepseek' | 'aliyun' | 'custom';
export interface EndpointConfig { provider?: ModelProvider; baseUrl: string; model: string; apiKey: string }
export interface PaperParsingConfig { arxivHtmlBaseUrl: string; arxivHtmlTimeoutSeconds: number; mineru: { baseUrl: string; model: string; apiToken: string; timeoutSeconds: number; pollIntervalSeconds: number } }
export interface Settings { text: EndpointConfig; vision: EndpointConfig & {useTextModel?: boolean}; mediaVision: EndpointConfig; transcription: EndpointConfig & { protocol: 'openai'|'dashscope' }; search: { provider: 'deepseek'; baseUrl: string; model: string; apiKey: string }; paperParsing: PaperParsingConfig; dataDir: string; ytDlpPath: string; ffmpegPath: string; mediaCookiesPath: string }
export type SettingsPatch = Omit<Partial<Settings>, 'paperParsing'> & {
  providerKeys?: Partial<Record<'aliyun'|'deepseek', string>>;
  paperParsing?: Partial<Omit<PaperParsingConfig, 'mineru'>> & { mineru?: Partial<PaperParsingConfig['mineru']> };
};
export interface StorageInspection { requestedPath: string; targetPath?: string; status: 'current'|'empty'|'missing'|'library'|'invalid'; exists: boolean; canCopy: boolean; canOpen: boolean; recommendedMode?: 'move'|'open'; message: string; documentCount?: number }
export interface PublicSettings { text: Omit<EndpointConfig,'apiKey'> & {configured: boolean; hasKey: boolean}; vision: Omit<Settings['vision'],'apiKey'> & {configured:boolean;hasKey:boolean}; mediaVision: Omit<EndpointConfig,'apiKey'> & {configured:boolean;hasKey:boolean}; transcription: Omit<Settings['transcription'],'apiKey'> & {configured:boolean;hasKey:boolean}; search: Omit<Settings['search'],'apiKey'> & {configured:boolean;hasKey:boolean}; paperParsing: Omit<PaperParsingConfig,'mineru'> & {mineru: Omit<PaperParsingConfig['mineru'],'apiToken'> & {hasToken:boolean;configured:boolean;source?:'env'|'saved'|'none'}}; dataDir: string; ytDlpPath:string; ffmpegPath:string; mediaCookiesPath:string; providers: Record<'aliyun'|'deepseek',{hasKey:boolean;source:'env'|'saved'|'none'}>; envFile?:string; pendingDataDir?:string }
export interface Snapshot { categories: Category[]; tasks: Task[]; conflicts: Conflict[]; settings: PublicSettings; recovered: boolean }
export interface TaskDetail { task: Task; messages: Message[]; events: TaskEvent[]; scans: Scan[]; drafts: Draft[]; sources: RawMaterial[]; inputs: TaskInput[]; conflicts: Conflict[]; turns: ResearchTurn[] }
export interface Upload { name: string; mimeType: string; data: string; localToken?: string; localPath?: string }
export interface ShelfAPI { call<T = unknown>(method: string, payload?: unknown): Promise<T>; onEvent(listener: (event: {type: string; taskId?: string; data?: unknown})=>void): ()=>void; chooseFiles(): Promise<Upload[]>; chooseDirectory(): Promise<string|null>; importEnv():Promise<PublicSettings|null>; openPath(path: string): Promise<void>; openExternal(url:string): Promise<void> }
declare global { interface Window { shelf: ShelfAPI } }
