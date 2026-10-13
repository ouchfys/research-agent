# Research Agent

面向个人研究资料的桌面 Agent，应用内名称为「研究书架」。将网页、论文、图文和音视频整理为本地 Markdown 文档，并持续维护已有知识。

基于 **TypeScript、React、Electron、Pi SDK 和 SQLite**。项目关注资料入库中的实际工程问题：来源获取失败、批次恢复、重复材料、文档版本竞争、人工裁决，以及长上下文的调用成本。

## 能做什么

- **批量入库**：粘贴多条链接或导入文件，每项独立记录结果；成功后打开文档，失败后查看原因并选择重试。
- **多种来源获取**：网页正文、arXiv HTML、MinerU PDF 解析、字幕、ASR 和图片识别；部分平台支持浏览器后备与用户登录验证。
- **资料复用**：复用本地已取得的可读材料，避免相同来源重复下载和识别；显式重新获取可绕过缓存。
- **知识维护**：按目录概览选择候选、阅读正文，将同主题的多篇资料整合为新文档；发布后归档旧节点，保留来源和版本。
- **可恢复的研究**：独立入库批次与持续研究对话分开；任务、输入去向、草稿、冲突和 Pi 会话持久化。
- **可观察的成本**：每轮折叠展示处理过程、用时、输入与输出 token、缓存命中和费用估算。

初始书架包含「模型训练」「Agent」「Infra」，支持用户维护两层目录。文档以真实 Markdown 文件保存，可阅读、编辑、查看差异和回滚。

## 本地运行

当前开发与打包流程主要面向 **Windows 10/11 x64**。准备 Node.js 22.19 或更高版本（建议 Node.js 24）、npm；需要 Agent 读取代码仓库时，将 Git 加入 PATH。

```powershell
git clone https://github.com/ouchfys/research-agent.git
cd research-agent
npm ci
npm run setup:media
npm run dev
```

`setup:media` 下载 yt-dlp、FFmpeg、FFprobe，校验上游发布的 SHA-256，并保留许可文件。`dev` 同时启动界面、Electron 和独立本地服务。

构建后启动：

```powershell
npm run build
npm start
```

Windows 打包：

```powershell
npm run pack:dir   # 生成 release/win-unpacked，运行其中的「研究书架.exe」
npm run pack:win   # 准备媒体工具并生成 NSIS 安装程序
```

首次 `pack:dir` 前需运行 `setup:media`。分发免安装版时应保留整个 `win-unpacked` 目录；打包应用不需要另装 Node.js。项目未配置代码签名，安装包和媒体二进制不存入 Git。

## 配置与使用

打开「设置」，按以下顺序配置：

| 设置 | 用途 |
|---|---|
| API 密钥 | DeepSeek、阿里云百炼各填写一次；PDF 解析可额外配置 MinerU Token |
| 模型分工 | 选择研究主模型、图片理解和语音转写；纯文本主模型需要单独搭配视觉模型 |
| 文件存放 | 选择知识库目录；支持将完整资料复制到空目录，或立即打开另一知识库 |
| 高级设置 | 导入 `.env`，按需配置媒体工具、Cookies 和论文解析连接 |

也可先复制配置模板，再填写所需服务的凭据：

```powershell
Copy-Item .env.example .env
```

主要变量为 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY` 和可选的 `MINERU_API_TOKEN`；完整说明见 [.env.example](.env.example)。密钥保存在本机配置，设置界面不回传已保存密钥。请勿提交真实 `.env`、配置文件或 Cookies。

文本、视觉与 ASR 分别按所选模型调用。内置网页搜索使用 DeepSeek 官方服务，复用 DeepSeek Key，并产生独立的模型调用；公共论文检索和直接读取网页可在没有该搜索 Key 时使用。模型菜单是内置预设，账户权限与实际可用性由服务商决定。

在「资料入库」粘贴链接或选择文件，点击「开始入库」。每批使用独立的 Pi 上下文，重试保留已完成成果，仅处理选定的待办。入库后可在书架阅读文档，也可进入研究对话追问，或通过「维护书架」整理重复主题。

没有 API 配置时仍可管理目录、手动编辑文档和查看历史；需要模型的任务会提示配置。

## 实现思路

| 层 | 实现与职责 |
|---|---|
| 界面 | React 工作台：入库批次、Markdown 阅读与编辑、研究对话、目录与设置 |
| 桌面宿主 | Electron 主进程与 preload：窗口、白名单 IPC、文件选择、浏览器获取 |
| 本地服务 | 独立 Node.js 进程：任务状态、来源解析、模型调用、存储和用量记录 |
| Agent | Pi SDK 提供工具调用循环、流式响应与持久化会话；业务工具连接知识库操作 |
| 数据 | SQLite 保存元数据与状态，Markdown 保存正文，原始材料与不可变历史分别归档 |

**Agent 决定研究内容，程序保证执行约束。**

Agent 根据材料选择目录和候选文档、检索补充来源、比较内容、形成草稿，并在缺少信息时询问用户。程序负责参数校验、实际下载与识别、输入状态、版本检查、发布、事务、用量记录和临时文件清理。写成一篇文档不会自动把整批输入标记为完成。

知识检索采用目录概览与正文按需读取，当前没有向量数据库。日常入库检查标题、别名和论文标识；集中维护逐项领取待整理文档，确认适合合并后发布新节点。草稿先保存，提交时检查修订号和源文档版本；真实内容冲突等待用户裁决。

上下文按 ID 追加状态变化，工具回执减少重复信息。长会话约在达到模型窗口的 80% 时触发 compaction，使用主模型并尽量保留可复用前缀；缓存命中由服务商决定，费用记录用于观察实际效果。

更多实现说明见 [架构与流程](docs/ARCHITECTURE.md)、[来源能力](docs/SOURCES.md) 和 [项目结构](docs/PROJECT-STRUCTURE.md)。

## 验证

代表性检查命令：

```powershell
npm run build
node tests/test-settings.mjs
node tests/test-ingestion-retry.mjs
node tests/test-maintenance-consolidation.mjs
node tests/test-maintenance-service.mjs
node tests/test-maintenance-context.mjs
node tests/test-collection-identity.mjs
node tests/test-desktop-startup.mjs
```

这些测试覆盖配置与存储切换、入库重试、合并发布和版本竞争、维护任务生命周期、增量上下文、精确候选查找，以及真实 Electron 启动和 IPC。测试使用独立数据目录；上述检查不需要付费模型调用，桌面启动测试依赖先完成构建。

当前尚无真实模型质量基准、来源平台全覆盖验证或大库性能评测；回归通过说明程序约束得到检查，不代表模型始终能正确理解或合并资料。

## 数据与运行边界

- 源码版默认配置在 `.local/config/settings.json`，知识库在 `.local/data/`；打包版默认使用 Electron 用户数据目录。设置中可查看和切换实际位置，无需重启。
- 知识库包含 SQLite、Markdown、原始材料、版本、草稿和会话。备份前退出应用并复制完整目录；迁移可使用设置中的复制功能，原目录会保留。
- 来源可能受登录、验证码、限流、删除或权限限制影响。浏览器后备无法保证成功；字幕、语音转写、有限抽帧和全文分别记录获取范围。详细限制见 [来源能力](docs/SOURCES.md)。
- 模型请求会将所需材料发送给已配置的服务商。费用按已记录用量与模型单价估算，未记录或无法计价的部分会单独标明，以服务商账单为准。
- Agent 的命令行在本地运行，可按需浅克隆公开仓库。应用过滤子进程环境并清理自己的临时研究目录；**命令仍使用当前操作系统用户权限，临时目录不是系统沙箱**。
- 当前同一时间运行一个研究任务，支持暂停和恢复。macOS、Linux 的桌面打包未纳入当前验证范围。

`npm run clean` 预览可清理的构建和缓存，`npm run clean -- --apply` 执行清理；该脚本保留知识库、`.local`、`.env`、媒体工具和发行目录。
