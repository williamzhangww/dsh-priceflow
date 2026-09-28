import { createAtomicJsonStore } from './atomic-json.mjs'
import { validateCnyPriceBook } from '../pricing/cny-price-book.mjs'

const TRUST = new Set(['verified', 'stale-verified', 'unavailable'])

export function validateCnyBookCache(value) {
  if (!value || value.schemaVersion !== 1) throw new TypeError('invalid CNY book cache schema')
  const lastKnownGood = value.lastKnownGood == null ? null : validateCnyPriceBook(value.lastKnownGood)
  const op = value.operational
  if (!op || !TRUST.has(op.trustStatus)) throw new TypeError('invalid CNY book operational state')
  if (op.trustStatus === 'verified' && !lastKnownGood) throw new TypeError('verified CNY book requires a lastKnownGood book')
  return {
    schemaVersion: 1,
    lastKnownGood,
    operational: {
      trustStatus: op.trustStatus,
      lastSuccessfulFetchAt: Number.isFinite(op.lastSuccessfulFetchAt) ? op.lastSuccessfulFetchAt : null,
      lastAttemptAt: Number.isFinite(op.lastAttemptAt) ? op.lastAttemptAt : null,
      lastErrorCode: typeof op.lastErrorCode === 'string' ? op.lastErrorCode : null,
      lastFetchMetadata: op.lastFetchMetadata && typeof op.lastFetchMetadata === 'object' ? op.lastFetchMetadata : null,
    },
  }
}

export function createCnyBookStore(root) {
  const store = createAtomicJsonStore(`${root.replace(/[\\/]$/, '')}/cny-price-cache.json`, { validate: validateCnyBookCache })
  return { async load() { return store.read() }, async save(value) { return store.write(validateCnyBookCache(value)) } }
}
