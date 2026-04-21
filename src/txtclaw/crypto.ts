const encoder = new TextEncoder()

export function toUtf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  // Cast to satisfy BufferSource typing in workers-types (avoids ArrayBufferLike/SharedArrayBuffer unions).
  return encoder.encode(value) as Uint8Array<ArrayBuffer>
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!)
  return btoa(binary)
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

export async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toUtf8Bytes(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, toUtf8Bytes(message))
  return toBase64(signature)
}

export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toUtf8Bytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, toUtf8Bytes(message))
  return toBase64(signature)
}
