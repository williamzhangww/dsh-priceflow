import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseOfficialPricingHtml, PricingParseError } from '../src/pricing/parser.mjs'
import { diffPolicies } from '../src/pricing/diff.mjs'
import { createPolicy } from '../src/pricing/policy-schema.mjs'
import { getPhaseAt } from '../src/pricing/engine.mjs'

const html = await readFile(new URL('./fixtures/pricing-normalized.html', import.meta.url), 'utf8')
const realDomHtml = await readFile(new URL('./fixtures/pricing-real-dom-2026-09-27.html', import.meta.url), 'utf8')
const realDomMetadata = JSON.parse(await readFile(new URL('./fixtures/pricing-real-dom-2026-09-27.json', import.meta.url), 'utf8'))
const holidayCalendar = JSON.parse(await readFile(new URL('../src/pricing/fixtures/cn-public-holidays-2026.json', import.meta.url), 'utf8'))
const parse = (source = html) => parseOfficialPricingHtml(source, { fetchedAt: '2026-09-27T10:00:00.000Z', contentHash: 'sha256:test' })

test('parses the live official-page extraction, exact model versions, tiers, prices, unit and holiday clause', () => {
  const p = parse()
  assert.equal(p.currency, 'USD')
  assert.equal(p.unit, 'per_1m_tokens')
  assert.deepEqual(p.schedule, {
    timeBasis: 'UTC', weekdays: [1, 2, 3, 4, 5],
    peakWindows: [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }],
    offpeakRelation: { kind: 'ratio', offpeakPerPeak: 0.5 },
    exclusions: [{ kind: 'public-holiday-calendar', jurisdiction: 'CN', calendarTimeZone: 'Asia/Shanghai', calendarId: 'cn-public-holidays' }],
  })
  assert.equal(p.models['deepseek-flash'].displayName, 'DeepSeek-V4.1-Flash')
  assert.equal(p.models['deepseek-flash'].peak.cacheHitInput, 0.006)
  assert.equal(p.models['deepseek-flash'].offpeak.cacheMissInput, 0.15)
  assert.equal(p.models['deepseek-v4-pro'].peak.output, 3.96)
})

test('real official DOM regression preserves model table rowspans, price tiers, and full schedule semantics', () => {
  assert.equal(`sha256:${createHash('sha256').update(realDomHtml).digest('hex')}`, realDomMetadata.curatedFixtureContentHash)
  assert.match(realDomHtml, /<table[^>]*>[\s\S]*rowspan="6"[\s\S]*rowspan="2"/i)
  assert.match(realDomHtml, /Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays/i)
  const policy = parseOfficialPricingHtml(realDomHtml, {
    requestedUrl: realDomMetadata.requestedUrl,
    finalUrl: realDomMetadata.finalUrl,
    fetchedAt: realDomMetadata.capturedAt,
    contentHash: realDomMetadata.rawContentHash,
    etag: realDomMetadata.etag,
    lastModified: realDomMetadata.lastModified,
  })
  assert.equal(policy.currency, 'USD')
  assert.equal(policy.unit, 'per_1m_tokens')
  assert.deepEqual(Object.keys(policy.models).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
  for (const model of Object.values(policy.models)) for (const tier of ['peak', 'offpeak']) {
    assert.deepEqual(Object.keys(model[tier]).sort(), ['cacheHitInput', 'cacheMissInput', 'output'])
    for (const price of Object.values(model[tier])) assert.ok(Number.isFinite(price) && price >= 0)
  }
  assert.deepEqual(policy.schedule.weekdays, [1, 2, 3, 4, 5])
  assert.deepEqual(policy.schedule.peakWindows, [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }])
  assert.equal(policy.schedule.offpeakRelation.offpeakPerPeak, 0.5)
  assert.deepEqual(policy.schedule.exclusions, [{ kind: 'public-holiday-calendar', jurisdiction: 'CN', calendarTimeZone: 'Asia/Shanghai', calendarId: 'cn-public-holidays' }])
  assert.equal(policy.source.contentHash, realDomMetadata.rawContentHash)
  const engine = (instant) => getPhaseAt(Date.parse(instant), policy, { holidayCalendars: [holidayCalendar] })
  assert.equal(engine('2026-09-28T01:00:00.000Z'), 'PEAK')
  assert.equal(engine('2026-09-28T04:00:00.000Z'), 'OFF-PEAK')
  assert.equal(engine('2026-09-28T06:00:00.000Z'), 'PEAK')
  assert.equal(engine('2026-09-28T10:00:00.000Z'), 'OFF-PEAK')
  assert.equal(engine('2026-09-26T02:00:00.000Z'), 'OFF-PEAK')
  assert.equal(engine('2026-09-27T02:00:00.000Z'), 'OFF-PEAK')
  assert.equal(engine('2026-10-01T02:00:00.000Z'), 'OFF-PEAK')
})

test('expands pricing table row spans used by grouped metric/tier layouts', () => {
  const grouped = `<table data-priceflow="pricing"><caption>USD per 1M tokens</caption>
    <thead><tr><th>PRICING</th><th>deepseek-flash</th><th>deepseek-v4-pro</th></tr></thead><tbody>
    <tr><td rowspan="4">1M INPUT TOKENS</td><td rowspan="2">(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
    <tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
    <tr><td rowspan="2">(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
    <tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
    <tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
    <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
    </tbody></table>`
  const candidate = html.replace(/<table data-priceflow="pricing">[\s\S]*?<\/table>/, grouped)
  const policy = parse(candidate)
  assert.equal(policy.models['deepseek-flash'].peak.output, 1.2)
  assert.equal(policy.models['deepseek-v4-pro'].offpeak.cacheMissInput, 0.66)
})

test('pricing-only and schedule-only edits remain distinct; holiday policy changes are diffed semantically', () => {
  const prior = parse()
  const priceOnly = parse(html.replace(/\$[\d.]+/g, (value) => `$${Number(value.slice(1)) * 1000}`))
  const scheduleOnly = parse(html.replace('06:00 - 10:00', '07:00 - 11:00'))
  const weekdaysOnly = parse(html.replace('Monday through Friday', 'Monday through Thursday'))
  const holidayRemoved = parse(html.replace(', excluding Chinese public holidays', '').replace(' and Chinese public holidays in full', ''))
  assert.ok(diffPolicies(prior, priceOnly).changes.some((change) => change.kind === 'model-changed'))
  assert.ok(diffPolicies(prior, scheduleOnly).changes.some((change) => change.kind === 'peak-windows'))
  assert.ok(diffPolicies(prior, weekdaysOnly).changes.some((change) => change.kind === 'weekdays'))
  assert.ok(diffPolicies(prior, holidayRemoved).changes.some((change) => change.kind === 'holiday-exclusion-removed'))
  const changedJurisdictionData = structuredClone(prior)
  delete changedJurisdictionData.policyId
  changedJurisdictionData.schedule.exclusions[0].jurisdiction = 'US'
  const changedJurisdiction = createPolicy(changedJurisdictionData)
  assert.ok(diffPolicies(prior, changedJurisdiction).changes.some((change) => change.kind === 'holiday-exclusion-jurisdiction-changed'))
  const changedCalendarData = structuredClone(prior)
  delete changedCalendarData.policyId
  changedCalendarData.schedule.exclusions[0].calendarTimeZone = 'Asia/Tokyo'
  changedCalendarData.schedule.exclusions[0].calendarId = 'jp-holidays'
  const changedCalendar = createPolicy(changedCalendarData)
  assert.ok(diffPolicies(prior, changedCalendar).changes.some((change) => change.kind === 'holiday-calendar-semantics-changed'))
  const ratioChanged = parse(html.replace('Off-peak rates are half of the peak rates.', 'Off-peak rates are 0.25 times the peak rates.')
    .replace(/\$[\d.]+/g, (value) => ({ '$0.003':'$0.0015', '$0.15':'$0.075', '$0.6':'$0.3', '$0.022':'$0.011', '$0.66':'$0.33', '$1.98':'$0.99' }[value] ?? value)))
  assert.equal(ratioChanged.schedule.offpeakRelation.offpeakPerPeak, 0.25)
})

test('rejects missing, ambiguous, structurally changed pricing data and malformed schedule semantics', () => {
  const cases = [
    [html.replace('1M OUTPUT TOKENS', 'Unknown metric'), 'unknown-price-metric'],
    [html.replace('<tr><td>1M OUTPUT TOKENS</td><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>', ''), 'missing-price'],
    [html.replaceAll('per 1M tokens', 'per request'), 'unknown-unit'],
    [html.replace('USD per 1M tokens', 'credits per 1M tokens').replaceAll('$', ''), 'unknown-currency'],
    [html.replace('Monday through Friday', 'Monday or Wednesday'), 'ambiguous-weekdays'],
    [html.replace('UTC, Monday', 'local time, Monday'), 'unknown-timezone'],
    [html.replace('excluding Chinese public holidays', 'excluding holidays'), 'ambiguous-exclusion'],
    [html.replace('All other hours are off-peak', 'Remaining times are cheap'), 'ambiguous-schedule'],
    [html.replace('01:00 - 04:00', '01:00 - 25:99'), 'malformed-schedule'],
  ]
  for (const [candidate, code] of cases) assert.throws(() => parse(candidate), (error) => error instanceof PricingParseError && error.code === code, code)
  assert.throws(() => parse(html.replace('data-priceflow="pricing"', 'data-priceflow="changed"').replace('Pricing metric', 'Cost group')), PricingParseError)
  assert.throws(() => parse(html + html.match(/<table data-priceflow="pricing">[\s\S]*?<\/table>/)[0]), (error) => error.code === 'ambiguous-pricing-table')
})

test('strict parser does not retain a removed holiday exclusion as an implicit default', () => {
  const noHolidayClause = parse(html.replace(', excluding Chinese public holidays', '').replace(' and Chinese public holidays in full', ''))
  assert.deepEqual(noHolidayClause.schedule.exclusions, [])
})
