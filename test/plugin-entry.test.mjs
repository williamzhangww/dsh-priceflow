import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

test('DSH plugin entry keeps Cordis metadata visible on the named namespace', () => {
  assert.equal(plugin.name, 'dsh-priceflow')
  assert.deepEqual(plugin.inject, [])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(Object.hasOwn(plugin, 'default'), false)
})
