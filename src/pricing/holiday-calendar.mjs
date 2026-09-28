import { createHash } from 'node:crypto'

export const HOLIDAY_CALENDAR_SCHEMA_VERSION = 1
export const HOLIDAY_TRUST_STATUSES = Object.freeze(['verified', 'stale-verified', 'official-bundled'])

function fail(message) { throw Object.assign(new TypeError(message), { code: 'invalid-holiday-calendar' }) }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validateHolidayCalendar(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== HOLIDAY_CALENDAR_SCHEMA_VERSION) fail('unsupported holiday calendar')
  const { calendarId, jurisdiction, timeZone, year, holidayDateRanges, source, trustStatus } = input
  if (typeof calendarId !== 'string' || !calendarId || jurisdiction !== 'CN' || timeZone !== 'Asia/Shanghai') fail('calendar identity must specify CN and Asia/Shanghai')
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Array.isArray(holidayDateRanges) || holidayDateRanges.length === 0) fail('invalid calendar year or empty ranges')
  if (!source || typeof source !== 'object' || typeof source.url !== 'string' || typeof source.authority !== 'string' || !source.authority.trim()) fail('official source metadata is required')
  const url = new URL(source.url)
  if (url.protocol !== 'https:' || !(url.hostname === 'gov.cn' || url.hostname.endsWith('.gov.cn'))) fail('holiday source must be on gov.cn')
  if (!HOLIDAY_TRUST_STATUSES.includes(trustStatus)) fail('invalid holiday trust status')
  for (const key of ['publishedAt', 'capturedAt', 'fetchedAt']) {
    if (source[key] != null && !Number.isFinite(Date.parse(source[key]))) fail(`source.${key} must be a parseable timestamp`)
  }
  if (trustStatus === 'official-bundled' && (!source.capturedAt || source.fetchedAt != null)) fail('official-bundled calendars need capturedAt and must not claim fetchedAt')
  if (trustStatus !== 'official-bundled' && !source.fetchedAt) fail(`${trustStatus} calendars need fetchedAt`)
  const ranges = holidayDateRanges.map((range) => {
    if (!range || !validDate(range.start) || !validDate(range.end) || range.start > range.end || Number(range.start.slice(0, 4)) !== year || Number(range.end.slice(0, 4)) !== year) fail('holiday range must be valid and contained within calendar year')
    return { name: String(range.name ?? ''), start: range.start, end: range.end }
  }).sort((a, b) => a.start.localeCompare(b.start))
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start <= ranges[i - 1].end) fail('holiday ranges overlap')
  const semantic = { schemaVersion: HOLIDAY_CALENDAR_SCHEMA_VERSION, calendarId, jurisdiction, timeZone, year, holidayDateRanges: ranges }
  const computedHash = `sha256:${createHash('sha256').update(JSON.stringify(semantic)).digest('hex')}`
  if (source.contentHash && source.contentHash !== computedHash) fail('holiday calendar contentHash mismatch')
  return {
    ...semantic,
    source: { url: source.url, authority: source.authority, publishedAt: source.publishedAt ?? null, capturedAt: source.capturedAt ?? null, fetchedAt: source.fetchedAt ?? null, contentHash: computedHash },
    trustStatus,
  }
}

function localCalendarDate(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instantMs)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function findHolidayCalendar(calendars, exclusion, instantMs) {
  const date = localCalendarDate(instantMs, exclusion.calendarTimeZone)
  const year = Number(date.slice(0, 4))
  const calendar = (calendars ?? []).map(validateHolidayCalendar).find((item) => item.calendarId === exclusion.calendarId && item.jurisdiction === exclusion.jurisdiction && item.timeZone === exclusion.calendarTimeZone && item.year === year)
  if (!calendar) return { date, year, covered: false, isHoliday: null, trustStatus: 'unavailable' }
  return { date, year, covered: true, isHoliday: calendar.holidayDateRanges.some((range) => date >= range.start && date <= range.end), trustStatus: calendar.trustStatus }
}

export function loadCalendarSet(values = []) {
  if (!Array.isArray(values)) throw new TypeError('holidayCalendars must be an array')
  return values.map(validateHolidayCalendar)
}
