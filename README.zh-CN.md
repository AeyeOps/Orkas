# Orkas

**开源的 AI 智能体团队，就在你的桌面上——把目标变成交付成果，并持续推进。**

Orkas 是一个开源（MIT）、本地优先的多智能体桌面应用，也是一支协同工作的 AI 助手团队。你描述目标，**指挥官（Commander）**将它拆成待办、亲自完成通用部分，并协调 **16 个内置专业智能体**完成研究、写作、幻灯片、视频、语音、设计、代码、SEO 和电商工作；还可接入你已在使用的编程与个人智能体：**Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent**。项目汇集目标、记忆和文件，Auto-advance（自动推进）与定时自动化让工作持续推进，完成的成果交回给你审核。

**[⬇ 下载 Orkas：macOS 与 Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** —— 免费使用，内置 Orkas 模型赠送 500 积分，开始使用无需 API Key。也可以用自己的 Key：Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao，或接入本地 OpenAI 兼容模型端点。

[![下载 macOS 与 Windows 版](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![许可证：MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=social)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)

[English](./README.md) · [简体中文](./README.zh-CN.md)

---

**你：** *“研究排名前 5 的竞品，写成报告，再做成一份幻灯片。”*

**Orkas：** 指挥官把目标拆成待办，再协调专业智能体执行：**DeepResearcher** 收集并核实来源，**ContentWriter** 撰写报告，**PptMaker** 制作幻灯片。一个对话、一份共享计划，成品留在你的项目里。

![Orkas 演示：指挥官把目标拆成待办，调度专业智能体并交付成品](./resources/app-ui/demo.gif)

---

## 让工作持续推进

完成一项任务只是开始。Orkas 也为需要持续开展的工作而设计。

- **项目** —— 目标与规则、记忆、文件随项目共享，每个新对话都能接着做，不必从头交代背景。
- **待办与 Auto-advance** —— 项目中的待办可交给人或智能体；开启自动推进后，团队会自行接手下一项工作，并将完成的成果交回给你审核。
- **定时自动化** —— 按小时、每天、每周或每月执行任务。Orkas 在你的电脑上运行；从 1.9 起，电脑唤醒或应用启动后，每个自动化会补跑 12 小时内最近一次错过的任务。
- **连接器** —— 接入 Gmail、Google Calendar、Sheets、Drive、Notion、Slack、Shopify、Stripe 等服务。默认情况下，Orkas 会在发送、发帖或删除前询问你。
- **应用** —— 描述你需要的工具，Orkas 就能将它做成桌面应用内的本地应用；付费会员还可以将其发布为带公开链接的网页应用。
- **共享项目** —— 邀请同事或虚拟助理加入，将每条待办分配给人或智能体。

云同步、共享项目、语音输入和网页应用发布属于安装版功能，其余多数能力也可在源码版使用。

---

## 团队能交付什么

- **视频、配音与图片** —— VideoStudio、VoiceStudio、ImageStudio
- **研究报告、SEO 审计与市场分析** —— DeepResearcher、SeoGeoAgent、StockAnalyser
- **帖子、文章、简报与幻灯片** —— ContentWriter、PptMaker
- **网站、UI 与代码** —— UIDesigner、ProductDeveloper
- **Word、Excel、PowerPoint 与 PDF 文件** —— OfficeWorker
- **电商工作** —— 5 个电商智能体负责选品、商品文案、评价分析、经营分析与商品运营

16 个专业智能体随应用内置，各有自己的技能、记忆和工具。[智能体库](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)中有 30+ 个智能体可供选择；也可以描述所需角色，让指挥官为你创建自定义智能体。

<details>
<summary><b>全部 16 个内置智能体</b></summary>

| 领域 | 智能体 | 交付内容 |
| --- | --- | --- |
| 研究与分析 | **DeepResearcher** | 核实来源、标记矛盾，交付有依据、可追溯的研究报告 |
| | **SeoGeoAgent** | 从 URL 开始，审计技术 SEO、内容质量、Core Web Vitals 和 AI 回答引用能力（GEO），按优先级列出修复项 |
| | **StockAnalyser** | 股票研究、因子筛选、回测与组合风险检查，附可追溯的数据看板 |
| 内容与媒体 | **ContentWriter** | 将目标、来源或初稿写成可发布的帖子、文章、简报与案例 |
| | **PptMaker** | 从主题、大纲或文档制作可编辑、可审核的 PPTX 幻灯片 |
| | **ImageStudio** | 海报、封面、社媒图片与信息图 |
| | **VideoStudio** | 视频制作与编辑，包括旁白、AI 主播、字幕、配音、片段提取与本地化 |
| | **VoiceStudio** | 旁白、多角色音频、转写与字幕、音频编辑和混音 |
| | **UIDesigner** | 从产品目标、PRD、截图或 Figma 素材制作以 HTML 为主的可编辑 UI |
| 开发与办公 | **ProductDeveloper** | 理解代码仓库，落实 PRD、修复缺陷、重构和审查代码，交付可验证的结果 |
| | **OfficeWorker** | 创建、编辑、检查和交付 Word、Excel、PowerPoint 与 PDF，支持单份或批量处理 |
| 电商 | **ECommerceResearcher** | 按预算、市场和采购限制筛选产品，给出候选、淘汰理由和验证计划 |
| | **ECommerceWriter** | 按品牌语气撰写标题、详情页、FAQ、图片文案与视频脚本 |
| | **ECommerceReviewer** | 分析评价与口碑，归纳客户主题、差评根因和改进优先级 |
| | **ECommerceAnalyzer** | 从导出文件核对销售、利润、广告、退款与库存指标，给出经营建议 |
| | **ECommerceOperator** | 规划商品、价格、促销与库存调整，仅通过你已连接的工具执行 |

了解各智能体 → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

---

## 一起运行 Claude Code、Codex 和 OpenCode

Orkas 将你已安装的 CLI 智能体作为本地会话运行，与内置专业智能体一起工作：包括编程智能体 **Claude Code、Codex 和 OpenCode**，以及个人智能体 **OpenClaw 和 Hermes-Agent**。指挥官协调分工，并在它们之间保持同一份计划，让一个对话完成缺陷修复、变更审查和发布说明撰写。HyperFrames 等开源工具也可接入同一工作流。

[一起使用 Claude Code 和 Codex →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## 为什么选择 Orkas

- **会规划、分工，也会亲自完成工作的指挥官** —— 拆解目标，选择合适的智能体、技能、连接器与工具；没有更合适的专业智能体时，亲自处理分析、写作、研究和文件工作。
- **本地优先** —— 对话、文件、知识库和自定义智能体默认保存在本机，安装版可选择开启云同步。使用自己的 Key 时，模型调用从本机直连服务商；内置 Orkas 模型通过 Orkas 托管服务运行。
- **模型随时可切换** —— 指挥官与内置智能体共用一个模型设置，可选择内置 Orkas 模型、自有服务商或本地端点；外接 CLI 智能体保留各自的模型设置。
- **能积累经验的智能体** —— 各自保留私有技能与记忆，在被纠正、错误恢复或遇到已知弱项等信号触发时反思，改进后续工作。
- **开源、可审查** —— MIT 许可证，可以查看 Orkas、智能体与技能的具体实现。

> ⭐ 如果 Orkas 对你有用，点一颗 Star 能帮助更多人发现它。

---

## 下载

| | 安装版（推荐） | 源码版 |
| --- | --- | --- |
| 平台 | macOS 12+（Apple Silicon 与 Intel）、Windows 10+ | macOS、Windows、glibc 2.34+ Linux x64/arm64 |
| 账号 | 登录即送 500 积分 | 无需账号 |
| 模型 | 内置 Orkas 模型，或使用自己的 Key | 自己的 Key，或本地模型端点 |
| 另含 | 云同步、共享项目、语音输入、网页应用发布 | — |
| 获取方式 | **[下载 Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [快速开始](#快速开始) |

下载链接会识别你的系统，并开始下载对应安装包。

---

## 使用场景

- **营销内容** —— 用你的品牌语气制作发布视频、产品页面、帖子与简报。[内容写作](https://orkas.ai/use/content-writing/?source=gh-orkas) · [视频](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **店铺经营** —— 销售周报、评价回复、商品文案与竞品检查。[电商](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **研究与报告** —— 按需或定期交付带来源的报告与幻灯片。[研究](https://orkas.ai/use/researchers/?source=gh-orkas) · [数据分析](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **和文档对话** —— 基于你自己的文件回答问题，并标注来源段落，方便核对。[文档问答](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **客户项目** —— 按你的模板制作会议简报、客户月报与进度幻灯片。[客户月报模板](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **产品发布** —— 落地页、带测试的缺陷修复、更新日志与发布帖子。[面向开发者](https://orkas.ai/use/developers/?source=gh-orkas)
- **做应用** —— 报价计算器、预约表单、内部工具。[做应用](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **小团队协作** —— 人与智能体在同一个项目里协作。[小团队](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas 与同类工具对比

| 工具 | 它是什么 | Orkas 的不同之处 |
| --- | --- | --- |
| **Claude Cowork** | Anthropic 基于 Claude 构建的桌面智能体体验。 | Orkas 开源（MIT），可使用内置 Orkas 模型或自有服务商，并协调 Claude Code、Codex、OpenCode 与内置专业智能体。[Claude Cowork 替代方案 →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **LangChain** | 面向开发者的 LLM 应用与智能体框架，通过代码嵌入 Python/JS 应用。 | Orkas 是通过对话指挥的桌面应用，数据默认保存在本地。 |
| **CrewAI** | 通过 Python 代码定义团队与角色、编排自治智能体的框架。 | Orkas 将多智能体编排做成桌面应用，内置项目、待办、自动化与各智能体的经验积累。 |
| **OpenClaw** | 跨消息渠道与你联系的常驻个人助理。 | Orkas 协调一支团队，OpenClaw 也可作为其中一个 CLI 智能体接入。 |
| **Hermes-Agent** | Nous Research 的自我改进智能体，具备记忆与技能，提供 CLI、消息网关和桌面版。 | Orkas 由指挥官协调多个专业智能体与外部 CLI 智能体，Hermes-Agent 也可作为其中一员接入。 |

**适合你，如果你希望：**让智能体团队协作，跨天持续推进工作，并将数据、Key 与智能体默认保存在自己的硬盘上。

**不适合你，如果你只需要：**一个通用聊天机器人，或嵌入自己应用的纯代码框架。

**选择编程智能体？** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code 替代方案](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**逐项对比 →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## 常见问题（FAQ）

**Orkas 是什么？**
Orkas 是开源（MIT）、本地优先的多智能体桌面应用。指挥官将目标拆成待办，协调 16 个内置专业智能体，以及 Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent，交付成品文件。

**需要 API Key 吗？**
不需要。安装版赠送 500 积分，可直接使用内置 Orkas 模型。用完后可购买积分、选择付费会员，或添加自己的模型服务商 Key；自有服务商的费用单独计算。

**Orkas 是本地大模型吗？**
不是。Orkas 在你的电脑上运行，调用你选择的内置 Orkas 模型、自有 API Key 或本地模型端点。它负责协调智能体与工具，本身不是模型。

**能基于我的文档回答问题，并标注出处吗？**
可以。把 PDF 和文档加入本地资料库，Orkas 可搜索这些文件，并在回答中引用来源段落，方便打开原文核对。索引在本机建立。

**能使用 Ollama、LM Studio 等本地模型吗？**
可以。打开 **账号设置 → 模型 → 对话 → 添加模型 → 自定义**，选择 **OpenAI 兼容** 或 **Anthropic 兼容**，填写基础地址、准确的模型 ID 和 API Key，然后在任务的模型控件中选择已保存的模型。

**API Key 和数据存在哪里？**
默认保存在本机。你自己的服务商 Key 在本地加密保存，并排除在云同步之外。使用自己的 Key 时，模型调用从本机直连服务商；内置 Orkas 模型使用 Orkas 托管服务。安装版的可选云同步和共享项目会将所选数据保存在 Orkas 服务器上。[安全与数据处理 →](https://orkas.ai/security/?source=gh-orkas)

**Orkas 能完全离线使用吗？**
源码版配合本地模型端点可以完全离线运行。安装版需要登录，云端模型调用需要联网。

**电脑关机后还会继续工作吗？**
不会。Auto-advance 和定时自动化需要电脑保持唤醒，且 Orkas 正在运行。从 1.9 起，电脑唤醒或应用启动后，每个自动化会补跑 12 小时内最近一次错过的任务。

**能做应用和发布应用吗？**
可以。在 Orkas 内运行的本地应用免费。将网页应用发布为公开链接需要付费会员，Lite、Pro、Max 分别可发布 5、8、15 个；公开网页应用不包含 Orkas 桌面应用内的全部能力。

**需要 Orkas 账号吗？**
安装版首次启动时需要登录。本仓库的源码版没有账号模块，启动后直接进入应用。

**能驱动 Claude Code 等 CLI 智能体吗？**
可以。Orkas 能将五个外部 CLI 智能体作为本地子进程运行：Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent；也可接入 HyperFrames 等开源工具，在同一个对话中协调工作。

**和 Claude Cowork、Claude Desktop、CrewAI、LangChain 有什么不同？**
Claude Cowork 和 Claude Desktop 基于 Claude；CrewAI 和 LangChain 是代码优先的框架。Orkas 是开源桌面应用，由指挥官协调专业智能体与 CLI 智能体，可选择不同模型服务商，数据与 Key 默认保存在本地。[查看完整对比](https://orkas.ai/compare/?source=gh-orkas)。

**支持哪些平台？**
macOS 12+（Apple Silicon 与 Intel）和 Windows 10+ 提供安装包。glibc 2.34+ Linux x64/arm64 目前通过源码运行，尚无安装包；首次启动会准备固定版本的 whisper.cpp 运行时，支持本地语音转写。不支持 Alpine 等基于 musl 的发行版。源码启动需要 Node 22.12+；只有原生 npm 包缺少兼容的预编译文件、需要本地重建时，才需要 Python 3 和 C/C++ 构建工具链。

**Orkas 免费且开源吗？**
是的，应用采用 MIT 许可证，可免费使用。安装版赠送 500 积分；付费会员每月 $11.99 起，增加月度积分、云同步、更多共享项目和网页应用发布能力。使用自己的 Key 时，模型用量由服务商计费，Orkas 不加价。[价格 →](https://orkas.ai/pricing/?source=gh-orkas)

---

## 快速开始

想直接用安装包？见上方 [下载](#下载)。以下是从源码运行的方式 —— 也是目前在 Linux 上运行 Orkas 的方式：

**环境要求**：Node 22.12+ · macOS / Windows 10+ / 基于 glibc 2.34+ 的 Linux x64 或 arm64。建议保留 Python 3 与 C/C++ 构建工具链，用于少数原生模块需要源码编译的兜底场景。

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux 源码运行需要 glibc 2.34+，不支持 Alpine 及其他基于 musl 的发行版。本地语音转写会在首次源码启动时下载并校验目标架构对应的 whisper.cpp 运行时及多语言模型。

`run.sh` / `run.cmd` 会在首次启动时安装 lockfile 固定的 npm 依赖，并准备固定版本的 Python、uv、Node、嵌入模型（约 95 MB）、OfficeCLI、FFmpeg、whisper.cpp 与多语言语音模型。Linux 启动还会在 Electron ABI 下验证平台原生模块及 Whisper 运行时后再打开应用。OCR 与 Skill 专属 Python 包会在首次使用对应功能时安装到隔离的本地环境。首次启动会在 `~/.orkas/`（macOS / Linux）或 `<最小的非系统盘>:\.orkas\`（Windows）下创建工作区。随后进入 **设置 → AI 服务商** 配置 API key 或 OAuth。

遇到原生依赖错误时，请使用 Node.js 24 LTS（最低 22.12.0），在此源码目录执行
`npm run native:repair`。它会恢复可选依赖、修复 Electron 对应的 SQLite，并验证 SQL、
sqlite-vec，并准备随包 Node、在独立进程中验证 sharp 后才报告成功。只检查、不安装可运行 `npm run native:check`。
详见[原生依赖安装与排错说明](docs/native-dependencies.md)。

---

## 截图

![Orkas 主界面：左侧为指挥官、智能体、技能、连接器与资料库，中间是任务输入框与快捷模板](./resources/app-ui/home-zh.jpg)

---

## 工作原理（核心设计）

> 完整设计与硬约束 → [`CLAUDE.md`](./CLAUDE.md)

### 三个派发动词，以及选哪个的规则

指挥官是唯一持有派发工具的角色 —— worker 和智能体都没有。选哪个动词，决定了用户听谁说话、以及指挥官是否留在回合里：

| 动词 | 用户看得到智能体的回复 | 结果回传给指挥官 | 指挥官的回合 |
| --- | --- | --- | --- |
| `hand_off_to({ to, message })` | 是 | 否 | 结束 —— 智能体的回复本身就是答案 |
| `dispatch_to({ to, message })` | 是 | 是 | 继续执行一个已命名的下一步 |
| `run_worker({ to, task })` | 否 —— 作为私有输入 | 是 | 继续 |

指挥官必须**先**说出自己具体的下一步动作，才可以选 `dispatch_to`；如果剩下的事只是复述智能体的回复，规则就强制它改用 `hand_off_to`。正是这一条约束，让多智能体对话不会以"把你刚读过的内容再总结一遍"收尾。在同一次回复里发出多个 `run_worker` 调用，它们会并发执行。

### 单一运行时，有界扇出

每个对话只有一个 FIFO 运行时，顶层回合串行通过它；并行发生在回合**内部**，以进程内嵌套派发的形式（[`bus.ts`](./src/main/features/group_chat/bus.ts)）。两个独立的信号量为它设界 —— 跨所有用户的 `globalSlots = 10`，以及用于嵌套派发的 `dispatchSlots = 4`（可用 `ORKAS_MAX_DISPATCH_CONCURRENCY` 覆盖）。

嵌套运行刻意跳过 `globalSlots`：父回合已经占着一个槽位，嵌套获取会造成"父等子"的死锁。这个捷径之所以安全，只因为派发工具专属于指挥官，信号量不可能被重入获取 —— 死锁是被构造排除的，而不是靠超时兜底。

### 上下文预算：由模型推导，而不是写死一个数

每个压缩阈值都由当前使用的模型推导而来，因此同一套策略既适配 32K 窗口，也适配 1M 窗口（[`context-budget.ts`](./src/core-agent/src/agent/context-budget.ts)）：

```
usableInput   = 上下文窗口 − 最大输出 token − 安全余量
messageBudget = max(usableInput × 0.2, usableInput − 系统提示 − 工具定义)
```

每个触发阈值都是 `messageBudget` 的一个份额 —— 回合内层 0.3、跨回合历史 0.2、单轮内联工具结果 0.1 —— 其余参数都由触发阈值派生，因此这几个份额是唯一的可调面。它们的总和远小于 1，留出的余量用于回灌的运行时状态，以及"触发发生到摘要落地"之间仍在继续的增长。那个 `max` 是保险丝：当工具集大到会吃掉整个窗口时，消息仍保有一个底线份额，而不是算出一个负预算。

一次运行需要压缩多少次就压缩多少次 —— **成功压缩的次数刻意不设上限**。真正设界的是无效功：指纹校验拒绝对同一状态重复压缩，最小收益阈值拒绝那些释放太少的压缩，连续三次失败则停止 LLM 压缩。

摘要必然丢细节，所以智能体绝不能忘的东西不交给散文承载。一份记录"写过哪些文件、读过哪些文件、跑过哪些命令"的工作台账会以结构形式挺过压缩（[`workspace-state.ts`](./src/core-agent/src/agent/workspace-state.ts)）；另有一个空转检测 —— 压缩两次以上且工具预算已消耗 75% —— 会提醒智能体一次，让它回到台账重新锚定，而不是把刚被摘要掉的工作再推导一遍。

### 记忆：本地索引上的混合检索

资料库是一份构建在你本机的 SQLite 索引 —— 用 FTS5 做全文、用存储的向量做相似度（[`memory/`](./src/core-agent/src/memory)）。文档按 512 行切块、块间重叠 64 行；一次查询两路并发，两个排序结果用 reciprocal rank fusion 融合，权重为向量 0.7、关键词 0.3。智能体通过 `memory_search` 与 `memory_read` 访问它，检索范围同时覆盖存入的文档和历史会话。

嵌入向量**在本机计算**，由随包的 ONNX 模型完成（`bge-small-zh-v1.5`，约 95 MB，安装时下载一次），因此建立资料库索引不会把任何内容发出去。如果你更愿意用云端嵌入服务，OpenAI、Gemini、Voyage、Mistral 也都支持。

### 四道互相独立的失控保护

- **轮次上限** —— `MAX_WORKER_TURNS = 100` 计的是回合数而非墙钟时间，因此一个慢但在推进的模型不会被误杀。
- **每回合工具轮数** —— 指挥官 120、具名智能体 100、临时 worker 用 schema 默认值（[`actor-budgets.ts`](./src/main/features/group_chat/actor-budgets.ts)），由单元测试钉死，不会悄悄漂移。
- **`loop_detection`** —— 连续 N 次相同或近似重复的工具调用后提醒模型。
- **工具空闲看门狗** —— 针对卡住而非打转的回合。

### 自我进化：由信号触发，而非每次任务都做

每个智能体维护 `meta/COMPETENCE.md`（我擅长什么 / 不擅长什么）和 `meta/LEARNING_STRATEGIES.md`（对我有效的方法），两者都会在下一次运行时回喂进它的系统提示。

复盘不是固定计数器。一个加权触发器为六个信号打分 —— `error_recovery`、`user_correction`、`complexity`、`known_weakness`、`weakness_succeeded`、`skill_ineffective` —— 只有总分越过阈值才触发复盘，并依据占主导的那个信号生成复盘提示（[`metacognition.ts`](./src/core-agent/src/evolution/metacognition.ts)）。通过 `skill_manage`，智能体还能把"我是如何解决 X 的"结晶成一份**私有** `SKILL.md`，从下一回合起即可使用。

---

## 致谢

本项目部分核心模块参考了以下开源项目，特此致谢：

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes-Agent](https://github.com/NousResearch/hermes-agent)

---

## 许可证

[MIT](./LICENSE)
