import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createOfficialPricingFetcher } from '../src/pricing/fetcher.mjs'

const html = await readFile(new URL('./fixtures/pricing-normalized.html', import.meta.url), 'utf8')
function response({ status = 200, body = html, url = 'https://api-docs.deepseek.com/quick_start/pricing/', headers = {} } = {}) {
  const normalized = { 'content-type': 'text/html; charset=utf-8', ...headers }
  return { status, ok: status >= 200 && status < 300, url, headers: { get: (name) => normalized[name.toLowerCase()] ?? null }, text: async () => body }
}

test('fetches only official pricing URL with timeout signal, UA, and validator headers', async () => {
  let captured
  const fetcher = createOfficialPricingFetcher({ fetchImpl: async (url, options) => { captured = { url, options }; return response({ headers: { etag: '"rev-1"', 'last-modified': 'Sat, 27 Sep 2026 10:00:00 GMT' } }) }, now: () => Date.parse('2026-09-27T10:00:00Z') })
  const result = await fetcher.refresh()
  assert.match(captured.url, /^https:\/\/api-docs\.deepseek\.com\//)
  assert.equal(captured.options.redirect, 'follow')
  assert.ok(captured.options.signal instanceof AbortSignal)
  assert.match(captured.options.headers['User-Agent'], /PriceFlow/)
  assert.equal(result.metadata.etag, '"rev-1"')
  assert.equal(result.policy.source.lastModified, 'Sat, 27 Sep 2026 10:00:00 GMT')
  assert.equal(result.metadata.status, 200)
  assert.equal(result.metadata.contentType, 'text/html; charset=utf-8')
  assert.equal(result.metadata.responseBytes, Buffer.byteLength(html))
  assert.match(result.metadata.contentHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(result.metadata.parserResult, 'passed')
  assert.equal(result.metadata.policyId, result.policy.policyId)
})

test('single-flight shares one fetch and response', async () => {
  let count = 0
  let release
  const wait = new Promise((resolve) => { release = resolve })
  const fetcher = createOfficialPricingFetcher({ fetchImpl: async () => { count++; await wait; return response() } })
  const a = fetcher.refresh()
  const b = fetcher.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(count, 1)
  release()
  assert.strictEqual(await a, await b)
})

test('sends conditional validators and accepts 304 metadata response', async () => {
  let options
  const fetcher = createOfficialPricingFetcher({ fetchImpl: async (_url, o) => { options = o; return response({ status: 304, headers: { etag: '"rev-2"' } }) }, cacheMetadata: () => ({ etag: '"rev-1"', lastModified: 'yesterday' }) })
  const out = await fetcher.refresh()
  assert.equal(options.headers['If-None-Match'], '"rev-1"')
  assert.equal(options.headers['If-Modified-Since'], 'yesterday')
  assert.equal(out.notModified, true)
  assert.equal(out.metadata.etag, '"rev-2"')
})

test('rejects external redirects, HTTP errors, parser errors, and abort timeout', async () => {
  const cases = [
    [async () => response({ url: 'https://evil.example/pricing' }), 'untrusted-redirect'],
    [async () => response({ status: 503 }), 'http-503'],
    [async () => response({ body: '<html>'.repeat(30) + '<h1>changed</h1></html>' }), 'missing-pricing-table'],
    [async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))) ), 'timeout'],
  ]
  for (const [fetchImpl, code] of cases) {
    const f = createOfficialPricingFetcher({ fetchImpl, timeoutMs: code === 'timeout' ? 5 : 100 })
    await assert.rejects(f.refresh(), (e) => e.code === code, code)
  }
})

test('captures safe response metadata when content type or strict parsing fails', async () => {
  const wrongType = createOfficialPricingFetcher({ fetchImpl: async () => response({ headers: { 'content-type': 'application/json' }, body: '{"hello":"world"}' }) })
  await assert.rejects(wrongType.refresh(), (error) => error.code === 'unexpected-content-type' && error.metadata.status === 200)
  const badHtml = createOfficialPricingFetcher({ fetchImpl: async () => response({ body: '<html>'.repeat(30) }) })
  await assert.rejects(badHtml.refresh(), (error) => error.code === 'missing-pricing-table' && error.metadata.parserResult === 'failed' && error.metadata.responseBytes > 0)
})

test('accepts official DeepSeek subdomain redirect', async () => {
  const f = createOfficialPricingFetcher({ fetchImpl: async () => response({ url: 'https://www.deepseek.com/pricing', body: html }) })
  assert.ok((await f.refresh()).policy.policyId)
})
