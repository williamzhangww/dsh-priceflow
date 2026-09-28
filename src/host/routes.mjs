export const PRICEFLOW_ROUTE_PREFIX = '/dsh-priceflow'
export const PRICEFLOW_STATE_ROUTE = `${PRICEFLOW_ROUTE_PREFIX}/state`
export const PRICEFLOW_ACTION_ROUTE = `${PRICEFLOW_ROUTE_PREFIX}/action`
export const MAX_ACTION_BODY_BYTES = 16 * 1024
export const MAX_PROMPT_BYTES = 12 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

class RouteInputError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  })
  res.end(body)
}

function readLimitedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > maxBytes) {
        settled = true
        chunks.length = 0
        reject(new RouteInputError('request body exceeds the configured limit', 'body-too-large', 413))
        req.resume?.()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')) }
    })
    req.on('error', () => {
      if (!settled) { settled = true; reject(new RouteInputError('request body could not be read', 'body-read-failed', 400)) }
    })
  })
}

export function createPriceFlowRouteHandlers(service, { maxBodyBytes = MAX_ACTION_BODY_BYTES, connection, getConnection } = {}) {
  if (!service || typeof service.getState !== 'function' || typeof service.refreshNow !== 'function') throw new TypeError('PriceFlow host service is required')
  const admit = (req) => {
    const current = typeof getConnection === 'function' ? getConnection() : connection
    if (!current || typeof current.requestRejection !== 'function') return 503
    try { return current.requestRejection(req) ?? null } catch { return 503 }
  }
  const rejectAdmission = (req, res) => {
    const rejection = admit(req)
    if (rejection == null) return false
    writeJson(res, rejection, { ok: false, error: { code: rejection === 503 ? 'connection-unavailable' : 'connection-rejected', message: rejection === 503 ? 'DSH connection admission unavailable' : 'request rejected by DSH connection security' } })
    return true
  }
  return {
    async state(req, res) {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        if (rejectAdmission(req, res)) return
        writeJson(res, 200, { ok: true, data: await service.getState() })
      } catch (error) {
        writeJson(res, error.status ?? 500, { ok: false, error: { code: error.code ?? 'state-error', message: error.status ? error.message : 'state snapshot unavailable' } })
      }
    },
    async action(req, res) {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        if (rejectAdmission(req, res)) return
        const contentType = req.headers?.['content-type']
        if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new RouteInputError('Content-Type must be application/json', 'invalid-content-type', 415)
        const raw = await readLimitedBody(req, maxBodyBytes)
        let body
        try { body = JSON.parse(raw) } catch { throw new RouteInputError('request body is not valid JSON', 'malformed-json') }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['action', 'args'].includes(key))) {
          throw new RouteInputError('request body must contain only action and args', 'invalid-action-schema')
        }
        const args = body.args ?? {}
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RouteInputError('action args must be an object', 'invalid-action-args')
        let result
        if (body.action === 'refreshPricing') {
          if (Object.keys(args).length) throw new RouteInputError('refreshPricing takes no arguments', 'invalid-action-args')
          const refresh = await service.refreshNow()
          result = { trustStatus: refresh.trustStatus, policyId: refresh.policy.policyId, livePricingValidation: refresh.livePricingValidation }
        } else if (body.action === 'refreshBalance' || body.action === 'ensureBalance') {
          if (Object.keys(args).length) throw new RouteInputError(`${body.action} takes no arguments`, 'invalid-action-args')
          result = body.action === 'refreshBalance' ? await service.refreshBalance() : await service.ensureBalanceFresh()
        } else if (['enqueue', 'sendNow', 'sendOffPeakAware'].includes(body.action)) {
          const allowed = ['sessionId', 'text']
          if (Object.keys(args).some((key) => !allowed.includes(key)) || Object.keys(args).length !== 2) throw new RouteInputError('submit args must contain only sessionId and text', 'invalid-action-args')
          if (typeof args.sessionId !== 'string' || !SESSION_ID_PATTERN.test(args.sessionId)) throw new RouteInputError('invalid sessionId', 'invalid-session-id')
          if (typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text, 'utf8') > MAX_PROMPT_BYTES) throw new RouteInputError(`text must be non-empty and at most ${MAX_PROMPT_BYTES} UTF-8 bytes`, 'invalid-text')
          if (body.action === 'sendNow') result = await service.submitNow(args)
          else if (body.action === 'sendOffPeakAware') result = await service.submitOffPeakAware(args)
          else result = await service.enqueue(args)
        } else if (body.action === 'cancelQueueItem' || body.action === 'retryQueueItem') {
          if (Object.keys(args).length !== 1 || typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.id)) throw new RouteInputError('queue action requires a valid id', 'invalid-action-args')
          result = body.action === 'cancelQueueItem' ? await service.cancelQueueItem(args.id) : await service.retryQueueItem(args.id)
        } else throw new RouteInputError('unknown action', 'unknown-action')
        writeJson(res, 200, { ok: true, data: result })
      } catch (error) {
        const status = error.status ?? (error.code === 'pricing-untrusted' ? 409 : error.code === 'service-not-ready' ? 503 : error.code === 'session-not-found' ? 404 : 500)
        writeJson(res, status, { ok: false, error: { code: error.code ?? 'action-failed', message: error.status || ['pricing-untrusted', 'service-not-ready', 'session-not-found'].includes(error.code) ? error.message : 'action could not be completed' } })
      }
    },
  }
}

export function registerPriceFlowRoutes(scope, service, admission = {}) {
  if (!scope?.webServer || typeof scope.effect !== 'function') throw new TypeError('webServer injection scope is required')
  const handlers = createPriceFlowRouteHandlers(service, { connection: scope.connection, ...admission })
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: PRICEFLOW_STATE_ROUTE, handler: handlers.state }), 'dsh-priceflow: state route')
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: PRICEFLOW_ACTION_ROUTE, handler: handlers.action }), 'dsh-priceflow: action route')
}
