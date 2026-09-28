export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const CURRENCIES = ['CNY', 'USD']
const decimalPattern = /^\d+(?:\.\d+)?$/

export class BalanceFetchError extends Error {
  constructor(message, code = 'balance-fetch-failed') { super(message); this.name = 'BalanceFetchError'; this.code = code }
}

function validateAmount(value, field) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new BalanceFetchError(`invalid ${field}`, 'invalid-balance-body')
  return value
}

export function validateBalanceResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.is_available !== 'boolean' || !Array.isArray(body.balance_infos)) throw new BalanceFetchError('invalid balance response shape', 'invalid-balance-body')
  const balances = Object.create(null)
  for (const item of body.balance_infos) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.currency !== 'string') throw new BalanceFetchError('invalid balance entry', 'invalid-balance-body')
    if (!CURRENCIES.includes(item.currency)) continue
    if (Object.hasOwn(balances, item.currency)) throw new BalanceFetchError('duplicate known balance currency', 'invalid-balance-body')
    balances[item.currency] = {
      totalBalance: validateAmount(item.total_balance, 'total_balance'),
      grantedBalance: validateAmount(item.granted_balance, 'granted_balance'),
      toppedUpBalance: validateAmount(item.topped_up_balance, 'topped_up_balance'),
    }
  }
  return { isAvailable: body.is_available, currencies: balances }
}

export function createDeepSeekBalanceFetcher({ fetchImpl = globalThis.fetch, resolveCredential, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof resolveCredential !== 'function') throw new TypeError('fetchImpl and resolveCredential are required')
  return {
    async refresh() {
      const resolved = await resolveCredential()
      const apiKey = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new BalanceFetchError('balance credential is unavailable', 'missing-credential')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(DEEPSEEK_BALANCE_URL, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
        if (!response.ok) throw new BalanceFetchError(`balance endpoint returned HTTP ${response.status}`, `http-${response.status}`)
        let body
        try { body = await response.json() } catch { throw new BalanceFetchError('balance endpoint returned invalid JSON', 'invalid-balance-body') }
        return validateBalanceResponse(body)
      } catch (error) {
        if (error instanceof BalanceFetchError) throw error
        if (controller.signal.aborted || error?.name === 'AbortError') throw new BalanceFetchError('balance request timed out', 'timeout')
        throw new BalanceFetchError('balance request failed', 'network-error')
      } finally { clearTimeout(timer) }
    },
  }
}

export function createBalanceMemoryService({ fetcher, now = () => Date.now(), ttlMs = 60_000 } = {}) {
  if (!fetcher?.refresh) throw new TypeError('balance fetcher is required')
  let snapshot = null
  let lastAttemptAt = null
  let lastErrorCode = null
  let inFlight = null
  let fetching = false
  async function refresh({ force = false } = {}) {
    if (inFlight) return inFlight
    if (!force && snapshot && now() - snapshot.fetchedAt < ttlMs) return getSnapshot()
    lastAttemptAt = now()
    fetching = true
    inFlight = (async () => {
      try {
        const result = await fetcher.refresh()
        snapshot = { ...result, fetchedAt: now() }
        lastErrorCode = null
      } catch (error) {
        lastErrorCode = typeof error?.code === 'string' ? error.code : 'balance-fetch-failed'
        if (!snapshot) snapshot = null
      }
      return getSnapshot()
    })().finally(() => { fetching = false; inFlight = null })
    return inFlight
  }
  function getSnapshot() {
    if (!snapshot) return { status: fetching ? 'loading' : lastErrorCode ? (lastErrorCode === 'missing-credential' ? 'unconfigured' : 'unavailable') : 'idle', isAvailable: null, currencies: {}, fetchedAt: null, lastAttemptAt, lastErrorCode }
    const stale = Boolean(lastErrorCode)
    return { status: stale ? 'stale' : 'available', isAvailable: snapshot.isAvailable, currencies: structuredClone(snapshot.currencies), fetchedAt: snapshot.fetchedAt, lastAttemptAt, lastErrorCode }
  }
  return { refresh, getSnapshot }
}
