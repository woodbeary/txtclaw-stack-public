import { hmacSha256Base64, timingSafeEqual } from './crypto'

type SquareEnv = 'sandbox' | 'production'

function getSquareBaseUrl(env: SquareEnv): string {
  return env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
}

export type SquareLocation = {
  id: string
  name?: string
  status?: string
}

export type CreatePaymentLinkResult = {
  id: string
  url: string
  orderId: string | null
}

export type SquareWebhookEvent = {
  merchant_id?: string
  type: string
  event_id: string
  created_at?: string
  data?: unknown
}

export async function squareFetch(args: {
  env: SquareEnv
  accessToken: string
  path: string
  init?: RequestInit
}): Promise<Response> {
  const url = `${getSquareBaseUrl(args.env)}${args.path}`
  const res = await fetch(url, {
    ...args.init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.accessToken}`,
      ...(args.init?.headers || {}),
    },
  })
  return res
}

export async function listSquareLocations(args: {
  env: SquareEnv
  accessToken: string
}): Promise<SquareLocation[]> {
  const res = await squareFetch({
    env: args.env,
    accessToken: args.accessToken,
    path: '/v2/locations',
    init: { method: 'GET' },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Square locations failed (${res.status}): ${text}`)
  const json = JSON.parse(text) as { locations?: SquareLocation[] }
  return json.locations || []
}

export async function createSquarePaymentLink(args: {
  env: SquareEnv
  accessToken: string
  idempotencyKey: string
  locationId: string
  name: string
  amountCents: number
  currency: string
  redirectUrl?: string
  note?: string
}): Promise<CreatePaymentLinkResult> {
  const body = {
    idempotency_key: args.idempotencyKey,
    quick_pay: {
      name: args.name,
      price_money: {
        amount: args.amountCents,
        currency: args.currency,
      },
      location_id: args.locationId,
    },
    checkout_options: args.redirectUrl
      ? {
          redirect_url: args.redirectUrl,
        }
      : undefined,
    payment_note: args.note,
  }

  const res = await squareFetch({
    env: args.env,
    accessToken: args.accessToken,
    path: '/v2/online-checkout/payment-links',
    init: { method: 'POST', body: JSON.stringify(body) },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Square create payment link failed (${res.status}): ${text}`)

  const json = JSON.parse(text) as {
    payment_link: { id: string; url: string; order_id?: string | null }
  }

  return {
    id: json.payment_link.id,
    url: json.payment_link.url,
    orderId: json.payment_link.order_id ?? null,
  }
}

export async function verifySquareWebhookSignature(args: {
  signatureKey: string
  notificationUrl: string
  rawBody: string
  expectedSignature: string | null | undefined
}): Promise<boolean> {
  const expected = args.expectedSignature?.trim()
  if (!expected) return false

  const msg = `${args.notificationUrl}${args.rawBody}`
  const actual = await hmacSha256Base64(args.signatureKey, msg)
  return timingSafeEqual(actual, expected)
}

export async function createSquareWebhookSubscription(args: {
  env: SquareEnv
  accessToken: string
  idempotencyKey: string
  name: string
  notificationUrl: string
  eventTypes: string[]
  apiVersion?: string
}): Promise<{ id: string; signatureKey: string }> {
  const body = {
    idempotency_key: args.idempotencyKey,
    subscription: {
      name: args.name,
      event_types: args.eventTypes,
      notification_url: args.notificationUrl,
      api_version: args.apiVersion,
    },
  }

  const res = await squareFetch({
    env: args.env,
    accessToken: args.accessToken,
    path: '/v2/webhooks/subscriptions',
    init: { method: 'POST', body: JSON.stringify(body) },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Square create webhook subscription failed (${res.status}): ${text}`)

  const json = JSON.parse(text) as { subscription: { id: string; signature_key: string } }
  return { id: json.subscription.id, signatureKey: json.subscription.signature_key }
}

export async function testSquareWebhookSubscription(args: {
  env: SquareEnv
  accessToken: string
  subscriptionId: string
  eventType: string
}): Promise<void> {
  const body = { event_type: args.eventType }
  const res = await squareFetch({
    env: args.env,
    accessToken: args.accessToken,
    path: `/v2/webhooks/subscriptions/${encodeURIComponent(args.subscriptionId)}/test`,
    init: { method: 'POST', body: JSON.stringify(body) },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Square test webhook failed (${res.status}): ${text}`)
}
