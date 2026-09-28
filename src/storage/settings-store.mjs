import { createAtomicJsonStore } from './atomic-json.mjs'

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  requestTimeoutMs: 12000,
  queueMaxItems: 100,
  retryBaseMs: 300000,
  retryMaxMs: 7200000,
  refreshIntervalMs: 86400000,
  deliveryLeaseMs: 120000,
  submittedRetentionMs: 2592000000,
  cancelledRetentionMs: 604800000,
})

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new TypeError('invalid settings schema')
  const out = { ...DEFAULT_SETTINGS, ...value }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'schemaVersion') continue
    if (!Number.isSafeInteger(out[key]) || out[key] <= 0) throw new TypeError(`invalid setting ${key}`)
  }
  if (out.retryMaxMs < out.retryBaseMs || out.queueMaxItems > 10000) throw new TypeError('settings values out of bounds')
  return out
}

export function createSettingsStore(root) {
  const file = `${root.replace(/[\\/]$/, '')}/settings.json`
  const store = createAtomicJsonStore(file, { validate: validateSettings })
  return {
    path: file,
    async load() { return (await store.read()) ?? validateSettings(DEFAULT_SETTINGS) },
    async save(settings) { return store.write(validateSettings(settings)) },
  }
}
