import fs from 'fs'
import path from 'path'
import { WebSocket } from 'ws'
import { createAgent } from './agents'
import {
  ChatMessage,
  CONSENSUS_TAG,
  DebateSession,
  Message,
  ServerEvent,
} from './types'

const SESSIONS_DIR = path.join(process.cwd(), 'sessions')

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

function saveSession(session: DebateSession): void {
  ensureSessionsDir()
  const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeId) return
  const filePath = path.join(SESSIONS_DIR, `${safeId}.json`)
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8')
}

export function loadSession(sessionId: string): DebateSession | null {
  ensureSessionsDir()
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeId) return null
  const filePath = path.join(SESSIONS_DIR, `${safeId}.json`)
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as DebateSession
  } catch {
    return null
  }
}

export function listSessions(): { id: string; topic: string; createdAt: number; status: string; consensusReached: boolean }[] {
  ensureSessionsDir()
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  const result: { id: string; topic: string; createdAt: number; status: string; consensusReached: boolean }[] = []
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8')
      const session = JSON.parse(raw) as DebateSession
      result.push({
        id: session.id,
        topic: session.topic,
        createdAt: session.createdAt,
        status: session.status,
        consensusReached: session.consensusReached ?? false,
      })
    } catch {
      // skip corrupted files
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt)
}

export class Orchestrator {
  private paused = false
  private stopped = false
  private injectedMessage: string | null = null
  private ws: WebSocket

  // Shared conversation history for both agents
  // Index 0 = executor, Index 1 = reviewer
  // Each agent sees the shared thread from its own perspective:
  //   - its own turns are 'assistant'
  //   - the other agent's turns are 'user'
  private sharedHistory: ChatMessage[] = []

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  private send(event: ServerEvent): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event))
    }
  }

  private async waitWhilePaused(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.stopped) { resolve(false); return }
        if (!this.paused) { resolve(true); return }
        setTimeout(check, 200)
      }
      check()
    })
  }

  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  stop(): void { this.stopped = true; this.paused = false }
  inject(content: string): void { this.injectedMessage = content }

  /**
   * Build the message array for a given agent from the shared history.
   * The agent's own turns → 'assistant', the other agent's turns → 'user'.
   * sharedHistory entries are tagged with the agentId that produced them.
   */
  private buildMessagesForAgent(
    agentId: string,
    taggedHistory: { agentId: string; role: 'user' | 'assistant'; content: string }[]
  ): ChatMessage[] {
    return taggedHistory.map((entry) => ({
      role: entry.agentId === agentId ? 'assistant' : 'user',
      content: entry.content,
    }))
  }

  async start(session: DebateSession): Promise<void> {
    this.paused = false
    this.stopped = false
    this.injectedMessage = null

    // Tagged shared history: each entry knows which agent produced it
    const taggedHistory: { agentId: string; role: 'user' | 'assistant'; content: string }[] = []

    session.status = 'running'
    session.consensusReached = false
    this.send({ type: 'session_update', session: { ...session } })

    const [executorConfig, reviewerConfig] = session.agents
    const maxRounds = session.terminationMode === 'manual' ? Infinity : session.maxRounds

    // Seed: inject the topic as the opening user message to executor
    const topicSeed = `议题：${session.topic}\n\n请开始阐述你的方案和核心主张。`
    // This seed is a "system/moderator" prompt — shown as user to executor
    taggedHistory.push({ agentId: reviewerConfig.id, role: 'user', content: topicSeed })

    outerLoop: for (let round = 1; round <= maxRounds; round++) {
      session.currentRound = round

      // Alternate: executor first, then reviewer
      for (const agentConfig of [executorConfig, reviewerConfig]) {
        if (this.stopped) break outerLoop

        const canContinue = await this.waitWhilePaused()
        if (!canContinue) break outerLoop

        // Handle human injection
        if (this.injectedMessage !== null) {
          const injectContent = `[主持人介入]: ${this.injectedMessage}`
          this.injectedMessage = null

          // Inject as a neutral 'user' entry attributed to a virtual moderator
          taggedHistory.push({ agentId: '__moderator__', role: 'user', content: injectContent })

          const injectMsg: Message = {
            agentId: 'moderator',
            agentName: '主持人',
            role: 'executor', // neutral-ish, just reuse executor for colour
            content: injectContent,
            timestamp: Date.now(),
            round,
          }
          this.send({ type: 'message', data: injectMsg })
          session.messages.push(injectMsg)
        }

        // Build the perspective-correct message list for this agent
        const messagesForAgent = this.buildMessagesForAgent(agentConfig.id, taggedHistory)

        const agent = createAgent(agentConfig)
        let streamedContent = ''

        try {
          const response = await agent.call(messagesForAgent, (token: string) => {
            streamedContent += token
            this.send({ type: 'token', agentId: agentConfig.id, token })
          })

          streamedContent = response.content

          // Check for consensus signal
          const hasConsensus = streamedContent.includes(CONSENSUS_TAG)

          // Append to shared tagged history as 'assistant' for this agent
          taggedHistory.push({ agentId: agentConfig.id, role: 'assistant', content: streamedContent })

          const msg: Message = {
            agentId: agentConfig.id,
            agentName: agentConfig.name,
            role: agentConfig.role,
            content: streamedContent,
            timestamp: Date.now(),
            round,
            consensusSignal: hasConsensus,
            tokenUsage: response.tokenUsage,
          }
          session.messages.push(msg)
          this.send({ type: 'message', data: msg })

          if (hasConsensus) {
            session.consensusReached = true
            this.send({
              type: 'consensus_reached',
              triggerAgentName: agentConfig.name,
              round,
            })
            saveSession(session)
            this.send({ type: 'session_update', session: { ...session } })
            break outerLoop
          }

        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          this.send({ type: 'error', message: `Agent ${agentConfig.name} 调用失败: ${errMsg}` })
          session.status = 'paused'
          this.paused = true
          this.send({ type: 'session_update', session: { ...session } })
          const canResume = await this.waitWhilePaused()
          if (!canResume) break outerLoop
          session.status = 'running'
          this.send({ type: 'session_update', session: { ...session } })
          // Re-run this agent (undo the loop advance)
          // We break the inner for-of and restart by re-queuing via continue outerLoop trick
          round-- // re-do this round
          continue outerLoop
        }
      }

      // Save after each full round
      saveSession(session)
      this.send({ type: 'session_update', session: { ...session } })

      if (session.terminationMode === 'rounds' && round >= session.maxRounds) {
        break
      }
    }

    session.status = 'finished'
    saveSession(session)
    this.send({ type: 'session_update', session: { ...session } })
  }

  async generateSummary(session: DebateSession): Promise<string> {
    const transcript = session.messages
      .filter((m) => m.agentId !== 'moderator')
      .map((m) => `**[第${m.round}轮 · ${m.agentName}（${m.role === 'executor' ? '执行方' : '评审方'}）]**\n${m.content}`)
      .join('\n\n---\n\n')

    const consensusNote = session.consensusReached
      ? `\n\n> 本次对话已于第 ${session.messages.find(m => m.consensusSignal)?.round ?? '?'} 轮达成收敛。`
      : '\n\n> 本次对话未达成自动收敛，已达轮数上限或人工终止。'

    const summaryPrompt = `以下是一场关于「${session.topic}」的跨模型方案评审记录：\n\n${transcript}${consensusNote}\n\n请生成一份结构化总结报告，包含以下部分：\n\n1. **核心主张（最终收敛版本）**\n   - 执行方的最终方案要点\n   - 评审方最终认可的内容\n\n2. **主要评审争议**\n   - 评审过程中提出的关键批评\n   - 执行方的回应与修订\n\n3. **已解决 vs 未解决问题**\n\n4. **最终行动/结论建议**\n\n5. **收敛统计**\n   - 共进行轮次、是否达成共识\n\n请用中文回复，使用 Markdown 格式，条理清晰。`

    const summaryConfig = {
      ...session.agents[0],
      id: 'summary-agent',
      systemPrompt: '你是一名专业的方案评审分析师，擅长综合多方观点、识别共识与分歧，生成结构化的评审总结报告。',
    }
    const agent = createAgent(summaryConfig)

    let summaryContent = ''
    const response = await agent.call(
      [{ role: 'user', content: summaryPrompt }],
      (token: string) => {
        summaryContent += token
        this.send({ type: 'token', agentId: 'summary', token })
      }
    )

    summaryContent = response.content
    session.summary = summaryContent
    saveSession(session)
    this.send({ type: 'summary', content: summaryContent })
    return summaryContent
  }
}
