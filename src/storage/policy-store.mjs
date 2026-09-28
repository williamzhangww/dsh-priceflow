import { createAtomicJsonStore } from './atomic-json.mjs'
import { validatePolicy } from '../pricing/policy-schema.mjs'

export const POLICY_CACHE_SCHEMA_VERSION = 1
const STATUSES = new Set(['verified', 'stale-verified', 'bundled-fixture'])

export function validatePolicyCache(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== POLICY_CACHE_SCHEMA_VERSION) throw new TypeError('invalid policy cache schema')
  const lastKnownGood = value.lastKnownGood == null ? null : validatePolicy(value.lastKnownGood)
  const operational = value.operational
  if (!operational || typeof operational !== 'object' || !STATUSES.has(operational.trustStatus)) throw new TypeError('invalid policy operational state')
  if (operational.trustStatus === 'verified' || operational.trustStatus === 'stale-verified') {
    if (!lastKnownGood) throw new TypeError(`${operational.trustStatus} requires a lastKnownGood policy`)
  }
  if (operational.lastSuccessfulFetchAt != null && !Number.isFinite(operational.lastSuccessfulFetchAt)) throw new TypeError('invalid lastSuccessfulFetchAt')
  return {
    schemaVersion: POLICY_CACHE_SCHEMA_VERSION,
    lastKnownGood,
    operational: {
      trustStatus: operational.trustStatus,
      lastSuccessfulFetchAt: operational.lastSuccessfulFetchAt ?? null,
      lastAttemptAt: operational.lastAttemptAt ?? null,
      lastError: operational.lastError ?? null,
      retryState: operational.retryState ?? { failureCount: 0, retryAtUtcMs: null },
      semanticDiff: operational.semanticDiff ?? null,
      lastFetchMetadata: operational.lastFetchMetadata ?? null,
      livePricingValidation: ['passed', 'failed', 'not-run'].includes(operational.livePricingValidation) ? operational.livePricingValidation : 'not-run',
    },
  }
}

export function createPolicyStore(root) {
  const file = `${root.replace(/[\\/]$/, '')}/policy-cache.json`
  const store = createAtomicJsonStore(file, { validate: validatePolicyCache })
  return {
    path: file,
    async load() { return await store.read() },
    async save(cache) { return store.write(validatePolicyCache(cache)) },
    async update(mutator) {
      return store.update((current) => validatePolicyCache(mutator(current)))
    },
  }
}
