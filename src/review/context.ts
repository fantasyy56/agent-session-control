// 把源 Claude 会话的「近 N 轮」转写为纯文本，作为执行方的上下文。
// 一「轮」≈ 一条 user 消息及其之后的 assistant 回应；取最后 N 轮，控制 token 与聚焦度。

import { ClaudeMessage } from '../claude/types'

function blocksToText(m: ClaudeMessage): string {
  const parts: string[] = []
  for (const b of m.blocks) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'thinking' && b.text) parts.push(`(思考) ${b.text}`)
    else if (b.type === 'tool_use') parts.push(`(调用工具 ${b.toolName || ''})`)
    else if (b.type === 'tool_result') parts.push(`(工具输出${b.isError ? '·错误' : ''})`)
    else if (b.type === 'image') parts.push('(图片)')
  }
  return parts.join('\n').trim()
}

// 取最后 rounds 个 user 起始的片段
export function buildContextTranscript(messages: ClaudeMessage[], rounds: number): { text: string; usedRounds: number } {
  // 过滤掉无文本的元信息噪声
  const usable = messages.filter((m) => !m.isMeta)

  // 找到所有 user 消息的下标
  const userIdx: number[] = []
  usable.forEach((m, i) => { if (m.role === 'user') userIdx.push(i) })

  let startIdx = 0
  let usedRounds = userIdx.length
  if (userIdx.length > rounds) {
    startIdx = userIdx[userIdx.length - rounds]
    usedRounds = rounds
  }

  const slice = usable.slice(startIdx)
  const lines: string[] = []
  for (const m of slice) {
    const text = blocksToText(m)
    if (!text) continue
    const who = m.role === 'assistant' ? 'Claude' : m.role === 'user' ? '用户' : '系统'
    lines.push(`【${who}】${text}`)
  }
  // 防御性截断，避免超长上下文（保留尾部最相关内容）
  const MAX_CHARS = 12000
  let text = lines.join('\n\n')
  if (text.length > MAX_CHARS) {
    text = '…（已截断较早内容）…\n\n' + text.slice(text.length - MAX_CHARS)
  }
  return { text, usedRounds }
}
