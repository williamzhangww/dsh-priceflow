import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const SAFE_FIELDS = new Set([
  'event', 'code', 'trustStatus', 'retryAtUtcMs', 'policyId', 'fromPolicyId', 'toPolicyId',
  'changed', 'changeKinds', 'itemId', 'from', 'to', 'attemptCount', 'failureCount', 'status',
  'requestedUrl', 'finalUrl', 'fetchedAt', 'httpStatus', 'contentType', 'responseBytes', 'etag', 'lastModified',
  'contentHash', 'parserResult', 'policyIdAtFetch', 'livePricingValidation', 'durationMs', 'requestId', 'backend',
])
const CNY_DIAGNOSTIC_FIELDS = new Set([
  'httpStatus', 'finalUrl', 'contentType', 'bodyLength', 'bodySha256',
  'htmlTableTagCount', 'htmlTrTagCount', 'htmlThTagCount', 'htmlTdTagCount',
  'containsDeepseekFlash', 'containsZhModelLabel', 'containsZhModelVersionLabel',
  'containsEnModelLabel', 'containsEnModelVersionLabel', 'containsZhPriceLabel',
  'containsZhCacheHitLabel', 'containsZhCacheMissLabel', 'containsZhOutputLabel',
  'parserTableCount', 'parserRowCount', 'candidateModelRowCount',
  'candidateModelVersionRowCount', 'parserStage', 'errorCode',
  'modelCandidateTableIndex', 'modelCandidateRowIndex',
  'versionCandidateTableIndex', 'versionCandidateRowIndex', 'metadataRowsSameTable',
  'modelRowCellCount', 'versionRowCellCount', 'modelValueCellCount', 'versionValueCellCount',
  'modelNormalizedValueCount', 'versionNormalizedValueCount', 'modelEmptyValueCount',
  'versionEmptyValueCount', 'modelValueCellsWithNestedMarkupCount',
  'versionValueCellsWithNestedMarkupCount', 'modelIdsValidCount', 'modelIdsInvalidCount',
  'versionValuesNonEmptyCount', 'modelVersionCountEqual', 'modelIdsUnique',
  'normalizedModelValuesContainDeepseekFlash', 'metadataFailureReason',
  'modelCandidateCellCount', 'recognizedModelIdCount', 'structuralNonModelCellCount',
])

function sanitize(event) {
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') throw new TypeError('log event requires a name')
  const out = { at: new Date().toISOString(), event: event.event.slice(0, 80) }
  for (const key of SAFE_FIELDS) {
    if (key === 'event' || !Object.hasOwn(event, key)) continue
    const value = event[key]
    if (typeof value === 'string') out[key] = value.slice(0, 256)
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
    else if (key === 'changeKinds' && Array.isArray(value)) out[key] = value.filter((v) => typeof v === 'string').slice(0, 100).map((v) => v.slice(0, 80))
  }
  if (event.cnyDiagnostic && typeof event.cnyDiagnostic === 'object' && !Array.isArray(event.cnyDiagnostic)) {
    const diagnostic = {}
    for (const key of CNY_DIAGNOSTIC_FIELDS) {
      const value = event.cnyDiagnostic[key]
      if (typeof value === 'string') diagnostic[key] = value.slice(0, 256)
      else if (typeof value === 'number' && Number.isFinite(value)) diagnostic[key] = value
      else if (typeof value === 'boolean') diagnostic[key] = value
    }
    out.cnyDiagnostic = diagnostic
  }
  return out
}

export function createHostLogger(root, { maxBytes = 2_000_000 } = {}) {
  const path = `${root.replace(/[\\/]$/, '')}/host.log`
  let serial = Promise.resolve()
  return {
    path,
    write(event) {
      const record = sanitize(event)
      const task = serial.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        try {
          const info = await stat(path)
          if (info.size >= maxBytes) {
            try { await rename(`${path}.1`, `${path}.2`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
            try { await rename(path, `${path}.1`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
          }
        } catch (error) { if (error?.code !== 'ENOENT') throw error }
        await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
      })
      serial = task.catch(() => {})
      return task
    },
  }
}
