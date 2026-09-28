import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPriceFlowHostService, resolvePriceFlowStorageRoot } from '../src/host/service.mjs'
import { createPolicyStore } from '../src/storage/policy-store.mjs'
import { createQueueStore } from '../src/storage/queue-store.mjs'
import { createQueueService } from '../src/queue/service.mjs'
import { validateSettings, DEFAULT_SETTINGS } from '../src/storage/settings-store.mjs'
import { createPolicy } from '../src/pricing/policy-schema.mjs'
import { getPricingSnapshot } from '../src/pricing/engine.mjs'

const html = await readFile(new URL('./fixtures/pricing-normalized.html', import.meta.url), 'utf8')
const fixture = JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8'))
const calendar = JSON.parse(await readFile(new URL('../src/pricing/fixtures/cn-public-holidays-2026.json', import.meta.url), 'utf8'))
const nowValue = Date.parse('2026-09-27T12:00:00.000Z')
function fakeTimers() {
  let id = 0
  const tasks = new Map()
  return { tasks, set(fn, delay) { const key = ++id; tasks.set(key, { fn, delay }); return key }, clear(key) { tasks.delete(key) } }
}
function response(body = html) {
  return { ok: true, status: 200, url: 'https://api-docs.deepseek.com/quick_start/pricing/', headers: { get: (name) => ({ 'content-type': 'text/html; charset=utf-8', etag: '"host-test"' })[name.toLowerCase()] ?? null }, async text() { return body } }
}
function verified(policy = fixture) {
  return createPolicy({ ...policy, source: { ...policy.source, fetchedAt: new Date(nowValue).toISOString(), contentHash: 'sha256:host-fixture' } })
}

test('host service is isolated, starts once, loads LKG before startup refresh, and stops its timers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lkg = verified()
  lkg.source.etag = '"last-known-good"'
  const policyStore = createPolicyStore(root)
  await policyStore.save({ schemaVersion: 1, lastKnownGood: lkg, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: nowValue - 1, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: { etag: '"last-known-good"' }, livePricingValidation: 'passed' } })
  let fetchCount = 0
  let validator
  const timers = fakeTimers()
  const service = createPriceFlowHostService({ storageRoot: root, now: () => nowValue, setTimer: timers.set, clearTimer: timers.clear, holidayCalendars: [calendar], fetchImpl: async (_url, options) => { fetchCount++; validator = options.headers['If-None-Match']; assert.equal((await policyStore.load()).lastKnownGood.policyId, lkg.policyId); return response() } })
  const first = await service.start()
  await service.start()
  assert.equal(fetchCount, 1)
  assert.equal(validator, '"last-known-good"')
  assert.equal(first.trustStatus, 'verified')
  const state = await service.getState()
  assert.equal(state.service.status, 'running')
  assert.equal(state.pricing.canAutoSchedule, true)
  assert.equal(state.calendar.trust, 'official-bundled')
  assert.equal(state.modelPricing.modelId, null)
  assert.equal(state.modelPricing.prices, null)
  assert.equal(state.pricing.sourceUrl, 'https://api-docs.deepseek.com/quick_start/pricing/')
  assert.deepEqual(state.queue, { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0, cancelled: 0 })
  assert.ok(!JSON.stringify(state).includes('prompt'))
  assert.equal(resolvePriceFlowStorageRoot({ home: 'X:/isolated', env: {} }), join('X:/isolated', '.dsh', 'priceflow'))
  assert.equal(resolvePriceFlowStorageRoot({ env: { DSH_HOME: 'X:/temporary-dsh' }, home: 'unused' }), join('X:/temporary-dsh', 'priceflow'))
  assert.equal(resolvePriceFlowStorageRoot({ storageRoot: root, env: { DSH_HOME: 'unused' } }), root)
  assert.ok(timers.tasks.size >= 1)
  await service.stop()
  assert.equal((await service.getState()).service.status, 'stopped')
  assert.equal(timers.tasks.size, 0)
  const persisted = JSON.parse(await readFile(join(root, 'policy-cache.json'), 'utf8'))
  assert.equal(persisted.operational.livePricingValidation, 'passed')
})

test('startup refresh failure keeps isolated host alive on stale LKG and returns warning metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-host-fail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const policyStore = createPolicyStore(root)
  await policyStore.save({ schemaVersion: 1, lastKnownGood: verified(), operational: { trustStatus: 'verified', lastSuccessfulFetchAt: nowValue - 86400000, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: null } })
  const timers = fakeTimers()
  const service = createPriceFlowHostService({ storageRoot: root, now: () => nowValue, setTimer: timers.set, clearTimer: timers.clear, holidayCalendars: [calendar], fetchImpl: async () => { const error = Object.assign(new Error('network unavailable'), { code: 'network-error', metadata: { status: 503, parserResult: 'not-run' } }); throw error } })
  await service.start()
  const state = await service.getState()
  assert.equal(state.service.status, 'running')
  assert.equal(state.pricing.trustStatus, 'stale-verified')
  assert.equal(state.sync.livePricingValidation, 'failed')
  assert.equal(state.sync.stale, true)
  assert.equal(state.sync.fetch.status, 503)
  assert.equal(state.pricing.canAutoSchedule, true)
  await service.stop()
  assert.equal(timers.tasks.size, 0)
})

test('off-peak-aware submission enqueues through the host service and delivers immediately during trusted off-peak', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-host-offpeak-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const policyStore = createPolicyStore(root)
  await policyStore.save({ schemaVersion: 1, lastKnownGood: verified(), operational: { trustStatus: 'verified', lastSuccessfulFetchAt: nowValue - 1, lastAttemptAt: null, lastError: null, retryState: { failureCount: 0, retryAtUtcMs: null }, semanticDiff: null, lastFetchMetadata: null, livePricingValidation: 'passed' } })
  const timers = fakeTimers()
  const delivered = []
  const deliveryAdapter = {
    enabled: true,
    supported: true,
    async validateSession() { return true },
    async deliver(item) { delivered.push(item); return { accepted: true, acceptedAtUtc: nowValue } },
  }
  const service = createPriceFlowHostService({ storageRoot: root, now: () => nowValue, setTimer: timers.set, clearTimer: timers.clear, holidayCalendars: [calendar], fetchImpl: async () => { throw new Error('offline') }, deliveryAdapter })
  await service.start()
  const result = await service.submitOffPeakAware({ sessionId: 'session-offpeak', text: 'isolated off-peak submission' })
  assert.equal(result.immediate, true)
  assert.equal(result.item.status, 'submitted')
  assert.equal(result.item.attemptCount, 1)
  assert.equal(result.item.submittedAtUtc, nowValue)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sessionId, 'session-offpeak')
  await service.stop()
})

test('isolated queue persistence recovers an in-flight item across host restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-host-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createQueueStore(root)
  const queue = createQueueService({ store, settings: validateSettings(DEFAULT_SETTINGS), now: () => nowValue, id: () => 'restart-id' })
  await queue.start()
  await queue.enqueue({ text: 'private queued prompt', sessionId: 'session-1', policyId: fixture.policyId })
  const livePolicy = verified()
  const pricing = getPricingSnapshot(nowValue, livePolicy, null, { trustStatus: 'verified', canAutoSchedule: true }, { holidayCalendars: [calendar] })
  await queue.beginDelivery('restart-id', { policy: livePolicy, pricingSnapshot: pricing })
  const timers = fakeTimers()
  const service = createPriceFlowHostService({ storageRoot: root, now: () => nowValue, setTimer: timers.set, clearTimer: timers.clear, holidayCalendars: [calendar], fetchImpl: async () => { throw new Error('offline') } })
  await service.start()
  const state = await service.getState()
  assert.equal(state.queue.waiting, 1)
  assert.equal(state.queue.delivering, 0)
  assert.ok(!JSON.stringify(state).includes('private queued prompt'))
  assert.equal((await service.queueService.snapshot()).items[0].lastError, 'recovered-after-restart')
  await service.stop()
})
