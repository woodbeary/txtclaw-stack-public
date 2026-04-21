import { describe, expect, it } from 'vitest'
import { hmacSha1Base64 } from './crypto'
import { buildTwilioSignatureMessage, parseFormUrlEncoded, verifyTwilioSignature } from './twilio'

describe('txtclaw/twilio', () => {
  it('parses x-www-form-urlencoded bodies', () => {
    const params = parseFormUrlEncoded('From=%2B15551234567&Body=Hello%20world')
    expect(params.From).toBe('+15551234567')
    expect(params.Body).toBe('Hello world')
  })

  it('builds Twilio signature message with lexicographically sorted keys', () => {
    const msg = buildTwilioSignatureMessage('https://example.com/webhooks/twilio/sms', {
      Foo: '1',
      Bar: '2',
    })
    expect(msg).toBe('https://example.com/webhooks/twilio/smsBar2Foo1')
  })

  it('verifies Twilio signature', async () => {
    const authToken = 'test-auth-token'
    const requestUrl = 'https://example.com/webhooks/twilio/sms'
    const params = { To: '+15550001111', From: '+15551234567', Body: 'Hi' }
    const msg = buildTwilioSignatureMessage(requestUrl, params)
    const signature = await hmacSha1Base64(authToken, msg)

    const ok = await verifyTwilioSignature({
      authToken,
      requestUrl,
      params,
      expectedSignature: signature,
    })
    expect(ok).toBe(true)
  })
})
