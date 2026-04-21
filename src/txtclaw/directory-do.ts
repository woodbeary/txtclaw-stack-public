export type UserStatus = 'new' | 'pending_payment' | 'active' | 'frozen'

export type PendingCheckout = {
  provider: 'square'
  paymentLinkId: string
  url: string
  orderId: string | null
  amountCents?: number
  createdAt: string
  status: 'pending' | 'paid'
}

export type ApiUserPlan = {
  userId: string
  plan: 'free' | 'pro' | 'max' | 'byok'
  provider?: 'square' | 'manual'
  offerCode?: string
  paidAt?: string
  updatedAt: string
}

export type ApiKeyPublicRecord = {
  keyId: string
  prefix: string
  label?: string
  createdAt: string
  revokedAt?: string
  lastUsedAt?: string
  byokConfigured?: boolean
  byokProvider?: string
  byokUpdatedAt?: string
  byokFingerprint?: string
}

type ApiKeyRecord = ApiKeyPublicRecord & {
  userId: string
  keyHash: string // sha256 hex of the plaintext key
  lastUsedIpHash?: string
  // BYOK (encrypted) - plaintext key is never stored.
  byokProvider?: string
  byokBaseUrl?: string
  byokModel?: string
  byokKeyEnc?: string
  byokFingerprint?: string
  byokLabel?: string
  byokUpdatedAt?: string
}

type ApiUserKeysIndex = {
  userId: string
  keyIds: string[]
  createdAt: string
  updatedAt: string
}

export type PromptVersionRecord = {
  id: string
  label?: string
  content: string
  createdAt: string
  createdBy?: string
}

export type UserRecord = {
  from: string // E.164
  status: UserStatus
  sandboxKey?: string
  r2Prefix?: string
  // Developer API fields (used when `from` starts with "api:").
  developerSystemPrompt?: string
  developerSystemPromptVersionId?: string
  developerCustomerRef?: string
  developerMetadata?: Record<string, unknown>
  developerOwnerApiKeyId?: string
  developerOwnerUserId?: string
  developerLlmMode?: 'hosted' | 'byok'
  developerLlmTier?: 'fast' | 'smart'
  developerLlmModel?: string
  developerLlmProvider?: 'openai_compat' | 'openai' | 'anthropic'
  developerLlmBaseUrl?: string
  // Used to decide whether we must restart the sandbox gateway when BYOK changes.
  developerLlmKeyFingerprintApplied?: string
  profileUserName?: string
  profileAgentName?: string
  bootstrapState?: 'ask_user_name' | 'ask_agent_name' | 'complete'
  bootstrapCompletedAt?: string
  lastInboundSeq?: number
  pendingHandoffSeq?: number
  pendingHandoffAt?: string
  lastReplySource?: 'openclaw' | 'bridge_ai' | 'bridge_template' | 'warmup' | 'fallback'
  plan?: 'pro' | 'max' | 'byok'
  negotiatedPriceCents?: number
  negotiationTurns?: number
  lastNegotiatedAt?: string
  onboardingPromptDay?: string // YYYY-MM-DD UTC
  onboardingPromptCount?: number
  // User texted us and implicitly opted in (recorded for compliance + debugging).
  optedInAt?: string
  // User texted STOP/STOPALL/etc. (recorded so we can suppress outbound messages).
  optedOutAt?: string
  createdAt: string
  updatedAt: string
  lastInboundAt?: string
  lastOutboundAt?: string
  lastOutboundErrorAt?: string
  lastOutboundError?: string
  activatedAt?: string
  usageDay?: string // YYYY-MM-DD UTC
  usageWeek?: string // YYYY-WW UTC ISO week
  usageMonth?: string // YYYY-MM UTC
  inboundDayCount?: number
  inboundWeekCount?: number
  inboundMonthCount?: number
  outboundDayCount?: number
  outboundWeekCount?: number
  outboundMonthCount?: number
  fastRequestMonthCount?: number
  estimatedSpendCentsMonth?: number
  llmInputTokensMonth?: number
  llmOutputTokensMonth?: number
  llmTotalTokensMonth?: number
  llmEstimatedCostCentsMonth?: number
  lastModelUsed?: string
  lastLlmUsageAt?: string
  lastAppleTranscriptSignature?: string
  checkout?: PendingCheckout
  squarePaymentId?: string
  squareSubscriptionId?: string
  dedicatedNumber?: string // E.164 Twilio number
  twilioIncomingSid?: string
}

type RateLimitBatchItem = {
  key: string
  windowMs: number
  limit: number
  cost?: number
}

type RateLimitBatchResultItem = {
  key: string
  allowed: boolean
  remaining: number
  resetAtMs: number
}

type Action =
  | { action: 'getUser'; from: string }
  | { action: 'putUser'; user: UserRecord }
  | { action: 'listUsers' }
  | { action: 'mapOrder'; orderId: string; from: string }
  | { action: 'getFromByOrder'; orderId: string }
  | { action: 'mapSubscription'; subscriptionId: string; from: string }
  | { action: 'getFromBySubscription'; subscriptionId: string }
  | { action: 'mapDedicatedNumber'; to: string; from: string }
  | { action: 'getFromByDedicatedNumber'; to: string }
  | { action: 'checkAndMarkEvent'; key: string }
  | { action: 'rateLimitBatch'; items: RateLimitBatchItem[] }
  | { action: 'createApiKey'; userId: string; label?: string }
  | { action: 'listApiKeys'; userId: string }
  | { action: 'revokeApiKey'; userId: string; keyId: string }
  | {
      action: 'setApiUserPlan'
      userId: string
      plan: string
      provider?: string
      offerCode?: string
      paidAt?: string
    }
  | { action: 'getApiUserPlan'; userId: string }
  | { action: 'createPromptVersion'; content: string; label?: string; createdBy?: string }
  | { action: 'listPromptVersions' }
  | { action: 'activatePromptVersion'; id: string }
  | { action: 'getActivePromptVersion' }
  | {
      action: 'setApiKeyByok'
      userId: string
      keyId: string
      provider: string
      apiKeyEnc: string
      baseUrl?: string
      model?: string
      label?: string
      fingerprint?: string
    }
  | { action: 'clearApiKeyByok'; userId: string; keyId: string }
  | { action: 'getApiKeyById'; userId: string; keyId: string }
  | { action: 'lookupApiKey'; keyHash: string; ipHash?: string | null }

type ActionResult =
  | {
      ok: true
      user?: UserRecord | null
      users?: UserRecord[]
      from?: string | null
      isNew?: boolean
      items?: RateLimitBatchResultItem[]
      apiKey?: string
      apiKeys?: ApiKeyPublicRecord[]
      apiKeyRecord?: ApiKeyPublicRecord
      apiKeyLookup?: { keyId: string; userId: string; plan?: string }
      apiUserPlan?: ApiUserPlan | null
      promptVersions?: PromptVersionRecord[]
      activePromptId?: string | null
      promptVersion?: PromptVersionRecord | null
      apiKeyByok?: {
        provider?: string
        baseUrl?: string
        model?: string
        label?: string
        fingerprint?: string
        updatedAt?: string
        keyEnc?: string
      }
    }
  | { ok: false; error: string }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

function userKey(from: string): string {
  return `user:${from}`
}

function apiKeyKey(keyId: string): string {
  return `api_key:${keyId}`
}

function apiKeyHashKey(keyHash: string): string {
  return `api_key_hash:${keyHash}`
}

function apiUserIndexKey(userId: string): string {
  return `api_user_keys:${userId}`
}

function apiUserPlanKey(userId: string): string {
  return `api_user_plan:${userId}`
}

function promptActiveKey(): string {
  return 'prompt:active'
}

function promptVersionKey(id: string): string {
  return `prompt_version:${id}`
}

function orderKey(orderId: string): string {
  return `order:${orderId}`
}

function toKey(to: string): string {
  return `to:${to}`
}

function subscriptionKey(subscriptionId: string): string {
  return `subscription:${subscriptionId}`
}

function eventKey(key: string): string {
  return `event:${key}`
}

function rateLimitKey(key: string): string {
  return `rl:${key}`
}

type RateLimitState = {
  count: number
  resetAtMs: number
  updatedAt: string
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function clampKey(raw: string): string {
  // Prevent unbounded storage keys. This is an internal API; keep it tight.
  const value = String(raw || '').trim()
  if (!value) return ''
  if (value.length <= 200) return value
  return value.slice(0, 200)
}

function clampUserId(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  // Clerk user ids are short, but keep a conservative bound.
  if (value.length <= 128) return value
  return value.slice(0, 128)
}

function clampApiPlan(raw: string): ApiUserPlan['plan'] | '' {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  if (!value) return ''
  if (value === 'free' || value === 'pro' || value === 'max' || value === 'byok') return value
  return ''
}

function clampPlanProvider(raw: string | undefined): ApiUserPlan['provider'] | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim().toLowerCase()
  if (!value) return undefined
  if (value === 'square' || value === 'manual') return value
  return undefined
}

function clampPaidAt(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  // Keep it cheap: store only ISO-ish strings (no strict validation).
  if (value.length > 80) return value.slice(0, 80)
  return value
}

function clampOfferCode(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  if (value.length > 80) return value.slice(0, 80)
  return value
}

function clampLabel(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  if (value.length <= 60) return value
  return value.slice(0, 60)
}

function clampPromptLabel(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  if (value.length <= 80) return value
  return value.slice(0, 80)
}

function clampPromptContent(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  if (value.length > 8000) return null
  return value
}

function clampCreatedBy(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = String(raw).trim()
  if (!value) return undefined
  if (value.length <= 200) return value
  return value.slice(0, 200)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function makeApiKeyPlaintext(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `vck_${base64UrlEncode(bytes)}`
}

function makeApiKeyId(): string {
  const id = crypto.randomUUID().replace(/-/g, '')
  return `key_${id}`
}

const DEFAULT_PROMPT_VERSION_ID = 'prm_default_v1'

const DEFAULT_PROMPT_CONTENT = [
  'You are OpenClaw running inside a dedicated TXT CLAW agent.',
  '',
  'Goal: help the user and produce high quality, concise plain-text responses.',
  '',
  'Rules:',
  '1) Do not mention internal implementation details, providers, models, tokens, or tools.',
  '2) Do not write files; output any code or text inline.',
  '3) Ask at most one clarifying question when needed.',
].join('\n')

function makePromptVersionId(): string {
  const id = crypto.randomUUID().replace(/-/g, '')
  return `prm_${id}`
}

async function ensureDefaultPrompt(storage: DurableObjectStorage): Promise<PromptVersionRecord> {
  const existing =
    (await storage.get<PromptVersionRecord>(promptVersionKey(DEFAULT_PROMPT_VERSION_ID))) || null
  if (existing) return existing

  const record: PromptVersionRecord = {
    id: DEFAULT_PROMPT_VERSION_ID,
    label: 'Default (v1)',
    content: DEFAULT_PROMPT_CONTENT,
    createdAt: nowIso(),
    createdBy: 'system',
  }

  await storage.put(promptVersionKey(record.id), record)
  return record
}

export class TxtClawDirectory implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)

    let action: Action
    try {
      action = (await request.json()) as Action
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400)
    }

    try {
      const storage = this.state.storage

      switch (action.action) {
        case 'getUser': {
          const user = (await storage.get<UserRecord>(userKey(action.from))) || null
          return jsonResponse({ ok: true, user } satisfies ActionResult)
        }
        case 'putUser': {
          const updated: UserRecord = {
            ...action.user,
            updatedAt: nowIso(),
          }
          await storage.put(userKey(updated.from), updated)
          return jsonResponse({ ok: true, user: updated } satisfies ActionResult)
        }
        case 'listUsers': {
          const list = await storage.list<UserRecord>({ prefix: 'user:' })
          const users: UserRecord[] = []
          for (const value of list.values()) {
            users.push(value)
          }
          return jsonResponse({ ok: true, users } satisfies ActionResult)
        }
        case 'mapOrder': {
          await storage.put(orderKey(action.orderId), action.from)
          return jsonResponse({ ok: true } satisfies ActionResult)
        }
        case 'getFromByOrder': {
          const from = (await storage.get<string>(orderKey(action.orderId))) || null
          return jsonResponse({ ok: true, from } satisfies ActionResult)
        }
        case 'mapSubscription': {
          await storage.put(subscriptionKey(action.subscriptionId), action.from)
          return jsonResponse({ ok: true } satisfies ActionResult)
        }
        case 'getFromBySubscription': {
          const from = (await storage.get<string>(subscriptionKey(action.subscriptionId))) || null
          return jsonResponse({ ok: true, from } satisfies ActionResult)
        }
        case 'mapDedicatedNumber': {
          await storage.put(toKey(action.to), action.from)
          return jsonResponse({ ok: true } satisfies ActionResult)
        }
        case 'getFromByDedicatedNumber': {
          const from = (await storage.get<string>(toKey(action.to))) || null
          return jsonResponse({ ok: true, from } satisfies ActionResult)
        }
        case 'checkAndMarkEvent': {
          const existing = await storage.get<string>(eventKey(action.key))
          if (existing) return jsonResponse({ ok: true, isNew: false } satisfies ActionResult)
          await storage.put(eventKey(action.key), nowIso())
          return jsonResponse({ ok: true, isNew: true } satisfies ActionResult)
        }
        case 'rateLimitBatch': {
          const rawItems = Array.isArray(action.items) ? action.items : []
          if (rawItems.length === 0) {
            return jsonResponse({ ok: false, error: 'Missing rate limit items' } satisfies ActionResult, 400)
          }
          if (rawItems.length > 10) {
            return jsonResponse({ ok: false, error: 'Too many rate limit items' } satisfies ActionResult, 400)
          }

          const now = Date.now()
          const items: RateLimitBatchItem[] = rawItems
            .map((item) => ({
              key: clampKey(item?.key),
              windowMs: toPositiveInt(item?.windowMs, 0),
              limit: Math.max(0, Math.floor(Number(item?.limit || 0))),
              cost: toPositiveInt(item?.cost, 1),
            }))
            .filter((item) => item.key && item.windowMs > 0)

          if (items.length === 0) {
            return jsonResponse({ ok: false, error: 'Invalid rate limit items' } satisfies ActionResult, 400)
          }

          const states: RateLimitState[] = []
          const results: RateLimitBatchResultItem[] = []
          let allAllowed = true

          for (const item of items) {
            const key = rateLimitKey(item.key)
            const existing = (await storage.get<RateLimitState>(key)) || null
            const resetAtMs = existing && now < existing.resetAtMs ? existing.resetAtMs : now + item.windowMs
            const currentCount = existing && now < existing.resetAtMs ? existing.count : 0
            const nextCount = currentCount + (item.cost || 1)

            const allowed = item.limit > 0 ? nextCount <= item.limit : false
            if (!allowed) allAllowed = false

            const remaining = allowed
              ? Math.max(0, item.limit - nextCount)
              : Math.max(0, item.limit - currentCount)

            states.push({
              count: nextCount,
              resetAtMs,
              updatedAt: nowIso(),
            })

            results.push({
              key: item.key,
              allowed,
              remaining,
              resetAtMs,
            })
          }

          if (allAllowed) {
            for (let i = 0; i < items.length; i += 1) {
              await storage.put(rateLimitKey(items[i]!.key), states[i]!)
            }
          }

          return jsonResponse({ ok: true, items: results } satisfies ActionResult)
        }
        case 'createApiKey': {
          const userId = clampUserId(action.userId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }

          const label = clampLabel(action.label)
          const indexKey = apiUserIndexKey(userId)
          const existingIndex = (await storage.get<ApiUserKeysIndex>(indexKey)) || null
          const index: ApiUserKeysIndex = existingIndex || {
            userId,
            keyIds: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          }

          const plaintext = makeApiKeyPlaintext()
          const keyHash = await sha256Hex(plaintext)
          const keyId = makeApiKeyId()
          const createdAt = nowIso()
          const prefix = plaintext.slice(0, 12)

          const record: ApiKeyRecord = {
            keyId,
            userId,
            keyHash,
            prefix,
            label,
            createdAt,
          }

          index.keyIds = Array.from(new Set([...index.keyIds, keyId]))
          index.updatedAt = createdAt

          await storage.put(apiKeyKey(keyId), record)
          await storage.put(apiKeyHashKey(keyHash), keyId)
          await storage.put(indexKey, index)

          const publicRecord: ApiKeyPublicRecord = {
            keyId,
            prefix,
            label,
            createdAt,
          }

          return jsonResponse(
            { ok: true, apiKey: plaintext, apiKeyRecord: publicRecord } satisfies ActionResult,
            200,
          )
        }
        case 'listApiKeys': {
          const userId = clampUserId(action.userId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }

          const index = (await storage.get<ApiUserKeysIndex>(apiUserIndexKey(userId))) || null
          const keyIds = index?.keyIds || []
          if (keyIds.length === 0) {
            return jsonResponse({ ok: true, apiKeys: [] } satisfies ActionResult)
          }

          const recordsMap = (await storage.get<ApiKeyRecord>(keyIds.map(apiKeyKey))) as unknown as Map<
            string,
            ApiKeyRecord
          >

          const apiKeys: ApiKeyPublicRecord[] = []
          for (const keyId of keyIds) {
            const record = recordsMap.get(apiKeyKey(keyId))
            if (!record) continue
            apiKeys.push({
              keyId: record.keyId,
              prefix: record.prefix,
              label: record.label,
              createdAt: record.createdAt,
              revokedAt: record.revokedAt,
              lastUsedAt: record.lastUsedAt,
              byokConfigured: Boolean(record.byokKeyEnc),
              byokProvider: record.byokProvider,
              byokUpdatedAt: record.byokUpdatedAt,
              byokFingerprint: record.byokFingerprint,
            })
          }

          apiKeys.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          return jsonResponse({ ok: true, apiKeys } satisfies ActionResult)
        }
        case 'revokeApiKey': {
          const userId = clampUserId(action.userId)
          const keyId = clampKey(action.keyId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          if (!keyId) {
            return jsonResponse({ ok: false, error: 'Missing keyId' } satisfies ActionResult, 400)
          }

          const keyStorageKey = apiKeyKey(keyId)
          const record = (await storage.get<ApiKeyRecord>(keyStorageKey)) || null
          if (!record) {
            return jsonResponse({ ok: false, error: 'Not found' } satisfies ActionResult, 404)
          }
          if (record.userId !== userId) {
            return jsonResponse({ ok: false, error: 'Forbidden' } satisfies ActionResult, 403)
          }

          const revokedAt = record.revokedAt || nowIso()
          const updated: ApiKeyRecord = {
            ...record,
            revokedAt,
          }
          await storage.put(keyStorageKey, updated)

          const publicRecord: ApiKeyPublicRecord = {
            keyId: updated.keyId,
            prefix: updated.prefix,
            label: updated.label,
            createdAt: updated.createdAt,
            revokedAt: updated.revokedAt,
            lastUsedAt: updated.lastUsedAt,
            byokConfigured: Boolean(updated.byokKeyEnc),
            byokProvider: updated.byokProvider,
            byokUpdatedAt: updated.byokUpdatedAt,
            byokFingerprint: updated.byokFingerprint,
          }

          return jsonResponse({ ok: true, apiKeyRecord: publicRecord } satisfies ActionResult)
        }
        case 'setApiUserPlan': {
          const userId = clampUserId(action.userId)
          const plan = clampApiPlan(action.plan)
          const provider = clampPlanProvider(action.provider)
          const offerCode = clampOfferCode(action.offerCode)
          const paidAt = clampPaidAt(action.paidAt)

          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          if (!plan) {
            return jsonResponse({ ok: false, error: 'Invalid plan' } satisfies ActionResult, 400)
          }

          const updatedAt = nowIso()
          const record: ApiUserPlan = {
            userId,
            plan,
            provider,
            offerCode,
            paidAt,
            updatedAt,
          }

          await storage.put(apiUserPlanKey(userId), record)
          return jsonResponse({ ok: true, apiUserPlan: record } satisfies ActionResult, 200)
        }
        case 'getApiUserPlan': {
          const userId = clampUserId(action.userId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          const record = (await storage.get<ApiUserPlan>(apiUserPlanKey(userId))) || null
          return jsonResponse({ ok: true, apiUserPlan: record } satisfies ActionResult, 200)
        }
        case 'createPromptVersion': {
          const content = clampPromptContent(action.content)
          if (!content) {
            return jsonResponse({ ok: false, error: 'Missing content' } satisfies ActionResult, 400)
          }

          const record: PromptVersionRecord = {
            id: makePromptVersionId(),
            label: clampPromptLabel(action.label),
            content,
            createdAt: nowIso(),
            createdBy: clampCreatedBy(action.createdBy),
          }

          await storage.put(promptVersionKey(record.id), record)

          const existingActive = (await storage.get<string>(promptActiveKey())) || null
          const activePromptId = existingActive || record.id
          if (!existingActive) {
            await storage.put(promptActiveKey(), activePromptId)
          }

          return jsonResponse({ ok: true, promptVersion: record, activePromptId } satisfies ActionResult, 200)
        }
        case 'listPromptVersions': {
          const defaultPrompt = await ensureDefaultPrompt(storage)

          let activePromptId = (await storage.get<string>(promptActiveKey())) || null
          if (!activePromptId) {
            activePromptId = defaultPrompt.id
            await storage.put(promptActiveKey(), activePromptId)
          }

          const listed = await storage.list<PromptVersionRecord>({ prefix: 'prompt_version:' })
          const promptVersions: PromptVersionRecord[] = []
          for (const value of listed.values()) {
            promptVersions.push(value)
          }

          promptVersions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          return jsonResponse({ ok: true, promptVersions, activePromptId } satisfies ActionResult, 200)
        }
        case 'activatePromptVersion': {
          const id = clampKey(action.id)
          if (!id) {
            return jsonResponse({ ok: false, error: 'Missing id' } satisfies ActionResult, 400)
          }

          const record = (await storage.get<PromptVersionRecord>(promptVersionKey(id))) || null
          if (!record) {
            return jsonResponse({ ok: false, error: 'Not found' } satisfies ActionResult, 404)
          }

          await storage.put(promptActiveKey(), record.id)
          return jsonResponse(
            { ok: true, promptVersion: record, activePromptId: record.id } satisfies ActionResult,
            200,
          )
        }
        case 'getActivePromptVersion': {
          const defaultPrompt = await ensureDefaultPrompt(storage)

          let activePromptId = (await storage.get<string>(promptActiveKey())) || null
          if (!activePromptId) {
            activePromptId = defaultPrompt.id
            await storage.put(promptActiveKey(), activePromptId)
          }

          const record = (await storage.get<PromptVersionRecord>(promptVersionKey(activePromptId))) || null

          if (record) {
            return jsonResponse(
              { ok: true, promptVersion: record, activePromptId } satisfies ActionResult,
              200,
            )
          }

          // Corrupt state (active pointer missing): fall back to default.
          await storage.put(promptActiveKey(), defaultPrompt.id)
          return jsonResponse(
            {
              ok: true,
              promptVersion: defaultPrompt,
              activePromptId: defaultPrompt.id,
            } satisfies ActionResult,
            200,
          )
        }
        case 'getApiKeyById': {
          const userId = clampUserId(action.userId)
          const keyId = clampKey(action.keyId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          if (!keyId) {
            return jsonResponse({ ok: false, error: 'Missing keyId' } satisfies ActionResult, 400)
          }

          const record = (await storage.get<ApiKeyRecord>(apiKeyKey(keyId))) || null
          if (!record) {
            return jsonResponse({ ok: false, error: 'Not found' } satisfies ActionResult, 404)
          }
          if (record.userId !== userId) {
            return jsonResponse({ ok: false, error: 'Forbidden' } satisfies ActionResult, 403)
          }

          const publicRecord: ApiKeyPublicRecord = {
            keyId: record.keyId,
            prefix: record.prefix,
            label: record.label,
            createdAt: record.createdAt,
            revokedAt: record.revokedAt,
            lastUsedAt: record.lastUsedAt,
            byokConfigured: Boolean(record.byokKeyEnc),
            byokProvider: record.byokProvider,
            byokUpdatedAt: record.byokUpdatedAt,
            byokFingerprint: record.byokFingerprint,
          }

          return jsonResponse(
            {
              ok: true,
              apiKeyRecord: publicRecord,
              apiKeyByok: record.byokKeyEnc
                ? {
                    provider: record.byokProvider,
                    baseUrl: record.byokBaseUrl,
                    model: record.byokModel,
                    label: record.byokLabel,
                    fingerprint: record.byokFingerprint,
                    updatedAt: record.byokUpdatedAt,
                    keyEnc: record.byokKeyEnc,
                  }
                : undefined,
            } satisfies ActionResult,
            200,
          )
        }
        case 'setApiKeyByok': {
          const userId = clampUserId(action.userId)
          const keyId = clampKey(action.keyId)
          const provider = clampKey(action.provider)
          const apiKeyEnc = clampKey(action.apiKeyEnc)
          const baseUrl = action.baseUrl ? clampKey(action.baseUrl).replace(/\/+$/, '') : undefined
          const model = action.model ? clampKey(action.model) : undefined
          const label = clampLabel(action.label)
          const fingerprint = action.fingerprint ? clampKey(action.fingerprint) : undefined

          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          if (!keyId) {
            return jsonResponse({ ok: false, error: 'Missing keyId' } satisfies ActionResult, 400)
          }
          if (!provider) {
            return jsonResponse({ ok: false, error: 'Missing provider' } satisfies ActionResult, 400)
          }
          if (!apiKeyEnc) {
            return jsonResponse({ ok: false, error: 'Missing apiKeyEnc' } satisfies ActionResult, 400)
          }
          if (apiKeyEnc.length > 3000) {
            return jsonResponse({ ok: false, error: 'apiKeyEnc too large' } satisfies ActionResult, 400)
          }

          const keyStorageKey = apiKeyKey(keyId)
          const record = (await storage.get<ApiKeyRecord>(keyStorageKey)) || null
          if (!record) {
            return jsonResponse({ ok: false, error: 'Not found' } satisfies ActionResult, 404)
          }
          if (record.userId !== userId) {
            return jsonResponse({ ok: false, error: 'Forbidden' } satisfies ActionResult, 403)
          }
          if (record.revokedAt) {
            return jsonResponse({ ok: false, error: 'Key is revoked' } satisfies ActionResult, 409)
          }

          const updatedAt = nowIso()
          const updated: ApiKeyRecord = {
            ...record,
            byokProvider: provider,
            byokBaseUrl: baseUrl,
            byokModel: model,
            byokKeyEnc: apiKeyEnc,
            byokFingerprint: fingerprint,
            byokLabel: label,
            byokUpdatedAt: updatedAt,
          }
          await storage.put(keyStorageKey, updated)

          const publicRecord: ApiKeyPublicRecord = {
            keyId: updated.keyId,
            prefix: updated.prefix,
            label: updated.label,
            createdAt: updated.createdAt,
            revokedAt: updated.revokedAt,
            lastUsedAt: updated.lastUsedAt,
            byokConfigured: true,
            byokProvider: updated.byokProvider,
            byokUpdatedAt: updated.byokUpdatedAt,
            byokFingerprint: updated.byokFingerprint,
          }

          return jsonResponse({ ok: true, apiKeyRecord: publicRecord } satisfies ActionResult, 200)
        }
        case 'clearApiKeyByok': {
          const userId = clampUserId(action.userId)
          const keyId = clampKey(action.keyId)
          if (!userId) {
            return jsonResponse({ ok: false, error: 'Missing userId' } satisfies ActionResult, 400)
          }
          if (!keyId) {
            return jsonResponse({ ok: false, error: 'Missing keyId' } satisfies ActionResult, 400)
          }

          const keyStorageKey = apiKeyKey(keyId)
          const record = (await storage.get<ApiKeyRecord>(keyStorageKey)) || null
          if (!record) {
            return jsonResponse({ ok: false, error: 'Not found' } satisfies ActionResult, 404)
          }
          if (record.userId !== userId) {
            return jsonResponse({ ok: false, error: 'Forbidden' } satisfies ActionResult, 403)
          }

          const updatedAt = nowIso()
          const updated: ApiKeyRecord = {
            ...record,
            byokProvider: undefined,
            byokBaseUrl: undefined,
            byokModel: undefined,
            byokKeyEnc: undefined,
            byokFingerprint: undefined,
            byokLabel: undefined,
            byokUpdatedAt: updatedAt,
          }
          await storage.put(keyStorageKey, updated)

          const publicRecord: ApiKeyPublicRecord = {
            keyId: updated.keyId,
            prefix: updated.prefix,
            label: updated.label,
            createdAt: updated.createdAt,
            revokedAt: updated.revokedAt,
            lastUsedAt: updated.lastUsedAt,
            byokConfigured: false,
            byokProvider: undefined,
            byokUpdatedAt: updated.byokUpdatedAt,
            byokFingerprint: undefined,
          }

          return jsonResponse({ ok: true, apiKeyRecord: publicRecord } satisfies ActionResult, 200)
        }
        case 'lookupApiKey': {
          const keyHash = clampKey(action.keyHash)
          const ipHash = action.ipHash ? clampKey(action.ipHash) : null
          if (!keyHash) {
            return jsonResponse({ ok: false, error: 'Missing keyHash' } satisfies ActionResult, 400)
          }

          const keyId = (await storage.get<string>(apiKeyHashKey(keyHash))) || null
          if (!keyId) {
            return jsonResponse({ ok: false, error: 'Unauthorized' } satisfies ActionResult, 401)
          }

          const record = (await storage.get<ApiKeyRecord>(apiKeyKey(keyId))) || null
          if (!record || record.revokedAt) {
            return jsonResponse({ ok: false, error: 'Unauthorized' } satisfies ActionResult, 401)
          }

          const updated: ApiKeyRecord = {
            ...record,
            lastUsedAt: nowIso(),
            lastUsedIpHash: ipHash || record.lastUsedIpHash,
          }
          await storage.put(apiKeyKey(keyId), updated)

          const planRecord = (await storage.get<ApiUserPlan>(apiUserPlanKey(updated.userId))) || null
          const plan = planRecord?.plan || undefined

          return jsonResponse(
            {
              ok: true,
              apiKeyLookup: { keyId: updated.keyId, userId: updated.userId, plan },
            } satisfies ActionResult,
            200,
          )
        }
        default:
          return jsonResponse({ ok: false, error: 'Unknown action' } satisfies ActionResult, 400)
      }
    } catch (error) {
      return jsonResponse(
        { ok: false, error: error instanceof Error ? error.message : 'Unknown error' } satisfies ActionResult,
        500,
      )
    }
  }
}
