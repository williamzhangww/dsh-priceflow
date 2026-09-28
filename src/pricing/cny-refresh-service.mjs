import { createHash } from 'node:crypto'
import { OFFICIAL_CNY_PRICING_URL, parseOfficialCnyPricingHtml, validateCnyPriceBook } from './cny-price-book.mjs'
import { validateCnyBookCache } from '../storage/cny-book-store.mjs'

const officialHost = (host) => host === 'deepseek.com' || host.endsWith('.deepseek.com')

export function createOfficialCnyPricingFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 12000, now = () => Date.now(), maxResponseBytes = 5_000_000 } = {}) {
  let inFlight = null
  return {
    refresh(validators = {}) {
      if (inFlight) return inFlight
      inFlight = (async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'PriceFlow/0.2 (+https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)' }
        if (validators.etag) headers['If-None-Match'] = validators.etag
        if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified
        try {
          const response = await fetchImpl(OFFICIAL_CNY_PRICING_URL, { method: 'GET', redirect: 'follow', headers, signal: controller.signal })
          const finalUrl = new URL(response.url || OFFICIAL_CNY_PRICING_URL)
          if (finalUrl.protocol !== 'https:' || !officialHost(finalUrl.hostname)) throw Object.assign(new Error('CNY pricing redirect ended outside the official DeepSeek domain'), { code: 'untrusted-cny-redirect' })
          const metadata = { requestedUrl: OFFICIAL_CNY_PRICING_URL, finalUrl: finalUrl.href, status: response.status, contentType: response.headers?.get?.('content-type') ?? null, etag: response.headers?.get?.('etag') ?? validators.etag ?? null, lastModified: response.headers?.get?.('last-modified') ?? validators.lastModified ?? null, fetchedAt: new Date(now()).toISOString() }
          if (response.status === 304) return { notModified: true, metadata }
          if (!response.ok) throw Object.assign(new Error(`official CNY pricing page returned HTTP ${response.status}`), { code: `http-${response.status}` })
          if (!/^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/i.test(metadata.contentType ?? '')) throw Object.assign(new Error('unexpected official CNY pricing content type'), { code: 'unexpected-content-type' })
          const length = Number(response.headers?.get?.('content-length'))
          if (Number.isFinite(length) && length > maxResponseBytes) throw Object.assign(new Error('CNY pricing response exceeds size limit'), { code: 'response-too-large' })
          const html = await response.text()
          if (Buffer.byteLength(html, 'utf8') > maxResponseBytes) throw Object.assign(new Error('CNY pricing response exceeds size limit'), { code: 'response-too-large' })
          metadata.contentHash = `sha256:${createHash('sha256').update(html).digest('hex')}`
          try {
            return { notModified: false, metadata, book: parseOfficialCnyPricingHtml(html, metadata) }
          } catch (error) {
            const safeFinalUrl = new URL(metadata.finalUrl)
            safeFinalUrl.search = ''
            safeFinalUrl.hash = ''
            const parserDiagnostic = error?.parserDiagnostic ?? {}
            error.cnyDiagnostic = {
              httpStatus: metadata.status,
              finalUrl: safeFinalUrl.href,
              contentType: String(metadata.contentType ?? '').slice(0, 128),
              bodyLength: Buffer.byteLength(html, 'utf8'),
              bodySha256: metadata.contentHash,
              htmlTableTagCount: (html.match(/<table\b/gi) ?? []).length,
              htmlTrTagCount: (html.match(/<tr\b/gi) ?? []).length,
              htmlThTagCount: (html.match(/<th\b/gi) ?? []).length,
              htmlTdTagCount: (html.match(/<td\b/gi) ?? []).length,
              containsDeepseekFlash: html.includes('deepseek-flash'),
              containsZhModelLabel: html.includes('模型'),
              containsZhModelVersionLabel: html.includes('模型版本'),
              containsEnModelLabel: html.includes('MODEL'),
              containsEnModelVersionLabel: html.includes('MODEL VERSION'),
              containsZhPriceLabel: html.includes('价格'),
              containsZhCacheHitLabel: html.includes('缓存命中'),
              containsZhCacheMissLabel: html.includes('缓存未命中'),
              containsZhOutputLabel: html.includes('输出'),
              parserTableCount: parserDiagnostic.parserTableCount ?? 0,
              parserRowCount: parserDiagnostic.parserRowCount ?? 0,
              candidateModelRowCount: parserDiagnostic.candidateModelRowCount ?? 0,
              candidateModelVersionRowCount: parserDiagnostic.candidateModelVersionRowCount ?? 0,
              parserStage: parserDiagnostic.parserStage ?? 'html-parse',
              errorCode: error?.code ?? 'cny-parse-failed',
              ...parserDiagnostic,
            }
            throw error
          }
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') throw Object.assign(new Error('official CNY pricing request timed out'), { code: 'timeout' })
          if (error?.code) throw error
          throw Object.assign(new Error('official CNY pricing request failed'), { code: 'network-error' })
        } finally { clearTimeout(timer) }
      })().finally(() => { inFlight = null })
      return inFlight
    },
  }
}

function emptyCache() { return { schemaVersion: 1, lastKnownGood: null, operational: { trustStatus: 'unavailable', lastSuccessfulFetchAt: null, lastAttemptAt: null, lastErrorCode: null, lastFetchMetadata: null } } }

export function createCnyPriceBookService({ fetcher, store, getPrimaryPolicy, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, refreshIntervalMs = 86400000, logger = () => {} } = {}) {
  if (!fetcher?.refresh || !store?.load || !store?.save) throw new TypeError('CNY fetcher and store are required')
  let cache = null
  let inFlight = null
  let timer = null
  let stopped = true
  const listeners = new Set()
  const emit = () => { for (const listener of [...listeners]) { try { listener(getSnapshot()) } catch {} } }
  function compatible(book = cache?.lastKnownGood) {
    const primary = getPrimaryPolicy?.()
    if (!book || !primary) return false
    const ids = Object.keys(primary.models ?? {})
    return ids.length === Object.keys(book.models ?? {}).length && ids.every((id) => book.models[id]?.displayName === primary.models[id]?.displayName)
  }
  function getSnapshot() {
    return { trustStatus: cache?.operational.trustStatus ?? 'unavailable', compatible: compatible(), models: cache?.lastKnownGood && compatible() ? structuredClone(cache.lastKnownGood.models) : null, source: cache?.lastKnownGood ? { ...cache.lastKnownGood.source } : null, lastSuccessfulFetchAt: cache?.operational.lastSuccessfulFetchAt ?? null, lastAttemptAt: cache?.operational.lastAttemptAt ?? null, lastErrorCode: cache?.operational.lastErrorCode ?? null }
  }
  async function refreshNow() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      cache ??= emptyCache()
      cache.operational.lastAttemptAt = now()
      await store.save(cache)
      try {
        const prior = cache.lastKnownGood?.source ?? {}
        const result = await fetcher.refresh({ etag: prior.etag, lastModified: prior.lastModified })
        if (result.notModified) {
          if (!cache.lastKnownGood) throw Object.assign(new Error('CNY server returned 304 without a verified local book'), { code: 'orphan-304' })
          cache.operational.trustStatus = 'verified'
          cache.operational.lastSuccessfulFetchAt = now()
          cache.operational.lastErrorCode = null
          cache.operational.lastFetchMetadata = result.metadata
        } else {
          const book = validateCnyPriceBook(result.book)
          const primary = getPrimaryPolicy?.()
          const ids = Object.keys(primary?.models ?? {})
          if (!primary || ids.length !== Object.keys(book.models).length || !ids.every((id) => book.models[id]?.displayName === primary.models[id]?.displayName)) throw Object.assign(new Error('CNY price book is incompatible with the primary model catalog'), { code: 'incompatible-cny-catalog' })
          cache.lastKnownGood = book
          cache.operational.trustStatus = 'verified'
          cache.operational.lastSuccessfulFetchAt = now()
          cache.operational.lastErrorCode = null
          cache.operational.lastFetchMetadata = result.metadata
        }
        await store.save(cache)
        logger({ event: 'cny-pricing-refresh-success', trustStatus: cache.operational.trustStatus })
        emit()
        return getSnapshot()
      } catch (error) {
        cache.operational.trustStatus = cache.lastKnownGood && compatible() ? 'stale-verified' : 'unavailable'
        cache.operational.lastErrorCode = typeof error?.code === 'string' ? error.code : 'cny-refresh-failed'
        await store.save(cache)
        logger({ event: 'cny-pricing-refresh-failure', code: cache.operational.lastErrorCode, trustStatus: cache.operational.trustStatus, ...(error?.cnyDiagnostic ? { cnyDiagnostic: error.cnyDiagnostic } : {}) })
        emit()
        throw error
      }
    })().finally(() => { inFlight = null })
    return inFlight
  }
  function schedule() {
    if (stopped) return
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => { timer = null; void refreshNow().catch(() => {}).finally(schedule) }, refreshIntervalMs)
    timer?.unref?.()
  }
  return {
    async start() { cache = await store.load() ?? emptyCache(); stopped = false; try { await refreshNow() } catch {} schedule(); return getSnapshot() },
    async stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; if (inFlight) await inFlight.catch(() => {}) },
    async refreshNow() { return refreshNow() },
    getSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}
