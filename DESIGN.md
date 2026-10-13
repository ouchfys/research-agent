---
name: 研究书架
description: 内容阅读优先的中文桌面研究工作台
colors:
  primary: "#245bd6"
  primary-hover: "#194bbd"
  primary-soft: "#edf3ff"
  canvas: "#f5f6f8"
  surface: "#ffffff"
  surface-muted: "#f0f2f5"
  ink: "#1d2736"
  muted: "#5b6473"
  border: "#dfe3e9"
  border-strong: "#c4cbd6"
  success: "#276344"
  success-soft: "#edf7f0"
  warning: "#825b14"
  warning-soft: "#fff7e8"
  danger: "#ad3440"
  danger-soft: "#fff0f1"
typography:
  title:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "29px"
    fontWeight: 680
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.95
  interface:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  code:
    fontFamily: "Cascadia Code, Consolas, SFMono-Regular, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  sm: "6px"
  md: "10px"
  dialog: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
  conflict-card:
    backgroundColor: "#fffdfa"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "16px"
---

# Design System: 研究书架

## Overview

**Creative North Star: "安静的研究工作台"**

中性背景承托白色文档，研究活动和文档状态始终可见。界面使用 Windows 中文系统字体，重视长时间阅读、目录扫描与明确操作。蓝色只承担选择和主要动作，语义色与文字共同表达状态。

**Key Characteristics:**
- 文档、材料、草稿与已发布版本明确区分。
- 细分隔线与表面色建立层级，内容保持平直、稳定。
- 图标统一使用 Lucide，辅助文字而不取代标签。
- 空库展示真实入口，不填充虚构知识。

## Colors

主强调色为研究蓝；背景是偏冷的纸白与浅灰。深灰承载正文，辅助文字保持足够可读性。成功、疑问和错误分别使用绿色、赭色与红色，并提供文字说明。

**The State Rule.** 语义色必须伴随可读状态文字；冲突不能仅用颜色或禁用按钮表达。

## Typography

全局字号、中文字体与代码字体集中定义于 `src/renderer/styles.css`。工作台正文使用紧凑的界面字号，阅读正文使用更大的正文角色；代码与标识符使用等宽字体。

文档标题以字重和留白建立层级。Markdown 正文行高为 1.95，宽度上限为 72ch；段落间距与二级标题上方间距承担阅读节奏。对话保持 14px，历史差异与时间信息采用更紧凑的排版。长标题换行，正文表格和代码块独立横向滚动。

## Layout

顶部工具栏 54px，底部状态栏 26px。宽窗口为书架、文档、研究三栏；书架初始 276px，研究初始 386px，文档自适应剩余宽度。书架可调至 220–420px，研究可调至 320–640px。5px 分隔条支持拖动、键盘聚焦和方向键。

860–1180px 使用双栏；选择书架时展示目录与文档，其余状态展示文档与研究。860px 及以下通过顶部面板标签切换单栏。编辑和裁决保持正常纵向滚动，不固定为无法容纳内容的高度。560px 及以下设置导航变为横向。

目录分页 40 篇，分类树、目录、正文与会话各自滚动。文档正文限制行宽，研究输入区固定在所属面板底部。留白遵循 4px 基础节奏。

## Elevation & Depth

主要面板依靠表面色和细分隔线建立层级，无悬浮卡片式背景。原生 dialog 用于设置、分类编辑以及回滚或放弃修改的明确确认；阴影为 `0 16px 64px rgb(24 36 56 / 18%)`。返回最新消息的浮动按钮使用轻微阴影。

## Shapes

输入框和按钮使用 6px 圆角。用户消息使用 10px 圆角；冲突卡片与 dialog 使用 12px 圆角。上下文标签紧凑、可移除，不把长文档目录做成大卡片。

## Components

按钮按主要、次要、文字和图标四类复用。所有仅图标按钮具有名称和提示。禁用保留可见轮廓，操作失败在相关输入附近显示并保留内容。

输入拥有持久标签、2px 蓝色焦点轮廓和中文说明。密钥输入为密码字段，留空保留既有密钥；不缓存到前端本地存储。未保存 Markdown 与文字输入保存恢复副本。

分类导航的选中状态使用浅蓝表面，层级用缩进和展开按钮表达。研究上下文以浅蓝标签确认选择，可打开文档或移除。

冲突卡片留在原对话中，分别显示 A 旧说法、B 新说法、核实说明和来源。C 展开两组明确条件输入；Other 作为补充追问。顶部全局提示链接到冲突所在任务。

Markdown 链接由受控桌面接口打开；本地图片由服务验证后提供数据。真实任务事件、扫描数量和候选阅读记录展示实际工作，不使用模拟百分比。

模态窗口只有一次轻微位移与淡入；其他交互只过渡背景、边框与文字色。支持减少动态效果设置。选中文本、滚动条与输入光标沿用项目颜色。

## Do's and Don'ts

- 保持文档、研究与分类导航的明确位置。
- 用真实任务状态和明确获取范围解释工作进展。
- 保留失败时的输入、未保存编辑和持久化冲突。
- 用来源和版本支持可追溯的阅读。
- 不用假文档、假进度或示例结果填充空白。
- 不用渐变、装饰性光晕或图片打断研究工作。
- 不把开发实现说明写进主要使用流程。

以上记录描述初始工作台已实现的代码规则；初始搭建轮次未开展截图验收、完整 audit、polish 或视觉评测。

## 书架目录画布（2026-10-07 新增）

「书架目录」从现有顶栏进入，作为独立完整页面与阅读、研究工作区切换。此节记录 `src/renderer/shelf-directory.css` 的局部规则，不替换上述工作台、阅读、研究、状态或共享模态窗口的规则。画布沿用系统中文字体与 Lucide 图标，使用浅冷灰点阵、白色节点和细蓝灰连接线；文件叶节点比目录更轻、更紧凑。

### 局部颜色

| Token / 角色 | 实现值 |
|---|---|
| shelf-canvas · 画布 | `#f5f8fc` |
| shelf-surface · 工具栏、节点、菜单 | `#ffffff` |
| shelf-ink · 节点文字 | `#202b43` |
| shelf-blue · 图标、新建和拖放边框 | `#2364ee` |
| shelf-line · 连接线 | `#b7c5db` |
| shelf-node-border · 目录与根节点边框 | `#d4dff0` |
| shelf-file-border · 文件边框 | `#dee6f1` |
| shelf-toolbar-border · 工具栏分隔线 | `#dfe7f3` |
| shelf-grid-dot · 点阵 | `#d6e0ed` |
| shelf-search-surface · 搜索背景 | `#f6f8fb` |
| shelf-control-border · 搜索和视图开关边框 | `#dce4f1` |
| shelf-folder-icon · 目录图标底色 | `#f0f5ff` |
| shelf-drop-surface · 拖放目标与根图标底色 | `#edf4ff` |
| shelf-drop-icon · 拖放目标图标底色 | `#dce9ff` |
| shelf-meta · 直属文档数量和根节点摘要 | `#60718a` |
| shelf-control-text · 视图标签和画布提示 | `#596b87` |

视图开关选中、完成反馈及新增二级目录文字继续使用共享研究蓝 `#245bd6`，选中开关表面为共享 `#edf3ff`。拖放目标同时使用 2px 边框和完整目录路径反馈，不只靠颜色区分。

### 字体与形状

所有角色继承 `Segoe UI, Microsoft YaHei UI, Microsoft YaHei, system-ui, sans-serif`，常规行高继承 `1.5`。画布缩放改变地图节点的显示比例，以下是 100% 时的 CSS 尺寸。

| 角色 | 字号 / 字重 | 圆角 |
|---|---|---|
| 页面标题 | `22px / 650`，1000px 以下 `20px`；字距 `-0.025em` | — |
| 根节点名称 | `17px / 650` | 节点 `10px`、图标底 `8px` |
| 目录名称 | `14px / 600` | 节点 `9px`、图标底 `7px` |
| 文件名称 | 地图 `12px / 400`，列表 `13px / 400` | 节点 `7px` |
| 搜索与视图开关 | `13px`；选中开关 `600` | 控件 `8px`、开关按钮 `5px` |
| 数量、画布提示 | `11px / 400` | — |
| 移动反馈 | `12px / 400` | `24px` |
| 缩放与适应画布 | `12px`；比例读数 `600` | 控件 `9px`、内部按钮 `4px` |

工具栏最小高度 `78px`，内边距 `16px 28px`，间距 `24px`；搜索与新建按钮高 `40px`。点阵间隔 `24px`、圆点半径 `0.8px`，连接线宽 `1.3px`。底部提示和缩放操作栏参与正常布局，独占最小 `64px` 高度与 `10px 24px` 内边距；画布滚动区域自适应其余高度，反馈浮层不遮挡操作栏。列表限宽 `1080px`，目录行高 `56px`、文件行高 `44px`；文件间距 `8px`，子内容缩进 `26px`。菜单圆角 `8px`，阴影 `0 8px 28px rgb(38 58 92 / 16%)`；反馈阴影 `0 5px 24px rgb(38 66 116 / 12%)`。

1000px 以下收紧工具栏并将反馈抬至距底部 `78px`；620px 以下工具栏换行、列表缩进改为 `16px`，底部操作栏内边距为 `10px 12px`，反馈距底部 `68px`。地图缩放范围为 `35%–150%`；空白区域拖动平移，列表和移动对话框提供键盘操作路径。新增目录的范围字段放在可展开区域，默认不允许自动归类；保存中禁止关闭。共享模态窗口继续使用原有 `12px` 圆角和焦点规则。

目录节点过渡为 `170ms` 背景与边框；文件节点为 `140ms` 边框与透明度；移动反馈使用 `180ms` 淡入和 `220ms` 位移，沿用共享缓动 `cubic-bezier(.16, 1, .3, 1)`。减少动态效果时关闭反馈动画。

## 资料入库（2026-10-09）

依用户选定截图新增独立页面，沿用原顶部导航与系统中文字体。只对 `src/renderer/ingestion.css` 生效：桌面左栏 278px，1400px 起为 294px；主区 34–35px 横向留白，标题 34px / 680、说明 18px、批次标题 16px、卡片标题 18px / 600、卡片元信息 14px、操作 15–16px，过程 14px、次要计数 12px。卡片圆角 7px，输入和历史项 8px，主按钮至少 48px 高；输入初始高度 124px。

成功表面 `#edf8f2`、图标 `#276c4b`、说明 `#496352`；失败表面 `#fff1f3`、图标 `#b93646`、说明 `#8b4850`；等待表面 `#f3f5f9`、图标 `#61728a`；空态图标 `#687b99`。其他颜色沿用共享变量，不添加插画、光晕或额外视觉主题。

结果保持输入顺序，相同发布文档只显示最高版本一张卡。过程和费用默认折叠，不将完整研究日志铺满主页面。760px 以下历史改为顶部横向区域，字号及按钮适度缩小，正文独立滚动；新批次、失败原因、重试、暂停/继续、回复和文档入口均有可见状态。

## 设置（2026-10-13）

设置沿用共享模态窗口、系统中文字体及蓝色主操作，规则局限于 `src/renderer/settings.css`。分为「API 密钥」「模型分工」「文件存放」「高级设置」，通过左侧导航定位；不把不同能力与存储选项塞在同一个长表单中。

桌面窗口宽度上限 900px，左侧导航宽 166px；内容区域内边距 29px 32px，标题 21px / 650，说明 13px，状态与辅助文字 12px。内容独立滚动，保存区固定在模态内部底部。700px 以下导航收至 145px、模型字段单列；560px 以下导航改为顶部横排，可横向滚动，底部操作允许换行。表单和控件沿用共享焦点、间距、圆角与语义色。

每个服务商只出现一组主密钥输入，状态区分来自 `.env`、本机保存、尚未填写和新密钥待保存。显示按钮只对新输入生效；已有密钥保持空输入和已配置说明，绝不通过占位符或前端缓存暴露。PDF 解析凭据折叠呈现，地址、协议与媒体工具逐层展开。模型分工用研究、图片、语音三个直接用途说明，不展示独立的重复媒体视觉配置。

文件存放明确分开「正在使用」和「目标文件夹」。目标预检结果随地址更新，等待时显示检查状态，无效位置显示原因；复制与打开使用互斥选项，并说明复制保留原目录、空目录打开会创建空库。最终按钮使用「复制资料并切换」「打开这个知识库」「创建空库并切换」等具体动作，不用笼统“确认”掩盖操作。未保存设置时提示先保存或还原；执行中禁止重复提交和关闭。

保存成功不自动收起全部设置，保留当前分组并显示反馈。关闭有未保存内容时，在底部提供继续编辑、放弃修改、保存并关闭；“已配置”只描述已保存状态，不暗示真实模型连通或余额已验证。

导航底部的本机配置说明使用 11px，状态与辅助文字使用 12px，设置页标题使用 21px；选中存储方式的补充说明使用 `#31518a` 保证在浅蓝表面上可读。
