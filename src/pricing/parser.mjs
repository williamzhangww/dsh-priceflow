import { createPolicy, OFFICIAL_PRICING_URL, PolicyValidationError } from './policy-schema.mjs'

export const PARSER_VERSION = 2

export class PricingParseError extends Error {
  constructor(message, code = 'parse-error') { super(message); this.name = 'PricingParseError'; this.code = code }
}

const decodeEntities = (s) => s.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
const stripTags = (s) => decodeEntities(s.replace(/<sup\b[^>]*>[\s\S]*?<\/sup\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const WEEKDAYS = Object.freeze({ monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 })

function tagBlocks(html, tagName) {
  const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'gi')
  return [...html.matchAll(re)].map((m) => ({ attrs: m[1], inner: m[2], text: stripTags(m[2]) }))
}

function rowsOf(tableHtml) {
  const pending = new Map()
  return tagBlocks(tableHtml, 'tr').map((row) => {
    const cells = []
    const nextPending = new Map()
    for (const [column, value] of pending) {
      cells[column] = value.text
      if (value.remaining > 1) nextPending.set(column, { text: value.text, remaining: value.remaining - 1 })
    }
    let column = 0
    for (const match of row.inner.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
      while (cells[column] !== undefined) column++
      const attrs = match[2]
      const text = stripTags(match[3])
      const colSpan = Math.max(1, Number(attrs.match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))
      const rowSpan = Math.max(1, Number(attrs.match(/\browspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))
      while (Array.from({ length: colSpan }, (_, offset) => cells[column + offset]).some((value) => value !== undefined)) column++
      for (let offset = 0; offset < colSpan; offset++) {
        cells[column + offset] = text
        if (rowSpan > 1) nextPending.set(column + offset, { text, remaining: rowSpan - 1 })
      }
      column += colSpan
    }
    pending.clear()
    for (const [col, value] of nextPending) pending.set(col, value)
    return cells.filter((cell) => cell !== undefined)
  }).filter((row) => row.length > 0)
}

function parseNumber(text) {
  const normalized = text.replace(/,/g, '').replace(/^\s*\$/, '').trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) throw new PricingParseError(`invalid numeric price cell: ${text}`, 'invalid-price-cell')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) throw new PricingParseError('price must be finite and non-negative', 'invalid-price-cell')
  return value
}

function parseSchedule(text) {
  const statements = [...text.matchAll(/(?:Peak hours are|Peak hours:)([^.\n]*)/gi)]
  if (statements.length !== 1) throw new PricingParseError(`expected exactly one explicit peak-hours statement; found ${statements.length}`, statements.length ? 'ambiguous-schedule' : 'missing-schedule')
  const scheduleStatement = statements[0][0]
  const matches = [...scheduleStatement.matchAll(/(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})/gi)]
  if (matches.length === 0) throw new PricingParseError('pricing schedule windows not found', 'missing-schedule')
  const windows = matches.map((m) => {
    const parseMinute = (s) => {
      const [h, min] = s.split(':').map(Number)
      if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new PricingParseError(`invalid schedule time: ${s}`, 'malformed-schedule')
      return h * 60 + min
    }
    return { startMinute: parseMinute(m[1]), endMinute: parseMinute(m[2]) }
  })
  if (windows.some((w) => w.startMinute >= w.endMinute)) throw new PricingParseError('overnight or empty schedule window is unsupported', 'malformed-schedule')
  const utc = /\bUTC\b/i.test(scheduleStatement)
  if (!utc) throw new PricingParseError('schedule timezone is not explicitly UTC', 'unknown-timezone')
  const weekdayRange = scheduleStatement.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(?:through|to|[-–—])\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i)
  let weekdays
  if (weekdayRange) {
    const first = WEEKDAYS[weekdayRange[1].toLowerCase()]
    const last = WEEKDAYS[weekdayRange[2].toLowerCase()]
    if (last < first) throw new PricingParseError('weekday range is reversed or wraps the week', 'ambiguous-weekdays')
    weekdays = Array.from({ length: last - first + 1 }, (_, index) => first + index)
  } else if (/\bweekdays\b/i.test(scheduleStatement)) weekdays = [1, 2, 3, 4, 5]
  else if (/Monday\s*,\s*Tuesday\s*,\s*Wednesday\s*,\s*Thursday\s*,?\s*Friday/i.test(scheduleStatement)) weekdays = [1, 2, 3, 4, 5]
  else throw new PricingParseError('weekday applicability is not explicit or supported', 'ambiguous-weekdays')
  if (/excluding\s+(?!Chinese\s+public\s+holidays\b)[^,.]+/i.test(scheduleStatement)) throw new PricingParseError('unsupported or ambiguous schedule exclusion', 'ambiguous-exclusion')
  const holidayClause = /Chinese\s+public\s+holidays/i.test(text)
  const fullHolidayOffpeak = /including\s+weekends\s+and\s+Chinese\s+public\s+holidays\s+in\s+full/i.test(text)
  const exclusions = (/excluding\s+Chinese\s+public\s+holidays\b/i.test(scheduleStatement) || fullHolidayOffpeak)
    ? [{ kind: 'public-holiday-calendar', jurisdiction: 'CN', calendarTimeZone: 'Asia/Shanghai', calendarId: 'cn-public-holidays' }]
    : []
  const allOther = /All\s+other\s+hours\s+are\s+off\s*[- ]?peak/i.test(text)
  if (!allOther) throw new PricingParseError('all-other-hours off-peak rule is missing or ambiguous', 'ambiguous-schedule')
  if (holidayClause && !fullHolidayOffpeak) {
    throw new PricingParseError('holiday clause does not establish that holidays are off-peak in full', 'ambiguous-exclusion')
  }
  return { timeBasis: 'UTC', weekdays, peakWindows: windows, exclusions }
}

function priceTableCandidates(html) {
  const tables = tagBlocks(html, 'table')
  return tables.filter((t) => {
    const body = t.text.toLowerCase()
    const identified = /\bpricing\b/i.test(t.attrs) || /\bpricing\b/i.test(t.text)
    const completeMatrix = /cache\s*hit/i.test(body) && /cache\s*miss/i.test(body) && /\boutput\b/i.test(body)
    return identified && completeMatrix
  })
}

function identifyModels(html) {
  const details = tagBlocks(html, 'table').filter((t) => /model-details/i.test(t.attrs) || /model version/i.test(t.text))
  const found = new Map()
  for (const table of details) {
    const rows = rowsOf(table.inner)
    const modelRow = rows.find((row) => /^MODEL$/i.test(row[0] ?? ''))
    const versionRow = rows.find((row) => /^MODEL VERSION$/i.test(row[0] ?? ''))
    if (modelRow && versionRow) {
      const labelColumns = modelRow.filter((cell) => /^MODEL$/i.test(cell)).length
      const modelIds = modelRow.slice(labelColumns)
      const versions = versionRow.slice(labelColumns)
      if (modelIds.length > 0 && modelIds.length === versions.length && modelIds.every((id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id)) && new Set(modelIds).size === modelIds.length) {
        modelIds.forEach((id, index) => found.set(id, versions[index]))
      }
    }
  }
  if (found.size === 0) throw new PricingParseError('official Model Details table must identify each model id and version', 'missing-model-metadata')
  return found
}

export function parseOfficialPricingHtml(html, sourceMetadata = {}) {
  if (typeof html !== 'string' || html.length < 100) throw new PricingParseError('HTML document is empty or too short', 'empty-document')
  const tables = priceTableCandidates(html)
  if (tables.length !== 1) throw new PricingParseError(`expected exactly one clearly identified current pricing table; found ${tables.length}`, tables.length ? 'ambiguous-pricing-table' : 'missing-pricing-table')
  const table = tables[0]
  const rows = rowsOf(table.inner)
  const idMap = identifyModels(html)
  const modelIds = [...idMap.keys()].sort()
  const modelHeader = rows.find((row) => row.some((cell) => modelIds.includes(cell)))
  if (modelHeader && (modelHeader.filter((cell) => modelIds.includes(cell)).length !== modelIds.length || modelIds.some((modelId) => !modelHeader.includes(modelId)))) {
    throw new PricingParseError('pricing model columns are duplicated or ambiguous', 'duplicate-model')
  }
  if (new Set(modelIds).size !== modelIds.length) throw new PricingParseError('pricing columns map to conflicting model ids', 'duplicate-model')
  const values = Object.create(null)
  const currencies = new Set()
  for (const row of rows) {
    const tierIndex = row.findIndex((cell) => /^(?:off\s*[- ]?peak|peak)$/i.test(cell))
    if (tierIndex < 0) continue
    const metric = row.slice(0, tierIndex).join(' ').toLowerCase()
    const tierText = row[tierIndex].toLowerCase()
    const tier = /off\s*[- ]?peak/i.test(tierText) ? 'offpeak' : /\bpeak\b/i.test(tierText) ? 'peak' : null
    if (!tier) continue
    const field = /cache\s*hit/i.test(metric) ? 'cacheHitInput' : /cache\s*miss/i.test(metric) ? 'cacheMissInput' : /output/i.test(metric) ? 'output' : null
    if (!field) throw new PricingParseError(`unknown pricing metric: ${metric}`, 'unknown-price-metric')
    const rawValues = row.slice(tierIndex + 1)
    if (rawValues.length !== modelIds.length) throw new PricingParseError(`price row has ${rawValues.length} model values; expected ${modelIds.length}`, 'unknown-table-structure')
    modelIds.forEach((modelId, i) => {
      const raw = rawValues[i]
      if (/^[A-Z]{3}\s/.test(raw)) currencies.add(raw.slice(0, 3))
      const value = parseNumber(raw)
      const key = `${modelId}:${tier}:${field}`
      if (Object.hasOwn(values, key) && values[key] !== value) throw new PricingParseError(`conflicting duplicate price row ${key}`, 'conflicting-price-row')
      if (Object.hasOwn(values, key)) throw new PricingParseError(`duplicate price row ${key}`, 'duplicate-price-row')
      values[key] = value
    })
  }
  let currency = null
  const caption = tagBlocks(table.inner, 'caption')[0]?.text ?? ''
  const currencyText = `${caption} ${table.text}`
  if (/\bUSD\b|US\s*dollars?|\$/i.test(currencyText)) currency = 'USD'
  if (/\bEUR\b|€/.test(currencyText)) currency = currency ? 'AMBIGUOUS' : 'EUR'
  if (/\bCNY\b|\bRMB\b|¥|人民币/.test(currencyText)) currency = currency ? 'AMBIGUOUS' : 'CNY'
  if (currencies.size > 1 || currency === 'AMBIGUOUS') throw new PricingParseError('conflicting currency declarations', 'unknown-currency')
  if (currencies.size === 1) {
    const fromCells = [...currencies][0]
    if (currency && currency !== fromCells) throw new PricingParseError('table caption and price cells disagree on currency', 'unknown-currency')
    currency = fromCells
  }
  if (!currency) throw new PricingParseError('currency is not explicit in the pricing table', 'unknown-currency')
  if (!/per\s*1\s*M\s*tokens?/i.test(caption) && !/per\s*1\s*M\s*tokens?/i.test(html.slice(0, 2000))) throw new PricingParseError('price unit is not explicitly per 1M tokens', 'unknown-unit')
  const scheduleText = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ')
  const schedule = parseSchedule(scheduleText)
  const ratioMatches = [...scheduleText.matchAll(/off\s*[- ]?peak\s+(?:rates?\s+are|prices?\s+are)\s+(\d+(?:\.\d+)?)\s*(?:times?|x)\s+(?:the\s+)?peak|off\s*[- ]?peak\s+(?:rates?\s+are|prices?\s+are)\s+(?:half|one half)\s+(?:of\s+)?(?:the\s+)?peak/gi)]
  let offpeakPerPeak = null
  if (ratioMatches.length === 1) {
    const m = ratioMatches[0]
    offpeakPerPeak = /half/i.test(m[0]) ? 0.5 : Number(m[1])
  } else if (ratioMatches.length > 1) throw new PricingParseError('multiple conflicting off-peak ratio statements', 'conflicting-ratio')
  const models = Object.create(null)
  for (const modelId of modelIds) {
    const record = { displayName: idMap.get(modelId) ?? modelId }
    for (const tier of ['peak', 'offpeak']) {
      record[tier] = {}
      for (const field of ['cacheHitInput', 'cacheMissInput', 'output']) {
        const key = `${modelId}:${tier}:${field}`
        if (!Object.hasOwn(values, key)) throw new PricingParseError(`missing required price ${key}`, 'missing-price')
        record[tier][field] = values[key]
      }
    }
    models[modelId] = record
  }
  if (offpeakPerPeak !== null) {
    for (const model of Object.values(models)) for (const field of ['cacheHitInput', 'cacheMissInput', 'output']) {
      if (Math.abs(model.offpeak[field] - model.peak[field] * offpeakPerPeak) > Math.max(1e-12, Math.abs(model.peak[field]) * 1e-9)) {
        throw new PricingParseError('explicit off-peak ratio conflicts with price table', 'ratio-price-conflict')
      }
    }
  }
  const source = {
    url: OFFICIAL_PRICING_URL,
    requestedUrl: sourceMetadata.requestedUrl ?? OFFICIAL_PRICING_URL,
    finalUrl: sourceMetadata.finalUrl ?? OFFICIAL_PRICING_URL,
    fetchedAt: sourceMetadata.fetchedAt ?? new Date().toISOString(),
    contentHash: sourceMetadata.contentHash ?? null,
    parserVersion: PARSER_VERSION,
    etag: sourceMetadata.etag ?? null,
    lastModified: sourceMetadata.lastModified ?? null,
  }
  try {
    return createPolicy({
      schemaVersion: 1,
      source,
      currency,
      unit: 'per_1m_tokens',
      schedule: { ...schedule, offpeakRelation: offpeakPerPeak === null ? null : { kind: 'ratio', offpeakPerPeak } },
      models,
    })
  } catch (error) {
    if (error instanceof PolicyValidationError) throw new PricingParseError(error.message, error.code)
    throw error
  }
}
