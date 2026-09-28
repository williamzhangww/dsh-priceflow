import { validatePolicy } from './policy-schema.mjs'
import { findHolidayCalendar, loadCalendarSet } from './holiday-calendar.mjs'

export const TRUST_STATUSES = Object.freeze(['verified', 'stale-verified', 'bundled-fixture'])
export const PHASES = Object.freeze(['PEAK', 'OFF-PEAK'])

function validateInstant(instantMs) {
  if (!Number.isFinite(instantMs)) throw new TypeError('instantMs must be a finite epoch millisecond value')
}

function isoWeekdayFromUtcDate(date) {
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

function phaseForDayMinute(weekday, minute, schedule) {
  if (!schedule.weekdays.includes(weekday)) return 'OFF-PEAK'
  return schedule.peakWindows.some((w) => minute >= w.startMinute && minute < w.endMinute) ? 'PEAK' : 'OFF-PEAK'
}

function scheduleParts(instantMs, timeBasis) {
  if (timeBasis === 'UTC') {
    const date = new Date(instantMs)
    return { weekday: isoWeekdayFromUtcDate(date), minute: date.getUTCHours() * 60 + date.getUTCMinutes() }
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeBasis,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instantMs)
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[values.weekday]
  if (!weekday) throw new Error(`cannot resolve weekday for ${timeBasis}`)
  return { weekday, minute: Number(values.hour) * 60 + Number(values.minute) }
}

function basePhaseForPolicy(instantMs, policy) {
  const parts = scheduleParts(instantMs, policy.schedule.timeBasis)
  return phaseForDayMinute(parts.weekday, parts.minute, policy.schedule)
}

function calendarState(instantMs, policy, calendars) {
  const exclusions = policy.schedule.exclusions ?? []
  if (!exclusions.length) return { covered: true, status: 'not-required', coverage: [] }
  const states = exclusions.map((exclusion) => ({ exclusion, ...findHolidayCalendar(calendars, exclusion, instantMs) }))
  const covered = states.every((state) => state.covered)
  const status = !covered ? 'unavailable' : states.some((state) => state.trustStatus === 'official-bundled') ? 'official-bundled' : states.some((state) => state.trustStatus === 'stale-verified') ? 'stale-verified' : 'verified'
  return { covered, status, coverage: states.map(({ exclusion, date, year, covered: hasCoverage, trustStatus }) => ({ calendarId: exclusion.calendarId, jurisdiction: exclusion.jurisdiction, date, year, covered: hasCoverage, trustStatus })) }
}

function getPhaseForPolicy(instantMs, policy, calendars = []) {
  const phase = basePhaseForPolicy(instantMs, policy)
  if (phase !== 'PEAK') return phase
  for (const exclusion of policy.schedule.exclusions ?? []) {
    const state = findHolidayCalendar(calendars, exclusion, instantMs)
    if (state.covered && state.isHoliday) return 'OFF-PEAK'
  }
  return phase
}

export function getPhaseAt(instantMs, policyLike, options = {}) {
  validateInstant(instantMs)
  return getPhaseForPolicy(instantMs, validatePolicy(policyLike), loadCalendarSet(options.holidayCalendars ?? []))
}

function nextLocalDateBoundary(instantMs, timeZone) {
  const dateAt = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  let left = instantMs
  const initial = dateAt(left)
  const stepMs = 6 * 60 * 60 * 1000
  const end = instantMs + 3 * 86400000
  while (left < end) {
    const right = Math.min(left + stepMs, end)
    if (dateAt(right) !== initial) {
      let low = Math.floor(left / 60000) * 60000
      let high = Math.ceil(right / 60000) * 60000
      while (high - low > 60000) {
        const mid = Math.floor((low + high) / 120000) * 60000
        if (dateAt(mid) === initial) low = mid
        else high = mid
      }
      return high
    }
    left = right
  }
  return null
}

function nextTransitionForPolicy(instantMs, policy, calendars = []) {
  const current = getPhaseForPolicy(instantMs, policy, calendars)
  if (policy.schedule.timeBasis === 'UTC') {
    const date = new Date(instantMs)
    const firstMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    const boundaries = new Set([0, 1440])
    for (const window of policy.schedule.peakWindows) {
      boundaries.add(window.startMinute)
      boundaries.add(window.endMinute)
    }
    const sorted = [...boundaries].sort((a, b) => a - b)
    const candidates = new Set()
    for (let dayOffset = 0; dayOffset <= 15; dayOffset++) {
      const dayStart = firstMidnight + dayOffset * 86400000
      for (const minute of sorted) {
        const at = dayStart + minute * 60000
        if (at > instantMs) candidates.add(at)
      }
    }
    for (const exclusion of policy.schedule.exclusions ?? []) {
      let cursor = instantMs
      for (let i = 0; i < 18; i++) {
        const boundary = nextLocalDateBoundary(cursor, exclusion.calendarTimeZone)
        if (boundary == null) break
        candidates.add(boundary)
        cursor = boundary + 60000
      }
    }
    for (const at of [...candidates].sort((a, b) => a - b)) {
      const nextPhase = getPhaseForPolicy(at, policy, calendars)
      if (nextPhase !== current) return { atUtcMs: at, nextPhase }
    }
    throw new Error('unable to find the next pricing transition within sixteen days')
  }
  // Policies have minute-granular boundaries. Scan absolute instants, then
  // resolve their schedule zone with Intl so DST folds/gaps remain well-defined.
  let at = Math.floor(instantMs / 60000) * 60000 + 60000
  const horizon = at + 16 * 86400000
  while (at <= horizon) {
    const next = getPhaseForPolicy(at, policy, calendars)
    if (next !== current) return { atUtcMs: at, nextPhase: next }
    at += 60000
  }
  throw new Error('unable to find the next pricing transition within sixteen days')
}

export function getNextTransition(instantMs, policyLike, options = {}) {
  validateInstant(instantMs)
  const policy = validatePolicy(policyLike)
  return nextTransitionForPolicy(instantMs, policy, loadCalendarSet(options.holidayCalendars ?? []))
}

function normalizeOperationalStatus(status) {
  const trustStatus = typeof status === 'string' ? status : status?.trustStatus
  if (!TRUST_STATUSES.includes(trustStatus)) throw new TypeError(`invalid trustStatus: ${String(trustStatus)}`)
  const canAutoSchedule = trustStatus !== 'bundled-fixture' && (typeof status === 'object' ? status.canAutoSchedule !== false : true)
  return { trustStatus, canAutoSchedule }
}

export function getPricingSnapshot(instantMs, policyLike, modelId = null, operationalStatus = 'verified', options = {}) {
  validateInstant(instantMs)
  const policy = validatePolicy(policyLike)
  const calendars = loadCalendarSet(options.holidayCalendars ?? [])
  const phase = getPhaseForPolicy(instantMs, policy, calendars)
  const next = nextTransitionForPolicy(instantMs, policy, calendars)
  const ops = normalizeOperationalStatus(operationalStatus)
  const nowCalendar = calendarState(instantMs, policy, calendars)
  const nextCalendar = calendarState(next.atUtcMs, policy, calendars)
  const scheduleVerified = nowCalendar.covered && nextCalendar.covered
  const canAutoSchedule = ops.canAutoSchedule && scheduleVerified
  const known = typeof modelId === 'string' && Object.hasOwn(policy.models, modelId)
  return {
    phase,
    nextPhase: next.nextPhase,
    transitionAtUtcMs: next.atUtcMs,
    remainingMs: Math.max(0, next.atUtcMs - instantMs),
    modelId: typeof modelId === 'string' ? modelId : null,
    prices: known ? { ...policy.models[modelId][phase === 'PEAK' ? 'peak' : 'offpeak'] } : null,
    currency: known ? policy.currency : null,
    unit: known ? policy.unit : null,
    policyId: policy.policyId,
    trustStatus: ops.trustStatus,
    canAutoSchedule,
    scheduleVerified,
    calendarStatus: nowCalendar.status,
    holidayCoverage: nowCalendar.coverage,
  }
}

export function isTargetSatisfied(targetPolicy, instantMs, policyLike, options = {}) {
  validateInstant(instantMs)
  if (targetPolicy !== 'OFF-PEAK' && targetPolicy !== 'PEAK') throw new TypeError(`unsupported targetPolicy: ${String(targetPolicy)}`)
  const policy = validatePolicy(policyLike)
  const calendars = loadCalendarSet(options.holidayCalendars ?? [])
  return calendarState(instantMs, policy, calendars).covered && getPhaseForPolicy(instantMs, policy, calendars) === targetPolicy
}
