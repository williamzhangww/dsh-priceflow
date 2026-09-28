import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekBalanceFetcher, createBalanceMemoryService, validateBalanceResponse } from '../src/pricing/balance-fetcher.mjs'

const entry = (currency, total = '1.00', topped = '0.50', granted = '0.50') => ({ currency, total_balance: total, topped_up_balance: topped, granted_balance: granted })
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('validates CNY-only, USD-only, dual-currency, and a real zero balance distinctly from absence', () => {
  assert.deepEqual(Object.keys(validateBalanceResponse({ is_available: true, balance_infos: [entry('CNY')] }).currencies), ['CNY'])
  assert.deepEqual(Object.keys(validateBalanceResponse({ is_available: true, balance_infos: [entry('USD')] }).currencies), ['USD'])
  const both = validateBalanceResponse({ is_available: true, balance_infos: [entry('USD'), entry('CNY')] })
  assert.equal(both.currencies.USD.totalBalance, '1.00')
  assert.equal(validateBalanceResponse({ is_available: true, balance_infos: [entry('USD', '0.00', '0.00', '0.00')] }).currencies.USD.totalBalance, '0.00')
})

test('balance schema rejects malformed amounts and duplicate known currencies, ignores future currencies', () => {
  assert.throws(() => validateBalanceResponse({ is_available: true, balance_infos: [entry('CNY', 'NaN')] }), { code: 'invalid-balance-body' })
  assert.throws(() => validateBalanceResponse({ is_available: true, balance_infos: [entry('CNY'), entry('CNY')] }), /duplicate/)
  const value = validateBalanceResponse({ is_available: true, balance_infos: [entry('EUR'), entry('USD')] })
  assert.deepEqual(Object.keys(value.currencies), ['USD'])
  assert.equal(validateBalanceResponse({ is_available: false, balance_infos: [] }).isAvailable, false)
})

test('balance fetch uses official endpoint, bearer auth only at Host, timeout and safe errors', async () => {
  const calls = []
  const fetcher = createDeepSeekBalanceFetcher({ resolveCredential: async () => ({ value: 'host-secret-key', source: 'test' }), fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ is_available: true, balance_infos: [entry('CNY')] }) } })
  const result = await fetcher.refresh()
  assert.equal(result.currencies.CNY.totalBalance, '1.00')
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer host-secret-key')
  const missing = createDeepSeekBalanceFetcher({ resolveCredential: async () => undefined, fetchImpl: async () => { throw Error('must not fetch') } })
  await assert.rejects(missing.refresh(), (error) => error.code === 'missing-credential' && !error.message.includes('DEEPSEEK_API_KEY'))
  for (const status of [401, 429, 500]) {
    const failing = createDeepSeekBalanceFetcher({ resolveCredential: async () => 'secret', fetchImpl: async () => response({}, status) })
    await assert.rejects(failing.refresh(), (error) => error.code === `http-${status}` && !error.message.includes('secret'))
  }
  const invalidJson = createDeepSeekBalanceFetcher({ resolveCredential: async () => 'secret', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw Error('secret leaked?') } }) })
  await assert.rejects(invalidJson.refresh(), (error) => error.code === 'invalid-balance-body' && !error.message.includes('secret'))
})

test('balance memory cache honors TTL, force refresh, and single-flight', async () => {
  let now = 10_000
  let calls = 0
  let finish
  const service = createBalanceMemoryService({ now: () => now, fetcher: { refresh: async () => { calls++; if (calls === 1) return validateBalanceResponse({ is_available: true, balance_infos: [entry('CNY')] }); await new Promise((resolve) => { finish = resolve }); return validateBalanceResponse({ is_available: true, balance_infos: [entry('CNY', '2.00')] }) } } })
  await service.refresh()
  await service.refresh()
  assert.equal(calls, 1)
  now += 60_001
  const a = service.refresh()
  const b = service.refresh({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  finish()
  const [one, two] = await Promise.all([a, b])
  assert.equal(one.currencies.CNY.totalBalance, '2.00')
  assert.equal(two.status, 'available')
})

test('balance refresh failure preserves successful data without including amounts in status errors', async () => {
  let fail = false
  const service = createBalanceMemoryService({ fetcher: { refresh: async () => { if (fail) throw Object.assign(Error('host-secret-key'), { code: 'http-500' }); return validateBalanceResponse({ is_available: true, balance_infos: [entry('USD', '12.34')] }) } } })
  const success = await service.refresh()
  fail = true
  const stale = await service.refresh({ force: true })
  assert.equal(stale.status, 'stale')
  assert.equal(stale.currencies.USD.totalBalance, '12.34')
  assert.doesNotMatch(JSON.stringify({ status: stale.status, error: stale.lastErrorCode }), /host-secret-key|12\.34/)
  assert.equal(success.status, 'available')
})
