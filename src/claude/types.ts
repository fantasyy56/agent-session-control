// 统一会话数据模型 —— 解析 Claude Code CLI 的 JSONL 会话文件后归一化的结构。
// 设计原则：每个 session 都带上 sessionId + cwd，为后续「反向操作（claude --resume）」预留钩子。

export type BlockType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'image'
  | 'unknown'

export interface ContentBlock {
  type: BlockType
  text?: string // text / thinking 的文本，tool_result 的文本输出
  toolName?: string // tool_use 的工具名
  toolInput?: unknown // tool_use 的输入参数
  toolUseId?: string // tool_use / tool_result 关联 id
  isError?: boolean // tool_result 是否报错
}

export interface ClaudeMessage {
  uuid: string
  parentUuid: string | null
  role: 'user' | 'assistant' | 'system'
  timestamp: number // epoch ms
  blocks: ContentBlock[]
  model?: string // assistant 消息所用模型
  usage?: { input: number; output: number }
  isMeta?: boolean // Claude Code 注入的元信息消息
  isSidechain?: boolean // 子 agent / sidechain 消息
}

// 数据源类型：区分会话来自 Claude Code CLI / CodeBuddy IDE / WorkBuddy CLI / Cursor
export type SourceType = 'claude' | 'codebuddy' | 'workbuddy' | 'cursor'

// 会话元信息（列表展示用，不含完整消息体）
export interface SessionMeta {
  sourceType: SourceType // 数据源
  sessionId: string
  cwd: string
  projectDir: string // 源目录下表示项目的目录名（编码后的 cwd）
  filePath: string
  title: string        // 展示用标题：优先 customTitle，其次 summary，最后首条消息派生
  customTitle?: string // Claude Code CLI 用户手动命名（type=custom-title 行）
  createdAt: number
  lastActiveAt: number
  messageCount: number
  gitBranch?: string
}

// 会话详情（含完整消息）
export interface SessionDetail extends SessionMeta {
  messages: ClaudeMessage[]
}

// 按项目（cwd）分组
export interface ProjectGroup {
  sourceType: SourceType
  projectDir: string
  cwd: string
  sessionCount: number
  lastActiveAt: number
  sessions: SessionMeta[]
}

// ── WebSocket 事件协议 ──────────────────────────────────────────

// 服务端 → 客户端
export type MonitorServerEvent =
  | { type: 'init'; projects: ProjectGroup[]; baseDir: string; usingSample: boolean }
  | { type: 'projects'; projects: ProjectGroup[] }
  | { type: 'session_detail'; session: SessionDetail }
  | { type: 'session_meta_updated'; meta: SessionMeta }
  | { type: 'session_appended'; sessionId: string; messages: ClaudeMessage[]; meta: SessionMeta }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'error'; message: string }

// 客户端 → 服务端
export type MonitorClientEvent =
  | { type: 'subscribe'; sessionId: string } // 订阅某会话的实时增量
  | { type: 'unsubscribe' }
  | { type: 'open_session'; sessionId: string } // 请求完整会话详情
  | { type: 'refresh' } // 手动刷新会话列表
