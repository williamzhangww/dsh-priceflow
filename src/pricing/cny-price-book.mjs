import { createHash } from 'node:crypto'

export const OFFICIAL_CNY_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const FIELDS = ['cacheHitInput', 'cacheMissInput', 'output']
const PHASES = ['peak', 'offpeak']

export class CnyPriceBookError extends Error {
  constructor(message, code = 'invalid-cny-price-book') { super(message); this.name = 'CnyPriceBookError'; this.code = code }
}

const decode = (s) => s.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
const strip = (s) => decode(s.replace(/<sup\b[^>]*>[\s\S]*?<\/sup\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const normalizeHeading = (value) => value.replace(/[\p{Cf}\u200b\ufeff]/gu, '').trim().toLocaleUpperCase('en-US')
function records(html, tag) { return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].map((m) => ({ attrs: m[1], inner: m[2], text: strip(m[2]) })) }

function rowsOf(html) {
  const pending = new Map()
  return records(html, 'tr').map((row) => {
    const cells = []
    const nextPending = new Map()
    for (const [column, value] of pending) {
      cells[column] = value.text
      if (value.remaining > 1) nextPending.set(column, { text: value.text, remaining: value.remaining - 1 })
    }
    let column = 0
    for (const m of row.inner.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
      while (cells[column] !== undefined) column++
      const text = strip(m[3])
      const colspan = Math.max(1, Number(m[2].match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))
      const rowspan = Math.max(1, Number(m[2].match(/\browspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))
      for (let offset = 0; offset < colspan; offset++) {
        cells[column + offset] = text
        if (rowspan > 1) nextPending.set(column + offset, { text, remaining: rowspan - 1 })
      }
      column += colspan
    }
    pending.clear()
    for (const [key, value] of nextPending) pending.set(key, value)
    return cells
  }).filter((row) => row.length)
}

function rawRowsOf(html) {
  return records(html, 'tr').map((row) => [...row.inner.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((cell) => cell[2]))
}

const hasNestedMarkup = (cell) => /<[a-z][^>]*>/i.test(cell ?? '')
const validModelId = (id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id)

function decimal(value) {
  const text = value.trim().replace(/[¥￥元\s,]/g, '')
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) throw new CnyPriceBookError('official CNY price is not a plain decimal', 'invalid-cny-number')
  const normalized = text.startsWith('.') ? `0${text}` : text
  if (!/[1-9]/.test(normalized)) return normalized.includes('.') ? `0.${normalized.split('.')[1]}` : '0'
  return normalized
}

export function validateCnyPriceBook(input) {
  if (!input || input.currency !== 'CNY' || input.unit !== 'per_1m_tokens' || !input.models || typeof input.models !== 'object' || Array.isArray(input.models)) throw new CnyPriceBookError('invalid CNY price book shape')
  const models = Object.create(null)
  for (const [id, model] of Object.entries(input.models)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !model || typeof model.displayName !== 'string' || !model.displayName.trim()) throw new CnyPriceBookError('invalid CNY model identity')
    models[id] = { displayName: model.displayName.trim() }
    for (const phase of PHASES) {
      if (!model[phase] || typeof model[phase] !== 'object') throw new CnyPriceBookError(`missing CNY ${phase} prices`)
      models[id][phase] = Object.fromEntries(FIELDS.map((field) => {
        if (typeof model[phase][field] !== 'string') throw new CnyPriceBookError(`missing CNY ${phase}.${field}`)
        const value = decimal(model[phase][field])
        return [field, value]
      }))
    }
  }
  if (!Object.keys(models).length) throw new CnyPriceBookError('CNY model list is empty')
  const source = input.source
  if (!source || source.url !== OFFICIAL_CNY_PRICING_URL || !Number.isFinite(Date.parse(source.fetchedAt))) throw new CnyPriceBookError('invalid CNY official source metadata')
  return { schemaVersion: 1, currency: 'CNY', unit: 'per_1m_tokens', source: { ...source }, models }
}

export function parseOfficialCnyPricingHtml(html, metadata = {}) {
  let parserStage = 'html-parse'
  let parserTableCount = 0
  let parserRowCount = 0
  let candidateModelRowCount = 0
  let candidateModelVersionRowCount = 0
  try {
    if (typeof html !== 'string' || html.length < 100) throw new CnyPriceBookError('official CNY pricing document is empty or too short', 'empty-document')
    const text = strip(html)
    if (!/百万\s*tokens?/i.test(text) || !/(?:人民币|CNY|元)/.test(text)) throw new CnyPriceBookError('CNY currency or per-million unit is not explicit', 'unknown-cny-unit')
    parserStage = 'table-discovery'
    const allTables = records(html, 'table')
    parserTableCount = allTables.length
    const tableRows = allTables.map((table) => rowsOf(table.inner))
    parserRowCount = tableRows.reduce((count, rows) => count + rows.length, 0)
    const pricingTables = allTables.filter(({ attrs, text: body }) => /pricing|价格/i.test(`${attrs} ${body}`) && /缓存命中/.test(body) && /缓存未命中/.test(body) && /输出/.test(body))
    if (pricingTables.length !== 1) throw new CnyPriceBookError(`expected one official CNY pricing table; found ${pricingTables.length}`, pricingTables.length ? 'ambiguous-cny-table' : 'missing-cny-table')
    parserStage = 'model-metadata'
    const details = allTables.map((table, index) => ({ ...table, tableIndex: index, rows: tableRows[index], rawRows: rawRowsOf(table.inner) })).filter(({ attrs, text: body }) => /model-details|模型版本/.test(`${attrs} ${body}`) && /模型/.test(body))
    const modelVersions = new Map()
    const modelCandidateRows = []
    const versionCandidateRows = []
    let metadataFailureReason = null
    let selectedModelColumns = []
    let selectedModelValues = []
    let selectedVersionValues = []
    let selectedModelCandidate = null
    let selectedVersionCandidate = null
    for (const { rows, tableIndex } of details) {
      candidateModelRowCount += rows.filter((row) => ['MODEL', '模型'].includes(normalizeHeading(row[0] ?? ''))).length
      candidateModelVersionRowCount += rows.filter((row) => ['MODEL VERSION', '模型版本'].includes(normalizeHeading(row[0] ?? ''))).length
      rows.forEach((row, rowIndex) => {
        if (['MODEL', '模型'].includes(normalizeHeading(row[0] ?? ''))) modelCandidateRows.push({ tableIndex, rowIndex, row })
        if (['MODEL VERSION', '模型版本'].includes(normalizeHeading(row[0] ?? ''))) versionCandidateRows.push({ tableIndex, rowIndex, row })
      })
      const modelIndex = rows.findIndex((row) => ['MODEL', '模型'].includes(normalizeHeading(row[0] ?? '')))
      const versionIndex = rows.findIndex((row) => ['MODEL VERSION', '模型版本'].includes(normalizeHeading(row[0] ?? '')))
      if (modelIndex < 0) continue
      const modelRow = rows[modelIndex]
      const modelColumns = modelRow.flatMap((value, columnIndex) => {
        const modelId = value.trim()
        return columnIndex > 0 && validModelId(modelId) ? [{ columnIndex, modelId }] : []
      })
      if (selectedModelCandidate === null) {
        selectedModelCandidate = { tableIndex, rowIndex: modelIndex, row: modelRow }
        selectedModelColumns = modelColumns
        selectedModelValues = modelRow.slice(1).map((value) => value?.trim() ?? '')
      }
      if (versionIndex < 0) {
        metadataFailureReason ??= 'version-row-missing'
        continue
      }
      const versionRow = rows[versionIndex]
      if (selectedVersionCandidate === null) {
        selectedVersionCandidate = { tableIndex, rowIndex: versionIndex, row: versionRow }
        selectedVersionValues = versionRow.slice(1).map((value) => value?.trim() ?? '')
      }
      if (!modelColumns.length) {
        metadataFailureReason ??= 'no-valid-model-id'
        continue
      }
      const modelIds = modelColumns.map(({ modelId }) => modelId)
      if (new Set(modelIds).size !== modelIds.length) {
        metadataFailureReason ??= 'duplicate-model-id'
        continue
      }
      const pairs = modelColumns.map(({ columnIndex, modelId }) => ({ modelId, version: versionRow[columnIndex]?.trim() ?? '' }))
      if (pairs.some(({ version }) => !version)) {
        metadataFailureReason ??= 'missing-version-for-model-column'
        continue
      }
      if (pairs.some(({ modelId }) => modelVersions.has(modelId))) {
        metadataFailureReason ??= 'duplicate-model-id'
        continue
      }
      for (const { modelId, version } of pairs) modelVersions.set(modelId, version)
    }
    if (candidateModelRowCount === 0) metadataFailureReason ??= 'model-row-missing'
    if (candidateModelVersionRowCount === 0) metadataFailureReason ??= 'version-row-missing'
    if (selectedModelCandidate && !selectedModelColumns.length) metadataFailureReason ??= 'no-valid-model-id'
    if (!modelVersions.size || metadataFailureReason) {
      const modelCandidate = selectedModelCandidate ?? modelCandidateRows[0] ?? null
      const versionCandidate = selectedVersionCandidate ?? versionCandidateRows.find((candidate) => candidate.tableIndex === modelCandidate?.tableIndex) ?? versionCandidateRows[0] ?? null
      const sameTable = Boolean(modelCandidate && versionCandidate && modelCandidate.tableIndex === versionCandidate.tableIndex)
      const modelValues = selectedModelValues.length ? selectedModelValues : modelCandidate?.row.slice(1).map((value) => value?.trim() ?? '') ?? []
      const versionValues = selectedVersionValues.length ? selectedVersionValues : versionCandidate?.row.slice(1).map((value) => value?.trim() ?? '') ?? []
      const modelColumns = selectedModelColumns.length ? selectedModelColumns : modelCandidate?.row.flatMap((value, columnIndex) => {
        const modelId = value.trim()
        return columnIndex > 0 && validModelId(modelId) ? [{ columnIndex, modelId }] : []
      }) ?? []
      const modelRawValues = modelCandidate ? (details.find((table) => table.tableIndex === modelCandidate.tableIndex)?.rawRows[modelCandidate.rowIndex] ?? []).slice(1) : []
      const versionRawValues = versionCandidate ? (details.find((table) => table.tableIndex === versionCandidate.tableIndex)?.rawRows[versionCandidate.rowIndex] ?? []).slice(1) : []
      const modelIds = modelColumns.map(({ modelId }) => modelId)
      const modelIdsUnique = new Set(modelIds).size === modelIds.length
      const modelIdsValidCount = modelIds.length
      const correspondingVersions = modelColumns.map(({ columnIndex }) => versionCandidate?.row[columnIndex]?.trim() ?? '')
      if (metadataFailureReason === null) metadataFailureReason = modelVersions.size ? 'other-metadata-validation' : 'no-valid-model-id'
      const error = new CnyPriceBookError('official model ids and versions were not identified', 'missing-cny-model-metadata')
      error.metadataDiagnostic = {
        modelCandidateTableIndex: modelCandidate?.tableIndex ?? -1,
        modelCandidateRowIndex: modelCandidate?.rowIndex ?? -1,
        versionCandidateTableIndex: versionCandidate?.tableIndex ?? -1,
        versionCandidateRowIndex: versionCandidate?.rowIndex ?? -1,
        metadataRowsSameTable: sameTable,
        modelRowCellCount: modelCandidate?.row.length ?? 0,
        versionRowCellCount: versionCandidate?.row.length ?? 0,
        modelValueCellCount: modelValues.length,
        versionValueCellCount: versionValues.length,
        modelNormalizedValueCount: modelValues.filter(Boolean).length,
        versionNormalizedValueCount: versionValues.filter(Boolean).length,
        modelEmptyValueCount: modelValues.filter((value) => !value).length,
        versionEmptyValueCount: versionValues.filter((value) => !value).length,
        modelValueCellsWithNestedMarkupCount: modelRawValues.filter(hasNestedMarkup).length,
        versionValueCellsWithNestedMarkupCount: versionRawValues.filter(hasNestedMarkup).length,
        modelIdsValidCount,
        modelIdsInvalidCount: 0,
        modelCandidateCellCount: modelValues.length,
        recognizedModelIdCount: modelIdsValidCount,
        structuralNonModelCellCount: modelValues.length - modelIdsValidCount,
        versionValuesNonEmptyCount: versionValues.filter(Boolean).length,
        modelVersionCountEqual: correspondingVersions.length === modelColumns.length && correspondingVersions.every(Boolean),
        modelIdsUnique,
        normalizedModelValuesContainDeepseekFlash: modelValues.some((value) => value.toLowerCase() === 'deepseek-flash'),
        metadataFailureReason,
      }
      throw error
    }
    parserStage = 'price-table'
    const rows = tableRows[allTables.indexOf(pricingTables[0])]
    const modelHeader = rows.find((row) => row.some((cell) => modelVersions.has(cell)))
    const ids = modelHeader?.filter((cell) => modelVersions.has(cell)) ?? []
    if (!ids.length || ids.length !== modelVersions.size || new Set(ids).size !== ids.length) throw new CnyPriceBookError('CNY model columns do not match official model metadata', 'cny-model-conflict')
    const values = new Map()
    parserStage = 'numeric-parse'
    for (const row of rows) {
      const phaseIndex = row.findIndex((cell) => /^(?:高峰时段|空闲时段)$/.test(cell))
      if (phaseIndex < 0) continue
      const metric = row.slice(0, phaseIndex).join(' ')
      const phase = row[phaseIndex] === '高峰时段' ? 'peak' : 'offpeak'
      const field = /缓存命中/.test(metric) ? 'cacheHitInput' : /缓存未命中/.test(metric) ? 'cacheMissInput' : /输出/.test(metric) ? 'output' : null
      if (!field) throw new CnyPriceBookError(`unknown CNY pricing metric: ${metric}`, 'unknown-cny-metric')
      const cells = row.slice(phaseIndex + 1)
      if (cells.length !== ids.length) throw new CnyPriceBookError('CNY price row does not match model columns', 'invalid-cny-table')
      ids.forEach((id, i) => {
        const key = `${id}:${phase}:${field}`
        if (values.has(key)) throw new CnyPriceBookError('duplicate CNY price component', 'duplicate-cny-price')
        values.set(key, decimal(cells[i]))
      })
    }
    const models = Object.create(null)
    for (const id of ids) {
      models[id] = { displayName: modelVersions.get(id) }
      for (const phase of PHASES) {
        models[id][phase] = Object.fromEntries(FIELDS.map((field) => {
          const key = `${id}:${phase}:${field}`
          if (!values.has(key)) throw new CnyPriceBookError(`missing CNY price component ${key}`, 'missing-cny-price')
          return [field, values.get(key)]
        }))
      }
    }
    const fetchedAt = metadata.fetchedAt ?? new Date().toISOString()
    parserStage = 'validation'
    return validateCnyPriceBook({
      schemaVersion: 1, currency: 'CNY', unit: 'per_1m_tokens', models,
      source: { url: OFFICIAL_CNY_PRICING_URL, requestedUrl: metadata.requestedUrl ?? OFFICIAL_CNY_PRICING_URL, finalUrl: metadata.finalUrl ?? OFFICIAL_CNY_PRICING_URL, fetchedAt, contentHash: metadata.contentHash ?? `sha256:${createHash('sha256').update(html).digest('hex')}`, etag: metadata.etag ?? null, lastModified: metadata.lastModified ?? null },
    })
  } catch (error) {
    if (error && typeof error === 'object') error.parserDiagnostic = { parserTableCount, parserRowCount, candidateModelRowCount, candidateModelVersionRowCount, parserStage, errorCode: error.code ?? 'cny-parse-failed', ...(error.metadataDiagnostic ?? {}) }
    throw error
  }
}

export function isCnyBookCompatible(bookLike, usdPolicy) {
  try {
    const book = validateCnyPriceBook(bookLike)
    const ids = Object.keys(usdPolicy.models ?? {})
    return ids.length === Object.keys(book.models).length && ids.every((id) => book.models[id]?.displayName === usdPolicy.models[id]?.displayName)
  } catch { return false }
}

export function formatDecimalAmount(value, currency) {
  const text = decimal(String(value))
  const [integer, fraction = ''] = text.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const padded = fraction.padEnd(2, '0')
  const symbol = currency === 'CNY' ? '¥' : '$'
  return `${symbol}${grouped}${padded ? `.${padded}` : ''}`
}
