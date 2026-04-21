import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockEnv } from '../test-utils'
import { bytesToBase64Url } from '../txtclaw/credentials'
import type { UserRecord } from '../txtclaw/directory-do'
import { publicApiV1 } from './public-api-v1'

const store = new Map<string, UserRecord>()
const byokStore = new Map<
  string,
  {
    provider: string
    baseUrl?: string
    model?: string
    fingerprint?: string
    updatedAt?: string
    keyEnc: string
  }
>()

let lastBuildArgs: any = null

vi.mock('../txtclaw/directory-client', () => ({
  getUser: async (_env: any, from: string) => store.get(from) || null,
  putUser: async (_env: any, user: UserRecord) => {
    store.set(user.from, user)
    return user
  },
  getActivePromptVersion: async () => ({
    id: 'prm_default_v1',
    label: 'Default (v1)',
    content: 'You are a helpful assistant.',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  }),
  lookupApiKey: async () => ({ keyId: 'key_test', userId: 'user_1' }),
  getApiKeyById: async (_env: any, args: { userId: string; keyId: string }) => ({
    record: {
      keyId: args.keyId,
      prefix: 'vck_testprefix',
      createdAt: new Date().toISOString(),
    },
    byok: byokStore.get(args.keyId) || undefined,
  }),
  setApiKeyByok: async (_env: any, args: any) => {
    byokStore.set(args.keyId, {
      provider: args.provider,
      baseUrl: args.baseUrl,
      model: args.model,
      fingerprint: args.fingerprint,
      updatedAt: new Date().toISOString(),
      keyEnc: args.apiKeyEnc,
    })
    return {
      keyId: args.keyId,
      prefix: 'vck_testprefix',
      createdAt: new Date().toISOString(),
      byokConfigured: true,
      byokProvider: args.provider,
      byokUpdatedAt: new Date().toISOString(),
      byokFingerprint: args.fingerprint,
    }
  },
  clearApiKeyByok: async (_env: any, args: any) => {
    byokStore.delete(args.keyId)
    return {
      keyId: args.keyId,
      prefix: 'vck_testprefix',
      createdAt: new Date().toISOString(),
      byokConfigured: false,
    }
  },
  rateLimitBatch: async (_env: any, items: any[]) =>
    items.map((item) => ({
      key: item.key,
      allowed: true,
      remaining: 999999,
      resetAtMs: Date.now() + 60000,
    })),
}))

vi.mock('../txtclaw/agent', () => ({
  buildDedicatedReply: async (args: any) => {
    lastBuildArgs = args
    return {
      replyBody: `echo:${String(args.inboundBody || '')}`,
      user: args.user,
    }
  },
  prewarmDedicatedGateway: async () => {},
}))

describe('publicApiV1', () => {
  beforeEach(() => {
    store.clear()
    byokStore.clear()
    lastBuildArgs = null
  })

  it('returns 404 when public API is disabled', async () => {
    const env = createMockEnv({
      TXTCLAW_PUBLIC_API_ENABLED: 'false',
      TXTCLAW_PUBLIC_API_KEYS: 'test',
    })
    const res = await publicApiV1.request('http://localhost/status', {}, env as any)
    expect(res.status).toBe(404)
  })

  it('returns 401 when missing bearer token', async () => {
    const env = createMockEnv({
      TXTCLAW_PUBLIC_API_ENABLED: 'true',
      TXTCLAW_PUBLIC_API_KEYS: 'test',
    })
    const res = await publicApiV1.request('http://localhost/status', {}, env as any)
    expect(res.status).toBe(401)
  })

  it('creates agent and sends message', async () => {
    const apiKey = 'test-key'
    const env = createMockEnv({
      TXTCLAW_PUBLIC_API_ENABLED: 'true',
      TXTCLAW_PUBLIC_API_KEYS: apiKey,
    })

    const createRes = await publicApiV1.request(
      'http://localhost/agents',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_prompt: 'You are a helpful assistant.',
          sms: { mode: 'none' },
        }),
      },
      env as any,
    )

    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as any
    expect(created.agent_id).toMatch(/^agt_[a-f0-9]+$/)
    expect(created.status).toBe('active')

    const from = `api:${created.agent_id}`
    const stored = store.get(from)
    expect(stored).toBeTruthy()
    expect(stored?.developerSystemPrompt).toBe('You are a helpful assistant.')

    const msgRes = await publicApiV1.request(
      `http://localhost/agents/${created.agent_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello' }),
      },
      env as any,
    )

    expect(msgRes.status).toBe(200)
    const msg = (await msgRes.json()) as any
    expect(msg.reply_text).toBe('echo:hello')
    expect(msg.trace_id).toMatch(/^trc_[a-f0-9]+$/)
  })

  it('supports BYOK via /byok + byok-mode agents (directory keys only)', async () => {
    const masterBytes = new Uint8Array(32)
    crypto.getRandomValues(masterBytes)

    const apiKey = 'tok_byok'
    const env = createMockEnv({
      TXTCLAW_PUBLIC_API_ENABLED: 'true',
      TXTCLAW_PUBLIC_API_KEYS: '',
      TXTCLAW_BYOK_ENABLED: 'true',
      TXTCLAW_CREDENTIALS_MASTER_KEY: bytesToBase64Url(masterBytes),
    })

    const putRes = await publicApiV1.request(
      'http://localhost/byok',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openai_compat',
          api_key: 'sk-test-123',
          base_url: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
          model: 'openai/amazon/nova-lite',
        }),
      },
      env as any,
    )
    expect(putRes.status).toBe(200)

    const createRes = await publicApiV1.request(
      'http://localhost/agents',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_prompt: 'You are a helpful assistant.',
          llm: { mode: 'byok' },
          sms: { mode: 'none' },
        }),
      },
      env as any,
    )
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as any
    const agentId = created.agent_id as string

    const msgRes1 = await publicApiV1.request(
      `http://localhost/agents/${agentId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello' }),
      },
      env as any,
    )
    expect(msgRes1.status).toBe(200)
    expect(lastBuildArgs).toBeTruthy()
    expect(lastBuildArgs.forceGatewayRestart).toBe(true)
    expect(lastBuildArgs.runtimeEnvOverrides?.OPENAI_API_KEY).toBe('sk-test-123')

    const msgRes2 = await publicApiV1.request(
      `http://localhost/agents/${agentId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello again' }),
      },
      env as any,
    )
    expect(msgRes2.status).toBe(200)
    expect(lastBuildArgs.forceGatewayRestart).toBe(false)
  })
})
