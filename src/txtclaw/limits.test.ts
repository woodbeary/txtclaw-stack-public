import { describe, expect, it } from 'vitest'
import type { UserRecord } from './directory-do'
import {
  applyInboundUsage,
  applyOutboundUsage,
  bumpUnpaidPromptCounter,
  canSendUnpaidPrompt,
  getLimitConfig,
  getUsageWarningLines,
} from './limits'

function baseUser(): UserRecord {
  return {
    from: '+15551234567',
    status: 'pending_payment',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('txtclaw/limits', () => {
  it('caps unpaid prompt count per day', () => {
    const cfg = getLimitConfig({})
    const day = new Date('2026-02-11T05:00:00.000Z')
    const user1 = bumpUnpaidPromptCounter(baseUser(), day)
    const user2 = bumpUnpaidPromptCounter(user1, day)
    expect(canSendUnpaidPrompt(user1, cfg, day)).toBe(true)
    expect(canSendUnpaidPrompt(user2, cfg, day)).toBe(false)
  })

  it('enforces inbound fast request monthly limit', () => {
    const cfg = getLimitConfig({ TXTCLAW_PRO_FAST_REQUESTS_MONTH: '1' })
    const now = new Date('2026-02-11T00:00:00.000Z')
    const first = applyInboundUsage({ ...baseUser(), status: 'active' }, cfg, now)
    expect(first.allowed).toBe(true)
    const second = applyInboundUsage(first.user, cfg, now)
    expect(second.allowed).toBe(false)
    expect(second.reason).toBe('fast_request_month_limit')
  })

  it('enforces outbound daily/monthly limits', () => {
    const cfg = getLimitConfig({
      TXTCLAW_PRO_OUTBOUND_PER_DAY: '1',
      TXTCLAW_PRO_OUTBOUND_PER_WEEK: '1',
      TXTCLAW_PRO_OUTBOUND_PER_MONTH: '1',
    })
    const now = new Date('2026-02-11T00:00:00.000Z')
    const first = applyOutboundUsage({ ...baseUser(), status: 'active' }, cfg, now)
    expect(first.allowed).toBe(true)
    const second = applyOutboundUsage(first.user, cfg, now)
    expect(second.allowed).toBe(false)
    expect(['outbound_day_limit', 'outbound_week_limit', 'outbound_month_limit']).toContain(second.reason)
  })

  it('enforces weekly inbound limit', () => {
    const cfg = getLimitConfig({
      TXTCLAW_PRO_FAST_REQUESTS_MONTH: '100',
      TXTCLAW_PRO_INBOUND_PER_DAY: '100',
      TXTCLAW_PRO_INBOUND_PER_WEEK: '2',
    })
    const now = new Date('2026-02-11T00:00:00.000Z')
    const first = applyInboundUsage({ ...baseUser(), status: 'active' }, cfg, now)
    expect(first.allowed).toBe(true)
    const second = applyInboundUsage(first.user, cfg, now)
    expect(second.allowed).toBe(true)
    const third = applyInboundUsage(second.user, cfg, now)
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe('inbound_week_limit')
  })

  it('emits warnings at 80%+ for daily and weekly usage', () => {
    const cfg = getLimitConfig({
      TXTCLAW_PRO_INBOUND_PER_DAY: '10',
      TXTCLAW_PRO_INBOUND_PER_WEEK: '50',
      TXTCLAW_PRO_OUTBOUND_PER_DAY: '10',
      TXTCLAW_PRO_OUTBOUND_PER_WEEK: '50',
      TXTCLAW_PRO_OUTBOUND_PER_MONTH: '100',
      TXTCLAW_PRO_FAST_REQUESTS_MONTH: '10',
      TXTCLAW_PRO_ESTIMATED_SPEND_CAP_CENTS: '1000',
    })

    const user: UserRecord = {
      ...baseUser(),
      status: 'active',
      inboundDayCount: 8,
      inboundWeekCount: 40,
      outboundDayCount: 8,
      outboundWeekCount: 40,
      outboundMonthCount: 80,
      fastRequestMonthCount: 8,
      estimatedSpendCentsMonth: 800,
    }

    const warnings = getUsageWarningLines(user, cfg)
    expect(warnings.some((line) => line.includes('inbound messages (daily)'))).toBe(true)
    expect(warnings.some((line) => line.includes('inbound messages (weekly)'))).toBe(true)
    expect(warnings.some((line) => line.includes('outbound messages (daily)'))).toBe(true)
    expect(warnings.some((line) => line.includes('outbound messages (weekly)'))).toBe(true)
    expect(warnings.some((line) => line.includes('estimated spend (monthly cents)'))).toBe(true)
  })

  it('enforces hard estimated spend cap', () => {
    const cfg = getLimitConfig({
      TXTCLAW_PRO_ESTIMATED_SPEND_CAP_CENTS: '3',
      TXTCLAW_FAST_REQUEST_COST_CENTS: '2',
    })
    const now = new Date('2026-02-11T00:00:00.000Z')
    const first = applyInboundUsage({ ...baseUser(), status: 'active' }, cfg, now)
    expect(first.allowed).toBe(true)
    const second = applyInboundUsage(first.user, cfg, now)
    expect(second.allowed).toBe(false)
    expect(second.reason).toBe('estimated_spend_cap')
  })
})
