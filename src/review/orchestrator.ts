// 评审编排器：执行方（持上下文）↔ 评审方（只看简报）乒乓讨论，收敛后产出结论。
// 复用现有 agents.ts 的 OpenAI 流式封装；与旧 orchestrator 的区别在于「非对称喂上下文」。

import { v4 as uuidv4 } from 'uuid'
import { createAgent } from '../agents'
import { AgentConfig, ChatMessage, CONSENSUS_TAG } from '../types'
import { ReviewMessage, ReviewRole, ReviewServerEvent, ReviewSession } from './types'

export interface ReviewOrchestratorOptions {
  sourceSessionId: string
  cwd: string
  query: string
  contextTranscript: string // 源会话近 N 轮的文本转写（仅执行方可见）
  contextRounds: number
  executorModel: string
  reviewerModel: string
  maxRounds: number
  send: (e: ReviewServerEvent) => void
}

interface TaggedEntry {
  producer: ReviewRole // 'executor' | 'reviewer' | 'moderator'
  content: string
}

function executorSystemPrompt(contextTranscript: string, query: string): string {
  return [
    '你是「执行方」。你正在就一个具体问题，与一位使用不同模型的「评审专家」展开讨论。',
    '你掌握以下来自真实编码会话的上下文，评审方看不到这些，只能看到你主动转述给它的内容：',
    '',
    '<会话上下文>',
    contextTranscript || '（无可用历史，仅依据下方问题展开）',
    '</会话上下文>',
    '',
    '用户当前想讨论的问题：',
    query,
    '',
    '【首轮】请撰写一段「开场简报」：清晰陈述你当前的观点/方案，并明确你希望评审方帮你判断的具体问题。',
    '简报必须自包含——把评审所需的背景、约束、关键细节都讲清楚，因为评审方看不到原始上下文。',
    '【后续轮】针对评审方的意见，结合你掌握的上下文给出回应：认同点、不认同点及理由、修正后的方案。',
    '保持简洁、聚焦在当前问题上，不要发散到无关话题。收敛与否由评审方判定，你只需如实回应。',
  ].join('\n')
}

const REVIEWER_SYSTEM_PROMPT = [
  '你是「评审专家」，使用与执行方不同的模型，目的是提供跨模型的独立视角。',
  '你只能看到执行方提供的简报以及双方往返的讨论，看不到原始代码会话——若信息不足，请要求执行方补充。',
  '职责：审视执行方的方案/观点，指出潜在风险、漏洞、被忽略的边界情况，并给出更优替代或改进建议。',
  '提问要尖锐但具建设性，聚焦在当前讨论的问题上。',
  `当你认为执行方的方案已足够完善、你没有重大新意见时，在回复最后单独用一行输出：${CONSENSUS_TAG}`,
].join('\n')

const CONCLUSION_SYSTEM_PROMPT = [
  '你是「执行方」。评审讨论已结束，请基于你掌握的上下文与本次全部往返讨论，输出一份「最终结论」。',
  '包含：①最终采纳的方案/答案；②评审过程中被修正或加强的关键点；③仍存在的风险或待办（如有）。',
  '用中文、Markdown，条理清晰、可直接落地。',
].join('\n')

// 合并相邻同角色消息，避免部分 OpenAI 兼容服务对连续 user/assistant 报错
function mergeAdjacent(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content
    } else {
      out.push({ ...m })
    }
  }
  return out
}

export class ReviewOrchestrator {
  private paused = false
  private stopped = false
  private injected: string | null = null
  private readonly opts: ReviewOrchestratorOptions
  private history: TaggedEntry[] = []

  constructor(opts: ReviewOrchestratorOptions) {
    this.opts = opts
  }

  pause(): void { this.paused = true; this.opts.send({ type: 'review_status', status: 'paused', round: 0 }) }
  resume(): void { this.paused = false; this.opts.send({ type: 'review_status', status: 'running', round: 0 }) }
  stop(): void { this.stopped = true; this.paused = false }
  inject(content: string): void { this.injected = content }

  private async waitWhilePaused(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.stopped) return resolve(false)
        if (!this.paused) return resolve(true)
        setTimeout(check, 200)
      }
      check()
    })
  }

  // 从共享往返历史构建某一方可见的消息列表：自己=assistant，他方/主持人=user
  private buildMessagesFor(role: ReviewRole): ChatMessage[] {
    const mapped: ChatMessage[] = this.history.map((e) => ({
      role: e.producer === role ? 'assistant' : 'user',
      content: e.content,
    }))
    return mergeAdjacent(mapped)
  }

  private newMessage(role: ReviewRole, content: string, round: number, model?: string, consensusSignal?: boolean): ReviewMessage {
    return { id: uuidv4(), role, content, round, timestamp: Date.now(), model, consensusSignal }
  }

  private async runAgent(
    role: ReviewRole,
    systemPrompt: string,
    model: string,
    messages: ChatMessage[],
    round: number
  ): Promise<string> {
    const config: AgentConfig = {
      id: role,
      name: role,
      model,
      role: role === 'reviewer' ? 'reviewer' : 'executor',
      systemPrompt,
    }
    const agent = createAgent(config)
    const res = await agent.call(messages, (token) => {
      this.opts.send({ type: 'review_token', role, round, token })
    })
    const content = (res.content || '').trim()
    return content || '（本轮模型未产出有效内容）'
  }

  async start(session: ReviewSession): Promise<void> {
    const { send, query, contextTranscript, executorModel, reviewerModel, maxRounds } = this.opts
    send({ type: 'review_started', review: session })
    send({ type: 'review_status', status: 'running', round: 1 })

    try {
      for (let round = 1; round <= maxRounds; round++) {
        // ── 执行方 ──
        if (!(await this.waitWhilePaused())) break

        if (this.injected !== null) {
          const content = `[主持人介入] ${this.injected}`
          this.injected = null
          this.history.push({ producer: 'moderator', content })
          const m = this.newMessage('moderator', content, round)
          session.messages.push(m)
          send({ type: 'review_message', message: m })
        }

        const execMsgs = this.buildMessagesFor('executor')
        if (execMsgs.length === 0) {
          execMsgs.push({ role: 'user', content: '请撰写开场简报，陈述你的观点并提出希望评审的问题。' })
        }
        const execContent = await this.runAgent(
          'executor',
          executorSystemPrompt(contextTranscript, query),
          executorModel,
          execMsgs,
          round
        )
        this.history.push({ producer: 'executor', content: execContent })
        const execMsg = this.newMessage('executor', execContent, round, executorModel)
        session.messages.push(execMsg)
        send({ type: 'review_message', message: execMsg })

        // ── 评审方 ──
        if (!(await this.waitWhilePaused())) break

        const reviewMsgs = this.buildMessagesFor('reviewer')
        const reviewRaw = await this.runAgent(
          'reviewer',
          REVIEWER_SYSTEM_PROMPT,
          reviewerModel,
          reviewMsgs,
          round
        )
        const hasConsensus = reviewRaw.includes(CONSENSUS_TAG)
        const reviewContent = reviewRaw.replace(CONSENSUS_TAG, '').trim()
        this.history.push({ producer: 'reviewer', content: reviewContent })
        const reviewMsg = this.newMessage('reviewer', reviewContent, round, reviewerModel, hasConsensus)
        session.messages.push(reviewMsg)
        send({ type: 'review_message', message: reviewMsg })

        if (hasConsensus) {
          session.consensusReached = true
          break
        }
        if (this.stopped) break
      }

      if (this.stopped) {
        session.status = 'stopped'
        send({ type: 'review_status', status: 'stopped', round: 0 })
        return
      }

      // ── 最终结论（执行方自动回复）──
      const conclMsgs = this.buildMessagesFor('executor')
      conclMsgs.push({ role: 'user', content: '讨论到此结束，请给出最终结论。' })
      const conclusion = await this.runAgent('conclusion', CONCLUSION_SYSTEM_PROMPT, executorModel, conclMsgs, 0)
      session.conclusion = conclusion
      const conclMsg = this.newMessage('conclusion', conclusion, 0, executorModel)
      session.messages.push(conclMsg)
      send({ type: 'review_message', message: conclMsg })
      send({ type: 'review_conclusion', content: conclusion })

      session.status = 'finished'
      send({ type: 'review_status', status: 'finished', round: 0 })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      session.status = 'error'
      send({ type: 'review_error', message: `评审失败：${msg}` })
      send({ type: 'review_status', status: 'error', round: 0 })
    }
  }
}
