export function startPriceFlowWithLifecycle(ctx, service) {
  if (!ctx || typeof ctx.effect !== 'function') throw new TypeError('Cordis context with effect() is required')
  ctx.effect(() => {
    let disposed = false
    void service.start().catch((error) => {
      const code = error?.code ?? 'host-start-failed'
      try { ctx.logger?.warn?.(`[dsh-priceflow] host service failed to start (${code})`) } catch { /* ignore logger failure */ }
    })
    return () => {
      disposed = true
      void service.stop().catch((error) => {
        if (disposed) {
          try { ctx.logger?.warn?.(`[dsh-priceflow] cleanup failed (${error?.code ?? 'cleanup-failed'})`) } catch { /* ignore logger failure */ }
        }
      })
    }
  }, 'dsh-priceflow: host service')
}
