import {
  markBackPending,
  markConflict,
  markFailed,
  markInFlight,
  markSynced,
  takePendingSyncBatch,
  type AppState,
  type SyncConflict,
  type SyncQueueItem,
} from './posStore'

export type SyncPushReport = {
  syncedIds: string[]
  failedIds: string[]
  conflicts: Array<{ id: string; conflicts: SyncConflict[] }>
  error?: string
}

export type SyncAdapter = {
  name: string
  push: (items: SyncQueueItem[]) => Promise<SyncPushReport>
}

export type SyncOptions = {
  batchSize?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

export type SyncRunResult = {
  pushed: number
  failed: number
  conflicts: number
  attempts: number
  stopped: boolean
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Adapter that pushes queued items to a backend over HTTP.
 * The server must treat item.id as an idempotency key: replaying an item
 * already stored must return it in syncedIds, never create a duplicate.
 */
export function createRestSyncAdapter(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): SyncAdapter {
  return {
    name: 'rest',
    async push(items) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        })

        if (!response.ok) {
          return {
            syncedIds: [],
            failedIds: items.map((item) => item.id),
            conflicts: [],
            error: `Sync endpoint returned ${response.status}`,
          }
        }

        const report = (await response.json()) as Partial<SyncPushReport>
        return {
          syncedIds: report.syncedIds ?? [],
          failedIds: report.failedIds ?? [],
          conflicts: report.conflicts ?? [],
        }
      } catch (error) {
        return {
          syncedIds: [],
          failedIds: items.map((item) => item.id),
          conflicts: [],
          error: error instanceof Error ? error.message : 'Network error during sync',
        }
      }
    },
  }
}

/**
 * In-memory adapter used in tests and as an offline dev target.
 * Deduplicates by item id (idempotent server behaviour) and can be told to
 * fail the first N pushes or flag specific ids as conflicts.
 */
export function createInMemorySyncAdapter(options?: {
  failTimes?: number
  conflictIds?: string[]
  onPush?: (items: SyncQueueItem[]) => void
}): SyncAdapter & { received: SyncQueueItem[]; pushCount: number } {
  const received: SyncQueueItem[] = []
  const seenIds = new Set<string>()
  let pushCount = 0
  let remainingFailures = options?.failTimes ?? 0
  const conflictIds = new Set(options?.conflictIds ?? [])

  return {
    name: 'memory',
    get received() {
      return received
    },
    get pushCount() {
      return pushCount
    },
    async push(items) {
      pushCount += 1
      options?.onPush?.(items)

      if (remainingFailures > 0) {
        remainingFailures -= 1
        return {
          syncedIds: [],
          failedIds: items.map((item) => item.id),
          conflicts: [],
          error: 'Simulated transient failure',
        }
      }

      const syncedIds: string[] = []
      const conflicts: Array<{ id: string; conflicts: SyncConflict[] }> = []

      for (const item of items) {
        if (conflictIds.has(item.id)) {
          conflicts.push({
            id: item.id,
            conflicts: [
              {
                field: 'payload',
                localValue: item.payload,
                remoteValue: 'server-copy',
              },
            ],
          })
          continue
        }

        if (seenIds.has(item.id)) {
          // Idempotent replay: already stored server-side, count as synced.
          syncedIds.push(item.id)
          continue
        }

        seenIds.add(item.id)
        received.push(item)
        syncedIds.push(item.id)
      }

      return { syncedIds, failedIds: [], conflicts }
    },
  }
}

function backoffDelayMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempts - 1)
  return Math.min(exponential, maxDelayMs)
}

/**
 * Drives the offline sync queue against an adapter until the queue drains,
 * attempts run out, or the signal aborts. Never throws: all failures are
 * recorded on the queue items so data is never silently dropped.
 */
export async function runSync(
  state: AppState,
  adapter: SyncAdapter,
  options: SyncOptions = {},
): Promise<SyncRunResult> {
  const batchSize = options.batchSize ?? 25
  const maxAttempts = options.maxAttempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 200
  const maxDelayMs = options.maxDelayMs ?? 30_000

  const result: SyncRunResult = {
    pushed: 0,
    failed: 0,
    conflicts: 0,
    attempts: 0,
    stopped: false,
  }

  while (!options.signal?.aborted) {
    const batch = takePendingSyncBatch(state, batchSize)
    if (batch.length === 0) {
      break
    }

    const retryIds: string[] = []
    result.attempts += 1

    markInFlight(state, batch.map((item) => item.id))
    const report = await adapter.push(batch)

    if (report.syncedIds.length > 0) {
      markSynced(state, report.syncedIds)
      result.pushed += report.syncedIds.length
    }

    if (report.conflicts.length > 0) {
      for (const conflict of report.conflicts) {
        markConflict(state, conflict.id, conflict.conflicts)
        result.conflicts += 1
      }
    }

    const failedNoRetry = report.failedIds.filter((id) => {
      const item = state.syncQueue.find((entry) => entry.id === id)
      return !item || item.attempts >= maxAttempts
    })
    const failedRetry = report.failedIds.filter((id) => !failedNoRetry.includes(id))

    if (failedRetry.length > 0) {
      markBackPending(state, failedRetry, report.error ?? 'Sync attempt failed')
      retryIds.push(...failedRetry)
    }

    if (failedNoRetry.length > 0) {
      for (const id of failedNoRetry) {
        markFailed(state, id, report.error ?? 'Sync attempt failed')
        result.failed += 1
      }
    }

    if (retryIds.length === 0) {
      continue
    }

    const firstRetry = state.syncQueue.find((item) => item.id === retryIds[0])
    const delay = backoffDelayMs(firstRetry?.attempts ?? 1, baseDelayMs, maxDelayMs)
    await sleep(delay, options.signal)

    if (options.signal?.aborted) {
      result.stopped = true
      break
    }
  }

  if (options.signal?.aborted) {
    result.stopped = true
  }

  return result
}

/**
 * Resolves a conflicted queue item. `strategy = 'local'` re-queues the local
 * payload for another push; `strategy = 'remote'` accepts the server copy and
 * marks the item synced; `strategy = 'drop'` discards it after an explicit
 * owner decision (never called automatically).
 */
export function resolveConflict(
  state: AppState,
  id: string,
  strategy: 'local' | 'remote' | 'drop',
): void {
  const item = state.syncQueue.find((entry) => entry.id === id)
  if (!item || item.status !== 'conflict') {
    return
  }

  if (strategy === 'local') {
    item.status = 'pending'
    item.conflict = undefined
    return
  }

  if (strategy === 'remote') {
    item.status = 'synced'
    item.conflict = undefined
    return
  }

  markFailed(state, id, 'Discarded by owner decision')
}
