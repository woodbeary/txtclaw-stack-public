import type { MoltbotEnv } from '../types'
import type { UserRecord } from './directory-do'

export type BridgeReply = {
  replyBody: string
  source: 'bridge_ai' | 'bridge_template'
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function extractGatewayText(payload: any): string | null {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  const output = Array.isArray(payload?.output) ? payload.output : []
  const parts: string[] = []
  for (const block of output) {
    const content = Array.isArray(block?.content) ? block.content : []
    for (const piece of content) {
      const text = typeof piece?.text === 'string' ? piece.text.trim() : ''
      if (text) parts.push(text)
    }
  }

  return parts.length ? parts.join('\n\n') : null
}

function trimBridgeText(value: string, max = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3).trim()}...`
}

function templateBridgeReply(user: UserRecord): string {
  const name = user.profileUserName?.trim()
  if (name) {
    return `On it, ${name}. Give me a moment and I will follow up shortly.`
  }
  return 'On it. Give me a moment and I will follow up shortly.'
}

async function buildBridgeReplyViaGateway(args: {
  env: MoltbotEnv
  user: UserRecord
  inboundBody: string
}): Promise<string | null> {
  const baseUrl = String(args.env.AI_GATEWAY_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
  const apiKey = String(args.env.AI_GATEWAY_API_KEY || args.env.OPENAI_API_KEY || '').trim()
  if (!baseUrl || !apiKey) return null

  const configuredModel = String(args.env.TXTCLAW_BRIDGE_MODEL || '').trim()
  const fallbackModel = String(args.env.AI_GATEWAY_MODEL || 'amazon/nova-lite').trim()
  const model = configuredModel || fallbackModel
  const maxOutputTokens = parsePositiveInt(args.env.TXTCLAW_BRIDGE_MAX_OUTPUT_TOKENS, 80)
  const timeoutMs = parsePositiveInt(args.env.TXTCLAW_BRIDGE_TIMEOUT_MS, 2500)

  const greetingName = args.user.profileUserName?.trim()
  const systemPrompt = [
    'You are a concise messaging assistant.',
    'Write one short acknowledgement that you are handling the request.',
    'Do not mention system status, warmup, providers, or internal routing.',
    'Do not claim completion.',
    'Do not include markdown or bullet points.',
    greetingName ? `If natural, address user as ${greetingName}.` : 'Keep it neutral and direct.',
  ].join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: systemPrompt }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: args.inboundBody }],
          },
        ],
        max_output_tokens: maxOutputTokens,
        temperature: 0.2,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`bridge gateway call failed (${res.status}): ${text}`)
    }

    const payload = (await res.json()) as any
    const text = extractGatewayText(payload)
    if (!text) return null
    const normalized = trimBridgeText(text)
    return normalized || null
  } finally {
    clearTimeout(timeout)
  }
}

export async function buildBridgeReply(args: {
  env: MoltbotEnv
  user: UserRecord
  inboundBody: string
}): Promise<BridgeReply> {
  try {
    const viaAi = await buildBridgeReplyViaGateway(args)
    if (viaAi) {
      return {
        replyBody: viaAi,
        source: 'bridge_ai',
      }
    }
  } catch (error) {
    console.error('[txtclaw] bridge ai reply failed; using template fallback:', error)
  }

  return {
    replyBody: templateBridgeReply(args.user),
    source: 'bridge_template',
  }
}
