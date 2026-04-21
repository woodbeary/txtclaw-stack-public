import { Hono } from 'hono'
import { encryptSecret, fingerprintSecret } from '../txtclaw/credentials'
import { timingSafeEqual } from '../txtclaw/crypto'
import {
  activatePromptVersion,
  clearApiKeyByok,
  createApiKey,
  createPromptVersion,
  getActivePromptVersion,
  getApiUserPlan,
  listApiKeys,
  listPromptVersions,
  rateLimitBatch,
  revokeApiKey,
  setApiKeyByok,
  setApiUserPlan,
} from '../txtclaw/directory-client'
import type { UserRecord } from '../txtclaw/directory-do'
import { deriveHostedApiRuntimeIdentity } from '../txtclaw/runtime'
import { getTrace, gradeTrace, listTraces } from '../txtclaw/traces-client'
import type { TraceGrade } from '../txtclaw/traces-do'
import type { AppEnv } from '../types'

function nowIso(): string {
  return new Date().toISOString()
}

function isTrue(raw: string | undefined): boolean {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  return value === 'true' || value === '1' || value === 'yes' || value === 'on'
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

function getConsoleTokens(env: AppEnv['Bindings']): string[] {
  const candidates = [
    String(env.TXTCLAW_CONSOLE_SERVICE_TOKEN || '').trim(),
    String(env.TXTCLAW_CONSOLE_SERVICE_TOKEN_NEXT || '').trim(),
  ]
    .filter(Boolean)
    .flatMap((raw) =>
      raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )

  // De-dupe while preserving order.
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const t of candidates) {
    if (!seen.has(t)) {
      seen.add(t)
      tokens.push(t)
    }
  }
  return tokens
}

function isAuthorized(env: AppEnv['Bindings'], request: Request): boolean {
  const expectedTokens = getConsoleTokens(env)
  if (!expectedTokens.length) return false
  const token =
    parseBearer(request.headers.get('authorization') || undefined) ||
    String(request.headers.get('x-txtclaw-console-token') || '').trim() ||
    null
  if (!token) return false
  for (const expected of expectedTokens) {
    if (timingSafeEqual(expected, token)) return true
  }
  return false
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || '')
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function planFromOfferCode(offerCode: string): 'free' | 'pro' | 'byok' {
  const raw = String(offerCode || '')
    .trim()
    .toLowerCase()
  if (!raw) return 'free'
  if (raw === 'ltd_byok_299') return 'byok'
  if (raw.startsWith('launch_')) return 'pro'
  return 'pro'
}

function byokEnabled(env: AppEnv['Bindings']): boolean {
  return isTrue(env.TXTCLAW_BYOK_ENABLED) && Boolean(env.TXTCLAW_CREDENTIALS_MASTER_KEY?.trim())
}

function getMasterKey(env: AppEnv['Bindings']): string | null {
  const raw = env.TXTCLAW_CREDENTIALS_MASTER_KEY?.trim() || ''
  return raw ? raw : null
}

export const consoleRoutes = new Hono<AppEnv>()

// Shared auth gate for all /console/v1 routes.
consoleRoutes.use('/v1/*', async (c, next) => {
  if (!getConsoleTokens(c.env).length) {
    return c.json({ ok: false, error: 'Console is not configured.' }, 503)
  }

  if (!isAuthorized(c.env, c.req.raw)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401)
  }

  return next()
})

consoleRoutes.get('/v1/api-keys', async (c) => {
  const userId = String(c.req.query('user_id') || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)

  const apiKeys = await listApiKeys(c.env, { userId })
  return c.json({ ok: true, api_keys: apiKeys }, 200)
})

consoleRoutes.post('/v1/api-keys', async (c) => {
  let payload: { user_id?: string; label?: string } | null = null
  try {
    payload = (await c.req.json()) as { user_id?: string; label?: string }
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)

  const maxActive = parsePositiveInt(c.env.TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER, 3)
  const createPerHour = parsePositiveInt(c.env.TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER, 5)

  // Anti-abuse: cap active keys per user.
  const existing = await listApiKeys(c.env, { userId })
  const activeCount = existing.filter((k) => !k.revokedAt).length
  if (activeCount >= maxActive) {
    return c.json(
      {
        ok: false,
        error: `Max active keys reached (${maxActive}). Revoke an old key first.`,
      },
      409,
    )
  }

  // Anti-abuse: cap key-creates per hour per user.
  const rl = await rateLimitBatch(c.env, [
    { key: `console:create:${userId}`, windowMs: 60 * 60 * 1000, limit: createPerHour, cost: 1 },
  ])
  const denied = rl.find((r) => !r.allowed)
  if (denied) {
    const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json(
      {
        ok: false,
        error: 'Too many keys created recently. Try again later.',
      },
      429,
    )
  }

  const created = await createApiKey(c.env, { userId, label: payload?.label })

  // DX: opportunistically warm the gateway for this API key so "first reply" is faster.
  // This is safe because key creation is already rate-limited per user.
  try {
    const exec: any = (c as any).executionCtx
    if (exec && typeof exec.waitUntil === 'function' && created.record?.keyId) {
      const runtime = deriveHostedApiRuntimeIdentity()
      const warmUser: UserRecord = {
        from: `apiwarm:${created.record.keyId}`,
        status: 'active',
        sandboxKey: runtime.sandboxKey,
        r2Prefix: runtime.r2Prefix,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }

      exec.waitUntil(
        (async () => {
          const { prewarmDedicatedGateway } = await import('../txtclaw/agent')
          await prewarmDedicatedGateway({ env: c.env, user: warmUser })
        })().catch((err) => {
          console.error('[console] prewarm failed:', err instanceof Error ? err.message : String(err))
        }),
      )
    }
  } catch {
    // Never block key creation response on prewarm wiring.
  }
  return c.json(
    {
      ok: true,
      api_key: created.apiKey,
      record: created.record,
      generated_at: nowIso(),
    },
    200,
  )
})

consoleRoutes.post('/v1/api-keys/revoke', async (c) => {
  let payload: { user_id?: string; key_id?: string } | null = null
  try {
    payload = (await c.req.json()) as { user_id?: string; key_id?: string }
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  const keyId = String(payload?.key_id || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)
  if (!keyId) return c.json({ ok: false, error: 'Missing key_id.' }, 400)

  const record = await revokeApiKey(c.env, { userId, keyId })
  return c.json({ ok: true, record, revoked_at: nowIso() }, 200)
})

consoleRoutes.post('/v1/api-keys/byok', async (c) => {
  if (!byokEnabled(c.env)) {
    return c.json({ ok: false, error: 'BYOK is not enabled.' }, 503)
  }

  let payload: {
    user_id?: string
    key_id?: string
    provider?: string
    api_key?: string
    base_url?: string
    model?: string
    label?: string
  } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  const keyId = String(payload?.key_id || '').trim()
  const provider = String(payload?.provider || '').trim()
  const apiKeyPlain = String(payload?.api_key || '').trim()
  const baseUrlRaw = payload?.base_url
  const baseUrl = normalizeUrl(baseUrlRaw)
  const model = payload?.model !== undefined && payload?.model !== null ? String(payload.model).trim() : ''
  const label = payload?.label !== undefined && payload?.label !== null ? String(payload.label).trim() : ''

  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)
  if (!keyId) return c.json({ ok: false, error: 'Missing key_id.' }, 400)
  if (!apiKeyPlain) return c.json({ ok: false, error: 'Missing api_key.' }, 400)
  if (provider !== 'openai_compat' && provider !== 'openai' && provider !== 'anthropic') {
    return c.json({ ok: false, error: 'Invalid provider.' }, 400)
  }
  if (baseUrlRaw !== undefined && baseUrlRaw !== null && String(baseUrlRaw).trim() && !baseUrl) {
    return c.json({ ok: false, error: 'Invalid base_url.' }, 400)
  }
  if (model && model.length > 200) return c.json({ ok: false, error: 'Invalid model.' }, 400)
  if (label && label.length > 60) return c.json({ ok: false, error: 'Invalid label.' }, 400)

  const master = getMasterKey(c.env)
  if (!master) return c.json({ ok: false, error: 'Console BYOK is not configured.' }, 503)

  const limit = parsePositiveInt(c.env.TXTCLAW_BYOK_SET_PER_HOUR_PER_KEY, 5)
  const rl = await rateLimitBatch(c.env, [
    { key: `console:byok:set:${keyId}`, windowMs: 60 * 60 * 1000, limit, cost: 1 },
  ])
  const denied = rl.find((r) => !r.allowed)
  if (denied) {
    const retryAfterSeconds = Math.max(1, Math.ceil((denied.resetAtMs - Date.now()) / 1000))
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json({ ok: false, error: 'Too many BYOK updates recently. Try again later.' }, 429)
  }

  const apiKeyEnc = await encryptSecret({
    masterKeyB64Url: master,
    keyId,
    plaintext: apiKeyPlain,
  })
  const fingerprint = await fingerprintSecret(apiKeyPlain)

  const record = await setApiKeyByok(c.env, {
    userId,
    keyId,
    provider,
    apiKeyEnc,
    baseUrl,
    model: model || undefined,
    label: label || undefined,
    fingerprint,
  })

  return c.json({ ok: true, record, updated_at: nowIso() }, 200)
})

consoleRoutes.post('/v1/api-keys/byok/clear', async (c) => {
  let payload: { user_id?: string; key_id?: string } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  const keyId = String(payload?.key_id || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)
  if (!keyId) return c.json({ ok: false, error: 'Missing key_id.' }, 400)

  const record = await clearApiKeyByok(c.env, { userId, keyId })
  return c.json({ ok: true, record, cleared_at: nowIso() }, 200)
})

consoleRoutes.get('/v1/plan', async (c) => {
  const userId = String(c.req.query('user_id') || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)
  const plan = await getApiUserPlan(c.env, { userId })
  return c.json({ ok: true, plan }, 200)
})

consoleRoutes.post('/v1/plan', async (c) => {
  let payload: {
    user_id?: string
    plan?: 'free' | 'pro' | 'max' | 'byok'
    provider?: 'square' | 'manual'
    offer_code?: string
    paid_at?: string
  } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)

  const planRaw = String(payload?.plan || '')
    .trim()
    .toLowerCase()
  const plan = planRaw === 'pro' || planRaw === 'max' || planRaw === 'byok' ? planRaw : 'free'
  const provider =
    payload?.provider === 'square' ? 'square' : payload?.provider === 'manual' ? 'manual' : undefined
  const offerCode = typeof payload?.offer_code === 'string' ? payload.offer_code.trim() : undefined
  const paidAt = typeof payload?.paid_at === 'string' ? payload.paid_at.trim() : undefined

  const updated = await setApiUserPlan(c.env, {
    userId,
    plan: plan as any,
    provider,
    offerCode,
    paidAt,
  })

  return c.json({ ok: true, plan: updated }, 200)
})

consoleRoutes.post('/v1/plan/sync', async (c) => {
  let payload: { user_id?: string; offer_code?: string; paid_at?: string } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const userId = String(payload?.user_id || '').trim()
  const offerCode = String(payload?.offer_code || '').trim()
  const paidAt = typeof payload?.paid_at === 'string' ? payload.paid_at.trim() : undefined
  if (!userId) return c.json({ ok: false, error: 'Missing user_id.' }, 400)
  if (!offerCode) return c.json({ ok: false, error: 'Missing offer_code.' }, 400)

  const plan = planFromOfferCode(offerCode)
  const updated = await setApiUserPlan(c.env, {
    userId,
    plan,
    provider: 'square',
    offerCode,
    paidAt,
  })

  return c.json({ ok: true, plan: updated }, 200)
})

consoleRoutes.get('/v1/traces', async (c) => {
  const limitRaw = String(c.req.query('limit') || '').trim()
  const cursor = String(c.req.query('cursor') || '').trim() || undefined
  const limit = parsePositiveInt(limitRaw || undefined, 50)

  const out = await listTraces(c.env, { limit, cursor })
  return c.json({ ok: true, traces: out.traces, cursor: out.cursor }, 200)
})

consoleRoutes.get('/v1/traces/:traceId', async (c) => {
  const traceId = String(c.req.param('traceId') || '').trim()
  if (!traceId) return c.json({ ok: false, error: 'Missing traceId.' }, 400)
  const trace = await getTrace(c.env, traceId)
  if (!trace) return c.json({ ok: false, error: 'Not found.' }, 404)
  return c.json({ ok: true, trace }, 200)
})

consoleRoutes.post('/v1/traces/grade', async (c) => {
  let payload: { trace_id?: string; grade?: string; note?: string } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const traceId = String(payload?.trace_id || '').trim()
  const gradeRaw = String(payload?.grade || '').trim()
  const note = payload?.note !== undefined && payload?.note !== null ? String(payload.note).trim() : ''
  if (!traceId) return c.json({ ok: false, error: 'Missing trace_id.' }, 400)
  if (!gradeRaw) return c.json({ ok: false, error: 'Missing grade.' }, 400)

  const grade = gradeRaw as TraceGrade
  if (
    grade !== 'good' &&
    grade !== 'bad' &&
    grade !== 'needs_prompt' &&
    grade !== 'bug' &&
    grade !== 'unknown'
  ) {
    return c.json({ ok: false, error: 'Invalid grade.' }, 400)
  }

  const updated = await gradeTrace(c.env, { traceId, grade, note: note || undefined })
  if (!updated) return c.json({ ok: false, error: 'Not found.' }, 404)
  return c.json({ ok: true, trace: updated }, 200)
})

consoleRoutes.get('/v1/prompts', async (c) => {
  const out = await listPromptVersions(c.env)
  return c.json({ ok: true, active_prompt_id: out.activePromptId, prompt_versions: out.promptVersions }, 200)
})

consoleRoutes.get('/v1/prompts/active', async (c) => {
  const prompt = await getActivePromptVersion(c.env)
  return c.json({ ok: true, prompt_version: prompt, active_prompt_id: prompt.id }, 200)
})

consoleRoutes.post('/v1/prompts', async (c) => {
  let payload: { label?: string; content?: string; created_by?: string; activate?: boolean } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
  const label = typeof payload?.label === 'string' ? payload.label.trim() : ''
  const createdBy = typeof payload?.created_by === 'string' ? payload.created_by.trim() : ''
  const activate = payload?.activate !== false

  if (!content) return c.json({ ok: false, error: 'Missing content.' }, 400)

  const created = await createPromptVersion(c.env, {
    content,
    label: label || undefined,
    createdBy: createdBy || undefined,
  })

  let activePromptId = created.activePromptId
  let record = created.record
  if (activate) {
    const activated = await activatePromptVersion(c.env, { id: created.record.id })
    activePromptId = activated.activePromptId
    record = activated.record
  }

  return c.json({ ok: true, prompt_version: record, active_prompt_id: activePromptId }, 200)
})

consoleRoutes.post('/v1/prompts/activate', async (c) => {
  let payload: { id?: string } | null = null
  try {
    payload = (await c.req.json()) as any
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
  }

  const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (!id) return c.json({ ok: false, error: 'Missing id.' }, 400)

  const activated = await activatePromptVersion(c.env, { id })
  return c.json(
    { ok: true, prompt_version: activated.record, active_prompt_id: activated.activePromptId },
    200,
  )
})
