import { describe, expect, it } from 'vitest'
import { type TraceRecord, TxtClawTraces } from './traces-do'

function createInMemoryState() {
  const store = new Map<string, unknown>()
  const state = {
    storage: {
      get: async <T>(key: string | string[]): Promise<T | Map<string, T> | undefined> => {
        if (Array.isArray(key)) {
          const out = new Map<string, T>()
          for (const k of key) {
            if (store.has(k)) out.set(k, store.get(k) as T)
          }
          return out
        }
        return store.get(key) as T | undefined
      },
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value)
      },
      list: async <T>(options?: { prefix?: string; limit?: number; startAfter?: string }): Promise<
        Map<string, T>
      > => {
        const prefix = options?.prefix || ''
        const startAfter = options?.startAfter || ''
        const limit = typeof options?.limit === 'number' ? Math.max(0, Math.floor(options.limit)) : undefined

        const keys = Array.from(store.keys())
          .filter((key) => (prefix ? key.startsWith(prefix) : true))
          .filter((key) => (startAfter ? key > startAfter : true))
          .sort()

        const selected = limit !== undefined ? keys.slice(0, limit) : keys
        const out = new Map<string, T>()
        for (const key of selected) {
          out.set(key, store.get(key) as T)
        }
        return out
      },
    },
  } as unknown as DurableObjectState

  return { state }
}

function post(doInstance: TxtClawTraces, payload: unknown) {
  return doInstance.fetch(
    new Request('https://txtclaw-traces/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

describe('TxtClawTraces', () => {
  it('stores and lists traces newest-first with cursor', async () => {
    const { state } = createInMemoryState()
    const traces = new TxtClawTraces(state)

    const older: TraceRecord = {
      traceId: 'trc_old',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      method: 'GET',
      pathname: '/v1/status',
      status: 200,
      elapsedMs: 12,
    }

    const newer: TraceRecord = {
      traceId: 'trc_new',
      startedAt: new Date().toISOString(),
      method: 'POST',
      pathname: '/v1/agents',
      status: 200,
      elapsedMs: 34,
    }

    await post(traces, { action: 'putTrace', trace: older })
    await post(traces, { action: 'putTrace', trace: newer })

    const res = await post(traces, { action: 'listTraces', limit: 1 })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.traces).toHaveLength(1)
    expect(json.traces[0].traceId).toBe('trc_new')
    expect(typeof json.cursor === 'string' || json.cursor === null).toBe(true)

    const res2 = await post(traces, { action: 'listTraces', limit: 10, cursor: json.cursor })
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as any
    expect(json2.ok).toBe(true)
    expect(json2.traces.map((t: any) => t.traceId)).toContain('trc_old')
  })

  it('grades a trace', async () => {
    const { state } = createInMemoryState()
    const traces = new TxtClawTraces(state)

    const record: TraceRecord = {
      traceId: 'trc_grade',
      startedAt: new Date().toISOString(),
      method: 'POST',
      pathname: '/v1/agents/x/messages',
      status: 200,
      elapsedMs: 10,
    }

    await post(traces, { action: 'putTrace', trace: record })

    const gradeRes = await post(traces, {
      action: 'gradeTrace',
      traceId: 'trc_grade',
      grade: 'good',
      note: 'looks fine',
    })
    expect(gradeRes.status).toBe(200)
    const graded = (await gradeRes.json()) as any
    expect(graded.ok).toBe(true)
    expect(graded.trace.grade).toBe('good')
    expect(graded.trace.gradeNote).toBe('looks fine')
    expect(typeof graded.trace.gradedAt).toBe('string')
  })
})
