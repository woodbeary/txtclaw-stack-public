function normalizeSubdomain(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return ''
  if (trimmed.endsWith('.zendesk.com')) {
    return trimmed.slice(0, -'.zendesk.com'.length)
  }
  return trimmed
}

function sunshineBaseUrl(subdomain: string): string {
  const normalized = normalizeSubdomain(subdomain)
  if (!normalized) {
    throw new Error('Missing Zendesk subdomain for Sunshine Conversations')
  }
  return `https://${normalized}.zendesk.com/sc`
}

function sunshineAuthHeader(keyId: string, keySecret: string): string {
  const id = keyId.trim()
  const secret = keySecret.trim()
  if (!id || !secret) {
    throw new Error('Missing Sunshine Conversations API credentials')
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
}

export async function sendSunshineConversationReply(args: {
  subdomain: string
  appId: string
  keyId: string
  keySecret: string
  conversationId: string
  body: string
}): Promise<void> {
  const appId = args.appId.trim()
  const conversationId = args.conversationId.trim()
  if (!appId || !conversationId) {
    throw new Error('Missing Sunshine appId or conversationId')
  }

  const url = `${sunshineBaseUrl(args.subdomain)}/v2/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}/messages`
  const payload = {
    author: { type: 'business' },
    content: {
      type: 'text',
      text: args.body,
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: sunshineAuthHeader(args.keyId, args.keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sunshine conversation reply failed (${res.status}): ${text}`)
  }
}

export async function sendSunshineAppUserReply(args: {
  subdomain: string
  appId: string
  keyId: string
  keySecret: string
  appUserId: string
  body: string
}): Promise<void> {
  const appId = args.appId.trim()
  const appUserId = args.appUserId.trim()
  if (!appId || !appUserId) {
    throw new Error('Missing Sunshine appId or appUserId')
  }

  const url = `${sunshineBaseUrl(args.subdomain)}/v1.1/apps/${encodeURIComponent(appId)}/appusers/${encodeURIComponent(appUserId)}/messages`
  const payload = {
    role: 'appMaker',
    type: 'text',
    text: args.body,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: sunshineAuthHeader(args.keyId, args.keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sunshine app user reply failed (${res.status}): ${text}`)
  }
}
