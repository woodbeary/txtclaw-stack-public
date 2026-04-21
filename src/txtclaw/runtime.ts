import { createHash } from 'node:crypto'
import type { MoltbotEnv } from '../types'
import { normalizeE164 } from './phone'

export type RuntimeIdentity = {
  sandboxKey: string
  r2Prefix: string
}

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, '')
}

export function deriveRuntimeIdentity(fromPhone: string): RuntimeIdentity {
  const raw = fromPhone.trim()
  const looksLikePhone = /^[\d+\-().\s]+$/.test(raw)
  const normalized = looksLikePhone ? normalizeE164(raw) : null
  if (normalized) {
    const digits = digitsOnly(normalized)
    if (!digits) {
      throw new Error('Invalid phone number for runtime identity')
    }

    return {
      sandboxKey: `cust-${digits}`,
      r2Prefix: `customers/${digits}`,
    }
  }

  const handle = fromPhone.trim().toLowerCase()
  if (!handle) {
    throw new Error('Invalid identifier for runtime identity')
  }
  const digest = createHash('sha256').update(handle).digest('hex').slice(0, 24)

  return {
    sandboxKey: `custh-${digest}`,
    r2Prefix: `customers/h-${digest}`,
  }
}

/**
 * Developer API: one gateway per TXT CLAW API key.
 *
 * This avoids cold-starting a new Sandbox/gateway process for every agent ID.
 * Agent isolation is enforced at the TXT CLAW layer (per-agent user record + prompt),
 * and OpenClaw sessions are namespaced via the `user` field in the upstream request.
 */
export function deriveApiKeyRuntimeIdentity(apiKeyId: string): RuntimeIdentity {
  const handle = `api-key:${String(apiKeyId || '')
    .trim()
    .toLowerCase()}`
  if (!handle.trim() || handle === 'api-key:') {
    throw new Error('Invalid apiKeyId for runtime identity')
  }
  const digest = createHash('sha256').update(handle).digest('hex').slice(0, 24)
  return {
    sandboxKey: `apik-${digest}`,
    r2Prefix: `api/${digest}`,
  }
}

/**
 * Developer API hosted lane: share a single gateway across accounts.
 *
 * This dramatically reduces cold-starts and avoids exhausting container instances
 * when many developers generate keys during launch. Agent isolation is still enforced
 * by TXT CLAW (unique agent IDs + per-agent system prompts), and OpenClaw sessions are
 * namespaced via the `user` field in the upstream request.
 *
 * BYOK mode intentionally does NOT use this shared runtime because it requires
 * per-customer provider credentials to be applied at gateway startup.
 */
export function deriveHostedApiRuntimeIdentity(): RuntimeIdentity {
  return {
    sandboxKey: 'api-hosted',
    r2Prefix: 'api/hosted',
  }
}

export function buildSandboxOptionsForTxtClaw(env: MoltbotEnv) {
  const sleepAfter =
    env.TXTCLAW_SANDBOX_SLEEP_AFTER?.toLowerCase() || env.SANDBOX_SLEEP_AFTER?.toLowerCase() || '1h'
  if (sleepAfter === 'never') return { keepAlive: true } as const
  return { sleepAfter } as const
}

/**
 * Hosted Developer API: keep the shared gateway warm.
 *
 * This is a single Sandbox instance (`api-hosted`) shared across all hosted-lane developer traffic,
 * so keeping it alive improves DX without exhausting container instances.
 */
export function buildSandboxOptionsForTxtClawUser(env: MoltbotEnv, sandboxKey: string) {
  if (sandboxKey === 'api-hosted') return { keepAlive: true } as const
  return buildSandboxOptionsForTxtClaw(env)
}
