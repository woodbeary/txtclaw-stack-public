import { describe, expect, it } from 'vitest'
import { bytesToBase64Url } from '../txtclaw/credentials'
import { TxtClawDirectory } from '../txtclaw/directory-do'
import { consoleRoutes } from './console'

type MockDurableObjectStub = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function createInMemoryDirectoryNamespace() {
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

  const namespace = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (_id: DurableObjectId) => stub as unknown as DurableObjectStub,
  }

  return { namespace }
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

describe('consoleRoutes', () => {
  it('requires service token', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
    }

    const res = await consoleRoutes.request('http://localhost/v1/api-keys?user_id=u1', {}, env)
    expect(res.status).toBe(401)
  })

  it('creates, lists, and revokes an API key', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
      TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER: '3',
      TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER: '5',
    }

    const createRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1', label: 'test' }),
      },
      env,
    )
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as any
    expect(created.ok).toBe(true)
    expect(created.api_key).toMatch(/^vck_/)
    expect(created.record.keyId).toMatch(/^key_/)

    const listRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys?user_id=user_1',
      {
        method: 'GET',
        headers: authHeaders('svc'),
      },
      env,
    )
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as any
    expect(listed.ok).toBe(true)
    expect(listed.api_keys.length).toBe(1)

    const revokeRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys/revoke',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1', key_id: created.record.keyId }),
      },
      env,
    )
    expect(revokeRes.status).toBe(200)
    const revoked = (await revokeRes.json()) as any
    expect(revoked.ok).toBe(true)
    expect(revoked.record.revokedAt).toBeTruthy()
  })

  it('enforces max active keys', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
      TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER: '1',
      TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER: '5',
    }

    const first = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1' }),
      },
      env,
    )
    expect(first.status).toBe(200)

    const second = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1' }),
      },
      env,
    )
    expect(second.status).toBe(409)
  })

  it('rate limits key creation attempts', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
      TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER: '10',
      TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER: '1',
    }

    const first = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1' }),
      },
      env,
    )
    expect(first.status).toBe(200)

    const second = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1' }),
      },
      env,
    )
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
  })

  it('sets and clears BYOK on an API key', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const masterBytes = new Uint8Array(32)
    crypto.getRandomValues(masterBytes)

    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
      TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER: '3',
      TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER: '5',
      TXTCLAW_BYOK_ENABLED: 'true',
      TXTCLAW_CREDENTIALS_MASTER_KEY: bytesToBase64Url(masterBytes),
      TXTCLAW_BYOK_SET_PER_HOUR_PER_KEY: '5',
    }

    const createRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1', label: 'test' }),
      },
      env,
    )
    const created = (await createRes.json()) as any
    const keyId = created.record.keyId as string

    const setRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys/byok',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({
          user_id: 'user_1',
          key_id: keyId,
          provider: 'openai_compat',
          api_key: 'sk-test-123',
          base_url: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
          model: 'openai/amazon/nova-lite',
        }),
      },
      env,
    )
    expect(setRes.status).toBe(200)
    const setJson = (await setRes.json()) as any
    expect(setJson.ok).toBe(true)
    expect(setJson.record.byokConfigured).toBe(true)
    expect(setJson.record.byokProvider).toBe('openai_compat')
    expect(setJson.record.byokFingerprint).toMatch(/^[a-f0-9]{12}$/)

    const listRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys?user_id=user_1',
      {
        method: 'GET',
        headers: authHeaders('svc'),
      },
      env,
    )
    const listed = (await listRes.json()) as any
    expect(listed.api_keys[0].byokConfigured).toBe(true)

    const clearRes = await consoleRoutes.request(
      'http://localhost/v1/api-keys/byok/clear',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ user_id: 'user_1', key_id: keyId }),
      },
      env,
    )
    expect(clearRes.status).toBe(200)
    const cleared = (await clearRes.json()) as any
    expect(cleared.ok).toBe(true)
    expect(cleared.record.byokConfigured).toBe(false)
  })

  it('creates and activates prompt versions', async () => {
    const { namespace } = createInMemoryDirectoryNamespace()
    const env: any = {
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_CONSOLE_SERVICE_TOKEN: 'svc',
    }

    const listRes = await consoleRoutes.request(
      'http://localhost/v1/prompts',
      {
        method: 'GET',
        headers: authHeaders('svc'),
      },
      env,
    )
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as any
    expect(listed.ok).toBe(true)
    expect(Array.isArray(listed.prompt_versions)).toBe(true)
    expect(typeof listed.active_prompt_id === 'string').toBe(true)

    const createRes = await consoleRoutes.request(
      'http://localhost/v1/prompts',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({
          label: 'Experiment',
          content: 'You are a helpful assistant.',
          created_by: 'admin@example.com',
        }),
      },
      env,
    )
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as any
    expect(created.ok).toBe(true)
    expect(created.prompt_version.id).toMatch(/^prm_/)
    expect(created.active_prompt_id).toBe(created.prompt_version.id)

    const activeRes = await consoleRoutes.request(
      'http://localhost/v1/prompts/active',
      {
        method: 'GET',
        headers: authHeaders('svc'),
      },
      env,
    )
    expect(activeRes.status).toBe(200)
    const active = (await activeRes.json()) as any
    expect(active.ok).toBe(true)
    expect(active.active_prompt_id).toBe(created.prompt_version.id)

    const activateRes = await consoleRoutes.request(
      'http://localhost/v1/prompts/activate',
      {
        method: 'POST',
        headers: authHeaders('svc'),
        body: JSON.stringify({ id: 'prm_default_v1' }),
      },
      env,
    )
    expect(activateRes.status).toBe(200)
    const activated = (await activateRes.json()) as any
    expect(activated.ok).toBe(true)
    expect(activated.active_prompt_id).toBe('prm_default_v1')
  })
})
