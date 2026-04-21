import type { UserRecord } from './directory-do'

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

function utcWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

export type TxtClawLimitConfig = {
  unpaidPromptsPerDay: number
  proFastRequestsPerMonth: number
  proInboundPerDay: number
  proInboundPerWeek: number
  proOutboundPerDay: number
  proOutboundPerWeek: number
  proOutboundPerMonth: number
  proEstimatedSpendCapCents: number
  smsSegmentCostCents: number
  fastRequestCostCents: number
}

export function getLimitConfig(env: {
  TXTCLAW_UNPAID_PROMPTS_PER_DAY?: string
  TXTCLAW_PRO_FAST_REQUESTS_MONTH?: string
  TXTCLAW_PRO_INBOUND_PER_DAY?: string
  TXTCLAW_PRO_INBOUND_PER_WEEK?: string
  TXTCLAW_PRO_OUTBOUND_PER_DAY?: string
  TXTCLAW_PRO_OUTBOUND_PER_WEEK?: string
  TXTCLAW_PRO_OUTBOUND_PER_MONTH?: string
  TXTCLAW_PRO_ESTIMATED_SPEND_CAP_CENTS?: string
  TXTCLAW_SMS_SEGMENT_COST_CENTS?: string
  TXTCLAW_FAST_REQUEST_COST_CENTS?: string
}): TxtClawLimitConfig {
  const proInboundPerDay = parsePositiveInt(env.TXTCLAW_PRO_INBOUND_PER_DAY, 400)
  const proOutboundPerDay = parsePositiveInt(env.TXTCLAW_PRO_OUTBOUND_PER_DAY, 400)
  return {
    unpaidPromptsPerDay: parsePositiveInt(env.TXTCLAW_UNPAID_PROMPTS_PER_DAY, 2),
    proFastRequestsPerMonth: parsePositiveInt(env.TXTCLAW_PRO_FAST_REQUESTS_MONTH, 500),
    proInboundPerDay,
    proInboundPerWeek: parsePositiveInt(env.TXTCLAW_PRO_INBOUND_PER_WEEK, proInboundPerDay * 7),
    proOutboundPerDay,
    proOutboundPerWeek: parsePositiveInt(env.TXTCLAW_PRO_OUTBOUND_PER_WEEK, proOutboundPerDay * 7),
    proOutboundPerMonth: parsePositiveInt(env.TXTCLAW_PRO_OUTBOUND_PER_MONTH, 3000),
    // 0 disables the hard spend cap. Default keeps a margin guardrail enabled.
    proEstimatedSpendCapCents: parseNonNegativeInt(env.TXTCLAW_PRO_ESTIMATED_SPEND_CAP_CENTS, 1600),
    smsSegmentCostCents: parsePositiveInt(env.TXTCLAW_SMS_SEGMENT_COST_CENTS, 1),
    fastRequestCostCents: parsePositiveInt(env.TXTCLAW_FAST_REQUEST_COST_CENTS, 2),
  }
}

export function bumpUnpaidPromptCounter(user: UserRecord, now = new Date()): UserRecord {
  const day = utcDay(now)
  const count = user.onboardingPromptDay === day ? user.onboardingPromptCount || 0 : 0
  return {
    ...user,
    onboardingPromptDay: day,
    onboardingPromptCount: count + 1,
  }
}

export function canSendUnpaidPrompt(user: UserRecord, config: TxtClawLimitConfig, now = new Date()): boolean {
  const day = utcDay(now)
  const count = user.onboardingPromptDay === day ? user.onboardingPromptCount || 0 : 0
  return count < config.unpaidPromptsPerDay
}

export function applyInboundUsage(
  user: UserRecord,
  config: TxtClawLimitConfig,
  now = new Date(),
): { user: UserRecord; allowed: boolean; reason?: string } {
  const day = utcDay(now)
  const week = utcWeek(now)
  const month = utcMonth(now)
  const inboundDayCount = (user.usageDay === day ? user.inboundDayCount || 0 : 0) + 1
  const inboundWeekCount = (user.usageWeek === week ? user.inboundWeekCount || 0 : 0) + 1
  const outboundDayCount = user.usageDay === day ? user.outboundDayCount || 0 : 0
  const outboundWeekCount = user.usageWeek === week ? user.outboundWeekCount || 0 : 0
  const inboundMonthCount = (user.usageMonth === month ? user.inboundMonthCount || 0 : 0) + 1
  const outboundMonthCount = user.usageMonth === month ? user.outboundMonthCount || 0 : 0
  const fastRequestMonthCount = (user.usageMonth === month ? user.fastRequestMonthCount || 0 : 0) + 1
  const estimatedSpendCentsMonth =
    (user.usageMonth === month ? user.estimatedSpendCentsMonth || 0 : 0) + config.fastRequestCostCents

  const next: UserRecord = {
    ...user,
    usageDay: day,
    usageWeek: week,
    usageMonth: month,
    inboundDayCount,
    inboundWeekCount,
    inboundMonthCount,
    outboundDayCount,
    outboundWeekCount,
    outboundMonthCount,
    fastRequestMonthCount,
    estimatedSpendCentsMonth,
  }

  // Pro defaults currently used for all plans unless expanded.
  if (fastRequestMonthCount > config.proFastRequestsPerMonth) {
    return { user: next, allowed: false, reason: 'fast_request_month_limit' }
  }
  if (inboundDayCount > config.proInboundPerDay) {
    return { user: next, allowed: false, reason: 'inbound_day_limit' }
  }
  if (inboundWeekCount > config.proInboundPerWeek) {
    return { user: next, allowed: false, reason: 'inbound_week_limit' }
  }
  if (config.proEstimatedSpendCapCents > 0 && estimatedSpendCentsMonth > config.proEstimatedSpendCapCents) {
    return { user: next, allowed: false, reason: 'estimated_spend_cap' }
  }

  return { user: next, allowed: true }
}

export function applyOutboundUsage(
  user: UserRecord,
  config: TxtClawLimitConfig,
  now = new Date(),
): { user: UserRecord; allowed: boolean; reason?: string } {
  const day = utcDay(now)
  const week = utcWeek(now)
  const month = utcMonth(now)
  const inboundDayCount = user.usageDay === day ? user.inboundDayCount || 0 : 0
  const outboundDayCount = (user.usageDay === day ? user.outboundDayCount || 0 : 0) + 1
  const inboundWeekCount = user.usageWeek === week ? user.inboundWeekCount || 0 : 0
  const outboundWeekCount = (user.usageWeek === week ? user.outboundWeekCount || 0 : 0) + 1
  const inboundMonthCount = user.usageMonth === month ? user.inboundMonthCount || 0 : 0
  const outboundMonthCount = (user.usageMonth === month ? user.outboundMonthCount || 0 : 0) + 1
  const fastRequestMonthCount = user.usageMonth === month ? user.fastRequestMonthCount || 0 : 0
  const estimatedSpendCentsMonth =
    (user.usageMonth === month ? user.estimatedSpendCentsMonth || 0 : 0) + config.smsSegmentCostCents

  const next: UserRecord = {
    ...user,
    usageDay: day,
    usageWeek: week,
    usageMonth: month,
    inboundDayCount,
    inboundWeekCount,
    inboundMonthCount,
    outboundDayCount,
    outboundWeekCount,
    outboundMonthCount,
    fastRequestMonthCount,
    estimatedSpendCentsMonth,
  }

  if (outboundDayCount > config.proOutboundPerDay) {
    return { user: next, allowed: false, reason: 'outbound_day_limit' }
  }
  if (outboundWeekCount > config.proOutboundPerWeek) {
    return { user: next, allowed: false, reason: 'outbound_week_limit' }
  }
  if (outboundMonthCount > config.proOutboundPerMonth) {
    return { user: next, allowed: false, reason: 'outbound_month_limit' }
  }
  if (config.proEstimatedSpendCapCents > 0 && estimatedSpendCentsMonth > config.proEstimatedSpendCapCents) {
    return { user: next, allowed: false, reason: 'estimated_spend_cap' }
  }

  return { user: next, allowed: true }
}

type UsageMetric = {
  label: string
  current: number
  cap: number
}

function warnLine(metric: UsageMetric): string {
  const pct = Math.min(999, Math.floor((metric.current / metric.cap) * 100))
  return `Usage warning: ${metric.label} at ${pct}% (${metric.current}/${metric.cap}).`
}

export function getUsageWarningLines(
  user: UserRecord,
  config: TxtClawLimitConfig,
  threshold = 0.8,
): string[] {
  const metrics: UsageMetric[] = [
    {
      label: 'fast requests (monthly)',
      current: user.fastRequestMonthCount || 0,
      cap: config.proFastRequestsPerMonth,
    },
    { label: 'inbound messages (daily)', current: user.inboundDayCount || 0, cap: config.proInboundPerDay },
    {
      label: 'inbound messages (weekly)',
      current: user.inboundWeekCount || 0,
      cap: config.proInboundPerWeek,
    },
    {
      label: 'outbound messages (daily)',
      current: user.outboundDayCount || 0,
      cap: config.proOutboundPerDay,
    },
    {
      label: 'outbound messages (weekly)',
      current: user.outboundWeekCount || 0,
      cap: config.proOutboundPerWeek,
    },
    {
      label: 'outbound messages (monthly)',
      current: user.outboundMonthCount || 0,
      cap: config.proOutboundPerMonth,
    },
    {
      label: 'estimated spend (monthly cents)',
      current: user.estimatedSpendCentsMonth || 0,
      cap: config.proEstimatedSpendCapCents,
    },
  ]

  return metrics
    .filter((metric) => metric.cap > 0)
    .filter((metric) => metric.current / metric.cap >= threshold)
    .map(warnLine)
}
