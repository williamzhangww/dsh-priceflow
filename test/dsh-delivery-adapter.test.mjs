import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshDeliveryAdapter } from '../src/delivery/dsh-delivery-adapter.mjs'

function item(sessionId = 'session-A') { return { id: 'q-1', sessionId, text: 'PRICEFLOW_DELIVERY_TEST_unit', targetPolicy: 'OFF-PEAK' } }

test('sessions.prompt adapter submits to exact session and reports host acceptance receipt', async () => {
  const calls = []
  const adapter = createDshDeliveryAdapter({
    apiProxy: { sessions: { async prompt(request) { calls.push(request); return { result: { ok: true, value: { accepted: true, messageId: 'msg-1' } } } } } },
    inspectSession: async (id) => ({ sessionId: id }), requestId: () => 'rpc-1', now: () => 123,
  })
  const receipt = await adapter.deliver(item())
  assert.deepEqual(calls[0], { rpcId: 'rpc-1', payload: { sessionId: 'session-A', mode: 'queue', content: [{ type: 'text', text: item().text }] } })
  assert.deepEqual(receipt, { accepted: true, requestId: 'rpc-1', backend: 'api-proxy', acceptedAtUtc: 123, hostResultMetadata: { messageId: 'msg-1' } })
})

test('sessionController.prompt fallback uses the official request shape and exact target', async () => {
  const calls = []
  const controller = {
    async prompt(request, signal) {
      calls.push({ request, hasAbortSignal: signal instanceof AbortSignal })
      return { accepted: true }
    },
  }
  const adapter = createDshDeliveryAdapter({
    getSessionController: () => controller,
    inspectSession: async (id) => ({ sessionId: id }),
    rpcId: () => 'request-1', now: () => 456,
  })
  assert.equal(adapter.supported, true)
  const queueItem = { ...item('session-B'), deliveryRequestId: 'persisted-req-1' }
  const receipt = await adapter.deliver(queueItem)
  assert.deepEqual(calls, [{
    request: {
      requestId: 'persisted-req-1',
      sessionId: 'session-B',
      mode: 'queue',
      content: [{ type: 'text', text: queueItem.text }],
    },
    hasAbortSignal: true,
  }])
  assert.deepEqual(receipt, { accepted: true, requestId: 'persisted-req-1', backend: 'session-controller', acceptedAtUtc: 456, hostResultMetadata: { messageId: null } })
})

test('sessionController is primary when both prompt APIs exist, and missing apiProxy does not degrade it', async () => {
  const calls = []
  const adapter = createDshDeliveryAdapter({
    sessionController: { async prompt(request) { calls.push(['controller', request.requestId]); return { accepted: true } } },
    apiProxy: { sessions: { async prompt() { calls.push(['legacy']); return { accepted: true } } } },
    inspectSession: async () => ({}),
  })
  assert.equal(adapter.backend, 'session-controller')
  assert.equal(adapter.supported, true)
  await adapter.deliver({ ...item(), deliveryRequestId: 'stable-queue-request' })
  assert.deepEqual(calls, [['controller', 'stable-queue-request']])

  const controllerOnly = createDshDeliveryAdapter({ sessionController: { prompt() {} }, inspectSession: async () => ({}) })
  assert.equal(controllerOnly.enabled, true)
  assert.equal(controllerOnly.backend, 'session-controller')
})

test('legacy apiProxy uses the persisted id as rpcId without a session-controller dedupe claim', async () => {
  const calls = []
  const adapter = createDshDeliveryAdapter({ apiProxy: { sessions: { async prompt(request) { calls.push(request); return { accepted: true } } } }, inspectSession: async () => ({}) })
  const legacyItem = { ...item(), deliveryRequestId: 'stable-legacy-correlation' }
  const receipt = await adapter.deliver(legacyItem)
  assert.equal(calls[0].rpcId, legacyItem.deliveryRequestId)
  assert.equal(receipt.backend, 'api-proxy')
  assert.equal(receipt.requestId, legacyItem.deliveryRequestId)
})

test('the same queue item retries with its persisted requestId and emits prompt-free attempt diagnostics', async () => {
  const calls = []; const diagnostics = []
  const adapter = createDshDeliveryAdapter({
    getSessionController: () => ({ async prompt(request) { calls.push(request.requestId); return { accepted: true } } }),
    inspectSession: async () => ({}), onDiagnostic: (event) => diagnostics.push(event),
  })
  const queued = { ...item(), deliveryRequestId: 'stable-retry-request', attemptCount: 1 }
  await adapter.deliver(queued)
  await adapter.deliver({ ...queued, attemptCount: 2 })
  assert.deepEqual(calls, ['stable-retry-request', 'stable-retry-request'])
  assert.deepEqual(diagnostics.map(({ event, requestId, attemptCount, backend }) => ({ event, requestId, attemptCount, backend })), [
    { event: 'delivery-attempt', requestId: 'stable-retry-request', attemptCount: 1, backend: 'session-controller' },
    { event: 'delivery-accepted', requestId: 'stable-retry-request', attemptCount: 1, backend: 'session-controller' },
    { event: 'delivery-attempt', requestId: 'stable-retry-request', attemptCount: 2, backend: 'session-controller' },
    { event: 'delivery-accepted', requestId: 'stable-retry-request', attemptCount: 2, backend: 'session-controller' },
  ])
  assert.equal(JSON.stringify(diagnostics).includes(queued.text), false)
})

test('sessionController capability can become available after host activation', () => {
  let controller = null
  const adapter = createDshDeliveryAdapter({ getSessionController: () => controller })
  assert.equal(adapter.enabled, false)
  controller = { prompt() {} }
  assert.equal(adapter.enabled, true)
})

test('unsupported API and unverified or absent sessions fail closed', async () => {
  const unsupported = createDshDeliveryAdapter({})
  assert.equal(unsupported.enabled, false)
  await assert.rejects(unsupported.deliver(item()), { code: 'unsupported-host-api', retryable: false })
  const noInspector = createDshDeliveryAdapter({ apiProxy: { sessions: { prompt() {} } } })
  await assert.rejects(noInspector.deliver(item()), { code: 'session-validation-unavailable', retryable: false })
  const missing = createDshDeliveryAdapter({ apiProxy: { sessions: { prompt() {} } }, inspectSession: async () => null })
  await assert.rejects(missing.deliver(item()), { code: 'session-not-found', retryable: false })
})

test('classifies transient host failure, malformed acceptance and session errors', async () => {
  const make = (response) => createDshDeliveryAdapter({ apiProxy: { sessions: { prompt: async () => response } }, inspectSession: async () => ({}) })
  await assert.rejects(make({ result: { ok: false, error: { code: 'host/unavailable', message: 'temporary' } } }).deliver(item()), { code: 'host/unavailable', category: 'transient', retryable: true })
  await assert.rejects(make({ result: { ok: true, value: { accepted: false } } }).deliver(item()), { code: 'malformed-host-result', retryable: false })
  await assert.rejects(make({ result: { ok: false, error: { code: 'session-not-found', message: 'missing' } } }).deliver(item()), { code: 'session-not-found', category: 'session', retryable: false })
})

test('adapter serializes concurrent direct submissions', async () => {
  let running = 0; let maxRunning = 0; let release
  const gate = new Promise((resolve) => { release = resolve })
  const adapter = createDshDeliveryAdapter({ apiProxy: { sessions: { async prompt() { running++; maxRunning = Math.max(maxRunning, running); await gate; running--; return { accepted: true } } } }, inspectSession: async () => ({}) })
  const one = adapter.deliver(item('session-A'))
  const two = adapter.deliver(item('session-B'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(maxRunning, 1)
  release(); await Promise.all([one, two])
  assert.equal(maxRunning, 1)
})
