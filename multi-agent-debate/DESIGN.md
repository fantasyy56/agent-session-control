# 多 Agent 辩论协作工具 — 设计文档

> 记录时间：2026-06-18

---

## 一、项目概述

本地 Web 应用，支持两个 AI Agent 围绕一个议题自动展开多轮辩论。用户可以实时监视、人工介入、暂停/继续/终止，并在辩论结束后生成结构化总结。

---

## 二、技术栈

| 层级 | 技术 |
|------|------|
| 后端运行时 | Node.js 20 + TypeScript |
| Web 框架 | Express 4 |
| 实时通信 | WebSocket（ws 库） |
| AI 调用 | openai SDK（兼容内部 proxy） |
| 前端 | 单页 HTML，Vanilla JS，无框架 |
| 存储 | 本地 JSON 文件（sessions/ 目录） |
| 包管理 | npm |

---

## 三、目录结构

```
multi-agent-debate/
├── src/
│   ├── server.ts          # Express + WebSocket 主服务
│   ├── orchestrator.ts    # 辩论编排器 + session 持久化
│   ├── agents.ts          # Agent 封装（OpenAI 兼容客户端）
│   └── types.ts           # 所有 TypeScript 类型定义
├── public/
│   └── index.html         # 前端单页应用（内联 CSS + JS）
├── sessions/              # 自动创建，历史 session JSON
├── .env                   # 本地环境变量（不提交 git）
├── .env.example           # 环境变量模板
├── package.json
├── tsconfig.json
├── README.md
└── DESIGN.md              # 本文件
```

---

## 四、环境变量（.env）

```env
API_KEY=<内部 API Key>
API_BASE_URL=https://api.together.xyz/v1   # any OpenAI-compatible endpoint
DEFAULT_MODEL=deepseek-v4-pro
PORT=3000
```

- 所有 AI 调用统一走内部 proxy，兼容 OpenAI Chat Completions 格式。
- `DEFAULT_MODEL` 目前仅作备注，前端下拉自行选择模型。

---

## 五、核心类型（src/types.ts）

```typescript
type AgentRole = 'proposer' | 'critic' | 'neutral'

interface AgentConfig {
  id: string
  name: string
  model: string       // 模型名，直接传给 proxy
  role: AgentRole
  systemPrompt: string
}

interface Message {
  agentId: string
  agentName: string
  role: AgentRole
  content: string
  timestamp: number
  tokenUsage?: { input: number; output: number }
}

interface DebateSession {
  id: string
  topic: string
  agents: AgentConfig[]
  messages: Message[]
  status: 'idle' | 'running' | 'paused' | 'finished'
  currentRound: number
  maxRounds: number
  terminationMode: 'rounds' | 'manual'
  createdAt: number
  summary?: string
}
```

---

## 六、Agent 层（src/agents.ts）

- 统一使用 `openai` SDK，通过 `baseURL` 指向内部 proxy。
- `API_KEY` 和 `API_BASE_URL` 从 `.env` 读取，不接受客户端传入。
- 使用 `stream: true` + `stream_options: { include_usage: true }` 实现流式输出并收集 token 用量。
- `onToken` 回调每次收到 delta 时触发，供编排器推送给前端。

```typescript
class Agent {
  constructor(config: AgentConfig)  // 从 env 初始化 OpenAI client
  async call(messages: ChatMessage[], onToken: (t: string) => void): Promise<AgentResponse>
}
```

---

## 七、编排器（src/orchestrator.ts）

### 7.1 对话历史管理

每个 Agent 维护独立的 `ChatMessage[]` 历史（不含 system，system 在 API 调用时单独传入）。

**跨 Agent 消息传递格式：**
```
[提案者（proposer）]: <内容>
```
对方的回复以 `role: 'user'` 追加到本 Agent 历史，形成自然的对话上下文。

### 7.2 辩论流程

```
启动
  └─ 给 Agent A 注入「辩题 + 请开始阐述」作为 user 消息
  └─ 外层循环 round = 1..maxRounds
       └─ 内层循环：遍历 agents 数组（A → B → A → B …）
            ├─ 检查 paused / stopped
            ├─ 注入主持人消息（如有）
            ├─ 将上一个 Agent 的回复追加到当前 Agent 历史
            ├─ 调用 API（流式），逐 token 推送 WS
            ├─ 完成后推送 message 事件，更新 session.messages
            └─ API 失败 → 推送 error，自动暂停，等待 resume/stop 重试
  └─ 每轮结束后 saveSession() 写入 JSON 文件
  └─ 终止后推送最终 session_update
```

### 7.3 控制接口

| 方法 | 说明 |
|------|------|
| `pause()` | 设置 paused=true，编排器在下一次 waitWhilePaused 处阻塞 |
| `resume()` | 设置 paused=false，解除阻塞 |
| `stop()` | 设置 stopped=true，编排器跳出循环 |
| `inject(content)` | 缓存注入内容，下一轮广播给所有 Agent 并展示为主持人消息 |

### 7.4 总结生成

使用 session.agents[0] 的模型（替换 systemPrompt 为分析师角色），将全部对话拼接后请求 AI 生成 Markdown 格式总结，流式推送 `{ type: 'token', agentId: 'summary' }`，完成后推送 `{ type: 'summary', content }`。

---

## 八、WebSocket 事件协议

### 服务端 → 客户端

| 事件 | 说明 |
|------|------|
| `{ type: 'session_update', session }` | session 状态变更（启动/暂停/每轮结束/终止） |
| `{ type: 'token', agentId, token }` | 流式 token（agentId='summary' 时为总结） |
| `{ type: 'message', data: Message }` | 一条完整的 Agent 消息 |
| `{ type: 'summary', content }` | 完整总结文本 |
| `{ type: 'error', message }` | 错误提示 |

### 客户端 → 服务端

| 事件 | 说明 |
|------|------|
| `{ type: 'start', config: StartConfig }` | 启动辩论 |
| `{ type: 'pause' }` | 暂停 |
| `{ type: 'resume' }` | 继续 |
| `{ type: 'stop' }` | 终止 |
| `{ type: 'inject', content }` | 主持人介入 |
| `{ type: 'generate_summary' }` | 生成总结 |
| `{ type: 'load_session', sessionId }` | 加载历史 session |

---

## 九、REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 返回所有历史 session 的摘要列表（按时间倒序） |
| GET | `/api/sessions/:id` | 返回指定 session 的完整 JSON |

---

## 十、前端界面（public/index.html）

### 布局

```
┌──────────────────────────────────────────────────────────────┐
│ 工具栏：议题输入 ｜ 历史Session下拉 ｜ 开始 ｜ 生成总结 ｜ 状态  │
├────────────────┬─────────────────────────┬───────────────────┤
│   Agent A      │       对话流             │    Agent B        │
│  · 名称        │  消息气泡（左=A，右=B）   │   · 名称          │
│  · 模型下拉    │  流式光标动画            │   · 模型下拉       │
│  · 角色        │  ──────────────────────  │   · 角色          │
│  · 系统提示词  │  [主持人介入输入框][注入]  │   · 系统提示词    │
│  · Token 统计  │  [轮数][终止条件]         │   · Token 统计    │
│                │  [暂停][继续][终止]       │                   │
├────────────────┴─────────────────────────┴───────────────────┤
│                   总结区（生成后展示 Markdown）                 │
└──────────────────────────────────────────────────────────────┘
```

### 可选模型（两个 Agent 独立选择）

| 分组 | 模型值 | 显示名 |
|------|--------|--------|
| DeepSeek | `deepseek-v4-pro` | DeepSeek V4 Pro |
| DeepSeek | `deepseek-chat` | DeepSeek V3 (Chat) |
| DeepSeek | `deepseek-reasoner` | DeepSeek R1 (推理) |
| Claude | `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| Claude | `claude-opus-4-7` | Claude Opus 4.7 |
| Claude | `claude-haiku-4-5` | Claude Haiku 4.5 |
| GPT | `gpt-5.5` | GPT-5.5 |
| GPT | `gpt-4o` | GPT-4o |
| GPT | `gpt-4o-mini` | GPT-4o mini |
| GLM | `glm-5.1` | GLM-5.1 |

### 内置系统提示词

**提案方：**
```
你是一名专业的方案提出者。你的任务是：
1. 清晰阐述你的方案和理由
2. 认真对待评判方的批评，区分有效批评和无效批评
3. 对有效批评做出具体修订，更新你的方案
4. 保持立场的一致性，但不固执己见
请始终用中文回复，回复简洁有力，不超过 300 字。
```

**评判方：**
```
你是一名严格的方案评审员。你的任务是：
1. 找出方案中具体的、可操作的缺陷（避免泛泛而谈）
2. 质疑隐含假设和被忽视的风险
3. 提出改进方向，但不替对方设计完整方案
4. 如果方案已经足够好，明确说"基本认可，建议收敛"
请始终用中文回复，回复简洁有力，不超过 300 字。
```

---

## 十一、安全措施

| 风险 | 措施 |
|------|------|
| 路径穿越 | session ID 经 `/[^a-zA-Z0-9_-]/` 过滤后拼接路径 |
| API Key 泄露 | Key 仅从 `.env` 读取，不接受客户端传入，`.env` 不提交 git |
| XSS | 前端消息内容统一经 `escapeHtml()` 处理后再写入 innerHTML |
| 非法 WS 消息 | 所有客户端事件 type 经 switch 严格匹配，未知类型返回 error |

---

## 十二、启动命令

```bash
cd multi-agent-debate
cp .env.example .env   # 填入 API_KEY
npm install
npm run dev            # 开发模式，访问 http://localhost:3000

# 生产构建
npm run build
npm start
```
