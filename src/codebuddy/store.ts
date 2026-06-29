// CodeBuddyStore：扫描 CodeBuddy IDE 本地 Data 目录、建立会话索引、并用 chokidar 实时监听。
//
// CodeBuddy IDE 在本机的存储结构（macOS）：
//   ~/Library/Application Support/CodeBuddyExtension/Data/<userId>/CodeBuddyIDE/<userId>/history/
//     └─ <workspaceId>/
//        ├─ index.json                        // 该工作区的会话列表
//        └─ <conversationId>/
//           ├─ index.json                     // 该会话的消息顺序索引（messages: [{id,role,...}]）
//           └─ messages/<messageId>.json      // 每条消息的完整内容
//
// 工作区与 cwd 的映射来自 CodeBuddyExtension/Logs/CodeBuddyIDE/<date>/<projectName>__<workspaceId>.log 的第 1 行：
//   "Workspace Path: /Users/.../xxx"
//
// 设计原则：保持与 ClaudeStore 一致的接口（baseDir/scan/getProjects/getSession/startWatching/on/off）。

import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import { ClaudeMessage, ContentBlock, ProjectGroup, SessionDetail, SessionMeta } from '../claude/types'

interface ConvIndexEntry {
  id: string
  role: 'user' | 'assistant' | 'tool' | string
  isComplete?: boolean
  type?: string
}
interface ConvIndex {
  messages?: ConvIndexEntry[]
}

interface SessionState {
  workspaceId: string // CodeBuddy 工作区 hash
  conversationId: string // 即 sessionId
  convDir: string // .../history/<workspaceId>/<conversationId>
  meta: SessionMeta
}

export type CodeBuddyStoreEvent =
  | { type: 'session_appended'; sessionId: string; messages: ClaudeMessage[]; meta: SessionMeta }
  | { type: 'session_meta_updated'; meta: SessionMeta }
  | { type: 'session_removed'; sessionId: string }

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  return p
}

// 默认 macOS 路径；用户可通过 CODEBUDDY_DATA_DIR 覆盖到 Data/<userId>/CodeBuddyIDE/<userId> 这一层
const DEFAULT_BASE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'CodeBuddyExtension',
  'Data'
)

const DEFAULT_LOGS_BASE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'CodeBuddyExtension',
  'Logs',
  'CodeBuddyIDE'
)

export class CodeBuddyStore {
  readonly baseDir: string // 实际定位到的 .../CodeBuddyIDE/<userId> 这一层（含 history/ plan-task/ 等）
  readonly historyDir: string // .../CodeBuddyIDE/<userId>/history
  readonly usingSample = false
  private sessions = new Map<string, SessionState>() // sessionId -> state
  private workspaceCwd = new Map<string, string>() // workspaceId -> cwd（从 Logs 推断）
  private listeners = new Set<(e: CodeBuddyStoreEvent) => void>()
  private watcher?: FSWatcher

  constructor() {
    const envBase = process.env.CODEBUDDY_DATA_DIR
    const root = envBase ? expandHome(envBase) : DEFAULT_BASE
    // 自动下钻到 <userId>/CodeBuddyIDE/<userId>，跳过 Public/genie-cache 等非 userId 目录
    let target = ''
    let history = ''
    if (fs.existsSync(root)) {
      // 第一层：取那个含 CodeBuddyIDE 子目录的（一般是 userId）
      for (const d of safeReaddir(root)) {
        const ide = path.join(root, d, 'CodeBuddyIDE')
        if (!fs.existsSync(ide) || !isDir(ide)) continue
        // 第二层：取那个含 history 子目录的（也是 userId）
        for (const u of safeReaddir(ide)) {
          const h = path.join(ide, u, 'history')
          if (fs.existsSync(h) && isDir(h)) {
            target = path.join(ide, u)
            history = h
            break
          }
        }
        if (target) break
      }
    }
    this.baseDir = target
    this.historyDir = history
  }

  on(listener: (e: CodeBuddyStoreEvent) => void): void {
    this.listeners.add(listener)
  }
  off(listener: (e: CodeBuddyStoreEvent) => void): void {
    this.listeners.delete(listener)
  }
  private emit(e: CodeBuddyStoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('[CodeBuddyStore] listener error:', err)
      }
    }
  }

  // 从 Logs 目录推断 workspaceId -> cwd 的映射（依赖 IDE 日志的第 1 行 "Workspace Path: ..."）
  private buildWorkspaceCwdMap(): void {
    this.workspaceCwd.clear()
    if (!fs.existsSync(DEFAULT_LOGS_BASE)) return
    // 遍历最近若干天目录
    const days = safeReaddir(DEFAULT_LOGS_BASE).sort().reverse().slice(0, 30)
    for (const day of days) {
      const dir = path.join(DEFAULT_LOGS_BASE, day)
      for (const f of safeReaddir(dir)) {
        if (!f.endsWith('.log')) continue
        // 文件名格式: <projectName>__<workspaceId>.log
        const m = f.match(/__([0-9a-f]+)\.log$/)
        if (!m) continue
        const wsId = m[1]
        if (this.workspaceCwd.has(wsId)) continue // 已有就跳过，更新的日子先扫
        const full = path.join(dir, f)
        try {
          // 只读前 4KB，找第 1 行 "Workspace Path: ..."
          const fd = fs.openSync(full, 'r')
          const buf = Buffer.alloc(4096)
          fs.readSync(fd, buf, 0, 4096, 0)
          fs.closeSync(fd)
          const head = buf.toString('utf8')
          const m2 = head.match(/Workspace Path:\s*(.+)/)
          if (m2) this.workspaceCwd.set(wsId, m2[1].trim())
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 完整解析一个会话目录，返回归一化后的 messages + meta
  private parseConversation(workspaceId: string, conversationId: string): { messages: ClaudeMessage[]; meta: SessionMeta } | null {
    const convDir = path.join(this.historyDir, workspaceId, conversationId)
    const idxPath = path.join(convDir, 'index.json')
    if (!fs.existsSync(idxPath)) return null

    let idx: ConvIndex = {}
    try {
      idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')) as ConvIndex
    } catch {
      return null
    }
    const entries = Array.isArray(idx.messages) ? idx.messages : []

    const messages: ClaudeMessage[] = []
    let firstTs = 0
    let lastTs = 0

    for (const e of entries) {
      const msgPath = path.join(convDir, 'messages', `${e.id}.json`)
      if (!fs.existsSync(msgPath)) continue
      let rawObj: { role?: string; message?: string; createdAt?: string; extra?: string } = {}
      try {
        rawObj = JSON.parse(fs.readFileSync(msgPath, 'utf8'))
      } catch {
        continue
      }
      const ts = rawObj.createdAt ? Date.parse(rawObj.createdAt) : 0
      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts
        if (ts > lastTs) lastTs = ts
      }
      const blocks = parseMessageBlocks(rawObj.message)
      if (blocks.length === 0) continue

      // role 归一：CodeBuddy 的 'tool' 在我们的统一模型里以 user 形式承载 tool_result（与 Claude CLI 一致）
      const role: 'user' | 'assistant' | 'system' =
        e.role === 'assistant' ? 'assistant' : e.role === 'tool' ? 'user' : 'user'

      let model: string | undefined
      if (rawObj.extra) {
        try {
          const ex = JSON.parse(rawObj.extra) as { modelName?: string; modelId?: string }
          model = ex.modelName || ex.modelId
        } catch {
          /* ignore */
        }
      }

      messages.push({
        uuid: e.id,
        parentUuid: null,
        role,
        timestamp: ts,
        blocks,
        model,
        isMeta: false,
        isSidechain: false,
      })
    }

    // 从工作区索引拿 title
    const wsIdx = this.readWorkspaceIndex(workspaceId)
    const convInfo = wsIdx?.conversations?.find((c) => c.id === conversationId)
    const rawName = convInfo?.name?.trim() || ''
    const title = rawName ? sanitizeTitle(rawName) : deriveTitleFromMessages(messages)

    const cwd = this.workspaceCwd.get(workspaceId) || workspaceId
    const projectDir = path.basename(cwd)

    const meta: SessionMeta = {
      sourceType: 'codebuddy',
      sessionId: conversationId,
      cwd,
      projectDir,
      filePath: convDir,
      title,
      createdAt: firstTs || (convInfo?.createdAt ? Date.parse(convInfo.createdAt) : lastTs),
      lastActiveAt: lastTs || (convInfo?.lastMessageAt ? Date.parse(convInfo.lastMessageAt) : 0),
      messageCount: messages.length,
    }
    return { messages, meta }
  }

  private readWorkspaceIndex(workspaceId: string): { conversations?: Array<{ id: string; name?: string; createdAt?: string; lastMessageAt?: string }> } | null {
    const p = path.join(this.historyDir, workspaceId, 'index.json')
    if (!fs.existsSync(p)) return null
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }

  // 全量扫描
  scan(): void {
    this.sessions.clear()
    if (!this.historyDir || !fs.existsSync(this.historyDir)) return
    this.buildWorkspaceCwdMap()
    const workspaces = safeReaddir(this.historyDir).filter((w) => isDir(path.join(this.historyDir, w)))
    for (const ws of workspaces) {
      const wsDir = path.join(this.historyDir, ws)
      const convs = safeReaddir(wsDir).filter((c) => isDir(path.join(wsDir, c)))
      for (const c of convs) {
        const parsed = this.parseConversation(ws, c)
        if (!parsed) continue
        if (parsed.messages.length === 0) continue // 跳过空会话
        this.sessions.set(c, {
          workspaceId: ws,
          conversationId: c,
          convDir: path.join(wsDir, c),
          meta: parsed.meta,
        })
      }
    }
  }

  getProjects(): ProjectGroup[] {
    const byCwd = new Map<string, ProjectGroup>()
    for (const s of this.sessions.values()) {
      const key = s.meta.cwd || s.meta.projectDir
      let group = byCwd.get(key)
      if (!group) {
        group = { sourceType: 'codebuddy', projectDir: s.meta.projectDir, cwd: key, sessionCount: 0, lastActiveAt: 0, sessions: [] }
        byCwd.set(key, group)
      }
      group.sessions.push(s.meta)
      group.sessionCount++
      if (s.meta.lastActiveAt > group.lastActiveAt) group.lastActiveAt = s.meta.lastActiveAt
    }
    const groups = Array.from(byCwd.values())
    for (const g of groups) g.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    groups.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return groups
  }

  getSession(sessionId: string): SessionDetail | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const parsed = this.parseConversation(s.workspaceId, s.conversationId)
    if (!parsed) return null
    // 同步更新缓存的 meta
    s.meta = parsed.meta
    return { ...parsed.meta, messages: parsed.messages }
  }

  // 文件变动处理：CodeBuddy 写入是「单条消息一个 json」，所以「新增/修改 messages/*.json」=有新消息
  private refreshConversation(workspaceId: string, conversationId: string): void {
    const old = this.sessions.get(conversationId)
    const oldCount = old?.meta.messageCount || 0
    const parsed = this.parseConversation(workspaceId, conversationId)
    if (!parsed) return
    if (parsed.messages.length === 0) return

    if (!old) {
      this.sessions.set(conversationId, {
        workspaceId,
        conversationId,
        convDir: path.join(this.historyDir, workspaceId, conversationId),
        meta: parsed.meta,
      })
      this.emit({ type: 'session_meta_updated', meta: parsed.meta })
      return
    }

    old.meta = parsed.meta
    if (parsed.messages.length > oldCount) {
      // 推送增量
      const fresh = parsed.messages.slice(oldCount)
      this.emit({ type: 'session_appended', sessionId: conversationId, messages: fresh, meta: parsed.meta })
    } else {
      this.emit({ type: 'session_meta_updated', meta: parsed.meta })
    }
  }

  startWatching(): void {
    if (this.watcher) return
    if (!this.historyDir || !fs.existsSync(this.historyDir)) return
    this.watcher = chokidar.watch(this.historyDir, {
      ignoreInitial: true,
      depth: 4, // history/<ws>/<conv>/messages/<id>.json
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 },
    })
    const onChange = (f: string) => {
      const rel = path.relative(this.historyDir, f)
      const parts = rel.split(path.sep)
      if (parts.length < 2) return
      const ws = parts[0]
      const conv = parts[1]
      if (!conv || conv === 'index.json') return
      this.refreshConversation(ws, conv)
    }
    this.watcher.on('add', (f) => onChange(f))
    this.watcher.on('change', (f) => onChange(f))
    this.watcher.on('unlink', (f) => {
      const rel = path.relative(this.historyDir, f)
      const parts = rel.split(path.sep)
      if (parts.length === 3 && parts[2] === 'index.json') {
        // 会话索引被删 → 会话消失
        const conv = parts[1]
        if (this.sessions.has(conv)) {
          this.sessions.delete(conv)
          this.emit({ type: 'session_removed', sessionId: conv })
        }
      }
    })
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = undefined
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────────

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// 把 CodeBuddy 单条消息的 message 字段（嵌套 JSON 字符串）解析为我们统一的 ContentBlock[]
function parseMessageBlocks(messageStr?: string): ContentBlock[] {
  if (!messageStr) return []
  let outer: { role?: string; content?: unknown }
  try {
    outer = JSON.parse(messageStr)
  } catch {
    // 不是 JSON，当纯文本处理
    return messageStr.trim() ? [{ type: 'text', text: messageStr }] : []
  }
  const content = outer.content
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    const t = b.type
    if (t === 'text') {
      const text = String(b.text ?? '')
      if (text) blocks.push({ type: 'text', text })
    } else if (t === 'tool-call') {
      blocks.push({
        type: 'tool_use',
        toolName: String(b.toolName ?? 'unknown'),
        toolInput: b.args ?? b.input ?? {},
        toolUseId: typeof b.toolCallId === 'string' ? b.toolCallId : undefined,
      })
    } else if (t === 'tool-result') {
      blocks.push({
        type: 'tool_result',
        text: flattenToolResult(b.result),
        toolUseId: typeof b.toolCallId === 'string' ? b.toolCallId : undefined,
        isError: b.isError === true,
      })
    } else if (t === 'reasoning' || t === 'thinking') {
      blocks.push({ type: 'thinking', text: String(b.text ?? b.reasoning ?? '') })
    } else if (t === 'image') {
      blocks.push({ type: 'image', text: '[图片]' })
    } else {
      blocks.push({ type: 'unknown', text: typeof t === 'string' ? `[${t}]` : '[未知块]' })
    }
  }
  return blocks
}

function flattenToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result == null) return ''
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function deriveTitleFromMessages(messages: ClaudeMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user' && !m.isMeta) {
      const t = m.blocks.find((b) => b.type === 'text' && b.text && b.text.trim())
      if (t?.text) {
        const s = t.text.trim().replace(/\s+/g, ' ')
        return s.length > 60 ? s.slice(0, 60) + '…' : s
      }
    }
  }
  return '(无标题会话)'
}

function sanitizeTitle(raw: string): string {
  const s = raw.replace(/```/g, '').replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}
