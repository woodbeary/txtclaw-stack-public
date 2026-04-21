import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendSunshineAppUserReply, sendSunshineConversationReply } from './sunshine'

describe('txtclaw/sunshine', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends conversation reply through Sunshine v2 API', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: { id: 'msg_1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await sendSunshineConversationReply({
      subdomain: 'textclaw',
      appId: 'app_123',
      keyId: 'key_123',
      keySecret: 'secret_123',
      conversationId: 'conv_456',
      body: 'hello world',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://textclaw.zendesk.com/sc/v2/apps/app_123/conversations/conv_456/messages')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Basic\s+/)

    const payload = JSON.parse(String(init.body))
    expect(payload.content.type).toBe('text')
    expect(payload.content.text).toBe('hello world')
    expect(payload.author.type).toBe('business')
  })

  it('sends app user reply through Sunshine appusers API', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ _id: 'msg_2' }] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await sendSunshineAppUserReply({
      subdomain: 'textclaw.zendesk.com',
      appId: 'app_123',
      keyId: 'key_123',
      keySecret: 'secret_123',
      appUserId: 'external_789',
      body: 'offer details',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://textclaw.zendesk.com/sc/v1.1/apps/app_123/appusers/external_789/messages')

    const payload = JSON.parse(String(init.body))
    expect(payload.role).toBe('appMaker')
    expect(payload.type).toBe('text')
    expect(payload.text).toBe('offer details')
  })

  it('throws on Sunshine API errors', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))

    await expect(
      sendSunshineConversationReply({
        subdomain: 'textclaw',
        appId: 'app_123',
        keyId: 'key_123',
        keySecret: 'secret_123',
        conversationId: 'conv_456',
        body: 'hello world',
      }),
    ).rejects.toThrow(/Sunshine conversation reply failed/)
  })
})
