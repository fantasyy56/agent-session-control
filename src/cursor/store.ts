// CursorStore：读取 Cursor（基于 VSCode 的 AI IDE）的会话数据并归一化到统一模型。
//
// Cursor 与前几个源的根本差异：会话存在 SQLite（state.vscdb）而非 jsonl 文件。
// macOS 存储结构：
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//     └─ 表 cursorDiskKV（key,value）:
//        - 'composerData:<composerId>'          // 会话元信息 + 消息顺序（fullConversationHeadersOnly）
//        - 'bubbleId:<composerId>:<bubbleId>'    // 单条消息气泡（type 1=user / 2=assistant）
//
// 工作区路径：直接来自 composerData.workspaceIdentifier.uri.fsPath（无需遍历 workspaceStorage）。
//
// 避锁策略：Cursor 的 state.vscdb 是正在写入的活动库（WAL 模式）。为避免 SQLITE_BUSY，
// 每次读取都把 db + -wal + -shm 复制为临时快照，在副本上查询（副本可读写以自动应用 WAL），用完删除。
//
// 设计原则：保持与其它 Store 一致的接口（baseDir/scan/getProjects/getSession/startWatching/on/off）。

import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import Database from 'better-sqlite3'
import { ClaudeMessage, ContentBlock, ProjectGroup, SessionDetail, SessionMeta } from '../claude/types'

interface SessionState {
  composerId: string // 即 sessionId
  meta: SessionMeta
  messages: ClaudeMessage[] // 全量缓存（会话/消息量小，便于增量对比）
}

export type CursorStoreEvent =
  | { type: 'session_appended'; sessionId: string; messages: ClaudeMessage[]; meta: SessionMeta }
  | { type: 'session_meta_updated'; meta: SessionMeta }
  | { type: 'session_removed'; sessionId: string }

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  return p
}

const DEFAULT_GLOBAL_STORAGE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage'
)

const NO_WORKSPACE = '(未关联工作区)'

type BubbleRow = { value: string }
type BubbleStmt = { get(key: string): BubbleRow | undefined }

export class CursorStore {
  readonly baseDir: string // globalStorage 目录（不存在时为空串）
  readonly usingSample = false
  private dbPath: string // .../globalStorage/state.vscdb
  private sessions = new Map<string, SessionState>() // composerId -> state
  private listeners = new Set<(e: CursorStoreEvent) => void>()
  private watcher?: FSWatcher
  private debounce?: NodeJS.Timeout

  constructor() {
    const env = process.env.CURSOR_GLOBAL_STORAGE
    const dir = env ? expandHome(env) : DEFAULT_GLOBAL_STORAGE
    const db = path.join(dir, 'state.vscdb')
    const ok = fs.existsSync(db)
    this.baseDir = ok ? dir : ''
    this.dbPath = ok ? db : ''
  }

  on(listener: (e: CursorStoreEvent) => void): void {
    this.listeners.add(listener)
  }
  off(listener: (e: CursorStoreEvent) => void): void {
    this.listeners.delete(listener)
  }
  private emit(e: CursorStoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('[CursorStore] listener error:', err)
      }
    }
  }

  // 复制活动库为临时快照并打开（副本可读写，SQLite 自动合并 WAL）。返回 db + 清理函数。
  private openSnapshot(): { db: Database.Database; cleanup: () => void } | null {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return null
    let tmpDir = ''
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-snap-'))
      const tmpDb = path.join(tmpDir, 'state.vscdb')
      fs.copyFileSync(this.dbPath, tmpDb)
      for (const suf of ['-wal', '-shm']) {
        const src = this.dbPath + suf
        if (fs.existsSync(src)) {
          try {
            fs.copyFileSync(src, tmpDb + suf)
          } catch {
            /* ignore：某个附属文件复制失败不致命 */
          }
        }
      }
      const db = new Database(tmpDb, { fileMustExist: true })
      const dir = tmpDir
      const cleanup = () => {
        try {
          db.close()
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      return { db, cleanup }
    } catch {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      return null
    }
  }

  // 解析一个 composer（会话）为 SessionState；空会话返回 null。
  private parseComposer(getBubble: BubbleStmt, composerId: string, raw: Record<string, unknown>): SessionState | null {
    const headers = Array.isArray(raw.fullConversationHeadersOnly) ? (raw.fullConversationHeadersOnly as unknown[]) : []
    const messages: ClaudeMessage[] = []
    let firstTs = 0
    let lastTs = 0

    for (const hRaw of headers) {
      if (!hRaw || typeof hRaw !== 'object') continue
      const h = hRaw as { bubbleId?: string; type?: number; createdAt?: string }
      if (!h.bubbleId) continue
      const row = getBubble.get(`bubbleId:${composerId}:${h.bubbleId}`)
      if (!row) continue
      let b: Record<string, unknown> | null
      try {
        b = JSON.parse(row.value)
      } catch {
        continue
      }
      if (!b || typeof b !== 'object') continue
      const blocks = bubbleToBlocks(b)
      if (blocks.length === 0) continue

      const ts = h.createdAt ? Date.parse(h.createdAt) : 0
      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts
        if (ts > lastTs) lastTs = ts
      }
      const role: 'user' | 'assistant' = h.type === 2 ? 'assistant' : 'user'
      messages.push({
        uuid: h.bubbleId,
        parentUuid: null,
        role,
        timestamp: ts,
        blocks,
        isMeta: false,
        isSidechain: false,
      })
    }

    if (messages.length === 0) return null // 空会话跳过

    // 工作区路径：workspaceIdentifier.uri.fsPath / .path
    let cwd = ''
    const wi = raw.workspaceIdentifier as { uri?: { fsPath?: string; path?: string } } | undefined
    if (wi && wi.uri) cwd = (wi.uri.fsPath || wi.uri.path || '').trim()
    const cwdKey = cwd || NO_WORKSPACE
    const projectDir = cwd ? path.basename(cwd) : NO_WORKSPACE

    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const title = name ? sanitizeTitle(name) : deriveTitleFromMessages(messages)

    const createdAtRaw = typeof raw.createdAt === 'number' ? raw.createdAt : 0
    const lastUpdatedRaw = typeof raw.lastUpdatedAt === 'number' ? raw.lastUpdatedAt : 0

    const meta: SessionMeta = {
      sourceType: 'cursor',
      sessionId: composerId,
      cwd: cwdKey,
      projectDir,
      filePath: this.dbPath,
      title,
      createdAt: createdAtRaw || firstTs,
      lastActiveAt: lastUpdatedRaw || lastTs,
      messageCount: messages.length,
    }
    return { composerId, meta, messages }
  }

  scan(): void {
    this.sessions.clear()
    const snap = this.openSnapshot()
    if (!snap) return
    try {
      const comps = snap.db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key: string; value: string }>
      const getBubble = snap.db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?') as unknown as BubbleStmt
      for (const r of comps) {
        let raw: Record<string, unknown> | null
        try {
          raw = JSON.parse(r.value)
        } catch {
          continue
        }
        if (!raw || typeof raw !== 'object') continue
        const composerId = r.key.slice('composerData:'.length)
        const st = this.parseComposer(getBubble, composerId, raw)
        if (st) this.sessions.set(composerId, st)
      }
    } catch (err) {
      console.error('[CursorStore] scan error:', err instanceof Error ? err.message : err)
    } finally {
      snap.cleanup()
    }
  }

  getProjects(): ProjectGroup[] {
    const byCwd = new Map<string, ProjectGroup>()
    for (const s of this.sessions.values()) {
      const key = s.meta.cwd || s.meta.projectDir
      let group = byCwd.get(key)
      if (!group) {
        group = { sourceType: 'cursor', projectDir: s.meta.projectDir, cwd: key, sessionCount: 0, lastActiveAt: 0, sessions: [] }
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
    const cached = this.sessions.get(sessionId)
    if (!cached) return null
    // 打开即重读一次，保证最新
    const snap = this.openSnapshot()
    if (!snap) return { ...cached.meta, messages: cached.messages }
    try {
      const row = snap.db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${sessionId}`) as { value: string } | undefined
      if (!row) return { ...cached.meta, messages: cached.messages }
      let raw: Record<string, unknown> | null
      try {
        raw = JSON.parse(row.value)
      } catch {
        return { ...cached.meta, messages: cached.messages }
      }
      if (!raw) return { ...cached.meta, messages: cached.messages }
      const getBubble = snap.db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?') as unknown as BubbleStmt
      const st = this.parseComposer(getBubble, sessionId, raw)
      if (st) {
        this.sessions.set(sessionId, st)
        return { ...st.meta, messages: st.messages }
      }
      return { ...cached.meta, messages: cached.messages }
    } catch {
      return { ...cached.meta, messages: cached.messages }
    } finally {
      snap.cleanup()
    }
  }

  // 库变化后全量重扫并对比，推送增量/元信息/移除事件。
  private refreshAll(): void {
    const old = new Map<string, { count: number; last: number; title: string }>()
    for (const [id, st] of this.sessions) {
      old.set(id, { count: st.messages.length, last: st.meta.lastActiveAt, title: st.meta.title })
    }
    this.scan()
    const seen = new Set<string>()
    for (const [id, st] of this.sessions) {
      seen.add(id)
      const o = old.get(id)
      if (!o) {
        this.emit({ type: 'session_meta_updated', meta: st.meta })
        continue
      }
      if (st.messages.length > o.count) {
        this.emit({ type: 'session_appended', sessionId: id, messages: st.messages.slice(o.count), meta: st.meta })
      } else if (st.meta.lastActiveAt !== o.last || st.meta.title !== o.title) {
        this.emit({ type: 'session_meta_updated', meta: st.meta })
      }
    }
    for (const id of old.keys()) {
      if (!seen.has(id)) this.emit({ type: 'session_removed', sessionId: id })
    }
  }

  startWatching(): void {
    if (this.watcher) return
    if (!this.baseDir || !fs.existsSync(this.baseDir)) return
    // 只监听 globalStorage 顶层的 state.vscdb*（WAL 写入频繁，用防抖收敛）
    this.watcher = chokidar.watch(this.baseDir, { ignoreInitial: true, depth: 0 })
    const onChange = (f: string) => {
      if (!path.basename(f).startsWith('state.vscdb')) return
      if (this.debounce) clearTimeout(this.debounce)
      this.debounce = setTimeout(() => this.refreshAll(), 600)
    }
    this.watcher.on('add', onChange)
    this.watcher.on('change', onChange)
  }

  async stopWatching(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = undefined
    }
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = undefined
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────────

// 把一个 Cursor bubble 归一化为 ContentBlock[]（顺序：thinking → text → tool_use → tool_result）
function bubbleToBlocks(b: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = []

  const thinking = b.thinking as { text?: string } | undefined
  if (thinking && typeof thinking.text === 'string' && thinking.text.trim()) {
    blocks.push({ type: 'thinking', text: thinking.text })
  }

  if (typeof b.text === 'string' && b.text.trim()) {
    blocks.push({ type: 'text', text: b.text })
  }

  const tf = b.toolFormerData as
    | { name?: string; tool?: string; params?: unknown; rawArgs?: string; result?: unknown; toolCallId?: string; status?: string }
    | undefined
  if (tf && typeof tf === 'object') {
    const toolName = String(tf.name || tf.tool || 'unknown')
    let toolInput: unknown = undefined
    if (tf.params != null) {
      toolInput = tf.params
    } else if (typeof tf.rawArgs === 'string') {
      try {
        toolInput = JSON.parse(tf.rawArgs)
      } catch {
        toolInput = tf.rawArgs
      }
    }
    const toolUseId = tf.toolCallId ? String(tf.toolCallId) : undefined
    blocks.push({ type: 'tool_use', toolName, toolInput, toolUseId })
    const resultStr = flattenToolResult(tf.result)
    if (resultStr) {
      blocks.push({ type: 'tool_result', text: resultStr, toolUseId, isError: tf.status === 'error' })
    }
  }

  return blocks
}

function flattenToolResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
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
