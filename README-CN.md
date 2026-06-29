<div align="center">

# Agent Session Control

**一个为 Claude CLI 而生的实时会话监视台，支持多源聚合与跨模型对等评审。**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D16-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

<img width="900" alt="Agent Session Control Dashboard" src="https://raw.githubusercontent.com/your-username/agent-session-control/main/docs/screenshot.png" />

*Claude CLI 会话实时观测台，支持多源会话聚合与内置跨模型对等评审。*

</div>

---

## 为什么需要这个工具

**Claude CLI 代理**将会话写入本地文件，但没有统一的方式来检查、评审或管理这些会话。每个会话都变成了一个**黑箱**。你无法轻松比较不同模型的输出、审计执行过程、或将反馈注入到活跃会话中。

**Agent Session Control** 是一个**实时会话监视台**，专为 Claude CLI 设计。它直接读取 Claude 的本地会话存储，实时监测变化，并提供统一的仪表板供检查和对等评审。系统具有高度可扩展性：CodeBuddy IDE、Cursor、Windsurf 等其他 AI 工具可作为额外的会话源添加，无需修改核心逻辑。

---

## 支持的会话来源

| 来源 | 状态 | 自动发现 |
|---|---|---|
| **Claude CLI** | 活跃 | `~/.claude/projects/` |
| **CodeBuddy IDE** | 活跃 | `~/Library/Application Support/CodeBuddyExtension/Data/` |
| **Cursor** | 计划中 | `~/.cursor/` |
| **Windsurf** | 计划中 | `~/.windsurf/` |

---

## 核心功能

### 多源会话聚合

- **零配置发现** — 自动查找 Claude CLI 会话和 CodeBuddy IDE 对话，无需手动配置路径。
- **统一消息模型** — 所有来源归一化为相同的 `role + blocks` 架构（text、thinking、tool_use、tool_result、image），无论底层存储格式如何。
- **实时文件系统监控** — 使用 chokidar 并发监测所有数据源；增量变化通过 WebSocket 在数毫秒内推送。

### 智能会话视图

- **简洁/完整切换** — 按会话切换视图模式。简洁模式将连续的工具调用折叠成紧凑条形，折叠 thinking 块并显示 60 字符预览，隐藏噪音消息。完整模式展示所有内容。
- **提示词 vs. 注入解析器** — 用户消息常包含大型系统注入的 XML 块（system-reminder、additional_data 等）。渲染器自动分离实际提示词和注入的上下文，按语义类型分类每个块。
- **源徽标** — 会话标记其来源（CLI / IDE）并可通过标签切换器筛选。

### 跨模型对等评审

评审子系统实现**非对称辩论协议**：

```
执行模型  - 完整会话上下文（最后 N 轮）
评审模型  - 仅简明摘要

    ping-pong 最多 REVIEW_MAX_ROUNDS 轮
    
    收敛的结论
```

- **执行器**（如 DeepSeek V3）持有完整对话上下文并提出分析。
- **评审器**（如 Qwen3）仅接收精简摘要，提供独立视角而不受锚定偏差影响。
- 当两个模型都表示同意时轮次自动收敛；主持人可随时强制终止。
- 通过 `.env` 配置：模型选择、最大轮数、上下文窗口大小。

### 架构

Claude CLI 会话存储和 CodeBuddy IDE 数据通过 AggregateStore 统一聚合，推送至 WebSocket 服务器，最终呈现在前端仪表板。AggregateStore 与数据源无关：添加第三个数据源（Cursor、Windsurf 等）仅需实现新的 ISessionStore —— 服务器和前端无需任何改动。

---

## 快速开始

```bash
git clone https://github.com/your-username/agent-session-control.git
cd agent-session-control

cp .env.example .env
# 编辑 .env: 设置 API_KEY 和 API_BASE_URL 用于对等评审

npm install
npm run dev
# -> http://localhost:3002
```

会话自动加载。如果 ~/.claude/projects/ 或 CodeBuddy 数据目录存在，会话会立即显示。否则仪表板将使用内置示例数据加载。

---

## 配置（`.env`）

```dotenv
# OpenAI 兼容端点（任何提供商都可用：Together AI、Fireworks 等）
API_BASE_URL=https://api.together.xyz/v1
API_KEY=your_api_key_here

# 对等评审模型（使用两个不同的架构以获得多样化视角）
REVIEW_EXECUTOR_MODEL=deepseek-v3
REVIEW_REVIEWER_MODEL=qwen3-30b-a3b-instruct
REVIEW_MAX_ROUNDS=6
REVIEW_CONTEXT_ROUNDS=5

PORT=3002

# 可选覆盖（如果省略则自动检测）
# CLAUDE_PROJECTS_DIR=~/.claude/projects
# CODEBUDDY_DATA_DIR=~/Library/Application Support/CodeBuddyExtension/Data
```

---

## 技术栈

| 层次 | 技术 |
|---|---|
| 运行时 | Node.js + TypeScript |
| 传输 | WebSocket (ws) + Express |
| 文件监控 | chokidar |
| LLM 访问 | OpenAI 兼容 REST（任何提供商） |
| 前端 | 原生 JS 单页应用（零框架依赖） |

---

## 许可证

MIT
