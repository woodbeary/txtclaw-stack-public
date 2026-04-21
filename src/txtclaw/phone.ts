export function normalizeE164(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null

  const hasPlus = value.startsWith('+')
  const digits = value.replace(/[^\d]/g, '')
  if (!digits) return null

  if (hasPlus) return `+${digits}`

  // Default to US if 10 digits are provided.
  if (digits.length === 10) return `+1${digits}`

  // If already has country code without plus.
  return `+${digits}`
}

export function isE164(value: string): boolean {
  return /^\+\d{7,15}$/.test(value)
}
