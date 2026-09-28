import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateHolidayCalendar } from '../src/pricing/holiday-calendar.mjs'

const fixture = JSON.parse(await readFile(new URL('../src/pricing/fixtures/cn-public-holidays-2026.json', import.meta.url), 'utf8'))

test('2026 annual calendar contains only official holiday ranges and verifiable bundled provenance', () => {
  const calendar = validateHolidayCalendar(fixture)
  assert.equal(calendar.year, 2026)
  assert.equal(calendar.timeZone, 'Asia/Shanghai')
  assert.equal(calendar.trustStatus, 'official-bundled')
  assert.equal(calendar.source.authority, 'State Council General Office')
  assert.equal(calendar.source.fetchedAt, null)
  assert.match(calendar.source.contentHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(calendar.holidayDateRanges.map(({ start, end }) => [start, end]), [
    ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ])
})

test('calendar rejects non-government source and a modified fixture hash', () => {
  assert.throws(() => validateHolidayCalendar({ ...fixture, source: { ...fixture.source, url: 'https://example.org/calendar' } }), /gov\.cn/)
  assert.throws(() => validateHolidayCalendar({ ...fixture, holidayDateRanges: fixture.holidayDateRanges.slice(1) }), /contentHash mismatch/)
})
