// 导出功能的类型定义

export type ExportFormat = 'json' | 'markdown' | 'html'
export type MarkdownVariant = 'concise' | 'detailed'

export interface ExportOptions {
  format: ExportFormat
  sessionId: string
  variant?: MarkdownVariant
  includeThinking?: boolean
  includeMetadata?: boolean
}

export interface ExportResult {
  content: string | Buffer
  mimeType: string
  filename: string
  size: number
}

export interface ExportMetadata {
  version: string
  exportedAt: string
  tool: string
  toolVersion: string
}
