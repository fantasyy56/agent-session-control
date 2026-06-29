// Claude Code JSONL 行解析器（纯函数，无副作用）。
// Claude Code 把每个会话存为 ~/.claude/projects/<编码cwd>/<sessionId>.jsonl，
// 每行一个 JSON 事件，常见 type：summary / user / assistant / system / file-history-snapshot。

import { ClaudeMessage, ContentBlock } from './types'

// 原始行解析结果：可能是一条消息、一个 summary（用作标题）、或可忽略的元信息行。
export interface ParsedLine {
  message?: ClaudeMessage
  summary?: string      // type=summary 时的 AI 生成标题
  customTitle?: string  // type=custom-title 时用户手动命名
  cwd?: string
  gitBranch?: string
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

// 把 tool_result 的 content（可能是字符串或块数组）拍平成文本。
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object') {
          const obj = c as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function parseContentBlocks(content: unknown): ContentBlock[] {
  // 用户纯文本消息：content 直接是字符串
  if (typeof content === 'string') {
    return content.length ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    switch (b.type) {
      case 'text':
        blocks.push({ type: 'text', text: String(b.text ?? '') })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: String(b.thinking ?? b.text ?? '') })
        break
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          toolName: String(b.name ?? 'unknown'),
          toolInput: b.input,
          toolUseId: typeof b.id === 'string' ? b.id : undefined,
        })
        break
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          text: flattenToolResultContent(b.content),
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
          isError: b.is_error === true,
        })
        break
      case 'image':
        blocks.push({ type: 'image', text: '[图片]' })
        break
      default:
        blocks.push({ type: 'unknown', text: typeof b.type === 'string' ? `[${b.type}]` : '[未知块]' })
    }
  }
  return blocks
}

// 解析单行 JSONL。无法解析或非关注类型返回 {}。
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
  const gitBranch = typeof obj.gitBranch === 'string' ? obj.gitBranch : undefined
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
  const timestamp = toEpochMs(obj.timestamp)

  if (type === 'summary') {
    return { summary: typeof obj.summary === 'string' ? obj.summary : undefined }
  }

  if (type === 'custom-title') {
    return { customTitle: typeof obj.customTitle === 'string' ? obj.customTitle : undefined }
  }

  if (type === 'user' || type === 'assistant' || type === 'system') {
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg && type !== 'system') return { cwd, gitBranch, sessionId, timestamp }

    const blocks = msg ? parseContentBlocks(msg.content) : []
    // 跳过完全空的消息（例如纯元信息行）
    if (blocks.length === 0 && type !== 'system') {
      return { cwd, gitBranch, sessionId, timestamp }
    }

    let usage: { input: number; output: number } | undefined
    const rawUsage = msg?.usage as Record<string, unknown> | undefined
    if (rawUsage) {
      usage = {
        input: Number(rawUsage.input_tokens ?? 0) || 0,
        output: Number(rawUsage.output_tokens ?? 0) || 0,
      }
    }

    const message: ClaudeMessage = {
      uuid: typeof obj.uuid === 'string' ? obj.uuid : `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      parentUuid: typeof obj.parentUuid === 'string' ? obj.parentUuid : null,
      role: type as 'user' | 'assistant' | 'system',
      timestamp,
      blocks,
      model: typeof msg?.model === 'string' ? (msg.model as string) : undefined,
      usage,
      isMeta: obj.isMeta === true,
      isSidechain: obj.isSidechain === true,
    }
    return { message, cwd, gitBranch, sessionId, timestamp }
  }

  // file-history-snapshot 等其它类型：仅可能携带元信息
  return { cwd, gitBranch, sessionId, timestamp }
}

// 从首条用户文本消息派生一个标题（当没有 summary 时）。
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
