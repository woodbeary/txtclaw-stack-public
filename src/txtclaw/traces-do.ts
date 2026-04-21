export type TraceGrade = 'good' | 'bad' | 'needs_prompt' | 'bug' | 'unknown'

export type TraceRecord = {
  traceId: string
  startedAt: string
  endedAt?: string
  method: string
  pathname: string
  status: number
  elapsedMs: number
  ray?: string
  ipHash?: string | null
  apiKeyId?: string
  apiKeyUserId?: string
  apiKeyAuthKind?: 'allowlist' | 'directory'
  agentId?: string
  llmMode?: 'hosted' | 'byok'
  llmTier?: 'fast' | 'smart'
  modelUsed?: string
  promptVersionId?: string
  error?: string
  grade?: TraceGrade
  gradeNote?: string
  gradedAt?: string
}

type Action =
  | { action: 'putTrace'; trace: TraceRecord }
  | { action: 'getTrace'; traceId: string }
  | { action: 'listTraces'; limit?: number; cursor?: string }
  | { action: 'gradeTrace'; traceId: string; grade: TraceGrade; note?: string }

type ActionResult =
  | { ok: true; trace?: TraceRecord | null; traces?: TraceRecord[]; cursor?: string | null }
  | { ok: false; error: string }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(200, Math.floor(n)))
}

function traceKey(traceId: string): string {
  return `trace:${traceId}`
}

const TS_MAX = 9_999_999_999_999

function revKeyForDateMs(dateMs: number): string {
  const clamped = Math.max(0, Math.min(TS_MAX, Math.floor(dateMs)))
  return String(TS_MAX - clamped).padStart(13, '0')
}

function indexKey(dateMs: number, traceId: string): string {
  return `idx:${revKeyForDateMs(dateMs)}:${traceId}`
}

function parseIndexTraceId(key: string): string | null {
  const parts = key.split(':')
  if (parts.length !== 3) return null
  if (parts[0] !== 'idx') return null
  return parts[2] || null
}

function toDateMs(iso: string | undefined): number {
  const raw = String(iso || '').trim()
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : Date.now()
}

function asTraceGrade(raw: unknown): TraceGrade {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  if (value === 'good' || value === 'bad' || value === 'needs_prompt' || value === 'bug') return value
  return 'unknown'
}

export class TxtClawTraces implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' } satisfies ActionResult, 405)
    }

    let action: Action
    try {
      action = (await request.json()) as Action
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' } satisfies ActionResult, 400)
    }

    try {
      const storage = this.state.storage

      switch (action.action) {
        case 'putTrace': {
          const trace = action.trace as TraceRecord
          const traceId = String(trace?.traceId || '').trim()
          if (!traceId) {
            return jsonResponse({ ok: false, error: 'Missing traceId' } satisfies ActionResult, 400)
          }

          const dateMs = toDateMs(trace.startedAt)
          await storage.put(traceKey(traceId), trace)
          await storage.put(indexKey(dateMs, traceId), traceId)
          return jsonResponse({ ok: true } satisfies ActionResult)
        }

        case 'getTrace': {
          const traceId = String(action.traceId || '').trim()
          if (!traceId) {
            return jsonResponse({ ok: false, error: 'Missing traceId' } satisfies ActionResult, 400)
          }
          const trace = (await storage.get<TraceRecord>(traceKey(traceId))) || null
          return jsonResponse({ ok: true, trace } satisfies ActionResult)
        }

        case 'listTraces': {
          const limit = clampLimit(action.limit, 50)
          const cursor = action.cursor ? String(action.cursor).trim() : ''

          const listed = await storage.list<string>({
            prefix: 'idx:',
            limit: limit + 1,
            ...(cursor ? { startAfter: cursor } : {}),
          })

          const keys = Array.from(listed.keys())
          const pageKeys = keys.slice(0, limit)
          // Cursor semantics: client passes the last-seen key back; we use startAfter(cursor)
          // so the next page begins strictly after it.
          const nextCursor = keys.length > limit ? pageKeys[pageKeys.length - 1] || null : null

          const traceIds = pageKeys
            .map((key) => parseIndexTraceId(key))
            .filter((id): id is string => Boolean(id))

          if (traceIds.length === 0) {
            return jsonResponse({ ok: true, traces: [], cursor: nextCursor } satisfies ActionResult)
          }

          const traceKeyMap = (await storage.get<TraceRecord>(traceIds.map((id) => traceKey(id)))) as Map<
            string,
            TraceRecord
          >

          const traces: TraceRecord[] = []
          for (const id of traceIds) {
            const record = traceKeyMap.get(traceKey(id))
            if (record) traces.push(record)
          }

          return jsonResponse({ ok: true, traces, cursor: nextCursor } satisfies ActionResult)
        }

        case 'gradeTrace': {
          const traceId = String(action.traceId || '').trim()
          if (!traceId) {
            return jsonResponse({ ok: false, error: 'Missing traceId' } satisfies ActionResult, 400)
          }

          const existing = (await storage.get<TraceRecord>(traceKey(traceId))) || null
          if (!existing) {
            return jsonResponse({ ok: false, error: 'Trace not found' } satisfies ActionResult, 404)
          }

          const note = action.note !== undefined && action.note !== null ? String(action.note).trim() : ''
          const updated: TraceRecord = {
            ...existing,
            grade: asTraceGrade(action.grade),
            gradeNote: note || undefined,
            gradedAt: nowIso(),
          }

          await storage.put(traceKey(traceId), updated)
          return jsonResponse({ ok: true, trace: updated } satisfies ActionResult)
        }
      }

      return jsonResponse({ ok: false, error: 'Unknown action' } satisfies ActionResult, 400)
    } catch (error) {
      return jsonResponse(
        { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ActionResult,
        500,
      )
    }
  }
}
