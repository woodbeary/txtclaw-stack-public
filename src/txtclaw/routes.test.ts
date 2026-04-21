import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getFromByDedicatedNumber,
  getFromByOrder,
  getUser,
  mapDedicatedNumber,
  mapOrder,
  mapSubscription,
  putUser,
} from './directory-client'
import { TxtClawDirectory, type UserRecord } from './directory-do'
import { txtclawWebhooks } from './routes'

type MockDurableObjectStub = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function createInMemoryDirectory() {
  const store = new Map<string, unknown>()
  const state = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
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

  return { namespace, store }
}

function formBody(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

describe('txtclaw/routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('onboarding: returns assistant + checkout link and stores user/order mapping', async () => {
    const { namespace } = createInMemoryDirectory()

    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_ENABLE_TWILIO_ONBOARDING: 'true',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'test-square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_1', url: 'https://pay.example/checkout', order_id: 'order_1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const from = '+15551234567'
    const res = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hi',
          MessageSid: 'SM_onboarding_1',
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Subscribe here:')
    expect(text).toContain('TXT CLAW is a paid assistant in this thread')
    expect(text).not.toContain('Current offer:')
    expect(text).toContain('https://pay.example/checkout')

    const user = await getUser(env, from)
    expect(user?.status).toBe('pending_payment')
    expect(user?.checkout?.status).toBe('pending')
    expect(await getFromByOrder(env, 'order_1')).toBe(from)
  })

  it('onboarding: returns non-live message when Twilio onboarding is disabled', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_ENABLE_TWILIO_ONBOARDING: 'false',
    }

    const res = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: '+15551230001',
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hi',
          MessageSid: 'SM_onboarding_disabled_1',
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('SMS onboarding is currently disabled')
    expect(text).toContain('https://www.txtclaw.com/waitlist')
  })

  it('negotiates onboarding price down in $1 steps until floor', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_ENABLE_TWILIO_ONBOARDING: 'true',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'test-square-token',
      SQUARE_LOCATION_ID: 'LOC1',
      TXTCLAW_PRICE_CENTS: '1900',
      TXTCLAW_MIN_PRICE_CENTS: '1700',
      TXTCLAW_UNPAID_PROMPTS_PER_DAY: '10',
    }

    const createdAmounts: number[] = []
    let n = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        n += 1
        const payload = JSON.parse(String(init?.body || '{}'))
        createdAmounts.push(Number(payload?.quick_pay?.price_money?.amount || 0))
        return new Response(
          JSON.stringify({
            payment_link: {
              id: `pl_${n}`,
              url: `https://pay.example/checkout-${n}`,
              order_id: `order_${n}`,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const from = '+15551230100'
    const first = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hey',
          MessageSid: 'SM_neg_1',
        }),
      },
      env,
    )
    const second = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'too expensive can you lower the price',
          MessageSid: 'SM_neg_2',
        }),
      },
      env,
    )
    const third = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'still expensive, any discount?',
          MessageSid: 'SM_neg_3',
        }),
      },
      env,
    )
    const fourth = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'last try for cheaper',
          MessageSid: 'SM_neg_4',
        }),
      },
      env,
    )

    const firstText = await first.text()
    const secondText = await second.text()
    const thirdText = await third.text()
    const fourthText = await fourth.text()

    expect(firstText).toContain('Subscribe here:')
    expect(secondText).toContain('Subscribe here:')
    expect(thirdText).toContain('Subscribe here:')
    expect(fourthText).toContain('Subscribe here:')
    expect(fourthText).not.toContain('Current offer:')
    expect(createdAmounts).toEqual([1900, 1800, 1700])

    const user = await getUser(env, from)
    expect(user?.negotiatedPriceCents).toBe(1700)
    expect(user?.negotiationTurns).toBe(2)
    expect(user?.checkout?.amountCents).toBe(1700)
  })

  it('square webhook: provisions dedicated number and sends activation sms', async () => {
    const { namespace } = createInMemoryDirectory()

    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_PREFERRED_NUMBER: '+15554443333',
      TWILIO_ACCOUNT_SID: 'AC_TEST',
      TWILIO_API_KEY_SID: 'SK_TEST',
      TWILIO_API_KEY_SECRET: 'SECRET_TEST',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url.includes('/IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({ sid: 'PN1', phone_number: env.TXTCLAW_PREFERRED_NUMBER }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/Messages.json')) {
        return new Response(JSON.stringify({ sid: 'SM1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(`unhandled fetch: ${url}`, { status: 500 })
    })

    const from = '+15551234567'

    const pending: UserRecord = {
      from,
      status: 'pending_payment',
      optedInAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkout: {
        provider: 'square',
        paymentLinkId: 'pl_1',
        url: 'https://pay.example/checkout',
        orderId: 'order_1',
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    }
    await putUser(env, pending)
    await mapOrder(env, 'order_1', from)

    const event = {
      event_id: 'evt_1',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_1', order_id: 'order_1', status: 'COMPLETED' } } },
    }

    const res = await txtclawWebhooks.request(
      '/square',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
      env,
    )
    expect(res.status).toBe(200)

    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.dedicatedNumber).toBe(env.TXTCLAW_PREFERRED_NUMBER)

    const user = await getUser(env, from)
    expect(user?.status).toBe('active')
    expect(user?.dedicatedNumber).toBe(env.TXTCLAW_PREFERRED_NUMBER)
    expect(user?.sandboxKey).toBe('cust-15551234567')
    expect(user?.r2Prefix).toBe('customers/15551234567')
    expect(user?.checkout?.status).toBe('paid')
    expect(user?.squarePaymentId).toBe('pay_1')
    expect(await getFromByDedicatedNumber(env, env.TXTCLAW_PREFERRED_NUMBER)).toBe(from)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/IncomingPhoneNumbers.json'),
      expect.any(Object),
    )
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/Messages.json'), expect.any(Object))
  })

  it('square webhook: queues activation when number provisioning is disabled', async () => {
    const { namespace } = createInMemoryDirectory()

    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_DISABLE_NUMBER_PURCHASE: 'true',
      TWILIO_ACCOUNT_SID: 'AC_TEST',
      TWILIO_API_KEY_SID: 'SK_TEST',
      TWILIO_API_KEY_SECRET: 'SECRET_TEST',
    }

    const from = '+15551235555'
    await putUser(env, {
      from,
      status: 'pending_payment',
      optedInAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkout: {
        provider: 'square',
        paymentLinkId: 'pl_2',
        url: 'https://pay.example/checkout-2',
        orderId: 'order_2',
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    })
    await mapOrder(env, 'order_2', from)

    const event = {
      event_id: 'evt_2',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_2', order_id: 'order_2', status: 'COMPLETED' } } },
    }

    const res = await txtclawWebhooks.request(
      '/square',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.queued).toBe(true)
    expect(String(json.reason)).toContain('temporarily disabled')

    const user = await getUser(env, from)
    expect(user?.status).toBe('pending_payment')
    expect(user?.dedicatedNumber).toBeUndefined()
  })

  it('square webhook: activates Zendesk identities directly when enabled', async () => {
    const { namespace } = createInMemoryDirectory()

    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ZENDESK_DIRECT_ACTIVATION: 'true',
    }

    const from = 'zendesk-user:49045975046547'
    await putUser(env, {
      from,
      status: 'pending_payment',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkout: {
        provider: 'square',
        paymentLinkId: 'pl_3',
        url: 'https://pay.example/checkout-3',
        orderId: 'order_3',
        createdAt: new Date().toISOString(),
        status: 'pending',
      },
    } as any)
    await mapOrder(env, 'order_3', from)

    const event = {
      event_id: 'evt_3',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_3', order_id: 'order_3', status: 'COMPLETED' } } },
    }

    const res = await txtclawWebhooks.request(
      '/square',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
      env,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.mode).toBe('zendesk_direct_activation')
    expect(json.dedicatedNumber).toBeNull()

    const user = await getUser(env, from)
    expect(user?.status).toBe('active')
    expect(user?.squarePaymentId).toBe('pay_3')
    expect(user?.checkout?.status).toBe('paid')
    expect(user?.sandboxKey?.startsWith('custh-')).toBe(true)
  })

  it('STOP/START/HELP keywords update consent and suppress outbound messages when opted out', async () => {
    const { namespace } = createInMemoryDirectory()

    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
    }

    const from = '+15551234567'

    const stopRes = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'STOP',
          MessageSid: 'SM_stop_1',
        }),
      },
      env,
    )
    const stopText = await stopRes.text()
    expect(stopText).toContain('unsubscribed')

    const stopped = await getUser(env, from)
    expect(Boolean(stopped?.optedOutAt)).toBe(true)

    const suppressedRes = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hello',
          MessageSid: 'SM_hello_1',
        }),
      },
      env,
    )
    const suppressedText = await suppressedRes.text()
    expect(suppressedText).toContain('<Response>')
    expect(suppressedText).not.toContain('<Message>')

    const startRes = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'START',
          MessageSid: 'SM_start_1',
        }),
      },
      env,
    )
    const startText = await startRes.text()
    expect(startText).toContain('resubscribed')

    const restarted = await getUser(env, from)
    expect(Boolean(restarted?.optedOutAt)).toBe(false)

    const helpRes = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'HELP',
          MessageSid: 'SM_help_1',
        }),
      },
      env,
    )
    const helpText = await helpRes.text()
    expect(helpText).toContain('support')
    expect(helpText).toContain('STOP')

    const statusRes = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'STATUS',
          MessageSid: 'SM_status_1',
        }),
      },
      env,
    )
    const statusText = await statusRes.text()
    expect(statusText).toContain('Status:')
  })

  it('throttles unpaid onboarding prompts after daily cap', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_ENABLE_TWILIO_ONBOARDING: 'true',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'test-square-token',
      SQUARE_LOCATION_ID: 'LOC1',
      TXTCLAW_UNPAID_PROMPTS_PER_DAY: '2',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_1', url: 'https://pay.example/checkout', order_id: 'order_1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const from = '+15551234567'
    const first = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ From: from, To: env.TXTCLAW_ONBOARDING_NUMBER, Body: 'hi', MessageSid: 'SM_cap_1' }),
      },
      env,
    )
    const second = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hi2',
          MessageSid: 'SM_cap_2',
        }),
      },
      env,
    )
    const third = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: env.TXTCLAW_ONBOARDING_NUMBER,
          Body: 'hi3',
          MessageSid: 'SM_cap_3',
        }),
      },
      env,
    )

    expect(await first.text()).toContain('Subscribe here')
    expect(await second.text()).toContain('Subscribe here')
    const thirdText = await third.text()
    expect(thirdText).toContain('You reached today’s free preview limit')
    expect(thirdText).toContain('https://pay.example/checkout')
  })

  it('freezes account on subscription canceled event', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
    }

    const from = '+15551234567'
    await putUser(env, {
      from,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dedicatedNumber: '+15554443333',
    })
    await mapSubscription(env, 'sub_123', from)

    const event = {
      event_id: 'evt_sub_1',
      type: 'subscription.updated',
      data: { object: { subscription: { id: 'sub_123', status: 'CANCELED' } } },
    }

    const res = await txtclawWebhooks.request(
      '/square',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
      env,
    )

    expect(res.status).toBe(200)
    const user = await getUser(env, from)
    expect(user?.status).toBe('frozen')
    expect(user?.squareSubscriptionId).toBe('sub_123')
  })

  it('zendesk webhook: authenticates bearer and posts onboarding offer', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      ZENDESK_API_EMAIL: 'agent@example.com',
      ZENDESK_API_TOKEN: 'z-token',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_z', url: 'https://pay.example/z', order_id: 'order_z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('zendesk.com/api/v2/tickets/')) {
        return new Response(JSON.stringify({ ticket: { id: 4 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const unauthorized = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_id: 4, requester_id: 1, message: 'hi' }),
      },
      env,
    )
    expect(unauthorized.status).toBe(401)

    const authorized = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-1',
        },
        body: JSON.stringify({
          ticket_id: 4,
          ticket_channel: 'messaging',
          requester_id: 4904,
          requester_email: 'founder@example.com',
          message: 'can you help me',
        }),
      },
      env,
    )
    expect(authorized.status).toBe(200)
    const json = (await authorized.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('offer_sent')

    const user = await getUser(env, 'zendesk-user:4904')
    expect(user?.status).toBe('pending_payment')

    const ignored = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-2',
        },
        body: JSON.stringify({
          ticket_id: 5,
          ticket_channel: 'email',
          requester_id: 4905,
          requester_email: 'email-user@example.com',
          message: 'hello from email',
        }),
      },
      env,
    )
    const ignoredJson = (await ignored.json()) as any
    expect(ignoredJson.ok).toBe(true)
    expect(String(ignoredJson.reason)).toContain('unsupported_channel')
  })

  it('zendesk webhook: uses Sunshine Conversations when conversation id is present', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_s', url: 'https://pay.example/s', order_id: 'order_s' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_abc/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const authorized = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-sunshine-1',
        },
        body: JSON.stringify({
          ticket_id: 41,
          ticket_channel: 'messaging',
          conversation_id: 'conv_abc',
          requester_id: 4101,
          requester_email: 'apple-user@example.com',
          message: 'need help',
        }),
      },
      env,
    )

    expect(authorized.status).toBe(200)
    const json = (await authorized.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('offer_sent')

    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )

    const sunshineCalls = urls.filter((url) =>
      url.includes('/sc/v2/apps/app_123/conversations/conv_abc/messages'),
    )
    expect(sunshineCalls).toHaveLength(2)
    expect(urls.some((url) => url.includes('zendesk.com/api/v2/tickets/'))).toBe(false)
  })

  it('zendesk webhook: uses Sunshine app user fallback from requester_external_id', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      TXTCLAW_USE_REQUESTER_EXTERNAL_ID_AS_SUNSHINE: 'true',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_a', url: 'https://pay.example/a', order_id: 'order_a' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v1.1/apps/app_123/appusers/apple_ext_42/messages')) {
        return new Response(JSON.stringify({ messages: [{ _id: 'msg_1' }] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const authorized = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-sunshine-2',
        },
        body: JSON.stringify({
          ticket_id: 42,
          ticket_channel: 'messaging',
          requester_external_id: 'apple_ext_42',
          requester_id: 4201,
          message: 'need details',
        }),
      },
      env,
    )

    expect(authorized.status).toBe(200)
    const json = (await authorized.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('offer_sent')

    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )
    const appUserCalls = urls.filter((url) =>
      url.includes('/sc/v1.1/apps/app_123/appusers/apple_ext_42/messages'),
    )
    expect(appUserCalls).toHaveLength(2)
    expect(urls.some((url) => url.includes('zendesk.com/api/v2/tickets/'))).toBe(false)
  })

  it('zendesk webhook: normalizes apple app user identity to sunshine namespace', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      TXTCLAW_USE_REQUESTER_EXTERNAL_ID_AS_SUNSHINE: 'true',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/sc/v1.1/apps/app_123/appusers/apple_ext_42/messages')) {
        return new Response(JSON.stringify({ messages: [{ _id: 'msg_1' }] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const authorized = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-identity-1',
        },
        body: JSON.stringify({
          ticket_id: 43,
          ticket_channel: 'apple_business_chat',
          requester_external_id: 'apple_ext_42',
          requester_id: 4301,
          sunshine_app_user_id: 'apple_ext_42',
          message: '(15:20:17) Apple Messages for Business User urn:mbid:test: hello there',
          updated_by_role: 'end-user',
        }),
      },
      env,
    )

    expect(authorized.status).toBe(200)
    const json = (await authorized.json()) as any
    expect(json.ok).toBe(true)
    expect(json.from).toBe('sunshine-user:apple_ext_42')
    expect(json.action).toBe('bootstrap')

    const canonical = await getUser(env, 'sunshine-user:apple_ext_42')
    expect(canonical).toBeTruthy()
    const legacy = await getUser(env, 'zendesk:apple_ext_42')
    expect(legacy).toBeNull()
  })

  it('zendesk webhook: accepts apple_business_chat transcript and replies using latest user line', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      ZENDESK_API_EMAIL: 'agent@example.com',
      ZENDESK_API_TOKEN: 'z-token',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_apple', url: 'https://pay.example/apple', order_id: 'order_apple' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('zendesk.com/api/v2/tickets/')) {
        return new Response(JSON.stringify({ ticket: { id: 88 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const transcript = [
      '(12:43:15) Apple Messages for Business User urn:mbid:AQA...: hey, are u there?',
      '(12:43:16) TXTCLAW: auto reply from business',
      '(15:20:17) Apple Messages for Business User urn:mbid:AQA...: lower price please',
    ].join('\n')

    const res = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-1',
        },
        body: JSON.stringify({
          ticket_id: 88,
          ticket_channel: 'apple_business_chat',
          requester_id: 8801,
          message: transcript,
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('agent_reply')
  })

  it('zendesk webhook: ignores apple_business_chat transcript updates when latest line is business', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      ZENDESK_API_EMAIL: 'agent@example.com',
      ZENDESK_API_TOKEN: 'z-token',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockResolvedValue(new Response('should not be called', { status: 500 }))

    const transcript = [
      '(12:43:15) Apple Messages for Business User urn:mbid:AQA...: hello',
      '(12:43:16) TXTCLAW: this is a business line',
    ].join('\n')

    const res = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-2',
        },
        body: JSON.stringify({
          ticket_id: 89,
          ticket_channel: 'apple_business_chat',
          requester_id: 8901,
          message: transcript,
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.ignored).toBe(true)
    expect(json.reason).toBe('non_user_transcript_update')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('zendesk webhook: parses STATUS keyword from apple transcript speakers containing urn colons', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      ZENDESK_API_EMAIL: 'agent@example.com',
      ZENDESK_API_TOKEN: 'z-token',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('zendesk.com/api/v2/tickets/')) {
        return new Response(JSON.stringify({ ticket: { id: 90 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const transcript = [
      '(15:20:17) Apple Messages for Business User urn:mbid:AQAAY5S5n5/3: hello',
      '(15:21:17) Apple Messages for Business User urn:mbid:AQAAY5S5n5/3: STATUS',
    ].join('\n')

    const res = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-3',
        },
        body: JSON.stringify({
          ticket_id: 90,
          ticket_channel: 'apple_business_chat',
          requester_id: 9001,
          message: transcript,
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('status')
  })

  it('zendesk webhook: dedupes repeated apple transcript payloads to avoid replay loops', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_WEBHOOK_BEARER_TOKEN: 'zendesk-secret',
      ZENDESK_SUBDOMAIN: 'textclaw',
      ZENDESK_API_EMAIL: 'agent@example.com',
      ZENDESK_API_TOKEN: 'z-token',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_loop', url: 'https://pay.example/loop', order_id: 'order_loop' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('zendesk.com/api/v2/tickets/')) {
        return new Response(JSON.stringify({ ticket: { id: 91 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const transcript = '(15:35:10) Apple Messages for Business User urn:mbid:AQAAY5S…: can you help me?'
    const body = JSON.stringify({
      ticket_id: 91,
      ticket_channel: 'apple_business_chat',
      requester_id: 9101,
      message: transcript,
    })

    const first = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-loop-1',
        },
        body,
      },
      env,
    )
    expect(first.status).toBe(200)
    const firstJson = (await first.json()) as any
    expect(firstJson.action).toBe('agent_reply')

    const second = await txtclawWebhooks.request(
      '/zendesk/ticket',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer zendesk-secret',
          'X-Zendesk-Webhook-Invocation-Id': 'inv-z-apple-loop-2',
        },
        body,
      },
      env,
    )
    expect(second.status).toBe(200)
    const secondJson = (await second.json()) as any
    expect(secondJson.ignored).toBe(true)
    expect(secondJson.reason).toBe('duplicate_apple_transcript')
  })

  it('sunshine webhook: auto-activates appUser message and replies in-thread', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_sc', url: 'https://pay.example/sc', order_id: 'order_sc' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_123/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_sc_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_123' },
          conversation: { _id: 'conv_123' },
          messages: [
            {
              _id: 'msg_in_1',
              author: { type: 'user', userId: 'appuser_123' },
              content: { type: 'text', text: 'hello there' },
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('agent_reply')

    const user = await getUser(env, 'sunshine-user:appuser_123')
    expect(user?.status).toBe('active')
    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )
    const sunshineCalls = urls.filter((url) =>
      url.includes('/sc/v2/apps/app_123/conversations/conv_123/messages'),
    )
    expect(sunshineCalls).toHaveLength(1)
    const outboundBodies = fetchMock.mock.calls
      .filter(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return url.includes('/sc/v2/apps/app_123/conversations/conv_123/messages')
      })
      .map(([, init]) => String((init as RequestInit | undefined)?.body || ''))
    expect(outboundBodies[0]?.length).toBeGreaterThan(0)
  })

  it('sunshine webhook: bootstrap asks identity when enabled', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'true',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_bootstrap/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_bootstrap_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_bootstrap' },
          conversation: { _id: 'conv_bootstrap' },
          messages: [
            {
              _id: 'msg_bootstrap_in_1',
              author: { type: 'user', userId: 'appuser_bootstrap' },
              content: { type: 'text', text: 'hello there' },
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.action).toBe('bootstrap')

    const outboundBody = fetchMock.mock.calls
      .filter(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return url.includes('/sc/v2/apps/app_123/conversations/conv_bootstrap/messages')
      })
      .map(([, init]) => String((init as RequestInit | undefined)?.body || ''))[0]

    expect(outboundBody).toContain('Who are you?')
  })

  it('sunshine webhook: STATUS command takes precedence during bootstrap', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'true',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_bootstrap_status/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_bootstrap_status_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_bootstrap_status' },
          conversation: { _id: 'conv_bootstrap_status' },
          messages: [
            {
              _id: 'msg_bootstrap_status_in_1',
              author: { type: 'user', userId: 'appuser_bootstrap_status' },
              content: { type: 'text', text: 'hello there' },
            },
          ],
        }),
      },
      env,
    )

    const statusRes = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_bootstrap_status' },
          conversation: { _id: 'conv_bootstrap_status' },
          messages: [
            {
              _id: 'msg_bootstrap_status_in_2',
              author: { type: 'user', userId: 'appuser_bootstrap_status' },
              content: { type: 'text', text: 'STATUS' },
            },
          ],
        }),
      },
      env,
    )

    const statusJson = (await statusRes.json()) as any
    expect(statusJson.action).toBe('status')
  })

  it('sunshine webhook: supports legacy appUser payloads that use role/authorId', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_legacy', url: 'https://pay.example/legacy', order_id: 'order_legacy' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_legacy/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_legacy_out_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          conversation: { _id: 'conv_legacy' },
          messages: [
            {
              id: 'msg_legacy_in_1',
              role: 'appUser',
              authorId: 'appuser_legacy',
              text: 'hello from legacy payload',
              received: '2026-02-12T01:10:00.000Z',
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('agent_reply')

    const user = await getUser(env, 'sunshine-user:appuser_legacy')
    expect(user?.status).toBe('active')
  })

  it('sunshine webhook: selects inbound user text when payload includes mixed message types', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_mix', url: 'https://pay.example/mix', order_id: 'order_mix' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_mix/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_mix_out_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_mix' },
          conversation: { _id: 'conv_mix' },
          messages: [
            {
              _id: 'msg_delivery_marker',
              author: { type: 'business' },
              content: { type: 'text', text: 'delivery metadata' },
            },
            {
              _id: 'msg_mix_user_1',
              author: { type: 'user', userId: 'appuser_mix' },
              content: { type: 'text', text: 'actual user message' },
              received: '2026-02-12T01:15:00.000Z',
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.action).toBe('agent_reply')
  })

  it('sunshine webhook: ignores duplicate message ids', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_dup', url: 'https://pay.example/dup', order_id: 'order_dup' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_dup/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_dup_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const payload = JSON.stringify({
      trigger: 'message:appUser',
      appUser: { _id: 'appuser_dup' },
      conversation: { _id: 'conv_dup' },
      messages: [
        {
          _id: 'msg_dup_1',
          author: { type: 'user', userId: 'appuser_dup' },
          content: { type: 'text', text: 'hello' },
        },
      ],
    })

    const first = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      },
      env,
    )
    const second = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      },
      env,
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const secondJson = (await second.json()) as any
    expect(secondJson.ignored).toBe(true)
    expect(secondJson.reason).toBe('duplicate')
  })

  it('sunshine webhook: does not dedupe distinct legacy messages without ids when received timestamps differ', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_status/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_status_out_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const payloadAt = (received: string) =>
      JSON.stringify({
        trigger: 'message:appUser',
        conversation: { _id: 'conv_status' },
        messages: [
          {
            role: 'appUser',
            authorId: 'appuser_status',
            text: 'status',
            received,
          },
        ],
      })

    const first = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadAt('2026-02-12T01:20:00.000Z'),
      },
      env,
    )
    const second = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadAt('2026-02-12T01:20:04.000Z'),
      },
      env,
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const secondJson = (await second.json()) as any
    expect(secondJson.action).toBe('status')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sunshine webhook: does not suppress rapid follow-up user messages by default', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
      SQUARE_ENV: 'sandbox',
      SQUARE_ACCESS_TOKEN: 'square-token',
      SQUARE_LOCATION_ID: 'LOC1',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v2/online-checkout/payment-links')) {
        return new Response(
          JSON.stringify({
            payment_link: { id: 'pl_fast', url: 'https://pay.example/fast', order_id: 'order_fast' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_fast/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_fast_out_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const inboundPayload = (messageId: string, text: string) =>
      JSON.stringify({
        trigger: 'message:appUser',
        appUser: { _id: 'appuser_fast' },
        conversation: { _id: 'conv_fast' },
        messages: [
          {
            _id: messageId,
            author: { type: 'user', userId: 'appuser_fast' },
            content: { type: 'text', text },
          },
        ],
      })

    const first = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inboundPayload('msg_fast_in_1', 'hello'),
      },
      env,
    )
    const second = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inboundPayload('msg_fast_in_2', 'still here'),
      },
      env,
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstJson = (await first.json()) as any
    const secondJson = (await second.json()) as any
    expect(firstJson.action).toBe('agent_reply')
    expect(secondJson.action).toBe('agent_reply')

    const sunshineCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return url.includes('/sc/v2/apps/app_123/conversations/conv_fast/messages')
    })
    expect(sunshineCalls).toHaveLength(2)
  })

  it('sunshine webhook: ignores non-appUser triggers to prevent delivery loops', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
    }

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:delivery:channel',
          appUser: { _id: 'appuser_loop' },
          conversation: { _id: 'conv_loop' },
          messages: [
            {
              _id: 'msg_loop_1',
              author: { type: 'business' },
              content: { type: 'text', text: 'delivery event payload' },
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ignored).toBe(true)
    expect(json.reason).toContain('trigger:message:delivery:channel')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sunshine webhook: respects app user allowlist', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_SUNSHINE_ALLOWLIST_APP_USERS: 'allowed_user',
    }

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'blocked_user' },
          conversation: { _id: 'conv_blocked' },
          messages: [
            {
              _id: 'msg_blocked_1',
              author: { type: 'user', userId: 'blocked_user' },
              content: { type: 'text', text: 'hello' },
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ignored).toBe(true)
    expect(json.reason).toBe('appuser_not_allowlisted')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sunshine webhook: activates pending-payment app users and replies without checkout reminders', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_BOOTSTRAP_ENABLED: 'false',
      ZENDESK_SUBDOMAIN: 'textclaw',
      SUNSHINE_APP_ID: 'app_123',
      SUNSHINE_KEY_ID: 'key_123',
      SUNSHINE_KEY_SECRET: 'secret_123',
    }

    await putUser(env, {
      from: 'sunshine-user:appuser_cap',
      status: 'pending_payment',
      checkout: {
        provider: 'square',
        paymentLinkId: 'pl_cap',
        url: 'https://pay.example/cap',
        orderId: 'order_cap',
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any)

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/sc/v2/apps/app_123/conversations/conv_cap/messages')) {
        return new Response(JSON.stringify({ message: { id: 'msg_cap_1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const res = await txtclawWebhooks.request(
      '/sunshine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'message:appUser',
          appUser: { _id: 'appuser_cap' },
          conversation: { _id: 'conv_cap' },
          messages: [
            {
              _id: 'msg_cap_in_1',
              author: { type: 'user', userId: 'appuser_cap' },
              content: { type: 'text', text: 'still evaluating' },
            },
          ],
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.action).toBe('agent_reply')

    const bodies = fetchMock.mock.calls
      .filter(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return url.includes('/sc/v2/apps/app_123/conversations/conv_cap/messages')
      })
      .map(([, init]) => {
        const body = (init as RequestInit | undefined)?.body
        return typeof body === 'string' ? body : ''
      })

    expect(bodies.length).toBe(1)
    expect(bodies[0]).not.toContain('https://pay.example/cap')
    expect(bodies[0]).not.toContain('free preview limit')

    const user = await getUser(env, 'sunshine-user:appuser_cap')
    expect(user?.status).toBe('active')
  })

  it('returns warmup acknowledgement for first/cold dedicated interactions', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_WARM_ACK_AFTER_MINUTES: '30',
    }

    const from = '+15551234567'
    const dedicated = '+15554443333'
    await putUser(env, {
      from,
      status: 'active',
      dedicatedNumber: dedicated,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await mapDedicatedNumber(env, dedicated, from)

    const res = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: dedicated,
          Body: 'hello there',
          MessageSid: 'SM_dedicated_first_1',
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('waking up')
  })

  it('returns empty webhook response when dedicated session is warm', async () => {
    const { namespace } = createInMemoryDirectory()
    const env: any = {
      DEV_MODE: 'true',
      TXTCLAW_DIRECTORY: namespace,
      TXTCLAW_ONBOARDING_NUMBER: '+15550001111',
      TXTCLAW_WARM_ACK_AFTER_MINUTES: '30',
    }

    const from = '+15551234567'
    const dedicated = '+15554443333'
    await putUser(env, {
      from,
      status: 'active',
      dedicatedNumber: dedicated,
      lastOutboundAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await mapDedicatedNumber(env, dedicated, from)

    const res = await txtclawWebhooks.request(
      '/twilio/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({
          From: from,
          To: dedicated,
          Body: 'hello again',
          MessageSid: 'SM_dedicated_warm_1',
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<Response>')
    expect(text).not.toContain('<Message>')
  })
})
