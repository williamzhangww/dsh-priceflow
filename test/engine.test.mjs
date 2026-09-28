import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validatePolicy } from '../src/pricing/policy-schema.mjs'
import { getNextTransition, getPhaseAt, getPricingSnapshot, isTargetSatisfied } from '../src/pricing/engine.mjs'

const fixturePath = new URL('../src/pricing/fixtures/official-current.json', import.meta.url)
const fixture = validatePolicy(JSON.parse(await readFile(fixturePath, 'utf8')))
const holidayCalendar = JSON.parse(await readFile(new URL('../src/pricing/fixtures/cn-public-holidays-2026.json', import.meta.url), 'utf8'))
const calendars = { holidayCalendars: [holidayCalendar] }
const at = (iso) => Date.parse(iso)

test('UTC windows use [start,end) at every Monday boundary', () => {
  const cases = [
    ['2026-09-28T00:59:59Z', 'OFF-PEAK'],
    ['2026-09-28T01:00:00Z', 'PEAK'],
    ['2026-09-28T03:59:59Z', 'PEAK'],
    ['2026-09-28T04:00:00Z', 'OFF-PEAK'],
    ['2026-09-28T05:59:59Z', 'OFF-PEAK'],
    ['2026-09-28T06:00:00Z', 'PEAK'],
    ['2026-09-28T09:59:59Z', 'PEAK'],
    ['2026-09-28T10:00:00Z', 'OFF-PEAK'],
  ]
  for (const [instant, phase] of cases) assert.equal(getPhaseAt(at(instant), fixture, calendars), phase, instant)
})

test('Tuesday and Friday follow weekday schedule; Saturday and Sunday are off-peak', () => {
  for (const day of ['2026-09-29', '2026-09-30']) assert.equal(getPhaseAt(at(`${day}T06:30:00Z`), fixture, calendars), 'PEAK')
  for (const day of ['2026-10-03', '2026-10-04']) assert.equal(getPhaseAt(at(`${day}T06:30:00Z`), fixture, calendars), 'OFF-PEAK')
})

test('next transitions include same-day and cross-week boundaries', () => {
  const cases = [
    ['2026-09-28T02:00:00Z', '2026-09-28T04:00:00Z', 'OFF-PEAK'],
    ['2026-09-28T04:00:00Z', '2026-09-28T06:00:00Z', 'PEAK'],
    ['2026-09-29T09:00:00Z', '2026-09-29T10:00:00Z', 'OFF-PEAK'],
    ['2026-10-04T23:59:59Z', '2026-10-08T01:00:00Z', 'PEAK'],
  ]
  for (const [instant, nextAt, phase] of cases) assert.deepEqual(getNextTransition(at(instant), fixture, calendars), { atUtcMs: at(nextAt), nextPhase: phase })
})

test('month, year, leap day and DST dates do not perturb UTC evaluation', () => {
  const expected = new Map([
    ['2026-01-30T06:30:00Z', 'PEAK'], ['2026-12-28T06:30:00Z', 'PEAK'], ['2028-02-29T06:30:00Z', 'PEAK'],
    ['2027-03-28T01:30:00Z', 'OFF-PEAK'], ['2027-10-31T01:30:00Z', 'OFF-PEAK'],
    ['2027-03-14T06:30:00Z', 'OFF-PEAK'], ['2027-11-07T06:30:00Z', 'OFF-PEAK'],
  ])
  for (const [point, phase] of expected) assert.equal(getPhaseAt(at(point), fixture, calendars), phase, point)
})

test('unknown model has no price while schedule snapshot remains complete', () => {
  const snap = getPricingSnapshot(at('2026-09-28T02:00:00Z'), fixture, 'unknown-model', 'stale-verified', calendars)
  assert.equal(snap.phase, 'PEAK')
  assert.equal(snap.nextPhase, 'OFF-PEAK')
  assert.equal(snap.remainingMs, 2 * 60 * 60 * 1000)
  assert.equal(snap.prices, null)
  assert.equal(snap.currency, null)
  assert.equal(snap.trustStatus, 'stale-verified')
  assert.equal(snap.canAutoSchedule, true)
})

test('target satisfaction requires calendar coverage when the policy excludes holidays', () => {
  assert.equal(isTargetSatisfied('OFF-PEAK', at('2026-09-28T04:00:00Z'), fixture, calendars), true)
  assert.equal(isTargetSatisfied('OFF-PEAK', at('2026-09-28T02:00:00Z'), fixture, calendars), false)
  assert.equal(isTargetSatisfied('OFF-PEAK', at('2026-09-28T04:00:00Z'), fixture), false)
})

test('Chinese public holidays suppress every otherwise-peak weekday window', () => {
  for (const hour of ['01:00', '02:00', '06:00', '09:00']) {
    assert.equal(getPhaseAt(at(`2026-09-25T${hour}:00Z`), fixture, calendars), 'OFF-PEAK')
  }
  for (let day = 1; day <= 7; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`
    for (const hour of ['01:30', '06:30']) assert.equal(getPhaseAt(at(`${date}T${hour}:00Z`), fixture, calendars), 'OFF-PEAK', `${date} ${hour}`)
  }
  for (const day of ['2026-09-20', '2026-10-10']) {
    for (const hour of ['01:30', '06:30']) assert.equal(getPhaseAt(at(`${day}T${hour}:00Z`), fixture, calendars), 'OFF-PEAK')
  }
  assert.equal(getPhaseAt(at('2026-09-24T06:30:00Z'), fixture, calendars), 'PEAK')
  assert.equal(getPhaseAt(at('2026-09-28T06:30:00Z'), fixture, calendars), 'PEAK')
})

test('holiday timezone is Asia/Shanghai and does not depend on the user timezone', () => {
  const instant = at('2026-09-24T17:30:00Z') // Sep 25 in China; still Sep 24 in Helsinki
  const phases = ['Europe/Helsinki', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo'].map((timeZone) => {
    const original = process.env.TZ
    process.env.TZ = timeZone
    const phase = getPhaseAt(instant, fixture, calendars)
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
    return phase
  })
  assert.deepEqual(phases, ['OFF-PEAK', 'OFF-PEAK', 'OFF-PEAK', 'OFF-PEAK'])
})

test('holiday-aware transition search skips a holiday weekday window and resumes after the holiday', () => {
  const next = getNextTransition(at('2026-09-24T17:00:00Z'), fixture, calendars)
  assert.deepEqual(next, { atUtcMs: at('2026-09-28T01:00:00Z'), nextPhase: 'PEAK' })
  assert.deepEqual(getNextTransition(at('2026-02-13T10:01:00Z'), fixture, calendars), {
    atUtcMs: at('2026-02-24T01:00:00Z'), nextPhase: 'PEAK',
  })
})

test('missing holiday year is visible and disables automatic scheduling', () => {
  const snap = getPricingSnapshot(at('2027-03-29T02:00:00Z'), fixture, 'deepseek-flash', 'verified')
  assert.equal(snap.phase, 'PEAK') // provisional weekday/window reference
  assert.equal(snap.calendarStatus, 'unavailable')
  assert.equal(snap.scheduleVerified, false)
  assert.equal(snap.canAutoSchedule, false)
})

test('bundled holiday dates retain official-bundled provenance and never claim online verification', () => {
  const snap = getPricingSnapshot(at('2026-09-28T02:00:00Z'), fixture, 'deepseek-flash', 'verified', calendars)
  assert.equal(snap.calendarStatus, 'official-bundled')
  assert.equal(snap.scheduleVerified, true)
  assert.equal(snap.canAutoSchedule, true)
  assert.equal(holidayCalendar.trustStatus, 'official-bundled')
  assert.equal(holidayCalendar.source.fetchedAt, null)
})

test('stale-verified pricing plus covered official-bundled calendar remains schedulable', () => {
  const snap = getPricingSnapshot(at('2026-09-28T02:00:00Z'), fixture, 'deepseek-flash', 'stale-verified', calendars)
  assert.equal(snap.canAutoSchedule, true)
  assert.equal(snap.scheduleVerified, true)
  assert.equal(snap.calendarStatus, 'official-bundled')
})

test('IANA policy basis resolves a real transition through DST without using host timezone', () => {
  const finland = structuredClone(fixture)
  finland.schedule = { timeBasis: 'Europe/Helsinki', weekdays: [1, 2, 3, 4, 5], peakWindows: [{ startMinute: 540, endMinute: 600 }], offpeakRelation: null }
  delete finland.policyId
  const beforeSpringTransition = at('2027-03-29T05:59:00Z') // 07:59 in Helsinki
  const spring = getNextTransition(beforeSpringTransition, finland)
  assert.equal(spring.atUtcMs, at('2027-03-29T06:00:00Z'))
  assert.equal(spring.nextPhase, 'PEAK')
  const beforeAutumn = at('2027-10-25T05:59:00Z') // 08:59 after the autumn clock change
  assert.equal(getNextTransition(beforeAutumn, finland).atUtcMs, at('2027-10-25T06:00:00Z'))
})

test('engine output is invariant under supported host process time zones', () => {
  const script = `import {readFileSync} from 'node:fs'; import {getPricingSnapshot} from './src/pricing/engine.mjs'; const p=JSON.parse(readFileSync('./src/pricing/fixtures/official-current.json','utf8')); const x=getPricingSnapshot(Date.parse('2027-03-28T01:30:00Z'),p,null,'verified'); console.log(JSON.stringify({phase:x.phase,nextPhase:x.nextPhase,transitionAtUtcMs:x.transitionAtUtcMs}));`
  const outputs = ['Europe/Helsinki', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'].map((TZ) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.trim()
  })
  assert.equal(new Set(outputs).size, 1)
})
