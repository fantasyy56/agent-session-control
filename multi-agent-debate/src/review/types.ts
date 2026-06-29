// Phase 2：在被监视的 Claude 会话上叠加「双模型评审讨论」的数据模型与 WS 协议。
//
// 非对称设计（已与用户对齐）：
//   - 执行方（executor）：持有源会话「近 N 轮」上下文 + 用户当前 query，
//     首轮撰写自包含的「开场简报」，后续回应评审意见，收敛后产出最终结论。
//   - 评审方（reviewer）：使用异构模型，全程只看简报与往返讨论，看不到原始会话。
//   - 评审完成后由执行方自动产出「结论」，仅在监视台 UI 展示（不回写 Claude .jsonl）。

export type ReviewRole = 'executor' | 'reviewer' | 'conclusion' | 'moderator'

export interface ReviewMessage {
  id: string
  role: ReviewRole
  content: string
  round: number
  timestamp: number
  model?: string
  consensusSignal?: boolean
}

export type ReviewStatus = 'running' | 'paused' | 'finished' | 'stopped' | 'error'

export interface ReviewSession {
  id: string
  sourceSessionId: string
  cwd: string
  query: string // 用户在发起时输入的「当前想讨论的问题」
  contextRounds: number // 实际纳入上下文的源会话轮数
  status: ReviewStatus
  messages: ReviewMessage[]
  conclusion?: string
  consensusReached: boolean
  createdAt: number
  executorModel: string
  reviewerModel: string
}

// 列表展示用的轻量元信息
export interface ReviewSessionMeta {
  id: string
  sourceSessionId: string
  query: string
  status: ReviewStatus
  consensusReached: boolean
  createdAt: number
}

// ── WebSocket 事件协议 ──────────────────────────────────────────

// 服务端 → 客户端（评审相关，与 Phase 1 的 MonitorServerEvent 并存）
export type ReviewServerEvent =
  | { type: 'review_started'; review: ReviewSession }
  | { type: 'review_token'; role: ReviewRole; round: number; token: string }
  | { type: 'review_message'; message: ReviewMessage }
  | { type: 'review_status'; status: ReviewStatus; round: number }
  | { type: 'review_conclusion'; content: string }
  | { type: 'review_error'; message: string }

// 客户端 → 服务端
export type ReviewClientEvent =
  | { type: 'start_review'; sourceSessionId: string; query: string }
  | { type: 'review_pause' }
  | { type: 'review_resume' }
  | { type: 'review_inject'; content: string }
  | { type: 'review_stop' }
