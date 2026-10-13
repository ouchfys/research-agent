# 来源适配器与能力范围

来源读取由本地 Node.js 服务协调；抖音视频与图文的浏览器后备通过内部 IPC 交给 Electron 主进程加载隔离页面。原始数据是待分析材料，其中的提示、命令或 A/B/C 文字不会成为系统指令或可信人类裁决。每个来源有独立 ID、获取时间、实际读取范围、状态、错误及原始文件，保存在数据目录的 `raw/<UUID>/` 中。`source.json` 是可恢复的来源记录，`content.md` 是提取文字。`metadata.stages` 保存各阶段名称、完成/部分/失败/未执行状态及原因，可在材料卡片和原始材料详情中查看。材料不是额外知识页面。

## 已实现的读取路径

除下面的 URL/文件解析路径外，Agent 也可使用用户授权的 Pi 原生命令行，在本轮临时目录浅克隆公开仓库并按需阅读相关文件。是否跟进文章中的仓库或论文由 Agent 根据研究目标决定，不自动递归所有链接。Windows 使用 PowerShell，Git 从系统 PATH 查找，不自动安装；仓库文件只作资料，不加载其 AGENTS.md/Skills 为指令或运行其脚本。

命令输出先限量、脱敏，再保存为补充材料（`kind=command`），可用材料 ID 引用；仅代表实际输出片段，不把 clone 成功当作已读完整仓库。正常结束、暂停、异常时清理临时工作目录，文档和已保存的文字来源保留。该命令权限沿用当前本机用户，临时目录不是 OS 沙箱；网络和文件能力并非由 URL 适配器的访问检查统一约束。具体权限约定及清理机制见 [架构说明](ARCHITECTURE.md#原生命令行与临时研究目录)。

| 输入 | 实际行为 | 范围与限制 |
| --- | --- | --- |
| 完整分享文字 | 保留完整文字，提取 URL，逐个处理短链接和最多 6 次跳转 | 自动处理前 12 个唯一链接；更多链接在范围中明确提示 |
| 普通网页、公众号 | 静态 HTML、Readability 正文；公众号优先 `#js_content` | 不运行页面 JavaScript；登录、验证、动态页面失败会保留真实原因 |
| 网页图片 | 记录正文中前 24 个图像 URL，尝试保存前 6 张，每张最多 5 MB | 保存不等于视觉读取；范围明确标识。未绕过防盗链或登录 |
| B 站 | 调用平台公开 `x/web-interface/view` 获取视频信息，`x/player/v2` 查公开字幕，下载真实字幕；使用 yt-dlp 补充可获取的媒体 | 元数据只作线索；按 URL 的 `p` 读取对应分 P。字幕可能要求登录或 API 签名，失败明确报告；不自动读取外部浏览器 Cookies，无浏览器后备 |
| 抖音视频 | 解析作品链接和公开信息，使用内置 yt-dlp 获取字幕与媒体；未取得媒体时，对确认作品 ID 的 `/video/` 页面尝试隔离浏览器加载，再处理实际取得的音视频 | 标题和作者描述不是视频转写；只有音轨时明确未看画面。无法获取时报告实际阶段，不规避验证码、地区、登录或 DRM |
| 抖音图文 | 按作品 ID 解析 `/note/` 与公开 JSON；未取得可用图片时加载隔离浏览器，从对应作品状态获取图片，再由服务逐图识别 | 最多尝试前 24 张、每张下载最高 10 MB；保留原图数量、原始序号、下载与识别结果，允许部分成功，不把图集配乐代替图片正文 |
| 小红书 | 读取公开元数据；公开内嵌 JSON 存在时提取笔记标题与正文 | 笔记文字与视频转写分开标记；结构变化会退回明确的元数据范围 |
| 截图、图片 | 原图保留；与图文、视频抽帧共用视觉辅助，可跟随支持图片的主模型或在高级设置独立选择 | 纯文本 Pro 应搭配独立 Flash 视觉辅助；视觉未配置时为不可读状态，识别结果标注可能出错，不冒充确定原文 |
| arXiv 论文链接 | 识别 `/abs/`、`/pdf/`、`/html/` 及配置的 HTML 根，先取结构化 HTML，再尝试同版本 PDF，最后读取摘要 | 保留论文 ID、版本、原始响应、真实最终 URL 和各阶段原因；仅摘要固定标部分内容，不能当全文 |
| PDF | 使用 MinerU v4 解析，保留返回的 Markdown、图片与结构 JSON | 上传与普通 PDF 下载仍受 32 MB 限制；提交模型的正文最多 40 万字符，完整解析 Markdown 原件保留。缺少 Token 或服务失败明确不可读，不回退旧 PDF.js |
| TXT、MD 等文字 | UTF-8 读取，保留原文件 | 最多提取 40 万字符，超过时明确部分读取 |
| 音频、视频文件 | FFprobe 测量时长，FFmpeg 提取并分段，Qwen ASR 转写；共用视觉辅助模型识别有限抽帧 | 附件按钮导入本地音视频最高 512 MB；最多前 20 分钟，音频按 60 秒分段，画面在处理窗口内均匀抽样最多 24 帧 |
| 字幕文件 | 解析 SRT、VTT、ASS/SSA、TTML、B 站/YouTube 及常见 utterances/segments JSON | 最高 32 MB、提取最多 40 万字符，保留原字幕时间范围；读取字幕不代表听过原音频或看过画面 |
| 论文名称、DOI、arXiv ID | 并行查询 Crossref、OpenAlex、arXiv，每个服务最多 8 个候选 | 返回标题、作者、年份、摘要、来源及原文链接；缺失摘要明确标识。保留不同服务/版本候选，不按相似名称强行合并 |

论文工具返回的是候选元数据，搜索摘要不是论文全文。arXiv 候选同时提供 HTML 与 PDF 原文链接，Agent 通过现有 `read(url)` 读取；明显歧义需要在对话中澄清。供应商检索失败时保留缺失服务提示；所有服务失败会报错。不同候选的作者和原始链接用于辨认，不能把一个视频的讲述和后来读取的论文补充混成一个来源。

## arXiv HTML 与 MinerU 论文读取

官方 arXiv 链接或显式配置 HTML 根下的论文编号才参与 arXiv 路由，支持 `vN` 和老式编号。按原编号、版本先请求 `ARXIV_HTML_BASE_URL/<id>`，HTML 无正文或不可用时请求对应官方 PDF 并交 MinerU，仍不可读时才从摘要页提取标题、作者和摘要。普通会议 PDF 不猜测 arXiv 对应关系；跳转或页面声明不同论文版本时拒绝替换指定材料。

HTML 使用论文主体解析，保留 h1–h6 标题、MathML 的 alttext / TeX annotation、表格行列和跨格、图注及参考文献。不执行网页 JavaScript，不把图注等同于实际看过图片。文字最多 40 万字符，DOM 遍历最多 15 万节点与 120 层，达到限制标记 partial。每次原始 HTTP 响应保留为 `arxiv-html.html`、`arxiv-pdf.pdf` 或 `arxiv-abstract.html`；`paperFetches` 和阶段记录保存最终 URL、状态、文件及失败原因。仅摘要时 `metadata.fullText=false`，获取范围明确未读方法、实验和附录。

PDF 统一走 MinerU，不再使用 PDF.js 文本层降级。程序发送 MinerU v4 `POST /file-urls/batch` 申请上传地址，通过不带 Token 的 PUT 上传原 PDF，轮询 `extract-results/batch/<id>`，成功后下载结果 ZIP。保留 `full.md`、图片、layout / content-list 等服务实际返回文件，正文超过 40 万字符时提供有界内容并标部分读取，完整 Markdown 原件仍在来源目录。服务公开的 PDF 页数上限为 200 页，具体拒绝原因以服务返回为准；无法确认页数时不编造已处理页数。Token 缺失、权限、网络、超时或归档问题会明确记录，原 PDF 保留；不能解析的普通 PDF 为 unavailable，arXiv 则仍可退到明确标识的摘要。

结果归档限定 ZIP 100 MiB、声明及实际解压总量 256 MiB、单项 32 MiB、最多 2000 项，压缩膨胀比不超过 500。只支持 stored/deflate 并核对 CRC32，拒绝分卷、ZIP64、加密、符号链接、特殊文件、大小写冲突或路径穿越条目；保留原 ZIP 和支持的 Markdown、JSON、常见栅格图片。服务状态 done 只表示解析服务完成，不等于应用另外逐图视觉阅读过全部论文图片。

论文配置从关联 `.env` 自动读取，也支持设置中的“重新读取 .env”：`ARXIV_HTML_BASE_URL` 默认 `https://arxiv.org/html`，`ARXIV_HTML_TIMEOUT_SECONDS` 默认 60；`MINERU_API_BASE_URL` 默认 `https://mineru.net/api/v4`，`MINERU_MODEL_VERSION` 默认 `vlm`，`MINERU_TIMEOUT_SECONDS` 为整个 MinerU 调用的总预算、默认 600，`MINERU_POLL_INTERVAL_SECONDS` 默认 4，凭据为 `MINERU_API_TOKEN`。启动和显式重读采用非空论文配置，缺失字段保留保存值；公开设置不返回 Token，空 Token 回写保留已有值。未配置 MinerU 仍能使用公共论文搜索和可访问的 arXiv HTML。

MinerU Token 只发送到显式配置的 API origin，上传与结果 ZIP 下载不携带 Token；来源公网检查仍适用，错误和材料脱敏包含该 Token。结构化解析结果仍是待核验材料，不保证公式、表格或 OCR 完全正确，配置完整也不代表本轮已经实测真实账号解析成功。

## 内置媒体程序与处理流程

yt-dlp 是平台媒体解析工具；FFmpeg 负责本地音轨提取、分段与抽帧，FFprobe 读取真实媒体时长及流信息。它们不是 AI 模型，也不需要 API Key。Windows 安装包内置 yt-dlp 2026.08.19、FFmpeg/FFprobe 8.1 LGPL 构建及许可说明。`npm run setup:media` 从发布方下载并校验 SHA-256，`pack:win` 在构建前执行该准备步骤；运行时不自动升级。

发现顺序是有效的用户覆盖路径、`SHELF_TOOLS_DIR` 指定的内置目录、系统 PATH（Windows 另查 WinGet 链接目录）。开发目录为项目 `tools/`，打包目录为 `resources/tools/`。FFprobe 与选中的 FFmpeg 同目录；覆盖 FFmpeg 路径时需要同时保留匹配的 FFprobe。子进程采用参数数组和 `shell: false`，Windows 隐藏窗口，不传入模型密钥，不读取用户 yt-dlp 配置。

yt-dlp 只使用 B 站、抖音、小红书专用提取器，媒体下载上限 512 MB，临时下载目录上限 1 GB。下载通过提取器完成，平台可用格式与分段流支持取决于内置 yt-dlp；无法获取或合并时保留失败，不将任意提取失败解释为没有视频。FFmpeg 只读取已保存的本地文件，协议限制为 `file,pipe`。字幕通过本应用受限制的 HTTP 客户端下载。

真实字幕优先。程序根据字幕解析范围与已知视频时长判断是否可跳过重复 ASR；不能确认覆盖时继续尝试音频转写。已取得字幕仍会独立尝试画面读取。FFprobe 未能提供可靠时长时明确失败，不捏造媒体范围。音频最多处理前 20 分钟，按 60 秒截取 PCM 单声道 16 kHz WAV，再用片段实测时长标注每个转写窗口；这些是片段范围，**不是句级或词级时间戳**。

视频画面在同一处理窗口内均匀抽样最多 24 帧，每帧独立交给当前有效视觉辅助模型，与上传图片、抖音图文共用配置。帧标签是抽帧目标时间，不宣称精确帧 PTS。连续三段转写或三帧识别失败会停止对应分支并保留已有结果。原媒体、音频片段、逐段转写、抽样 JPG、逐帧识别及 `coverage.json` 均保留。只取得语音时不声称看到图表、公式或演示；有限帧不等于看完全部画面，当前不自动获取评论作为知识正文。

### 抖音作品浏览器后备

此后备属于既有 `read(url)` 固定来源流程，不向 Pi 新增浏览器或媒体工具。视频在公开读取与 yt-dlp 未取得媒体后、图文在公开状态未取得可用图片时，Electron 会在隔离、隐藏的临时会话中加载规范化的 `https://www.douyin.com/video/<作品 ID>` 或 `/note/<作品 ID>` 页面，核对作品 ID 后获取对应内容。短分享链接必须先解析出有效作品 ID；不会把推荐作品、头像或图集配乐当作目标正文，也不承诺未解析短链都能进入此路径。

远程页面没有应用 preload、Node 或模型密钥权限；临时会话不自动导入外部浏览器的登录状态。可以复用用户在高级媒体设置明确指定的 Netscape Cookies，但不破解验证码或其他访问控制。用户暂停会取消后备请求，并释放临时页面/会话。B 站与普通网页不使用这一浏览器后备。

初始化先发出 `Network.enable`，紧接着调用 `loadURL` 启动页面导航，再等待网络监听准备完成，避免调试命令等待首次导航、而导航又等待命令的相互阻塞。初始化步骤与网络监听启用分别设有 15 秒、20 秒超时。进度区分“页面开始加载”“主页面 HTTP 状态”“完成加载”和“候选媒体下载”；整体 `browser_timeout` 会包含具体停滞阶段。排查时应结合阶段和 HTTP 状态判断，不能仅凭等待时间推断平台要求登录，也不能把页面完成加载视为已经获取音视频。

隔离会话在首次导航前设置使用 ASCII `ResearchBookshelf` 标识的 User-Agent，媒体下载沿用同一会话的 User-Agent，避免默认中文产品名触发 HTTP 请求头的 ByteString 限制。每个候选下载分别记录固定阶段、耗时、HTTP 状态、已接收字节数、白名单内的错误名称/代码及 User-Agent 是否规范化；诊断经内部 IPC 返回并保存为来源的 `browserDiagnostics`。诊断不包含 Cookies、带签名的媒体 URL 或原始异常内容。

页面返回 HTTP 200、发现媒体 URL 或错误码变化都不代表下载成功，也不能单凭这些现象建议盲目重试。应先结合候选下载诊断判断失败步骤；旧日志没有异常详情时，不能断言此前候选下载失败全部由 User-Agent 导致。

浏览器阶段与此前的公开读取、yt-dlp 阶段分别记录状态和原因。能打开页面不代表已取得媒体，取得媒体也不代表转写或画面识别完成。若只得到音轨，仅对实际音频范围转写，明确没有读取画面；标题、作者描述不能填充成视频正文。仍无可用正文时保留不可获取状态，已取得真实字幕或部分内容时按实际范围标记，不抹去失败阶段。该路径的实现说明不代表已通过真实抖音链接验收。

### 抖音图文与网页壳

图文分支识别 `/note/` 及作品 JSON 的图集类型。静态阶段只解析 `RENDER_DATA`、`__NEXT_DATA__`、`application/json`、`window._ROUTER_DATA` / `__INITIAL_STATE__` JSON，未取得数据时尝试公开作品详情接口。仍没有可用图片时由浏览器实际加载页面，读取与目标作品 ID 匹配的动态状态。图集按原数组顺序处理前 24 张，返回原图总数和从 1 开始的原始序号，每张可分别带本地文件或错误；服务只识别已下载的图片，缺页不重新编号，也不补写未取得的画面。不生成签名绕过校验，平台结构或访问条件仍可能导致失败。

每张成功获取的原图与识别文字分开保留，下载失败和视觉识别失败分别记录，部分成功按实际页数和范围保存。识别结果注明是模型识别，作者公开文字单独标记。只有脚本壳或域名占位标题时，来源是 `unavailable`，正文为空；不会把域名当作有效正文或“部分读取成功”。补充搜索的论文仍是新来源，不能冒充作品内容。

### 用户提供的 Cookies

高级媒体设置可手动指定自行导出的 Netscape Cookies 文件，必须是本机文件绝对路径、内容不超过 2 MB。程序只筛选当前平台域名所需条目，供 yt-dlp 临时文件或抖音浏览器后备的临时会话使用；原文件不回写，使用结束清理临时数据。不自动读取外部浏览器 Cookie，不向模型、对话或错误日志输出 Cookie 内容。清空路径并保存即可停用。Cookies 不保证消除验证码、登录权限、区域或 DRM 限制；不能读取时可导入已经取得的本地媒体、图片或字幕。

HTTP 403 记录为 `access_denied`，reason 为 `http_access_denied`，不能据此直接要求用户登录。明确登录提示归 `access_denied`，reason 为 `login_requested`；只有平台或提取器明确要求 fresh/valid Cookies 才记录 `cookies_required`，reason 为 `fresh_cookies_requested`。下载失败、提取器失败和验证受阻仍保留各自原因，不统一改写成“缺少 Cookies”。

## 模型和搜索协议

文本主模型由 Pi SDK 驱动。来源模块中的视觉、ASR 与 DeepSeek 网页搜索是独立的能力调用；搜索每次需要额外一个 Messages 模型轮次，但没有建立第二套本地 Agent 循环。设置提供官方供应方与模型下拉；内置列表依据官方模型元数据和文档维护，未通过收费调用验证账号权限、模型连通或搜索可用性。

- **主模型与视觉**：DeepSeek 官方可选纯文本 `deepseek-v4-pro`（DeepSeek V4 Pro）及支持图片的 `deepseek-flash`（DeepSeek V4.1 Flash）；百炼 Flash 的模型 ID 为 `deepseek-v4.1-flash`。首次未保存选择且有 DeepSeek Key 时仍默认 Flash，否则默认百炼 Qwen3.8 Flash，新增 Pro 不改变该逻辑。上传图片、抖音图文与视频抽帧共用有效视觉辅助；`mediaVision` 跟随有效 `vision`，可复用支持图片的主模型，也可在高级设置独立配置，不再固定阿里云。Pro 主模型应独立搭配 Flash 视觉辅助。视觉请求发送 `POST /chat/completions`，用户内容使用 `image_url` 的 Base64 data URI。官方已知模型显式关闭本次提取请求的思考；自定义服务不注入官方专用字段。采用非流式响应，因此不支持仅流式的 QVQ 模型。
- **DashScope ASR**：默认使用 `qwen3-asr-flash`，共用阿里云服务商密钥；协议为 `dashscope`，支持 Qwen3-ASR-Flash 系列（排除 Filetrans / Realtime）。发送 `POST /chat/completions`，音频放在 `messages[].content[].input_audio.data`，值是完整的 `data:audio/wav;base64,...`。`asr_options.enable_itn=false`。本地提取每段最高 60 秒，单段 WAV 超过 4 MB 时不提交；协议层继续检查 Base64 编码后不超过 10,000,000 字节。总范围最多前 20 分钟，工具缺失或时长探测失败时明确记录未完成，不直接提交未知范围的原音频。地区与模型权限仍须匹配。
- **OpenAI ASR**：协议选择 `openai`，发送 multipart `POST /audio/transcriptions`，使用独立 ASR 模型与密钥。单段本地限制 10 MB。
- **联网搜索**：固定使用 DeepSeek 官方 `POST https://api.deepseek.com/anthropic/v1/messages`，模型 `deepseek-flash`，服务端工具 `web_search_20250305`，复用已有 DeepSeek 官方 Key。最多返回 8 条结构化来源，工具随后读取必要原文。每次搜索额外产生一个 Messages 模型轮次的延迟和 token 消耗。

搜索来源只取 `web_search_tool_result` 内的 `web_search_result`；片段只取 `text.citations` 中按来源 URL 对应的 `cited_text`。未引用的来源可没有片段，生成的回答正文不作为证据，也不从回答文本中抓取链接充当搜索结果。没有结构化结果时明确报不可用；搜索服务、权限、网络或响应错误均保留失败信息，不改用第三方服务或静默回退。

协议选择参考 DeepSeek 官方 Anthropic 兼容说明与本机 DSH 搜索包，项目使用独立适配器，不引入 DSH 运行时。Anthropic 兼容说明列出服务端搜索消息块支持；Responses 兼容接口的内置 `web_search` 被标记为忽略，不能用 Responses 请求替代此处的 Messages 搜索。文档对齐不代表真实账号已验证可用。论文检索和 `read(url)` 继续使用原有读取路径。

DashScope 常用兼容基址为 `https://dashscope.aliyuncs.com/compatible-mode/v1`。阿里云当前推荐工作空间专属域名，如 `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；旧域名仍受官方支持。区域、密钥和模型权限必须匹配。设置中允许填写实际可用地址。

服务商密钥可由设置填写，或导入/重新读取已关联的 `.env`。支持 `DEEPSEEK_API_KEY` / `deepseek_api` 与 `DASHSCOPE_API_KEY` / `aliyunbailian-api-key`。手动保存密钥优先于启动时自动读取，主动重读文件则切回文件中的对应密钥。密钥不打包、不随设置读取回传给界面。

## 获取边界和恢复

- 应用 HTTP 客户端只接受 HTTP(S)，拒绝 URL 内嵌账号密码；每次跳转校验公网 DNS，连接固定到已验证 IP，拒绝本机、私有地址、保留地址和非支持端口。yt-dlp 是独立下载程序，其入口限定为受支持平台的作品 URL，并限制提取器。抖音浏览器后备使用独立受控会话并限定作品入口；不把应用 HTTP 客户端的 DNS 固定机制等同于 yt-dlp 或 Chromium 的网络行为。
- 公网来源获取有时间、大小与跳转上限。手动配置的模型服务可为局域网服务；它们是显式信任配置，不从来源文本推导。DeepSeek 搜索固定请求官方地址。带密钥请求拒绝自动跳转。
- 模型服务的响应错误不输出响应体；所有保存的来源错误与文字还会过滤当前配置中的密钥。
- 单次最多 12 个上传文件。主进程文件对话框将本地文件绑定到不透明令牌，渲染进程不能自行指定可信本地路径；仅 `task.start` / `task.message` 由主进程解令牌，再由服务复制原件到来源目录。音视频最高 512 MB，文本、图片、PDF、字幕与拖拽/Base64 最高 32 MB。原文截断、分页限制、图片范围、音视频范围都明确记入 `coverage`。
- 每个材料完成后立即保存并通知任务层。纯输入文字继续使用任务内 SHA256 检查点；URL 与上传文件通过当前库的获取缓存检查，只有成功产物及文件校验通过才复用。失败材料保留历史，重新提交或恢复时可重新获取，并通过 `retryOf` 关联原输入，不重复计数。
- 配置视觉或 ASR 后，Agent 可用 `read` 的材料读取及 `refresh=true` 按已授权来源 ID 重新解析已保存图片、PDF、音视频等原件，也可重新获取 URL。服务重新读取持久化来源记录，并检查原件规范化路径位于该来源自己的目录内；不接受任意文件路径。重试生成带 `retryOf` 的新来源记录，保留旧记录和原来的失败范围。
- 不需要模型密钥也能导入文本、读取可访问网页/PDF、查询公共论文目录和保存原件。依赖视觉、ASR、DeepSeek 官方密钥的相应能力会明确标记不可用，不因其他模型已有密钥就假定网页搜索可用。

## 结构化正文与获取结果复用（2026-10-08）

公众号静态和 Chromium 路径共用结构化 Markdown 转换器，保留标题、列表、引用、HTTP(S) 链接、代码块、基本表格和正文配图序号；配图原件及识别文字继续单独保存，签名图片 URL 不重复拼进正文。浏览器脚本显式注入自包含转换器。复杂排版、跨行跨列表格仅保留可读信息，不还原网页视觉样式；字符、节点或深度限制会标明不完整。小红书静态路径按引号、转义和花括号配平截取 `__INITIAL_STATE__`，允许其后仍有 JavaScript，继续核对目标笔记 ID，且从不执行网页脚本。

获取缓存位于当前知识库的 `source-cache/`，不可与服务商的前缀缓存混淆。键包含来源身份、实现版本、视觉/ASR/论文解析配置、工具文件版本和所配置 Cookie 文件的摘要，不保存密钥或 Cookie 内容。上传文件按实际内容 SHA256 和文件名/类型识别；平台完整链接保留作品 ID、B站分 P、arXiv 版本；普通 URL 保留查询参数与片段，不猜测不同短链是否属于同一作品。

首次成功采集会在来源目录保存不可变快照和产物清单。复用前核对原件、字幕、转写、画面、图片识别与论文附件的文件类型、目录和 SHA256；任一缺失、变化或指向旧库则重新获取。跨任务命中生成新来源 ID，复制产物到自己的目录，并重写本地图片链接；同任务恢复保留输入 ID 与重试关系。缓存只优化获取，入库判断和文档版本规则不变。升级前无当前版本快照的旧来源不会自动回填或批量重新识别。

普通网页、公众号、小红书和无指定版本的论文快照保留 24 小时；抖音/B站完整作品身份保留 7 天；指定版本 arXiv 为 90 天；上传文件以内容与配置变化失效。命中不会延长原始有效期，来源覆盖说明保留采集时间并明确本次未重新访问。成功处理指定窗口的视频仍保持 `partial`，最多前 20 分钟和抽样画面的原有范围不会因复用升级成完整视频。缺失识别结果、失败、取消、仅摘要或未完整获取的文章不作为成功缓存。

显式 `refresh=true` 始终绕过缓存；该次失败不会退回同键旧成功结果。缓存读写损坏不阻碍正常获取；新尝试与索引发布按键排序，避免旧完成覆盖新状态。此轮未加入远端分段续跑、通用网页浏览器、抖音移动分享页入口，未引入 Skills 或第二套 Agent。

以上借鉴 [Chubby 的公众号结构提取](https://github.com/chubbyguan/chubbyskills/blob/1b759b181f746541ae0f07f43d8d18b99a622670/wechat-article-ingest/scripts/fetch_article.py)、[小红书状态配平](https://github.com/chubbyguan/chubbyskills/blob/1b759b181f746541ae0f07f43d8d18b99a622670/xiaohongshu-ingest/scripts/fetch_note.py)和[有效产物复用](https://github.com/chubbyguan/chubbyskills/blob/1b759b181f746541ae0f07f43d8d18b99a622670/tools/chubby.py)思路，以本项目 TypeScript 模块实现，保留现有浏览器验证、目标 ID 校验、Qwen ASR 和视觉流程。

## 官方参考（开发时核对）

- [DeepSeek 官方模型标识与能力](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek 视觉接口](https://api-docs.deepseek.com/guides/vision/)
- [阿里云视觉模型](https://help.aliyun.com/zh/model-studio/vision-model)
- [阿里云 OpenAI 兼容 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [Qwen ASR 兼容请求示例](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [阿里云语音识别音频规格](https://help.aliyun.com/zh/model-studio/asr-model)
- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
- [OpenAlex API](https://docs.openalex.org/)
- [arXiv API 手册](https://info.arxiv.org/help/api/user-manual.html)
- [yt-dlp 官方仓库与命令行说明](https://github.com/yt-dlp/yt-dlp)
- [MinerU 云服务 API](https://mineru.net/apiManage/docs)
- [MinerU 输出文件说明](https://opendatalab.github.io/MinerU/reference/output_files/)
- [DeepSeek Anthropic 兼容 Messages](https://api-docs.deepseek.com/guides/anthropic_api/)
- [DeepSeek Responses 兼容范围](https://api-docs.deepseek.com/guides/responses_api/)

B 站网页使用的接口不是稳定、承诺兼容的第三方开发者服务；字幕访问政策和响应结构可能变化。平台失败如实显示，不承诺绕过访问控制。当前阶段按项目要求仅做依赖/API 类型对齐与构建，不开展来源端到端测试或评测。
