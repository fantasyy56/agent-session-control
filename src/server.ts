// 监视台主服务：Express 静态资源 + REST + WebSocket 实时推送。
// Phase 1 聚焦「只读监视 Claude Code 会话」；辩论模块（orchestrator/agents）保留待 Phase 2 接入。

import 'dotenv/config'
import express from 'express'
import http from 'http'
import path from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { AggregateStore, AggStoreEvent } from './aggregate-store'
import { ClaudeMessage, MonitorClientEvent } from './claude/types'
import { ReviewOrchestrator } from './review/orchestrator'
import { buildContextTranscript } from './review/context'
import { ReviewClientEvent, ReviewServerEvent, ReviewSession } from './review/types'
import { ExportService } from './export/service'
import { ExportFormat, MarkdownVariant } from './export/types'

const PORT = parseInt(process.env.PORT || '3000', 10)
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/

// 评审相关配置（缺省可让流程跑通，模型名等用户在 .env 填）
const DEFAULT_MODEL = process.env.REVIEW_EXECUTOR_MODEL || process.env.DEFAULT_MODEL || process.env.MODEL || 'gpt-4o'
const REVIEW_EXECUTOR_MODEL = DEFAULT_MODEL
const REVIEW_REVIEWER_MODEL = process.env.REVIEW_REVIEWER_MODEL || DEFAULT_MODEL
const REVIEW_MAX_ROUNDS = parseInt(process.env.REVIEW_MAX_ROUNDS || '6', 10)
const REVIEW_CONTEXT_ROUNDS = parseInt(process.env.REVIEW_CONTEXT_ROUNDS || '5', 10)

// 取最后一条 user 消息的纯文本（query 留空时回落用）
function lastUserText(messages: ClaudeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || m.isMeta) continue
    const text = m.blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim()
    if (text) return text
  }
  return ''
}

const app = express()
app.use(express.json())
app.use(express.static(path.join(process.cwd(), 'public')))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// 全局单例：扫描 + 监听
const store = new AggregateStore()
store.scan()
store.startWatching()

// ── REST API ────────────────────────────────────────────────
app.get('/api/meta', (_req, res) => {
  res.json({ baseDir: store.baseDir, usingSample: store.usingSample, sources: store.sources })
})

app.get('/api/projects', (_req, res) => {
  res.json(store.getProjects())
})

app.get('/api/sessions/:id', (req, res) => {
  const id = req.params.id
  if (!SESSION_ID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }
  const session = store.getSession(id)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  res.json(session)
})

// ── 导出 API ─────────────────────────────────────────────────
const exportService = new ExportService()

const ALLOWED_FORMATS: ExportFormat[] = ['json', 'markdown', 'html']
const ALLOWED_VARIANTS: MarkdownVariant[] = ['concise', 'detailed']

app.get('/api/sessions/:id/export', async (req, res) => {
  const id = req.params.id
  if (!SESSION_ID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid session id' })
    return
  }

  const format = (req.query.format as string) || 'json'
  const variant = (req.query.variant as string) || 'detailed'

  if (!ALLOWED_FORMATS.includes(format as ExportFormat)) {
    res.status(400).json({ error: `Invalid format. Allowed: ${ALLOWED_FORMATS.join(', ')}` })
    return
  }
  if (!ALLOWED_VARIANTS.includes(variant as MarkdownVariant)) {
    res.status(400).json({ error: `Invalid variant. Allowed: ${ALLOWED_VARIANTS.join(', ')}` })
    return
  }

  const session = store.getSession(id)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  try {
    const result = await exportService.export(session, {
      format: format as ExportFormat,
      sessionId: id,
      variant: variant as MarkdownVariant,
      includeThinking: true,
      includeMetadata: true,
    })

    res.setHeader('Content-Type', result.mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
    res.setHeader('Content-Length', result.size)
    res.send(result.content)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed'
    res.status(500).json({ error: message })
  }
})

// ── WebSocket：实时推送 ──────────────────────────────────────
wss.on('connection', (ws: WebSocket) => {
  let subscribedSessionId: string | null = null
  let review: ReviewOrchestrator | null = null // 当前连接的评审编排器（单例）
  let reviewRunning = false
  console.log('[WS] Client connected')

  const send = (data: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
  }
  const sendReview = (e: ReviewServerEvent) => send(e)

  // 初始化：推送当前项目/会话列表
  send({
    type: 'init',
    projects: store.getProjects(),
    baseDir: store.baseDir,
    usingSample: store.usingSample,
    sources: store.sources,
  })

  // 监听 store 变化，按订阅情况转发
  const onStoreEvent = (e: AggStoreEvent) => {
    switch (e.type) {
      case 'session_appended':
        // 列表始终更新元信息；正文增量仅推给订阅了该会话的客户端
        if (subscribedSessionId === e.sessionId) {
          send({ type: 'session_appended', sessionId: e.sessionId, messages: e.messages, meta: e.meta })
        } else {
          send({ type: 'session_meta_updated', meta: e.meta })
        }
        break
      case 'session_meta_updated':
        send({ type: 'session_meta_updated', meta: e.meta })
        break
      case 'session_removed':
        send({ type: 'session_removed', sessionId: e.sessionId })
        break
    }
  }
  store.on(onStoreEvent)

  ws.on('message', (raw: Buffer) => {
    let event: MonitorClientEvent | ReviewClientEvent
    try {
      event = JSON.parse(raw.toString()) as MonitorClientEvent | ReviewClientEvent
    } catch {
      send({ type: 'error', message: '无效的消息格式' })
      return
    }

    switch (event.type) {
      case 'open_session': {
        if (!SESSION_ID_RE.test(event.sessionId)) {
          send({ type: 'error', message: '无效的 session id' })
          return
        }
        const session = store.getSession(event.sessionId)
        if (!session) {
          send({ type: 'error', message: `会话不存在: ${event.sessionId}` })
          return
        }
        subscribedSessionId = event.sessionId // 打开即订阅其实时增量
        send({ type: 'session_detail', session })
        break
      }
      case 'subscribe':
        if (SESSION_ID_RE.test(event.sessionId)) subscribedSessionId = event.sessionId
        break
      case 'unsubscribe':
        subscribedSessionId = null
        break
      case 'refresh':
        store.scan()
        send({ type: 'projects', projects: store.getProjects() })
        break

      // ── 评审讨论 ──────────────────────────────────────────
      case 'start_review': {
        if (!SESSION_ID_RE.test(event.sourceSessionId)) {
          sendReview({ type: 'review_error', message: '无效的 session id' })
          return
        }
        const query = (event.query || '').trim()
        const detail = store.getSession(event.sourceSessionId)
        if (!detail) {
          sendReview({ type: 'review_error', message: `会话不存在: ${event.sourceSessionId}` })
          return
        }
        if (review && reviewRunning) {
          sendReview({ type: 'review_error', message: '已有评审进行中，请先停止' })
          return
        }
        const { text, usedRounds } = buildContextTranscript(detail.messages, REVIEW_CONTEXT_ROUNDS)
        // query 留空时回落到最后一条 user 文本
        const effectiveQuery = query || lastUserText(detail.messages) || '（未提供具体问题，请基于上下文给出评审）'
        const reviewSession: ReviewSession = {
          id: uuidv4(),
          sourceSessionId: event.sourceSessionId,
          cwd: detail.cwd,
          query: effectiveQuery,
          contextRounds: usedRounds,
          status: 'running',
          messages: [],
          consensusReached: false,
          createdAt: Date.now(),
          executorModel: REVIEW_EXECUTOR_MODEL,
          reviewerModel: REVIEW_REVIEWER_MODEL,
        }
        review = new ReviewOrchestrator({
          sourceSessionId: event.sourceSessionId,
          cwd: detail.cwd,
          query: effectiveQuery,
          contextTranscript: text,
          contextRounds: usedRounds,
          executorModel: REVIEW_EXECUTOR_MODEL,
          reviewerModel: REVIEW_REVIEWER_MODEL,
          maxRounds: REVIEW_MAX_ROUNDS,
          send: sendReview,
        })
        reviewRunning = true
        review.start(reviewSession).finally(() => { reviewRunning = false })
        break
      }
      case 'review_pause':
        review?.pause()
        break
      case 'review_resume':
        review?.resume()
        break
      case 'review_inject':
        if (typeof event.content === 'string' && event.content.trim()) review?.inject(event.content.trim())
        break
      case 'review_stop':
        review?.stop()
        reviewRunning = false
        break

      default:
        send({ type: 'error', message: '未知的事件类型' })
    }
  })

  ws.on('close', () => {
    console.log('[WS] Client disconnected')
    review?.stop()
    store.off(onStoreEvent)
  })

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message)
    review?.stop()
    store.off(onStoreEvent)
  })
})

server.listen(PORT, () => {
  console.log(`🔭 多源会话监视台运行于 http://localhost:${PORT}`)
  for (const s of store.sources) {
    const tag = s.sourceType === 'claude' ? 'Claude CLI' : 'CodeBuddy IDE'
    const status = s.available ? (s.usingSample ? '内置样例' : '已接入') : '未发现'
    console.log(`   [${tag}] ${status}  ${s.baseDir || '-'}`)
  }
})
