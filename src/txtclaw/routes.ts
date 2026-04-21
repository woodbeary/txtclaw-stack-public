import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { applyIdentityBootstrap, shouldRunBootstrap } from './bootstrap'
import { buildBridgeReply } from './bridge'
import {
  checkAndMarkEvent,
  getFromByDedicatedNumber,
  getFromByOrder,
  getFromBySubscription,
  getUser,
  listUsers,
  mapDedicatedNumber,
  mapOrder,
  mapSubscription,
  putUser,
} from './directory-client'
import type { UserRecord } from './directory-do'
import {
  applyInboundUsage,
  applyOutboundUsage,
  bumpUnpaidPromptCounter,
  canSendUnpaidPrompt,
  getLimitConfig,
} from './limits'
import { normalizeE164 } from './phone'
import { deriveRuntimeIdentity } from './runtime'
import {
  type SquareWebhookEvent,
  createSquarePaymentLink,
  listSquareLocations,
  verifySquareWebhookSignature,
} from './square'
import { sendSunshineAppUserReply, sendSunshineConversationReply } from './sunshine'
import { parseFormUrlEncoded, verifyTwilioSignature } from './twilio'
import { buyTwilioPhoneNumber, findTwilioAvailableLocalNumber, sendTwilioSms } from './twilio'
import { twimlEmpty, twimlMessage } from './twiml'
import { sendZendeskTicketReply, verifyZendeskWebhookBearer } from './zendesk'

function nowIso(): string {
  return new Date().toISOString()
}

const TXTCLAW_PROGRAM_NAME = 'TXT CLAW'

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'])
const HELP_KEYWORDS = new Set(['HELP', 'INFO'])
const START_KEYWORDS = new Set(['START'])
const STATUS_KEYWORDS = new Set(['STATUS'])
const NEGOTIATION_PATTERNS = [
  /\b(price|cost|pricing)\b/i,
  /\b(discount|deal|offer|cheaper|lower|reduce)\b/i,
  /\b(expensive)\b/i,
  /\b(too expensive|can.?t afford|cant afford|budget|student)\b/i,
  /\b(negotiate|negotiation)\b/i,
]

function extractKeyword(body: string): string | null {
  const first = body.trim().split(/\s+/)[0]
  if (!first) return null
  return first.toUpperCase()
}

function stopMessage(): string {
  // Keep this close to carrier-approved templates.
  return 'You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.'
}

function helpMessage(onboardingNumber?: string): string {
  const main = onboardingNumber ? `\nMain line: ${onboardingNumber}` : ''
  return `${TXTCLAW_PROGRAM_NAME} support.${main}\nReply STOP to unsubscribe. Msg&Data rates may apply.`
}

function startMessage(): string {
  return `You’re resubscribed. Reply HELP for help.`
}

function onboardingServiceIntro(): string {
  return 'TXT CLAW is a paid assistant in this thread for scheduling, web tasks, and setup help.'
}

function getCanonicalBaseUrl(env: AppEnv['Bindings'], requestUrl: string): string {
  const base = env.TXTCLAW_PUBLIC_BASE_URL?.trim()
  if (base) return base.replace(/\/+$/, '')
  const url = new URL(requestUrl)
  return `${url.protocol}//${url.host}`
}

function getTwilioWebhookUrl(env: AppEnv['Bindings'], requestUrl: string): string {
  // Use canonical base URL so signature verification matches Twilio config.
  const base = getCanonicalBaseUrl(env, requestUrl)
  return `${base}/webhooks/twilio/sms`
}

function getSquareWebhookUrl(env: AppEnv['Bindings'], requestUrl: string): string {
  const explicit = env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim()
  if (explicit) return explicit
  const base = getCanonicalBaseUrl(env, requestUrl)
  return `${base}/webhooks/square`
}

function getPrice(env: AppEnv['Bindings']): { amountCents: number; currency: string } {
  const amountCents = Number(env.TXTCLAW_PRICE_CENTS || '999')
  const currency = (env.TXTCLAW_CURRENCY || 'USD').toUpperCase()
  return {
    amountCents: Number.isFinite(amountCents) && amountCents > 0 ? Math.floor(amountCents) : 999,
    currency,
  }
}

function getOfferFloorCents(env: AppEnv['Bindings'], baseAmountCents: number): number {
  const configured = Number(
    (env as unknown as { TXTCLAW_MIN_PRICE_CENTS?: string }).TXTCLAW_MIN_PRICE_CENTS || '',
  )
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.floor(configured), baseAmountCents)
  }
  // Default: allow up to $10 discount, but never below $3.
  return Math.max(300, baseAmountCents - 1000)
}

function formatPrice(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountCents / 100)
  } catch {
    return `$${(amountCents / 100).toFixed(2)}`
  }
}

function hasNegotiationIntent(body: string): boolean {
  const text = body.trim()
  if (!text) return false
  return NEGOTIATION_PATTERNS.some((pattern) => pattern.test(text))
}

function resolveOffer(args: {
  env: AppEnv['Bindings']
  user?: UserRecord | null
  inboundBody: string
}): { amountCents: number; floorCents: number; turns: number; changed: boolean } {
  const price = getPrice(args.env)
  const floorCents = getOfferFloorCents(args.env, price.amountCents)
  const previous = args.user?.negotiatedPriceCents ?? price.amountCents
  const turns = args.user?.negotiationTurns || 0

  if (!hasNegotiationIntent(args.inboundBody)) {
    return {
      amountCents: previous,
      floorCents,
      turns,
      changed: false,
    }
  }

  const next = Math.max(floorCents, previous - 100)
  return {
    amountCents: next,
    floorCents,
    turns: next === previous ? turns : turns + 1,
    changed: next !== previous,
  }
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

function parseCsvLowerSet(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set()
  const values = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  return new Set(values)
}

function isTrue(raw: string | undefined): boolean {
  return (
    String(raw || '')
      .trim()
      .toLowerCase() === 'true'
  )
}

function isTrueByDefault(raw: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
  if (!normalized) return defaultValue
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function isBridgeEnabled(env: AppEnv['Bindings']): boolean {
  return isTrueByDefault(env.TXTCLAW_BRIDGE_ENABLED, true)
}

function getBridgeInitialTimeoutMs(env: AppEnv['Bindings']): number {
  return parsePositiveInt(env.TXTCLAW_BRIDGE_INITIAL_TIMEOUT_MS, 1200)
}

function createTraceId(prefix = 'txtclaw'): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

function logTrace(traceId: string, event: string, fields: Record<string, unknown>): void {
  try {
    console.log(
      JSON.stringify({
        scope: 'txtclaw',
        traceId,
        event,
        at: new Date().toISOString(),
        ...fields,
      }),
    )
  } catch (error) {
    console.log('[txtclaw] logTrace serialization failed', traceId, event, error)
  }
}

function nextInboundSeq(user: UserRecord): number {
  return (user.lastInboundSeq || 0) + 1
}

function isTwilioOnboardingEnabled(env: AppEnv['Bindings']): boolean {
  return (
    String(env.TXTCLAW_ENABLE_TWILIO_ONBOARDING || '')
      .trim()
      .toLowerCase() === 'true'
  )
}

function trimReplyPreview(body: string, max = 220): string {
  const normalized = body.trim()
  if (!normalized) return ''
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function fallbackDedicatedReply(body: string): string {
  const preview = trimReplyPreview(body, 200)
  if (!preview) {
    return 'Message received. Your agent is online.'
  }
  return `Message received: ${preview}`
}

async function buildDedicatedReplySafe(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  inboundBody: string
  source: 'zendesk' | 'sunshine' | 'dedicated_sms'
  skipOutboundAccounting?: boolean
}): Promise<{ replyBody: string; user: UserRecord }> {
  try {
    const { buildDedicatedReply } = await import('./agent')
    return await buildDedicatedReply({
      env: args.env,
      user: args.user,
      inboundBody: args.inboundBody,
      skipOutboundAccounting: args.skipOutboundAccounting,
    })
  } catch (error) {
    console.error(`[txtclaw] ${args.source} dedicated reply generation failed, using fallback:`, error)
    return {
      replyBody: fallbackDedicatedReply(args.inboundBody),
      user: args.user,
    }
  }
}

async function processDedicatedInboundMessageSafe(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  inboundBody: string
}): Promise<void> {
  try {
    const { processDedicatedInboundMessage } = await import('./agent')
    await processDedicatedInboundMessage(args)
    return
  } catch (error) {
    console.error('[txtclaw] async dedicated inbound processing failed, using fallback:', error)
  }

  const fromNumber = normalizeE164(args.user.dedicatedNumber)
  const toNumber = normalizeE164(args.user.from)
  if (!fromNumber || !toNumber) return
  if (!args.env.TWILIO_ACCOUNT_SID || !args.env.TWILIO_API_KEY_SID || !args.env.TWILIO_API_KEY_SECRET) return
  if (args.user.optedOutAt) return

  try {
    await sendTwilioSms({
      accountSid: args.env.TWILIO_ACCOUNT_SID,
      apiKeySid: args.env.TWILIO_API_KEY_SID,
      apiKeySecret: args.env.TWILIO_API_KEY_SECRET,
      from: fromNumber,
      to: toNumber,
      body: fallbackDedicatedReply(args.inboundBody),
      statusCallbackUrl: args.env.TWILIO_STATUS_CALLBACK_URL,
    })
    await putUser(args.env, {
      ...args.user,
      lastOutboundAt: nowIso(),
      lastOutboundErrorAt: undefined,
      lastOutboundError: undefined,
    })
  } catch (fallbackError) {
    console.error('[txtclaw] dedicated fallback SMS send failed:', fallbackError)
    await putUser(args.env, {
      ...args.user,
      lastOutboundErrorAt: nowIso(),
      lastOutboundError: fallbackError instanceof Error ? fallbackError.message : 'dedicated_fallback_failed',
    })
  }
}

function markOutboundSuccess(user: UserRecord): UserRecord {
  return {
    ...user,
    lastOutboundAt: nowIso(),
    lastOutboundErrorAt: undefined,
    lastOutboundError: undefined,
  }
}

function isRecentlyOutbound(
  user: UserRecord | null | undefined,
  minSeconds: number,
  now = new Date(),
): boolean {
  if (!user?.lastOutboundAt) return false
  const previous = new Date(user.lastOutboundAt)
  if (Number.isNaN(previous.getTime())) return false
  return now.getTime() - previous.getTime() < minSeconds * 1000
}

function limitExceededMessage(reason: string | undefined): string {
  if (reason === 'estimated_spend_cap') {
    return 'You reached this plan’s monthly usage budget. Reply HELP for upgrade options.'
  }
  return 'Usage limit reached for now. Reply HELP for options.'
}

function isWarmupReply(body: string): boolean {
  return body.trim().toLowerCase().includes('warming up')
}

function highUsageRetryMessage(): string {
  return 'We are seeing high usage right now. Please try again in a few minutes.'
}

function responseSourceFromBridge(source: 'bridge_ai' | 'bridge_template'): 'bridge_ai' | 'bridge_template' {
  return source
}

function withReplyMetadata(
  user: UserRecord,
  args: {
    source: UserRecord['lastReplySource']
    clearPendingHandoff?: boolean
    outboundError?: string
  },
): UserRecord {
  return {
    ...user,
    lastReplySource: args.source,
    pendingHandoffSeq: args.clearPendingHandoff ? undefined : user.pendingHandoffSeq,
    pendingHandoffAt: args.clearPendingHandoff ? undefined : user.pendingHandoffAt,
    lastOutboundAt: args.outboundError ? user.lastOutboundAt : nowIso(),
    lastOutboundErrorAt: args.outboundError ? nowIso() : undefined,
    lastOutboundError: args.outboundError,
  }
}

function llmDelta(current: number | undefined, baseline: number | undefined): number {
  const c = Number(current || 0)
  const b = Number(baseline || 0)
  const delta = c - b
  return Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 0
}

function mergeLlmUsageFromGenerated(args: {
  latest: UserRecord
  baseline: UserRecord
  generated: UserRecord
}): UserRecord {
  const inputDelta = llmDelta(args.generated.llmInputTokensMonth, args.baseline.llmInputTokensMonth)
  const outputDelta = llmDelta(args.generated.llmOutputTokensMonth, args.baseline.llmOutputTokensMonth)
  const totalDelta = llmDelta(args.generated.llmTotalTokensMonth, args.baseline.llmTotalTokensMonth)
  const llmCostDelta = llmDelta(
    args.generated.llmEstimatedCostCentsMonth,
    args.baseline.llmEstimatedCostCentsMonth,
  )
  const spendDelta = llmDelta(args.generated.estimatedSpendCentsMonth, args.baseline.estimatedSpendCentsMonth)

  return {
    ...args.latest,
    usageMonth: args.generated.usageMonth || args.latest.usageMonth,
    llmInputTokensMonth: (args.latest.llmInputTokensMonth || 0) + inputDelta,
    llmOutputTokensMonth: (args.latest.llmOutputTokensMonth || 0) + outputDelta,
    llmTotalTokensMonth: (args.latest.llmTotalTokensMonth || 0) + totalDelta,
    llmEstimatedCostCentsMonth: (args.latest.llmEstimatedCostCentsMonth || 0) + llmCostDelta,
    estimatedSpendCentsMonth: (args.latest.estimatedSpendCentsMonth || 0) + spendDelta,
    lastModelUsed: args.generated.lastModelUsed || args.latest.lastModelUsed,
    lastLlmUsageAt: args.generated.lastLlmUsageAt || args.latest.lastLlmUsageAt,
  }
}

type ZendeskTicketWebhookPayload = {
  ticket_id?: number | string
  ticketId?: number | string
  requester_id?: number | string
  requester_external_id?: string
  conversation_id?: string
  conversationId?: string
  sunshine_conversation_id?: string
  sunshineConversationId?: string
  messaging_conversation_id?: string
  smooch_conversation_id?: string
  sunshine_app_user_id?: string
  sunshineAppUserId?: string
  app_user_id?: string
  appUserId?: string
  requester_phone?: string
  requester_email?: string
  message?: string
  latest_public_comment?: string
  updated_at?: string
  updated_by_role?: string
  ticket_channel?: string
}

type SunshineWebhookPayload = {
  trigger?: string
  appUser?: {
    _id?: string
    id?: string
    userId?: string
    user_id?: string
  }
  conversation?: {
    _id?: string
    id?: string
  }
  message?: SunshineWebhookMessage
  messages?: SunshineWebhookMessage[]
}

type SunshineWebhookMessage = {
  _id?: string
  id?: string
  externalId?: string
  role?: string
  text?: string
  received?: string
  createdAt?: string
  source?: {
    type?: string
  }
  author?: {
    type?: string
    role?: string
    id?: string
    _id?: string
    userId?: string
    user_id?: string
  }
  authorId?: string
  author_id?: string
  conversation?:
    | {
        _id?: string
        id?: string
      }
    | string
  conversationId?: string
  payload?: {
    text?: string
  }
  content?: {
    type?: string
    text?: string
    fallback?: string
  }
}

type SunshineInbound = {
  messageId?: string
  appUserId?: string
  conversationId?: string
  body?: string
  trigger?: string
  authorType?: string
  sourceType?: string
  receivedAt?: string
}

function extractSunshineMessageBody(message: SunshineWebhookMessage | undefined): string | undefined {
  if (!message) return undefined
  return firstNonEmptyString([
    message.content?.text,
    message.content?.fallback,
    message.text,
    message.payload?.text,
  ])
}

function normalizeSunshineAuthorType(message: SunshineWebhookMessage | undefined): string {
  if (!message) return ''
  return String(firstNonEmptyString([message.author?.type, message.author?.role, message.role]) || '')
    .trim()
    .toLowerCase()
}

function selectSunshineMessage(payload: SunshineWebhookPayload): SunshineWebhookMessage | undefined {
  const candidates: SunshineWebhookMessage[] = []
  if (payload.message) candidates.push(payload.message)
  if (Array.isArray(payload.messages)) candidates.push(...payload.messages)
  if (candidates.length === 0) return undefined

  const preferred = candidates.find((message) => {
    const authorType = normalizeSunshineAuthorType(message)
    if (authorType && authorType !== 'user' && authorType !== 'appuser') return false
    return Boolean(extractSunshineMessageBody(message))
  })

  return preferred || candidates[0]
}

function extractSunshineInbound(payload: SunshineWebhookPayload): SunshineInbound {
  const trigger = String(payload.trigger || '').trim()
  const message = selectSunshineMessage(payload)
  const messageConversationObject =
    message?.conversation && typeof message.conversation === 'object' ? message.conversation : undefined
  const appUserId = firstNonEmptyString([
    payload.appUser?._id,
    payload.appUser?.id,
    payload.appUser?.userId,
    payload.appUser?.user_id,
    message?.author?.id,
    message?.author?._id,
    message?.author?.userId,
    message?.author?.user_id,
    message?.authorId,
    message?.author_id,
  ])
  const conversationId = firstNonEmptyString([
    payload.conversation?._id,
    payload.conversation?.id,
    typeof message?.conversation === 'string' ? message?.conversation : '',
    messageConversationObject?._id,
    messageConversationObject?.id,
    message?.conversationId,
  ])
  const messageId = firstNonEmptyString([message?._id, message?.id, message?.externalId])
  const authorType = normalizeSunshineAuthorType(message)
  const sourceType = String(message?.source?.type || '')
    .trim()
    .toLowerCase()
  const body = extractSunshineMessageBody(message)
  const receivedAt = firstNonEmptyString([message?.received, message?.createdAt])

  return {
    messageId,
    appUserId,
    conversationId,
    body,
    trigger,
    authorType,
    sourceType,
    receivedAt,
  }
}

function resolveZendeskUserId(payload: ZendeskTicketWebhookPayload): string {
  const phone = normalizeE164(payload.requester_phone || '')
  if (phone) return phone

  const external = (payload.requester_external_id || '').trim()
  if (external) return `zendesk:${external}`

  const requesterId = String(payload.requester_id || '').trim()
  if (requesterId) return `zendesk-user:${requesterId}`

  const requesterEmail = String(payload.requester_email || '')
    .trim()
    .toLowerCase()
  if (requesterEmail) return `zendesk-email:${requesterEmail}`

  throw new Error('Unable to resolve Zendesk requester identity')
}

function parseZendeskTicketId(payload: ZendeskTicketWebhookPayload): number {
  const raw = payload.ticket_id ?? payload.ticketId
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid Zendesk ticket id')
  }
  return Math.floor(value)
}

function extractLatestAppleUserLine(rawMessage: string): string | null {
  const text = rawMessage.trim()
  if (!text) return null

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  // Zendesk Apple transcript line example:
  // (15:20:17) Apple Messages for Business User urn:mbid:...: hello
  const transcriptPrefix = /^\(\d{1,2}:\d{2}:\d{2}\)\s+/

  let foundTranscriptLine = false
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!transcriptPrefix.test(line)) continue
    foundTranscriptLine = true

    const withoutPrefix = line.replace(transcriptPrefix, '')
    const separator = withoutPrefix.lastIndexOf(': ')
    if (separator === -1) continue

    const speaker = withoutPrefix.slice(0, separator).trim().toLowerCase()
    const message = withoutPrefix.slice(separator + 2).trim()
    if (!message) continue

    const isAppleUser = speaker.includes('apple messages for business user') || speaker.includes('urn:mbid')
    if (isAppleUser) return message

    // If the latest transcript line is not from the user, treat as non-user update.
    return null
  }

  // Apple Business Chat payloads from Zendesk are expected as transcript lines.
  // Non-transcript updates are typically system/API comments and should be ignored.
  return foundTranscriptLine ? null : null
}

type SunshineTarget = {
  conversationId?: string
  appUserId?: string
}

type ZendeskTicketAuditEvent = {
  type?: string
  value?: {
    conversation_id?: string
    visitor_id?: string
    control_context?: {
      origin_source_user_id?: string
    }
  }
}

function zendeskBasicAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString('base64')}`
}

async function fetchZendeskTicketChannel(
  env: AppEnv['Bindings'],
  ticketId: number,
): Promise<string | undefined> {
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim()
  const email = env.ZENDESK_API_EMAIL?.trim()
  const apiToken = env.ZENDESK_API_TOKEN?.trim()
  if (!subdomain || !email || !apiToken) return undefined

  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: zendeskBasicAuthHeader(email, apiToken),
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) return undefined

  const data = (await res.json()) as {
    ticket?: {
      via?: {
        channel?: string
      }
    }
  }

  const channel = String(data.ticket?.via?.channel || '')
    .trim()
    .toLowerCase()
  return channel || undefined
}

async function fetchSunshineTargetFromTicketAudits(
  env: AppEnv['Bindings'],
  ticketId: number,
): Promise<SunshineTarget> {
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim()
  const email = env.ZENDESK_API_EMAIL?.trim()
  const apiToken = env.ZENDESK_API_TOKEN?.trim()
  if (!subdomain || !email || !apiToken) return {}

  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/audits.json`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: zendeskBasicAuthHeader(email, apiToken),
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) return {}

  const data = (await res.json()) as {
    audits?: Array<{
      events?: ZendeskTicketAuditEvent[]
    }>
  }
  const audits = data.audits || []
  for (let i = audits.length - 1; i >= 0; i -= 1) {
    const events = audits[i]?.events || []
    for (let j = events.length - 1; j >= 0; j -= 1) {
      const event = events[j]
      if (event?.type !== 'ChatStartedEvent') continue
      const conversationId = String(event.value?.conversation_id || '').trim()
      const appUserId = firstNonEmptyString([
        event.value?.visitor_id,
        event.value?.control_context?.origin_source_user_id,
      ])
      if (conversationId || appUserId) {
        return { conversationId: conversationId || undefined, appUserId }
      }
    }
  }

  return {}
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (normalized) return normalized
  }
  return undefined
}

function resolveSunshineTarget(
  env: AppEnv['Bindings'],
  payload: ZendeskTicketWebhookPayload,
): SunshineTarget {
  const conversationId = firstNonEmptyString([
    payload.sunshine_conversation_id,
    payload.sunshineConversationId,
    payload.conversation_id,
    payload.conversationId,
    payload.messaging_conversation_id,
    payload.smooch_conversation_id,
  ])

  const explicitAppUserId = firstNonEmptyString([
    payload.sunshine_app_user_id,
    payload.sunshineAppUserId,
    payload.app_user_id,
    payload.appUserId,
  ])

  const useExternalAsAppUser = env.TXTCLAW_USE_REQUESTER_EXTERNAL_ID_AS_SUNSHINE === 'true'
  const externalAppUserId = useExternalAsAppUser ? String(payload.requester_external_id || '').trim() : ''
  const appUserId = explicitAppUserId || externalAppUserId || undefined

  return { conversationId, appUserId }
}

function shouldSendWarmupAck(user: UserRecord, warmAfterMinutes: number, now = new Date()): boolean {
  if (!user.lastOutboundAt) return true
  const lastOutbound = new Date(user.lastOutboundAt)
  if (Number.isNaN(lastOutbound.getTime())) return true
  return now.getTime() - lastOutbound.getTime() >= warmAfterMinutes * 60_000
}

function isSameUtcDay(iso: string | undefined, now: Date): boolean {
  if (!iso) return false
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  )
}

async function hasProvisioningCapacity(
  env: AppEnv['Bindings'],
  from: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const users = await listUsers(env)
  const existing = users.find((u) => u.from === from)
  if (existing?.status === 'active') {
    return { ok: true }
  }

  const maxActive = parsePositiveInt(env.TXTCLAW_MAX_ACTIVE_USERS, 50)
  const maxPerDay = parsePositiveInt(env.TXTCLAW_MAX_NEW_PER_DAY, 5)
  const active = users.filter((u) => u.status === 'active')
  const now = new Date()
  const activatedToday = active.filter((u) => isSameUtcDay(u.activatedAt, now)).length

  if (active.length >= maxActive) {
    return { ok: false, reason: `active_cap_${maxActive}` }
  }
  if (activatedToday >= maxPerDay) {
    return { ok: false, reason: `daily_cap_${maxPerDay}` }
  }

  return { ok: true }
}

async function sendZendeskReply(
  env: AppEnv['Bindings'],
  args: { ticketId: number; body: string; sunshineTarget?: SunshineTarget },
): Promise<void> {
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim()
  const sunshineAppId = env.SUNSHINE_APP_ID?.trim()
  const sunshineKeyId = env.SUNSHINE_KEY_ID?.trim()
  const sunshineKeySecret = env.SUNSHINE_KEY_SECRET?.trim()

  if (subdomain && sunshineAppId && sunshineKeyId && sunshineKeySecret) {
    try {
      if (args.sunshineTarget?.conversationId) {
        await sendSunshineConversationReply({
          subdomain,
          appId: sunshineAppId,
          keyId: sunshineKeyId,
          keySecret: sunshineKeySecret,
          conversationId: args.sunshineTarget.conversationId,
          body: args.body,
        })
        return
      }

      if (args.sunshineTarget?.appUserId) {
        await sendSunshineAppUserReply({
          subdomain,
          appId: sunshineAppId,
          keyId: sunshineKeyId,
          keySecret: sunshineKeySecret,
          appUserId: args.sunshineTarget.appUserId,
          body: args.body,
        })
        return
      }
    } catch (error) {
      console.error('[txtclaw] sunshine send failed, falling back to Zendesk ticket API:', error)
    }
  }

  if (!subdomain || !env.ZENDESK_API_EMAIL || !env.ZENDESK_API_TOKEN) {
    throw new Error('Missing Zendesk API configuration')
  }

  await sendZendeskTicketReply({
    subdomain,
    email: env.ZENDESK_API_EMAIL,
    apiToken: env.ZENDESK_API_TOKEN,
    ticketId: args.ticketId,
    body: args.body,
  })
}

async function sendZendeskOfferWithPreview(
  env: AppEnv['Bindings'],
  args: { ticketId: number; checkoutUrl: string; detailsBody: string; sunshineTarget?: SunshineTarget },
): Promise<void> {
  // Apple Messages rich previews are most reliable when URL is the whole message.
  await sendZendeskReply(env, {
    ticketId: args.ticketId,
    body: args.checkoutUrl,
    sunshineTarget: args.sunshineTarget,
  })
  await sendZendeskReply(env, {
    ticketId: args.ticketId,
    body: args.detailsBody,
    sunshineTarget: args.sunshineTarget,
  })
}

async function sendSunshineReplyOnly(
  env: AppEnv['Bindings'],
  args: { body: string; sunshineTarget: SunshineTarget; traceId?: string },
): Promise<void> {
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim()
  const sunshineAppId = env.SUNSHINE_APP_ID?.trim()
  const sunshineKeyId = env.SUNSHINE_KEY_ID?.trim()
  const sunshineKeySecret = env.SUNSHINE_KEY_SECRET?.trim()
  if (!subdomain || !sunshineAppId || !sunshineKeyId || !sunshineKeySecret) {
    throw new Error('Missing Sunshine API configuration')
  }

  if (args.sunshineTarget.conversationId) {
    try {
      await sendSunshineConversationReply({
        subdomain,
        appId: sunshineAppId,
        keyId: sunshineKeyId,
        keySecret: sunshineKeySecret,
        conversationId: args.sunshineTarget.conversationId,
        body: args.body,
      })
      return
    } catch (conversationError) {
      logTrace(args.traceId || 'n/a', 'sunshine.conversation_send_failed', {
        conversationId: args.sunshineTarget.conversationId,
        appUserId: args.sunshineTarget.appUserId,
        error: conversationError instanceof Error ? conversationError.message : String(conversationError),
      })
      if (!args.sunshineTarget.appUserId) {
        throw conversationError
      }
    }
  }

  if (args.sunshineTarget.appUserId) {
    await sendSunshineAppUserReply({
      subdomain,
      appId: sunshineAppId,
      keyId: sunshineKeyId,
      keySecret: sunshineKeySecret,
      appUserId: args.sunshineTarget.appUserId,
      body: args.body,
    })
    logTrace(args.traceId || 'n/a', 'sunshine.appuser_send_success', {
      appUserId: args.sunshineTarget.appUserId,
    })
    return
  }

  throw new Error('Missing Sunshine target (conversationId/appUserId)')
}

async function sendSunshineOfferWithPreview(
  env: AppEnv['Bindings'],
  args: { checkoutUrl: string; detailsBody: string; sunshineTarget: SunshineTarget },
): Promise<void> {
  await sendSunshineReplyOnly(env, {
    body: args.checkoutUrl,
    sunshineTarget: args.sunshineTarget,
  })
  await sendSunshineReplyOnly(env, {
    body: args.detailsBody,
    sunshineTarget: args.sunshineTarget,
  })
}

function getWarmupRetryDelayMs(env: AppEnv['Bindings']): number {
  return parsePositiveInt(
    (env as unknown as { TXTCLAW_WARMUP_RETRY_DELAY_MS?: string }).TXTCLAW_WARMUP_RETRY_DELAY_MS,
    120000,
  )
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

type AppleReplyTraceContext = {
  channel: 'zendesk' | 'sunshine'
  fromIdentity: string
  inboundSeq: number
  conversationId?: string
  appUserId?: string
  ticketId?: number
}

async function dispatchAppleReply(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  body: string
  replySource: UserRecord['lastReplySource']
  applyOutboundAccounting: boolean
  clearPendingHandoff?: boolean
  sendReply: (body: string) => Promise<void>
  traceId: string
  trace: AppleReplyTraceContext
  latencyMs?: number
}): Promise<UserRecord> {
  let nextUser = args.user
  let bodyToSend = args.body
  let source = args.replySource

  if (args.applyOutboundAccounting) {
    const outbound = applyOutboundUsage(nextUser, getLimitConfig(args.env))
    nextUser = outbound.user
    if (!outbound.allowed) {
      bodyToSend = limitExceededMessage(outbound.reason)
      source = 'fallback'
    }
  }

  await args.sendReply(bodyToSend)
  const saved = await putUser(
    args.env,
    withReplyMetadata(nextUser, {
      source,
      clearPendingHandoff: Boolean(args.clearPendingHandoff),
    }),
  )

  logTrace(args.traceId, 'outbound.delivery_success', {
    ...args.trace,
    replySource: source,
    latencyMs: args.latencyMs,
  })

  return saved
}

async function dispatchAppleReplyFailure(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  error: unknown
  traceId: string
  trace: AppleReplyTraceContext
  clearPendingHandoff?: boolean
}): Promise<void> {
  const message = args.error instanceof Error ? args.error.message : String(args.error)
  await putUser(
    args.env,
    withReplyMetadata(args.user, {
      source: 'fallback',
      clearPendingHandoff: Boolean(args.clearPendingHandoff),
      outboundError: message,
    }),
  )
  logTrace(args.traceId, 'outbound.delivery_failed', {
    ...args.trace,
    error: message,
  })
}

async function runAppleBridgeFlow(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  inboundBody: string
  fromIdentity: string
  source: 'zendesk' | 'sunshine'
  traceId: string
  trace: AppleReplyTraceContext
  sendReply: (body: string) => Promise<void>
  scheduleTask: (task: Promise<void>) => void
}): Promise<{ action: 'agent_reply'; replySource: UserRecord['lastReplySource'] }> {
  const startedAt = Date.now()
  logTrace(args.traceId, 'openclaw.request_start', {
    ...args.trace,
    latencyMs: 0,
  })

  const generatedPromise = buildDedicatedReplySafe({
    env: args.env,
    user: args.user,
    inboundBody: args.inboundBody,
    source: args.source,
    skipOutboundAccounting: true,
  })

  const bridgeEnabled = isBridgeEnabled(args.env)
  const initialTimeoutMs = getBridgeInitialTimeoutMs(args.env)

  const race = bridgeEnabled
    ? await Promise.race([
        generatedPromise.then((generated) => ({ type: 'generated' as const, generated })),
        sleepMs(initialTimeoutMs).then(() => ({ type: 'timeout' as const })),
      ])
    : { type: 'generated' as const, generated: await generatedPromise }

  if (race.type === 'generated') {
    const generated = race.generated
    const finalReplyBody = isWarmupReply(generated.replyBody) ? highUsageRetryMessage() : generated.replyBody
    const finalSource: UserRecord['lastReplySource'] = isWarmupReply(generated.replyBody)
      ? 'fallback'
      : 'openclaw'

    try {
      await dispatchAppleReply({
        env: args.env,
        user: generated.user,
        body: finalReplyBody,
        replySource: finalSource,
        applyOutboundAccounting: true,
        sendReply: args.sendReply,
        traceId: args.traceId,
        trace: args.trace,
        latencyMs: Date.now() - startedAt,
      })
    } catch (error) {
      await dispatchAppleReplyFailure({
        env: args.env,
        user: generated.user,
        error,
        traceId: args.traceId,
        trace: args.trace,
      })
      throw error
    }

    logTrace(args.traceId, 'openclaw.request_end', {
      ...args.trace,
      replySource: finalSource,
      latencyMs: Date.now() - startedAt,
    })

    return { action: 'agent_reply', replySource: finalSource }
  }

  const bridge = await buildBridgeReply({
    env: args.env,
    user: args.user,
    inboundBody: args.inboundBody,
  })

  try {
    const sent = await dispatchAppleReply({
      env: args.env,
      user: args.user,
      body: bridge.replyBody,
      replySource: responseSourceFromBridge(bridge.source),
      applyOutboundAccounting: true,
      sendReply: args.sendReply,
      traceId: args.traceId,
      trace: args.trace,
      latencyMs: Date.now() - startedAt,
    })
    await putUser(args.env, {
      ...sent,
      pendingHandoffSeq: args.trace.inboundSeq,
      pendingHandoffAt: nowIso(),
    })
  } catch (error) {
    await dispatchAppleReplyFailure({
      env: args.env,
      user: args.user,
      error,
      traceId: args.traceId,
      trace: args.trace,
    })
    throw error
  }

  logTrace(args.traceId, 'bridge.sent', {
    ...args.trace,
    replySource: bridge.source,
    latencyMs: Date.now() - startedAt,
  })

  const handoffTask = (async () => {
    let generated
    try {
      generated = await generatedPromise
    } catch (error) {
      logTrace(args.traceId, 'openclaw.request_end', {
        ...args.trace,
        replySource: 'fallback',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })

      const latest = await getUser(args.env, args.fromIdentity)
      if (!latest || latest.optedOutAt) return
      if ((latest.lastInboundSeq || 0) !== args.trace.inboundSeq) {
        logTrace(args.traceId, 'handoff.dropped_stale', {
          ...args.trace,
          latestInboundSeq: latest.lastInboundSeq || 0,
        })
        return
      }

      try {
        await dispatchAppleReply({
          env: args.env,
          user: latest,
          body: highUsageRetryMessage(),
          replySource: 'fallback',
          applyOutboundAccounting: true,
          clearPendingHandoff: true,
          sendReply: args.sendReply,
          traceId: args.traceId,
          trace: args.trace,
          latencyMs: Date.now() - startedAt,
        })
      } catch (sendError) {
        await dispatchAppleReplyFailure({
          env: args.env,
          user: latest,
          error: sendError,
          traceId: args.traceId,
          trace: args.trace,
          clearPendingHandoff: true,
        })
      }
      return
    }

    const latest = await getUser(args.env, args.fromIdentity)
    if (!latest || latest.optedOutAt) return

    if ((latest.lastInboundSeq || 0) !== args.trace.inboundSeq) {
      logTrace(args.traceId, 'handoff.dropped_stale', {
        ...args.trace,
        latestInboundSeq: latest.lastInboundSeq || 0,
      })
      return
    }

    const finalReplyBody = isWarmupReply(generated.replyBody) ? highUsageRetryMessage() : generated.replyBody
    const finalSource: UserRecord['lastReplySource'] = isWarmupReply(generated.replyBody)
      ? 'fallback'
      : 'openclaw'

    const mergedUser = mergeLlmUsageFromGenerated({
      latest,
      baseline: args.user,
      generated: generated.user,
    })

    try {
      await dispatchAppleReply({
        env: args.env,
        user: mergedUser,
        body: finalReplyBody,
        replySource: finalSource,
        applyOutboundAccounting: true,
        clearPendingHandoff: true,
        sendReply: args.sendReply,
        traceId: args.traceId,
        trace: args.trace,
        latencyMs: Date.now() - startedAt,
      })
      logTrace(args.traceId, 'handoff.sent', {
        ...args.trace,
        replySource: finalSource,
        latencyMs: Date.now() - startedAt,
      })
    } catch (error) {
      await dispatchAppleReplyFailure({
        env: args.env,
        user: mergedUser,
        error,
        traceId: args.traceId,
        trace: args.trace,
        clearPendingHandoff: true,
      })
    }
  })()

  args.scheduleTask(handoffTask)

  return { action: 'agent_reply', replySource: responseSourceFromBridge(bridge.source) }
}

async function scheduleSunshineWarmupFollowup(args: {
  env: AppEnv['Bindings']
  fromIdentity: string
  inboundBody: string
  sunshineTarget: SunshineTarget
}): Promise<void> {
  try {
    await sleepMs(getWarmupRetryDelayMs(args.env))
    const latest = await getUser(args.env, args.fromIdentity)
    if (!latest || latest.optedOutAt) return

    const generated = await buildDedicatedReplySafe({
      env: args.env,
      user: latest,
      inboundBody: args.inboundBody,
      source: 'sunshine',
    })

    let replyBody = generated.replyBody
    if (isWarmupReply(replyBody)) {
      replyBody = highUsageRetryMessage()
    }

    await sendSunshineReplyOnly(args.env, {
      body: replyBody,
      sunshineTarget: args.sunshineTarget,
    })
    await putUser(args.env, markOutboundSuccess(generated.user))
  } catch (error) {
    console.error('[txtclaw] sunshine warmup follow-up failed:', error)
  }
}

async function scheduleZendeskWarmupFollowup(args: {
  env: AppEnv['Bindings']
  fromIdentity: string
  inboundBody: string
  ticketId: number
  sunshineTarget: SunshineTarget
}): Promise<void> {
  try {
    await sleepMs(getWarmupRetryDelayMs(args.env))
    const latest = await getUser(args.env, args.fromIdentity)
    if (!latest || latest.optedOutAt) return

    const generated = await buildDedicatedReplySafe({
      env: args.env,
      user: latest,
      inboundBody: args.inboundBody,
      source: 'zendesk',
    })

    let replyBody = generated.replyBody
    if (isWarmupReply(replyBody)) {
      replyBody = highUsageRetryMessage()
    }

    await sendZendeskReply(args.env, {
      ticketId: args.ticketId,
      body: replyBody,
      sunshineTarget: args.sunshineTarget,
    })
    await putUser(args.env, markOutboundSuccess(generated.user))
  } catch (error) {
    console.error('[txtclaw] zendesk warmup follow-up failed:', error)
  }
}

function extractGatewayText(payload: any): string | null {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  const output = Array.isArray(payload?.output) ? payload.output : []
  const parts: string[] = []
  for (const block of output) {
    const content = Array.isArray(block?.content) ? block.content : []
    for (const piece of content) {
      const text = typeof piece?.text === 'string' ? piece.text.trim() : ''
      if (text) parts.push(text)
    }
  }
  return parts.length ? parts.join('\n\n') : null
}

async function buildOfferAssistantIntroViaGateway(args: {
  env: AppEnv['Bindings']
  inboundBody: string
  offerText: string
  floorReached: boolean
}): Promise<string | null> {
  const baseUrl = String(args.env.AI_GATEWAY_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
  const apiKey = String(args.env.AI_GATEWAY_API_KEY || args.env.OPENAI_API_KEY || '').trim()
  if (!baseUrl || !apiKey) return null

  const model = String(args.env.AI_GATEWAY_MODEL || 'amazon/nova-lite').trim()
  const maxOutputTokens = parsePositiveInt(args.env.TXTCLAW_ONBOARDING_MAX_OUTPUT_TOKENS, 180)
  const systemPrompt = [
    'You are TXT CLAW onboarding concierge for an SMS/iMessage paid assistant.',
    'User has NOT paid yet.',
    'Be concise, persuasive, and useful. 2-4 short sentences max.',
    'Always direct user to complete checkout using the payment link already provided in-thread.',
    `Current monthly offer: ${args.offerText}.`,
    args.floorReached
      ? 'This is the floor price. Do not offer lower.'
      : 'Price can drop by $1 only if user strongly pushes back.',
    'Never claim payment is complete unless explicitly confirmed.',
    'No markdown, no lists, no policy talk.',
  ].join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: systemPrompt }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: args.inboundBody }],
          },
        ],
        max_output_tokens: maxOutputTokens,
        temperature: 0.4,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`onboarding gateway call failed (${res.status}): ${text}`)
    }

    const payload = (await res.json()) as any
    return extractGatewayText(payload)
  } finally {
    clearTimeout(timeout)
  }
}

function defaultOfferAssistantIntro(args: {
  offerChanged: boolean
  floorReached: boolean
}): string {
  if (args.offerChanged) {
    return 'I can lower the price a bit if that helps.'
  }
  if (args.floorReached) {
    return `I can run scheduling, web tasks, and agent setup in this thread once you activate.`
  }
  return `I can run scheduling, web tasks, and agent setup in this thread.`
}

async function buildOfferAssistantIntro(args: {
  env: AppEnv['Bindings']
  user: UserRecord
  inboundBody: string
  offerText: string
  offerChanged: boolean
  floorReached: boolean
}): Promise<{ text: string; user: UserRecord }> {
  const fallbackText = defaultOfferAssistantIntro({
    offerChanged: args.offerChanged,
    floorReached: args.floorReached,
  })

  // Preferred launch path: direct AI Gateway call for fast, low-cost onboarding replies.
  try {
    const direct = await buildOfferAssistantIntroViaGateway({
      env: args.env,
      inboundBody: args.inboundBody,
      offerText: args.offerText,
      floorReached: args.floorReached,
    })
    if (direct && direct.trim()) {
      return { text: direct.trim(), user: args.user }
    }
  } catch (error) {
    console.error('[txtclaw] onboarding direct gateway reply failed, trying fallback:', error)
  }

  // Optional fallback: route through customer sandbox LLM (higher latency/cost).
  if (!isTrue(args.env.TXTCLAW_ONBOARDING_USE_SANDBOX_LLM)) {
    return { text: fallbackText, user: args.user }
  }

  // Unit tests and some dry-run contexts intentionally do not provide Sandbox.
  if (!args.env.Sandbox) {
    return { text: fallbackText, user: args.user }
  }

  try {
    const { buildDedicatedReply } = await import('./agent')
    const prompt = [
      'You are TXT CLAW onboarding concierge for a paid subscription service.',
      'The user has not paid yet. Be concise, high-agency, and helpful.',
      'Respond naturally to the user message and keep momentum to conversion.',
      `Current monthly offer: ${args.offerText}.`,
      args.floorReached
        ? 'This is the floor offer and cannot go lower.'
        : 'Price can still improve by $1 only if the user pushes back.',
      'Never claim payment is complete unless explicitly told it is complete.',
      'Keep output under 90 words.',
      `User message: ${args.inboundBody}`,
    ].join('\n')

    const generated = await buildDedicatedReply({
      env: args.env,
      user: args.user,
      inboundBody: prompt,
    })

    const text = generated.replyBody.trim() || fallbackText
    return { text, user: generated.user }
  } catch (error) {
    console.error('[txtclaw] onboarding LLM reply failed, using fallback:', error)
    return { text: fallbackText, user: args.user }
  }
}

async function getSquareLocationId(env: AppEnv['Bindings']): Promise<string> {
  if (env.SQUARE_LOCATION_ID?.trim()) return env.SQUARE_LOCATION_ID.trim()
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('Missing SQUARE_ACCESS_TOKEN')
  const locations = await listSquareLocations({
    env: (env.SQUARE_ENV || 'sandbox') as 'sandbox' | 'production',
    accessToken: env.SQUARE_ACCESS_TOKEN,
  })
  const active = locations.find((l) => l.status?.toUpperCase() === 'ACTIVE') || locations[0]
  if (!active?.id) throw new Error('No Square location found')
  return active.id
}

async function ensureCheckoutLink(
  env: AppEnv['Bindings'],
  from: string,
  requestUrl: string,
  options?: { amountCents?: number; forceNewLink?: boolean },
) {
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('Missing SQUARE_ACCESS_TOKEN')
  const runtime = deriveRuntimeIdentity(from)
  const basePrice = getPrice(env)

  const user = (await getUser(env, from)) || {
    from,
    status: 'new' as const,
    sandboxKey: runtime.sandboxKey,
    r2Prefix: runtime.r2Prefix,
    optedInAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  const offerAmountCents =
    options?.amountCents && options.amountCents > 0
      ? Math.floor(options.amountCents)
      : user.negotiatedPriceCents || basePrice.amountCents
  const shouldForceNew = Boolean(options?.forceNewLink)
  const existingCheckout = user.checkout
  const canReuseExisting =
    existingCheckout?.status === 'pending' &&
    existingCheckout?.url &&
    existingCheckout?.amountCents === offerAmountCents

  // Reuse pending checkout if it exists.
  if (!shouldForceNew && canReuseExisting) {
    return { user, url: existingCheckout.url }
  }

  const locationId = await getSquareLocationId(env)
  const { currency } = basePrice
  const idempotencyKey = `txtclaw:${from}:${new Date().toISOString().slice(0, 10)}:${offerAmountCents}`
  const paymentLink = await createSquarePaymentLink({
    env: (env.SQUARE_ENV || 'sandbox') as 'sandbox' | 'production',
    accessToken: env.SQUARE_ACCESS_TOKEN,
    idempotencyKey,
    locationId,
    name: 'TXT CLAW',
    amountCents: offerAmountCents,
    currency,
    redirectUrl: `${getCanonicalBaseUrl(env, requestUrl)}/paid`,
    note: `txtclaw_from=${from}`,
  })

  const nextUser = await putUser(env, {
    ...user,
    status: 'pending_payment',
    negotiatedPriceCents: offerAmountCents,
    checkout: {
      provider: 'square',
      paymentLinkId: paymentLink.id,
      url: paymentLink.url,
      orderId: paymentLink.orderId,
      amountCents: offerAmountCents,
      createdAt: nowIso(),
      status: 'pending',
    },
  })

  if (paymentLink.orderId) {
    await mapOrder(env, paymentLink.orderId, from)
  }

  return { user: nextUser, url: paymentLink.url }
}

async function provisionDedicatedNumber(
  env: AppEnv['Bindings'],
  from: string,
  requestUrl: string,
  squarePaymentId?: string,
) {
  if (env.TXTCLAW_DISABLE_NUMBER_PURCHASE === 'true') {
    throw new Error('Dedicated number provisioning is temporarily disabled')
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET) {
    throw new Error('Missing Twilio API credentials')
  }

  const existing = await getUser(env, from)
  if (existing?.dedicatedNumber) return existing

  const areaCode = (
    env as unknown as { TXTCLAW_DEFAULT_AREA_CODE?: string }
  ).TXTCLAW_DEFAULT_AREA_CODE?.trim()
  const preferred = (env as unknown as { TXTCLAW_PREFERRED_NUMBER?: string }).TXTCLAW_PREFERRED_NUMBER?.trim()

  const numberToBuy =
    preferred ||
    (await findTwilioAvailableLocalNumber({
      accountSid: env.TWILIO_ACCOUNT_SID,
      apiKeySid: env.TWILIO_API_KEY_SID,
      apiKeySecret: env.TWILIO_API_KEY_SECRET,
      country: 'US',
      areaCode: areaCode && /^\d{3}$/.test(areaCode) ? areaCode : undefined,
    }))

  const smsUrl = getTwilioWebhookUrl(env, requestUrl)
  const result = await buyTwilioPhoneNumber({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    phoneNumberE164: numberToBuy,
    friendlyName: `txtclaw:${from}`,
    smsUrl,
    smsMethod: 'POST',
  })

  await mapDedicatedNumber(env, result.phoneNumber, from)

  const runtime = deriveRuntimeIdentity(from)

  const user = (existing || {
    from,
    status: 'active' as const,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }) as any

  const next = await putUser(env, {
    ...user,
    status: 'active',
    activatedAt: user.activatedAt || nowIso(),
    sandboxKey: user.sandboxKey || runtime.sandboxKey,
    r2Prefix: user.r2Prefix || runtime.r2Prefix,
    dedicatedNumber: result.phoneNumber,
    twilioIncomingSid: result.sid,
    squarePaymentId: squarePaymentId || user.squarePaymentId,
    checkout: user.checkout
      ? {
          ...user.checkout,
          status: 'paid',
        }
      : undefined,
  })

  return next
}

export const txtclawWebhooks = new Hono<AppEnv>()

// POST /webhooks/twilio/sms
txtclawWebhooks.post('/twilio/sms', async (c) => {
  const rawBody = await c.req.raw.clone().text()
  const params = parseFormUrlEncoded(rawBody)

  const from = normalizeE164(params.From)
  const to = normalizeE164(params.To)
  const body = (params.Body || '').trim()

  if (!from || !to) {
    return c.text(twimlMessage('Invalid message.'), 200, { 'Content-Type': 'application/xml' })
  }

  // Verify signature (unless explicitly disabled for dev).
  const skipSig = c.env.DEV_MODE === 'true' || c.env.E2E_TEST_MODE === 'true'
  if (!skipSig) {
    if (!c.env.TWILIO_AUTH_TOKEN)
      return c.text(twimlMessage('Server not configured.'), 200, { 'Content-Type': 'application/xml' })
    const requestUrl = getTwilioWebhookUrl(c.env, c.req.url)
    const ok = await verifyTwilioSignature({
      authToken: c.env.TWILIO_AUTH_TOKEN,
      requestUrl,
      params,
      expectedSignature: c.req.header('x-twilio-signature'),
    })
    if (!ok) {
      return c.text(twimlMessage('Unauthorized.'), 200, { 'Content-Type': 'application/xml' })
    }
  }

  // Idempotency on Twilio MessageSid (best-effort).
  const messageSid = params.MessageSid || params.SmsSid
  if (messageSid) {
    const isNew = await checkAndMarkEvent(c.env, `twilio:${messageSid}`)
    if (!isNew) {
      return c.text(twimlEmpty(), 200, { 'Content-Type': 'application/xml' })
    }
  }

  const onboarding = normalizeE164(c.env.TXTCLAW_ONBOARDING_NUMBER)
  const keyword = extractKeyword(body)

  // Compliance keywords: STOP/START/HELP.
  // These apply on both the onboarding number and dedicated numbers.
  if (
    keyword &&
    (STOP_KEYWORDS.has(keyword) ||
      HELP_KEYWORDS.has(keyword) ||
      START_KEYWORDS.has(keyword) ||
      STATUS_KEYWORDS.has(keyword))
  ) {
    const existing = await getUser(c.env, from)
    const runtime = deriveRuntimeIdentity(from)
    const baseUser: UserRecord = existing || {
      from,
      status: 'new',
      sandboxKey: runtime.sandboxKey,
      r2Prefix: runtime.r2Prefix,
      optedInAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    if (STOP_KEYWORDS.has(keyword)) {
      await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: nowIso(),
      } as any)
      return c.text(twimlMessage(stopMessage()), 200, { 'Content-Type': 'application/xml' })
    }

    if (START_KEYWORDS.has(keyword)) {
      await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: undefined,
        optedInAt: baseUser.optedInAt || nowIso(),
      } as any)
      return c.text(twimlMessage(startMessage()), 200, { 'Content-Type': 'application/xml' })
    }

    if (STATUS_KEYWORDS.has(keyword)) {
      const activeState = baseUser.status
      const usage = [
        `Status: ${activeState}`,
        `Inbound today: ${baseUser.inboundDayCount || 0}`,
        `Inbound this week: ${baseUser.inboundWeekCount || 0}`,
        `Outbound today: ${baseUser.outboundDayCount || 0}`,
        `Outbound this week: ${baseUser.outboundWeekCount || 0}`,
        `Fast requests this month: ${baseUser.fastRequestMonthCount || 0}`,
        `LLM tokens this month: ${baseUser.llmTotalTokensMonth || 0}`,
        `Model: ${baseUser.lastModelUsed || 'n/a'}`,
        `Estimated spend this month: ${baseUser.estimatedSpendCentsMonth || 0} cents`,
      ]
      return c.text(twimlMessage(usage.join('\n')), 200, { 'Content-Type': 'application/xml' })
    }

    return c.text(twimlMessage(helpMessage(onboarding || undefined)), 200, {
      'Content-Type': 'application/xml',
    })
  }

  const userForConsent = await getUser(c.env, from)
  if (userForConsent?.optedOutAt) {
    // When opted out, do not send any messages beyond STOP/START/HELP.
    return c.text(twimlEmpty(), 200, { 'Content-Type': 'application/xml' })
  }

  // Legacy onboarding flow: reply with a checkout link until paid.
  if (onboarding && to === onboarding) {
    const existing = await getUser(c.env, from)
    if (existing?.status === 'active' && existing.dedicatedNumber) {
      const reply = `You’re active.\n\nText your dedicated number: ${existing.dedicatedNumber}`
      return c.text(twimlMessage(reply), 200, { 'Content-Type': 'application/xml' })
    }
    if (!isTwilioOnboardingEnabled(c.env)) {
      return c.text(
        twimlMessage(
          'TXT CLAW SMS onboarding is currently disabled. Join the Apple beta waitlist: https://www.txtclaw.com/waitlist',
        ),
        200,
        { 'Content-Type': 'application/xml' },
      )
    }

    try {
      const limitConfig = getLimitConfig(c.env)
      if (existing && existing.status !== 'active' && !canSendUnpaidPrompt(existing, limitConfig)) {
        const checkoutUrl =
          existing.checkout?.status === 'pending' && existing.checkout?.url
            ? existing.checkout.url
            : (await ensureCheckoutLink(c.env, from, c.req.url)).url
        const limitReply = `You reached today’s free preview limit.\n\nSubscribe here:\n${checkoutUrl}\n\nAfter payment, you’ll receive your dedicated number.`
        return c.text(twimlMessage(limitReply), 200, { 'Content-Type': 'application/xml' })
      }

      const offer = resolveOffer({
        env: c.env,
        user: existing,
        inboundBody: body,
      })
      const checkout = await ensureCheckoutLink(c.env, from, c.req.url, {
        amountCents: offer.amountCents,
        forceNewLink: offer.changed,
      })

      const latest = {
        ...checkout.user,
        negotiatedPriceCents: offer.amountCents,
        negotiationTurns: offer.turns,
        lastNegotiatedAt: offer.changed ? nowIso() : checkout.user.lastNegotiatedAt,
      }

      const base = getPrice(c.env)
      const offerText = formatPrice(offer.amountCents, base.currency)
      const floorReached = offer.amountCents <= offer.floorCents
      const llmIntro = await buildOfferAssistantIntro({
        env: c.env,
        user: latest,
        inboundBody: body,
        offerText,
        offerChanged: offer.changed,
        floorReached,
      })

      if (latest.status !== 'active') {
        await putUser(c.env, bumpUnpaidPromptCounter(llmIntro.user))
      }
      const introPrefix = existing ? '' : `${onboardingServiceIntro()}\n\n`
      const reply = `${introPrefix}${llmIntro.text}\n\nSubscribe here:\n${checkout.url}\n\nAfter payment, you’ll receive your dedicated number.\n\nReply STOP to unsubscribe. Msg&Data rates may apply.`
      return c.text(twimlMessage(reply), 200, { 'Content-Type': 'application/xml' })
    } catch (error) {
      const reply = `Setup is not ready yet.\n${error instanceof Error ? error.message : 'Unknown error'}`
      return c.text(twimlMessage(reply), 200, { 'Content-Type': 'application/xml' })
    }
  }

  // Dedicated number flow: verify ownership, then respond.
  const owner = await getFromByDedicatedNumber(c.env, to)
  if (owner && owner !== from) {
    return c.text(twimlMessage('This number is private.'), 200, { 'Content-Type': 'application/xml' })
  }

  const user = await getUser(c.env, from)
  if (!user || user.status !== 'active' || user.dedicatedNumber !== to) {
    const reply = onboarding
      ? `This number isn’t active for you.\nText the main line to start: ${onboarding}`
      : `This number isn’t active for you.`
    return c.text(twimlMessage(reply), 200, { 'Content-Type': 'application/xml' })
  }

  const limitConfig = getLimitConfig(c.env)
  const inboundUsage = applyInboundUsage(
    {
      ...user,
      lastInboundAt: nowIso(),
    },
    limitConfig,
  )
  const updatedUser = await putUser(c.env, inboundUsage.user)

  if (!body) {
    return c.text(twimlMessage('Send a message to get started.'), 200, { 'Content-Type': 'application/xml' })
  }

  if (!inboundUsage.allowed) {
    return c.text(twimlMessage(limitExceededMessage(inboundUsage.reason)), 200, {
      'Content-Type': 'application/xml',
    })
  }

  const task = processDedicatedInboundMessageSafe({
    env: c.env,
    user: updatedUser,
    inboundBody: body,
  })

  let scheduled = false
  try {
    const executionCtx = c.executionCtx
    if (executionCtx) {
      executionCtx.waitUntil(task)
      scheduled = true
    }
  } catch {
    // Hono test context has no execution context; fall through to direct invocation.
  }
  if (!scheduled) {
    // Test and local execution safety: still run task without waitUntil support.
    void task
  }

  // For first/cold interactions, return immediate feedback so users never see silence.
  const warmAfterMinutes = parsePositiveInt(c.env.TXTCLAW_WARM_ACK_AFTER_MINUTES, 30)
  if (shouldSendWarmupAck(updatedUser, warmAfterMinutes)) {
    return c.text(twimlMessage('Your dedicated agent is waking up. You will get a reply shortly.'), 200, {
      'Content-Type': 'application/xml',
    })
  }

  // For warm interactions, keep webhook response empty and send async reply.
  return c.text(twimlEmpty(), 200, { 'Content-Type': 'application/xml' })
})

// POST /webhooks/zendesk/ticket
// Receives Zendesk trigger webhooks and posts replies back into the same ticket.
txtclawWebhooks.post('/zendesk/ticket', async (c) => {
  const rawBody = await c.req.raw.clone().text()

  const expectedBearer = c.env.ZENDESK_WEBHOOK_BEARER_TOKEN?.trim()
  if (expectedBearer) {
    const ok = verifyZendeskWebhookBearer(expectedBearer, c.req.header('authorization'))
    if (!ok) return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  let payload: ZendeskTicketWebhookPayload
  try {
    payload = JSON.parse(rawBody) as ZendeskTicketWebhookPayload
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  let ticketId: number
  let from: string
  try {
    ticketId = parseZendeskTicketId(payload)
    from = resolveZendeskUserId(payload)
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid payload' }, 400)
  }

  let channel = String(payload.ticket_channel || '')
    .trim()
    .toLowerCase()
  if (!channel) {
    channel = (await fetchZendeskTicketChannel(c.env, ticketId)) || ''
  }

  const allowedChannels = new Set(['messaging', 'apple_business_chat'])
  if (channel && !allowedChannels.has(channel)) {
    return c.json({ ok: true, ignored: true, reason: `unsupported_channel:${channel}` })
  }

  const rawMessage = String(payload.message || payload.latest_public_comment || '').trim()
  if (!rawMessage) return c.json({ ok: true, ignored: true, reason: 'empty_message' })

  const updatedByRole = String(payload.updated_by_role || '')
    .trim()
    .toLowerCase()
  const looksLikeAppleTranscript = /^\(\d{1,2}:\d{2}:\d{2}\)\s+/m.test(rawMessage)
  if (updatedByRole && updatedByRole !== 'end-user' && !looksLikeAppleTranscript) {
    return c.json({ ok: true, ignored: true, reason: `updated_by_role:${updatedByRole}` })
  }

  const body = channel === 'apple_business_chat' ? extractLatestAppleUserLine(rawMessage) : rawMessage
  if (!body) {
    return c.json({ ok: true, ignored: true, reason: 'non_user_transcript_update' })
  }

  const invocationId = c.req.header('x-zendesk-webhook-invocation-id')?.trim()
  const fallbackId = `${ticketId}:${payload.updated_at || ''}:${body.slice(0, 120)}`
  const dedupeKey = invocationId ? `zendesk:${invocationId}` : `zendesk:${fallbackId}`
  const isNew = await checkAndMarkEvent(c.env, dedupeKey)
  if (!isNew) return c.json({ ok: true, ignored: true, reason: 'duplicate' })
  let sunshineTarget = resolveSunshineTarget(c.env, payload)
  if (channel === 'apple_business_chat' && !sunshineTarget.conversationId && !sunshineTarget.appUserId) {
    const auditTarget = await fetchSunshineTargetFromTicketAudits(c.env, ticketId)
    sunshineTarget = {
      conversationId: sunshineTarget.conversationId || auditTarget.conversationId,
      appUserId: sunshineTarget.appUserId || auditTarget.appUserId,
    }
  }
  if (channel === 'apple_business_chat' && sunshineTarget.appUserId) {
    from = `sunshine-user:${sunshineTarget.appUserId}`
  }

  const traceId = createTraceId('zendesk')
  const keyword = extractKeyword(body)
  const onboarding = normalizeE164(c.env.TXTCLAW_ONBOARDING_NUMBER)
  const existing = await getUser(c.env, from)
  const runtime = deriveRuntimeIdentity(from)
  let baseUser: UserRecord = existing || {
    from,
    status: 'new',
    sandboxKey: runtime.sandboxKey,
    r2Prefix: runtime.r2Prefix,
    optedInAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  if (channel === 'apple_business_chat') {
    if (existing?.lastAppleTranscriptSignature && existing.lastAppleTranscriptSignature === rawMessage) {
      return c.json({ ok: true, ignored: true, reason: 'duplicate_apple_transcript' })
    }

    baseUser = await putUser(c.env, {
      ...baseUser,
      sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
      r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
      lastAppleTranscriptSignature: rawMessage,
    } as any)
  }

  const inboundSeq = nextInboundSeq(baseUser)
  baseUser = await putUser(c.env, {
    ...baseUser,
    sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
    r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
    lastInboundSeq: inboundSeq,
    lastInboundAt: nowIso(),
  } as any)

  const trace: AppleReplyTraceContext = {
    channel: 'zendesk',
    fromIdentity: from,
    ticketId,
    conversationId: sunshineTarget.conversationId,
    appUserId: sunshineTarget.appUserId,
    inboundSeq,
  }

  logTrace(traceId, 'ingress.received', {
    ...trace,
    channelType: channel || 'unknown',
    dedupeKey,
  })

  if (
    keyword &&
    (STOP_KEYWORDS.has(keyword) ||
      HELP_KEYWORDS.has(keyword) ||
      START_KEYWORDS.has(keyword) ||
      STATUS_KEYWORDS.has(keyword))
  ) {
    if (STOP_KEYWORDS.has(keyword)) {
      await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: nowIso(),
      } as any)
      await sendZendeskReply(c.env, {
        ticketId,
        body: stopMessage(),
        sunshineTarget,
      })
      return c.json({ ok: true, from, action: 'stop' })
    }

    if (START_KEYWORDS.has(keyword)) {
      await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: undefined,
        optedInAt: baseUser.optedInAt || nowIso(),
      } as any)
      await sendZendeskReply(c.env, {
        ticketId,
        body: startMessage(),
        sunshineTarget,
      })
      return c.json({ ok: true, from, action: 'start' })
    }

    if (STATUS_KEYWORDS.has(keyword)) {
      const usage = [
        `Status: ${baseUser.status}`,
        `Inbound today: ${baseUser.inboundDayCount || 0}`,
        `Inbound this week: ${baseUser.inboundWeekCount || 0}`,
        `Outbound today: ${baseUser.outboundDayCount || 0}`,
        `Outbound this week: ${baseUser.outboundWeekCount || 0}`,
        `Fast requests this month: ${baseUser.fastRequestMonthCount || 0}`,
        `LLM tokens this month: ${baseUser.llmTotalTokensMonth || 0}`,
        `Model: ${baseUser.lastModelUsed || 'n/a'}`,
        `Estimated spend this month: ${baseUser.estimatedSpendCentsMonth || 0} cents`,
      ]
      await sendZendeskReply(c.env, {
        ticketId,
        body: usage.join('\n'),
        sunshineTarget,
      })
      return c.json({ ok: true, from, action: 'status' })
    }

    await sendZendeskReply(c.env, {
      ticketId,
      body: helpMessage(onboarding || undefined),
      sunshineTarget,
    })
    return c.json({ ok: true, from, action: 'help' })
  }

  if (baseUser.optedOutAt) {
    return c.json({ ok: true, suppressed: true })
  }

  // Apple beta is invite-only. Once a user can message this thread, activate on first inbound.
  if (baseUser.status !== 'active' && channel === 'apple_business_chat') {
    baseUser = await putUser(c.env, {
      ...baseUser,
      status: 'active',
      activatedAt: baseUser.activatedAt || nowIso(),
      sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
      r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
    } as any)
  }

  // Non-Apple Zendesk channels keep legacy paywall behavior.
  if (baseUser.status !== 'active') {
    const limitConfig = getLimitConfig(c.env)
    if (existing && existing.status !== 'active' && !canSendUnpaidPrompt(existing, limitConfig)) {
      const checkoutUrl =
        existing.checkout?.status === 'pending' && existing.checkout?.url
          ? existing.checkout.url
          : (await ensureCheckoutLink(c.env, from, c.req.url)).url
      await sendZendeskOfferWithPreview(c.env, {
        ticketId,
        checkoutUrl,
        detailsBody:
          'You reached today’s free preview limit.\n\nUse the checkout link above to continue in this same thread.',
        sunshineTarget,
      })
      return c.json({ ok: true, from, action: 'unpaid_prompt_cap' })
    }

    const offer = resolveOffer({
      env: c.env,
      user: existing,
      inboundBody: body,
    })
    const checkout = await ensureCheckoutLink(c.env, from, c.req.url, {
      amountCents: offer.amountCents,
      forceNewLink: offer.changed,
    })

    const latest = {
      ...checkout.user,
      negotiatedPriceCents: offer.amountCents,
      negotiationTurns: offer.turns,
      lastNegotiatedAt: offer.changed ? nowIso() : checkout.user.lastNegotiatedAt,
    }
    const base = getPrice(c.env)
    const offerText = formatPrice(offer.amountCents, base.currency)
    const floorReached = offer.amountCents <= offer.floorCents
    const llmIntro = await buildOfferAssistantIntro({
      env: c.env,
      user: latest,
      inboundBody: body,
      offerText,
      offerChanged: offer.changed,
      floorReached,
    })
    await putUser(c.env, bumpUnpaidPromptCounter(llmIntro.user))

    const introPrefix = existing ? '' : `${onboardingServiceIntro()}\n\n`
    const details = `${introPrefix}${llmIntro.text}\n\nAfter payment, you’ll be activated in this same chat.`
    await sendZendeskOfferWithPreview(c.env, {
      ticketId,
      checkoutUrl: checkout.url,
      detailsBody: details,
      sunshineTarget,
    })
    return c.json({ ok: true, from, action: 'offer_sent' })
  }

  const inboundUsage = applyInboundUsage(
    {
      ...baseUser,
      lastInboundAt: nowIso(),
      lastInboundSeq: inboundSeq,
    },
    getLimitConfig(c.env),
  )
  let updatedUser = await putUser(c.env, inboundUsage.user)
  if (!inboundUsage.allowed) {
    await sendZendeskReply(c.env, {
      ticketId,
      body: limitExceededMessage(inboundUsage.reason),
      sunshineTarget,
    })
    return c.json({ ok: true, from, action: 'usage_limited' })
  }

  if (channel === 'apple_business_chat') {
    const bootstrap = applyIdentityBootstrap({
      user: updatedUser,
      inboundBody: body,
      enabled: shouldRunBootstrap(c.env),
      nowIso: nowIso(),
    })

    logTrace(traceId, 'bootstrap.transition', {
      ...trace,
      transition: bootstrap.transition,
    })

    if (bootstrap.action === 'reply') {
      try {
        await dispatchAppleReply({
          env: c.env,
          user: bootstrap.user,
          body: bootstrap.replyBody,
          replySource: 'fallback',
          applyOutboundAccounting: true,
          sendReply: async (replyBody) =>
            sendZendeskReply(c.env, {
              ticketId,
              body: replyBody,
              sunshineTarget,
            }),
          traceId,
          trace,
        })
      } catch (error) {
        await dispatchAppleReplyFailure({
          env: c.env,
          user: bootstrap.user,
          error,
          traceId,
          trace,
        })
        throw error
      }
      return c.json({ ok: true, from, action: 'bootstrap' })
    }

    updatedUser = await putUser(c.env, bootstrap.user)

    const flow = await runAppleBridgeFlow({
      env: c.env,
      user: updatedUser,
      inboundBody: body,
      fromIdentity: from,
      source: 'zendesk',
      traceId,
      trace,
      sendReply: async (replyBody) =>
        sendZendeskReply(c.env, {
          ticketId,
          body: replyBody,
          sunshineTarget,
        }),
      scheduleTask: (task) => {
        try {
          const executionCtx = c.executionCtx
          if (executionCtx) {
            executionCtx.waitUntil(task)
            return
          }
        } catch {
          // ignore and continue with direct task execution
        }
        void task
      },
    })

    return c.json({ ok: true, from, action: flow.action, replySource: flow.replySource })
  }

  const generated = await buildDedicatedReplySafe({
    env: c.env,
    user: updatedUser,
    inboundBody: body,
    source: 'zendesk',
  })

  try {
    await sendZendeskReply(c.env, {
      ticketId,
      body: generated.replyBody,
      sunshineTarget,
    })
    await putUser(c.env, {
      ...generated.user,
      lastOutboundAt: nowIso(),
      lastOutboundErrorAt: undefined,
      lastOutboundError: undefined,
    })

    if (isWarmupReply(generated.replyBody)) {
      const followup = scheduleZendeskWarmupFollowup({
        env: c.env,
        fromIdentity: from,
        inboundBody: body,
        ticketId,
        sunshineTarget,
      })
      try {
        const executionCtx = c.executionCtx
        if (executionCtx) {
          executionCtx.waitUntil(followup)
        } else {
          void followup
        }
      } catch {
        void followup
      }
    }
  } catch (error) {
    await putUser(c.env, {
      ...generated.user,
      lastOutboundErrorAt: nowIso(),
      lastOutboundError: error instanceof Error ? error.message : 'Zendesk reply failed',
    })
    throw error
  }

  return c.json({ ok: true, from, action: 'agent_reply' })
})

// POST /webhooks/sunshine
// Receives Sunshine Conversations webhooks directly for real-time Apple message handling.
txtclawWebhooks.post('/sunshine', async (c) => {
  if (isTrue(c.env.TXTCLAW_DISABLE_SUNSHINE_AUTOREPLY)) {
    return c.json({ ok: true, ignored: true, reason: 'sunshine_disabled' })
  }

  const rawBody = await c.req.raw.clone().text()

  let payload: SunshineWebhookPayload
  try {
    payload = JSON.parse(rawBody) as SunshineWebhookPayload
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  const inbound = extractSunshineInbound(payload)
  const trigger = (inbound.trigger || '').toLowerCase()

  const body = String(inbound.body || '').trim()
  if (!body) return c.json({ ok: true, ignored: true, reason: 'empty_message' })
  const authorType = (inbound.authorType || '').toLowerCase()
  if (!authorType) {
    return c.json({
      ok: true,
      ignored: true,
      reason: `missing_author;trigger:${trigger || 'unknown'};source:${inbound.sourceType || 'unknown'}`,
    })
  }
  if (authorType !== 'user' && authorType !== 'appuser') {
    return c.json({
      ok: true,
      ignored: true,
      reason: `author:${authorType};trigger:${trigger || 'unknown'};source:${inbound.sourceType || 'unknown'}`,
    })
  }

  const dedupeId =
    inbound.messageId || `${inbound.conversationId || ''}:${inbound.receivedAt || ''}:${body.slice(0, 120)}`
  const isNew = await checkAndMarkEvent(c.env, `sunshine:${dedupeId}`)
  if (!isNew) return c.json({ ok: true, ignored: true, reason: 'duplicate' })

  const sunshineTarget: SunshineTarget = {
    conversationId: inbound.conversationId,
    appUserId: inbound.appUserId,
  }
  if (!sunshineTarget.conversationId && !sunshineTarget.appUserId) {
    return c.json({ ok: true, ignored: true, reason: 'missing_target' })
  }
  const allowlist = parseCsvLowerSet(c.env.TXTCLAW_SUNSHINE_ALLOWLIST_APP_USERS)
  if (allowlist.size > 0) {
    const inboundAppUser = String(inbound.appUserId || '')
      .trim()
      .toLowerCase()
    if (!inboundAppUser || !allowlist.has(inboundAppUser)) {
      return c.json({ ok: true, ignored: true, reason: 'appuser_not_allowlisted' })
    }
  }

  const fromIdentity = inbound.appUserId
    ? `sunshine-user:${inbound.appUserId}`
    : `sunshine-conversation:${inbound.conversationId}`
  const traceId = createTraceId('sunshine')
  const keyword = extractKeyword(body)
  const onboarding = normalizeE164(c.env.TXTCLAW_ONBOARDING_NUMBER)
  const existing = await getUser(c.env, fromIdentity)
  const runtime = deriveRuntimeIdentity(fromIdentity)
  let baseUser: UserRecord = existing || {
    from: fromIdentity,
    status: 'new',
    sandboxKey: runtime.sandboxKey,
    r2Prefix: runtime.r2Prefix,
    optedInAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  const inboundSeq = nextInboundSeq(baseUser)
  baseUser = await putUser(c.env, {
    ...baseUser,
    sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
    r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
    lastInboundSeq: inboundSeq,
    lastInboundAt: nowIso(),
  } as any)

  const trace: AppleReplyTraceContext = {
    channel: 'sunshine',
    fromIdentity,
    conversationId: sunshineTarget.conversationId,
    appUserId: sunshineTarget.appUserId,
    inboundSeq,
  }

  logTrace(traceId, 'ingress.received', {
    ...trace,
    trigger: trigger || 'unknown',
    dedupeId,
  })

  if (
    keyword &&
    (STOP_KEYWORDS.has(keyword) ||
      HELP_KEYWORDS.has(keyword) ||
      START_KEYWORDS.has(keyword) ||
      STATUS_KEYWORDS.has(keyword))
  ) {
    if (STOP_KEYWORDS.has(keyword)) {
      const stoppedUser = await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: nowIso(),
      } as any)
      await sendSunshineReplyOnly(c.env, { body: stopMessage(), sunshineTarget, traceId })
      await putUser(c.env, markOutboundSuccess(stoppedUser))
      return c.json({ ok: true, from: fromIdentity, action: 'stop' })
    }

    if (START_KEYWORDS.has(keyword)) {
      const startedUser = await putUser(c.env, {
        ...baseUser,
        sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
        r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
        optedOutAt: undefined,
        optedInAt: baseUser.optedInAt || nowIso(),
      } as any)
      await sendSunshineReplyOnly(c.env, { body: startMessage(), sunshineTarget, traceId })
      await putUser(c.env, markOutboundSuccess(startedUser))
      return c.json({ ok: true, from: fromIdentity, action: 'start' })
    }

    if (STATUS_KEYWORDS.has(keyword)) {
      const usage = [
        `Status: ${baseUser.status}`,
        `Inbound today: ${baseUser.inboundDayCount || 0}`,
        `Inbound this week: ${baseUser.inboundWeekCount || 0}`,
        `Outbound today: ${baseUser.outboundDayCount || 0}`,
        `Outbound this week: ${baseUser.outboundWeekCount || 0}`,
        `Fast requests this month: ${baseUser.fastRequestMonthCount || 0}`,
        `LLM tokens this month: ${baseUser.llmTotalTokensMonth || 0}`,
        `Model: ${baseUser.lastModelUsed || 'n/a'}`,
        `Estimated spend this month: ${baseUser.estimatedSpendCentsMonth || 0} cents`,
      ]
      await sendSunshineReplyOnly(c.env, {
        body: usage.join('\n'),
        sunshineTarget,
        traceId,
      })
      await putUser(c.env, markOutboundSuccess(baseUser))
      return c.json({ ok: true, from: fromIdentity, action: 'status' })
    }

    await sendSunshineReplyOnly(c.env, {
      body: helpMessage(onboarding || undefined),
      sunshineTarget,
      traceId,
    })
    await putUser(c.env, markOutboundSuccess(baseUser))
    return c.json({ ok: true, from: fromIdentity, action: 'help' })
  }

  if (baseUser.optedOutAt) {
    return c.json({ ok: true, suppressed: true })
  }

  const minReplyIntervalSeconds = parseNonNegativeInt(c.env.TXTCLAW_SUNSHINE_MIN_REPLY_INTERVAL_SECONDS, 0)
  if (minReplyIntervalSeconds > 0 && isRecentlyOutbound(existing || baseUser, minReplyIntervalSeconds)) {
    return c.json({ ok: true, suppressed: true, reason: 'reply_throttled' })
  }

  if (baseUser.status !== 'active') {
    baseUser = await putUser(c.env, {
      ...baseUser,
      status: 'active',
      activatedAt: baseUser.activatedAt || nowIso(),
      sandboxKey: baseUser.sandboxKey || runtime.sandboxKey,
      r2Prefix: baseUser.r2Prefix || runtime.r2Prefix,
    } as any)
  }

  const inboundUsage = applyInboundUsage(
    {
      ...baseUser,
      lastInboundAt: nowIso(),
      lastInboundSeq: inboundSeq,
    },
    getLimitConfig(c.env),
  )
  let updatedUser = await putUser(c.env, inboundUsage.user)
  if (!inboundUsage.allowed) {
    await sendSunshineReplyOnly(c.env, {
      body: limitExceededMessage(inboundUsage.reason),
      sunshineTarget,
      traceId,
    })
    await putUser(c.env, markOutboundSuccess(updatedUser))
    return c.json({ ok: true, from: fromIdentity, action: 'usage_limited' })
  }

  const bootstrap = applyIdentityBootstrap({
    user: updatedUser,
    inboundBody: body,
    enabled: shouldRunBootstrap(c.env),
    nowIso: nowIso(),
  })

  logTrace(traceId, 'bootstrap.transition', {
    ...trace,
    transition: bootstrap.transition,
  })

  if (bootstrap.action === 'reply') {
    try {
      await dispatchAppleReply({
        env: c.env,
        user: bootstrap.user,
        body: bootstrap.replyBody,
        replySource: 'fallback',
        applyOutboundAccounting: true,
        sendReply: async (replyBody) =>
          sendSunshineReplyOnly(c.env, {
            body: replyBody,
            sunshineTarget,
            traceId,
          }),
        traceId,
        trace,
      })
    } catch (error) {
      await dispatchAppleReplyFailure({
        env: c.env,
        user: bootstrap.user,
        error,
        traceId,
        trace,
      })
      throw error
    }
    return c.json({ ok: true, from: fromIdentity, action: 'bootstrap' })
  }

  updatedUser = await putUser(c.env, bootstrap.user)

  const flow = await runAppleBridgeFlow({
    env: c.env,
    user: updatedUser,
    inboundBody: body,
    fromIdentity,
    source: 'sunshine',
    traceId,
    trace,
    sendReply: async (replyBody) =>
      sendSunshineReplyOnly(c.env, {
        body: replyBody,
        sunshineTarget,
        traceId,
      }),
    scheduleTask: (task) => {
      try {
        const executionCtx = c.executionCtx
        if (executionCtx) {
          executionCtx.waitUntil(task)
          return
        }
      } catch {
        // ignore and continue with direct task execution
      }
      void task
    },
  })

  return c.json({ ok: true, from: fromIdentity, action: flow.action, replySource: flow.replySource })
})

// POST /webhooks/square
txtclawWebhooks.post('/square', async (c) => {
  const rawBody = await c.req.raw.clone().text()

  const skipSig = c.env.DEV_MODE === 'true' || c.env.E2E_TEST_MODE === 'true'
  if (!skipSig) {
    const signatureKey = c.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim()
    if (!signatureKey) return c.json({ ok: false, error: 'Missing SQUARE_WEBHOOK_SIGNATURE_KEY' }, 500)

    const ok = await verifySquareWebhookSignature({
      signatureKey,
      notificationUrl: getSquareWebhookUrl(c.env, c.req.url),
      rawBody,
      expectedSignature: c.req.header('x-square-hmacsha256-signature'),
    })

    if (!ok) return c.json({ ok: false, error: 'Invalid signature' }, 401)
  }

  let event: SquareWebhookEvent
  try {
    event = JSON.parse(rawBody) as SquareWebhookEvent
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  if (!event.event_id || !event.type) {
    return c.json({ ok: false, error: 'Invalid event shape' }, 400)
  }

  const isNew = await checkAndMarkEvent(c.env, `square:${event.event_id}`)
  if (!isNew) return c.json({ ok: true, ignored: true })

  // Handle payment and subscription lifecycle events.
  const supported = event.type.startsWith('payment.') || event.type.startsWith('subscription.')
  if (!supported) return c.json({ ok: true, ignored: true, type: event.type })

  // Attempt to locate payment/subscription fields in event payload.
  const data = event.data as any
  const payment = data?.object?.payment
  const subscription = data?.object?.subscription
  const orderId: string | undefined = payment?.order_id
  const paymentId: string | undefined = payment?.id
  const paymentStatus: string | undefined = payment?.status
  const paymentSubscriptionId: string | undefined = payment?.subscription_id
  const subscriptionId: string | undefined = subscription?.id
  const subscriptionStatus: string | undefined = subscription?.status

  if (event.type.startsWith('subscription.')) {
    if (!subscriptionId) return c.json({ ok: true, ignored: true, reason: 'missing_subscription_id' })
    const from = await getFromBySubscription(c.env, subscriptionId)
    if (!from) return c.json({ ok: true, ignored: true, reason: 'unknown_subscription', subscriptionId })

    const existing = await getUser(c.env, from)
    if (!existing) return c.json({ ok: true, ignored: true, reason: 'missing_user', from })

    const normalized = (subscriptionStatus || '').toUpperCase()
    if (normalized === 'ACTIVE') {
      const updated = await putUser(c.env, {
        ...existing,
        squareSubscriptionId: subscriptionId,
        status: existing.dedicatedNumber ? 'active' : existing.status,
      })
      return c.json({ ok: true, from: updated.from, status: updated.status, subscriptionStatus: normalized })
    }

    if (['PAUSED', 'CANCELED', 'DEACTIVATED'].includes(normalized)) {
      const updated = await putUser(c.env, {
        ...existing,
        squareSubscriptionId: subscriptionId,
        status: 'frozen',
      })
      return c.json({ ok: true, from: updated.from, status: updated.status, subscriptionStatus: normalized })
    }

    return c.json({ ok: true, ignored: true, subscriptionStatus: normalized || 'UNKNOWN' })
  }

  if (!orderId) return c.json({ ok: true, ignored: true, reason: 'missing_order_id' })

  const from = await getFromByOrder(c.env, orderId)
  if (!from) return c.json({ ok: true, ignored: true, reason: 'unknown_order', orderId })

  // Only provision on completed.
  if (paymentStatus && paymentStatus !== 'COMPLETED') {
    const existing = await getUser(c.env, from)
    if (existing) {
      await putUser(c.env, {
        ...existing,
        status: 'frozen',
      })
    }
    return c.json({ ok: true, ignored: true, reason: 'not_completed', paymentStatus })
  }

  const existingForChannel = await getUser(c.env, from)
  const isSmsIdentity = /^[\d+\-().\s]+$/.test(from) && Boolean(normalizeE164(from))
  const allowZendeskDirectActivation = c.env.TXTCLAW_ZENDESK_DIRECT_ACTIVATION === 'true'

  if (!isSmsIdentity && allowZendeskDirectActivation) {
    const runtime = deriveRuntimeIdentity(from)
    let directUser = await putUser(c.env, {
      ...(existingForChannel || {
        from,
        createdAt: nowIso(),
      }),
      status: 'active',
      activatedAt: existingForChannel?.activatedAt || nowIso(),
      sandboxKey: existingForChannel?.sandboxKey || runtime.sandboxKey,
      r2Prefix: existingForChannel?.r2Prefix || runtime.r2Prefix,
      squarePaymentId: paymentId,
      checkout: existingForChannel?.checkout
        ? {
            ...existingForChannel.checkout,
            status: 'paid',
          }
        : undefined,
    } as any)

    if (paymentSubscriptionId) {
      await mapSubscription(c.env, paymentSubscriptionId, from)
      directUser = await putUser(c.env, {
        ...directUser,
        squareSubscriptionId: paymentSubscriptionId,
      })
    }

    return c.json({
      ok: true,
      provisioned: true,
      from,
      dedicatedNumber: null,
      mode: 'zendesk_direct_activation',
    })
  }

  const capacity = await hasProvisioningCapacity(c.env, from)
  if (!capacity.ok) {
    const pending = await getUser(c.env, from)
    if (pending) {
      await putUser(c.env, {
        ...pending,
        status: 'pending_payment',
      })
    }

    const onboarding = normalizeE164(c.env.TXTCLAW_ONBOARDING_NUMBER)
    if (onboarding && c.env.TWILIO_ACCOUNT_SID && c.env.TWILIO_API_KEY_SID && c.env.TWILIO_API_KEY_SECRET) {
      try {
        await sendTwilioSms({
          accountSid: c.env.TWILIO_ACCOUNT_SID,
          apiKeySid: c.env.TWILIO_API_KEY_SID,
          apiKeySecret: c.env.TWILIO_API_KEY_SECRET,
          from: onboarding,
          to: from,
          body: 'You are in the activation queue. We will text you as soon as your dedicated number is ready.',
          statusCallbackUrl: c.env.TWILIO_STATUS_CALLBACK_URL,
        })
      } catch (err) {
        console.error('[txtclaw] failed to send queue status SMS:', err)
      }
    }

    return c.json({ ok: true, queued: true, reason: capacity.reason })
  }

  let user: UserRecord
  try {
    user = await provisionDedicatedNumber(c.env, from, c.req.url, paymentId)
  } catch (error) {
    const existing = await getUser(c.env, from)
    if (existing) {
      await putUser(c.env, {
        ...existing,
        status: 'pending_payment',
      })
    }
    return c.json({
      ok: true,
      queued: true,
      reason: error instanceof Error ? error.message : 'provisioning_failed',
    })
  }
  if (paymentSubscriptionId) {
    await mapSubscription(c.env, paymentSubscriptionId, from)
    user = await putUser(c.env, {
      ...user,
      squareSubscriptionId: paymentSubscriptionId,
    })
  }

  // Notify user from onboarding number if available.
  const onboarding = normalizeE164(c.env.TXTCLAW_ONBOARDING_NUMBER)
  if (
    onboarding &&
    user.dedicatedNumber &&
    c.env.TWILIO_ACCOUNT_SID &&
    c.env.TWILIO_API_KEY_SID &&
    c.env.TWILIO_API_KEY_SECRET
  ) {
    try {
      // If user opted out, do not send activation SMS.
      if (!user.optedOutAt) {
        await sendTwilioSms({
          accountSid: c.env.TWILIO_ACCOUNT_SID,
          apiKeySid: c.env.TWILIO_API_KEY_SID,
          apiKeySecret: c.env.TWILIO_API_KEY_SECRET,
          from: onboarding,
          to: from,
          body: `You’re in.\nYour dedicated number: ${user.dedicatedNumber}\n\nText it to start.\n\nReply STOP to unsubscribe. Msg&Data rates may apply.`,
          statusCallbackUrl: c.env.TWILIO_STATUS_CALLBACK_URL,
        })
      }
    } catch (err) {
      console.error('[txtclaw] failed to send activation SMS:', err)
    }
  }

  return c.json({ ok: true, provisioned: true, from, dedicatedNumber: user.dedicatedNumber })
})
