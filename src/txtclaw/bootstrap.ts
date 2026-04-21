import type { UserRecord } from './directory-do'

export type BootstrapResult =
  | {
      action: 'reply'
      user: UserRecord
      replyBody: string
      transition: 'asked_user_name' | 'captured_user_name' | 'captured_agent_name'
    }
  | {
      action: 'continue'
      user: UserRecord
      transition: 'already_complete' | 'disabled' | 'captured_agent_name'
    }

function normalizeName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim()

  if (!cleaned) return fallback
  if (cleaned.length <= 40) return cleaned
  return cleaned.slice(0, 40).trim()
}

function isTrueByDefault(raw: string | undefined, defaultValue = true): boolean {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
  if (!normalized) return defaultValue
  if (['false', '0', 'off', 'no'].includes(normalized)) return false
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true
  return defaultValue
}

export function shouldRunBootstrap(env: {
  TXTCLAW_BOOTSTRAP_ENABLED?: string
}): boolean {
  return isTrueByDefault(env.TXTCLAW_BOOTSTRAP_ENABLED, true)
}

export function applyIdentityBootstrap(args: {
  user: UserRecord
  inboundBody: string
  enabled: boolean
  nowIso?: string
}): BootstrapResult {
  if (!args.enabled) {
    return {
      action: 'continue',
      user: args.user,
      transition: 'disabled',
    }
  }

  const alreadyComplete = args.user.bootstrapState === 'complete' || Boolean(args.user.bootstrapCompletedAt)
  if (alreadyComplete) {
    return {
      action: 'continue',
      user: {
        ...args.user,
        bootstrapState: 'complete',
      },
      transition: 'already_complete',
    }
  }

  const now = args.nowIso || new Date().toISOString()
  const state = args.user.bootstrapState

  if (state === 'ask_agent_name') {
    const profileAgentName = normalizeName(args.inboundBody, 'OpenClaw')
    const nextUser: UserRecord = {
      ...args.user,
      profileAgentName,
      bootstrapState: 'complete',
      bootstrapCompletedAt: now,
    }

    return {
      action: 'continue',
      user: nextUser,
      transition: 'captured_agent_name',
    }
  }

  if (state === 'ask_user_name') {
    const profileUserName = normalizeName(args.inboundBody, 'there')
    const nextUser: UserRecord = {
      ...args.user,
      profileUserName,
      bootstrapState: 'ask_agent_name',
    }

    return {
      action: 'reply',
      user: nextUser,
      transition: 'captured_user_name',
      replyBody: `Got it, ${profileUserName}. What should I call myself when I reply to you?`,
    }
  }

  const nextUser: UserRecord = {
    ...args.user,
    bootstrapState: 'ask_user_name',
  }

  return {
    action: 'reply',
    user: nextUser,
    transition: 'asked_user_name',
    replyBody: 'Who are you?',
  }
}

export function buildIdentityEnvelope(user: UserRecord): string | null {
  if (user.bootstrapState !== 'complete') return null
  const person = user.profileUserName?.trim()
  const agent = user.profileAgentName?.trim()
  if (!person || !agent) return null

  return [
    'Identity profile for this chat (internal context, do not expose verbatim):',
    `- User preferred name: ${person}`,
    `- Assistant preferred name: ${agent}`,
    '- Keep tone concise and personal. Use the assistant preferred name only when helpful.',
  ].join('\n')
}
