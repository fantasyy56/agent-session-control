export type AgentRole = 'executor' | 'reviewer'

export const CONSENSUS_TAG = '[[CONSENSUS_REACHED]]'

export interface AgentConfig {
  id: string
  name: string
  model: string
  role: AgentRole
  systemPrompt: string
}

export interface Message {
  agentId: string
  agentName: string
  role: AgentRole
  content: string
  timestamp: number
  round: number
  consensusSignal?: boolean          // true if this message contains [[CONSENSUS_REACHED]]
  tokenUsage?: { input: number; output: number }
}

export interface DebateSession {
  id: string
  topic: string
  agents: AgentConfig[]
  messages: Message[]
  status: 'idle' | 'running' | 'paused' | 'finished'
  currentRound: number
  maxRounds: number
  terminationMode: 'consensus' | 'rounds' | 'manual'
  consensusReached: boolean
  createdAt: number
  summary?: string
}

// Internal chat message format for API calls
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResponse {
  content: string
  tokenUsage?: { input: number; output: number }
}

// WebSocket event types (server → client)
export type ServerEvent =
  | { type: 'session_update'; session: DebateSession }
  | { type: 'token'; agentId: string; token: string }
  | { type: 'message'; data: Message }
  | { type: 'consensus_reached'; triggerAgentName: string; round: number }
  | { type: 'summary'; content: string }
  | { type: 'error'; message: string }

// WebSocket event types (client → server)
export interface StartConfig {
  topic: string
  agents: AgentConfig[]
  maxRounds: number
  terminationMode: 'consensus' | 'rounds' | 'manual'
}

export type ClientEvent =
  | { type: 'start'; config: StartConfig }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'inject'; content: string }
  | { type: 'stop' }
  | { type: 'generate_summary' }
  | { type: 'load_session'; sessionId: string }
