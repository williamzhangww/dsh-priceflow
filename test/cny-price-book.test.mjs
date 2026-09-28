import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseOfficialCnyPricingHtml, formatDecimalAmount, isCnyBookCompatible } from '../src/pricing/cny-price-book.mjs'
import { validatePolicy } from '../src/pricing/policy-schema.mjs'
import { validateCnyBookCache, createCnyBookStore } from '../src/storage/cny-book-store.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficialCnyPricingFetcher, createCnyPriceBookService } from '../src/pricing/cny-refresh-service.mjs'
import { createHash } from 'node:crypto'

const html = await readFile(new URL('./fixtures/pricing-cny-official.html', import.meta.url), 'utf8')
const primary = validatePolicy(JSON.parse(await readFile(new URL('../src/pricing/fixtures/official-current.json', import.meta.url), 'utf8')))
const meta = { fetchedAt: '2026-09-28T10:00:00.000Z' }

test('official CNY fixture parses separate exact decimal prices by model and phase', () => {
  const book = parseOfficialCnyPricingHtml(html, meta)
  assert.equal(book.currency, 'CNY')
  assert.equal(book.models['deepseek-flash'].peak.cacheHitInput, '0.04')
  assert.equal(book.models['deepseek-flash'].offpeak.cacheMissInput, '1')
  assert.equal(book.models['deepseek-v4-pro'].peak.output, '27.0')
  assert.equal(isCnyBookCompatible(book, primary), true)
  assert.equal(formatDecimalAmount(book.models['deepseek-flash'].peak.cacheHitInput, 'CNY'), '¥0.04')
  assert.equal(formatDecimalAmount('10000', 'USD'), '$10,000.00')
})

test('parses localized Chinese model metadata from official pricing structure', () => {
  assert.match(html, /模型/)
  assert.match(html, /模型版本/)
  assert.match(html, /deepseek-flash/)
  assert.match(html, /DeepSeek-V4\.1-Flash/)
  const book = parseOfficialCnyPricingHtml(html, meta)
  const flash = book.models['deepseek-flash']
  assert.equal(flash.displayName, 'DeepSeek-V4.1-Flash')
  assert.deepEqual(flash.offpeak, { cacheHitInput: '0.02', cacheMissInput: '1', output: '4' })
  assert.deepEqual(flash.peak, { cacheHitInput: '0.04', cacheMissInput: '2', output: '8' })
  assert.equal(book.currency, 'CNY')
  assert.equal(book.unit, 'per_1m_tokens')
})

test('missing localized model id or version metadata remains fail-closed', () => {
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('<td>模型​</td>', '<td>型号​</td>'), meta), { code: 'missing-cny-model-metadata' })
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('<td>模型版本​</td>', '<td>版本​</td>'), meta), { code: 'missing-cny-model-metadata' })
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('DeepSeek-V4.1-Flash', ''), meta), { code: 'missing-cny-model-metadata' })
})

test('ignores structural non-model cells and pairs model versions by original column index', () => {
  assert.match(html, /<tr><td>模型[\s\S]*?<\/tr>/)
  const book = parseOfficialCnyPricingHtml(html, meta)
  assert.equal(Object.keys(book.models).length, 2)
  assert.equal(book.models['deepseek-flash'].displayName, 'DeepSeek-V4.1-Flash')
  assert.equal(book.models['deepseek-v4-pro'].displayName, 'DeepSeek-V4-Pro-0813')
  assert.equal(Object.hasOwn(book.models, '标准模型'), false)
  assert.equal(Object.hasOwn(book.models, '模型说明'), false)
  assert.equal(Object.hasOwn(book.models, '通用版本'), false)
  assert.equal(Object.hasOwn(book.models, '版本说明'), false)
})

test('selected model columns reject missing versions and duplicate model IDs', () => {
  let missingVersion
  try { parseOfficialCnyPricingHtml(html.replace('<td>DeepSeek-V4-Pro-0813</td>', ''), meta) } catch (error) { missingVersion = error }
  assert.equal(missingVersion?.code, 'missing-cny-model-metadata')
  assert.equal(missingVersion?.metadataDiagnostic?.metadataFailureReason, 'missing-version-for-model-column')
  assert.equal(missingVersion?.metadataDiagnostic?.modelCandidateCellCount, 4)
  assert.equal(missingVersion?.metadataDiagnostic?.recognizedModelIdCount, 2)
  assert.equal(missingVersion?.metadataDiagnostic?.structuralNonModelCellCount, 2)
  assert.equal(missingVersion?.metadataDiagnostic?.modelIdsInvalidCount, 0)
  assert.equal(missingVersion?.metadataDiagnostic?.modelVersionCountEqual, false)
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('<td>DeepSeek-V4.1-Flash</td>', '<td></td>'), meta), { code: 'missing-cny-model-metadata' })
  const duplicate = html.replace('<td>deepseek-v4-pro</td>', '<td>deepseek-flash</td>')
  let duplicateId
  try { parseOfficialCnyPricingHtml(duplicate, meta) } catch (error) { duplicateId = error }
  assert.equal(duplicateId?.code, 'missing-cny-model-metadata')
  assert.equal(duplicateId?.metadataDiagnostic?.metadataFailureReason, 'duplicate-model-id')
  assert.equal(duplicateId?.metadataDiagnostic?.modelIdsUnique, false)
})

test('CNY parser rejects ambiguous tables, malformed decimals, missing values and model conflicts', () => {
  assert.throws(() => parseOfficialCnyPricingHtml(html + html.match(/<table data-priceflow="pricing">[\s\S]*?<\/table>/)[0], meta), /one official CNY pricing table/)
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('0.04元', '4e-2元'), meta), { code: 'invalid-cny-number' })
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('13.5元', ''), meta), /plain decimal|price row does not match/)
  assert.throws(() => parseOfficialCnyPricingHtml(html.replace('<td>deepseek-v4-pro</td>', '<td>deepseek-other</td>'), meta), /compatib|conflict|model columns/)
})

test('legacy policy cache remains independent and CNY LKG compatibility fails closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-cny-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createCnyBookStore(root)
  assert.equal(await store.load(), null)
  const book = parseOfficialCnyPricingHtml(html, meta)
  const saved = validateCnyBookCache({ schemaVersion: 1, lastKnownGood: book, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: 1 } })
  await store.save(saved)
  assert.equal((await store.load()).lastKnownGood.models['deepseek-flash'].displayName, 'DeepSeek-V4.1-Flash')
  assert.equal(isCnyBookCompatible(book, { ...primary, models: { ...primary.models, 'deepseek-flash': { ...primary.models['deepseek-flash'], displayName: 'conflict' } } }), false)
})

test('CNY refresh failure preserves compatible verified LKG independently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'priceflow-cny-refresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createCnyBookStore(root)
  const book = parseOfficialCnyPricingHtml(html, meta)
  await store.save({ schemaVersion: 1, lastKnownGood: book, operational: { trustStatus: 'verified', lastSuccessfulFetchAt: 1 } })
  const fetcher = createOfficialCnyPricingFetcher({ fetchImpl: async () => { throw new Error('offline') } })
  const service = createCnyPriceBookService({ fetcher, store, getPrimaryPolicy: () => primary })
  const snapshot = await service.start()
  assert.equal(snapshot.trustStatus, 'stale-verified')
  assert.equal(snapshot.models['deepseek-flash'].peak.cacheHitInput, '0.04')
  assert.equal(snapshot.compatible, true)
})

test('CNY HTTP fetch is pinned to the official locale page and validates redirect host', async () => {
  const calls = []
  const fetcher = createOfficialCnyPricingFetcher({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, url, headers: { get: (name) => name === 'content-type' ? 'text/html; charset=utf-8' : null }, text: async () => html } } })
  const result = await fetcher.refresh()
  assert.equal(result.book.currency, 'CNY')
  assert.equal(calls[0].url, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
  assert.equal(calls[0].init.method, 'GET')
  const untrusted = createOfficialCnyPricingFetcher({ fetchImpl: async (url) => ({ ok: true, status: 200, url: 'https://evil.example/pricing', headers: { get: () => 'text/html' }, text: async () => html }) })
  await assert.rejects(untrusted.refresh(), { code: 'untrusted-cny-redirect' })
})

test('CNY parser failure emits deterministic secret-safe structure diagnostics without changing trust', async (t) => {
  const body = html.replace(/<table data-priceflow="model-details">[\s\S]*?<\/table>/, '')
  const fetcher = createOfficialCnyPricingFetcher({ fetchImpl: async (url) => ({
    ok: true, status: 200, url,
    headers: { get: (name) => name === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => body,
  }) })
  const root = await mkdtemp(join(tmpdir(), 'priceflow-cny-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createCnyBookStore(root)
  const logs = []
  const service = createCnyPriceBookService({ fetcher, store, getPrimaryPolicy: () => primary, logger: (event) => logs.push(event) })
  const snapshot = await service.start()
  assert.equal(snapshot.trustStatus, 'unavailable')
  assert.equal(snapshot.models, null)
  assert.equal(logs.length, 1)
  const { cnyDiagnostic: diagnostic } = logs[0]
  assert.equal(logs[0].code, 'missing-cny-model-metadata')
  assert.equal(diagnostic.httpStatus, 200)
  assert.equal(diagnostic.finalUrl, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
  assert.match(diagnostic.contentType, /^text\/html/)
  assert.equal(diagnostic.bodyLength, Buffer.byteLength(body))
  assert.equal(diagnostic.bodySha256, `sha256:${createHash('sha256').update(body).digest('hex')}`)
  assert.ok(diagnostic.htmlTableTagCount > 0)
  assert.ok(diagnostic.htmlTrTagCount > 0)
  assert.ok(diagnostic.htmlThTagCount > 0)
  assert.ok(diagnostic.htmlTdTagCount > 0)
  assert.ok(diagnostic.parserTableCount > 0)
  assert.ok(diagnostic.parserRowCount > 0)
  assert.equal(diagnostic.containsDeepseekFlash, true)
  assert.equal(diagnostic.containsZhModelLabel, true)
  assert.equal(diagnostic.containsZhModelVersionLabel, false)
  assert.equal(diagnostic.containsEnModelLabel, false)
  assert.equal(diagnostic.containsEnModelVersionLabel, false)
  assert.equal(diagnostic.containsZhPriceLabel, true)
  assert.equal(diagnostic.containsZhCacheHitLabel, true)
  assert.equal(diagnostic.containsZhCacheMissLabel, true)
  assert.equal(diagnostic.containsZhOutputLabel, true)
  assert.equal(diagnostic.candidateModelRowCount, 0)
  assert.equal(diagnostic.candidateModelVersionRowCount, 0)
  assert.equal(diagnostic.parserStage, 'model-metadata')
  assert.equal(diagnostic.errorCode, 'missing-cny-model-metadata')
  const serialized = JSON.stringify(diagnostic)
  assert.equal(serialized.includes(body), false)
  assert.doesNotMatch(serialized, /API[_ -]?KEY|Authorization|Bearer|balance|very secret|0\.02元/)
  const saved = await store.load()
  assert.equal(saved.operational.trustStatus, 'unavailable')
  assert.equal(saved.operational.lastSuccessfulFetchAt, null)
  assert.equal(typeof saved.operational.lastAttemptAt, 'number')
  assert.equal(saved.operational.lastErrorCode, 'missing-cny-model-metadata')
  assert.equal(saved.lastKnownGood, null)
  await service.stop()
})

test('successful CNY fetch does not emit failure diagnostics', async () => {
  const fetcher = createOfficialCnyPricingFetcher({ fetchImpl: async (url) => ({
    ok: true, status: 200, url,
    headers: { get: (name) => name === 'content-type' ? 'text/html' : null },
    text: async () => html,
  }) })
  const result = await fetcher.refresh()
  assert.equal(result.book.currency, 'CNY')
  assert.equal(Object.hasOwn(result, 'cnyDiagnostic'), false)
})

test('nested metadata cell markup is stripped into readable text by the current parser', () => {
  const nested = html.replace(/<table data-priceflow="model-details">[\s\S]*?<\/table>/,
    '<table data-priceflow="model-details"><tr><td>模型</td><td><code>deepseek-flash</code></td><td><a href="https://example.invalid/model">deepseek-v4-pro</a></td></tr><tr><td>模型版本</td><td><span>DeepSeek-V4.1-Flash</span></td><td><a href="https://example.invalid/version">DeepSeek-V4-Pro-0813</a></td></tr></table>')
  const book = parseOfficialCnyPricingHtml(nested, meta)
  assert.equal(book.models['deepseek-flash'].displayName, 'DeepSeek-V4.1-Flash')
  assert.equal(book.models['deepseek-v4-pro'].displayName, 'DeepSeek-V4-Pro-0813')
})

test('CNY parser failure diagnostics identify the exact metadata predicate without cell content', async (t) => {
  const body = html.replace(/<table data-priceflow="model-details">[\s\S]*?<\/table>/,
    '<table data-priceflow="model-details"><tr><td>模型</td><td><code>deepseek-flash</code></td><td><span>deepseek-v4-pro</span></td></tr><tr><td>模型版本</td><td><span>DeepSeek-V4.1-Flash</span></td></tr></table>')
  const fetcher = createOfficialCnyPricingFetcher({ fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: (name) => name === 'content-type' ? 'text/html' : null }, text: async () => body }) })
  const root = await mkdtemp(join(tmpdir(), 'priceflow-cny-metadata-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logs = []
  const service = createCnyPriceBookService({ fetcher, store: createCnyBookStore(root), getPrimaryPolicy: () => primary, logger: (event) => logs.push(event) })
  const state = await service.start()
  assert.equal(state.trustStatus, 'unavailable')
  assert.equal(state.models, null)
  const diagnostic = logs[0].cnyDiagnostic
  assert.equal(diagnostic.metadataRowsSameTable, true)
  assert.equal(diagnostic.modelCandidateTableIndex, 0)
  assert.equal(diagnostic.modelCandidateRowIndex, 0)
  assert.equal(diagnostic.versionCandidateTableIndex, 0)
  assert.equal(diagnostic.versionCandidateRowIndex, 1)
  assert.equal(diagnostic.modelRowCellCount, 3)
  assert.equal(diagnostic.versionRowCellCount, 2)
  assert.equal(diagnostic.modelValueCellCount, 2)
  assert.equal(diagnostic.versionValueCellCount, 1)
  assert.equal(diagnostic.modelNormalizedValueCount, 2)
  assert.equal(diagnostic.versionNormalizedValueCount, 1)
  assert.equal(diagnostic.modelEmptyValueCount, 0)
  assert.equal(diagnostic.versionEmptyValueCount, 0)
  assert.equal(diagnostic.modelValueCellsWithNestedMarkupCount, 2)
  assert.equal(diagnostic.versionValueCellsWithNestedMarkupCount, 1)
  assert.equal(diagnostic.modelIdsValidCount, 2)
  assert.equal(diagnostic.modelIdsInvalidCount, 0)
  assert.equal(diagnostic.versionValuesNonEmptyCount, 1)
  assert.equal(diagnostic.modelVersionCountEqual, false)
  assert.equal(diagnostic.modelIdsUnique, true)
  assert.equal(diagnostic.normalizedModelValuesContainDeepseekFlash, true)
  assert.equal(diagnostic.metadataFailureReason, 'missing-version-for-model-column')
  const serialized = JSON.stringify(diagnostic)
  assert.doesNotMatch(serialized, /deepseek-flash|DeepSeek-V4|example\.invalid|<code>|<span>/i)
  await service.stop()
})
