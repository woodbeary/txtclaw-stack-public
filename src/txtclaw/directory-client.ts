import type { MoltbotEnv } from '../types'
import type { ApiKeyPublicRecord, ApiUserPlan, PromptVersionRecord, UserRecord } from './directory-do'

export type ApiKeyByokRecord = {
  provider?: string
  baseUrl?: string
  model?: string
  label?: string
  fingerprint?: string
  updatedAt?: string
  keyEnc?: string
}

type DirectoryResponse =
  | {
      ok: true
      user?: UserRecord | null
      users?: UserRecord[]
      from?: string | null
      isNew?: boolean
      items?: {
        key: string
        allowed: boolean
        remaining: number
        resetAtMs: number
      }[]
      apiKey?: string
      apiKeys?: ApiKeyPublicRecord[]
      apiKeyRecord?: ApiKeyPublicRecord
      apiKeyLookup?: { keyId: string; userId: string; plan?: string }
      apiUserPlan?: ApiUserPlan | null
      promptVersions?: PromptVersionRecord[]
      activePromptId?: string | null
      promptVersion?: PromptVersionRecord | null
      apiKeyByok?: ApiKeyByokRecord
    }
  | { ok: false; error: string }

function getDirectoryStub(env: MoltbotEnv): DurableObjectStub {
  if (!env.TXTCLAW_DIRECTORY) {
    throw new Error('TXTCLAW_DIRECTORY binding is not configured')
  }

  const id = env.TXTCLAW_DIRECTORY.idFromName('txtclaw-directory')
  return env.TXTCLAW_DIRECTORY.get(id)
}

async function callDirectory(env: MoltbotEnv, payload: unknown): Promise<DirectoryResponse> {
  const stub = getDirectoryStub(env)
  const res = await stub.fetch('https://txtclaw-directory/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  try {
    return JSON.parse(text) as DirectoryResponse
  } catch {
    if (!res.ok) {
      return { ok: false, error: `Directory call failed (${res.status}): ${text}` }
    }
    return { ok: false, error: 'Directory returned invalid JSON' }
  }
}

export async function getUser(env: MoltbotEnv, from: string): Promise<UserRecord | null> {
  const data = await callDirectory(env, { action: 'getUser', from })
  if (!data.ok) throw new Error(data.error)
  return data.user ?? null
}

export async function putUser(env: MoltbotEnv, user: UserRecord): Promise<UserRecord> {
  const data = await callDirectory(env, { action: 'putUser', user })
  if (!data.ok) throw new Error(data.error)
  if (!data.user) throw new Error('Directory returned no user')
  return data.user
}

export async function listUsers(env: MoltbotEnv): Promise<UserRecord[]> {
  const data = await callDirectory(env, { action: 'listUsers' })
  if (!data.ok) throw new Error(data.error)
  return data.users || []
}

export async function mapOrder(env: MoltbotEnv, orderId: string, from: string): Promise<void> {
  const data = await callDirectory(env, { action: 'mapOrder', orderId, from })
  if (!data.ok) throw new Error(data.error)
}

export async function getFromByOrder(env: MoltbotEnv, orderId: string): Promise<string | null> {
  const data = await callDirectory(env, { action: 'getFromByOrder', orderId })
  if (!data.ok) throw new Error(data.error)
  return data.from ?? null
}

export async function mapSubscription(env: MoltbotEnv, subscriptionId: string, from: string): Promise<void> {
  const data = await callDirectory(env, { action: 'mapSubscription', subscriptionId, from })
  if (!data.ok) throw new Error(data.error)
}

export async function getFromBySubscription(env: MoltbotEnv, subscriptionId: string): Promise<string | null> {
  const data = await callDirectory(env, { action: 'getFromBySubscription', subscriptionId })
  if (!data.ok) throw new Error(data.error)
  return data.from ?? null
}

export async function mapDedicatedNumber(env: MoltbotEnv, to: string, from: string): Promise<void> {
  const data = await callDirectory(env, { action: 'mapDedicatedNumber', to, from })
  if (!data.ok) throw new Error(data.error)
}

export async function getFromByDedicatedNumber(env: MoltbotEnv, to: string): Promise<string | null> {
  const data = await callDirectory(env, { action: 'getFromByDedicatedNumber', to })
  if (!data.ok) throw new Error(data.error)
  return data.from ?? null
}

export async function checkAndMarkEvent(env: MoltbotEnv, key: string): Promise<boolean> {
  const data = await callDirectory(env, { action: 'checkAndMarkEvent', key })
  if (!data.ok) throw new Error(data.error)
  return Boolean(data.isNew)
}

export type RateLimitItem = {
  key: string
  windowMs: number
  limit: number
  cost?: number
}

export type RateLimitResultItem = {
  key: string
  allowed: boolean
  remaining: number
  resetAtMs: number
}

export async function rateLimitBatch(
  env: MoltbotEnv,
  items: RateLimitItem[],
): Promise<RateLimitResultItem[]> {
  const data = await callDirectory(env, { action: 'rateLimitBatch', items })
  if (!data.ok) throw new Error(data.error)
  return (data.items || []) as RateLimitResultItem[]
}

export async function createApiKey(
  env: MoltbotEnv,
  args: { userId: string; label?: string },
): Promise<{ apiKey: string; record: ApiKeyPublicRecord }> {
  const data = await callDirectory(env, { action: 'createApiKey', userId: args.userId, label: args.label })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiKey || !data.apiKeyRecord) throw new Error('Directory returned no api key')
  return { apiKey: data.apiKey, record: data.apiKeyRecord }
}

export async function listApiKeys(env: MoltbotEnv, args: { userId: string }): Promise<ApiKeyPublicRecord[]> {
  const data = await callDirectory(env, { action: 'listApiKeys', userId: args.userId })
  if (!data.ok) throw new Error(data.error)
  return data.apiKeys || []
}

export async function revokeApiKey(
  env: MoltbotEnv,
  args: { userId: string; keyId: string },
): Promise<ApiKeyPublicRecord> {
  const data = await callDirectory(env, { action: 'revokeApiKey', userId: args.userId, keyId: args.keyId })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiKeyRecord) throw new Error('Directory returned no api key record')
  return data.apiKeyRecord
}

export async function setApiUserPlan(
  env: MoltbotEnv,
  args: {
    userId: string
    plan: 'free' | 'pro' | 'max' | 'byok'
    provider?: 'square' | 'manual'
    offerCode?: string
    paidAt?: string
  },
): Promise<ApiUserPlan> {
  const data = await callDirectory(env, { action: 'setApiUserPlan', ...args })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiUserPlan) throw new Error('Directory returned no plan record')
  return data.apiUserPlan
}

export async function getApiUserPlan(env: MoltbotEnv, args: { userId: string }): Promise<ApiUserPlan | null> {
  const data = await callDirectory(env, { action: 'getApiUserPlan', userId: args.userId })
  if (!data.ok) throw new Error(data.error)
  return data.apiUserPlan ?? null
}

export async function getApiKeyById(
  env: MoltbotEnv,
  args: { userId: string; keyId: string },
): Promise<{ record: ApiKeyPublicRecord; byok?: ApiKeyByokRecord }> {
  const data = await callDirectory(env, { action: 'getApiKeyById', userId: args.userId, keyId: args.keyId })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiKeyRecord) throw new Error('Directory returned no api key record')
  return { record: data.apiKeyRecord, byok: data.apiKeyByok }
}

export async function setApiKeyByok(
  env: MoltbotEnv,
  args: {
    userId: string
    keyId: string
    provider: string
    apiKeyEnc: string
    baseUrl?: string
    model?: string
    label?: string
    fingerprint?: string
  },
): Promise<ApiKeyPublicRecord> {
  const data = await callDirectory(env, { action: 'setApiKeyByok', ...args })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiKeyRecord) throw new Error('Directory returned no api key record')
  return data.apiKeyRecord
}

export async function clearApiKeyByok(
  env: MoltbotEnv,
  args: { userId: string; keyId: string },
): Promise<ApiKeyPublicRecord> {
  const data = await callDirectory(env, { action: 'clearApiKeyByok', ...args })
  if (!data.ok) throw new Error(data.error)
  if (!data.apiKeyRecord) throw new Error('Directory returned no api key record')
  return data.apiKeyRecord
}

export async function lookupApiKey(
  env: MoltbotEnv,
  args: { keyHash: string; ipHash?: string | null },
): Promise<{ keyId: string; userId: string; plan?: string } | null> {
  const data = await callDirectory(env, {
    action: 'lookupApiKey',
    keyHash: args.keyHash,
    ipHash: args.ipHash,
  })
  if (!data.ok) {
    if (data.error.toLowerCase().includes('unauthorized')) return null
    throw new Error(data.error)
  }
  return data.apiKeyLookup || null
}

export async function listPromptVersions(
  env: MoltbotEnv,
): Promise<{ promptVersions: PromptVersionRecord[]; activePromptId: string | null }> {
  const data = await callDirectory(env, { action: 'listPromptVersions' })
  if (!data.ok) throw new Error(data.error)
  return {
    promptVersions: data.promptVersions || [],
    activePromptId: data.activePromptId ?? null,
  }
}

export async function getActivePromptVersion(env: MoltbotEnv): Promise<PromptVersionRecord> {
  const data = await callDirectory(env, { action: 'getActivePromptVersion' })
  if (!data.ok) throw new Error(data.error)
  if (!data.promptVersion) throw new Error('Directory returned no prompt version')
  return data.promptVersion
}

export async function createPromptVersion(
  env: MoltbotEnv,
  args: { content: string; label?: string; createdBy?: string },
): Promise<{ record: PromptVersionRecord; activePromptId: string | null }> {
  const data = await callDirectory(env, { action: 'createPromptVersion', ...args })
  if (!data.ok) throw new Error(data.error)
  if (!data.promptVersion) throw new Error('Directory returned no prompt version')
  return { record: data.promptVersion, activePromptId: data.activePromptId ?? null }
}

export async function activatePromptVersion(
  env: MoltbotEnv,
  args: { id: string },
): Promise<{ record: PromptVersionRecord; activePromptId: string | null }> {
  const data = await callDirectory(env, { action: 'activatePromptVersion', id: args.id })
  if (!data.ok) throw new Error(data.error)
  if (!data.promptVersion) throw new Error('Directory returned no prompt version')
  return { record: data.promptVersion, activePromptId: data.activePromptId ?? null }
}
