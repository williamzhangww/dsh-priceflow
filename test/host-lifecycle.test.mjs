import test from 'node:test'
import assert from 'node:assert/strict'
import { startPriceFlowWithLifecycle } from '../src/host/lifecycle.mjs'
import { registerPriceFlowRoutes, PRICEFLOW_STATE_ROUTE, PRICEFLOW_ACTION_ROUTE } from '../src/host/routes.mjs'

test('host lifecycle invokes start and effect cleanup invokes stop once', async () => {
  let effect
  let starts = 0
  let stops = 0
  startPriceFlowWithLifecycle({ effect(fn) { effect = fn } }, { async start() { starts++ }, async stop() { stops++ } })
  const cleanup = effect()
  await new Promise((resolve) => setImmediate(resolve))
  cleanup()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(starts, 1)
  assert.equal(stops, 1)
})

test('route scope effects register exact routes and own their disposers', () => {
  const registrations = []
  const effects = []
  const scope = {
    connection: { requestRejection() { return undefined } },
    webServer: { register(route) { registrations.push(route); return () => { registrations.splice(registrations.indexOf(route), 1) } } },
    effect(fn) { effects.push(fn()) },
  }
  registerPriceFlowRoutes(scope, { async getState() { return {} }, async refreshNow() { return { policy: { policyId: 'x' } } } })
  assert.equal(effects.length, 2)
  assert.deepEqual(registrations.map((route) => [route.kind, route.path]), [['exact', PRICEFLOW_STATE_ROUTE], ['exact', PRICEFLOW_ACTION_ROUTE]])
  assert.ok(registrations.every((route) => typeof route.handler === 'function'))
  assert.deepEqual(registrations.map((route) => route.path), ['/dsh-priceflow/state', '/dsh-priceflow/action'])
  for (const dispose of effects) dispose()
  assert.equal(registrations.length, 0)
})
