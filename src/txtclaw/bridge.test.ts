import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBridgeReply } from './bridge'
import type { UserRecord } from './directory-do'

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    from: 'sunshine-user:test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('txtclaw/bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('falls back to template reply when AI gateway is not configured', async () => {
    const result = await buildBridgeReply({
      env: {} as any,
      user: user({ profileUserName: 'Jacob' }),
      inboundBody: 'hello',
    })

    expect(result.source).toBe('bridge_template')
    expect(result.replyBody).toContain('Jacob')
  })

  it('uses AI gateway bridge when available', async () => {
    const fetchMock = vi.mocked(fetch as any)
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [{ text: 'Absolutely, I am on it and will follow up shortly.' }],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

    const result = await buildBridgeReply({
      env: {
        AI_GATEWAY_BASE_URL: 'https://gateway.example/v1',
        AI_GATEWAY_API_KEY: 'k_test',
        AI_GATEWAY_MODEL: 'amazon/nova-lite',
      } as any,
      user: user(),
      inboundBody: 'help me summarize this',
    })

    expect(result.source).toBe('bridge_ai')
    expect(result.replyBody).toContain('on it')
  })
})
