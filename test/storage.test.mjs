import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAtomicJsonStore } from '../src/storage/atomic-json.mjs'
import { createPolicyStore } from '../src/storage/policy-store.mjs'
import { createQueueStore } from '../src/storage/queue-store.mjs'
import { createSettingsStore } from '../src/storage/settings-store.mjs'
import { createHostLogger } from '../src/storage/host-log.mjs'
import { emptyQueueState } from '../src/queue/state-machine.mjs'
import { readFile as readNodeFile } from 'node:fs/promises'

async function temp() { return mkdtemp(join(tmpdir(), 'priceflow-')) }

test('atomic JSON writes, reads, serializes concurrent updates, and falls back to backup', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'state.json')
  const store = createAtomicJsonStore(file)
  await store.write({ value: 1 })
  assert.deepEqual(await store.read(), { value: 1 })
  await Promise.all(Array.from({ length: 20 }, () => store.update((v) => ({ value: v.value + 1 }))))
  assert.deepEqual(await store.read(), { value: 21 })
  await store.write({ value: 22 })
  await writeFile(file, '{corrupted', 'utf8')
  assert.deepEqual(await store.read(), { value: 21 }) // backup is the previous committed state
})

test('failed validation leaves the previous atomic file intact', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'atomic.json')
  const store = createAtomicJsonStore(file, { validate(value) { if (!Number.isInteger(value.value)) throw new TypeError('value must be integer'); return value } })
  await store.write({ value: 1 })
  await assert.rejects(store.write({ value: 'bad' }), /value must be integer/)
  assert.deepEqual(await store.read(), { value: 1 })
})

test('update after main file removal recovers and preserves backup data', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'recover.json')
  const store = createAtomicJsonStore(file)
  await store.write({ value: 1 })
  await store.write({ value: 2 })
  await rm(file)
  await store.update((current) => ({ value: current.value + 1 }))
  assert.deepEqual(await store.read(), { value: 2 })
})

test('missing main recovers backup; two corrupt files fail explicitly and update refuses overwrite', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'x.json')
  const store = createAtomicJsonStore(file)
  await store.write({ ok: true })
  await store.write({ ok: true, revision: 2 })
  await rm(file)
  assert.deepEqual(await store.read(), { ok: true })
  await writeFile(file, 'broken')
  await writeFile(`${file}.bak`, 'also broken')
  await assert.rejects(store.read(), (e) => e.code === 'corrupt-main-and-backup')
  await assert.rejects(store.update(() => ({ unsafe: true })), (e) => e.code === 'corrupt-main-and-backup')
})

test('separate stores keep policy, queue, and settings files independent', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const policy = createPolicyStore(root)
  const queue = createQueueStore(root)
  const settings = createSettingsStore(root)
  await policy.save({ schemaVersion: 1, lastKnownGood: null, operational: { trustStatus: 'bundled-fixture', lastSuccessfulFetchAt: null, retryState: { failureCount: 0, retryAtUtcMs: null } } })
  await queue.save(emptyQueueState(1))
  await settings.save(await settings.load())
  const policyBefore = await readFile(policy.path, 'utf8')
  await queue.save({ schemaVersion: 2, items: [], updatedAtUtc: 2 })
  assert.equal(await readFile(policy.path, 'utf8'), policyBefore)
  const queueBefore = await readFile(queue.path, 'utf8')
  await policy.save(await policy.load())
  assert.equal(await readFile(queue.path, 'utf8'), queueBefore)
  const contents = await Promise.all([policy.path, queue.path, settings.path].map((p) => readNodeFile(p, 'utf8')))
  assert.equal(contents.length, 3)
})

test('settings defaults include fixed 24h interval and queue bound', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const settings = createSettingsStore(root)
  assert.equal((await settings.load()).refreshIntervalMs, 86400000)
  assert.equal((await settings.load()).queueMaxItems, 100)
})

test('host logger serializes only allowlisted diagnostics and never writes prompt text', async (t) => {
  const root = await temp(); t.after(() => rm(root, { recursive: true, force: true }))
  const logger = createHostLogger(root, { maxBytes: 4096 })
  await logger.write({ event: 'queue-transition', itemId: 'q1', from: 'queued', to: 'delivering', text: 'very secret prompt' })
  await logger.write({ event: 'delivery-attempt', itemId: 'q1', requestId: 'stable-request', backend: 'session-controller', attemptCount: 2, text: 'very secret prompt' })
  await logger.write({ event: 'cny-pricing-refresh-failure', code: 'missing-cny-model-metadata', cnyDiagnostic: { httpStatus: 200, parserStage: 'model-metadata', containsDeepseekFlash: true, metadataRowsSameTable: true, modelValueCellsWithNestedMarkupCount: 2, modelCandidateCellCount: 4, recognizedModelIdCount: 2, structuralNonModelCellCount: 2, metadataFailureReason: 'model-version-count-mismatch', bodySha256: 'sha256:abc', html: '<secret html>', cellText: 'private response content', apiKey: 'secret-key', authorization: 'Bearer secret' } })
  const contents = await readFile(logger.path, 'utf8')
  assert.equal(contents.includes('very secret prompt'), false)
  assert.match(contents, /queue-transition/)
  assert.match(contents, /stable-request/)
  assert.match(contents, /session-controller/)
  assert.match(contents, /"parserStage":"model-metadata"/)
  assert.match(contents, /"containsDeepseekFlash":true/)
  assert.match(contents, /"metadataRowsSameTable":true/)
  assert.match(contents, /"modelValueCellsWithNestedMarkupCount":2/)
  assert.match(contents, /"metadataFailureReason":"model-version-count-mismatch"/)
  assert.match(contents, /"structuralNonModelCellCount":2/)
  assert.equal(contents.includes('<secret html>'), false)
  assert.equal(contents.includes('private response content'), false)
  assert.equal(contents.includes('secret-key'), false)
  assert.equal(contents.includes('Bearer secret'), false)
})
