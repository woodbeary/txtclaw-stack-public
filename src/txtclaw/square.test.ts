import { describe, expect, it } from 'vitest'
import { hmacSha256Base64 } from './crypto'
import { verifySquareWebhookSignature } from './square'

describe('txtclaw/square', () => {
  it('verifies Square webhook signature', async () => {
    const signatureKey = 'test-signature-key'
    const notificationUrl = 'https://example.com/webhooks/square'
    const rawBody = JSON.stringify({ hello: 'world' })
    const expectedSignature = await hmacSha256Base64(signatureKey, `${notificationUrl}${rawBody}`)

    const ok = await verifySquareWebhookSignature({
      signatureKey,
      notificationUrl,
      rawBody,
      expectedSignature,
    })
    expect(ok).toBe(true)
  })
})
