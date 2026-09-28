import { diffPolicies } from './diff.mjs'
import { validatePolicy } from './policy-schema.mjs'

export const DEFAULT_REFRESH_INTERVAL_MS = 86400000
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([300000, 1800000, 7200000])

function copy(value) { return value == null ? value : structuredClone(value) }
function nextDueAt(cache, now, interval) {
  if (!cache) return null
  const retryAt = cache.operational.retryState?.retryAtUtcMs
  if (retryAt != null) return retryAt
  const lastSuccess = cache.operational.lastSuccessfulFetchAt
  return lastSuccess == null ? null : lastSuccess + interval
}

export function createPricingRefreshService({
  fetcher,
  policyStore,
  bundledFixture,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  logger = () => {},
} = {}) {
  if (!fetcher || typeof fetcher.refresh !== 'function') throw new TypeError('fetcher.refresh is required')
  if (!policyStore || typeof policyStore.load !== 'function' || typeof policyStore.save !== 'function') throw new TypeError('policyStore is required')
  const fixture = validatePolicy(bundledFixture)
  let cache = null
  let inFlight = null
  let timer = null
  let stopped = true
  let started = false
  let failures = 0
  let listeners = new Set()

  const snapshot = () => {
    const current = cache
    const t = now()
    return current ? {
      policy: copy(current.lastKnownGood) ?? fixture,
      trustStatus: current.operational.trustStatus,
      canAutoSchedule: current.operational.trustStatus !== 'bundled-fixture',
      lastSuccessfulFetchAt: current.operational.lastSuccessfulFetchAt,
      lastAttemptAt: current.operational.lastAttemptAt,
      lastError: copy(current.operational.lastError),
      retryState: copy(current.operational.retryState),
      semanticDiff: copy(current.operational.semanticDiff),
      livePricingValidation: current.operational.livePricingValidation ?? 'not-run',
      lastFetchMetadata: copy(current.operational.lastFetchMetadata),
      nextScheduledRefreshAt: nextDueAt(current, t, refreshIntervalMs),
    } : {
      policy: fixture,
      trustStatus: 'bundled-fixture',
      canAutoSchedule: false,
      lastSuccessfulFetchAt: null,
      lastAttemptAt: null,
      lastError: null,
      retryState: { failureCount: 0, retryAtUtcMs: null },
      semanticDiff: null,
      livePricingValidation: 'not-run',
      lastFetchMetadata: null,
      nextScheduledRefreshAt: null,
    }
  }
  const emit = () => { for (const listener of [...listeners]) listener(snapshot()) }
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null }

  async function load() {
    const stored = await policyStore.load()
    if (stored) {
      cache = stored
      failures = stored.operational.retryState?.failureCount ?? 0
    } else {
      cache = {
        schemaVersion: 1,
        lastKnownGood: null,
        operational: {
          trustStatus: 'bundled-fixture', lastSuccessfulFetchAt: null, lastAttemptAt: null,
          lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: null,
          livePricingValidation: 'not-run',
        },
      }
    }
    return snapshot()
  }

  function writeCache() { return policyStore.save(cache) }

  function scheduleNext() {
    cancelTimer()
    if (stopped) return
    const t = now()
    const lastSuccess = cache.operational.lastSuccessfulFetchAt
    const retryAt = cache.operational.retryState?.retryAtUtcMs
    const refreshAt = lastSuccess == null ? t + refreshIntervalMs : lastSuccess + refreshIntervalMs
    const dueAt = retryAt != null ? retryAt : refreshAt
    timer = setTimer(() => {
      timer = null
      return refreshNow().catch(() => {}).finally(scheduleNext)
    }, Math.max(0, dueAt - t))
    timer?.unref?.()
  }

  async function refreshNow() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const attemptedAt = now()
      cache.operational.lastAttemptAt = attemptedAt
      await writeCache()
      logger({ event: 'pricing-refresh-start' })
      try {
        // Conditional requests may only be based on the response that produced
        // the LKG. A malformed response's ETag must never validate old policy.
        const validators = cache.lastKnownGood?.source ?? {}
        const result = await fetcher.refresh({ etag: validators.etag ?? null, lastModified: validators.lastModified ?? null })
        if (result.notModified) {
          if (!cache.lastKnownGood || cache.operational.trustStatus === 'bundled-fixture') throw Object.assign(new Error('received 304 without a verified cached policy'), { code: 'orphan-304' })
          failures = 0
          cache.operational.trustStatus = 'verified'
          cache.operational.lastSuccessfulFetchAt = now()
          cache.operational.lastError = null
          cache.operational.retryState = { failureCount: 0, retryAtUtcMs: null }
          cache.operational.lastFetchMetadata = result.metadata ?? null
          cache.operational.livePricingValidation = 'passed'
          await writeCache()
          logger({ event: 'pricing-refresh-not-modified', policyIdAtFetch: cache.lastKnownGood.policyId, livePricingValidation: 'passed', ...(result.metadata ?? {}) })
          emit()
          return snapshot()
        }
        const candidate = validatePolicy(result.policy)
        const prior = cache.lastKnownGood
        const diff = diffPolicies(prior, candidate)
        const successfulAt = now()
        cache.lastKnownGood = candidate
        cache.operational.trustStatus = 'verified'
        cache.operational.lastSuccessfulFetchAt = successfulAt
        cache.operational.lastError = null
        cache.operational.retryState = { failureCount: 0, retryAtUtcMs: null }
        cache.operational.semanticDiff = diff
        cache.operational.lastFetchMetadata = result.metadata ?? candidate.source
        cache.operational.livePricingValidation = 'passed'
        failures = 0
        await writeCache()
        logger({ event: 'pricing-refresh-success', policyId: candidate.policyId, policyIdAtFetch: candidate.policyId, livePricingValidation: 'passed', ...(result.metadata ?? {}) })
        emit()
        return snapshot()
      } catch (error) {
        failures++
        const delay = retryDelaysMs[Math.min(failures - 1, retryDelaysMs.length - 1)] ?? refreshIntervalMs
        const hasVerified = cache.lastKnownGood !== null
        cache.operational.trustStatus = hasVerified ? 'stale-verified' : 'bundled-fixture'
        cache.operational.lastError = { atUtcMs: now(), code: error?.code ?? 'refresh-error', message: error instanceof Error ? error.message : String(error) }
        cache.operational.retryState = { failureCount: failures, retryAtUtcMs: now() + delay }
        cache.operational.livePricingValidation = 'failed'
        if (error?.metadata) cache.operational.lastFetchMetadata = error.metadata
        await writeCache()
        logger({ event: 'pricing-refresh-failure', code: cache.operational.lastError.code, trustStatus: cache.operational.trustStatus, retryAtUtcMs: cache.operational.retryState.retryAtUtcMs, livePricingValidation: 'failed', ...(error?.metadata ?? {}) })
        emit()
        throw error
      }
    })().finally(() => {
      inFlight = null
      if (!stopped) scheduleNext()
    })
    return inFlight
  }

  return {
    async start() {
      if (started) return snapshot()
      started = true
      stopped = false
      await load()
      try { await refreshNow() } catch { /* operational fallback is represented in the snapshot */ }
      scheduleNext()
      return snapshot()
    },
    stop() { stopped = true; cancelTimer() },
    async refreshNow() { return refreshNow() },
    getSnapshot: snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
