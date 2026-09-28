import { validateQueueItem } from './state-machine.mjs'

export function shouldAttemptDelivery(itemLike, instantMs, pricingSnapshot, policy) {
  const item = validateQueueItem(itemLike)
  if (item.status !== 'queued') return false
  if (item.retryAtUtc != null && instantMs < item.retryAtUtc) return false
  if (!pricingSnapshot || pricingSnapshot.canAutoSchedule !== true) return false
  if (!['verified', 'stale-verified'].includes(pricingSnapshot.trustStatus)) return false
  if (pricingSnapshot.policyId !== policy.policyId) return false
  // The snapshot is created by PricingEngine with its holiday calendars. Queue
  // delivery consumes that one decision instead of recomputing phase rules.
  return pricingSnapshot.phase === item.targetPolicy
}
