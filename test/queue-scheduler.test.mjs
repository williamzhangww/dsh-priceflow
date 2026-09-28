import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPricingRefreshService } from '../src/pricing/refresh-service.mjs'
import { createPolicy } from '../src/pricing/policy-schema.mjs'
import { createQueueService } from '../src/queue/service.mjs'
import { createQueueScheduler, createDisabledDeliveryAdapter } from '../src/queue/scheduler.mjs'

const fixture = JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8'))
const calendar = JSON.parse(await readFile(new URL('../src/pricing/fixtures/cn-public-holidays-2026.json', import.meta.url), 'utf8'))
const peakPolicy = createPolicy({ ...fixture, source: { ...fixture.source, fetchedAt: '2026-09-27T00:00:00.000Z', contentHash: 'sha256:scheduler' } })
function timers() {
  let id = 0
  const tasks = new Map()
  return { tasks, set(fn, delay) { const key = ++id; tasks.set(key, { fn, delay }); return key }, clear(key) { tasks.delete(key) }, async runFirst() { const [key, item] = tasks.entries().next().value ?? []; if (!item) return; tasks.delete(key); await item.fn(); await new Promise((resolve) => setImmediate(resolve)) } }
}
function queueService(now) {
  let state = null
  const store = { async load() { return structuredClone(state) }, async save(value) { state = structuredClone(value) } }
  return createQueueService({ store, settings: { queueMaxItems: 100, deliveryLeaseMs: 120000 }, now, id: (() => { let id = 0; return () => `q${++id}` })() })
}
function pricingService(getPolicy, getTrust = () => 'verified') {
  const listeners = new Set()
  return {
    getSnapshot() { return { policy: getPolicy(), trustStatus: getTrust(), canAutoSchedule: getTrust() !== 'bundled-fixture' } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    change() { for (const fn of listeners) fn(this.getSnapshot()) },
  }
}

test('verified off-peak snapshot delivers once; peak remains queued until off-peak', async () => {
  let now = Date.parse('2026-09-28T06:30:00.000Z')
  const queue = queueService(() => now)
  await queue.start()
  await queue.enqueue({ text: 'queued', sessionId: 'session', policyId: peakPolicy.policyId })
  let delivered = 0
  const ts = timers()
  const scheduler = createQueueScheduler({ queueService: queue, pricingService: pricingService(() => peakPolicy), getHolidayCalendars: () => [calendar], deliveryAdapter: { async deliver() { delivered++ } }, now: () => now, setTimer: ts.set, clearTimer: ts.clear })
  await scheduler.start()
  assert.equal(delivered, 0)
  assert.equal((await queue.snapshot()).items[0].status, 'queued')
  assert.equal([...ts.tasks.values()][0].delay, Date.parse('2026-09-28T10:00:00Z') - now)
  now = Date.parse('2026-09-28T10:00:00.000Z')
  await scheduler.tick()
  assert.equal(delivered, 1)
  assert.equal((await queue.snapshot()).items[0].status, 'submitted')
  await scheduler.stop()
})

test('bundled fixture and missing holiday coverage never deliver', async () => {
  for (const [trust, calendars] of [['bundled-fixture', [calendar]], ['verified', []]]) {
    let now = Date.parse('2026-09-27T12:00:00.000Z')
    const queue = queueService(() => now)
    await queue.start()
    await queue.enqueue({ text: 'queued', sessionId: 'session', policyId: peakPolicy.policyId })
    let delivered = 0
    const ts = timers()
    const scheduler = createQueueScheduler({ queueService: queue, pricingService: pricingService(() => peakPolicy, () => trust), getHolidayCalendars: () => calendars, deliveryAdapter: { async deliver() { delivered++ } }, now: () => now, setTimer: ts.set, clearTimer: ts.clear })
    await scheduler.start()
    assert.equal(delivered, 0)
    assert.equal((await queue.snapshot()).items[0].status, 'queued')
    await scheduler.stop()
  }
})

test('queued item is re-evaluated with updated policy before off-peak delivery', async () => {
  let now = Date.parse('2026-09-28T06:30:00.000Z')
  const queue = queueService(() => now)
  await queue.start()
  await queue.enqueue({ text: 'queued', sessionId: 'session', policyId: peakPolicy.policyId })
  const changed = createPolicy({ ...peakPolicy, schedule: { ...peakPolicy.schedule, peakWindows: [{ startMinute: 420, endMinute: 660 }, { startMinute: 720, endMinute: 900 }] } })
  const pricing = pricingService(() => peakPolicy)
  let delivered = 0
  const ts = timers()
  const scheduler = createQueueScheduler({ queueService: queue, pricingService: pricing, getHolidayCalendars: () => [calendar], deliveryAdapter: { async deliver() { delivered++ } }, now: () => now, setTimer: ts.set, clearTimer: ts.clear })
  await scheduler.start()
  assert.equal(delivered, 0)
  pricing.getSnapshot = () => ({ policy: changed, trustStatus: 'verified', canAutoSchedule: true })
  pricing.change()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(delivered, 1)
  assert.equal((await queue.snapshot()).items[0].status, 'submitted')
  await scheduler.stop()
})

test('retryAt gates delivery and concurrent ticks do not duplicate an attempt', async () => {
  let now = Date.parse('2026-09-27T12:00:00.000Z')
  const queue = queueService(() => now)
  await queue.start()
  await queue.enqueue({ text: 'queued', sessionId: 'session', policyId: peakPolicy.policyId })
  let calls = 0
  let release
  const wait = new Promise((resolve) => { release = resolve })
  const ts = timers()
  const scheduler = createQueueScheduler({ queueService: queue, pricingService: pricingService(() => peakPolicy), getHolidayCalendars: () => [calendar], deliveryAdapter: { async deliver() { calls++; await wait } }, now: () => now, setTimer: ts.set, clearTimer: ts.clear, retryBaseMs: 1000 })
  const first = scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  const second = scheduler.tick()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])
  assert.equal((await queue.snapshot()).items[0].status, 'submitted')
  await scheduler.stop()

  const retryQueue = queueService(() => now)
  await retryQueue.start()
  await retryQueue.enqueue({ text: 'retry', sessionId: 'session', policyId: peakPolicy.policyId })
  let attempts = 0
  const retryTimers = timers()
  const retryScheduler = createQueueScheduler({ queueService: retryQueue, pricingService: pricingService(() => peakPolicy), getHolidayCalendars: () => [calendar], deliveryAdapter: { async deliver() { attempts++; if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'temporary', retryable: true }) } }, now: () => now, setTimer: retryTimers.set, clearTimer: retryTimers.clear, retryBaseMs: 1000 })
  await retryScheduler.start()
  assert.equal(attempts, 1)
  assert.equal((await retryQueue.snapshot()).items[0].retryAtUtc, now + 1000)
  await retryScheduler.tick()
  assert.equal(attempts, 1)
  now += 1000
  await retryScheduler.tick()
  assert.equal(attempts, 2)
  assert.equal((await retryQueue.snapshot()).items[0].status, 'submitted')
  await retryScheduler.stop()
})

test('disabled delivery adapter leaves queued work untouched', async () => {
  let now = Date.parse('2026-09-27T12:00:00.000Z')
  const queue = queueService(() => now)
  await queue.start()
  await queue.enqueue({ text: 'queued', sessionId: 'session', policyId: peakPolicy.policyId })
  const ts = timers()
  const scheduler = createQueueScheduler({ queueService: queue, pricingService: pricingService(() => peakPolicy), getHolidayCalendars: () => [calendar], deliveryAdapter: createDisabledDeliveryAdapter(), now: () => now, setTimer: ts.set, clearTimer: ts.clear })
  await scheduler.start()
  await scheduler.tick()
  assert.equal((await queue.snapshot()).items[0].status, 'queued')
  assert.equal(ts.tasks.size, 0)
  await scheduler.stop()
})
