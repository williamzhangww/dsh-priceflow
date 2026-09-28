import { createHash } from 'node:crypto'

export const POLICY_SCHEMA_VERSION = 1
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const PRICE_UNIT = 'per_1m_tokens'
export const TIERS = Object.freeze(['peak', 'offpeak'])
export const PRICE_FIELDS = Object.freeze(['cacheHitInput', 'cacheMissInput', 'output'])
export const HOLIDAY_CALENDAR_ID = 'cn-public-holidays'

export class PolicyValidationError extends Error {
  constructor(message, code = 'invalid-policy') {
    super(message)
    this.name = 'PolicyValidationError'
    this.code = code
  }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const finiteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new PolicyValidationError(`${field} must be a non-empty string`, `missing-${field}`)
  return value.trim()
}

function normalizePolicyData(input) {
  if (!isRecord(input)) throw new PolicyValidationError('policy must be an object')
  if (input.schemaVersion !== POLICY_SCHEMA_VERSION) throw new PolicyValidationError('unsupported policy schemaVersion', 'incompatible-schema')
  if (!isRecord(input.source)) throw new PolicyValidationError('source must be an object', 'missing-source')
  const source = input.source
  const sourceUrl = requiredString(source.url, 'source.url')
  const parsedUrl = new URL(sourceUrl)
  const isDeepSeekHost = (hostname) => hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'api-docs.deepseek.com') {
    throw new PolicyValidationError('policy source must be the official DeepSeek pricing documentation', 'untrusted-source')
  }
  const requestedUrl = source.requestedUrl == null ? sourceUrl : requiredString(source.requestedUrl, 'source.requestedUrl')
  const finalUrl = source.finalUrl == null ? sourceUrl : requiredString(source.finalUrl, 'source.finalUrl')
  for (const [label, value] of [['requestedUrl', requestedUrl], ['finalUrl', finalUrl]]) {
    const u = new URL(value)
    if (u.protocol !== 'https:' || !isDeepSeekHost(u.hostname)) throw new PolicyValidationError(`${label} is not an official HTTPS URL`, 'untrusted-source')
  }
  const fetchedAt = source.fetchedAt == null ? null : requiredString(source.fetchedAt, 'source.fetchedAt')
  if (fetchedAt !== null && !Number.isFinite(Date.parse(fetchedAt))) throw new PolicyValidationError('source.fetchedAt must be an ISO date', 'invalid-fetched-at')
  if (!isRecord(input.schedule)) throw new PolicyValidationError('schedule must be an object', 'missing-schedule')
  const schedule = input.schedule
  const timeBasis = requiredString(schedule.timeBasis, 'schedule.timeBasis')
  if (timeBasis !== 'UTC') {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timeBasis }).format(0) }
    catch { throw new PolicyValidationError(`unsupported schedule timeBasis: ${timeBasis}`, 'unsupported-time-basis') }
  }
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) throw new PolicyValidationError('schedule.weekdays is required', 'missing-weekdays')
  const weekdays = [...new Set(schedule.weekdays)]
  if (weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new PolicyValidationError('weekdays must use ISO values 1..7', 'invalid-weekdays')
  if (weekdays.length !== schedule.weekdays.length) throw new PolicyValidationError('duplicate weekday', 'duplicate-weekday')
  if (!Array.isArray(schedule.peakWindows) || schedule.peakWindows.length === 0) throw new PolicyValidationError('at least one peak window is required', 'missing-windows')
  const peakWindows = schedule.peakWindows.map((w) => {
    if (!isRecord(w) || !Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) ||
        w.startMinute < 0 || w.startMinute >= 1440 || w.endMinute <= 0 || w.endMinute > 1440 || w.startMinute >= w.endMinute) {
      throw new PolicyValidationError('peak window must be a valid non-empty same-day [start,end) range', 'invalid-window')
    }
    return { startMinute: w.startMinute, endMinute: w.endMinute }
  }).sort((a, b) => a.startMinute - b.startMinute)
  for (let i = 1; i < peakWindows.length; i++) {
    if (peakWindows[i].startMinute < peakWindows[i - 1].endMinute) throw new PolicyValidationError('peak windows overlap', 'overlapping-windows')
  }
  const offpeakRelation = schedule.offpeakRelation == null ? null : (() => {
    const r = schedule.offpeakRelation
    if (!isRecord(r) || r.kind !== 'ratio' || !finiteNonNegative(r.offpeakPerPeak) || r.offpeakPerPeak <= 0) {
      throw new PolicyValidationError('offpeakRelation must contain an explicit positive ratio', 'invalid-offpeak-relation')
    }
    return { kind: 'ratio', offpeakPerPeak: r.offpeakPerPeak }
  })()
  const exclusions = schedule.exclusions == null ? [] : (() => {
    if (!Array.isArray(schedule.exclusions)) throw new PolicyValidationError('schedule.exclusions must be an array', 'invalid-exclusions')
    const seen = new Set()
    return schedule.exclusions.map((exclusion) => {
      if (!isRecord(exclusion) || exclusion.kind !== 'public-holiday-calendar') throw new PolicyValidationError('unsupported schedule exclusion', 'invalid-exclusion')
      const jurisdiction = requiredString(exclusion.jurisdiction, 'exclusion.jurisdiction')
      const calendarTimeZone = requiredString(exclusion.calendarTimeZone, 'exclusion.calendarTimeZone')
      const calendarId = requiredString(exclusion.calendarId, 'exclusion.calendarId')
      try { new Intl.DateTimeFormat('en-US', { timeZone: calendarTimeZone }).format(0) }
      catch { throw new PolicyValidationError(`unsupported calendar timezone: ${calendarTimeZone}`, 'unsupported-calendar-timezone') }
      const key = `${exclusion.kind}:${jurisdiction}:${calendarId}`
      if (seen.has(key)) throw new PolicyValidationError('duplicate schedule exclusion', 'duplicate-exclusion')
      seen.add(key)
      return { kind: exclusion.kind, jurisdiction, calendarTimeZone, calendarId }
    }).sort((a, b) => `${a.jurisdiction}:${a.calendarId}`.localeCompare(`${b.jurisdiction}:${b.calendarId}`))
  })()
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new PolicyValidationError('currency must be an explicit ISO-style three-letter code', 'unknown-currency')
  if (input.unit !== PRICE_UNIT) throw new PolicyValidationError(`unsupported price unit: ${String(input.unit)}`, 'unknown-unit')
  if (!isRecord(input.models) || Object.keys(input.models).length === 0) throw new PolicyValidationError('models must be a non-empty object', 'missing-models')
  const models = Object.create(null)
  for (const id of Object.keys(input.models).sort()) {
    if (id.trim() === '' || id !== id.trim()) throw new PolicyValidationError('model ids must be exact non-empty API ids', 'invalid-model-id')
    if (Object.hasOwn(models, id)) throw new PolicyValidationError(`duplicate model id: ${id}`, 'duplicate-model')
    const model = input.models[id]
    if (!isRecord(model)) throw new PolicyValidationError(`model ${id} must be an object`, 'invalid-model')
    const displayName = requiredString(model.displayName, `models.${id}.displayName`)
    const prices = {}
    for (const tier of TIERS) {
      if (!isRecord(model[tier])) throw new PolicyValidationError(`model ${id} missing ${tier} prices`, 'missing-price-tier')
      prices[tier] = {}
      for (const field of PRICE_FIELDS) {
        if (!finiteNonNegative(model[tier][field])) throw new PolicyValidationError(`model ${id} ${tier}.${field} must be finite and non-negative`, 'invalid-price')
        prices[tier][field] = model[tier][field]
      }
    }
    models[id] = { displayName, ...prices }
  }
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    source: {
      url: sourceUrl,
      requestedUrl,
      finalUrl,
      fetchedAt,
      contentHash: source.contentHash == null ? null : requiredString(source.contentHash, 'source.contentHash'),
      parserVersion: Number.isInteger(source.parserVersion) && source.parserVersion > 0 ? source.parserVersion : 1,
      etag: typeof source.etag === 'string' ? source.etag : null,
      lastModified: typeof source.lastModified === 'string' ? source.lastModified : null,
      capturedAt: typeof source.capturedAt === 'string' ? source.capturedAt : null,
      provenance: typeof source.provenance === 'string' ? source.provenance : null,
    },
    currency: input.currency,
    unit: input.unit,
    schedule: { timeBasis, weekdays: weekdays.sort((a, b) => a - b), peakWindows, offpeakRelation, exclusions },
    models,
  }
}

export function canonicalPolicyData(policyLike) {
  const n = normalizePolicyData(policyLike)
  return {
    schemaVersion: n.schemaVersion,
    currency: n.currency,
    unit: n.unit,
    schedule: n.schedule,
    models: n.models,
  }
}

export function computePolicyId(policyLike) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalPolicyData(policyLike))).digest('hex')}`
}

export function validatePolicy(policyLike) {
  const normalized = normalizePolicyData(policyLike)
  const expected = computePolicyId(normalized)
  if (normalized.policyId != null && normalized.policyId !== expected) throw new PolicyValidationError('policyId does not match canonical semantic policy', 'policy-id-mismatch')
  return { ...normalized, policyId: expected }
}

export function createPolicy(data) {
  const normalized = normalizePolicyData(data)
  return { ...normalized, policyId: computePolicyId(normalized) }
}

export function semanticPolicy(policy) {
  return canonicalPolicyData(policy)
}
