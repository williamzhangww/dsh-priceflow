import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOfficialPricingFetcher } from '../pricing/fetcher.mjs'
import { getPricingSnapshot } from '../pricing/engine.mjs'
import { loadCalendarSet } from '../pricing/holiday-calendar.mjs'
import { createPricingRefreshService } from '../pricing/refresh-service.mjs'
import { createQueueScheduler, createDisabledDeliveryAdapter } from '../queue/scheduler.mjs'
import { DeliveryError } from '../delivery/dsh-delivery-adapter.mjs'
import { createQueueService } from '../queue/service.mjs'
import { queueCounts } from '../queue/state-machine.mjs'
import { createPriceFlowStores } from '../storage/index.mjs'
import { validateSettings } from '../storage/settings-store.mjs'
import { createOfficialCnyPricingFetcher, createCnyPriceBookService } from '../pricing/cny-refresh-service.mjs'
import { createDeepSeekBalanceFetcher, createBalanceMemoryService } from '../pricing/balance-fetcher.mjs'

export const PRICEFLOW_HOST_VERSION = '0.2.0'
export const DEFAULT_STORAGE_DIRECTORY = 'priceflow'
export const OFFICIAL_HOLIDAY_FIXTURE = new URL('../pricing/fixtures/cn-public-holidays-2026.json', import.meta.url)
export const OFFICIAL_PRICING_FIXTURE = new URL('../pricing/fixtures/official-current.json', import.meta.url)

export function resolvePriceFlowStorageRoot({ storageRoot, env = process.env, home = homedir() } = {}) {
  if (typeof storageRoot === 'string' && storageRoot.trim()) return storageRoot
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME : join(home, '.dsh')
  return join(dshHome, DEFAULT_STORAGE_DIRECTORY)
}

async function readJson(url) { return JSON.parse(await readFile(url, 'utf8')) }
function copy(value) { return value == null ? value : structuredClone(value) }

export function createPriceFlowHostService({
  storageRoot,
  env = process.env,
  home = homedir(),
  fetchImpl = globalThis.fetch,
  deliveryAdapter = createDisabledDeliveryAdapter(),
  holidayCalendars: injectedCalendars,
  holidayCalendarProvider,
  modelIdProvider = () => null,
  credentials,
  getCredentials,
  resolveApiKey,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger: externalLogger = () => {},
} = {}) {
  const root = resolvePriceFlowStorageRoot({ storageRoot, env, home })
  const stores = createPriceFlowStores(root)
  const pricingFixtureUrl = new URL(OFFICIAL_PRICING_FIXTURE)
  const holidayFixtureUrl = new URL(OFFICIAL_HOLIDAY_FIXTURE)
  let pricingFixture = JSON.parse(readFileSync(OFFICIAL_PRICING_FIXTURE, 'utf8'))
  let settings = null
  let calendars = []
  let refreshService = null
  let cnyBookService = null
  let cnyStartPromise = null
  const balanceService = createBalanceMemoryService({ fetcher: createDeepSeekBalanceFetcher({ fetchImpl, resolveCredential: async () => {
    if (typeof resolveApiKey === 'function') return resolveApiKey()
    const credentialService = getCredentials?.() ?? credentials
    if (credentialService && typeof credentialService.resolve === 'function') return credentialService.resolve('DEEPSEEK_API_KEY')
    return typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY : undefined
  } }), now })
  let queueService = null
  let queueScheduler = null
  let startPromise = null
  let stopRequested = false
  let stopped = false
  let state = 'stopped'
  let startedAt = null
  let connectionAdmissionAvailable = false
  const listeners = new Set()
  const pendingLogWrites = new Set()

  const log = (event) => {
    try { externalLogger(copy(event)) } catch { /* host logger must not affect service work */ }
    const write = stores.logger.write(event).catch(() => {})
    pendingLogWrites.add(write)
    void write.finally(() => pendingLogWrites.delete(write))
  }
  const emit = async () => {
    let snapshot
    try { snapshot = await getState() } catch { return }
    for (const listener of [...listeners]) { try { listener(copy(snapshot)) } catch { /* isolate subscribers */ } }
  }

  function pricingOperational() {
    return refreshService?.getSnapshot() ?? {
      policy: pricingFixture,
      trustStatus: 'bundled-fixture',
      canAutoSchedule: false,
      lastAttemptAt: null,
      lastSuccessfulFetchAt: null,
      lastError: null,
      nextScheduledRefreshAt: null,
      livePricingValidation: 'not-run',
      lastFetchMetadata: null,
    }
  }

  function engineSnapshot(at = now()) {
    const live = pricingOperational()
    return getPricingSnapshot(at, live.policy, modelIdProvider() ?? null, live, { holidayCalendars: calendars })
  }

  async function getState() {
    const live = pricingOperational()
    const pricing = engineSnapshot()
    const rawCounts = queueService ? queueCounts(await queueService.snapshot()) : { queued: 0, delivering: 0, blocked: 0 }
    const counts = {
      waiting: rawCounts.queued,
      queued: rawCounts.queued,
      delivering: rawCounts.delivering,
      submitted: rawCounts.submitted,
      blocked: rawCounts.blocked,
      cancelled: rawCounts.cancelled,
    }
    const exclusion = live.policy?.schedule?.exclusions?.[0] ?? null
    const coverage = pricing.holidayCoverage ?? []
    const firstCoverage = coverage[0] ?? null
    return {
      protocolVersion: 1,
      service: { status: state, startedAt, version: PRICEFLOW_HOST_VERSION },
      pricing: {
        phase: pricing.phase,
        nextPhase: pricing.nextPhase,
        transitionAtUtcMs: pricing.transitionAtUtcMs,
        remainingMs: pricing.remainingMs,
        policyId: pricing.policyId,
        trustStatus: pricing.trustStatus,
        canAutoSchedule: pricing.canAutoSchedule,
        scheduleVerified: pricing.scheduleVerified,
        sourceUrl: live.policy?.source?.url ?? null,
      },
      modelPricing: {
        modelId: pricing.modelId,
        prices: pricing.prices,
        currency: pricing.currency,
        unit: pricing.unit,
      },
      priceBooks: {
        USD: { trustStatus: live.trustStatus, source: live.policy?.source ?? null, currency: 'USD', unit: 'per_1m_tokens', models: live.policy?.currency === 'USD' ? copy(live.policy.models) : null },
        CNY: cnyBookService?.getSnapshot() ?? { trustStatus: 'unavailable', compatible: false, models: null, source: null, lastSuccessfulFetchAt: null, lastErrorCode: null },
      },
      balance: balanceService.getSnapshot(),
      calendar: {
        jurisdiction: exclusion?.jurisdiction ?? null,
        year: firstCoverage?.year ?? null,
        coverage,
        trust: firstCoverage?.trustStatus ?? (exclusion ? 'unavailable' : 'not-required'),
        status: pricing.calendarStatus,
      },
      sync: {
        lastAttemptAt: live.lastAttemptAt ?? null,
        lastSuccessfulFetchAt: live.lastSuccessfulFetchAt ?? null,
        nextScheduledRefreshAt: live.nextScheduledRefreshAt ?? null,
        lastError: copy(live.lastError),
        stale: live.trustStatus === 'stale-verified' || live.trustStatus === 'bundled-fixture',
        livePricingValidation: live.livePricingValidation ?? 'not-run',
        fetch: publicFetchMetadata(live.lastFetchMetadata),
      },
      queue: counts,
      delivery: {
        adapterStatus: deliveryAdapter.enabled === false ? 'unavailable' : 'ready',
        hostApiSupported: deliveryAdapter.supported === true,
        backend: deliveryAdapter.backend ?? null,
        lastDeliveryError: copy(queueScheduler?.lastDeliveryError),
      },
      security: {
        connectionAdmissionAvailable,
        mutationActionsEnabled: connectionAdmissionAvailable,
      },
    }
  }

  function publicFetchMetadata(metadata) {
    if (!metadata) return null
    const allowed = ['requestedUrl', 'finalUrl', 'status', 'contentType', 'etag', 'lastModified', 'fetchedAt', 'responseBytes', 'contentHash', 'parserResult', 'policyId']
    return Object.fromEntries(allowed.filter((key) => metadata[key] != null).map((key) => [key, metadata[key]]))
  }

  async function requireStartedQueue() {
    if (!queueService || !['starting', 'running'].includes(state)) throw Object.assign(new Error('PriceFlow service is not ready'), { code: 'service-not-ready' })
    return queueService
  }

  async function start() {
    if (stopped) throw Object.assign(new Error('PriceFlow service has been stopped'), { code: 'service-stopped' })
    if (startPromise) return startPromise
    state = 'starting'
    startPromise = (async () => {
      settings = validateSettings(await stores.settings.load())
      pricingFixture = await readJson(pricingFixtureUrl)
      const bundledCalendars = injectedCalendars ?? (holidayCalendarProvider ? await holidayCalendarProvider() : [await readJson(holidayFixtureUrl)])
      calendars = loadCalendarSet(bundledCalendars)
      queueService = createQueueService({
        store: stores.queue,
        settings,
        now,
        logger: log,
      })
      await queueService.start()
      refreshService = createPricingRefreshService({
        fetcher: createOfficialPricingFetcher({ fetchImpl, now, timeoutMs: settings.requestTimeoutMs }),
        policyStore: stores.policy,
        bundledFixture: pricingFixture,
        now,
        setTimer,
        clearTimer,
        refreshIntervalMs: settings.refreshIntervalMs,
        retryDelaysMs: [settings.retryBaseMs, Math.min(1800000, settings.retryMaxMs), settings.retryMaxMs],
        logger: log,
      })
      await refreshService.start()
      cnyBookService = createCnyPriceBookService({
        fetcher: createOfficialCnyPricingFetcher({ fetchImpl, timeoutMs: settings.requestTimeoutMs, now }),
        store: stores.cnyBook,
        getPrimaryPolicy: () => pricingOperational().policy,
        now,
        logger: (event) => log(event),
      })
      cnyStartPromise = cnyBookService.start().catch(() => {})
      if (stopRequested) return
      queueScheduler = createQueueScheduler({
        queueService,
        pricingService: refreshService,
        getHolidayCalendars: () => calendars,
        deliveryAdapter,
        now,
        setTimer,
        clearTimer,
        retryBaseMs: settings.retryBaseMs,
        retryMaxMs: settings.retryMaxMs,
        logger: log,
        onChange: emit,
      })
      await queueScheduler.start()
      if (stopRequested) {
        await queueScheduler.stop()
        refreshService.stop()
        return
      }
      startedAt = now()
      state = 'running'
      log({ event: 'priceflow-host-started', status: state })
      emit()
      return refreshService.getSnapshot()
    })().catch((error) => {
      state = 'error'
      log({ event: 'priceflow-host-start-failed', code: error?.code ?? 'host-start-failed' })
      emit()
      throw error
    })
    return startPromise
  }

  async function stop() {
    if (stopped) return
    stopRequested = true
    state = 'stopping'
    if (startPromise) await startPromise.catch(() => {})
    await queueScheduler?.stop()
    refreshService?.stop()
    await cnyBookService?.stop()
    if (cnyStartPromise) await cnyStartPromise
    queueScheduler = null
    stopped = true
    state = 'stopped'
    log({ event: 'priceflow-host-stopped', status: state })
    await Promise.allSettled([...pendingLogWrites])
    emit()
  }

  async function refreshNow() {
    if (!refreshService) throw Object.assign(new Error('PriceFlow service is not ready'), { code: 'service-not-ready' })
    try {
      const primary = await refreshService.refreshNow()
      void cnyBookService?.refreshNow().catch(() => {})
      return primary
    }
    finally { await queueScheduler?.tick(); emit() }
  }

  async function validateDeliveryTarget(sessionId) {
    if (typeof deliveryAdapter.validateSession !== 'function') throw new DeliveryError('session validation capability unavailable', { code: 'session-validation-unavailable', category: 'plugin', retryable: false })
    return deliveryAdapter.validateSession(sessionId)
  }

  async function submitNow({ sessionId, text }) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 12000) throw Object.assign(new Error('text must be non-empty and at most 12,000 UTF-8 bytes'), { code: 'invalid-text' })
    await validateDeliveryTarget(sessionId)
    const receipt = await deliveryAdapter.deliver({ id: `now-${now()}`, sessionId, text: text.trim(), targetPolicy: 'SEND_NOW' })
    emit()
    return { accepted: true, receipt }
  }

  async function enqueue(input) {
    const queue = await requireStartedQueue()
    if (!input || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 12 * 1024) throw Object.assign(new Error('text must be non-empty and at most 12,288 UTF-8 bytes'), { code: 'invalid-text' })
    await validateDeliveryTarget(input.sessionId)
    const live = pricingOperational()
    const result = await queue.enqueue({ ...input, policyId: live.policy.policyId })
    await queueScheduler?.tick()
    emit()
    return result
  }

  async function submitOffPeakAware({ sessionId, text }) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 12000) throw Object.assign(new Error('text must be non-empty and at most 12,000 UTF-8 bytes'), { code: 'invalid-text' })
    await validateDeliveryTarget(sessionId)
    const pricing = engineSnapshot()
    if (!pricing.canAutoSchedule) throw Object.assign(new Error('official pricing or schedule is not trusted; off-peak delivery cannot be guaranteed'), { code: 'pricing-untrusted' })
    const result = await enqueue({ sessionId, text })
    const latest = (await queueService.snapshot()).items.find((item) => item.id === result.id)
    return { item: latest ?? result, immediate: pricing.phase === 'OFF-PEAK' }
  }

  return {
    storageRoot: root,
    start,
    stop,
    getState,
    getPricingSnapshot: engineSnapshot,
    async refreshNow() { return refreshNow() },
    async refreshBalance() { const result = await balanceService.refresh({ force: true }); await emit(); return result },
    async ensureBalanceFresh() { const result = await balanceService.refresh(); await emit(); return result },
    async submitNow(input) { return submitNow(input) },
    async submitOffPeakAware(input) { return submitOffPeakAware(input) },
    enqueue,
    async cancelQueueItem(id) { const queue = await requireStartedQueue(); const result = await queue.cancel(id); emit(); return result },
    async retryQueueItem(id) { const queue = await requireStartedQueue(); const result = await queue.retry(id, 'owner-retry', now()); await queueScheduler?.tick(); emit(); return result },
    async tick() { await queueScheduler?.tick(); emit() },
    report(event) { log(event) },
    setConnectionAdmissionAvailable(value) { connectionAdmissionAvailable = value === true },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get queueScheduler() { return queueScheduler },
    get refreshService() { return refreshService },
    get queueService() { return queueService },
  }
}
