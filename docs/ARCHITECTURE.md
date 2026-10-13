# 架构与运行流程

源码按 `src/renderer`、`src/electron`、`src/server`、`src/shared` 分层，构建统一到 `dist/renderer` 和 `dist/electron`；完整目录及持久化边界见 [项目结构](PROJECT-STRUCTURE.md)。

## 进程边界

React / Vite 渲染进程 → sandboxed preload 白名单 IPC → Electron 主进程 → `utilityProcess.fork` 的独立 Node 服务 → Pi SDK / SQLite / Markdown / 来源服务。

没有对外监听的 HTTP 服务端口。开发时 Vite 仅绑定 127.0.0.1。生产窗口加载打包的本地文件。渲染进程没有 Node、文件系统或模型密钥读取能力；主进程检查 IPC 的发送窗口及主 frame，服务再次按操作验证参数和冲突状态。外部链接仅允许 HTTP(S)，应用内导航与新窗口默认拒绝。

`src/electron/main.ts` 负责单实例锁、原生文件对话框、窗口、菜单、受控文件夹/来源打开及子进程退出。服务崩溃会通知界面，任务数据留存，重启后人工点击恢复。普通抓取、PDF 解析与模型调用发生在服务进程；抖音视频与图文的浏览器后备由服务通过内部 IPC 请求主进程，在隔离的隐藏临时会话中加载远程页面。该页面没有应用 preload、Node 或模型密钥权限，不属于 React 工作台窗口。

本地附件通过原生文件选择器授予不透明 `localToken`。渲染进程得到文件名、类型与令牌，不获得可自行授权的文件读取接口；主进程只在 `task.start` / `task.message` 中解令牌，并拒绝渲染进程直接提交 `localPath`。服务将可信路径的原件复制到独立来源目录后处理，媒体上限 512 MB，其他文件与拖拽/Base64 上限 32 MB。模型仍只通过材料 ID 读取，不接触上传令牌或任意本地路径。

## Pi 运行底座

锁定官方当前包 `@earendil-works/pi-coding-agent@1.0.2`。旧 `@mariozechner/pi-coding-agent` npm 已标记 deprecated，本工程不使用它。

调用已安装类型定义中的 `ModelRuntime.create/registerProvider/setRuntimeApiKey`、`createAgentSession`、`SessionManager.create/open`、`SettingsManager.inMemory` 和 `defineTool`。文本模型是 `openai-completions` 兼容提供方；联网、知识库与发布均为自定义工具。没有另造模型推理或工具调用循环。

官方模型通过共享的供应方与模型预设注册真实文本/图像能力和上下文范围。DeepSeek 官方可选 `deepseek-v4-pro`（DeepSeek V4 Pro，纯文本）和 `deepseek-flash`（DeepSeek V4.1 Flash，支持文本及图片）；百炼的 Flash 使用 `deepseek-v4.1-flash`。Pro 主模型应搭配独立的 Flash 视觉辅助，不能声明 Pro 支持图片。Pi 原生 `compat.thinkingFormat` 分别采用 `deepseek` / `qwen`，模型声明支持推理，而会话默认 `thinkingLevel: 'off'`，让 SDK 显式发送关闭思考参数。SDK 负责流式响应与 `reasoning_content` 持久化和重放，不另写模型循环。静态模型菜单依据官方模型元数据和文档维护，不代表真实账号连通验证。

ResourceLoader 是空资源实现，仅提供产品 system prompt；不加载用户系统上的 Pi 扩展、技能或项目说明。显式工具名称 allowlist 是唯一可调用集合；包含八个业务工具及经用户授权的原生命令行工具。每个任务持有同一个持久化 Pi JSONL 文件；一轮结束释放内存会话，后续恢复打开原文件。等待用户后结束本轮请求，不轮询、不保留永远等待的模型请求。

## 八个业务工具

业务工具从原先分散的 17 个入口收敛为以下八个，另有下节描述的一个原生命令行入口；Pi SDK、模型运行底座和持久化会话不变。恢复旧会话时继续使用原会话文件，不以旧工具名提供兼容入口。分类说明（categories）与材料目录（materials）通过公开的 `session.agent.prepareRequest` 在每次模型请求前增量提供；保留 SDK 原有请求准备链，不追加重复历史快照，不再要求模型单独调用目录工具。冲突期间仅提供只读分类快照，不执行新的分类扫描。

| 工具 | 职责与约束 |
|---|---|
| `scan_category` | 按任务模式选择唯一目录：collection 用非空 identity 精确查标题/别名/论文标识，scope=identity；maintenance 或 legacy 按预算完整提供直属简介，scope=category，超预算用 continuation |
| `read` | 统一 document、material、draft、url 的受控逻辑资源读取；保留各资源的权限与分页约束，禁止任意本地 path |
| `search` | `scope=web` 使用 DeepSeek 官方服务端搜索，`scope=papers` 保留 Crossref、OpenAlex、arXiv 论文检索 |
| `write_draft` | 在有效目录、相应模式扫描和版本约束下新建或修改草稿；维护未确认范围目录仅可更新既有文档 |
| `submit_draft` | 接收草稿 ID、revision 与主模型七项 review，后台校验后自动发布；可单独提交输入 outcomes 或 maintenanceReports，无需新增完成工具 |
| `report_conflict` | 记录疑似冲突并触发持久化限制，不替代核实或人类裁决 |
| `review_conflict` | 提交来源核实结果，证实无矛盾可驳回，确有矛盾进入等待裁决 |
| `ask_user` | 保存问题与等待状态，结束本轮，收到用户回复后从原 Pi 会话继续 |

## 原生命令行与临时研究目录

`research-shell.ts` 包装 Pi 原生 `createPowerShellToolDefinition`（Windows）或 `createBashToolDefinition`，继续由 SDK 执行、管理退出码、超时和取消，不引入另一个执行循环。每个研究运行创建独立 scratch；`spawnHook` 强制设置默认 cwd 并提供过滤后的子进程环境，避免 SDK 的 `ctx.cwd` 覆盖临时位置或继承服务商密钥。工具 schema 保持稳定，不嵌入每轮路径。默认 120 秒、最高 300 秒，实际输出限量并脱敏后才进入 SDK 和来源记录，避免原生无限输出落入全局临时日志。

来源选择仍由模型负责：发现相关项目或论文后按需读官方页面、clone 或查代码，不增加仓库专用工具或自动遍历流程。命令实际输出由 `SourceService.recordCommandOutput` 保存为 `kind=command/inputRole=context`，可作为既有草稿 `sourceIds`，不增加直接输入项。正文沿用受控草稿发布；命令行调用前后检查暂停、等待及全局冲突，确认冲突后不执行命令。

提示词要求只操作本轮临时文件、使用浅克隆、只读研究代码、记录 commit/文件路径并在收尾主动删除。宿主在 finally 兜底清理，失败显示事件；异常退出的自有旧目录在下次工作区初始化按 lease 与进程状态回收。删除前核对专用根、真实路径、符号链接和归属，不用模型提供的任意路径执行宿主递归删除。已经保存的文字来源不随 clone 删除。

这是用户明确授权的本机命令权限，沿用服务进程的操作系统用户，不主动提权；cwd、环境过滤和提示词均不构成文件系统或网络沙箱。通用命令具有绕过工具路径访问其他同用户文件的技术能力，程序不能把提示词禁令表述成强制路径隔离。

`read` 使用文档、材料、草稿的受控 ID 或 HTTP(S) URL，不把任意本地路径转换成文件读取。URL 读取直接返回真实正文首段、coverage 和分页信息；没有正文或只读到部分内容时如实返回范围，不把元数据当正文。读取材料时指定 `refresh=true` 会沿用受控的原始来源重新解析，生成新材料 ID 并保留旧记录。来源追踪和冲突期间的访问限制继续由后端执行；用户授权的本机命令行另遵循上述临时工作区约定。

读取参数使用根对象内的鉴别联合，例如 `{"resource":{"kind":"material","id":"来源ID","offset":18000}}`。`kind` 可为 document、material、draft、url；草稿的 id 是 draftId，URL 类型提供 url、purpose，冲突核实时同时提供 conflictId。材料索引包含当前任务来源、已选或已读文档的历史来源和当前冲突证据；索引中的标题、简介等字符串始终作为数据处理。

## 渐进式候选发现

独立「资料入库」通过 `Task.kind=ingestion` 与研究对话区分，仍复用受控业务工具和获取流程。新批次创建新 Task/Pi 会话。`task.retryInputs` 只选择 pending/blocked 输入，保留已完成项和历史用量，清空当前 sessionFile 并保留旧路径供记录/清理；`retryInputIds` 限制本次去向登记和草稿发布范围，`retrySourceIds` 是可恢复的程序获取队列。不可读来源先获取，可读内容直接研究；取消保留队列，一项失败不丢弃其他项。存在无关未发布草稿时先继续旧任务，避免分类扫描和发布限制互相阻塞。

`history.clear` 仅允许任务停止时执行。先通过 SQLite `VACUUM INTO` 备份完整已提交状态，复制并校验会话、待获取记录及草稿 JSON/Markdown，再事务删除会话元数据、逐文件删除已备份内容。所有删除路径必须是当前库内的真实普通文件；不跟随符号链接或旧库路径。未裁决冲突所属任务保留；library、history、raw 来源、source-cache 和已维护文档记录保持不变。此能力只供可信应用调用，未注册成模型工具。

新库初始使用三个大类：模型训练、Agent、Infra；用户可在独立「书架目录」页面自行创建一级、二级目录。模型训练覆盖以模型能力为主要贡献的模型架构、学习理论、NLP、VLM、强化学习、世界模型；Agent 覆盖规划、记忆、工具、多 Agent、具身行动和系统自我改进；Infra 覆盖训练与推理服务、分布式算力和数据工程。

每篇文档按主要贡献保留唯一目录，细主题、条件和跨领域联系放入简介及正文。RSI 不单列目录，含义未明确时不擅自展开。候选范围是实际目录的直属文档，不隐式递归查询子目录，也不自动跨类检索。

新库直接初始化这三个大类。旧版九分类仅在分类未经编辑、没有任何任务、文档、草稿和历史时自动迁移；事务内保存原分类快照至 SQLite 的 `migration / three-broad-categories-v1` 记录并替换分类。已有内容或自定义分类的知识库保持原状，不自动猜测迁移归属。

普通新任务持久化 `retrievalMode=collection`。分类说明和材料目录仍自动提供，`scan_category` 根据非空 identity 在该目录元数据中精确比较规范化标题、别名和论文标识，只返回命中候选。该 scope=identity 的 complete 不代表整类扫描；后端禁止 collection 调用全量扫描/continuation。候选阅读和更新仍要求在已提供范围并核对最新版本；新主题避免已有同名身份，论文相同也不能替代方法身份判断。已实际发现的矛盾仍即时报告。

维护任务为 `retrievalMode=maintenance`；未保存该字段的旧任务继续 legacy 完整扫描。`scan_category` 完整提供实际目录直属标题、简介、别名和论文标识，超过 24,000 字符预算时返回绑定任务、目录、轮次、目录版本与进度的 continuation，不截断单条简介或用 Top K。该范围全部提供后才允许读候选或写草稿，记录已读版本。目录变化使旧扫描失效。服务只能证明工具提供和阅读记录，不能证明模型理解。

“唯一目录”约束当前检索与草稿轮次，不把整个批量任务锁在第一类。当前模式扫描已完整提供且没有未发布草稿时，模型可说明原因后串行切换目录，新目录不能继承旧扫描认证。用户手动选择或明确输入真实文档 ID，可显式增加跨类材料。新的普通人类追问可开启新轮次；等待澄清、维护固定批次或未发布草稿保留原范围。

## 按钮触发的增量维护

`maintenance.get/start/pause/resume` 从目录页面调用。请求携带当前 dataDir；暂停/恢复额外匹配 runId，阻止切库后的旧回调操作另一个库。服务的单运行任务限制和全局冲突白名单继续生效。维护也使用原八个工具和同一 Pi 会话，不新增定时器或另一套模型循环。

SQLite 保存固定文档 ID 批次、逐文档检查版本/关联版本/差异结论与已维护认证。首次领取现有库，后续只领取无认证的新入库 ID；已有未完成批次先继续，不扩充批次分母。运行中新入库留到下一批，已完成维护后的旧文档编辑不重新领取。本批已完成项的正文或已关联候选变更时撤销旧认证，并检查最新版本。

同目录批次文档共享完整扫描，再逐篇真实读新文档及相关旧候选，比较关联、重复、补充和冲突。尊重用户目录，不自动重分类；未确认范围的手动目录允许维护既有文档，仍禁止自动新建。修改照常草稿、自检、发布；无修改可直接提交 maintenanceReports。报告绑定本批 ID、最新文档版本、完整当前目录扫描、实际读过的最新关联候选和非空具体结论；有未发布草稿或冲突不得认证。

进度为已认证文档数/固定总数，关联按文档对去重。所有待办清零且没有未发布草稿、输入受阻或冲突后，才完成本批并记录 lastCompletedAt。暂停、失败或人类裁决等待保留状态；恢复沿用原批次。纯口头收尾无法将维护标记完成；有界续跑仍在原 Pi 会话内，连续无进展则停止并保留待办。

## 批量输入与任务完成

`TaskInput` 是用户直接输入的处理记录，与 `RawMaterial` 的获取记录分开。每个直接链接或附件形成一项；只有单独提交且不带链接或附件的纯文字作为一项，附带链接或上传文件的文字作为上下文，不重复计数。Agent 研究中补充取得的网页、论文及核实证据不新增直接输入项。材料 `refresh` 通过 `retryOf` 归入原输入的 `sourceIds`，不因为重试增加任务分母。

一次分享文本自动抓取前 12 个唯一链接；其余链接仍登记为未获取输入，保留在任务清单中，不能因为获取额度限制被静默丢弃。

每项保存 `pending`、`published`、`answered`、`skipped`、`blocked` 状态、说明、关联材料 ID、文档 ID 与更新时间。任务详情通过 `inputs` 返回这些记录；材料区域显示直接输入的处理去向，并单独保留来源的 available/partial/unavailable 采集状态。成功下载不等于研究完成，补充来源数量也不代表已处理输入数量。没有旧版逐项记录时不生成虚假的 0/0 进度。

后台在完成任务时检查整批输入去向：只有已发布、已回答或有说明跳过的项才计入已处理；pending 或 blocked 不得因为模型给出一段终答、或成功发布其中一篇文档就被掩盖。未结项对应 `inputs_pending` / `inputs_blocked` 阶段，保留待办与原因，让原 Pi 会话继续处理或等待需要的信息。该状态和校验属于运行流程，模型仍使用现有八个工具，不新增通用任务规划工具或另写模型循环。程序能校验记录和关联，不能仅凭终态证明知识内容正确。

输入去向通过既有 `submit_draft` 的 `outcomes` 提交：可与草稿发布同时提交，也可以只提交 published / answered / skipped / blocked 记录与说明，不增加“完成任务”工具。程序通过公开的 `session.agent.subscribe` 观察不含工具调用的终止 `turn_end`；若仍有 pending 项，用 `session.followUp` 在同一 Pi 会话补充未完成清单。连续两次续跑提示没有进展，或同一次用户启动累计达到 12 次提示时停止，保留未完成状态。blocked 项不会触发自动重复调用，需要用户补充信息或显式继续。这是完成校验与有界续跑，不替代 Pi 的模型循环。

## 发布和异常恢复

知识正文直接解释主题、机制、用途和重要技术条件；标题、简介不附加来源状态或免责声明。来源在既有来源区或文末集中简述，采样时间、获取诊断及七项自检留在来源元数据、获取详情和结构化 review。对影响实际使用的存疑专名、接口、额度、论文标识优先核对主来源；省略非核心不确定细节，必要的具体限定就近说明，不用重复免责声明代替核对。全部输入有实际去向且无待办时简短收尾，不继续询问是否扫描无关空分类。

SQLite 启用 WAL 和 `synchronous=FULL`。Markdown 位于 `library/<stable-id>.md`；元数据和不可变版本快照存在 SQLite，历史同时导出至 history。写文件使用唯一临时文件、fsync、rename。

主模型用 `submit_draft` 一次提交草稿 ID、revision 和七项结构化 review。后台检查 review 对应当前草稿修订、七项自检是否通过、全局冲突状态、对应任务模式的扫描和预期版本；通过后自动发布，不再要求模型另调自检和发布工具。自检失败会保留结果但不发布；修改正文后须为新修订重新提交 review，旧自检不能授权新正文。同一草稿修订的相同提交幂等，已经成功发布的重复提交返回原版本，不重复生成历史。

发布先写持久化 publication journal，再写 Markdown 和历史文件，最后更新数据库文档版本及草稿发布状态。启动或重试会重放未完成记录。新建文档继续检查父节点内标题/别名/论文标识和任务草稿身份；版本、冲突锁和发布日志等存储约束不因工具合并而放宽。

手动保存也检查 expectedVersion。直接在外部编辑 Markdown 后，下一次读取会将其保留为新版本；研究期间的旧版本因此不能覆盖该修改。检测到外部文件缺失时可从版本历史回滚。外部修改与知识事实冲突是不同状态。

## 冲突状态机

`suspected` → 核实 → `dismissed`（证实无矛盾，说明原因）或 `confirmed`（等待用户）→ `resolved`（可信裁决）。

疑似与确认冲突都会全局限制业务。服务白名单仅允许界面阅读、当前冲突相关文档/原始材料、来源核实与解释。手动写入、分类编辑、草稿发布、上下文改变、普通新导入与新任务均拒绝。新发现冲突会使未发布草稿的旧自检失效。来源暂不可用不会清除确认状态。

只有服务的 `conflict.resolve` 接收 A/B/C；该操作不在 Pi 工具列表。A/B 卡片携带旧、新说法。C 必须提交两组明确条件。可信用户消息只有完整匹配“采纳/采用/选择 A/B”且当前有唯一确认冲突才视为明确裁决，“为什么选择 B”是追问。C 使用卡片中的条件表单明确提交。Other 永远为追问。存在其他未决冲突时继续锁定；全部解决后自动打开原 Pi 会话继续。

## 配置和来源

公众号与小红书文章的浏览器后备复用来源服务的私有 `browser-media` IPC，不新增 Agent 工具或模型循环。主进程按经过校验的文章 URL 路由到 `acquireBrowserPage`，返回受限的 `kind: 'article'` 结果；Cookies、登录输入、任意页面状态不传给本地服务或模型。服务继续验证目标文章身份、当前来源目录中的图片文件、大小与图片格式，再调用视觉辅助。小红书初始状态按目标笔记 ID 选择，登录页、验证页和其他笔记不能成为目标正文。

文章浏览器先隐藏加载，需要用户操作时显示真实窗口，取得目标内容后自动继续；关闭窗口、任务暂停、服务退出或主窗口关闭会取消获取并清理窗口与网络连接。公众号与小红书各有独立持久分区和按平台排队的获取任务，复用本应用的登录会话。入口和导航限制为相应平台及登录验证域名，使用 public DNS 校验与固定地址代理，禁止页面调用应用 IPC、本地文件、Node 或外部协议。客户端文章请求上限 15 分钟（含排队），其中人工操作等待有独立上限；现有抖音流程保持临时会话及原媒体时限。

配置位于开发 `.local/config/settings.json` 或打包后的 Electron userData `settings.json`。设置按研究主模型、视觉辅助、语音转写、联网搜索、知识库与工具分组；官方提供方和模型使用下拉选择，自动应用对应基址。初始未保存选择时，有 DeepSeek 密钥则默认 DeepSeek V4.1 Flash，否则默认百炼 Qwen3.8 Flash；增加 Pro 选项不改变该逻辑。上传图片、图文作品与视频抽帧共用有效视觉配置：可跟随支持图片的主模型，也可在高级设置独立配置；`mediaVision` 随有效 `vision` 配置解析，不再固定阿里云提供方。使用纯文本 Pro 时应独立选择 Flash 视觉辅助，已有选择不会因启动而改回初始默认。ASR 默认 `qwen3-asr-flash` 并复用阿里云密钥。网页搜索继续固定使用 DeepSeek 官方 `deepseek-flash`，复用其已保存密钥，不随研究主模型切为 Pro，也不要求独立搜索凭据。

服务自动读取项目 `.env`，也能通过原生文件选择器导入并关联其他 `.env`，随后主动重读。接受 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`，兼容 `deepseek_api`、`aliyunbailian-api-key`；官方服务商密钥集中存储，避免多个能力重复填写。UI 手动保存的密钥在启动时优先于 `.env`；主动重新读取会采用该文件的对应密钥并更新来源。空密钥输入表示保留原值，已保存的模型选择不由普通启动随意覆盖。

服务只向 UI 返回地址、模型、能力配置状态、密钥是否存在与来源、关联文件路径，不回传已保存密钥。真实 `.env` 和本机 settings.json 不进入安装包。网络错误输出对已知密钥和 Bearer 内容脱敏。密钥仅存在于本机配置与服务运行时，配置状态不表示连通性已被验证。

`Settings.paperParsing` 独立保存 arXiv HTML 地址与超时，以及 MinerU API 地址、模型版本、Token、总超时与轮询间隔。旧配置缺少该字段时补默认值；启动按默认值、已保存配置、当前关联 `.env` / 进程环境的非空字段合并，显式重读 `.env` 同样采用其中论文配置。仅包含论文配置的文件也可导入并关联。默认 arXiv HTML 根为 `https://arxiv.org/html`、60 秒；MinerU 为 `https://mineru.net/api/v4`、`vlm`、600 秒、4 秒。

保存时校验 HTTP(S) 地址不得携带账号、密钥、查询参数或片段；arXiv 超时限定 1–300 秒、MinerU 总超时 1–3600 秒、轮询 1–60 秒且不得超过总超时，均为整数。`PublicSettings.paperParsing.mineru` 仅返回 `hasToken` / `configured` 和非敏感配置，不返回 `apiToken`；缺失或空 Token 的回写保留原值。配置及来源错误脱敏包含 MinerU Token，Token 不成为模型上下文。

媒体工具由 `scripts/setup-media.ps1` 准备，`pack:win` 构建前自动执行下载与发布方 SHA-256 校验。安装资源包含 yt-dlp 2026.08.19、FFmpeg/FFprobe 8.1 LGPL 构建、清单及许可说明。主进程将 `SHELF_TOOLS_DIR` 指向开发项目 `tools/` 或打包后 `resources/tools/`；服务优先有效用户路径，再查内置目录、PATH，FFprobe 从 FFmpeg 同目录查找。工具运行时不自动升级。

媒体处理属于来源导入流程，没有新增 Pi 工具或第二套 Agent 循环。流程为平台获取/本地原件 → 真实字幕与时长 → 必要的 ASR → 图文/画面识别 → 保存原件与阶段范围。字幕解析范围能覆盖已知时长时不重复 ASR；画面独立处理。FFprobe 提供时长，FFmpeg 处理最多前 20 分钟、每 60 秒一个单声道 16 kHz WAV，转写按实际音频片段窗口标注，不能当作词级时间戳。视频在处理窗口内均匀抽样最多 24 帧，时间标签是目标抽帧时间；转写和视觉失败各自保留，不把已知部分扩写成完整观看。

抖音视频在公开读取与 yt-dlp 未取得媒体后，固定流程可请求浏览器实际加载规范化的 `/video/<作品 ID>` 页面；先核对目标作品 ID，再获取其可访问媒体，不能把推荐作品的媒体当作输入内容。浏览器后备沿用同一 `read(url)` 和来源记录，不新增 Pi 工具。获取到音轨但没有视频流时仅进行语音处理，范围明确“未读取画面”。用户暂停会取消请求并释放临时页面/会话；后备失败保留此前阶段错误，不将页面加载成功等同于媒体获取或识别成功。

浏览器初始化先发出调试协议 `Network.enable`，立即调用 `loadURL` 开始首次导航，再等待网络监听启用完成；不能在首次导航前先等待该命令，否则命令可能因等待导航而阻塞后续页面加载。此顺序依据 [Electron `debugger.sendCommand` 文档](https://www.electronjs.org/docs/latest/api/debugger#debuggersendcommandmethod-commandparams-sessionid)。初始化步骤限时 15 秒，网络监听启用限时 20 秒；进度分别报告页面开始加载、主页面 HTTP 状态、完成加载及候选媒体下载。整体超时错误携带当前 phase，便于区分初始化、页面加载与媒体获取停滞；这些进度不等于已经读到视频内容。

抖音 `/note/` 与图文类型分支先按作品 ID 解析静态 JSON 或公开详情接口；未取得可用图片时进入隔离浏览器后备，从匹配作品的动态状态获取图集，最多下载前 24 张。浏览器结果区分视频与 `kind: 'note'`；图文返回原图总数、作者文字和带原始序号的逐图文件或错误，允许部分成功，本地服务再逐图调用视觉辅助，不把图集配乐当成正文。B 站仍沿用公开信息、字幕与 yt-dlp 路径。没有有效文字/媒体时保存 `unavailable`，而非域名标题组成的“部分成功”。`metadata.stages` 记录各阶段状态和说明，材料卡片与原始材料详情可查看。原始音视频、字幕、各段音频/转写、各帧和图集图片/识别及覆盖记录均保留，搜索论文补充独立成为其他来源。

`mediaCookiesPath` 仅允许手动提供本机文件绝对路径，支持清除；媒体层只读取不超过 2 MB 的 Netscape 文件，并按平台域名过滤到 yt-dlp 的临时 Cookie 文件或抖音浏览器后备的临时会话，结束后清理，不修改原文件。应用不会自动读取外部浏览器登录状态，Cookie 内容不进入模型、研究对话或原始错误日志。用户提供的 Cookie 不等于平台访问成功，也不触发验证码破解。HTTP 403 记录为 `access_denied`，reason 为 `http_access_denied`；明确登录提示仍归 `access_denied`，reason 为 `login_requested`；只有明确要求 fresh/valid Cookies 才归 `cookies_required`，reason 为 `fresh_cookies_requested`。各类失败可通过本地媒体/字幕导入继续。

来源模块可独立增加适配器，详见 [SOURCES.md](SOURCES.md)。网络请求带超时、重定向/响应大小限制及私网地址阻止。原始资料作为数据封装，不赋予指令或人类裁决权限。

### 论文全文解析

`search(scope=papers)` 仍用于发现候选；阅读由 `read(url)` / 材料导入内部处理，没有新增 Pi 工具。识别官方 arXiv `/abs/`、`/pdf/`、`/html/` 链接和显式配置 HTML 根下的编号，保留 `vN` 版本及老式编号。读取顺序为配置的 HTML 根 → 同编号版本的官方 PDF → 专用摘要页提取。普通会议 PDF 不根据文件名或相似标题猜测 arXiv 映射，跳转或页面声明不同版本时拒绝替代指定材料。

HTML 分支解析实际论文主体，保留标题层级、MathML/TeX 公式、表格行列与跨格、图注和参考文献；不执行脚本、不额外视觉识别图片。每次 HTTP 原始响应、最终 URL、状态和失败阶段都保留。只有摘要可读时固定标记 partial / fullText=false，不能将其当成读过方法、实验和附录。

PDF 内部调用已配置的 MinerU v4：申请批量上传 URL → 上传原 PDF → 轮询任务 → 下载结果归档 → 保留 Markdown、图片和结构 JSON。Token 只发送到配置的 MinerU API origin，上传及归档下载不携带 Token。未配置、超时或解析失败时记录真实原因，不另起研究 Agent 或让模型自行轮询解析任务。

### DeepSeek 官方网页搜索

`search(scope=web)` 发出一次 `POST https://api.deepseek.com/anthropic/v1/messages`，使用模型 `deepseek-flash` 与服务端工具 `web_search_20250305`，复用 DeepSeek 官方 API Key。该辅助请求每次消耗一个额外 Messages 模型轮次；Pi 仍持有主研究会话和八个业务工具，本地没有另建 Agent 循环。实现只参考 DSH 搜索包的协议，使用独立适配器，不引入其插件运行时。

来源仅取自 `web_search_tool_result` 中的 `web_search_result`；摘要只拼接 `text.citations` 中与来源 URL 匹配的 `cited_text`，没有引用时不编造片段。普通模型回答不作为证据，也不从回答文本中提取 URL 来补结果。缺少结构化结果、结构化服务错误、HTTP 或传输错误均明确报不可用，不切换第三方搜索或静默回退。`search(scope=papers)` 与 `read(url)` 不受此替换影响。

DeepSeek 官方 Anthropic 兼容说明列出 `server_tool_use`、`web_search_tool_result` 消息块支持；其 Responses 兼容接口则将内置 `web_search` 标记为忽略，因此此处使用 Messages 协议。协议文档和 DSH 本地参考不等于当前账号具有可用搜索能力；本次未发送真实搜索请求，端到端行为尚未验证。

## 知识库位置切换

数据位置不再作为“保存后重启”的普通配置项。受控的 `storage.switch` 操作支持 `move` 和 `open`：前者将完整当前知识库复制到空目标并保留旧库，后者打开已有知识库或在空目录创建新库。服务切换 SQLite、来源与 Agent 实例，主进程更新允许打开的当前数据根目录，界面刷新当前库；应用不需要重启。后续改动只写入新位置，配置文件仍留在既有配置目录。

运行中的研究任务、未决冲突等不允许被位置切换绕过。目录与目标内容检查、数据库关闭和复制由服务执行，不交给模型工具。旧版保存的未生效目标保留为待切换提示，界面分别显示当前实际库和目标，用户明确选择复制或打开后才激活，避免把重启当迁移。源目录保留也不替代独立备份；完整备份仍应在退出应用后复制 SQLite、Markdown、原始材料、草稿、历史和会话。

## 按提问保存过程、结果和费用

每条用户消息对应一个持久化 `ResearchTurn`，消息和后台事件携带 `turnId`。暂停后继续复用该回合，`elapsedMs` 累计实际运行区间，不计入等待；意外退出只保留最后已观察到的活动时间。结束时保存本轮输入去向和发布记录快照，后续提问不会重写以前的结果卡片。旧数据按用户消息及事件时间只读重建，旧用时标注约数。

UI 在每次提问后提供一条默认折叠的用时入口，合并该轮助手过程与后台事件；最终回复和简洁成果卡保留在外。发布显示绿底勾，受阻显示红底叉，待处理/跳过使用中性色。中间获取路径失败不等于最终研究失败，来源诊断仍通过原始材料详情查阅。待处理草稿和冲突裁决入口保留。

`api_usage` 保存供应商返回的 token、缓存量和 ASR 秒数，经 AsyncLocalStorage 归属正在运行的回合。主模型及 Pi 原生压缩、视觉、ASR、搜索、PDF 解析提交分别记录；PDF 轮询不重复当作一次解析。Pi 的 `input` 是未命中量，总输入需加缓存读取和写入；SDK 中原有零价配置不作为账单。2026-10-06 的 DeepSeek 官方高峰/低峰价格作为人民币估算区间，Qwen ASR 按响应秒数与区域价格计算。未知模型/服务费/缺少用量明确留为未计价，优惠与实际扣款以供应商账单为准。旧 Pi JSONL 只恢复实际文本用量，旧服务地址和辅助调用未保存时不伪造费用，也不改写历史文件。

## 保持上下文前缀稳定

固定系统规则不包含动态运行状态，每个任务按持久化 retrievalMode 增加对应收集/维护规则。每个 Pi 请求边界通过 SessionManager 追加隐藏状态消息，既有消息不替换。协议 2 对对象键、无序 ID 和材料等集合稳定排序；材料、分类、草稿、冲突、输入项和 maintenance.items 按 ID 追加增补/替换/删除，输入及维护计数单独更新。`snapshot` 提供完整基线，`delta` 依次应用 `unset`、`set`、`collections`；旧协议或压缩后追加一次完整基线，旧历史不改写。扫描列表保持轮次顺序，并明确 scope=identity/category，扫描和冲突限制继续由 Store 执行。

保存和发布只返回身份、版本、正文长度和必要确认，发布不再重复整份输入清单。材料正文仍按 18,000 字符连续读取，首段只附必要来源、覆盖信息和阶段摘要；图片清单、路径与详细诊断保留在原记录，通过既有 `read` 的 `detail=acquisition` 独立分页读取。摘要中的省略项有明确标记，完整获取记录与科研正文有独立 offset，未增加业务工具。

仍由 Pi 管理唯一 Agent 循环和压缩持久化。常规触发阈值为实际注册模型上下文窗口的约 80%，通过 `reserveTokens = contextWindow - floor(contextWindow * 0.8)` 传给 Pi。当前 1,048,576 窗口模型在超过 838,860 tokens 时触发，保留最近约 24k；切换其他窗口的模型时按比例计算。摘要仍跟随主模型 Pro，单次调用受 8192 输出预算约束。

通过公开 `session_before_compact` 扩展钩子调用 Pi 的 `compact()`，保留原切分边界、分段摘要合并、文件轨迹和保留区。仅替换摘要请求：从规范会话投影中取原系统、工具和截至目标段结尾的历史前缀，追加摘要指令，不再把同一段历史序列化为另一份长用户消息；近期保留区不发送，工具调用禁用。匹配不到唯一安全边界或发生上下文溢出时，在发出请求前选择原生摘要形式。请求失败则保留原会话、停止本轮，不在失败后切换路径重复请求。

摘要的每次实际请求独立记录用量，压缩结束不重复计入 Pi 汇总。成功压缩记录的 `details.usageRecords` 保存无正文、无密钥的最小用量记录；历史恢复按相同请求 ID 去重，已有账本优先。首次升级会追加新状态基线，已有历史冗余只在下一次压缩后缩减；不会就地重写历史。压缩改变有效上下文是正常现象，不承诺服务端每次都命中缓存或更晚压缩一定更省钱。

## 获取快照缓存与结构化文章

`SourceService.readUrl/readUpload` 先按当前来源与解析配置查询 `SourceCache`，调用方不必增加工具。缓存快照保留原始获取范围，SHA256 清单验证所有已保存产物；跨任务命中复制到新的来源目录，修改来源归属并重写 Markdown 中的本地图片路径，同任务恢复保留原输入链。`retryMaterial` 传递显式 refresh 旁路，新获取失败或取消不复用旧成功。索引属于知识库本地数据；旧版本记录与迁移后指向旧路径的快照视为 miss，不改写旧会话或已发布文档。

公众号通过 `src/shared/article-markdown.ts` 在 Node 和 Chromium 共用自包含渲染函数；浏览器序列化调用显式注入依赖。正文保留 Markdown 结构与图片序号，图片、识别文字及下载失败仍由原获取管线处理。小红书状态先安全截取配平 JSON，再执行原有字符串外 undefined 转换及笔记 ID 校验。详细时效和成功条件见 `docs/SOURCES.md`。

## 官方依据

- [Pi SDK 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，并以本工程 node_modules 中 1.0.2 的 `.d.ts` 为接口依据。
- [DeepSeek 官方人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[DeepSeek 前缀缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)、[Qwen ASR 用量与价格](https://help.aliyun.com/zh/model-studio/qwen3-asr-flash)。
- [DashScope OpenAI 兼容调用](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)。不同地域使用对应控制台给出的 base URL 与 API key。
- [DeepSeek 思考参数](https://api-docs.deepseek.com/guides/thinking_mode/)、[百炼 Chat API 参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。
- [DeepSeek Anthropic 兼容 Messages](https://api-docs.deepseek.com/guides/anthropic_api/)、[DeepSeek Responses 兼容范围](https://api-docs.deepseek.com/guides/responses_api/)。

本阶段未做自动测试、故障注入、并发/压力评测、模型效果评测或完整视觉验收。上述恢复与限制机制是实现说明，不等于已经通过这些测试。
