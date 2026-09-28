import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPricingRefreshService } from '../src/pricing/refresh-service.mjs'

const fixture = JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8'))
const okPolicy = structuredClone(fixture)
okPolicy.source = { ...okPolicy.source, fetchedAt: '2026-09-27T00:00:00.000Z', contentHash: 'sha256:valid' }
const MS = 1

function fakeTimers() {
  let next = 1
  const tasks = new Map()
  return {
    tasks,
    set(fn, delay) { const id = next++; tasks.set(id, { fn, delay }); return id },
    clear(id) { tasks.delete(id) },
    async runFirst() { const [id, task] = tasks.entries().next().value ?? []; if (!task) return; tasks.delete(id); await task.fn(); await new Promise((resolve) => setImmediate(resolve)) },
  }
}
function memoryStore(initial = null) {
  let current = initial
  return { async load() { return structuredClone(current) }, async save(v) { current = structuredClone(v); return structuredClone(v) }, inspect() { return structuredClone(current) } }
}

test('startup always refreshes once with or without LKG or bundled fallback', async () => {
  for (const initial of [null, {
    schemaVersion: 1, lastKnownGood: okPolicy,
    operational: { trustStatus: 'verified', lastSuccessfulFetchAt: Date.now(), lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: null },
  }]) {
    let calls = 0
    const timers = fakeTimers()
    const service = createPricingRefreshService({ fetcher: { async refresh() { calls++; throw Object.assign(new Error('offline'), { code: 'network-error' }) } }, policyStore: memoryStore(initial), bundledFixture: fixture, now: () => 1000, setTimer: timers.set, clearTimer: timers.clear, retryDelaysMs: [300, 600] })
    const snap = await service.start()
    assert.equal(calls, 1)
    assert.equal(snap.trustStatus, initial ? 'stale-verified' : 'bundled-fixture')
    service.stop()
  }
})

test('single-flight coalesces refresh calls and successful refresh resets retry state', async () => {
  let calls = 0
  let now = 1000
  const timers = fakeTimers()
  const store = memoryStore()
  const service = createPricingRefreshService({ fetcher: { async refresh() { calls++; await new Promise((resolve) => setImmediate(resolve)); return { policy: okPolicy, metadata: { fetchedAt: now } } } }, policyStore: store, bundledFixture: fixture, now: () => now, setTimer: timers.set, clearTimer: timers.clear })
  await service.start()
  assert.equal(calls, 1)
  assert.equal(service.getSnapshot().trustStatus, 'verified')
  assert.equal(service.getSnapshot().canAutoSchedule, true)
  assert.equal(service.getSnapshot().lastSuccessfulFetchAt, 1000)
  assert.deepEqual(service.getSnapshot().retryState, { failureCount: 0, retryAtUtcMs: null })
  service.stop()
})

test('failure preserves verified LKG as stale-verified and fixture cannot schedule', async () => {
  const store = memoryStore()
  const service = createPricingRefreshService({ fetcher: { async refresh() { throw Object.assign(new Error('parse failed'), { code: 'parse-error' }) } }, policyStore: store, bundledFixture: fixture, now: () => 5000, setTimer: fakeTimers().set, clearTimer: () => {}, retryDelaysMs: [300000] })
  await service.start()
  assert.equal(service.getSnapshot().trustStatus, 'bundled-fixture')
  assert.equal(service.getSnapshot().canAutoSchedule, false)
  assert.equal(service.getSnapshot().lastError.code, 'parse-error')
  service.stop()
})

test('unparsed response validators never suppress the first usable body after restart', async () => {
  const store = memoryStore()
  let captured
  let calls = 0
  const service = createPricingRefreshService({
    fetcher: { async refresh(options) { captured = options; calls++; if (calls === 1) throw Object.assign(new Error('changed markup'), { code: 'parse-error', metadata: { etag: '"unparsed"', lastModified: 'today' } }); return { policy: okPolicy } } },
    policyStore: store, bundledFixture: fixture, now: () => 1000, setTimer: fakeTimers().set, clearTimer: () => {},
  })
  await service.start()
  await service.refreshNow()
  assert.equal(captured.etag, null)
  assert.equal(captured.lastModified, null)
  assert.equal(service.getSnapshot().trustStatus, 'verified')
  service.stop()
})

test('failed response ETag never replaces the validator associated with LKG', async () => {
  const lkg = structuredClone(okPolicy)
  lkg.source.etag = '"lkg"'
  const initial = { schemaVersion: 1, lastKnownGood: lkg, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: 100, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: { etag: '"lkg"' } } }
  let now = 200
  let calls = 0
  const validators = []
  const service = createPricingRefreshService({
    fetcher: { async refresh(options) { validators.push(options.etag); calls++; if (calls <= 2) throw Object.assign(new Error('invalid html'), { code: 'parse-error', metadata: { etag: '"unparsed"' } }); return { policy: okPolicy } } },
    policyStore: memoryStore(initial), bundledFixture: fixture, now: () => now, setTimer: fakeTimers().set, clearTimer: () => {}, retryDelaysMs: [100, 200],
  })
  await service.start()
  now += 100
  await assert.rejects(service.refreshNow(), (error) => error.code === 'parse-error')
  assert.deepEqual(validators, ['"lkg"', '"lkg"'])
  service.stop()
})

test('verified LKG survives parse failure and the retry uses elapsed capped backoff', async () => {
  const lkg = structuredClone(okPolicy)
  lkg.source.etag = '"old"'
  const initial = { schemaVersion: 1, lastKnownGood: lkg, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: 100, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: { etag: '"old"' } } }
  const store = memoryStore(initial)
  const timers = fakeTimers()
  let now = 200
  let calls = 0
  let succeed = false
  let requestValidators
  const service = createPricingRefreshService({
    fetcher: { async refresh(options) { calls++; requestValidators = options; if (!succeed) throw Object.assign(new Error('invalid html'), { code: 'parse-error' }); return { policy: okPolicy } } },
    policyStore: store, bundledFixture: fixture, now: () => now, setTimer: timers.set, clearTimer: timers.clear, retryDelaysMs: [300000, 1800000, 7200000],
  })
  await service.start()
  const failed = await store.load()
  assert.equal(failed.lastKnownGood.policyId, okPolicy.policyId)
  assert.equal(failed.operational.trustStatus, 'stale-verified')
  assert.equal(service.getSnapshot().canAutoSchedule, true)
  assert.equal(requestValidators.etag, '"old"')
  assert.equal(failed.operational.retryState.retryAtUtcMs, now + 300000)
  succeed = true
  now += 300000
  await service.refreshNow()
  assert.equal(calls, 2)
  assert.equal(service.getSnapshot().trustStatus, 'verified')
  assert.equal(service.getSnapshot().lastSuccessfulFetchAt, now)
  assert.deepEqual(service.getSnapshot().retryState, { failureCount: 0, retryAtUtcMs: null })
  service.stop()
})

test('24-hour schedule is elapsed-time based, independent of local timezone and DST', async () => {
  let now = Date.parse('2026-03-29T00:00:00Z')
  let calls = 0
  const timers = fakeTimers()
  const initial = { schemaVersion: 1, lastKnownGood: okPolicy, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: now, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: null } }
  const service = createPricingRefreshService({ fetcher: { async refresh() { calls++; return { policy: okPolicy } } }, policyStore: memoryStore(initial), bundledFixture: fixture, now: () => now, setTimer: timers.set, clearTimer: timers.clear })
  await service.start()
  assert.equal(calls, 1)
  assert.equal([...timers.tasks.values()][0].delay, 86400000)
  service.stop()
  now += 86400000
  const dueTimers = fakeTimers()
  const next = createPricingRefreshService({ fetcher: { async refresh() { calls++; return { policy: okPolicy } } }, policyStore: memoryStore(initial), bundledFixture: fixture, now: () => now, setTimer: dueTimers.set, clearTimer: dueTimers.clear })
  await next.start()
  assert.equal(calls, 2) // Startup always refreshes, including after an elapsed 24h.
  next.stop()
  assert.equal(MS, 1)
})

test('manual refresh is available and starts a fresh 24-hour window', async () => {
  let now = 1000
  let calls = 0
  const timers = fakeTimers()
  const store = memoryStore()
  const service = createPricingRefreshService({ fetcher: { async refresh() { calls++; return { policy: okPolicy } } }, policyStore: store, bundledFixture: fixture, now: () => now, setTimer: timers.set, clearTimer: timers.clear })
  await service.start()
  now += 1234
  await service.refreshNow()
  assert.equal(calls, 2)
  assert.equal(service.getSnapshot().lastSuccessfulFetchAt, now)
  service.stop()
})

test('long-running service waits 23h59m, refreshes at 24h, and timezone changes do not move the deadline', async () => {
  let now = Date.parse('2026-03-28T12:00:00Z')
  let calls = 0
  const timers = fakeTimers()
  const service = createPricingRefreshService({ fetcher: { async refresh() { calls++; return { policy: okPolicy } } }, policyStore: memoryStore(), bundledFixture: fixture, now: () => now, setTimer: timers.set, clearTimer: timers.clear })
  const priorTz = process.env.TZ
  try {
    await service.start()
    assert.equal(calls, 1)
    assert.equal([...timers.tasks.values()][0].delay, 86400000)
    now += 86340000
    process.env.TZ = 'America/New_York'
    assert.equal(calls, 1)
    now += 60000
    await timers.runFirst()
    assert.equal(calls, 2)
    assert.equal([...timers.tasks.values()][0].delay, 86400000)
  } finally {
    if (priorTz === undefined) delete process.env.TZ
    else process.env.TZ = priorTz
    service.stop()
  }
})
