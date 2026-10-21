# Orkas

**An open-source team of AI agents on your desktop — it turns your goals into finished work and keeps it moving.**

Orkas is an open-source (MIT), local-first multi-agent desktop app — an AI assistant that works as a team. Describe a goal and the **Commander** turns it into to-dos, handles the general parts itself, and coordinates **16 built-in specialist agents** — research, writing, slides, video, voice, design, code, SEO and e-commerce — plus the coding and personal agents you already use: **Claude Code, Codex, OpenCode, OpenClaw and Hermes-Agent**. Projects keep goals, memory and files together; Auto-advance and scheduled automations keep the work moving; finished work comes back for your review.

**[⬇ Download Orkas for macOS & Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — free, with 500 credits for the built-in Orkas model, so you don't need an API key to start. Prefer your own keys? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, or a local OpenAI-compatible endpoint.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=social)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)

[English](./README.md) · [简体中文](./README.zh-CN.md)

---

**You:** *"Research the top 5 competitors, write it up, and turn it into a deck."*

**Orkas:** the Commander turns the goal into to-dos and runs them across specialists — **DeepResearcher** gathers and verifies the sources, **ContentWriter** drafts the report, **PptMaker** builds the slides. One chat, one shared plan, finished files in your project.

![Orkas demo: the Commander turns a goal into to-dos, dispatches them to specialist agents, and delivers the finished files](./resources/app-ui/demo-en.gif)

---

## Keep the work moving

One task is a good start. Orkas is built for the work that keeps going.

- **Projects** — goals & rules, memory and files that every conversation in the project starts from, so you never brief from scratch.
- **To-dos and Auto-advance** — every project has a to-do list for people and agents; with Auto-advance on, the team picks up the next item on its own and brings finished work back for your review.
- **Scheduled automations** — run any task hourly, daily, weekly or monthly. Orkas runs on your computer. From v1.9, each automation catches up its most recent missed run within 12 hours when the computer wakes or Orkas starts.
- **Connectors** — Gmail, Google Calendar, Sheets and Drive, Notion, Slack, Shopify, Stripe and many more. By default, Orkas asks before it sends, posts or deletes anything.
- **Apps** — describe a tool and Orkas builds it as a local app inside the desktop app. On a paid plan, publish it as a web app with a public link.
- **Shared projects** — invite a teammate or VA, and give each to-do to a person or an agent.

Cloud sync, shared projects, voice input and web-app publishing are part of the packaged app; most of the rest also works in the source build.

---

## What the team delivers

- **Videos, voice-overs and images** — VideoStudio, VoiceStudio, ImageStudio
- **Research reports, SEO audits and market analysis** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Posts, articles, newsletters and slide decks** — ContentWriter, PptMaker
- **Websites, UI and code** — UIDesigner, ProductDeveloper
- **Word, Excel, PowerPoint and PDF files** — OfficeWorker
- **E-commerce work** — product research, listings, review analysis, sales analysis and catalog changes, from five e-commerce agents

Sixteen specialists ship with the app, each with its own skills, memory and tools. Browse 30+ agents in the [agent marketplace](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas), or describe the role you need and the Commander builds a custom agent for you.

<details>
<summary><b>All 16 built-in agents</b></summary>

| Area | Agent | What it delivers |
| --- | --- | --- |
| Research & analysis | **DeepResearcher** | Evidence-grounded research with verified sources, flagged contradictions and an auditable report |
| | **SeoGeoAgent** | Give it a URL — technical audit, content quality, Core Web Vitals, AI-answer (GEO) citability, ranked fix list |
| | **StockAnalyser** | Equity research, factor screens, backtests and portfolio risk checks, with traceable dashboards |
| Content & media | **ContentWriter** | Publish-ready posts, articles, newsletters and case studies from a goal, sources or a rough draft |
| | **PptMaker** | Editable, reviewable PPTX decks from a topic, outline or document |
| | **ImageStudio** | Posters, covers, social images and infographics |
| | **VideoStudio** | Narration, AI presenters, captions and dubbing, highlight clips, localization |
| | **VoiceStudio** | Narration, multi-voice audio, transcripts and subtitles, audio editing and mixing |
| | **UIDesigner** | Editable, HTML-first UI from product goals, PRDs, screenshots or Figma material |
| Build & office | **ProductDeveloper** | Repo-aware engineering — implement a PRD, fix bugs, refactor, review, with verifiable results |
| | **OfficeWorker** | Create, edit, check and deliver Word / Excel / PowerPoint / PDF files, one at a time or in batches |
| E-commerce | **ECommerceResearcher** | Product selection by budget, market and sourcing limits — candidates, rejection reasons, validation plans |
| | **ECommerceWriter** | Titles, detail pages, FAQs, image copy and video scripts in your brand voice |
| | **ECommerceReviewer** | Review and reputation analysis — customer themes, root causes of bad reviews, priorities |
| | **ECommerceAnalyzer** | Sales, profit, ads, refunds and inventory from your exports — reconciled metrics and decisions |
| | **ECommerceOperator** | Plans catalog, price, promotion and inventory changes; executes only through tools you connect |

More on each agent → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

---

## Run Claude Code, Codex and OpenCode together

Orkas runs the CLI agents you already have installed as local sessions, next to its own specialists — the coding agents **Claude Code, Codex and OpenCode**, and the personal agents **OpenClaw and Hermes-Agent**. The Commander hands each one the part it's best at and keeps one plan across all of them, so a single chat can fix the bug, review the change and draft the release note. Open-source tools such as HyperFrames plug in the same way.

[Using Claude Code and Codex together →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Why Orkas

- **A Commander that plans, delegates and does the rest** — it breaks down goals, picks the right agents, skills, connectors and tools, and handles analysis, writing, research and file work itself when no specialist is a better fit.
- **Local-first by design** — conversations, files, knowledge bases and custom agents stay on your disk by default. Cloud sync is optional in the packaged app. With your own keys, model calls go straight from your machine to the provider; the built-in Orkas model runs through Orkas's managed model service.
- **Any model, switch any time** — the Commander and built-in agents share one model setting: the built-in Orkas model, your own provider, or a local endpoint. External CLI agents keep their own model settings.
- **Agents that get better** — each agent keeps private skills and memory, and reflects when a task signals it should (a correction, a recovered error, a known weakness) to improve the next run.
- **Open source, no black box** — MIT licensed. Read exactly what Orkas and every agent and skill do.

> ⭐ If Orkas is useful to you, a star helps more people find the project.

---

## Download

| | Packaged app (recommended) | Run from source |
| --- | --- | --- |
| Platforms | macOS 12+ (Apple Silicon & Intel), Windows 10+ | macOS, Windows, glibc 2.34+ Linux x64/arm64 |
| Account | Sign in — 500 free credits | None |
| Models | Built-in Orkas model, or your own keys | Your own keys or a local endpoint |
| Also includes | Cloud sync, shared projects, voice input, web-app publishing | — |
| Get it | **[Download Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Quick start](#quick-start) |

The download link detects your system and starts the right installer.

---

## What people use it for

- **Marketing content** — launch videos, product pages, posts and newsletters in your voice. [Content writing](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Videos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Store operations** — weekly sales briefs, review replies, listings and competitor checks. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Research and reports** — sourced reports and decks, on demand or every week. [Research](https://orkas.ai/use/researchers/?source=gh-orkas) · [Data analysis](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Chat with your documents** — answers grounded in your own files, with citations back to the source passages. [Chat with documents](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Client work** — meeting briefs, monthly client reports and update decks in your template. [Monthly client report template](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Product launch** — landing pages, bug fixes with tests, changelogs and launch posts. [Developers](https://orkas.ai/use/developers/?source=gh-orkas)
- **Build an app** — quote calculators, booking forms, internal tools. [Build apps](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Small teams** — one project for people and agents. [Small teams](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## How Orkas compares

| Tool | What it is | How Orkas differs |
| --- | --- | --- |
| **Claude Cowork** | Anthropic's agentic desktop experience, built on Claude. | Orkas is open source (MIT) and model-agnostic — the built-in Orkas model or your own keys from any provider — and coordinates Claude Code, Codex and OpenCode alongside its own specialists. [Claude Cowork alternatives →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **LangChain** | A developer framework/library for building LLM apps and agents — code-first, embedded in your own Python/JS app. | Orkas is a desktop app you direct through chat, not by writing orchestration code. Data stays local by default. |
| **CrewAI** | A Python framework for orchestrating role-playing autonomous agents — you define crews and agents in code. | Orkas brings multi-agent orchestration into a desktop app, with projects, to-dos, automations and per-agent self-improvement built in. |
| **OpenClaw** | A single always-on personal assistant reaching you across messaging channels. | Orkas gives you a team rather than one assistant, and OpenClaw plugs in as one of its CLI agents. |
| **Hermes-Agent** | Nous Research's self-improving agent — one agent with memory and skills, available as a CLI, a messaging gateway and a desktop app. | Orkas coordinates a team: the Commander directs many specialists and other CLI agents, and Hermes-Agent plugs in as one of them. |

**Orkas is for you if** you want a team of agents rather than one assistant, work that keeps moving across days, and your data, keys and agents on your own disk.

**Not for you if** you just want a single all-purpose chatbot, or a pure code library to embed in your own app.

**Choosing between coding agents?** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code alternatives](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Full side-by-side comparisons →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## FAQ

**What is Orkas?**
Orkas is an open-source (MIT), local-first multi-agent desktop app. Its Commander turns your goal into to-dos and coordinates 16 built-in specialist agents — plus Claude Code, Codex, OpenCode, OpenClaw and Hermes-Agent — to deliver finished files. Not a single chatbot, not a code framework, not a hosted SaaS.

**Do I need an API key?**
No. The packaged app comes with 500 credits for the built-in Orkas model. After that, buy credits, choose a paid plan or add your own provider keys; provider charges are separate.

**Is Orkas a local LLM?**
No. Orkas runs on your machine and calls the models you choose — the built-in Orkas model, your own API keys, or a local model endpoint. It orchestrates agents and tools; it is not itself a model.

**Can Orkas answer questions from my documents, with citations?**
Yes. Add PDFs and documents to your local Library; Orkas can search them and answer with citations to source passages, so you can open the original and check. The index is built on your machine.

**Can I use local models like Ollama or LM Studio?**
Yes. Open **Account settings → Models → Chat → Add model → Custom**, select **OpenAI-compatible** or **Anthropic-compatible**, and enter the base URL, exact model ID, and API key. Choose the saved model from the task's model control.

**Where are my API keys and data stored?**
On your disk by default. Your own provider keys are encrypted locally and excluded from cloud sync. With your own keys, model calls go straight from your machine to the provider; the built-in Orkas model uses Orkas's managed service. Optional cloud sync and shared projects in the packaged app store the selected data on Orkas servers. [Security and data handling →](https://orkas.ai/security/?source=gh-orkas)

**Does Orkas work offline?**
The source build can run fully offline against a local model endpoint. The packaged app needs to sign in, and cloud models need a network connection.

**Does it keep working when my computer is off?**
No — Orkas runs on your computer, so Auto-advance and automations need the computer awake and Orkas running. From v1.9, each automation catches up its most recent missed run within 12 hours when the computer wakes or Orkas starts.

**Can I build and publish apps?**
Yes. Local apps that run inside Orkas are free. Publishing a web app to a public link needs a paid plan (Lite 5, Pro 8, Max 15 apps), and published web apps don't include every capability available inside Orkas.

**Do I need an Orkas account?**
The packaged desktop app asks you to sign in when you first launch it. The source build in this repository has no account layer at all — it boots straight into the app.

**Can Orkas drive Claude Code and other CLI agents?**
Yes. Orkas can drive five external CLI agents as local subprocesses — the coding agents Claude Code, Codex and OpenCode, plus the personal agents OpenClaw and Hermes-Agent — and onboard open-source projects like HyperFrames, all directed from the same chat.

**How is Orkas different from Claude Cowork / Claude Desktop / CrewAI / LangChain?**
Claude Cowork and Claude Desktop are built on Claude alone; CrewAI and LangChain are code-first frameworks. Orkas is an open-source desktop app where a Commander coordinates a team of specialist agents and your CLI agents, with any model provider, and keeps data and keys local. See the [full comparisons](https://orkas.ai/compare/?source=gh-orkas).

**Which platforms does Orkas support?**
macOS 12+ (Apple Silicon and Intel) and Windows 10+ have packaged installers. glibc 2.34+ Linux x64/arm64 runs from source today, with no installer yet. Local speech transcription is supported on Linux through the pinned whisper.cpp runtime prepared on first launch. Alpine and other musl-based distributions are not supported. The source bootstrap needs Node 22.12+; Python 3 and a C/C++ build toolchain are needed only when a native npm package has no compatible prebuilt binary and must be rebuilt locally.

**Is Orkas free and open source?**
Yes — the app is MIT licensed and free to use. The packaged app includes 500 credits for the built-in Orkas model; paid plans from $11.99/month add monthly credits, cloud sync, more shared projects and app publishing. With your own keys, model usage is billed by your provider; Orkas does not add a markup. [Pricing →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Quick start

Want a packaged installer instead? See [Download](#download) above. To run from source — currently the way to run Orkas on Linux:

**Requirements**: Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 or arm64. Keep Python 3 and a C/C++ build toolchain available for the uncommon native-module source-build fallback.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux source runs require glibc 2.34+. Alpine and other musl-based distributions are not supported. Local speech transcription downloads and verifies the target-native whisper.cpp runtime and multilingual model during the first source launch.

`run.sh` / `run.cmd` installs the locked npm dependency tree and prepares the pinned Python, uv, Node, embedding model (~95 MB), OfficeCLI, FFmpeg, whisper.cpp, and multilingual speech model resources on first launch. Linux startup then verifies the platform-native modules and Whisper runtime under Electron's ABI before opening the app. OCR and Skill-specific Python packages are installed into isolated local environments when those features are first used. First launch creates a workspace under `~/.orkas/` (macOS / Linux) or `<smallest non-system drive>:\.orkas\` (Windows). Then open **Settings → AI Providers** to add an API key or OAuth.

Native dependency errors: use Node.js 24 LTS (minimum 22.12.0), then run
`npm run native:repair` from this checkout. This restores optional packages,
repairs SQLite for Electron, prepares bundled Node for isolated image processing,
and checks SQL, sqlite-vec and sharp before success.
Use `npm run native:check` for a check without installation.
See [native dependency setup and troubleshooting](docs/native-dependencies.md).

---

## Screenshots

![Orkas home screen: sidebar with Commander, Agents, Skills, Connectors and Library, and a task box with quick-start templates](./resources/app-ui/home-en.jpg)

---

## How it works (core design)

> Full design and hard constraints → [`CLAUDE.md`](./CLAUDE.md)

### Three dispatch verbs, and the rule for choosing between them

The Commander is the only actor holding dispatch tools — workers and agents have none. Which verb it picks decides who the user hears from and whether the Commander stays in the loop:

| Verb | User sees the agent's reply | Result returns to the Commander | Commander's turn |
| --- | --- | --- | --- |
| `hand_off_to({ to, message })` | yes | no | ends — the agent's reply stands as the answer |
| `dispatch_to({ to, message })` | yes | yes | continues with a named next step |
| `run_worker({ to, task })` | no — private input | yes | continues |

The Commander has to name its concrete next action *before* it may choose `dispatch_to`; if all that remains is restating the agent's reply, the rule forces `hand_off_to`. That single constraint is what stops a multi-agent chat from ending in a redundant re-summary of what you already read. Emitting several `run_worker` calls in one response runs them concurrently.

### One runtime, bounded fan-out

Each conversation has a single FIFO runtime, and top-level turns run through it serially; parallelism happens *inside* a turn as nested in-process dispatch ([`bus.ts`](./src/main/features/group_chat/bus.ts)). Two separate semaphores bound it — `globalSlots = 10` across all users, and `dispatchSlots = 4` for nested dispatches (`ORKAS_MAX_DISPATCH_CONCURRENCY`).

Nested runs deliberately skip `globalSlots`: the parent turn already holds a slot, so a nested acquire would deadlock as parent-waits-on-child. That shortcut is safe only because dispatch tools belong to the Commander alone, so the semaphore is never acquired re-entrantly — the deadlock is ruled out by construction, not by a timeout.

### Context budget: derived from the model, not a fixed number

Every compaction threshold is derived from the model in use, so one policy fits a 32K window and a 1M one alike ([`context-budget.ts`](./src/core-agent/src/agent/context-budget.ts)):

```
usableInput   = contextWindow − maxOutputTokens − safety
messageBudget = max(usableInput × 0.2, usableInput − systemPrompt − toolDefs)
```

Every trigger is a share of `messageBudget` — 0.3 for the in-turn layer, 0.2 for cross-turn history, 0.1 for one round's inline tool results — and everything else derives from its trigger, so the shares are the only tunable surface. They sum to well under 1, leaving room for injected runtime state and for the growth that happens between a trigger firing and its summary landing. The `max` is a fuse: when a large tool set would otherwise swallow the window, messages keep a floor share instead of computing a negative budget.

A run compacts as many times as it needs to — there is deliberately **no ceiling on successful passes**. What is bounded is wasted work instead: a fingerprint check refuses to compact identical state twice, a minimum-savings threshold rejects passes that would free too little, and three consecutive failures stop LLM-backed compaction.

Summarization loses detail, so what an agent must not forget is kept as structure rather than prose. A workspace ledger of files written, files read, and commands run survives compaction ([`workspace-state.ts`](./src/core-agent/src/agent/workspace-state.ts)), and a spin detector — two or more compactions plus 75% of the tool budget consumed — nudges the agent once to re-anchor on that ledger instead of re-deriving work it just summarized away.

### Memory: hybrid retrieval over a local index

A knowledge base is a SQLite index built on your machine — FTS5 for full text, stored vectors for similarity ([`memory/`](./src/core-agent/src/memory)). Documents are chunked at 512 lines with 64 lines of overlap; a query runs both ways and the two ranked lists merge by reciprocal rank fusion, weighted 0.7 vector to 0.3 keyword. Agents reach it through `memory_search` and `memory_read`, over stored documents and past sessions alike.

Embeddings are computed **on device** by a bundled ONNX model (`bge-small-zh-v1.5`, ~95 MB, fetched once during install), so indexing a knowledge base sends nothing anywhere. Cloud embedding providers — OpenAI, Gemini, Voyage, Mistral — are available if you prefer them.

### Four independent runaway guards

- **Turn ceiling** — `MAX_WORKER_TURNS = 100` counts turns, not wall-clock time, so a slow-but-progressing model isn't killed.
- **Per-turn tool rounds** — Commander 120, named agent 100, ephemeral worker the schema default ([`actor-budgets.ts`](./src/main/features/group_chat/actor-budgets.ts)), pinned by unit tests so they can't silently drift.
- **`loop_detection`** — nudges the model after N consecutive identical or near-duplicate tool calls.
- **Tool-idle watchdog** — for turns that stall rather than loop.

### Self-evolution: signal-triggered, not after every task

Each agent keeps `meta/COMPETENCE.md` (what it is and isn't good at) and `meta/LEARNING_STRATEGIES.md` (methods that have worked for it), both fed back into its system prompt on the next run.

Reflection is not a fixed counter. A weighted trigger scores six signals — `error_recovery`, `user_correction`, `complexity`, `known_weakness`, `weakness_succeeded`, `skill_ineffective` — and reviews only when the total clears a threshold, generating the review prompt from whichever signal dominated ([`metacognition.ts`](./src/core-agent/src/evolution/metacognition.ts)). Through `skill_manage` an agent can also crystallize "how I solved X" into a **private** `SKILL.md` that it can use from the next turn on.

---

## Acknowledgments

Some core modules draw on these open-source projects — special thanks to:

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes-Agent](https://github.com/NousResearch/hermes-agent)

---

## License

[MIT](./LICENSE)
