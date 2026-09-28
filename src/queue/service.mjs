import { randomUUID } from 'node:crypto'
import { emptyQueueState, queueCounts, recoverQueueState, transitionQueueItem, validateQueueItem, validateQueueState } from './state-machine.mjs'
import { shouldAttemptDelivery } from './eligibility.mjs'

export class QueueLimitError extends Error { constructor(message = 'queue capacity reached') { super(message); this.name = 'QueueLimitError'; this.code = 'queue-limit' } }

export function createQueueService({ store, settings, now = () => Date.now(), id = randomUUID, requestId = randomUUID, logger = () => {} } = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new TypeError('queue store is required')
  const maxItems = settings?.queueMaxItems ?? 100
  let state = null
  let serial = Promise.resolve()
  const transact = (fn) => {
    const result = serial.then(async () => {
      if (!state) await load()
      const next = await fn(state)
      state = validateQueueState(next)
      state.updatedAtUtc = now()
      await store.save(state)
      return structuredClone(state)
    })
    serial = result.catch(() => {})
    return result
  }
  async function load() {
    if (state) return structuredClone(state)
    const saved = await store.load()
    state = saved ? validateQueueState(saved) : emptyQueueState(now())
    return structuredClone(state)
  }
  const replaceItem = (items, item) => items.map((candidate) => candidate.id === item.id ? item : candidate)

  return {
    async start() {
      const current = await load()
      const recovered = recoverQueueState(current, {
        now: now(), leaseMs: settings?.deliveryLeaseMs,
        submittedRetentionMs: settings?.submittedRetentionMs,
        cancelledRetentionMs: settings?.cancelledRetentionMs,
      })
      if (JSON.stringify(recovered) !== JSON.stringify(current)) {
        for (const item of current.items) {
          const next = recovered.items.find((candidate) => candidate.id === item.id)
          if (item.status === 'delivering' && next?.status === 'queued') logger({ event: 'queue-transition', itemId: item.id, from: 'delivering', to: 'queued', attemptCount: item.attemptCount, code: 'recovered-after-restart' })
        }
        state = recovered
        await store.save(state)
      }
      return structuredClone(state)
    },
    async snapshot() { return structuredClone(await load()) },
    async counts() { return queueCounts(await load()) },
    async enqueue({ text, sessionId, policyId = null }) {
      if (typeof text !== 'string' || text.trim() === '') throw new TypeError('message text is required')
      if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('sessionId is required')
      return transact((current) => {
        if (current.items.filter((item) => !['submitted', 'cancelled'].includes(item.status)).length >= maxItems) throw new QueueLimitError()
        const timestamp = now()
        const item = validateQueueItem({
          id: id(), deliveryRequestId: requestId(), text: text.trim(), sessionId, createdAtUtc: timestamp, targetPolicy: 'OFF-PEAK',
          status: 'queued', attemptCount: 0, retryAtUtc: null, lastError: null,
          policyIdAtEnqueue: policyId, lease: null, submittedAtUtc: null, blockedReason: null, updatedAtUtc: timestamp,
        })
        logger({ event: 'queue-transition', itemId: item.id, from: 'draft', to: 'queued' })
        return { ...current, items: [...current.items, item] }
      }).then((next) => next.items.at(-1))
    },
    async transition(itemId, nextStatus, options = {}) {
      return transact((current) => {
        const item = current.items.find((candidate) => candidate.id === itemId)
        if (!item) throw new Error(`queue item not found: ${itemId}`)
        const next = transitionQueueItem(item, nextStatus, { now: now(), ...options })
        logger({ event: 'queue-transition', itemId, from: item.status, to: nextStatus, attemptCount: next.attemptCount })
        return { ...current, items: replaceItem(current.items, next) }
      }).then((next) => next.items.find((item) => item.id === itemId))
    },
    async beginDelivery(itemId, { policy, pricingSnapshot, leaseMs = settings?.deliveryLeaseMs ?? 120000 } = {}) {
      const snapshot = await this.snapshot()
      const item = snapshot.items.find((candidate) => candidate.id === itemId)
      if (!item || !shouldAttemptDelivery(item, now(), pricingSnapshot, policy)) return null
      return this.transition(itemId, 'delivering', { lease: { token: id(), expiresAtUtc: now() + leaseMs } })
    },
    async markSubmitted(itemId) { return this.transition(itemId, 'submitted') },
    async retry(itemId, error, retryAtUtc) { return this.transition(itemId, 'queued', { error: String(error), retryAtUtc }) },
    async block(itemId, reason) { return this.transition(itemId, 'blocked', { error: String(reason), blockedReason: String(reason) }) },
    async cancel(itemId) { return this.transition(itemId, 'cancelled') },
  }
}
