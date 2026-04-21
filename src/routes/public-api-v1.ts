import { Hono } from 'hono'
import { buildDedicatedReply, prewarmDedicatedGateway } from '../txtclaw/agent'
import { decryptSecret, encryptSecret, fingerprintSecret } from '../txtclaw/credentials'
import {
  clearApiKeyByok,
  getActivePromptVersion,
  getApiKeyById,
  getUser,
  lookupApiKey,
  putUser,
  rateLimitBatch,
  setApiKeyByok,
} from '../txtclaw/directory-client'
import type { UserRecord } from '../txtclaw/directory-do'
import { applyInboundUsage, getLimitConfig, getUsageWarningLines } from '../txtclaw/limits'
import {
  deriveApiKeyRuntimeIdentity,
  deriveHostedApiRuntimeIdentity,
  deriveRuntimeIdentity,
} from '../txtclaw/runtime'
import { putTrace } from '../txtclaw/traces-client'
import type { TraceRecord } from '../txtclaw/traces-do'
import type { AppEnv } from '../types'

type SmsMode = 'none' | 'sandbox' | 'managed' | 'byo_twilio'
type SmsStatus = 'disabled' | 'needs_compliance' | 'pending' | 'active' | 'needs_setup'

type LlmMode = 'hosted' | 'byok'
type LlmTier = 'fast' | 'smart'
type LlmProvider = 'openai_compat' | 'openai' | 'anthropic'

type CreateAgentBody = {
  system_prompt?: string
  customer_ref?: string
  metadata?: Record<string, unknown>
  sms?: { mode?: SmsMode }
  llm?: {
    mode?: LlmMode
    tier?: LlmTier
    model?: string
    provider?: LlmProvider
    base_url?: string
    api_key?: string
    label?: string
  }
}

type SendMessageBody = {
  text?: string
  user_ref?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function isTrue(raw: string | undefined): boolean {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  return value === 'true' || value === '1' || value === 'yes' || value === 'on'
}

function parseKeys(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function parseOrigins(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function parseBearer(auth: string | undefined): string | null {
  const value = String(auth || '').trim()
  if (!value) return null
  const prefix = 'bearer '
  if (value.toLowerCase().startsWith(prefix)) {
    const token = value.slice(prefix.length).trim()
    return token || null
  }
  return null
}

function buildSmsStatus(mode: SmsMode | undefined, env: AppEnv['Bindings']): SmsStatus | undefined {
  if (!mode || mode === 'none') return 'disabled'
  if (mode === 'sandbox') {
    return isTrue(env.TXTCLAW_PUBLIC_API_SMS_SANDBOX_ENABLED) ? 'pending' : 'disabled'
  }
  if (mode === 'managed') return 'needs_compliance'
  if (mode === 'byo_twilio') return 'needs_setup'
  return 'disabled'
}

function buildCannedSmsStatus(mode: SmsMode | undefined, env: AppEnv['Bindings']) {
  const status = buildSmsStatus(mode, env)
  return status ? { status } : undefined
}

function makeAgentId(): string {
  const id = crypto.randomUUID().replace(/-/g, '')
  return `agt_${id}`
}

function makeTraceId(): string {
  const id = crypto.randomUUID().replace(/-/g, '')
  return `trc_${id}`
}

export const publicApiV1 = new Hono<AppEnv>()

function logApi(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      scope: 'txtclaw_api',
      event,
      at: new Date().toISOString(),
      ...fields,
    }),
  )
}

function extractAgentIdFromPathname(pathname: string): string | undefined {
  const match = pathname.match(/agt_[a-f0-9]+/)
  return match ? match[0] : undefined
}

function scheduleTracePersist(c: any, trace: TraceRecord) {
  if (!c?.env?.TXTCLAW_TRACES) return
  const exec = c.executionCtx || c?.executionCtx || (c as any).executionCtx
  if (!exec || typeof exec.waitUntil !== 'function') return

  exec.waitUntil(
    putTrace(c.env, trace).catch((err) => {
      console.error('[txtclaw] trace persist failed:', err instanceof Error ? err.message : String(err))
    }),
  )
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

type ApiPlan = 'free' | 'pro' | 'max' | 'byok'

function normalizeApiPlan(raw: unknown): ApiPlan {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  if (value === 'pro' || value === 'max' || value === 'byok') return value
  return 'free'
}

function resolvePlanRateLimits(
  env: AppEnv['Bindings'],
  plan: ApiPlan,
): { rpmPerKey: number; rpmPerIp: number; reqPerDayPerKey: number } {
  const free = {
    rpmPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_KEY, 60),
    rpmPerIp: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_IP, 120),
    reqPerDayPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY, 1000),
  }

  if (plan === 'pro') {
    return {
      rpmPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_KEY_PRO, 300),
      rpmPerIp: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_IP_PRO, 500),
      reqPerDayPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_PRO, 10_000),
    }
  }

  if (plan === 'max') {
    return {
      rpmPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_KEY_MAX, 600),
      rpmPerIp: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_IP_MAX, 1000),
      reqPerDayPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_MAX, 50_000),
    }
  }

  if (plan === 'byok') {
    return {
      rpmPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_KEY_BYOK, 600),
      rpmPerIp: parsePositiveInt(env.TXTCLAW_PUBLIC_API_RPM_PER_IP_BYOK, 1000),
      reqPerDayPerKey: parsePositiveInt(env.TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_BYOK, 50_000),
    }
  }

  return free
}

function clientIpFromHeaders(headers: Headers): string | null {
  const direct = headers.get('cf-connecting-ip')
  if (direct && direct.trim()) return direct.trim()
  const forwarded = headers.get('x-forwarded-for')
  if (!forwarded) return null
  const first = forwarded.split(',')[0]?.trim()
  return first || null
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  if (value.length > 400) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

function byokEnabled(env: AppEnv['Bindings']): boolean {
  return isTrue(env.TXTCLAW_BYOK_ENABLED) && Boolean(env.TXTCLAW_CREDENTIALS_MASTER_KEY?.trim())
}

function getMasterKey(env: AppEnv['Bindings']): string | null {
  const raw = env.TXTCLAW_CREDENTIALS_MASTER_KEY?.trim() || ''
  return raw ? raw : null
}

function prewarmOnCreateEnabled(env: AppEnv['Bindings']): boolean {
  const raw = env.TXTCLAW_PUBLIC_API_PREWARM_ON_CREATE
  // Default: prewarm for better "1 minute to first reply" DX.
  if (raw === undefined || raw === null || String(raw).trim() === '') return true
  return isTrue(raw)
}

function requireDirectoryKey(
  c: any,
): { ok: true; keyId: string; userId: string } | { ok: false; res: Response } {
  const keyId = String(c.get('apiKeyId') || '').trim()
  const userId = String(c.get('apiKeyUserId') || '').trim()
  const kind = String(c.get('apiKeyAuthKind') || '').trim()

  if (!keyId) {
    return { ok: false, res: c.json({ error: 'unauthorized', trace_id: c.get('traceId') }, 401) }
  }
  if (kind !== 'directory' || !userId) {
    return {
      ok: false,
      res: c.json(
        {
          error: 'forbidden',
          message: 'This endpoint requires a dashboard-issued API key.',
          trace_id: c.get('traceId'),
        },
        403,
      ),
    }
  }
  return { ok: true, keyId, userId }
}

// CORS + preflight
publicApiV1.use('*', async (c, next) => {
  const allowed = parseOrigins(c.env.TXTCLAW_PUBLIC_API_CORS_ORIGINS)
  const origin = c.req.header('Origin')

  // Default: do not emit CORS headers. This is a server-to-server API.
  if (origin && allowed.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    c.header('Access-Control-Max-Age', '86400')
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204)
  }

  return next()
})

// Trace id + request logging
publicApiV1.use('*', async (c, next) => {
  const traceId = makeTraceId()
  const startMs = Date.now()
  const pathname = new URL(c.req.url).pathname
  const method = c.req.method
  const ray = c.req.header('cf-ray')
  const ip = clientIpFromHeaders(c.req.raw.headers)
  const ipHash = ip ? (await sha256Hex(ip)).slice(0, 16) : null

  c.set('traceId', traceId)
  c.set('ipHash', ipHash)
  c.header('x-txtclaw-trace-id', traceId)
  c.header('Cache-Control', 'no-store')

  logApi('request', {
    traceId,
    method,
    pathname,
    ray,
    ipHash,
  })

  try {
    const res = await next()
    const elapsedMs = Date.now() - startMs
    logApi('response', {
      traceId,
      method,
      pathname,
      status: c.res.status,
      elapsedMs,
    })

    scheduleTracePersist(c, {
      traceId,
      startedAt: new Date(startMs).toISOString(),
      endedAt: nowIso(),
      method,
      pathname,
      status: c.res.status,
      elapsedMs,
      ray: ray || undefined,
      ipHash,
      apiKeyId: String(c.get('apiKeyId') || '').trim() || undefined,
      apiKeyUserId: String(c.get('apiKeyUserId') || '').trim() || undefined,
      apiKeyAuthKind: (c.get('apiKeyAuthKind') as any) || undefined,
      agentId: extractAgentIdFromPathname(pathname),
      llmMode: (c.get('txtclawLlmMode') as any) || undefined,
      llmTier: (c.get('txtclawLlmTier') as any) || undefined,
      modelUsed: String(c.get('txtclawModelUsed') || '').trim() || undefined,
      promptVersionId: String(c.get('txtclawPromptVersionId') || '').trim() || undefined,
    })
    return res
  } catch (error) {
    const elapsedMs = Date.now() - startMs
    logApi('error', {
      traceId,
      method,
      pathname,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
    })

    scheduleTracePersist(c, {
      traceId,
      startedAt: new Date(startMs).toISOString(),
      endedAt: nowIso(),
      method,
      pathname,
      status: 500,
      elapsedMs,
      ray: ray || undefined,
      ipHash,
      apiKeyId: String(c.get('apiKeyId') || '').trim() || undefined,
      apiKeyUserId: String(c.get('apiKeyUserId') || '').trim() || undefined,
      apiKeyAuthKind: (c.get('apiKeyAuthKind') as any) || undefined,
      agentId: extractAgentIdFromPathname(pathname),
      llmMode: (c.get('txtclawLlmMode') as any) || undefined,
      llmTier: (c.get('txtclawLlmTier') as any) || undefined,
      modelUsed: String(c.get('txtclawModelUsed') || '').trim() || undefined,
      promptVersionId: String(c.get('txtclawPromptVersionId') || '').trim() || undefined,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
})

// Auth allowlist for the public developer API
publicApiV1.use('*', async (c, next) => {
  if (!isTrue(c.env.TXTCLAW_PUBLIC_API_ENABLED)) {
    return c.json({ error: 'not_found', trace_id: c.get('traceId') }, 404)
  }

  const keys = parseKeys(c.env.TXTCLAW_PUBLIC_API_KEYS)
  const token = parseBearer(c.req.header('Authorization'))
  if (!token) {
    return c.json({ error: 'unauthorized', trace_id: c.get('traceId') }, 401)
  }

  // Backward compatible allowlist path (used for staged rollouts).
  if (keys.length > 0 && keys.includes(token)) {
    const keyIndex = Math.max(0, keys.indexOf(token))
    c.set('apiKeyId', `allowlist_${keyIndex + 1}`)
    c.set('apiKeyAuthKind', 'allowlist')
    return next()
  }

  const keyHash = await sha256Hex(token)
  const ipHash = c.get('ipHash') as string | null | undefined
  const lookup = await lookupApiKey(c.env, { keyHash, ipHash })
  if (!lookup) {
    return c.json({ error: 'unauthorized', trace_id: c.get('traceId') }, 401)
  }

  c.set('apiKeyId', lookup.keyId)
  c.set('apiKeyUserId', lookup.userId)
  c.set('apiKeyPlan', normalizeApiPlan(lookup.plan))
  c.set('apiKeyAuthKind', 'directory')
  return next()
})

// Rate limiting (fixed windows stored in the Directory durable object)
publicApiV1.use('*', async (c, next) => {
  const traceId = c.get('traceId') as string | undefined
  const keyId = c.get('apiKeyId') as string | undefined
  const ipHash = c.get('ipHash') as string | null | undefined
  const pathname = new URL(c.req.url).pathname

  if (!keyId) {
    return c.json({ error: 'unauthorized', trace_id: traceId }, 401)
  }

  const plan = normalizeApiPlan(c.get('apiKeyPlan'))
  const { rpmPerKey, rpmPerIp, reqPerDayPerKey } = resolvePlanRateLimits(c.env, plan)
  const createPerDayPerKey = parsePositiveInt(c.env.TXTCLAW_PUBLIC_API_CREATE_PER_DAY_PER_KEY, 50)
  const createPerMinPerIp = parsePositiveInt(c.env.TXTCLAW_PUBLIC_API_CREATE_PER_MIN_PER_IP, 10)

  const items = [
    { key: `api:req:key:${keyId}`, windowMs: 60_000, limit: rpmPerKey, cost: 1 },
    { key: `api:req:ip:${ipHash || 'unknown'}`, windowMs: 60_000, limit: rpmPerIp, cost: 1 },
    { key: `api:req_day:key:${keyId}`, windowMs: 86_400_000, limit: reqPerDayPerKey, cost: 1 },
  ]

  const isCreateAgent = c.req.method === 'POST' && (pathname === '/agents' || pathname === '/v1/agents')
  if (isCreateAgent) {
    items.push({ key: `api:create:key:${keyId}`, windowMs: 86_400_000, limit: createPerDayPerKey, cost: 1 })
    items.push({
      key: `api:create:ip:${ipHash || 'unknown'}`,
      windowMs: 60_000,
      limit: createPerMinPerIp,
      cost: 1,
    })
  }

  const results = await rateLimitBatch(c.env, items)
  const denied = results.find((r) => !r.allowed)
  if (denied) {
    const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json(
      {
        error: 'rate_limited',
        limit_key: denied.key,
        trace_id: traceId,
      },
      429,
    )
  }

  return next()
})

publicApiV1.onError((err, c) => {
  const traceId = c.get('traceId') as string | undefined
  logApi('unhandled_error', {
    traceId,
    error: err instanceof Error ? err.message : String(err),
  })
  return c.json({ error: 'internal_error', trace_id: traceId }, 500)
})

publicApiV1.get('/status', (c) => {
  return c.json({
    ok: true,
    service: 'txtclaw',
    version: 'v1',
    mode: 'preview',
    trace_id: c.get('traceId'),
  })
})

publicApiV1.post('/warmup', async (c) => {
  type WarmupBody = { mode?: LlmMode } | null

  let body: WarmupBody = null
  const raw = c.req.raw
  // Allow empty body for convenience.
  if (raw.headers.get('content-length') && raw.headers.get('content-length') !== '0') {
    try {
      body = (await c.req.json()) as any
    } catch {
      return c.json({ error: 'invalid_json', trace_id: c.get('traceId') }, 400)
    }
  }

  const modeRaw = String((body as any)?.mode || '')
    .trim()
    .toLowerCase()
  const mode: LlmMode = modeRaw === 'byok' ? 'byok' : 'hosted'

  const keyId = String(c.get('apiKeyId') || '').trim()
  const warmupPerHour = parsePositiveInt(c.env.TXTCLAW_PUBLIC_API_WARMUP_PER_HOUR_PER_KEY, 3)
  const rl = await rateLimitBatch(c.env, [
    {
      key: `api:warmup:${mode}:${keyId || 'unknown'}`,
      windowMs: 60 * 60 * 1000,
      limit: warmupPerHour,
      cost: 1,
    },
  ])
  const denied = rl.find((r) => !r.allowed)
  if (denied) {
    const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json({ error: 'rate_limited', trace_id: c.get('traceId') }, 429)
  }

  const createdAt = nowIso()

  if (mode === 'hosted') {
    const runtime = deriveHostedApiRuntimeIdentity()
    const warmUser: UserRecord = {
      from: `apiwarm:hosted:${keyId || 'unknown'}`,
      status: 'active',
      sandboxKey: runtime.sandboxKey,
      r2Prefix: runtime.r2Prefix,
      createdAt,
      updatedAt: createdAt,
    }

    await prewarmDedicatedGateway({ env: c.env, user: warmUser })
    return c.json({ ok: true, warmed: true, mode: 'hosted', trace_id: c.get('traceId') }, 200)
  }

  // BYOK warmup: starts the BYOK gateway for this API key (if configured).
  if (!byokEnabled(c.env)) {
    return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
  }

  const auth = requireDirectoryKey(c)
  if (!auth.ok) return auth.res

  const lookedUp = await getApiKeyById(c.env, { userId: auth.userId, keyId: auth.keyId })
  const byok = lookedUp.byok
  if (!byok?.keyEnc) {
    return c.json({ error: 'byok_not_configured', trace_id: c.get('traceId') }, 409)
  }

  const master = getMasterKey(c.env)
  if (!master) {
    return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
  }

  const plaintextKey = await decryptSecret({
    masterKeyB64Url: master,
    keyId: auth.keyId,
    ciphertext: byok.keyEnc,
  })

  const provider = String(byok.provider || '').trim()
  if (provider !== 'openai_compat' && provider !== 'openai' && provider !== 'anthropic') {
    return c.json({ error: 'byok_invalid_provider', trace_id: c.get('traceId') }, 409)
  }

  const baseUrl = typeof byok.baseUrl === 'string' ? byok.baseUrl.trim() : ''
  const runtimeEnvOverrides: Record<string, string> =
    provider === 'anthropic'
      ? {
          ANTHROPIC_API_KEY: plaintextKey,
          AI_GATEWAY_BASE_URL: baseUrl || '',
          AI_GATEWAY_MODEL: '',
          TXTCLAW_FORCE_OPENAI_COMPAT: '',
          OPENAI_BASE_URL: '',
          ANTHROPIC_BASE_URL: baseUrl || '',
        }
      : {
          OPENAI_API_KEY: plaintextKey,
          ...(baseUrl ? { AI_GATEWAY_BASE_URL: baseUrl, OPENAI_BASE_URL: baseUrl } : {}),
        }

  const runtime = deriveApiKeyRuntimeIdentity(auth.keyId)
  const warmUser: UserRecord = {
    from: `apiwarm:byok:${auth.keyId}`,
    status: 'active',
    sandboxKey: runtime.sandboxKey,
    r2Prefix: runtime.r2Prefix,
    createdAt,
    updatedAt: createdAt,
  }

  await prewarmDedicatedGateway({
    env: c.env,
    user: warmUser,
    runtimeEnvOverrides,
    forceGatewayRestart: true,
  })
  return c.json({ ok: true, warmed: true, mode: 'byok', trace_id: c.get('traceId') }, 200)
})

publicApiV1.get('/byok', async (c) => {
  const auth = requireDirectoryKey(c)
  if (!auth.ok) return auth.res

  const { keyId, userId } = auth
  const lookedUp = await getApiKeyById(c.env, { userId, keyId })
  const byok = lookedUp.byok?.keyEnc
    ? {
        provider: lookedUp.byok.provider,
        base_url: lookedUp.byok.baseUrl,
        model: lookedUp.byok.model,
        fingerprint: lookedUp.byok.fingerprint,
        updated_at: lookedUp.byok.updatedAt,
      }
    : null

  return c.json({ ok: true, byok, trace_id: c.get('traceId') }, 200)
})

publicApiV1.put('/byok', async (c) => {
  if (!byokEnabled(c.env)) {
    return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
  }

  const auth = requireDirectoryKey(c)
  if (!auth.ok) return auth.res
  const { keyId, userId } = auth

  let body: {
    provider?: LlmProvider
    api_key?: string
    base_url?: string
    model?: string
    label?: string
  } | null = null
  try {
    body = (await c.req.json()) as any
  } catch {
    return c.json({ error: 'invalid_json', trace_id: c.get('traceId') }, 400)
  }

  const provider = String(body?.provider || '').trim() as LlmProvider
  if (provider !== 'openai_compat' && provider !== 'openai' && provider !== 'anthropic') {
    return c.json({ error: 'invalid_provider', trace_id: c.get('traceId') }, 400)
  }

  const apiKeyPlain = String(body?.api_key || '').trim()
  if (!apiKeyPlain) return c.json({ error: 'missing_api_key', trace_id: c.get('traceId') }, 400)

  const baseUrlRaw = body?.base_url
  const baseUrl = normalizeUrl(baseUrlRaw)
  if (baseUrlRaw !== undefined && baseUrlRaw !== null && String(baseUrlRaw).trim() && !baseUrl) {
    return c.json({ error: 'invalid_base_url', trace_id: c.get('traceId') }, 400)
  }

  const model = body?.model !== undefined && body?.model !== null ? String(body.model).trim() : ''
  if (model && model.length > 200) {
    return c.json({ error: 'invalid_model', trace_id: c.get('traceId') }, 400)
  }

  const label = body?.label !== undefined && body?.label !== null ? String(body.label).trim() : ''
  if (label && label.length > 60) {
    return c.json({ error: 'invalid_label', trace_id: c.get('traceId') }, 400)
  }

  const byokLimit = parsePositiveInt(c.env.TXTCLAW_BYOK_SET_PER_HOUR_PER_KEY, 5)
  const rl = await rateLimitBatch(c.env, [
    { key: `api:byok:set:${keyId}`, windowMs: 60 * 60 * 1000, limit: byokLimit, cost: 1 },
  ])
  const denied = rl.find((r) => !r.allowed)
  if (denied) {
    const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json({ error: 'rate_limited', trace_id: c.get('traceId') }, 429)
  }

  const master = getMasterKey(c.env)
  if (!master) {
    return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
  }

  const apiKeyEnc = await encryptSecret({
    masterKeyB64Url: master,
    keyId,
    plaintext: apiKeyPlain,
  })
  const fingerprint = await fingerprintSecret(apiKeyPlain)
  const updatedAt = nowIso()

  await setApiKeyByok(c.env, {
    userId,
    keyId,
    provider,
    apiKeyEnc,
    baseUrl,
    model: model || undefined,
    label: label || undefined,
    fingerprint,
  })

  return c.json(
    {
      ok: true,
      byok: {
        provider,
        base_url: baseUrl,
        model: model || undefined,
        fingerprint,
        updated_at: updatedAt,
      },
      trace_id: c.get('traceId'),
    },
    200,
  )
})

publicApiV1.delete('/byok', async (c) => {
  const auth = requireDirectoryKey(c)
  if (!auth.ok) return auth.res

  const { keyId, userId } = auth
  await clearApiKeyByok(c.env, { userId, keyId })
  return c.json({ ok: true, trace_id: c.get('traceId') }, 200)
})

publicApiV1.post('/agents', async (c) => {
  let body: CreateAgentBody | null = null
  try {
    body = (await c.req.json()) as CreateAgentBody
  } catch {
    return c.json({ error: 'invalid_json', trace_id: c.get('traceId') }, 400)
  }

  const agentId = makeAgentId()
  const from = `api:${agentId}`
  const createdAt = nowIso()

  let systemPrompt: string | undefined
  let promptVersionId: string | undefined
  if (body?.system_prompt !== undefined && body?.system_prompt !== null) {
    if (typeof body.system_prompt !== 'string') {
      return c.json({ error: 'invalid_system_prompt', trace_id: c.get('traceId') }, 400)
    }
    const trimmed = body.system_prompt.trim()
    if (trimmed.length > 2000) {
      return c.json({ error: 'system_prompt_too_long', trace_id: c.get('traceId') }, 400)
    }
    systemPrompt = trimmed || undefined
  }

  if (!systemPrompt) {
    const active = await getActivePromptVersion(c.env)
    systemPrompt = active.content
    promptVersionId = active.id
    c.set('txtclawPromptVersionId', promptVersionId)
  }

  let customerRef: string | undefined
  if (body?.customer_ref !== undefined && body?.customer_ref !== null) {
    if (typeof body.customer_ref !== 'string') {
      return c.json({ error: 'invalid_customer_ref', trace_id: c.get('traceId') }, 400)
    }
    const trimmed = body.customer_ref.trim()
    if (trimmed.length > 200) {
      return c.json({ error: 'customer_ref_too_long', trace_id: c.get('traceId') }, 400)
    }
    customerRef = trimmed || undefined
  }

  let metadata: Record<string, unknown> | undefined
  if (body?.metadata !== undefined && body?.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return c.json({ error: 'invalid_metadata', trace_id: c.get('traceId') }, 400)
    }
    metadata = body.metadata
    const raw = JSON.stringify(metadata)
    if (raw.length > 4000) {
      return c.json({ error: 'metadata_too_large', trace_id: c.get('traceId') }, 400)
    }
  }

  const ownerApiKeyId = String(c.get('apiKeyId') || '').trim() || undefined
  const ownerUserId = String(c.get('apiKeyUserId') || '').trim() || undefined

  const llm = body?.llm
  const llmModeRaw = String(llm?.mode || '')
    .trim()
    .toLowerCase()
  const llmTierRaw = String(llm?.tier || '')
    .trim()
    .toLowerCase()
  const llmMode: LlmMode = llmModeRaw === 'byok' ? 'byok' : 'hosted'
  const llmTier: LlmTier = llmTierRaw === 'smart' ? 'smart' : 'fast'
  c.set('txtclawLlmMode', llmMode)
  c.set('txtclawLlmTier', llmTier)

  const llmModel = llm?.model !== undefined && llm?.model !== null ? String(llm.model).trim() : ''
  if (llmModel && llmModel.length > 200) {
    return c.json({ error: 'invalid_llm_model', trace_id: c.get('traceId') }, 400)
  }

  const llmProvider = llm?.provider !== undefined && llm?.provider !== null ? String(llm.provider).trim() : ''
  const provider = llmProvider as LlmProvider
  if (llmProvider && provider !== 'openai_compat' && provider !== 'openai' && provider !== 'anthropic') {
    return c.json({ error: 'invalid_llm_provider', trace_id: c.get('traceId') }, 400)
  }

  const llmBaseUrlRaw = llm?.base_url
  const llmBaseUrl = normalizeUrl(llmBaseUrlRaw)
  if (llmBaseUrlRaw !== undefined && llmBaseUrlRaw !== null && String(llmBaseUrlRaw).trim() && !llmBaseUrl) {
    return c.json({ error: 'invalid_llm_base_url', trace_id: c.get('traceId') }, 400)
  }

  const llmApiKeyPlain = llm?.api_key !== undefined && llm?.api_key !== null ? String(llm.api_key).trim() : ''
  const llmLabel = llm?.label !== undefined && llm?.label !== null ? String(llm.label).trim() : ''
  if (llmLabel && llmLabel.length > 60) {
    return c.json({ error: 'invalid_llm_label', trace_id: c.get('traceId') }, 400)
  }

  if (llmApiKeyPlain && llmMode !== 'byok') {
    return c.json({ error: 'llm_api_key_requires_byok_mode', trace_id: c.get('traceId') }, 400)
  }

  if (llmMode === 'byok') {
    if (!byokEnabled(c.env)) {
      return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
    }

    const auth = requireDirectoryKey(c)
    if (!auth.ok) return auth.res

    if (llmApiKeyPlain) {
      const byokLimit = parsePositiveInt(c.env.TXTCLAW_BYOK_SET_PER_HOUR_PER_KEY, 5)
      const rl = await rateLimitBatch(c.env, [
        { key: `api:byok:set:${auth.keyId}`, windowMs: 60 * 60 * 1000, limit: byokLimit, cost: 1 },
      ])
      const denied = rl.find((r) => !r.allowed)
      if (denied) {
        const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
        c.header('Retry-After', String(retryAfterSeconds))
        return c.json({ error: 'rate_limited', trace_id: c.get('traceId') }, 429)
      }

      if (!provider) {
        return c.json({ error: 'missing_llm_provider', trace_id: c.get('traceId') }, 400)
      }

      const master = getMasterKey(c.env)
      if (!master) {
        return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
      }

      const apiKeyEnc = await encryptSecret({
        masterKeyB64Url: master,
        keyId: auth.keyId,
        plaintext: llmApiKeyPlain,
      })
      const fingerprint = await fingerprintSecret(llmApiKeyPlain)
      await setApiKeyByok(c.env, {
        userId: auth.userId,
        keyId: auth.keyId,
        provider,
        apiKeyEnc,
        baseUrl: llmBaseUrl,
        model: llmModel || undefined,
        label: llmLabel || undefined,
        fingerprint,
      })
    } else {
      const lookedUp = await getApiKeyById(c.env, { userId: auth.userId, keyId: auth.keyId })
      if (!lookedUp.byok?.keyEnc) {
        return c.json({ error: 'byok_not_configured', trace_id: c.get('traceId') }, 409)
      }
    }
  }

  const runtime =
    llmMode === 'hosted'
      ? deriveHostedApiRuntimeIdentity()
      : ownerApiKeyId
        ? deriveApiKeyRuntimeIdentity(ownerApiKeyId)
        : deriveRuntimeIdentity(from)

  const user: UserRecord = {
    from,
    status: 'active',
    sandboxKey: runtime.sandboxKey,
    r2Prefix: runtime.r2Prefix,
    developerSystemPrompt: systemPrompt,
    developerSystemPromptVersionId: promptVersionId,
    developerCustomerRef: customerRef,
    developerMetadata: metadata,
    developerOwnerApiKeyId: ownerApiKeyId,
    developerOwnerUserId: ownerUserId,
    developerLlmMode: llmMode,
    developerLlmTier: llmTier,
    developerLlmModel: llmModel || undefined,
    developerLlmProvider: provider || undefined,
    developerLlmBaseUrl: llmBaseUrl || undefined,
    createdAt,
    updatedAt: createdAt,
  }

  await putUser(c.env, user)

  if (prewarmOnCreateEnabled(c.env)) {
    let exec: any = null
    try {
      exec = (c as any).executionCtx
    } catch {
      exec = null
    }
    if (exec && typeof exec.waitUntil === 'function') {
      exec.waitUntil(
        prewarmDedicatedGateway({ env: c.env, user }).catch((err) => {
          logApi('prewarm_error', {
            traceId: c.get('traceId'),
            agentId,
            error: err instanceof Error ? err.message : String(err),
          })
        }),
      )
    }
  }

  const smsMode = body?.sms?.mode
  return c.json({
    agent_id: agentId,
    status: 'active',
    sms: buildCannedSmsStatus(smsMode, c.env),
    trace_id: c.get('traceId'),
  })
})

publicApiV1.get('/agents/:agentId', async (c) => {
  const agentId = c.req.param('agentId')
  const from = `api:${agentId}`
  const user = await getUser(c.env, from)
  if (!user) return c.json({ error: 'not_found', trace_id: c.get('traceId') }, 404)

  const smsStatus: SmsStatus = user.dedicatedNumber ? 'active' : 'disabled'
  return c.json({
    agent_id: agentId,
    status: user.status,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    sms: {
      status: smsStatus,
      phone_number: user.dedicatedNumber,
    },
    trace_id: c.get('traceId'),
  })
})

publicApiV1.post('/agents/:agentId/messages', async (c) => {
  const agentId = c.req.param('agentId')
  const from = `api:${agentId}`
  const existing = await getUser(c.env, from)
  if (!existing) return c.json({ error: 'not_found', trace_id: c.get('traceId') }, 404)

  const callerKeyId = String(c.get('apiKeyId') || '').trim()
  if (!callerKeyId) return c.json({ error: 'unauthorized', trace_id: c.get('traceId') }, 401)

  // Enforce agent ownership (best-effort migration for older agents).
  let ownerCheckedUser: UserRecord = existing
  if (existing.developerOwnerApiKeyId && existing.developerOwnerApiKeyId !== callerKeyId) {
    return c.json({ error: 'forbidden', trace_id: c.get('traceId') }, 403)
  }
  if (!existing.developerOwnerApiKeyId) {
    ownerCheckedUser = {
      ...existing,
      developerOwnerApiKeyId: callerKeyId,
      developerOwnerUserId: String(c.get('apiKeyUserId') || '').trim() || undefined,
    }
  }

  let body: SendMessageBody | null = null
  try {
    body = (await c.req.json()) as SendMessageBody
  } catch {
    return c.json({ error: 'invalid_json', trace_id: c.get('traceId') }, 400)
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return c.json({ error: 'missing_text', trace_id: c.get('traceId') }, 400)
  if (text.length > 4000) return c.json({ error: 'text_too_long', trace_id: c.get('traceId') }, 400)

  const limits = getLimitConfig(c.env)
  const inbound = applyInboundUsage(ownerCheckedUser, limits)
  if (!inbound.allowed) {
    await putUser(c.env, inbound.user)
    return c.json({ error: 'rate_limited', reason: inbound.reason, trace_id: c.get('traceId') }, 429)
  }

  // Default aligns with gateway cold-start worst-case (STARTUP_TIMEOUT_MS=180s).
  // In steady state this returns quickly; on first message it prevents false "unavailable" errors.
  const timeoutMs = parsePositiveInt(c.env.TXTCLAW_PUBLIC_API_OPENCLAW_TIMEOUT_MS, 180000)
  const maxAttempts = parsePositiveInt(c.env.TXTCLAW_PUBLIC_API_OPENCLAW_MAX_ATTEMPTS, 2)
  const retryDelayMs = parseNonNegativeInt(c.env.TXTCLAW_PUBLIC_API_OPENCLAW_RETRY_DELAY_MS, 0)

  const hostedPrimary = c.env.TXTCLAW_HOSTED_PRIMARY_MODEL?.trim() || undefined
  const hostedFallback = c.env.TXTCLAW_HOSTED_FALLBACK_MODEL?.trim() || undefined

  let runtimeEnvOverrides: Record<string, string> | undefined
  let forceGatewayRestart = false
  let modelOverride: string | undefined
  let modelFallbackOverride: string | undefined

  const llmMode: LlmMode = inbound.user.developerLlmMode === 'byok' ? 'byok' : 'hosted'
  const llmTier: LlmTier = inbound.user.developerLlmTier === 'smart' ? 'smart' : 'fast'
  c.set('txtclawLlmMode', llmMode)
  c.set('txtclawLlmTier', llmTier)

  const promptVersionId = String(inbound.user.developerSystemPromptVersionId || '').trim()
  if (promptVersionId) {
    c.set('txtclawPromptVersionId', promptVersionId)
  }

  if (llmMode === 'hosted') {
    modelOverride =
      inbound.user.developerLlmModel?.trim() ||
      (llmTier === 'smart' ? hostedFallback : hostedPrimary) ||
      hostedPrimary ||
      undefined

    // Auto-router: if the first attempt fails, use the fallback model (if configured).
    if (llmTier === 'fast' && hostedFallback && hostedFallback !== modelOverride) {
      modelFallbackOverride = hostedFallback
    }
  } else {
    if (!byokEnabled(c.env)) {
      await putUser(c.env, inbound.user)
      return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
    }

    const auth = requireDirectoryKey(c)
    if (!auth.ok) return auth.res

    const lookedUp = await getApiKeyById(c.env, { userId: auth.userId, keyId: auth.keyId })
    const byok = lookedUp.byok
    if (!byok?.keyEnc) {
      return c.json({ error: 'byok_not_configured', trace_id: c.get('traceId') }, 409)
    }

    const master = getMasterKey(c.env)
    if (!master) {
      return c.json({ error: 'byok_not_available', trace_id: c.get('traceId') }, 503)
    }

    const plaintextKey = await decryptSecret({
      masterKeyB64Url: master,
      keyId: auth.keyId,
      ciphertext: byok.keyEnc,
    })

    const provider = (inbound.user.developerLlmProvider || '').trim() || String(byok.provider || '').trim()
    if (provider !== 'openai_compat' && provider !== 'openai' && provider !== 'anthropic') {
      return c.json({ error: 'byok_invalid_provider', trace_id: c.get('traceId') }, 409)
    }

    const baseUrl =
      inbound.user.developerLlmBaseUrl?.trim() ||
      (typeof byok.baseUrl === 'string' ? byok.baseUrl.trim() : '') ||
      undefined

    modelOverride =
      inbound.user.developerLlmModel?.trim() ||
      (typeof byok.model === 'string' ? byok.model.trim() : '') ||
      undefined

    const fingerprint = String(byok.fingerprint || '').trim() || (await fingerprintSecret(plaintextKey))

    if (inbound.user.developerLlmKeyFingerprintApplied !== fingerprint) {
      forceGatewayRestart = true
      inbound.user = {
        ...inbound.user,
        developerLlmKeyFingerprintApplied: fingerprint,
      }
    }

    if (provider === 'anthropic') {
      runtimeEnvOverrides = {
        ANTHROPIC_API_KEY: plaintextKey,
        // Clear OpenAI routing knobs so gateway detection doesn't stick to OpenAI.
        AI_GATEWAY_BASE_URL: baseUrl || '',
        AI_GATEWAY_MODEL: '',
        TXTCLAW_FORCE_OPENAI_COMPAT: '',
        OPENAI_BASE_URL: '',
        ANTHROPIC_BASE_URL: baseUrl || '',
      }
    } else {
      runtimeEnvOverrides = {
        OPENAI_API_KEY: plaintextKey,
        ...(baseUrl ? { AI_GATEWAY_BASE_URL: baseUrl, OPENAI_BASE_URL: baseUrl } : {}),
      }
    }
  }

  let generated: { replyBody: string; user: UserRecord }
  try {
    generated = await buildDedicatedReply({
      env: c.env,
      user: inbound.user,
      inboundBody: text,
      skipOutboundAccounting: true,
      failHard: true,
      openclawTimeoutMs: timeoutMs,
      openclawMaxAttempts: maxAttempts,
      openclawRetryDelayMs: retryDelayMs,
      runtimeEnvOverrides,
      forceGatewayRestart,
      modelOverride,
      modelFallbackOverride,
    })
  } catch (error) {
    await putUser(c.env, inbound.user)
    logApi('openclaw_error', {
      traceId: c.get('traceId'),
      agentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: 'upstream_unavailable', trace_id: c.get('traceId') }, 503)
  }

  const updated = await putUser(c.env, generated.user)
  if (updated.lastModelUsed) {
    c.set('txtclawModelUsed', updated.lastModelUsed)
  } else if (modelOverride) {
    c.set('txtclawModelUsed', modelOverride)
  }
  const warnings = getUsageWarningLines(updated, limits)

  return c.json({
    reply_text: generated.replyBody,
    warnings: warnings.length ? warnings : undefined,
    trace_id: c.get('traceId'),
  })
})

publicApiV1.post('/agents/:agentId/channels/sms', async (c) => {
  const agentId = c.req.param('agentId')
  const from = `api:${agentId}`
  const user = await getUser(c.env, from)
  if (!user) return c.json({ error: 'not_found', trace_id: c.get('traceId') }, 404)

  let body: { mode?: SmsMode } | null = null
  try {
    body = (await c.req.json()) as { mode?: SmsMode }
  } catch {
    return c.json({ error: 'invalid_json', trace_id: c.get('traceId') }, 400)
  }

  const mode = body?.mode
  if (!mode || (mode !== 'sandbox' && mode !== 'managed' && mode !== 'byo_twilio')) {
    return c.json({ error: 'invalid_mode', trace_id: c.get('traceId') }, 400)
  }

  const status = buildSmsStatus(mode, c.env) || 'disabled'
  return c.json({ status, trace_id: c.get('traceId') })
})
