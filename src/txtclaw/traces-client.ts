import type { MoltbotEnv } from '../types'
import type { TraceGrade, TraceRecord } from './traces-do'

type TracesResponse =
  | { ok: true; trace?: TraceRecord | null; traces?: TraceRecord[]; cursor?: string | null }
  | { ok: false; error: string }

function getTracesStub(env: MoltbotEnv): DurableObjectStub {
  if (!env.TXTCLAW_TRACES) {
    throw new Error('TXTCLAW_TRACES binding is not configured')
  }

  const id = env.TXTCLAW_TRACES.idFromName('txtclaw-traces')
  return env.TXTCLAW_TRACES.get(id)
}

async function callTraces(env: MoltbotEnv, payload: unknown): Promise<TracesResponse> {
  const stub = getTracesStub(env)
  const res = await stub.fetch('https://txtclaw-traces/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  try {
    return JSON.parse(text) as TracesResponse
  } catch {
    if (!res.ok) {
      return { ok: false, error: `Traces call failed (${res.status}): ${text}` }
    }
    return { ok: false, error: 'Traces returned invalid JSON' }
  }
}

export async function putTrace(env: MoltbotEnv, trace: TraceRecord): Promise<void> {
  const data = await callTraces(env, { action: 'putTrace', trace })
  if (!data.ok) throw new Error(data.error)
}

export async function getTrace(env: MoltbotEnv, traceId: string): Promise<TraceRecord | null> {
  const data = await callTraces(env, { action: 'getTrace', traceId })
  if (!data.ok) throw new Error(data.error)
  return data.trace ?? null
}

export async function listTraces(
  env: MoltbotEnv,
  args: { limit?: number; cursor?: string } = {},
): Promise<{ traces: TraceRecord[]; cursor: string | null }> {
  const data = await callTraces(env, { action: 'listTraces', limit: args.limit, cursor: args.cursor })
  if (!data.ok) throw new Error(data.error)
  return { traces: data.traces || [], cursor: data.cursor ?? null }
}

export async function gradeTrace(
  env: MoltbotEnv,
  args: { traceId: string; grade: TraceGrade; note?: string },
) {
  const data = await callTraces(env, {
    action: 'gradeTrace',
    traceId: args.traceId,
    grade: args.grade,
    note: args.note,
  })
  if (!data.ok) throw new Error(data.error)
  return data.trace ?? null
}
