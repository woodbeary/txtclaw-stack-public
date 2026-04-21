import { describe, expect, it } from 'vitest'
import { createMockEnv } from '../test-utils'
import {
  buildSandboxOptionsForTxtClaw,
  buildSandboxOptionsForTxtClawUser,
  deriveRuntimeIdentity,
} from './runtime'

describe('txtclaw/runtime', () => {
  it('derives stable runtime identity from phone', () => {
    const identity = deriveRuntimeIdentity('+1 (555) 123-4567')
    expect(identity.sandboxKey).toBe('cust-15551234567')
    expect(identity.r2Prefix).toBe('customers/15551234567')
  })

  it('derives stable runtime identity from non-phone handles', () => {
    const a = deriveRuntimeIdentity('zendesk:requester-4904')
    const b = deriveRuntimeIdentity('zendesk:requester-4904')
    expect(a).toEqual(b)
    expect(a.sandboxKey.startsWith('custh-')).toBe(true)
    expect(a.r2Prefix.startsWith('customers/h-')).toBe(true)
  })

  it('uses keepAlive for never sleep policy', () => {
    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: 'never' })
    expect(buildSandboxOptionsForTxtClaw(env)).toEqual({ keepAlive: true })
  })

  it('passes through configured sleep duration', () => {
    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: '10m' })
    expect(buildSandboxOptionsForTxtClaw(env)).toEqual({ sleepAfter: '10m' })
  })

  it('defaults to event-window sleep policy', () => {
    const env = createMockEnv({})
    expect(buildSandboxOptionsForTxtClaw(env)).toEqual({ sleepAfter: '1h' })
  })

  it('prefers TXTCLAW-specific sleep setting', () => {
    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: 'never', TXTCLAW_SANDBOX_SLEEP_AFTER: '5m' })
    expect(buildSandboxOptionsForTxtClaw(env)).toEqual({ sleepAfter: '5m' })
  })

  it('keeps the hosted dev API gateway warm', () => {
    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: '10m' })
    expect(buildSandboxOptionsForTxtClawUser(env, 'api-hosted')).toEqual({ keepAlive: true })
    expect(buildSandboxOptionsForTxtClawUser(env, 'cust-15551234567')).toEqual({ sleepAfter: '10m' })
  })
})
