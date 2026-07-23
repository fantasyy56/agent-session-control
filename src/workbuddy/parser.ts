// WorkBuddy JSONL 行解析器（纯函数，无副作用）。
// WorkBuddy 是 Claude Code 的 Codex / OpenAI-Responses 风格衍生版，会话存为
//   ~/.workbuddy/projects/<编码cwd>/<sessionId>.jsonl
// 每行一个 JSON 事件，常见 type：
//   message                 —— 用户/助手文本（content 块：input_text / output_text）
//   reasoning               —— 模型思考（rawContent 块：reasoning_text）
//   function_call           —— 工具调用（顶层 name / arguments / callId）
//   function_call_result    —— 工具结果（顶层 name / callId / output）
//   summary                 —— 首条用户消息摘要
//   ai-title                —— AI 生成的会话标题（优先级最高）
//   file-history-snapshot   —— 文件快照（忽略）

import { ClaudeMessage, ContentBlock } from '../claude/types'

export interface ParsedLine {
  message?: ClaudeMessage
  summary?: string // type=summary（首条用户消息摘要）
  aiTitle?: string // type=ai-title（AI 生成标题，优先级最高）
  cwd?: string
  sessionId?: string
  timestamp?: number
}

function toEpochMs(ts: unknown): number {
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    if (!Number.isNaN(n)) return n
  }
  return 0
}

// 把 content / output / rawContent 数组（块可能含 text 字段）拍平为纯文本
function flattenText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

// message 行的 content 块 → 统一的 ContentBlock[]
function parseMessageContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    switch (b.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        blocks.push({ type: 'text', text: String(b.text ?? '') })
        break
      case 'input_image':
      case 'output_image':
      case 'image':
        blocks.push({ type: 'image', text: '[图片]' })
        break
      default:
        // 兜底：只要带 text 字段就当文本，否则忽略
        if (typeof b.text === 'string' && b.text) blocks.push({ type: 'text', text: b.text })
    }
  }
  return blocks
}

// WorkBuddy 的 token 用量落在顶层 message.usage = { input_tokens, output_tokens, total_tokens }
function usageOf(obj: Record<string, unknown>): { input: number; output: number } | undefined {
  const msg = obj.message as Record<string, unknown> | undefined
  const u = msg?.usage as Record<string, unknown> | undefined
  if (!u) return undefined
  return {
    input: Number(u.input_tokens ?? 0) || 0,
    output: Number(u.output_tokens ?? 0) || 0,
  }
}

// 解析单行 JSONL。无法解析或非关注类型返回 {}（仅可能携带元信息）。
export function parseLine(raw: string): ParsedLine {
  const line = raw.trim()
  if (!line) return {}
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return {} // 跳过损坏行
  }

  const type = obj.type
  const cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
  const timestamp = toEpochMs(obj.timestamp)
  const uuid = typeof obj.id === 'string' ? obj.id : `${timestamp}-${Math.random().toString(36).slice(2, 8)}`
  const parentUuid = typeof obj.parentId === 'string' ? obj.parentId : null

  // ── 标题类 ──
  if (type === 'ai-title') {
    return { aiTitle: typeof obj.aiTitle === 'string' ? obj.aiTitle : undefined, sessionId, timestamp }
  }
  if (type === 'summary') {
    return { summary: typeof obj.summary === 'string' ? obj.summary : undefined }
  }

  // ── 用户/助手文本消息 ──
  if (type === 'message') {
    const role: 'user' | 'assistant' = obj.role === 'assistant' ? 'assistant' : 'user'
    const blocks = parseMessageContent(obj.content)
    if (blocks.length === 0) return { cwd, sessionId, timestamp }
    const message: ClaudeMessage = {
      uuid,
      parentUuid,
      role,
      timestamp,
      blocks,
      usage: usageOf(obj),
      isMeta: false,
      isSidechain: false,
    }
    return { message, cwd, sessionId, timestamp }
  }

  // ── 思考（reasoning）→ thinking，归到 assistant ──
  if (type === 'reasoning') {
    const text = flattenText(obj.rawContent) || flattenText(obj.content)
    if (!text.trim()) return { cwd, sessionId, timestamp }
    const message: ClaudeMessage = {
      uuid,
      parentUuid,
      role: 'assistant',
      timestamp,
      blocks: [{ type: 'thinking', text }],
      isMeta: false,
      isSidechain: false,
    }
    return { message, cwd, sessionId, timestamp }
  }

  // ── 工具调用（function_call）→ tool_use，归到 assistant ──
  if (type === 'function_call') {
    const toolName = typeof obj.name === 'string' ? obj.name : 'unknown'
    let toolInput: unknown = obj.arguments
    if (typeof obj.arguments === 'string') {
      try {
        toolInput = JSON.parse(obj.arguments)
      } catch {
        toolInput = obj.arguments // 参数不是合法 JSON 就保留原字符串
      }
    }
    const message: ClaudeMessage = {
      uuid,
      parentUuid,
      role: 'assistant',
      timestamp,
      blocks: [
        {
          type: 'tool_use',
          toolName,
          toolInput,
          toolUseId: typeof obj.callId === 'string' ? obj.callId : undefined,
        },
      ],
      usage: usageOf(obj),
      isMeta: false,
      isSidechain: false,
    }
    return { message, cwd, sessionId, timestamp }
  }

  // ── 工具结果（function_call_result）→ tool_result，归到 user（与 Claude CLI 一致） ──
  if (type === 'function_call_result') {
    const status = typeof obj.status === 'string' ? obj.status : ''
    const message: ClaudeMessage = {
      uuid,
      parentUuid,
      role: 'user',
      timestamp,
      blocks: [
        {
          type: 'tool_result',
          text: flattenText(obj.output),
          toolUseId: typeof obj.callId === 'string' ? obj.callId : undefined,
          isError: status === 'error' || status === 'failed',
        },
      ],
      isMeta: false,
      isSidechain: false,
    }
    return { message, cwd, sessionId, timestamp }
  }

  // file-history-snapshot 等其它类型：仅可能携带元信息
  return { cwd, sessionId, timestamp }
}

// 从首条用户文本消息派生标题（当没有 ai-title / summary 时的兜底）。
export function deriveTitleFromMessages(messages: ClaudeMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user' && !m.isMeta) {
      const textBlock = m.blocks.find((b) => b.type === 'text' && b.text && b.text.trim())
      if (textBlock?.text) {
        const t = textBlock.text.trim().replace(/\s+/g, ' ')
        return t.length > 60 ? t.slice(0, 60) + '…' : t
      }
    }
  }
  return '(无标题会话)'
}
