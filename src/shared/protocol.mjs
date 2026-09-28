export const PRICEFLOW_ROUTE_PREFIX = '/priceflow'
export const PRICEFLOW_PROTOCOL_VERSION = 1

export function assertActionEnvelope(value) {
  if (!value || typeof value !== 'object' || value.protocolVersion !== PRICEFLOW_PROTOCOL_VERSION || typeof value.action !== 'string') {
    throw new TypeError('invalid PriceFlow action envelope')
  }
  return value
}
