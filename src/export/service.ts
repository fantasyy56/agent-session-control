// 导出服务协调器

import { SessionDetail } from '../claude/types'
import { ExportOptions, ExportResult } from './types'
import { formatJSON } from './formatters/json'
import { formatMarkdown } from './formatters/markdown'

const TOOL_VERSION = '1.0.0'

export class ExportService {
  /**
   * 根据指定格式导出会话
   */
  async export(session: SessionDetail, options: ExportOptions): Promise<ExportResult> {
    const { format } = options

    switch (format) {
      case 'json':
        return this.exportJSON(session)
      case 'markdown':
        return this.exportMarkdown(session, options)
      case 'html':
        throw new Error('HTML export not yet implemented (Phase 2)')
      default:
        throw new Error(`Unknown export format: ${format}`)
    }
  }

  private exportJSON(session: SessionDetail): ExportResult {
    const content = formatJSON(session)
    const filename = this.generateFilename(session.sessionId, 'json')

    return {
      content,
      mimeType: 'application/json',
      filename,
      size: Buffer.byteLength(content, 'utf-8')
    }
  }

  private exportMarkdown(session: SessionDetail, options: ExportOptions): ExportResult {
    const variant = options.variant || 'detailed'
    const includeThinking = options.includeThinking !== false
    const includeMetadata = options.includeMetadata !== false

    const content = formatMarkdown(session, {
      variant,
      includeThinking,
      includeMetadata
    })

    const filename = this.generateFilename(session.sessionId, 'md')

    return {
      content,
      mimeType: 'text/markdown',
      filename,
      size: Buffer.byteLength(content, 'utf-8')
    }
  }

  /**
   * 生成标准化文件名：session-{sessionId}-{timestamp}.{ext}
   */
  private generateFilename(sessionId: string, ext: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, -5)
    return `session-${sessionId}-${timestamp}.${ext}`
  }
}
