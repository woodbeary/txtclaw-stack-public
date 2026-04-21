import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendZendeskTicketReply, verifyZendeskWebhookBearer } from './zendesk'

describe('txtclaw/zendesk', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('verifies bearer token', () => {
    expect(verifyZendeskWebhookBearer('abc123', 'Bearer abc123')).toBe(true)
    expect(verifyZendeskWebhookBearer('abc123', 'Bearer wrong')).toBe(false)
    expect(verifyZendeskWebhookBearer('abc123', undefined)).toBe(false)
  })

  it('sends public ticket comment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"ticket":{"id":123}}',
    })
    vi.stubGlobal('fetch', fetchMock as any)

    await sendZendeskTicketReply({
      subdomain: 'textclaw',
      email: 'agent@example.com',
      apiToken: 'token123',
      ticketId: 123,
      body: 'Hello from TXTCLAW',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://textclaw.zendesk.com/api/v2/tickets/123.json')
    expect(init.method).toBe('PUT')
  })
})
