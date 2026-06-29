<div align="center">

# Agent Session Control

**A real-time, multi-source AI coding session observatory with built-in cross-model peer review.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D16-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

<img width="900" alt="Agent Session Control Dashboard" src="https://raw.githubusercontent.com/your-username/agent-session-control/main/docs/screenshot.png" />

*Unified real-time observatory for Claude CLI sessions.*

</div>

---

## Why This Exists

The **Claude CLI agent** writes sessions to local files, but there's no unified way to inspect, review, or manage them. Each session becomes a **black box** — you can't easily compare outputs from different models, audit what was done, or inject feedback back into live sessions.

**Agent Session Control** is a **real-time session observatory** purpose-built for Claude CLI. It reads directly from Claude's local session store, watches for live changes, and presents a unified dashboard for inspection and peer review. Beyond Claude, the system is extensible: CodeBuddy IDE, Cursor, Windsurf, and other AI tools can be added as additional session sources without touching core logic.

---

## Supported Session Sources

| Source | Status | Auto-Discovery |
|---|---|---|
| **Claude CLI** | ✅ Active | `~/.claude/projects/` |
| **CodeBuddy IDE** | ✅ Active | `~/Library/Application Support/CodeBuddyExtension/Data/` |
| **Cursor** | 🔜 Planned | `~/.cursor/` (estimated) |
| **Windsurf** | 🔜 Planned | `~/.windsurf/` (estimated) |

---

## Core Features

### Multi-Source Session Aggregation

- **Zero-config discovery** — automatically finds Claude CLI sessions and CodeBuddy IDE conversations. No path configuration needed.
- **Unified message model** — all sources normalize to the same `role + blocks` schema (`text`, `thinking`, `tool_use`, `tool_result`, `image`), regardless of storage format.
- **Live file-system watching** — [chokidar](https://github.com/paulmillr/chokidar) monitors all sources concurrently; incremental deltas are pushed over WebSocket within milliseconds.

### Intelligent Session View

- **Concise / Full toggle** — per-session view mode. Concise mode collapses consecutive tool calls into a compact strip (`🔧 Read · Edit · Bash × 3`), folds `thinking` blocks with a 60-char preview, and hides noise-only messages. Full mode shows everything flat.
- **Prompt vs. injection parser** — user messages often carry large system-injected XML blocks (`<system-reminder>`, `<additional_data>`, etc.). The renderer automatically separates your actual prompt from injected context and categorizes each block by semantic type:
  
  | Category | Color | Matched tags |
  |---|---|---|
  | 📜 Rules / Policy | Orange | `reminder`, `rule`, `policy`, `security` |
  | 📎 Context / Data | Blue | `context`, `additional_data`, `environment`, `open_files` |
  | ⚙ Command output | Gray | `command`, `stdout`, `stderr`, `caveat` |
  | 🧠 Memory / History | Purple | `memory`, `history`, `summary`, `previous` |

- **Source badges** — sessions are tagged with their origin (`CLI` / `IDE`) and filterable via tab switcher.

### Cross-Model Peer Review

The review subsystem implements an **asymmetric debate protocol**:

```
Executor model  ←── full session context (last N rounds)
Reviewer model  ←── summary brief only

              ↕  ping-pong up to REVIEW_MAX_ROUNDS
              
              → converged conclusion
```

- The **executor** (e.g. DeepSeek V3) holds the full conversation context and proposes an analysis.
- The **reviewer** (e.g. Qwen3) receives only a lean summary brief, injecting independent perspective without anchoring bias.
- Rounds converge automatically when both models signal agreement; a moderator can force-terminate at any time.
- Configurable via `.env`: model selection, max rounds, context window size.

### Architecture

```
Claude ~/.claude/projects/         src/claude/store.ts   ─┐
                                                           ├─→ AggregateStore → server.ts → WebSocket → index.html
CodeBuddy ~/Library/.../Data/  src/codebuddy/store.ts ─┘
```

The `AggregateStore` is source-agnostic: adding a third source (Cursor, Windsurf, etc.) requires only a new `ISessionStore` implementation — zero changes to the server or frontend.

---

## Quick Start

```bash
git clone https://github.com/your-username/agent-session-control.git
cd agent-session-control

cp .env.example .env
# Edit .env: set API_KEY and API_BASE_URL for peer review

npm install
npm run dev
# → http://localhost:3002
```

> **Sessions load automatically.** If `~/.claude/projects/` or the CodeBuddy data directory exists, sessions appear immediately. Otherwise the dashboard loads with built-in sample data.

---

## Configuration (`.env`)

```dotenv
# OpenAI-compatible endpoint (any provider works: Together AI, Fireworks, etc.)
API_BASE_URL=https://api.together.xyz/v1
API_KEY=your_api_key_here

# Peer review models (use two different architectures for diverse perspectives)
REVIEW_EXECUTOR_MODEL=deepseek-v3
REVIEW_REVIEWER_MODEL=qwen3-30b-a3b-instruct
REVIEW_MAX_ROUNDS=6          # max ping-pong rounds before forced conclusion
REVIEW_CONTEXT_ROUNDS=5      # executor receives last N session rounds

PORT=3002

# Optional overrides (auto-detected if omitted)
# CLAUDE_PROJECTS_DIR=~/.claude/projects
# CODEBUDDY_DATA_DIR=~/Library/Application Support/CodeBuddyExtension/Data
```

---

## Roadmap

- [x] **Phase 1** — Claude CLI session monitoring, real-time JSONL streaming
- [x] **Phase 2** — Cross-model peer review (asymmetric context, ping-pong debate)
- [x] **Phase 3** — CodeBuddy IDE source integration, unified aggregation layer
- [x] **Phase 3.1** — Concise/full per-session view, tool call collapsing
- [x] **Phase 3.2** — System injection parser, semantic tag visualization
- [ ] **Phase 4** — Reverse operation: resume/inject into live Claude CLI sessions
- [ ] Session naming persistence
- [ ] Cursor / Windsurf data source adapters

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Transport | WebSocket (`ws`) + Express |
| File watching | chokidar |
| LLM access | OpenAI-compatible REST (any provider) |
| Frontend | Vanilla JS single-page app (zero framework dependencies) |

---

## Contributing

The project follows a single-file frontend architecture (`public/index.html`) to keep the setup frictionless — no build step for the UI. Backend is TypeScript with strict mode enabled.

To add a new session source:

1. Implement `ISessionStore` in `src/<source>/store.ts`
2. Register it in `src/aggregate-store.ts`
3. Emit `sourceType` on normalized sessions

---

## License

MIT
