// AggregateStore：把多个 SessionSource（Claude / CodeBuddy / WorkBuddy）合并到一个统一对外接口。
//
// 设计：
// - 对外 API 与 ClaudeStore 保持一致（getProjects/getSession/scan/startWatching/on/off）
// - 每个会话的来源以 SessionMeta.sourceType 区分
// - sessionId 可能在多个源里同名（虽然 UUID 实践上不太可能冲突），所以内部用 sourceType+sessionId 索引

import { ClaudeStore, StoreEvent as ClaudeStoreEvent } from './claude/store'
import { CodeBuddyStore, CodeBuddyStoreEvent } from './codebuddy/store'
import { WorkBuddyStore, WorkBuddyStoreEvent } from './workbuddy/store'
import { ClaudeMessage, ProjectGroup, SessionDetail, SessionMeta, SourceType } from './claude/types'

export type AggStoreEvent = ClaudeStoreEvent | CodeBuddyStoreEvent | WorkBuddyStoreEvent

export class AggregateStore {
  private claude: ClaudeStore
  private codebuddy: CodeBuddyStore
  private workbuddy: WorkBuddyStore
  private listeners = new Set<(e: AggStoreEvent) => void>()

  constructor() {
    this.claude = new ClaudeStore()
    this.codebuddy = new CodeBuddyStore()
    this.workbuddy = new WorkBuddyStore()
    this.claude.on((e) => this.fanout(e))
    this.codebuddy.on((e) => this.fanout(e))
    this.workbuddy.on((e) => this.fanout(e))
  }

  // 兼容老接口：baseDir 拿主源（Claude）；前端从 /api/meta 取
  get baseDir(): string {
    return this.claude.baseDir
  }
  get usingSample(): boolean {
    return this.claude.usingSample
  }
  // 额外暴露每源的状态，便于前端做 Tab 显示
  get sources(): Array<{ sourceType: SourceType; baseDir: string; usingSample: boolean; available: boolean }> {
    return [
      { sourceType: 'claude', baseDir: this.claude.baseDir, usingSample: this.claude.usingSample, available: !!this.claude.baseDir },
      { sourceType: 'codebuddy', baseDir: this.codebuddy.baseDir, usingSample: false, available: !!this.codebuddy.baseDir },
      { sourceType: 'workbuddy', baseDir: this.workbuddy.baseDir, usingSample: false, available: !!this.workbuddy.baseDir },
    ]
  }

  on(l: (e: AggStoreEvent) => void): void {
    this.listeners.add(l)
  }
  off(l: (e: AggStoreEvent) => void): void {
    this.listeners.delete(l)
  }
  private fanout(e: AggStoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('[AggregateStore] listener error:', err)
      }
    }
  }

  scan(): void {
    this.claude.scan()
    this.codebuddy.scan()
    this.workbuddy.scan()
  }

  startWatching(): void {
    this.claude.startWatching()
    this.codebuddy.startWatching()
    this.workbuddy.startWatching()
  }

  async stopWatching(): Promise<void> {
    await this.claude.stopWatching()
    await this.codebuddy.stopWatching()
    await this.workbuddy.stopWatching()
  }

  // 合并各源的项目分组
  getProjects(): ProjectGroup[] {
    return [...this.claude.getProjects(), ...this.codebuddy.getProjects(), ...this.workbuddy.getProjects()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    )
  }

  // 依次查 Claude / CodeBuddy / WorkBuddy
  getSession(sessionId: string): SessionDetail | null {
    return this.claude.getSession(sessionId) || this.codebuddy.getSession(sessionId) || this.workbuddy.getSession(sessionId)
  }
}

// 重新导出消息/事件类型，避免 server.ts 改太多
export type { ClaudeMessage, SessionMeta, SessionDetail, ProjectGroup, SourceType }
