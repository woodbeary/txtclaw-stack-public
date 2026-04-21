import { describe, expect, it } from 'vitest'
import { TxtClawDirectory } from './directory-do'

type MockDurableObjectStub = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function createInMemoryDirectory() {
  const store = new Map<string, unknown>()
  const state = {
    storage: {
      get: async <T>(key: string | string[]): Promise<T | Map<string, T> | undefined> => {
        if (Array.isArray(key)) {
          const out = new Map<string, T>()
          for (const k of key) {
            if (store.has(k)) out.set(k, store.get(k) as T)
          }
          return out
        }
        return store.get(key) as T | undefined
      },
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value)
      },
      list: async <T>(options?: { prefix?: string }): Promise<Map<string, T>> => {
        const out = new Map<string, T>()
        for (const [key, value] of store.entries()) {
          if (!options?.prefix || key.startsWith(options.prefix)) {
            out.set(key, value as T)
          }
        }
        return out
      },
    },
  } as unknown as DurableObjectState

  const directory = new TxtClawDirectory(state)
  const stub: MockDurableObjectStub = {
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return directory.fetch(new Request(url, init))
    },
  }

  return { stub, store }
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('TxtClawDirectory API keys', () => {
  it('creates, lists, looks up, and revokes keys', async () => {
    const { stub } = createInMemoryDirectory()
    const userId = 'user_123'

    const createRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createApiKey', userId, label: 'my key' }),
    })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as any
    expect(created.ok).toBe(true)
    expect(created.apiKey).toMatch(/^vck_[A-Za-z0-9_-]+$/)
    expect(created.apiKeyRecord.keyId).toMatch(/^key_[a-f0-9]+$/)
    expect(created.apiKeyRecord.prefix).toBe(String(created.apiKey).slice(0, 12))
    expect(created.apiKeyRecord.label).toBe('my key')

    const listRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listApiKeys', userId }),
    })
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as any
    expect(listed.ok).toBe(true)
    expect(Array.isArray(listed.apiKeys)).toBe(true)
    expect(listed.apiKeys.length).toBe(1)
    expect(listed.apiKeys[0].keyId).toBe(created.apiKeyRecord.keyId)
    expect(listed.apiKeys[0].revokedAt).toBeUndefined()

    const keyHash = await sha256Hex(created.apiKey)
    const lookupRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lookupApiKey', keyHash, ipHash: 'iphash' }),
    })
    expect(lookupRes.status).toBe(200)
    const lookup = (await lookupRes.json()) as any
    expect(lookup.ok).toBe(true)
    expect(lookup.apiKeyLookup.keyId).toBe(created.apiKeyRecord.keyId)
    expect(lookup.apiKeyLookup.userId).toBe(userId)

    const listAfterLookupRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listApiKeys', userId }),
    })
    const listedAfterLookup = (await listAfterLookupRes.json()) as any
    expect(listedAfterLookup.apiKeys[0].lastUsedAt).toBeTruthy()

    const revokeRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revokeApiKey', userId, keyId: created.apiKeyRecord.keyId }),
    })
    expect(revokeRes.status).toBe(200)
    const revoked = (await revokeRes.json()) as any
    expect(revoked.ok).toBe(true)
    expect(revoked.apiKeyRecord.revokedAt).toBeTruthy()

    const lookupAfterRevokeRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lookupApiKey', keyHash }),
    })
    expect(lookupAfterRevokeRes.status).toBe(401)
  })

  it('stores an API user plan and returns it during key lookup', async () => {
    const { stub } = createInMemoryDirectory()
    const userId = 'user_123'

    const createRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createApiKey', userId }),
    })
    const created = (await createRes.json()) as any
    const keyHash = await sha256Hex(String(created.apiKey))

    const setPlanRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'setApiUserPlan',
        userId,
        plan: 'pro',
        provider: 'square',
        offerCode: 'launch_standard_19',
        paidAt: new Date().toISOString(),
      }),
    })
    expect(setPlanRes.status).toBe(200)

    const lookupRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lookupApiKey', keyHash }),
    })
    expect(lookupRes.status).toBe(200)
    const lookup = (await lookupRes.json()) as any
    expect(lookup.ok).toBe(true)
    expect(lookup.apiKeyLookup.userId).toBe(userId)
    expect(lookup.apiKeyLookup.plan).toBe('pro')

    const getPlanRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getApiUserPlan', userId }),
    })
    expect(getPlanRes.status).toBe(200)
    const plan = (await getPlanRes.json()) as any
    expect(plan.ok).toBe(true)
    expect(plan.apiUserPlan.plan).toBe('pro')
  })

  it('rejects invalid API user plans', async () => {
    const { stub } = createInMemoryDirectory()
    const userId = 'user_123'

    const res = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setApiUserPlan', userId, plan: 'lol' }),
    })
    expect(res.status).toBe(400)
  })

  it('stores and clears BYOK metadata on a key', async () => {
    const { stub } = createInMemoryDirectory()
    const userId = 'user_123'

    const createRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createApiKey', userId }),
    })
    const created = (await createRes.json()) as any
    const keyId = created.apiKeyRecord.keyId as string

    const setRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'setApiKeyByok',
        userId,
        keyId,
        provider: 'openai_compat',
        apiKeyEnc: 'v1:iv:cipher',
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
        model: 'openai/amazon/nova-lite',
        fingerprint: 'deadbeefdead',
      }),
    })
    expect(setRes.status).toBe(200)
    const setJson = (await setRes.json()) as any
    expect(setJson.ok).toBe(true)
    expect(setJson.apiKeyRecord.byokConfigured).toBe(true)
    expect(setJson.apiKeyRecord.byokProvider).toBe('openai_compat')

    const getRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getApiKeyById', userId, keyId }),
    })
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as any
    expect(got.ok).toBe(true)
    expect(got.apiKeyByok.provider).toBe('openai_compat')
    expect(got.apiKeyByok.keyEnc).toBe('v1:iv:cipher')

    const clearRes = await stub.fetch('https://txtclaw-directory/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearApiKeyByok', userId, keyId }),
    })
    expect(clearRes.status).toBe(200)
    const cleared = (await clearRes.json()) as any
    expect(cleared.ok).toBe(true)
    expect(cleared.apiKeyRecord.byokConfigured).toBe(false)
  })
})
