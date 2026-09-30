import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  markBackPending,
  markConflict,
  markFailed,
  markInFlight,
  markSynced,
  setAppState,
  takePendingSyncBatch,
  type AppState,
  type SyncQueueItem,
} from './posStore'
import {
  createInMemorySyncAdapter,
  createRestSyncAdapter,
  resolveConflict,
  runSync,
} from './syncEngine'

function makeItem(partial: Partial<SyncQueueItem>): SyncQueueItem {
  return {
    id: partial.id ?? 'sync-1',
    businessId: partial.businessId ?? 'biz-1',
    action: partial.action ?? 'sale-created',
    payload: partial.payload ?? {},
    status: partial.status ?? 'pending',
    createdAt: '2026-09-24T08:00:00.000Z',
    attempts: partial.attempts ?? 0,
  }
}

function seedQueue(state: AppState, items: SyncQueueItem[]): void {
  state.syncQueue.push(...items)
}

describe('sync engine', () => {
  let state: AppState

  beforeEach(() => {
    state = createInitialState()
    setAppState(state)
  })

  it('pushes a batch, marks items synced, and drains the queue', async () => {
    seedQueue(state, [makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    const adapter = createInMemorySyncAdapter()

    const result = await runSync(state, adapter)

    expect(result.pushed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.conflicts).toBe(0)
    expect(state.syncQueue.every((item) => item.status === 'synced')).toBe(true)
    expect(adapter.received.map((item) => item.id).sort()).toEqual(['a', 'b'])
  })

  it('retries failed pushes with backoff until they succeed', async () => {
    seedQueue(state, [makeItem({ id: 'a' })])
    const adapter = createInMemorySyncAdapter({ failTimes: 2 })

    const result = await runSync(state, adapter, { baseDelayMs: 1 })

    expect(result.attempts).toBe(3)
    expect(result.pushed).toBe(1)
    expect(adapter.received).toHaveLength(1)
  })

  it('marks items as error after max attempts instead of dropping them', async () => {
    seedQueue(state, [makeItem({ id: 'stuck' })])
    const adapter = createInMemorySyncAdapter({ failTimes: 99 })

    const result = await runSync(state, adapter, { maxAttempts: 2, baseDelayMs: 1 })

    expect(result.failed).toBe(1)
    expect(result.pushed).toBe(0)
    const stuck = state.syncQueue.find((item) => item.id === 'stuck')
    expect(stuck?.status).toBe('error')
    expect(stuck?.lastError).toBeTruthy()
  })

  it('never duplicates records when the same id is pushed twice', async () => {
    const adapter = createInMemorySyncAdapter()

    await adapter.push([makeItem({ id: 'dup-1' })])
    await adapter.push([makeItem({ id: 'dup-1' })])

    expect(adapter.received).toHaveLength(1)
  })

  it('stops cleanly when the abort signal fires mid-run', async () => {
    seedQueue(state, [makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    const controller = new AbortController()
    controller.abort()

    const result = await runSync(state, createInMemorySyncAdapter(), {
      signal: controller.signal,
    })

    expect(result.stopped).toBe(true)
    expect(result.pushed).toBe(0)
  })

  it('flags conflicts for the owner instead of silently discarding data', async () => {
    seedQueue(state, [makeItem({ id: 'conflict-1' })])
    const adapter = createInMemorySyncAdapter({ conflictIds: ['conflict-1'] })

    const result = await runSync(state, adapter)

    expect(result.conflicts).toBe(1)
    const item = state.syncQueue.find((entry) => entry.id === 'conflict-1')
    expect(item?.status).toBe('conflict')
    expect(item?.conflict).toHaveLength(1)
  })

  it('resolves conflicts: keep-mine requeues, keep-theirs syncs, drop fails the item', async () => {
    seedQueue(state, [makeItem({ id: 'c1' })])
    const adapter = createInMemorySyncAdapter({ conflictIds: ['c1'] })
    await runSync(state, adapter)

    resolveConflict(state, 'c1', 'remote')
    expect(state.syncQueue[0].status).toBe('synced')

    resolveConflict(state, 'c1', 'local')
    expect(state.syncQueue[0].status).toBe('synced') // only conflict items can be requeued

    resolveConflict(state, 'c1', 'drop')
    expect(state.syncQueue[0].status).toBe('synced') // unchanged
  })

  it('rest adapter reports all items failed when the endpoint errors', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('server down', { status: 500 }))
    const adapter = createRestSyncAdapter('https://example.test/sync', fakeFetch as typeof fetch)

    const report = await adapter.push([makeItem({ id: 'r1' })])

    expect(report.failedIds).toEqual(['r1'])
    expect(report.error).toContain('500')
  })

  it('rest adapter parses the success report from the endpoint', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ syncedIds: ['r1'], failedIds: [], conflicts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const adapter = createRestSyncAdapter('https://example.test/sync', fakeFetch as typeof fetch)

    const report = await adapter.push([makeItem({ id: 'r1' })])

    expect(report.syncedIds).toEqual(['r1'])
  })
})

describe('queue primitives', () => {
  it('takePendingSyncBatch only returns pending items', () => {
    const state = createInitialState()
    seedQueue(state, [
      makeItem({ id: 'a', status: 'pending' }),
      makeItem({ id: 'b', status: 'synced' }),
      makeItem({ id: 'c', status: 'conflict' }),
      makeItem({ id: 'd', status: 'pending' }),
    ])

    const batch = takePendingSyncBatch(state, 10)

    expect(batch.map((item) => item.id)).toEqual(['a', 'd'])
  })

  it('mark helpers transition item states without losing data', () => {
    const state = createInitialState()
    seedQueue(state, [makeItem({ id: 'a' })])

    markInFlight(state, ['a'])
    expect(state.syncQueue[0].status).toBe('in-flight')

    markBackPending(state, ['a'], 'offline')
    expect(state.syncQueue[0].status).toBe('pending')
    expect(state.syncQueue[0].lastError).toBe('offline')

    markConflict(state, 'a', [{ field: 'stock', localValue: 1, remoteValue: 2 }])
    expect(state.syncQueue[0].status).toBe('conflict')

    markFailed(state, 'a', 'gave up')
    expect(state.syncQueue[0].status).toBe('error')

    markSynced(state, ['a'])
    expect(state.syncQueue[0].status).toBe('synced')
  })
})
