import { describe, expect, it } from 'vitest'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './credentials'

function randomMasterKeyB64Url(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

describe('txtclaw/credentials', () => {
  it('round-trips encrypt/decrypt with AAD binding', async () => {
    const master = randomMasterKeyB64Url()
    const keyId = 'key_abc123'
    const plaintext = 'sk-test-123'

    const enc = await encryptSecret({ masterKeyB64Url: master, keyId, plaintext })
    expect(enc.startsWith('v1:')).toBe(true)

    const dec = await decryptSecret({ masterKeyB64Url: master, keyId, ciphertext: enc })
    expect(dec).toBe(plaintext)
  })

  it('fails to decrypt when keyId differs (AAD mismatch)', async () => {
    const master = randomMasterKeyB64Url()
    const enc = await encryptSecret({ masterKeyB64Url: master, keyId: 'key_1', plaintext: 'sk-test' })
    await expect(
      decryptSecret({ masterKeyB64Url: master, keyId: 'key_2', ciphertext: enc }),
    ).rejects.toBeTruthy()
  })

  it('computes fingerprint as sha256 prefix', async () => {
    const fp = await fingerprintSecret('sk-test-123')
    expect(fp).toMatch(/^[a-f0-9]{12}$/)
  })

  it('base64UrlToBytes requires input', () => {
    expect(() => base64UrlToBytes('')).toThrow()
  })
})
