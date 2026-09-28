import { createHash } from 'node:crypto'
import { OFFICIAL_PRICING_URL } from './policy-schema.mjs'
import { parseOfficialPricingHtml } from './parser.mjs'

export class PricingFetchError extends Error {
  constructor(message, code = 'fetch-error') { super(message); this.name = 'PricingFetchError'; this.code = code }
}

const isOfficialHost = (host) => host === 'deepseek.com' || host.endsWith('.deepseek.com')

export function createOfficialPricingFetcher({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 12000,
  cacheMetadata = () => ({}),
  userAgent = 'PriceFlow/0.1 (+https://api-docs.deepseek.com/quick_start/pricing/)',
  maxResponseBytes = 5_000_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  let inflight = null
  return {
    refresh(refreshOptions = {}) {
      if (inflight) return inflight
      inflight = (async () => {
        const requestedUrl = OFFICIAL_PRICING_URL
        const prior = { ...(cacheMetadata() ?? {}), ...refreshOptions }
        const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent }
        if (prior.etag) headers['If-None-Match'] = prior.etag
        if (prior.lastModified) headers['If-Modified-Since'] = prior.lastModified
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('pricing fetch timed out')), timeoutMs)
        const startedAt = now()
        try {
          const response = await fetchImpl(requestedUrl, { method: 'GET', redirect: 'follow', headers, signal: controller.signal })
          const finalUrl = response.url || requestedUrl
          let final
          try { final = new URL(finalUrl) } catch { throw new PricingFetchError('invalid final response URL', 'invalid-final-url') }
          if (final.protocol !== 'https:' || !isOfficialHost(final.hostname)) throw new PricingFetchError(`redirect ended at non-official host ${final.hostname}`, 'untrusted-redirect')
          const fetchedAt = new Date(startedAt).toISOString()
          const metadata = {
            requestedUrl,
            finalUrl,
            fetchedAt,
            status: response.status,
            contentType: response.headers?.get?.('content-type') ?? null,
            etag: response.headers?.get?.('etag') ?? prior.etag ?? null,
            lastModified: response.headers?.get?.('last-modified') ?? prior.lastModified ?? null,
            responseBytes: 0,
            contentHash: null,
            parserResult: 'not-run',
            policyId: null,
          }
          if (response.status === 304) return { notModified: true, metadata: { ...metadata, parserResult: 'not-modified' } }
          if (!response.ok) {
            const error = new PricingFetchError(`official pricing page returned HTTP ${response.status}`, `http-${response.status}`)
            error.metadata = metadata
            throw error
          }
          const declaredLength = Number(response.headers?.get?.('content-length'))
          if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
            const error = new PricingFetchError('official pricing response exceeds configured size limit', 'response-too-large')
            error.metadata = metadata
            throw error
          }
          if (!/^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/i.test(metadata.contentType ?? '')) {
            const error = new PricingFetchError(`unexpected official pricing Content-Type: ${metadata.contentType ?? 'missing'}`, 'unexpected-content-type')
            error.metadata = metadata
            throw error
          }
          const html = await response.text()
          metadata.responseBytes = Buffer.byteLength(html, 'utf8')
          if (metadata.responseBytes > maxResponseBytes) {
            const error = new PricingFetchError('official pricing response exceeds configured size limit', 'response-too-large')
            error.metadata = metadata
            throw error
          }
          const contentHash = `sha256:${createHash('sha256').update(html).digest('hex')}`
          metadata.contentHash = contentHash
          try {
            const policy = parseOfficialPricingHtml(html, { ...metadata, fetchedAt, contentHash })
            metadata.parserResult = 'passed'
            metadata.policyId = policy.policyId
            return { notModified: false, metadata, policy }
          } catch (error) {
            metadata.parserResult = 'failed'
            error.metadata = metadata
            throw error
          }
        } catch (error) {
          if (error instanceof PricingFetchError) throw error
          if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || controller.signal.aborted) {
            throw new PricingFetchError('official pricing request timed out', 'timeout')
          }
          if (error?.code) throw error
          throw new PricingFetchError(error instanceof Error ? error.message : String(error), 'network-error')
        } finally {
          clearTimeout(timer)
        }
      })().finally(() => { inflight = null })
      return inflight
    },
  }
}
