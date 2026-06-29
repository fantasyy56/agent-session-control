<div align="center">

# Agent Session Control

**A real-time, multi-source AI coding session observatory with built-in cross-model peer review.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D16-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

<img width="900" alt="Agent Session Control Dashboard" src="https://raw.githubusercontent.com/your-username/agent-session-control/main/docs/screenshot.png" />

*Unified real-time observatory for Claude CLI + CodeBuddy IDE sessions, with cross-model debate-style peer review.*

</div>

---

## Why This Exists

Modern AI-assisted coding spans multiple surfaces — terminal agents (Claude Code CLI), IDE copilots (CodeBuddy), and everything in between. These tools write to separate, incompatible local stores with no unified view.

**Agent Session Control** solves this by reading directly from each tool's local storage, normalizing the message model, and presenting a single live dashboard. When you want a second opinion on what the agent just did, kick off a **cross-model peer review** — two heterogeneous LLMs debate the session transcript and converge to a conclusion, right inside the dashboard.

---

## Highlights

### Multi-Source Session Aggregation

- **Zero-config discovery** — automatically finds Claude CLI sessions under `~/.claude/projects/` and CodeBuddy IDE conversations under the macOS Application Support directory. No path configuration needed.
- **Unified message model** — both sources are normalized to the same `role + blocks` schema (`text`, `thinking`, `tool_use`, `tool_result`, `image`), regardless of the underlying storage format.
- **Live file-system watching** — [chokidar](https://github.com/paulmillr/chokidar) watches both stores concurrently; incremental message deltas are pushed over WebSocket within milliseconds of the agent writing to disk.

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
cd agent-session-control/multi-agent-debate

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

---

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
