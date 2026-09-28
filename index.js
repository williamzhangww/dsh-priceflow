import { createPriceFlowHostService, PRICEFLOW_HOST_VERSION } from './src/host/service.mjs'
import { registerPriceFlowRoutes } from './src/host/routes.mjs'
import { startPriceFlowWithLifecycle } from './src/host/lifecycle.mjs'
import { createDshDeliveryAdapter } from './src/delivery/dsh-delivery-adapter.mjs'

export const name = 'dsh-priceflow'
export const inject = []

export function apply(ctx) {
  const getOptionalService = (name) => {
    try { return ctx.get(name, false) } catch { return undefined }
  }
  const logger = (event) => {
    const fields = [event.event, event.code, event.trustStatus, event.policyIdAtFetch].filter(Boolean).join(' ')
    try { ctx.logger?.info?.(`[dsh-priceflow] ${fields}`) } catch { /* disk logger remains the diagnostic source */ }
  }
  let sessionController = getOptionalService('sessionController')
  let service
  const inspectSession = (sessionId) => {
    const controller = sessionController ?? getOptionalService('sessionController')
    if (typeof controller?.inspect === 'function') return controller.inspect(sessionId)
    return getOptionalService('sessions')?.get?.(sessionId) ?? null
  }
  const deliveryAdapter = createDshDeliveryAdapter({
    getApiProxy: () => getOptionalService('apiProxy'),
    getSessionController: () => sessionController ?? getOptionalService('sessionController'),
    inspectSession,
    onDiagnostic: (event) => service?.report(event),
  })
  service = createPriceFlowHostService({ logger, deliveryAdapter, getCredentials: () => getOptionalService('credentials') })
  startPriceFlowWithLifecycle(ctx, service)
  ctx.inject(['sessionController'], (sessionScope) => { sessionController = sessionScope.sessionController })
  try {
    ctx.inject(['webServer'], (scope) => {
      let connection = null
      try {
        const routeScope = { webServer: scope.webServer, effect: scope.effect.bind(scope) }
        registerPriceFlowRoutes(routeScope, service, { getConnection: () => connection })
        service.report({ event: 'priceflow-routes-registered', status: 'registered' })
      } catch (error) {
        try { ctx.logger?.warn?.(`[dsh-priceflow] web routes unavailable (${error?.code ?? 'route-registration-failed'})`) } catch { /* host keeps running headless */ }
      }
      ctx.inject(['connection'], (connectionScope) => {
        connection = connectionScope.connection
        const available = typeof connection?.requestRejection === 'function'
        service.setConnectionAdmissionAvailable(available)
        if (!available) service.report({ event: 'priceflow-connection-admission-unavailable', status: 'fail-closed' })
      })
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`[dsh-priceflow] webServer injection unavailable (${error?.code ?? 'inject-failed'})`) } catch { /* host keeps running headless */ }
  }
  try { ctx.logger?.info?.(`[dsh-priceflow] plugin entry loaded v${PRICEFLOW_HOST_VERSION}`) } catch { /* no-op */ }
}

// Keep this as a named-export namespace plugin: DSH's Cordis loader unwraps a
// default export first, which would hide the module-level inject metadata.
