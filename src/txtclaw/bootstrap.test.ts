import { describe, expect, it } from 'vitest'
import { applyIdentityBootstrap, buildIdentityEnvelope, shouldRunBootstrap } from './bootstrap'
import type { UserRecord } from './directory-do'

function baseUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    from: 'sunshine-user:test-user',
    status: 'active',
    createdAt: '2026-02-12T00:00:00.000Z',
    updatedAt: '2026-02-12T00:00:00.000Z',
    ...overrides,
  }
}

describe('txtclaw/bootstrap', () => {
  it('runs two-question bootstrap flow and completes on third inbound', () => {
    const first = applyIdentityBootstrap({
      user: baseUser(),
      inboundBody: 'hello',
      enabled: true,
      nowIso: '2026-02-12T00:00:01.000Z',
    })
    expect(first.action).toBe('reply')
    if (first.action === 'reply') {
      expect(first.replyBody).toBe('Who are you?')
      expect(first.user.bootstrapState).toBe('ask_user_name')
    }

    const second = applyIdentityBootstrap({
      user: first.user,
      inboundBody: 'Jacob',
      enabled: true,
      nowIso: '2026-02-12T00:00:02.000Z',
    })
    expect(second.action).toBe('reply')
    if (second.action === 'reply') {
      expect(second.user.profileUserName).toBe('Jacob')
      expect(second.user.bootstrapState).toBe('ask_agent_name')
      expect(second.replyBody).toContain('What should I call myself')
    }

    const third = applyIdentityBootstrap({
      user: second.user,
      inboundBody: 'OpenClaw',
      enabled: true,
      nowIso: '2026-02-12T00:00:03.000Z',
    })
    expect(third.action).toBe('continue')
    expect(third.transition).toBe('captured_agent_name')
    expect(third.user.profileAgentName).toBe('OpenClaw')
    expect(third.user.bootstrapState).toBe('complete')
    expect(third.user.bootstrapCompletedAt).toBe('2026-02-12T00:00:03.000Z')
  })

  it('builds identity envelope only after bootstrap is complete', () => {
    const incomplete = buildIdentityEnvelope(
      baseUser({
        bootstrapState: 'ask_agent_name',
        profileUserName: 'Jacob',
      }),
    )
    expect(incomplete).toBeNull()

    const complete = buildIdentityEnvelope(
      baseUser({
        bootstrapState: 'complete',
        profileUserName: 'Jacob',
        profileAgentName: 'OpenClaw',
      }),
    )
    expect(complete).toContain('User preferred name: Jacob')
    expect(complete).toContain('Assistant preferred name: OpenClaw')
  })

  it('supports explicit bootstrap env toggle', () => {
    expect(shouldRunBootstrap({})).toBe(true)
    expect(shouldRunBootstrap({ TXTCLAW_BOOTSTRAP_ENABLED: 'true' })).toBe(true)
    expect(shouldRunBootstrap({ TXTCLAW_BOOTSTRAP_ENABLED: 'false' })).toBe(false)
  })
})
