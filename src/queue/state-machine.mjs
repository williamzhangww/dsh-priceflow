import { randomUUID } from 'node:crypto'

const TERMINAL = new Set(['submitted', 'cancelled'])
export const QUEUE_SCHEMA_VERSION = 2
const STATUSES = new Set(['queued', 'delivering', 'submitted', 'blocked', 'cancelled'])
const ALLOWED = Object.freeze({
  queued: new Set(['delivering', 'blocked', 'cancelled']),
  delivering: new Set(['submitted', 'queued', 'blocked']),
  blocked: new Set(['queued', 'cancelled']),
  submitted: new Set(),
  cancelled: new Set(),
})

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

export function validateQueueItem(item, { allowMissingDeliveryRequestId = false } = {}) {
  if (!isObject(item)) throw new TypeError('queue item must be an object')
  for (const key of ['id', 'text', 'sessionId']) if (typeof item[key] !== 'string' || item[key] === '') throw new TypeError(`queue item ${key} is required`)
  if (!Number.isFinite(item.createdAtUtc) || !Number.isInteger(item.createdAtUtc)) throw new TypeError('createdAtUtc must be epoch milliseconds')
  if (item.targetPolicy !== 'OFF-PEAK') throw new TypeError('targetPolicy must be OFF-PEAK')
  if (!STATUSES.has(item.status)) throw new TypeError('invalid queue status')
  if (!Number.isSafeInteger(item.attemptCount) || item.attemptCount < 0) throw new TypeError('invalid attemptCount')
  if (item.retryAtUtc != null && !Number.isFinite(item.retryAtUtc)) throw new TypeError('invalid retryAtUtc')
  if (typeof item.text !== 'string' || item.text.length > 50000) throw new TypeError('queue text exceeds the 50,000 character limit')
  if (item.policyIdAtEnqueue != null && typeof item.policyIdAtEnqueue !== 'string') throw new TypeError('invalid policyIdAtEnqueue')
  if (item.deliveryRequestId == null) {
    if (!allowMissingDeliveryRequestId) throw new TypeError('deliveryRequestId is required')
  } else if (typeof item.deliveryRequestId !== 'string' || !item.deliveryRequestId || item.deliveryRequestId.length > 128) {
    throw new TypeError('invalid deliveryRequestId')
  }
  if (item.lease != null && (!isObject(item.lease) || !Number.isFinite(item.lease.expiresAtUtc) || typeof item.lease.token !== 'string')) throw new TypeError('invalid delivery lease')
  if (item.status === 'delivering' && item.lease == null) throw new TypeError('delivering queue items require a lease')
  if (item.status === 'queued' && item.lease != null) throw new TypeError('queued items cannot retain a delivery lease')
  return {
    id: item.id,
    text: item.text,
    sessionId: item.sessionId,
    createdAtUtc: item.createdAtUtc,
    targetPolicy: item.targetPolicy,
    status: item.status,
    attemptCount: item.attemptCount,
    retryAtUtc: item.retryAtUtc ?? null,
    lastError: item.lastError ?? null,
    policyIdAtEnqueue: item.policyIdAtEnqueue ?? null,
    ...(item.deliveryRequestId == null ? {} : { deliveryRequestId: item.deliveryRequestId }),
    lease: item.lease ?? null,
    submittedAtUtc: item.submittedAtUtc ?? null,
    blockedReason: item.blockedReason ?? null,
    updatedAtUtc: item.updatedAtUtc ?? item.createdAtUtc,
  }
}

export function validateQueueState(value) {
  if (!isObject(value) || ![1, QUEUE_SCHEMA_VERSION].includes(value.schemaVersion) || !Array.isArray(value.items)) throw new TypeError('invalid queue state')
  const legacy = value.schemaVersion === 1
  const items = value.items.map((item) => validateQueueItem(item, { allowMissingDeliveryRequestId: legacy }))
  const ids = new Set()
  for (const item of items) {
    if (ids.has(item.id)) throw new TypeError(`duplicate queue item id ${item.id}`)
    ids.add(item.id)
  }
  return { schemaVersion: value.schemaVersion, items, updatedAtUtc: Number.isFinite(value.updatedAtUtc) ? value.updatedAtUtc : 0 }
}

export function migrateQueueState(value, requestId = randomUUID) {
  const state = validateQueueState(value)
  if (state.schemaVersion === QUEUE_SCHEMA_VERSION) return state
  return validateQueueState({
    schemaVersion: QUEUE_SCHEMA_VERSION,
    items: state.items.map((item) => ({ ...item, deliveryRequestId: item.deliveryRequestId ?? requestId(item) })),
    updatedAtUtc: state.updatedAtUtc,
  })
}

export function emptyQueueState(now = 0) { return { schemaVersion: QUEUE_SCHEMA_VERSION, items: [], updatedAtUtc: now } }

export function transitionQueueItem(itemLike, nextStatus, { now = Date.now(), error = null, retryAtUtc = null, lease = null, blockedReason = null } = {}) {
  const item = validateQueueItem(itemLike)
  if (!STATUSES.has(nextStatus) || !ALLOWED[item.status].has(nextStatus)) throw new Error(`invalid queue transition ${item.status} -> ${nextStatus}`)
  const next = { ...item, status: nextStatus, updatedAtUtc: now }
  if (nextStatus === 'delivering') {
    next.attemptCount++
    next.retryAtUtc = null
    next.lastError = null
    next.lease = lease
  } else {
    next.lease = null
  }
  if (nextStatus === 'queued') {
    next.retryAtUtc = retryAtUtc
    next.lastError = error
    next.blockedReason = null
  }
  if (nextStatus === 'blocked') {
    next.blockedReason = blockedReason ?? error ?? 'blocked'
    next.lastError = error
  }
  if (nextStatus === 'submitted') {
    next.submittedAtUtc = now
    next.lastError = null
  }
  if (nextStatus === 'cancelled') next.lastError = null
  return validateQueueItem(next)
}

export function recoverQueueState(stateLike, { now = Date.now(), leaseMs = 120000, submittedRetentionMs = 2592000000, cancelledRetentionMs = 604800000, processRestart = true } = {}) {
  const state = validateQueueState(stateLike)
  if (state.schemaVersion !== QUEUE_SCHEMA_VERSION) throw new TypeError('queue state must be migrated before recovery')
  const recovered = []
  for (const item of state.items) {
    if (item.status === 'delivering' && (processRestart || !item.lease || item.lease.expiresAtUtc <= now)) {
      recovered.push(transitionQueueItem(item, 'queued', { now, error: 'recovered-after-restart', retryAtUtc: now + Math.min(leaseMs, 5000) }))
    } else if (item.status === 'submitted' && item.submittedAtUtc != null && now - item.submittedAtUtc > submittedRetentionMs) {
      continue
    } else if (item.status === 'cancelled' && now - item.updatedAtUtc > cancelledRetentionMs) {
      continue
    } else recovered.push(item)
  }
  return { schemaVersion: QUEUE_SCHEMA_VERSION, items: recovered, updatedAtUtc: now }
}

export function queueCounts(stateLike) {
  const state = validateQueueState(stateLike)
  return state.items.reduce((counts, item) => { counts[item.status]++; return counts }, { queued: 0, delivering: 0, submitted: 0, blocked: 0, cancelled: 0 })
}

export function isTerminalQueueStatus(status) { return TERMINAL.has(status) }
