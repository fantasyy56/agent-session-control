// ClaudeStore：扫描 ~/.claude/projects、建立会话索引、并用 chokidar 实时监听增量。
// - 列表/详情读取：解析 JSONL 文件
// - 实时：按字节偏移只读新增内容，解析后以增量事件推送

import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import { parseLine, deriveTitleFromMessages } from './parser'
import { ClaudeMessage, ProjectGroup, SessionDetail, SessionMeta } from './types'

interface FileState {
  filePath: string
  sessionId: string
  meta: SessionMeta
  offset: number // 已消费的字节数
  leftover: string // 上次读取剩下的不完整行
}

export type StoreEvent =
  | { type: 'session_appended'; sessionId: string; messages: ClaudeMessage[]; meta: SessionMeta }
  | { type: 'session_meta_updated'; meta: SessionMeta }
  | { type: 'session_removed'; sessionId: string }

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  return p
}

export class ClaudeStore {
  readonly baseDir: string
  readonly usingSample: boolean
  private files = new Map<string, FileState>() // filePath -> state
  private sessionIndex = new Map<string, string>() // sessionId -> filePath
  private listeners = new Set<(e: StoreEvent) => void>()
  private watcher?: FSWatcher

  constructor() {
    const env = process.env.CLAUDE_PROJECTS_DIR
    let dir = env ? expandHome(env) : path.join(os.homedir(), '.claude', 'projects')
    let usingSample = false
    if (!fs.existsSync(dir)) {
      const sample = path.join(process.cwd(), 'sample-data', 'projects')
      if (fs.existsSync(sample)) {
        dir = sample
        usingSample = true
      }
    }
    this.baseDir = dir
    this.usingSample = usingSample
  }

  on(listener: (e: StoreEvent) => void): void {
    this.listeners.add(listener)
  }

  off(listener: (e: StoreEvent) => void): void {
    this.listeners.delete(listener)
  }

  private emit(e: StoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('[ClaudeStore] listener error:', err)
      }
    }
  }

  // 列出 baseDir 下所有 *.jsonl 文件（结构：baseDir/<project>/<session>.jsonl）
  private listJsonlFiles(): string[] {
    const result: string[] = []
    if (!fs.existsSync(this.baseDir)) return result
    let projectDirs: string[]
    try {
      projectDirs = fs.readdirSync(this.baseDir)
    } catch {
      return result
    }
    for (const proj of projectDirs) {
      const projPath = path.join(this.baseDir, proj)
      let stat: fs.Stats
      try {
        stat = fs.statSync(projPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      let entries: string[]
      try {
        entries = fs.readdirSync(projPath)
      } catch {
        continue
      }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) result.push(path.join(projPath, f))
      }
    }
    return result
  }

  // 完整解析一个文件，返回消息与元信息
  private parseFileFull(filePath: string): { messages: ClaudeMessage[]; meta: SessionMeta } {
    const projectDir = path.basename(path.dirname(filePath))
    const sessionId = path.basename(filePath, '.jsonl')
    const messages: ClaudeMessage[] = []
    let summary = ''
    let customTitle: string | undefined
    let cwd = ''
    let gitBranch: string | undefined
    let createdAt = 0
    let lastActiveAt = 0

    let content = ''
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      // 文件可能瞬时被占用，返回空
    }
    const lines = content.split('\n')
    for (const line of lines) {
      const parsed = parseLine(line)
      if (parsed.cwd) cwd = parsed.cwd
      if (parsed.gitBranch) gitBranch = parsed.gitBranch
      if (parsed.summary) summary = parsed.summary
      if (parsed.customTitle) customTitle = parsed.customTitle
      if (parsed.timestamp) {
        if (!createdAt || parsed.timestamp < createdAt) createdAt = parsed.timestamp
        if (parsed.timestamp > lastActiveAt) lastActiveAt = parsed.timestamp
      }
      if (parsed.message) messages.push(parsed.message)
    }
    // 标题优先级：用户手动命名 > AI summary > 首条消息派生
    const title = customTitle || summary || deriveTitleFromMessages(messages)

    const meta: SessionMeta = {
      sourceType: 'claude',
      sessionId,
      cwd: cwd || projectDir,
      projectDir,
      filePath,
      title,
      customTitle,
      createdAt: createdAt || lastActiveAt,
      lastActiveAt,
      messageCount: messages.length,
      gitBranch,
    }
    return { messages, meta }
  }

  // 初始扫描：建立索引，offset 设到文件末尾（实时只追后续增量）
  scan(): void {
    this.files.clear()
    this.sessionIndex.clear()
    for (const filePath of this.listJsonlFiles()) {
      const { meta } = this.parseFileFull(filePath)
      let size = 0
      try {
        size = fs.statSync(filePath).size
      } catch {
        /* ignore */
      }
      this.files.set(filePath, { filePath, sessionId: meta.sessionId, meta, offset: size, leftover: '' })
      this.sessionIndex.set(meta.sessionId, filePath)
    }
  }

  getProjects(): ProjectGroup[] {
    const byCwd = new Map<string, ProjectGroup>()
    for (const state of this.files.values()) {
      const key = state.meta.cwd || state.meta.projectDir
      let group = byCwd.get(key)
      if (!group) {
        group = { sourceType: 'claude', projectDir: state.meta.projectDir, cwd: key, sessionCount: 0, lastActiveAt: 0, sessions: [] }
        byCwd.set(key, group)
      }
      group.sessions.push(state.meta)
      group.sessionCount++
      if (state.meta.lastActiveAt > group.lastActiveAt) group.lastActiveAt = state.meta.lastActiveAt
    }
    const groups = Array.from(byCwd.values())
    for (const g of groups) g.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    groups.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return groups
  }

  getSession(sessionId: string): SessionDetail | null {
    const filePath = this.sessionIndex.get(sessionId)
    if (!filePath || !fs.existsSync(filePath)) return null
    const { messages, meta } = this.parseFileFull(filePath)
    return { ...meta, messages }
  }

  // 读取文件自 offset 起的新增字节
  private readNewBytes(filePath: string, offset: number): { text: string; newOffset: number } | null {
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      return null
    }
    if (size <= offset) {
      // 文件被截断/重写：从头再来
      if (size < offset) return { text: '__RESET__', newOffset: size }
      return null
    }
    const len = size - offset
    const buf = Buffer.alloc(len)
    let fd: number | null = null
    try {
      fd = fs.openSync(filePath, 'r')
      fs.readSync(fd, buf, 0, len, offset)
    } catch {
      return null
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
    return { text: buf.toString('utf8'), newOffset: size }
  }

  private handleChange(filePath: string): void {
    const state = this.files.get(filePath)
    if (!state) {
      this.handleAdd(filePath)
      return
    }
    const res = this.readNewBytes(filePath, state.offset)
    if (!res) return

    if (res.text === '__RESET__') {
      const { meta } = this.parseFileFull(filePath)
      state.meta = meta
      state.offset = res.newOffset
      state.leftover = ''
      this.emit({ type: 'session_meta_updated', meta })
      return
    }

    const combined = state.leftover + res.text
    const endsWithNewline = combined.endsWith('\n')
    const parts = combined.split('\n')
    state.leftover = endsWithNewline ? '' : parts.pop() ?? ''
    state.offset = res.newOffset

    const newMessages: ClaudeMessage[] = []
    for (const line of parts) {
      const parsed = parseLine(line)
      if (parsed.cwd) state.meta.cwd = parsed.cwd
      if (parsed.gitBranch) state.meta.gitBranch = parsed.gitBranch
      if (parsed.customTitle) {
        state.meta.customTitle = parsed.customTitle
        state.meta.title = parsed.customTitle // 用户命名优先级最高
      } else if (parsed.summary && !state.meta.customTitle) {
        state.meta.title = parsed.summary
      }
      if (parsed.timestamp && parsed.timestamp > state.meta.lastActiveAt) {
        state.meta.lastActiveAt = parsed.timestamp
      }
      if (parsed.message) newMessages.push(parsed.message)
    }
    if (newMessages.length > 0) {
      state.meta.messageCount += newMessages.length
      this.emit({ type: 'session_appended', sessionId: state.sessionId, messages: newMessages, meta: state.meta })
    } else {
      this.emit({ type: 'session_meta_updated', meta: state.meta })
    }
  }

  private handleAdd(filePath: string): void {
    if (this.files.has(filePath)) return
    const { meta } = this.parseFileFull(filePath)
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      /* ignore */
    }
    this.files.set(filePath, { filePath, sessionId: meta.sessionId, meta, offset: size, leftover: '' })
    this.sessionIndex.set(meta.sessionId, filePath)
    this.emit({ type: 'session_meta_updated', meta })
  }

  private handleRemove(filePath: string): void {
    const state = this.files.get(filePath)
    if (!state) return
    this.files.delete(filePath)
    this.sessionIndex.delete(state.sessionId)
    this.emit({ type: 'session_removed', sessionId: state.sessionId })
  }

  startWatching(): void {
    if (this.watcher) return
    if (!fs.existsSync(this.baseDir)) return
    this.watcher = chokidar.watch(this.baseDir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    this.watcher.on('add', (f) => {
      if (f.endsWith('.jsonl')) this.handleAdd(f)
    })
    this.watcher.on('change', (f) => {
      if (f.endsWith('.jsonl')) this.handleChange(f)
    })
    this.watcher.on('unlink', (f) => {
      if (f.endsWith('.jsonl')) this.handleRemove(f)
    })
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = undefined
    }
  }
}
