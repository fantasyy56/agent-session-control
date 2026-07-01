// Markdown 格式化器 - 生成可读性强的会话文档

import { SessionDetail, ClaudeMessage, ContentBlock } from '../../claude/types'
import { MarkdownVariant } from '../types'

interface MarkdownOptions {
  variant: MarkdownVariant
  includeThinking: boolean
  includeMetadata: boolean
}

/**
 * 将会话转换为 Markdown 格式
 */
export function formatMarkdown(session: SessionDetail, options: MarkdownOptions): string {
  const { variant, includeThinking, includeMetadata } = options
  const lines: string[] = []

  // ── 文件头 ───────────────────────────────────────────────
  lines.push(`# ${escapeMarkdown(session.title)}`)
  lines.push('')

  // 元信息块
  const source = session.sourceType === 'claude' ? 'Claude CLI' : 'CodeBuddy IDE'
  const created = formatDate(session.createdAt)
  const lastActive = formatDate(session.lastActiveAt)
  const nonMetaMessages = session.messages.filter(m => !m.isMeta)

  lines.push(`> **Source**: ${source}  `)
  lines.push(`> **Created**: ${created}  `)
  lines.push(`> **Last Active**: ${lastActive}  `)
  if (session.cwd) {
    lines.push(`> **Working Directory**: \`${session.cwd}\`  `)
  }
  if (session.gitBranch) {
    lines.push(`> **Git Branch**: \`${session.gitBranch}\`  `)
  }
  lines.push(`> **Messages**: ${nonMetaMessages.length}  `)
  if (includeMetadata) {
    const { inputTokens, outputTokens } = sumTokens(session.messages)
    if (inputTokens + outputTokens > 0) {
      lines.push(`> **Tokens**: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out  `)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  // ── 消息正文 ─────────────────────────────────────────────
  if (variant === 'concise') {
    renderConcise(session.messages, lines, includeThinking, includeMetadata)
  } else {
    renderDetailed(session.messages, lines, includeThinking, includeMetadata)
  }

  // ── 页脚 ─────────────────────────────────────────────────
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`*Exported by [agent-session-control](https://github.com/your-username/agent-session-control) on ${new Date().toISOString()}*`)

  return lines.join('\n')
}

// ── 简洁版渲染 ─────────────────────────────────────────────────────────────────

function renderConcise(
  messages: ClaudeMessage[],
  lines: string[],
  includeThinking: boolean,
  includeMetadata: boolean
): void {
  for (const msg of messages) {
    if (msg.isMeta) continue

    const role = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` *(${msg.model})*` : ''}`
    lines.push(`## ${role}`)
    lines.push('')

    if (includeMetadata && msg.timestamp) {
      lines.push(`*${formatDate(msg.timestamp)}*`)
      lines.push('')
    }

    // 收集工具调用，批量压缩为一行
    const toolCalls: string[] = []
    for (const block of msg.blocks) {
      switch (block.type) {
        case 'text':
          if (toolCalls.length > 0) {
            lines.push(`> 🔧 *${toolCalls.join(' · ')}*`)
            lines.push('')
            toolCalls.length = 0
          }
          if (block.text?.trim()) {
            lines.push(block.text.trim())
            lines.push('')
          }
          break

        case 'thinking':
          if (includeThinking && block.text?.trim()) {
            const preview = truncate(block.text.trim(), 80)
            lines.push(`> 💭 *${preview}*`)
            lines.push('')
          }
          break

        case 'tool_use':
          if (block.toolName) {
            toolCalls.push(block.toolName)
          }
          break

        case 'tool_result':
          // 简洁版不展示工具结果
          break

        case 'image':
          lines.push('> 📷 *[image]*')
          lines.push('')
          break
      }
    }

    // 收尾剩余工具调用
    if (toolCalls.length > 0) {
      lines.push(`> 🔧 *${toolCalls.join(' · ')}*`)
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }
}

// ── 详细版渲染 ─────────────────────────────────────────────────────────────────

function renderDetailed(
  messages: ClaudeMessage[],
  lines: string[],
  includeThinking: boolean,
  includeMetadata: boolean
): void {
  for (const msg of messages) {
    if (msg.isMeta) continue

    const role = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` *(${msg.model})*` : ''}`
    lines.push(`## ${role}`)
    lines.push('')

    // 元信息行
    if (includeMetadata) {
      const meta: string[] = []
      if (msg.timestamp) meta.push(`🕐 ${formatDate(msg.timestamp)}`)
      if (msg.usage && (msg.usage.input + msg.usage.output) > 0) {
        meta.push(`💬 ${msg.usage.input.toLocaleString()} in / ${msg.usage.output.toLocaleString()} out tokens`)
      }
      if (msg.isSidechain) meta.push(`🔗 sidechain`)
      if (meta.length > 0) {
        lines.push(`*${meta.join(' · ')}*`)
        lines.push('')
      }
    }

    // 按块类型逐一渲染
    for (const block of msg.blocks) {
      renderBlock(block, lines, includeThinking)
    }

    lines.push('---')
    lines.push('')
  }
}

function renderBlock(block: ContentBlock, lines: string[], includeThinking: boolean): void {
  switch (block.type) {
    case 'text':
      if (block.text?.trim()) {
        lines.push(block.text.trim())
        lines.push('')
      }
      break

    case 'thinking':
      if (includeThinking && block.text?.trim()) {
        lines.push('<details>')
        lines.push(`<summary>💭 Thinking</summary>`)
        lines.push('')
        lines.push(block.text.trim())
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }
      break

    case 'tool_use': {
      const toolName = block.toolName || 'unknown'
      lines.push(`### 🔧 Tool: \`${toolName}\``)
      lines.push('')
      if (block.toolInput != null) {
        const inputStr = formatToolInput(block.toolInput)
        if (inputStr.trim()) {
          const lang = guessLang(toolName, block.toolInput)
          lines.push(`\`\`\`${lang}`)
          lines.push(inputStr)
          lines.push('```')
          lines.push('')
        }
      }
      break
    }

    case 'tool_result': {
      const isError = block.isError === true
      const icon = isError ? '❌' : '✅'
      lines.push(`### ${icon} Result`)
      lines.push('')
      if (block.text?.trim()) {
        // 截断超长输出
        const output = truncateOutput(block.text.trim())
        lines.push('```')
        lines.push(output)
        lines.push('```')
        lines.push('')
      } else if (!isError) {
        lines.push('*(no output)*')
        lines.push('')
      }
      break
    }

    case 'image':
      lines.push('> 📷 *[image attachment]*')
      lines.push('')
      break

    case 'unknown':
      // 跳过
      break
  }
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function escapeMarkdown(text: string): string {
  // 仅转义标题级别干扰字符
  return text.replace(/[`*_[\]]/g, '\\$&')
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

/** 截断工具输出超长内容（默认 3000 字符） */
function truncateOutput(text: string, maxLen = 3000): string {
  if (text.length <= maxLen) return text
  const kept = text.slice(0, maxLen)
  const omitted = text.length - maxLen
  return `${kept}\n\n... (${omitted} characters omitted)`
}

function sumTokens(messages: ClaudeMessage[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0
  let outputTokens = 0
  for (const m of messages) {
    if (m.usage) {
      inputTokens += m.usage.input
      outputTokens += m.usage.output
    }
  }
  return { inputTokens, outputTokens }
}

/**
 * 根据工具名和输入内容推断代码块语言标识
 */
function guessLang(toolName: string, input: unknown): string {
  const name = toolName.toLowerCase()
  if (name === 'bash' || name === 'run_command' || name === 'execute') return 'bash'
  if (name.includes('write') || name.includes('create')) {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>
      const file = (obj['file_path'] ?? obj['path'] ?? '') as string
      if (file.endsWith('.ts') || file.endsWith('.tsx')) return 'typescript'
      if (file.endsWith('.js') || file.endsWith('.jsx')) return 'javascript'
      if (file.endsWith('.py')) return 'python'
      if (file.endsWith('.json')) return 'json'
      if (file.endsWith('.md')) return 'markdown'
      if (file.endsWith('.sh')) return 'bash'
      if (file.endsWith('.css')) return 'css'
      if (file.endsWith('.html')) return 'html'
      if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'yaml'
    }
  }
  if (name.includes('sql') || name.includes('query')) return 'sql'
  if (name.includes('json')) return 'json'
  return 'text'
}

/**
 * 格式化工具输入为可读文本
 */
function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>
    // 常见字段优先展示
    const PRIORITY_KEYS = ['command', 'cmd', 'content', 'code', 'query', 'file_path', 'path', 'input']
    for (const key of PRIORITY_KEYS) {
      if (key in obj && typeof obj[key] === 'string') {
        const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
        const restStr = Object.keys(rest).length > 0
          ? `\n// ${JSON.stringify(rest, null, 2).slice(1, -1).trim()}`
          : ''
        return `${obj[key]}${restStr}`
      }
    }
    return JSON.stringify(input, null, 2)
  }
  return String(input)
}
