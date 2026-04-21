import { hmacSha1Base64, timingSafeEqual, toBase64, toUtf8Bytes } from './crypto'

export type TwilioSmsWebhook = {
  MessageSid?: string
  SmsSid?: string
  AccountSid?: string
  MessagingServiceSid?: string
  From?: string
  To?: string
  Body?: string
  NumMedia?: string
}

export function parseFormUrlEncoded(bodyText: string): Record<string, string> {
  const params = new URLSearchParams(bodyText)
  const out: Record<string, string> = {}
  for (const [k, v] of params.entries()) out[k] = v
  return out
}

export function buildTwilioSignatureMessage(url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort()
  let msg = url
  for (const key of sorted) {
    msg += key + params[key]!
  }
  return msg
}

export async function verifyTwilioSignature(args: {
  authToken: string
  requestUrl: string
  params: Record<string, string>
  expectedSignature: string | null | undefined
}): Promise<boolean> {
  const expected = args.expectedSignature?.trim()
  if (!expected) return false

  const msg = buildTwilioSignatureMessage(args.requestUrl, args.params)
  const actual = await hmacSha1Base64(args.authToken, msg)
  return timingSafeEqual(actual, expected)
}

export async function sendTwilioSms(args: {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  from: string
  to: string
  body: string
  statusCallbackUrl?: string
}): Promise<unknown> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(args.accountSid)}/Messages.json`
  const auth = toBase64(toUtf8Bytes(`${args.apiKeySid}:${args.apiKeySecret}`))

  const form = new URLSearchParams()
  form.set('From', args.from)
  form.set('To', args.to)
  form.set('Body', args.body)
  if (args.statusCallbackUrl) form.set('StatusCallback', args.statusCallbackUrl)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: form.toString(),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Twilio send failed (${res.status}): ${text}`)
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function buyTwilioPhoneNumber(args: {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  phoneNumberE164: string
  friendlyName?: string
  smsUrl?: string
  smsMethod?: 'GET' | 'POST'
}): Promise<{ sid: string; phoneNumber: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(args.accountSid)}/IncomingPhoneNumbers.json`
  const auth = toBase64(toUtf8Bytes(`${args.apiKeySid}:${args.apiKeySecret}`))

  const form = new URLSearchParams()
  form.set('PhoneNumber', args.phoneNumberE164)
  if (args.friendlyName) form.set('FriendlyName', args.friendlyName)
  if (args.smsUrl) form.set('SmsUrl', args.smsUrl)
  if (args.smsMethod) form.set('SmsMethod', args.smsMethod)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: form.toString(),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Twilio buy number failed (${res.status}): ${text}`)

  const json = JSON.parse(text) as { sid: string; phone_number: string }
  return { sid: json.sid, phoneNumber: json.phone_number }
}

export async function updateTwilioIncomingNumber(args: {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  incomingPhoneNumberSid: string
  friendlyName?: string
  smsUrl?: string
  smsMethod?: 'GET' | 'POST'
}): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(args.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(args.incomingPhoneNumberSid)}.json`
  const auth = toBase64(toUtf8Bytes(`${args.apiKeySid}:${args.apiKeySecret}`))

  const form = new URLSearchParams()
  if (args.friendlyName) form.set('FriendlyName', args.friendlyName)
  if (args.smsUrl) form.set('SmsUrl', args.smsUrl)
  if (args.smsMethod) form.set('SmsMethod', args.smsMethod)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: form.toString(),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Twilio update number failed (${res.status}): ${text}`)
}

type TwilioAvailableNumber = {
  phone_number: string
}

export async function findTwilioAvailableLocalNumber(args: {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  country: 'US'
  areaCode?: string
  contains?: string
}): Promise<string> {
  const auth = toBase64(toUtf8Bytes(`${args.apiKeySid}:${args.apiKeySecret}`))

  const qs = new URLSearchParams()
  if (args.areaCode) qs.set('AreaCode', args.areaCode)
  if (args.contains) qs.set('Contains', args.contains)
  // Reduce risk of selecting a non-SMS-capable number.
  qs.set('SmsEnabled', 'true')

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(args.accountSid)}/AvailablePhoneNumbers/${args.country}/Local.json?${qs.toString()}`

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` },
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Twilio available numbers failed (${res.status}): ${text}`)

  const json = JSON.parse(text) as { available_phone_numbers?: TwilioAvailableNumber[] }
  const number = json.available_phone_numbers?.[0]?.phone_number
  if (!number) throw new Error('No available Twilio local numbers found')
  return number
}
