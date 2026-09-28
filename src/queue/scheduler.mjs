import { getPricingSnapshot } from '../pricing/engine.mjs'
import { shouldAttemptDelivery } from './eligibility.mjs'

export class DeliveryUnavailableError extends Error {
  constructor(message = 'delivery adapter is disabled in this phase') {
    super(message)
    this.name = 'DeliveryUnavailableError'
    this.code = 'delivery-disabled'
    this.retryable = false
  }
}

export const createDisabledDeliveryAdapter = () => ({ enabled: false, deliver: async () => { throw new DeliveryUnavailableError() } })

export function createQueueScheduler({
  queueService,
  pricingService,
  getHolidayCalendars = () => [],
  deliveryAdapter = createDisabledDeliveryAdapter(),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryBaseMs = 300000,
  retryMaxMs = 7200000,
  maxAttempts = 8,
  safetyTickMs = 86400000,
  logger = () => {},
  onChange = () => {},
} = {}) {
  if (!queueService || typeof queueService.snapshot !== 'function' || typeof queueService.beginDelivery !== 'function') throw new TypeError('queueService is required')
  if (!pricingService || typeof pricingService.getSnapshot !== 'function') throw new TypeError('pricingService is required')
  if (!deliveryAdapter || typeof deliveryAdapter.deliver !== 'function') throw new TypeError('deliveryAdapter.deliver is required')
  let started = false
  let timer = null
  let tickInFlight = null
  let unsubscribe = null
  let lastDeliveryError = null

  const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null }
  const deliveryEnabled = deliveryAdapter.enabled !== false
  const readEngineSnapshot = (at) => {
    const live = pricingService.getSnapshot()
    return { live, engine: getPricingSnapshot(at, live.policy, null, live, { holidayCalendars: getHolidayCalendars() }) }
  }

  async function scheduleNext() {
    clearScheduled()
    if (!started || !deliveryEnabled) return
    const state = await queueService.snapshot()
    if (!started || !deliveryEnabled) return
    const waiting = state.items.filter((item) => item.status === 'queued')
    if (!waiting.length) return
    const at = now()
    const { engine } = readEngineSnapshot(at)
    if (!engine.canAutoSchedule) return
    let dueAt = Number.POSITIVE_INFINITY
    for (const item of waiting) {
      const phaseAt = engine.phase === item.targetPolicy ? at : engine.nextPhase === item.targetPolicy ? engine.transitionAtUtcMs : engine.transitionAtUtcMs
      dueAt = Math.min(dueAt, Math.max(phaseAt, item.retryAtUtc ?? at))
    }
    if (!Number.isFinite(dueAt)) return
    const delay = Math.min(Math.max(0, dueAt - now()), safetyTickMs)
    if (!started || !deliveryEnabled) return
    timer = setTimer(() => { timer = null; void tick() }, delay)
    timer?.unref?.()
  }

  async function tick() {
    if (!started || !deliveryEnabled) return
    if (tickInFlight) return tickInFlight
    tickInFlight = (async () => {
      const state = await queueService.snapshot()
      for (const item of state.items) {
        if (!started) break
        const at = now()
        const { live, engine } = readEngineSnapshot(at)
        if (!shouldAttemptDelivery(item, at, engine, live.policy)) continue
        const delivering = await queueService.beginDelivery(item.id, { policy: live.policy, pricingSnapshot: engine })
        if (!delivering) continue
        const deliveryAt = now()
        const latest = readEngineSnapshot(deliveryAt)
        if (!shouldAttemptDelivery({ ...delivering, status: 'queued', lease: null }, deliveryAt, latest.engine, latest.live.policy)) {
          await queueService.retry(item.id, 'pricing-state-changed-before-delivery', deliveryAt)
          continue
        }
        try {
          await deliveryAdapter.deliver(structuredClone(delivering))
          await queueService.markSubmitted(item.id)
          lastDeliveryError = null
          logger({ event: 'queue-delivery-submitted', itemId: item.id, policyId: live.policy.policyId })
          await onChange()
        } catch (error) {
          lastDeliveryError = { code: error?.code ?? 'delivery-failed', category: error?.category ?? (error?.retryable === false ? 'permanent' : 'unknown'), atUtc: now() }
          if (error?.retryable === false || (item.attemptCount + 1) >= maxAttempts) {
            await queueService.block(item.id, error?.code ?? 'delivery-failed')
            logger({ event: 'queue-delivery-blocked', itemId: item.id, code: error?.code ?? 'delivery-failed' })
            await onChange()
          } else {
            const exponent = Math.max(0, item.attemptCount)
            const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** exponent))
            await queueService.retry(item.id, error?.code ?? 'delivery-failed', now() + delay)
            logger({ event: 'queue-delivery-retry', itemId: item.id, code: error?.code ?? 'delivery-failed', retryAtUtcMs: now() + delay })
            await onChange()
          }
        }
      }
    })().finally(async () => {
      tickInFlight = null
      await scheduleNext()
    })
    return tickInFlight
  }

  return {
    async start() {
      if (started) return
      started = true
      if (!deliveryEnabled) return
      unsubscribe = pricingService.subscribe?.(() => { void tick() }) ?? null
      await tick()
    },
    async stop() {
      started = false
      clearScheduled()
      unsubscribe?.()
      unsubscribe = null
      await tickInFlight?.catch(() => {})
    },
    tick,
    get inFlight() { return tickInFlight !== null },
    get lastDeliveryError() { return lastDeliveryError ? structuredClone(lastDeliveryError) : null },
  }
}
