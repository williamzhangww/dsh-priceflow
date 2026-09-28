import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPolicy, validatePolicy, computePolicyId, PolicyValidationError } from '../src/pricing/policy-schema.mjs'

const fixture = JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8'))

test('validates fixture and hashes only semantic policy fields', () => {
  const a = validatePolicy(fixture)
  const b = validatePolicy({ ...fixture, source: { ...fixture.source, fetchedAt: '2026-09-27T00:00:00.000Z', contentHash: 'sha256:other', etag: 'next' } })
  assert.equal(a.policyId, b.policyId)
  assert.match(a.policyId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(computePolicyId(a), a.policyId)
})

test('rejects wrong source, unsupported time basis, overlap, missing price and invalid currency', () => {
  const cases = [
    [() => validatePolicy({ ...fixture, source: { ...fixture.source, finalUrl: 'https://example.com/pricing' } }), 'untrusted-source'],
    [() => validatePolicy({ ...fixture, schedule: { ...fixture.schedule, timeBasis: 'Mars/Olympus' } }), 'unsupported-time-basis'],
    [() => validatePolicy({ ...fixture, schedule: { ...fixture.schedule, peakWindows: [{ startMinute: 60, endMinute: 200 }, { startMinute: 199, endMinute: 300 }] } }), 'overlapping-windows'],
    [() => validatePolicy({ ...fixture, currency: '¥' }), 'unknown-currency'],
    [() => validatePolicy({ ...fixture, models: { ...fixture.models, 'deepseek-flash': { ...fixture.models['deepseek-flash'], peak: { ...fixture.models['deepseek-flash'].peak, output: NaN } } } }), 'invalid-price'],
  ]
  for (const [fn, code] of cases) assert.throws(fn, (e) => e instanceof PolicyValidationError && e.code === code)
})

test('policy factory computes a valid policy id', () => {
  const data = { ...fixture }
  delete data.policyId
  assert.equal(createPolicy(data).policyId, validatePolicy(fixture).policyId)
})
