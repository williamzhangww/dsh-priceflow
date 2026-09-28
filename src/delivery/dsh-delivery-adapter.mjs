import { randomUUID } from 'node:crypto'

export class DeliveryError extends Error {
  constructor(message, { code = 'delivery-unknown', category = 'unknown', retryable = true } = {}) {
    super(message)
    this.name = 'DeliveryError'
    this.code = code
    this.category = category
    this.retryable = retryable
  }
}

const hostError = (response) => response?.result?.error ?? response?.error ?? null
const hostValue = (response) => response?.result?.value ?? response?.value ?? response?.result ?? (typeof response?.accepted === 'boolean' ? response : null)

/** Uses the primary SessionController business API and the exact queue identity. */
export function createDshDeliveryAdapter({ apiProxy, getApiProxy, sessionController, getSessionController, inspectSession, requestId = () => randomUUID(), onDiagnostic = () => {}, now = () => Date.now() } = {}) {
  const getEndpoint = () => {
    const controller = getSessionController?.() ?? sessionController
    if (typeof controller?.prompt === 'function') return { kind: 'sessionController', owner: controller, prompt: controller.prompt }
    const proxy = getApiProxy?.() ?? apiProxy
    if (typeof proxy?.sessions?.prompt === 'function') return { kind: 'apiProxy', owner: proxy.sessions, prompt: proxy.sessions.prompt }
    return null
  }
  const supported = () => getEndpoint() !== null
  const backend = () => {
    const endpoint = getEndpoint()
    return endpoint?.kind === 'sessionController' ? 'session-controller' : endpoint?.kind === 'apiProxy' ? 'api-proxy' : null
  }
  const report = (event) => { try { onDiagnostic(event) } catch { /* diagnostics must not affect delivery */ } }
  let tail = Promise.resolve()

  async function validateSession(sessionId) {
    if (!supported()) throw new DeliveryError('DSH session prompt API is unavailable', { code: 'unsupported-host-api', category: 'plugin', retryable: false })
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new DeliveryError('invalid target session id', { code: 'invalid-session-id', category: 'session', retryable: false })
    if (typeof inspectSession !== 'function') throw new DeliveryError('session validation capability unavailable', { code: 'session-validation-unavailable', category: 'plugin', retryable: false })
    try {
      const result = await inspectSession(sessionId)
      if (result === false || result == null) throw new DeliveryError('target session does not exist', { code: 'session-not-found', category: 'session', retryable: false })
    } catch (error) {
      if (error instanceof DeliveryError) throw error
      const message = String(error?.code ?? error?.message ?? '')
      const missing = /not.?found|unknown.?session|session.?missing/i.test(message)
      throw new DeliveryError(missing ? 'target session does not exist' : 'target session could not be verified', { code: missing ? 'session-not-found' : 'session-validation-failed', category: missing ? 'session' : 'unknown', retryable: !missing })
    }
    return true
  }

  async function deliverOne(item) {
    const endpoint = getEndpoint()
    if (!endpoint) throw new DeliveryError('DSH session prompt API is unavailable', { code: 'unsupported-host-api', category: 'plugin', retryable: false })
    await validateSession(item?.sessionId)
    if (typeof item?.text !== 'string' || !item.text.trim()) throw new DeliveryError('invalid prompt payload', { code: 'malformed-payload', category: 'plugin', retryable: false })
    const id = item?.deliveryRequestId ?? requestId(item)
    const backendName = endpoint.kind === 'sessionController' ? 'session-controller' : 'api-proxy'
    report({ event: 'delivery-attempt', itemId: item?.id, requestId: id, backend: backendName, attemptCount: item?.attemptCount })
    let response
    try {
      if (endpoint.kind === 'apiProxy') {
        response = await endpoint.prompt.call(endpoint.owner, {
          rpcId: id,
          payload: { sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: item.text }] },
        })
      } else {
        response = await endpoint.prompt.call(endpoint.owner, {
          requestId: id,
          sessionId: item.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: item.text }],
        }, new AbortController().signal)
      }
    } catch (error) {
      const code = String(error?.code ?? '')
      const details = `${code} ${error?.message ?? ''}`
      const missing = /session.?not.?found|unknown.?session|invalid.?session/i.test(details)
      const transient = /timeout|transport|unavailable|busy|econn|network|abort/i.test(details)
      throw new DeliveryError(missing ? 'target session does not exist' : 'DSH prompt request failed', { code: missing ? 'session-not-found' : code || (transient ? 'host-transport' : 'host-error'), category: missing ? 'session' : transient ? 'transient' : 'unknown', retryable: !missing })
    }
    const failure = hostError(response)
    if (failure) {
      const code = String(failure.code ?? 'host-error')
      const message = String(failure.message ?? '')
      const missing = /session.?not.?found|unknown.?session|invalid.?session/i.test(`${code} ${message}`)
      const transient = /timeout|transport|unavailable|busy|network/i.test(`${code} ${message}`)
      throw new DeliveryError(missing ? 'target session does not exist' : 'DSH rejected prompt submission', { code: missing ? 'session-not-found' : code, category: missing ? 'session' : transient ? 'transient' : 'unknown', retryable: !missing })
    }
    const value = hostValue(response)
    if (!value || typeof value !== 'object' || value.accepted !== true) throw new DeliveryError('DSH returned a malformed prompt acceptance result', { code: 'malformed-host-result', category: 'plugin', retryable: false })
    report({ event: 'delivery-accepted', itemId: item?.id, requestId: id, backend: backendName, attemptCount: item?.attemptCount })
    return { accepted: true, requestId: id, backend: backendName, acceptedAtUtc: now(), hostResultMetadata: { messageId: typeof value.messageId === 'string' ? value.messageId : null } }
  }

  return {
    get enabled() { return supported() },
    get supported() { return supported() },
    get backend() { return backend() },
    validateSession,
    deliver(item) {
      const operation = tail.then(() => deliverOne(item))
      tail = operation.catch(() => {})
      return operation
    },
  }
}
