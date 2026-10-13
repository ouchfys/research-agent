# 项目结构

源码、构建产物和个人知识库分开保存。更新程序不需要覆盖知识库。

## 源码目录

```text
research-agent/
├─ src/
│  ├─ renderer/     React 界面、Markdown 阅读与编辑、入库、目录、设置
│  ├─ electron/     窗口、preload、浏览器获取、进程与 IPC
│  ├─ server/       Pi 会话、来源解析、任务、存储、上下文和计费
│  └─ shared/       跨进程类型、协议与共享纯函数
├─ tests/           隔离回归检查与界面测试 fixture
├─ scripts/         开发、启动、构建、媒体工具准备和清理
├─ docs/            架构与来源能力说明
├─ .env.example     配置模板，不含真实凭据
├─ package.json     依赖、脚本和 Electron 打包配置
├─ package-lock.json
└─ README.md
```

主要实现入口：

| 文件或目录 | 职责 |
|---|---|
| `src/renderer/App.tsx` | 工作台页面与交互状态 |
| `src/renderer/IngestionPanel.tsx` | 独立资料入库界面 |
| `src/electron/main.ts`、`preload.ts` | 桌面启动、文件授权、IPC 与本地服务生命周期 |
| `src/electron/browser-*.ts` | 来源页面、图文和媒体的浏览器获取 |
| `src/server/service.ts` | 应用 RPC、任务与存储操作入口 |
| `src/server/agent.ts` | Pi 会话和业务工具注册、执行与恢复 |
| `src/server/agent-context.ts`、`agent-compaction.ts` | 增量上下文和摘要扩展 |
| `src/server/sources.ts`、`source-*.ts` | 来源获取、解析、缓存、识别与范围记录 |
| `src/server/store.ts` | SQLite、Markdown、版本、草稿、冲突和维护事务 |
| `src/server/config.ts`、`storage-location.ts` | 本机配置与知识库位置切换 |
| `src/server/research-shell.ts` | 临时命令工作目录、环境过滤与清理 |
| `src/shared/usage.ts`、`src/server/usage.ts` | 用量汇总与费用估算 |

## 本地生成的目录

以下内容不作为源码提交：

| 路径 | 内容 |
|---|---|
| `node_modules/` | `npm ci` 安装的依赖 |
| `tools/` | 媒体脚本下载并校验的二进制与许可文件 |
| `dist/renderer/` | Vite 构建的页面 |
| `dist/electron/` | 主进程、preload 和独立服务构建结果 |
| `release/` | 免安装应用与安装包 |
| `.cache/` | 测试、下载和其他临时产物 |
| `.local/` | 源码运行时的默认配置与知识库 |
| `.env` | 本机服务凭据与配置 |

`package.json` 的桌面入口为 `dist/electron/main.cjs`。主进程加载构建后的页面、preload 和独立 `service.mjs`。开发时页面由 Vite 提供，业务仍通过 Electron IPC 访问本地服务。

## 知识库结构

```text
data/
├─ app.sqlite        文档、任务、输入状态、版本索引和用量等元数据
├─ library/          已发布 Markdown
├─ history/          不可变版本正文和元数据
├─ raw/              来源原件、转写、图片识别和获取记录
├─ drafts/           草稿与发布记录
├─ sessions/         Pi 会话及运行配置
├─ source-cache/     可复用获取结果索引
├─ research-scratch/ 本轮临时仓库等，运行收尾时回收
└─ backups/          部分历史清理操作的恢复备份
```

这些目录共同构成知识库，原始材料和版本不是构建缓存。源码版默认库为 `.local/data`，配置为 `.local/config/settings.json`；打包版默认在 Electron 用户数据目录内创建。设置中的「文件存放」显示当前实际地址，支持复制完整知识库或打开另一个库。

备份前退出应用，复制整个知识库及所需配置。不要仅移动 Markdown；SQLite 索引、来源和会话之间存在关联。

## 开发与清理

README 列出的回归检查通过 `tests/workspace.mjs` 定位项目，使用独立临时目录，避免读写用户知识库。具体命令见 [README](../README.md#验证)。真实 Electron 启动测试需要先运行 `npm run build`。`prepare-directory-ui-qa.mjs` 与 `check-directory-source.mjs` 则是读取现有库并比较快照的手动诊断脚本，不属于默认回归检查。

`npm run clean` 预览固定范围内的构建和测试缓存，`npm run clean -- --apply` 执行清理。脚本保留 `.local`、`.env`、`tools`、`release` 和知识库，拒绝处理与当前知识库相交的路径。删除 `dist` 后需重新构建再启动。
