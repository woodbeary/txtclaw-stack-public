import { getSandbox } from '@cloudflare/sandbox'
import { MOLTBOT_PORT } from '../config'
import { ensureMoltbotGateway } from '../gateway'
import type { MoltbotEnv } from '../types'
import { buildIdentityEnvelope } from './bootstrap'
import { putUser } from './directory-client'
import type { UserRecord } from './directory-do'
import { applyOutboundUsage, getLimitConfig, getUsageWarningLines } from './limits'
import { buildSandboxOptionsForTxtClawUser } from './runtime'
import { sendTwilioSms } from './twilio'

type OpenClawUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  model?: string
}

function buildTxtClawInstructions(user: UserRecord): string | undefined {
  const parts: string[] = []
  const identity = buildIdentityEnvelope(user)
  if (identity) parts.push(identity)

  const devPrompt = user.developerSystemPrompt?.trim()
  const isApiUser = user.from.startsWith('api:')

  const rules: string[] = [
    'TXT CLAW output requirements:',
    'Respond directly to the user message.',
    'Do not mention providers, model names, tokens, internal routing, or warmup.',
    'Do not mention file paths, internal directories, or command lines.',
    'Do not write files. If you would normally write something to a file, output the content inline instead.',
    'If you use tools, do not mention them.',
    'Do not use markdown or bullet points.',
    'If you are drafting a message (text/email), output ONLY the final message text.',
    'Keep responses concise. Ask at most one clarifying question when needed.',
  ]

  if (isApiUser || devPrompt) {
    // Developer API should be clean + deterministic; avoid tool side-effects.
    rules.splice(4, 0, 'Do not run code, browse the web, or use tools.')
  }

  parts.push(rules.join('\n'))

  if (devPrompt) {
    parts.push(['Developer system prompt:', devPrompt].join('\n'))
  }

  return parts.length ? parts.join('\n\n') : undefined
}

function extractTextFromResponse(payload: any): string | null {
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

function toNonNegativeInt(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function extractUsageFromResponse(payload: any): OpenClawUsage | null {
  const usage = payload?.usage || {}

  const inputTokens = toNonNegativeInt(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens,
  )
  const outputTokens = toNonNegativeInt(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens,
  )
  const totalFromPayload = toNonNegativeInt(usage.total_tokens ?? usage.totalTokens)
  const totalTokens = totalFromPayload > 0 ? totalFromPayload : inputTokens + outputTokens

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    model: typeof payload?.model === 'string' ? payload.model : undefined,
  }
}

function parseTokenRate(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value < 0) return fallback
  return value
}

function estimateTokenCostCents(usage: OpenClawUsage, env: MoltbotEnv): number {
  const inputRate = parseTokenRate(env.TXTCLAW_INPUT_TOKEN_COST_PER_1M_CENTS, 0)
  const outputRate = parseTokenRate(env.TXTCLAW_OUTPUT_TOKEN_COST_PER_1M_CENTS, 0)
  const inputCost = (usage.inputTokens / 1_000_000) * inputRate
  const outputCost = (usage.outputTokens / 1_000_000) * outputRate
  const total = inputCost + outputCost
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.ceil(total)
}

function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

async function requestOpenClawReply(args: {
  env: MoltbotEnv
  user: UserRecord
  input: string
  forceGatewayRestart?: boolean
  runtimeEnvOverrides?: Record<string, string>
  modelOverride?: string
}): Promise<{ reply: string; usage: OpenClawUsage | null }> {
  if (!args.user.sandboxKey || !args.user.r2Prefix) {
    throw new Error('Missing runtime identity for customer')
  }

  const options = buildSandboxOptionsForTxtClawUser(args.env, args.user.sandboxKey)
  const sandbox = getSandbox(args.env.Sandbox, args.user.sandboxKey, options)

  const runtimeOverrides = {
    ...(args.runtimeEnvOverrides || {}),
    MOLTBOT_R2_PREFIX: args.user.r2Prefix,
  }

  await ensureMoltbotGateway(sandbox, args.env, runtimeOverrides, {
    forceRestart: Boolean(args.forceGatewayRestart),
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (args.env.MOLTBOT_GATEWAY_TOKEN) {
    headers.Authorization = `Bearer ${args.env.MOLTBOT_GATEWAY_TOKEN}`
  }

  const explicitModel = args.env.TXTCLAW_OPENCLAW_MODEL?.trim()
  const gatewayModel = args.env.AI_GATEWAY_MODEL?.trim()
  const preferredModel = explicitModel || (gatewayModel ? `openai/${gatewayModel}` : 'openclaw:main')
  const modelOverride = args.modelOverride?.trim()
  const instructions = buildTxtClawInstructions(args.user)

  const basePayload: any = {
    model: modelOverride || preferredModel,
    // Use a TXTCLAW-specific session namespace so historical test sessions
    // pinned to other providers do not poison current model routing.
    user: `txtclaw:${args.user.from}`,
    input: args.input,
    instructions: instructions || undefined,
    metadata: {
      txtclaw_user: args.user.from,
      txtclaw_sandbox: args.user.sandboxKey,
      txtclaw_channel: args.user.from.startsWith('api:')
        ? 'api'
        : args.user.from.startsWith('zendesk')
          ? 'zendesk'
          : 'sms',
    },
  }

  // For developer/API usage we want plain text replies (no filesystem side-effects).
  // Disabling tools here prevents "I saved it to /root/..." style responses.
  const disableTools = args.user.from.startsWith('api:')
  const toolDisabledPayload = disableTools
    ? {
        ...basePayload,
        tools: [],
        tool_choice: 'none',
      }
    : basePayload

  async function callOpenClaw(payload: any): Promise<any> {
    const req = new Request('https://internal/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    const res = await sandbox.containerFetch(req, MOLTBOT_PORT)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`OpenClaw response request failed (${res.status}): ${text}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error('OpenClaw response payload was not valid JSON')
    }
  }

  const json: any = await callOpenClaw(toolDisabledPayload)

  const reply = extractTextFromResponse(json)
  if (!reply) {
    throw new Error('OpenClaw returned an empty response')
  }

  // Some stale gateway/provider states surface upstream 405s as plain text.
  // Treat this as a retriable infrastructure failure instead of user output.
  if (/^405 status code/i.test(reply.trim())) {
    throw new Error(`OpenClaw upstream placeholder error: ${reply.trim()}`)
  }

  return {
    reply,
    usage: extractUsageFromResponse(json),
  }
}

export async function prewarmDedicatedGateway(args: {
  env: MoltbotEnv
  user: UserRecord
  runtimeEnvOverrides?: Record<string, string>
  forceGatewayRestart?: boolean
}): Promise<void> {
  if (!args.user.sandboxKey || !args.user.r2Prefix) {
    throw new Error('Missing runtime identity for customer')
  }

  const options = buildSandboxOptionsForTxtClawUser(args.env, args.user.sandboxKey)
  const sandbox = getSandbox(args.env.Sandbox, args.user.sandboxKey, options)
  const runtimeOverrides = {
    ...(args.runtimeEnvOverrides || {}),
    MOLTBOT_R2_PREFIX: args.user.r2Prefix,
  }

  await ensureMoltbotGateway(sandbox, args.env, runtimeOverrides, {
    forceRestart: Boolean(args.forceGatewayRestart),
  })
}

function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value <= 0) return fallbackMs
  return Math.floor(value)
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function limitExceededReply(reason: string | undefined): string {
  if (reason === 'estimated_spend_cap') {
    return 'You reached this plan’s monthly usage budget. Reply HELP for upgrade options.'
  }
  return 'Usage limit reached for now. Reply HELP for options.'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export async function buildDedicatedReply(args: {
  env: MoltbotEnv
  user: UserRecord
  inboundBody: string
  skipOutboundAccounting?: boolean
  // Developer/API lane should fail closed (no warmup fallback replies).
  failHard?: boolean
  // Optional overrides for specific lanes (e.g. the public developer API).
  openclawTimeoutMs?: number
  openclawMaxAttempts?: number
  openclawRetryDelayMs?: number
  runtimeEnvOverrides?: Record<string, string>
  forceGatewayRestart?: boolean
  modelOverride?: string
  modelFallbackOverride?: string
}): Promise<{ replyBody: string; user: UserRecord }> {
  let replyBody = ''
  let nextUser = args.user

  try {
    const timeoutMs =
      typeof args.openclawTimeoutMs === 'number' &&
      Number.isFinite(args.openclawTimeoutMs) &&
      args.openclawTimeoutMs > 0
        ? Math.floor(args.openclawTimeoutMs)
        : parseTimeoutMs(args.env.TXTCLAW_OPENCLAW_TIMEOUT_MS, 20000)
    const maxAttempts =
      typeof args.openclawMaxAttempts === 'number' &&
      Number.isFinite(args.openclawMaxAttempts) &&
      args.openclawMaxAttempts > 0
        ? Math.floor(args.openclawMaxAttempts)
        : parsePositiveInt(args.env.TXTCLAW_OPENCLAW_MAX_ATTEMPTS, 3)
    const retryDelayMs =
      typeof args.openclawRetryDelayMs === 'number' &&
      Number.isFinite(args.openclawRetryDelayMs) &&
      args.openclawRetryDelayMs >= 0
        ? Math.floor(args.openclawRetryDelayMs)
        : parsePositiveInt(args.env.TXTCLAW_OPENCLAW_RETRY_DELAY_MS, 1500)
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const modelForAttempt =
          attempt === 1 ? args.modelOverride : args.modelFallbackOverride || args.modelOverride
        const result = await withTimeout(
          requestOpenClawReply({
            env: args.env,
            user: args.user,
            input: args.inboundBody,
            runtimeEnvOverrides: args.runtimeEnvOverrides,
            modelOverride: modelForAttempt,
            forceGatewayRestart: Boolean(args.forceGatewayRestart) || attempt > 1,
          }),
          timeoutMs,
          `OpenClaw attempt ${attempt}`,
        )
        replyBody = result.reply
        const usage = result.usage
        if (usage) {
          const month = utcMonth()
          const sameMonth = nextUser.usageMonth === month
          const inputMonth = (sameMonth ? nextUser.llmInputTokensMonth || 0 : 0) + usage.inputTokens
          const outputMonth = (sameMonth ? nextUser.llmOutputTokensMonth || 0 : 0) + usage.outputTokens
          const totalMonth = (sameMonth ? nextUser.llmTotalTokensMonth || 0 : 0) + usage.totalTokens
          const llmCostCents = estimateTokenCostCents(usage, args.env)
          const llmCostMonth = (sameMonth ? nextUser.llmEstimatedCostCentsMonth || 0 : 0) + llmCostCents
          const estimatedSpendCentsMonth =
            (sameMonth ? nextUser.estimatedSpendCentsMonth || 0 : 0) + llmCostCents

          nextUser = {
            ...nextUser,
            llmInputTokensMonth: inputMonth,
            llmOutputTokensMonth: outputMonth,
            llmTotalTokensMonth: totalMonth,
            llmEstimatedCostCentsMonth: llmCostMonth,
            estimatedSpendCentsMonth,
            lastModelUsed: usage.model || nextUser.lastModelUsed,
            lastLlmUsageAt: new Date().toISOString(),
          }
        }
        lastError = null
        break
      } catch (error) {
        lastError = error
        console.error(`[txtclaw] OpenClaw processing error on attempt ${attempt}/${maxAttempts}:`, error)
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs * Math.pow(2, attempt - 1))
        }
      }
    }

    if (lastError) {
      throw lastError
    }
  } catch (error) {
    console.error('[txtclaw] OpenClaw processing error:', error)
    if (args.failHard) {
      throw error
    }
    replyBody =
      'Your agent is warming up (usually about 2 minutes). We will ping you here as soon as it is ready.'
  }

  if (!args.skipOutboundAccounting) {
    const limits = getLimitConfig(args.env)
    const outbound = applyOutboundUsage(nextUser, limits)
    nextUser = outbound.user

    if (!outbound.allowed) {
      replyBody = limitExceededReply(outbound.reason)
    } else {
      const warnings = getUsageWarningLines(nextUser, limits)
      if (warnings.length > 0) {
        replyBody = `${replyBody}\n\n${warnings.join('\n')}`
      }
    }
  }

  return { replyBody, user: nextUser }
}

export async function processDedicatedInboundMessage(args: {
  env: MoltbotEnv
  user: UserRecord
  inboundBody: string
}): Promise<void> {
  if (!args.user.dedicatedNumber) {
    throw new Error('User has no dedicated number')
  }
  if (args.user.optedOutAt) {
    return
  }
  if (!args.env.TWILIO_ACCOUNT_SID || !args.env.TWILIO_API_KEY_SID || !args.env.TWILIO_API_KEY_SECRET) {
    throw new Error('Missing Twilio API credentials')
  }

  const generated = await buildDedicatedReply(args)
  let replyBody = generated.replyBody
  let nextUser = generated.user

  const twilioMaxAttempts = parsePositiveInt(args.env.TXTCLAW_TWILIO_SEND_MAX_ATTEMPTS, 3)
  const twilioRetryDelayMs = parsePositiveInt(args.env.TXTCLAW_TWILIO_SEND_RETRY_DELAY_MS, 1000)
  let twilioError: unknown

  for (let attempt = 1; attempt <= twilioMaxAttempts; attempt += 1) {
    try {
      await sendTwilioSms({
        accountSid: args.env.TWILIO_ACCOUNT_SID,
        apiKeySid: args.env.TWILIO_API_KEY_SID,
        apiKeySecret: args.env.TWILIO_API_KEY_SECRET,
        from: args.user.dedicatedNumber,
        to: args.user.from,
        body: replyBody,
        statusCallbackUrl: args.env.TWILIO_STATUS_CALLBACK_URL,
      })
      twilioError = null
      break
    } catch (error) {
      twilioError = error
      console.error(`[txtclaw] Twilio send failed on attempt ${attempt}/${twilioMaxAttempts}:`, error)
      if (attempt < twilioMaxAttempts) {
        await sleep(twilioRetryDelayMs * Math.pow(2, attempt - 1))
      }
    }
  }

  if (twilioError) {
    await putUser(args.env, {
      ...nextUser,
      lastOutboundErrorAt: new Date().toISOString(),
      lastOutboundError: errorMessage(twilioError),
    })
    throw twilioError
  }

  await putUser(args.env, {
    ...nextUser,
    lastOutboundAt: new Date().toISOString(),
    lastOutboundErrorAt: undefined,
    lastOutboundError: undefined,
  })
}
