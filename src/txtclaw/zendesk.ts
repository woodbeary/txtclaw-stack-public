export function verifyZendeskWebhookBearer(
  expectedToken: string,
  authorizationHeader: string | undefined,
): boolean {
  const token = expectedToken.trim()
  if (!token) return false
  if (!authorizationHeader) return false

  const parts = authorizationHeader.trim().split(/\s+/)
  if (parts.length !== 2) return false
  if (parts[0].toLowerCase() !== 'bearer') return false

  return parts[1] === token
}

export async function sendZendeskTicketReply(args: {
  subdomain: string
  email: string
  apiToken: string
  ticketId: number
  body: string
}): Promise<void> {
  const subdomain = args.subdomain.trim()
  const email = args.email.trim()
  const apiToken = args.apiToken.trim()
  if (!subdomain || !email || !apiToken) {
    throw new Error('Missing Zendesk API credentials')
  }

  const auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64')
  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(String(args.ticketId))}.json`
  const payload = {
    ticket: {
      comment: {
        public: true,
        body: args.body,
      },
    },
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Zendesk ticket reply failed (${res.status}): ${text}`)
  }
}
