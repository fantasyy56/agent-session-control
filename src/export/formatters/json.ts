// JSON 格式化器 - 保留完整的会话数据结构

import { SessionDetail, ClaudeMessage } from '../../claude/types'

interface JSONExport {
  export: {
    version: string
    exportedAt: string
    tool: string
    toolVersion: string
  }
  session: {
    sessionId: string
    sourceType: string
    cwd: string
    projectDir: string
    title: string
    customTitle?: string | null
    createdAt: number
    lastActiveAt: number
    messageCount: number
    gitBranch?: string
    filePath: string
  }
  messages: ClaudeMessage[]
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    toolCallCount: Record<string, number>
    messagesByRole: Record<string, number>
  }
}

/**
 * 将会话转换为 JSON 格式
 * 保留所有元数据以支持后续导入和分析
 */
export function formatJSON(session: SessionDetail): string {
  const stats = calculateStats(session.messages)

  const jsonExport: JSONExport = {
    export: {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      tool: 'agent-session-control',
      toolVersion: '1.0.0'
    },
    session: {
      sessionId: session.sessionId,
      sourceType: session.sourceType,
      cwd: session.cwd,
      projectDir: session.projectDir,
      title: session.title,
      customTitle: session.customTitle,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messageCount: session.messageCount,
      gitBranch: session.gitBranch,
      filePath: session.filePath
    },
    messages: session.messages,
    stats
  }

  return JSON.stringify(jsonExport, null, 2)
}

/**
 * 计算会话统计信息
 */
function calculateStats(messages: ClaudeMessage[]) {
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const toolCallCount: Record<string, number> = {}
  const messagesByRole: Record<string, number> = {}

  for (const msg of messages) {
    // 统计角色分布
    messagesByRole[msg.role] = (messagesByRole[msg.role] || 0) + 1

    // 统计 token
    if (msg.usage) {
      totalInputTokens += msg.usage.input
      totalOutputTokens += msg.usage.output
    }

    // 统计工具调用
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && block.toolName) {
        toolCallCount[block.toolName] = (toolCallCount[block.toolName] || 0) + 1
      }
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    toolCallCount,
    messagesByRole
  }
}
