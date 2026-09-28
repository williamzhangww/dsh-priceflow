import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createPriceFlowRouteHandlers, MAX_ACTION_BODY_BYTES } from '../src/host/routes.mjs'

function request(method, body = '', headers = {}) {
  const req = Readable.from(body ? [body] : [])
  req.method = method
  req.headers = { host: '127.0.0.1:4567', ...headers }
  return req
}
function response() {
  return { headers: {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(body = '') { this.body = body } }
}
function decode(res) { return JSON.parse(res.body) }
const allowedConnection = { requestRejection() { return undefined } }

test('state route returns no-store snapshot and rejects cross-origin requests', async () => {
  const handlers = createPriceFlowRouteHandlers({ async getState() { return { service: { status: 'running' }, queue: { waiting: 1 } } }, async refreshNow() {} }, { connection: allowedConnection })
  const res = response()
  await handlers.state(request('GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.deepEqual(decode(res).data.queue, { waiting: 1 })
  const guarded = createPriceFlowRouteHandlers({ async getState() { return {} }, async refreshNow() {} }, { connection: { requestRejection(req) { return req.headers.origin === 'https://evil.example' ? 403 : undefined } } })
  const blocked = response()
  await guarded.state(request('GET', '', { origin: 'https://evil.example' }), blocked)
  assert.equal(blocked.status, 403)
  assert.equal(decode(blocked).error.code, 'connection-rejected')
})

test('action route accepts refreshPricing and rejects invalid method, schema, JSON, and content type', async () => {
  let calls = 0
  const handlers = createPriceFlowRouteHandlers({ async getState() { return {} }, async refreshNow() { calls++; return { trustStatus: 'verified', policy: { policyId: 'p1' }, livePricingValidation: 'passed' } } }, { connection: allowedConnection })
  const valid = response()
  await handlers.action(request('POST', '{"action":"refreshPricing"}', { 'content-type': 'application/json' }), valid)
  assert.equal(valid.status, 200)
  assert.equal(decode(valid).data.policyId, 'p1')
  assert.equal(calls, 1)
  for (const [req, expected] of [
    [request('GET'), 405],
    [request('POST', '{bad', { 'content-type': 'application/json' }), 400],
    [request('POST', '{"action":"nope"}', { 'content-type': 'application/json' }), 400],
    [request('POST', '{"action":"refreshPricing","extra":true}', { 'content-type': 'application/json' }), 400],
    [request('POST', '{}', { 'content-type': 'text/plain' }), 415],
  ]) {
    const res = response()
    await handlers.action(req, res)
    assert.equal(res.status, expected)
  }
  assert.equal(calls, 1)
})

test('action route enforces request body limit', async () => {
  const handlers = createPriceFlowRouteHandlers({ async getState() { return {} }, async refreshNow() { throw new Error('should not run') } }, { connection: allowedConnection })
  const res = response()
  await handlers.action(request('POST', ' '.repeat(MAX_ACTION_BODY_BYTES + 1), { 'content-type': 'application/json' }), res)
  assert.equal(res.status, 413)
  assert.equal(decode(res).error.code, 'body-too-large')
})

test('state and mutation routes fail closed without Connection admission', async () => {
  let mutations = 0
  const service = { async getState() { return {} }, async refreshNow() { mutations++; return {} }, async submitNow() { mutations++; return { accepted: true } } }
  for (const connection of [undefined, {}, { requestRejection() { return 401 } }, { requestRejection() { return 403 } }, { requestRejection() { throw Error('no admission') } }]) {
    const handlers = createPriceFlowRouteHandlers(service, { connection })
    const state = response(); await handlers.state(request('GET'), state)
    assert.ok([401, 403, 503].includes(state.status))
    const action = response(); await handlers.action(request('POST', '{"action":"refreshPricing"}', { 'content-type': 'application/json' }), action)
    assert.ok([401, 403, 503].includes(action.status))
    const send = response(); await handlers.action(request('POST', '{"action":"sendNow","args":{"sessionId":"session-A","text":"safe"}}', { 'content-type': 'application/json' }), send)
    assert.ok([401, 403, 503].includes(send.status))
  }
  assert.equal(mutations, 0)
})

test('Connection admission rejects bad Host, bad Origin, and missing browser authentication before mutation', async () => {
  let mutations = 0
  const service = { async getState() { return {} }, async refreshNow() { mutations++ } }
  const connection = { requestRejection(req) {
    if (req.headers.host !== '127.0.0.1:4567') return 403
    if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:4567') return 403
    if (!req.headers.cookie) return 401
    return undefined
  } }
  const handlers = createPriceFlowRouteHandlers(service, { connection })
  for (const headers of [{ host: 'evil.example', cookie: 'dsh_session=x' }, { origin: 'https://evil.example', cookie: 'dsh_session=x' }, {}]) {
    const res = response()
    await handlers.action(request('POST', '{"action":"refreshPricing"}', { 'content-type': 'application/json', ...headers }), res)
    assert.equal(res.status, headers.cookie && headers.host !== 'evil.example' ? 403 : headers.cookie ? 403 : 401)
  }
  assert.equal(mutations, 0)
})

test('authenticated actions validate exact action keys before dispatch', async () => {
  const seen = []
  const service = {
    async getState() { return {} }, async refreshNow() { return { trustStatus: 'verified', policy: { policyId: 'p' } } },
    async submitNow(args) { seen.push(['now', args]); return { accepted: true } },
    async submitOffPeakAware(args) { seen.push(['offpeak', args]); return { immediate: true } },
    async enqueue(args) { seen.push(['enqueue', args]); return { id: 'q1' } },
    async cancelQueueItem(id) { seen.push(['cancel', id]); return {} }, async retryQueueItem(id) { seen.push(['retry', id]); return {} },
  }
  const handlers = createPriceFlowRouteHandlers(service, { connection: allowedConnection })
  for (const action of ['sendNow', 'sendOffPeakAware', 'enqueue']) {
    const res = response(); await handlers.action(request('POST', JSON.stringify({ action, args: { sessionId: 'session-A', text: 'hello' } }), { 'content-type': 'application/json' }), res)
    assert.equal(res.status, 200)
  }
  for (const args of [{ sessionId: 'session-A', text: 'x', phase: 'OFF-PEAK' }, { sessionId: 'bad id', text: 'x' }, { sessionId: 'session-A', text: ' ' }]) {
    const res = response(); await handlers.action(request('POST', JSON.stringify({ action: 'enqueue', args }), { 'content-type': 'application/json' }), res)
    assert.equal(res.status, 400)
  }
  assert.equal(seen.length, 3)
  assert.equal(seen[0][0], 'now')
})
