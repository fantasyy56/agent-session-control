import OpenAI from 'openai'
import { AgentConfig, AgentResponse, ChatMessage } from './types'

export class Agent {
  private client: OpenAI
  private config: AgentConfig

  constructor(config: AgentConfig) {
    this.config = config
    const apiKey = process.env.API_KEY
    const baseURL = process.env.API_BASE_URL
    if (!apiKey) {
      throw new Error('API_KEY is required in .env')
    }
    if (!baseURL) {
      throw new Error('API_BASE_URL is required in .env')
    }
    this.client = new OpenAI({ apiKey, baseURL })
  }

  async call(
    messages: ChatMessage[],
    onToken: (token: string) => void
  ): Promise<AgentResponse> {
    let fullContent = ''
    let reasoningContent = ''
    let inputTokens = 0
    let outputTokens = 0

    const maxTokens = parseInt(process.env.MAX_TOKENS || '4096', 10)

    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: this.config.systemPrompt },
        ...messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as { content?: string; reasoning_content?: string } | undefined
      if (delta?.content) {
        fullContent += delta.content
        onToken(delta.content)
      }
      // 推理模型（如 glm-5）的正文走 reasoning_content，单独累积作为兜底
      if (delta?.reasoning_content) {
        reasoningContent += delta.reasoning_content
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens
        outputTokens = chunk.usage.completion_tokens
      }
    }

    // 若模型只产出了 reasoning（content 为空），兜底使用 reasoning 内容，避免空回合导致角色错乱
    if (!fullContent.trim() && reasoningContent.trim()) {
      fullContent = reasoningContent.trim()
      onToken(fullContent)
    }

    return {
      content: fullContent,
      tokenUsage: { input: inputTokens, output: outputTokens },
    }
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config)
}
