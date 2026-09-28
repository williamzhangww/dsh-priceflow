import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyQueueState, migrateQueueState, recoverQueueState, transitionQueueItem } from '../src/queue/state-machine.mjs'
import { shouldAttemptDelivery } from '../src/queue/eligibility.mjs'
import { createQueueService, QueueLimitError } from '../src/queue/service.mjs'
import { createQueueStore } from '../src/storage/queue-store.mjs'
import { validatePolicy } from '../src/pricing/policy-schema.mjs'

const fixture = validatePolicy(JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8')))
const make = (overrides = {}) => ({ id: 'q1', deliveryRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'private prompt content', sessionId: 'session-1', createdAtUtc: 100, targetPolicy: 'OFF-PEAK', status: 'queued', attemptCount: 0, retryAtUtc: null, lastError: null, policyIdAtEnqueue: fixture.policyId, lease: null, submittedAtUtc: null, blockedReason: null, updatedAtUtc: 100, ...overrides })

test('state transitions are valid and terminal states reject further mutation', () => {
  const delivering = transitionQueueItem(make(), 'delivering', { now: 200, lease: { token: 'lease', expiresAtUtc: 300 } })
  assert.equal(delivering.attemptCount, 1)
  assert.equal(transitionQueueItem(delivering, 'submitted', { now: 250 }).submittedAtUtc, 250)
  assert.throws(() => transitionQueueItem(make(), 'submitted'), /invalid queue transition/)
  assert.throws(() => transitionQueueItem(transitionQueueItem(make(), 'cancelled'), 'queued'), /invalid queue transition/)
})

test('delivery eligibility trusts only the engine snapshot and verified trust state', () => {
  const item = make()
  const offpeakSnapshot = { phase: 'OFF-PEAK', canAutoSchedule: true, trustStatus: 'verified', policyId: fixture.policyId }
  const staleSnapshot = { ...offpeakSnapshot, trustStatus: 'stale-verified' }
  const fixtureSnapshot = { ...offpeakSnapshot, canAutoSchedule: false, trustStatus: 'bundled-fixture' }
  const peakSnapshot = { ...offpeakSnapshot, phase: 'PEAK' }
  assert.equal(shouldAttemptDelivery(item, Date.parse('2026-09-28T11:00:00Z'), offpeakSnapshot, fixture), true)
  assert.equal(shouldAttemptDelivery(item, Date.parse('2026-09-28T11:00:00Z'), staleSnapshot, fixture), true)
  assert.equal(shouldAttemptDelivery(item, Date.parse('2026-09-28T11:00:00Z'), fixtureSnapshot, fixture), false)
  assert.equal(shouldAttemptDelivery(item, Date.parse('2026-09-28T02:00:00Z'), peakSnapshot, fixture), false)
  assert.equal(shouldAttemptDelivery(make({ retryAtUtc: 300 }), 200, offpeakSnapshot, fixture), false)
})

test('restart recovery resets delivering to queued and preserves blocked and submitted history', () => {
  const state = { schemaVersion: 2, updatedAtUtc: 10, items: [make({ status: 'delivering', attemptCount: 1, lease: { token: 't', expiresAtUtc: 9999 } }), make({ id: 'q2', deliveryRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'blocked', blockedReason: 'missing session' }), make({ id: 'q3', deliveryRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'submitted', submittedAtUtc: 5 })] }
  const recovered = recoverQueueState(state, { now: 20 })
  assert.equal(recovered.items.find((i) => i.id === 'q1').status, 'queued')
  assert.equal(recovered.items.find((i) => i.id === 'q1').lastError, 'recovered-after-restart')
  assert.equal(recovered.items.find((i) => i.id === 'q2').status, 'blocked')
  assert.equal(recovered.items.find((i) => i.id === 'q3').status, 'submitted')
})

test('queue service start durably recovers in-flight items after simulated DSH restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-restart-')); t.after(() => rm(root, { recursive: true, force: true }))
  let generated = 0
  const recoveryEvents = []
  const stableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const store = createQueueStore(root, { requestId: () => { generated++; return stableId } })
  const oldItem = make({ status: 'delivering', attemptCount: 1, lease: { token: 'old-lease', expiresAtUtc: 999999 } })
  const legacy = { schemaVersion: 1, updatedAtUtc: 10, items: [{ ...oldItem, deliveryRequestId: undefined }] }
  delete legacy.items[0].deliveryRequestId
  await writeFile(store.path, JSON.stringify(legacy))
  const service = createQueueService({ store, settings: { deliveryLeaseMs: 120000 }, now: () => 20, id: () => 'new', requestId: () => { generated++; return stableId }, logger: (event) => recoveryEvents.push(event) })
  await service.start()
  const restored = await store.load()
  assert.equal(restored.schemaVersion, 2)
  assert.equal(restored.items[0].deliveryRequestId, stableId)
  assert.equal(generated, 1)
  assert.equal(restored.items[0].status, 'queued')
  assert.equal(restored.items[0].lastError, 'recovered-after-restart')
  assert.deepEqual(recoveryEvents, [{ event: 'queue-transition', itemId: 'q1', from: 'delivering', to: 'queued', attemptCount: 1, code: 'recovered-after-restart' }])
  const restartedAgain = await createQueueStore(root).load()
  assert.equal(restartedAgain.items[0].deliveryRequestId, stableId)
  assert.equal(generated, 1)
})

test('queue schema migration creates and persists one request id per legacy item', () => {
  const legacy = { schemaVersion: 1, updatedAtUtc: 4, items: [{ ...make(), deliveryRequestId: undefined }] }
  delete legacy.items[0].deliveryRequestId
  const ids = ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']
  const migrated = migrateQueueState(legacy, () => ids.shift())
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.items[0].deliveryRequestId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
})

test('distinct queue items get distinct request ids that survive service restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-request-ids-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = createQueueStore(root)
  let id = 0
  const service = createQueueService({ store, now: () => 200, id: () => `q-${++id}` })
  const first = await service.enqueue({ text: 'first', sessionId: 'session-1' })
  const second = await service.enqueue({ text: 'second', sessionId: 'session-1' })
  assert.notEqual(first.deliveryRequestId, second.deliveryRequestId)
  assert.match(first.deliveryRequestId, /^[0-9a-f-]{36}$/i)
  assert.match(second.deliveryRequestId, /^[0-9a-f-]{36}$/i)
  const restarted = createQueueService({ store, now: () => 300 })
  await restarted.start()
  const persisted = await restarted.snapshot()
  assert.equal(persisted.items.find((item) => item.id === first.id).deliveryRequestId, first.deliveryRequestId)
  assert.equal(persisted.items.find((item) => item.id === second.id).deliveryRequestId, second.deliveryRequestId)
})

test('queue service persists enqueue, delivery, submission, block, cancel, and recovers after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-queue-')); t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-09-28T11:00:00Z')
  let serial = 0
  const store = createQueueStore(root)
  const service = createQueueService({ store, settings: { queueMaxItems: 2, deliveryLeaseMs: 1000 }, now: () => now, id: () => `id-${++serial}` })
  const item = await service.enqueue({ text: 'secret prompt', sessionId: 'session-abc', policyId: fixture.policyId })
  assert.equal((await store.load()).items[0].status, 'queued')
  const snapshot = { phase: 'OFF-PEAK', canAutoSchedule: true, trustStatus: 'verified', policyId: fixture.policyId }
  const delivering = await service.beginDelivery(item.id, { policy: fixture, pricingSnapshot: snapshot })
  assert.equal(delivering.status, 'delivering')
  assert.equal((await store.load()).items[0].status, 'delivering')
  await service.markSubmitted(item.id)
  assert.equal((await store.load()).items[0].status, 'submitted')
  await service.enqueue({ text: 'another', sessionId: 'session-abc' }).then(async (second) => { await service.block(second.id, 'session absent'); assert.equal((await store.load()).items.find((v) => v.id === second.id).status, 'blocked') })
  await service.enqueue({ text: 'third', sessionId: 'session-abc' })
  await assert.rejects(service.enqueue({ text: 'fourth', sessionId: 'session-abc' }), QueueLimitError)
  const state = await service.snapshot()
  assert.ok(!JSON.stringify(state).includes('not logged?'))
  const cancelSvc = createQueueService({ store, settings: { queueMaxItems: 4 }, now: () => now, id: () => `id-${++serial}` })
  const cancellable = await cancelSvc.enqueue({ text: 'cancel me', sessionId: 'session-abc' })
  await cancelSvc.cancel(cancellable.id)
  assert.equal((await store.load()).items.find((v) => v.id === cancellable.id).status, 'cancelled')
})

test('queue does not write message content into state transition logs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-logs-')); t.after(() => rm(root, { recursive: true, force: true }))
  const messages = []
  const service = createQueueService({ store: createQueueStore(root), now: () => 1, id: () => 'q-private', logger: (event) => messages.push(event) })
  const item = await service.enqueue({ text: 'secret-very-private-content', sessionId: 'session-x' })
  assert.equal(item.text, 'secret-very-private-content')
  assert.equal(JSON.stringify(messages).includes('secret-very-private-content'), false)
})
