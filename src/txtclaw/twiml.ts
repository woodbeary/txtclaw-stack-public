function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function twimlMessage(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Message>${escapeXml(body)}</Message>`,
    '</Response>',
  ].join('')
}

// Use when we intentionally want to send no outbound SMS (e.g. dedupe / opted-out).
export function twimlEmpty(): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', '</Response>'].join('')
}
