import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as plugin from '../index.js'

test('package metadata declares bounded DSH 0.2.x compatibility without a lockstep host peer', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.2.2')
  assert.equal(manifest.engines.node, '>=20')
  assert.equal(manifest.engines.dsh, '>=0.2.0-rc.1 <0.3.0-0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.2')
  assert.equal(manifest.dsh.engines?.dsh, undefined)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.client, { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-conversation'] })
})

test('rc.2 Cordis injection surface registers Host routes without starting a real queue', () => {
  const routes = []
  const effects = []
  const services = {
    sessionController: { inspect: async () => null, prompt: async () => ({ accepted: true }) },
    webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
    connection: { requestRejection() { return undefined } },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return services[name] },
    effect(effect, label) {
      effects.push(label)
      if (label?.includes('route')) return effect()
      return () => {}
    },
    inject(names, callback) {
      const scope = { effect: this.effect.bind(this) }
      for (const name of names) scope[name] = services[name]
      callback(scope)
      return () => {}
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(routes.map(({ kind, path }) => [kind, path]), [
    ['exact', '/dsh-priceflow/state'],
    ['exact', '/dsh-priceflow/action'],
  ])
  assert.ok(effects.includes('dsh-priceflow: host service'))
  assert.ok(effects.includes('dsh-priceflow: state route'))
  assert.ok(effects.includes('dsh-priceflow: action route'))
})
