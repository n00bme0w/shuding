# 书钉（Shuding）

简体中文 | [English](README.md)

一个面向专业书阅读的本地 AI PDF 阅读器。

书钉把「选句、提问、总结、留档」做成一条完整的工作流：选中一段话，问 AI 深入讨论，最后把讨论结果总结成笔记，钉在原文的引用位置。

## 特性

- **高质量 PDF 阅读**
  - 基于 PDF.js 渲染，支持高 DPI 清晰度（自动按设备像素比提升内部渲染倍率）
  - 连续纵向滚动阅读，支持缩放（25% – 400%）
  - 窗口化渲染：只渲染视口附近的页面，长时间阅读内存占用保持稳定
- **精准文本选择与定位**
  - 拖选时实时显示选区高亮，跨行选区逐行合并，不产生重叠或断裂
  - 选区保存为「页码 + 页内归一化坐标」，缩放与滚动不会破坏定位
- **引用与笔记**
  - 选中文字后可从选区操作条「添加笔记」，保存后生成永久引用（黄色高亮）
  - 标注抽屉列出全书引用与笔记，点击可跳回原文对应页
  - 引用与笔记按 PDF 内容指纹（SHA-256）归属，重开同一本书不会丢
- **AI 阅读助手（Pi 核心）**
  - 以 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 作为 agent 运行时
  - 支持 OpenAI 兼容 API（OpenAI、DeepSeek、硅基流动等任意兼容服务）
  - 多轮对话、流式回答、中止当前回答
  - 点击「问 AI」即可提问，自动参考选中文字、所在句及邻近语境或当前页；换页、换选区与按住 Y 语音提问继续同一讨论
  - 选区一键解释、Enter 发送、Shift+Enter 换行；回答可直接存为原文处的笔记，「新话题」另开讨论并保留历史
  - AI 回复支持 Markdown 渲染，代码块、列表、引用在面板中清晰呈现
  - 历史按最后提问时间排序，查看旧对话不会改变顺序；空白新话题复用草稿，不占历史列表
  - 会话历史保存到本地 SQLite，不按数量自动删除；内存按需恢复和清理闲置会话，停止生成、出错或关窗时保留问题及已收到的回答
  - AI 可自动抓取原文作为上下文锚点，记录页码与来源，供后续追问继续使用；锚点随会话保存，可在对话面板查看并跳回原文
  - 上下文锚点与 PDF 高亮独立；只有你主动添加高亮、保存引用或保存笔记时，才创建永久标注
- **本地优先与隐私**
  - 所有数据（标注、笔记、最近文档、AI 设置）都存储在本地 SQLite
  - API Key 仅在 Electron 主进程中使用，使用系统安全存储加密，renderer 永远拿不到
  - AI agent 不注册任何 shell / 文件 / 联网工具；模型只能「提议总结」，确认写入由应用完成
- **Drawer 优先的阅读界面**
  - 默认只显示左侧库 + 宽阅读区，右侧抽屉按需打开
  - 面板是布局的一部分，打开后向左挤压 PDF 阅读区，不会覆盖顶部工具栏
  - 面板宽度可拖拽调整（300px – 560px），读长文本或长对话更从容
  - 标注 / 笔记 / AI 三种抽屉模式互斥，一次只专注一个任务
  - AI 抽屉可在「当前对话 / 会话列表」两个视图间切换
  - AI 配置放在独立设置弹窗，不占用阅读空间

## 界面导航

| 入口 | 作用 |
| --- | --- |
| 导入 PDF | 打开系统文件选择器（由主进程打开，便于记录最近文档） |
| 最近文档 | 最多 8 条，点击按内部 ID 重新打开 |
| 顶栏 标注 | 打开全书标注/笔记索引抽屉 |
| 顶栏 笔记 | 当前选区 / 引用的笔记抽屉 |
| 顶栏 问 AI | 继续本书最近的讨论，自动参考选区或当前页 |
| 顶栏 设置 | AI 配置（Base URL / 模型 / API Key） |
| 选区操作条 | 添加笔记 · Ask AI · 复制 |

快捷键：

- `Escape`：依次关闭设置弹窗、抽屉、选区操作条
- `Enter`：发送 AI 提问；`Shift+Enter`：换行
- 按住 `Y`：围绕选区或当前页语音提问，松开后自动发送

## 环境要求

- Node.js ≥ 22.19（Electron 38 内嵌 Node 22.22.0，满足要求）
- 依赖 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 的本地构建（见下方依赖说明）
- Linux 上保存 API Key 需要可用的 Secret Service：
  - GNOME Keyring、KWallet（开启 Secret Service 接口）或启用 Secret Service 的 KeePassXC
  - 应用会自动追加 `--password-store=gnome-libsecret`
  - 如果系统安全存储不可用，Base URL 与模型名仍会保存，API Key 不会被落盘

## 安装与开发

```bash
npm install        # 会执行 postinstall：按 Electron ABI 重建 better-sqlite3
npm run dev        # 启动 Electron + renderer dev server

# 可选：注册一次全局命令和桌面 Launcher（入口直接指向当前源码目录）
npm run install:launcher
# 之后可以在任意目录运行：
shuding
# 也可以从系统应用 Launcher 中启动 “Shuding (Dev)”
npm run typecheck  # TypeScript 检查
npm run build      # 生产构建
npm run rebuild:native  # 重新按 Electron ABI 编译原生模块
```

如果 `@earendil-works/*` 本地包未构建，请先在其源码目录构建：

```bash
cd ../pi/packages/ai && npm run build:offline
cd ../pi/packages/agent && npm run build
```

## AI 配置

1. 打开顶栏「设置」
2. 填写 OpenAI 兼容服务的：
   - Base URL（例如 `https://api.deepseek.com/v1`）
   - 模型 ID（例如 `deepseek-chat`）
   - API Key（仅保存到系统安全存储）
3. 点击「问 AI」直接提问；也可选中文字后点「解释一下」，或按住 Y 说出问题
4. 继续追问或选择另一段原文，应用自动带上本次阅读内容；想另开讨论时点击「新话题」
5. 回答有用时点击「存为笔记」，或编辑 AI 笔记建议后保存；应用自动定位并附在相关原文处

## 数据与存储

- 数据库位置：Electron `userData` 目录下的 `shuding.sqlite3`
- 存储内容：锚点（anchor）、笔记（note）、最近文档、AI 设置（含加密 API Key）
- AI 对话：会话历史持久化在 `conversations` 表，按书分组；历史无自动淘汰上限，内存缓存清理不会删除磁盘记录。新话题发送第一个问题后才加入历史
- 重启后按会话 ID 恢复消息与上下文；删除会话保留已保存的高亮和笔记，删除高亮也保留 AI 对话及其原文上下文。切换历史保留各自的输入草稿
- AI 上下文与高亮的工作链路见 [AI 对话与上下文锚点](docs/ai-context-flow.md)

## 技术栈

- Electron 38 + electron-vite + Vite
- React 19 + TypeScript（strict）
- PDF.js 4.x（渲染、文本层）
- better-sqlite3（本地存储）
- @earendil-works/pi-agent-core + @earendil-works/pi-ai（agent 运行时）

## 许可证

[Apache-2.0](LICENSE)。第三方版权声明见 [NOTICE](NOTICE)。

## 当前状态

- 0.1.0 原型阶段
- 已完成：PDF 渲染、连续滚动、缩放、选区/锚点/笔记、最近文档、Pi AI 多轮对话、按书管理的对话历史、会话历史持久化、Drawer UI、安全凭据存储
- 未完成：扫描版 PDF 的本地 OCR、公式 OCR、全书 `search_document` 检索、web 检索工具、打包分发
