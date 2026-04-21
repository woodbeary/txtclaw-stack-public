type Subtle = SubtleCrypto

const encoder = new TextEncoder()

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto?.subtle
}

function getSubtle(): Subtle {
  if (!hasWebCrypto()) {
    throw new Error('WebCrypto is not available in this runtime')
  }
  return globalThis.crypto.subtle
}

function normalizeBase64Url(input: string): string {
  return String(input || '')
    .trim()
    .replace(/\s+/g, '')
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i)
    }
    return out as Uint8Array<ArrayBuffer>
  }

  // Node.js fallback (tests / local tooling)
  // eslint-disable-next-line no-undef
  return new Uint8Array(Buffer.from(b64, 'base64')) as Uint8Array<ArrayBuffer>
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 1) {
      bin += String.fromCharCode(bytes[i]!)
    }
    return btoa(bin)
  }

  // Node.js fallback (tests / local tooling)
  // eslint-disable-next-line no-undef
  return Buffer.from(bytes).toString('base64')
}

export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const raw = normalizeBase64Url(input)
  if (!raw) throw new Error('Missing base64url input')

  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (b64.length % 4)) % 4
  const padded = `${b64}${'='.repeat(padLen)}`
  return base64ToBytes(padded)
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function clampKeyId(raw: string): string {
  const keyId = String(raw || '').trim()
  if (!keyId) throw new Error('Missing keyId')
  if (keyId.length > 200) throw new Error('keyId too long')
  return keyId
}

export async function sha256Hex(text: string): Promise<string> {
  // Cast to satisfy BufferSource typing in workers-types.
  const data = encoder.encode(text) as Uint8Array<ArrayBuffer>
  const digest = await getSubtle().digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function fingerprintSecret(secret: string): Promise<string> {
  const hex = await sha256Hex(secret)
  return hex.slice(0, 12)
}

async function importMasterKey(masterKeyB64Url: string): Promise<CryptoKey> {
  // Cast to satisfy BufferSource typing in workers-types.
  const bytes = base64UrlToBytes(masterKeyB64Url) as Uint8Array<ArrayBuffer>
  if (bytes.length !== 32) {
    throw new Error('TXTCLAW_CREDENTIALS_MASTER_KEY must be 32 bytes (base64url-encoded).')
  }
  return getSubtle().importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function aadForKeyId(keyId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`txtclaw:byok:${clampKeyId(keyId)}`) as Uint8Array<ArrayBuffer>
}

export async function encryptSecret(args: {
  masterKeyB64Url: string
  keyId: string
  plaintext: string
}): Promise<string> {
  const keyId = clampKeyId(args.keyId)
  const plaintext = String(args.plaintext || '')
  if (!plaintext) throw new Error('Missing plaintext')
  if (plaintext.length > 600) throw new Error('Secret too long')

  const key = await importMasterKey(args.masterKeyB64Url)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const aad = aadForKeyId(keyId)
  // Cast to satisfy BufferSource typing in workers-types.
  const encoded = encoder.encode(plaintext) as Uint8Array<ArrayBuffer>
  const cipherBuf = await getSubtle().encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
    },
    key,
    encoded,
  )

  const cipher = new Uint8Array(cipherBuf)
  return `v1:${bytesToBase64Url(iv)}:${bytesToBase64Url(cipher)}`
}

export async function decryptSecret(args: {
  masterKeyB64Url: string
  keyId: string
  ciphertext: string
}): Promise<string> {
  const keyId = clampKeyId(args.keyId)
  const ciphertext = String(args.ciphertext || '').trim()
  if (!ciphertext) throw new Error('Missing ciphertext')

  const parts = ciphertext.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Invalid ciphertext format')
  }

  const iv = base64UrlToBytes(parts[1]!)
  const cipher = base64UrlToBytes(parts[2]!)

  const key = await importMasterKey(args.masterKeyB64Url)
  const aad = aadForKeyId(keyId)
  const plainBuf = await getSubtle().decrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad,
    },
    key,
    cipher as Uint8Array<ArrayBuffer>,
  )

  return new TextDecoder().decode(new Uint8Array(plainBuf))
}
