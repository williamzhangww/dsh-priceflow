import { semanticPolicy } from './policy-schema.mjs'

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

export function diffPolicies(previous, next) {
  if (!previous) return { changed: true, fromPolicyId: null, toPolicyId: next.policyId, changes: [{ kind: 'initial-policy' }] }
  const a = semanticPolicy(previous)
  const b = semanticPolicy(next)
  const changes = []
  if (a.currency !== b.currency) changes.push({ kind: 'currency', from: a.currency, to: b.currency })
  if (a.unit !== b.unit) changes.push({ kind: 'unit', from: a.unit, to: b.unit })
  if (!equal(a.schedule, b.schedule)) changes.push({ kind: 'schedule', from: a.schedule, to: b.schedule })
  if (!equal(a.schedule.weekdays, b.schedule.weekdays)) changes.push({ kind: 'weekdays', from: a.schedule.weekdays, to: b.schedule.weekdays })
  if (!equal(a.schedule.peakWindows, b.schedule.peakWindows)) changes.push({ kind: 'peak-windows', from: a.schedule.peakWindows, to: b.schedule.peakWindows })
  const exclusionsA = a.schedule.exclusions ?? []
  const exclusionsB = b.schedule.exclusions ?? []
  for (const exclusion of exclusionsA) {
    const match = exclusionsB.find((value) => value.kind === exclusion.kind)
    if (!match) changes.push({ kind: 'holiday-exclusion-removed', from: exclusion })
    else {
      if (match.jurisdiction !== exclusion.jurisdiction) changes.push({ kind: 'holiday-exclusion-jurisdiction-changed', from: exclusion.jurisdiction, to: match.jurisdiction })
      const semanticsA = { calendarTimeZone: exclusion.calendarTimeZone, calendarId: exclusion.calendarId }
      const semanticsB = { calendarTimeZone: match.calendarTimeZone, calendarId: match.calendarId }
      if (!equal(semanticsA, semanticsB)) changes.push({ kind: 'holiday-calendar-semantics-changed', from: semanticsA, to: semanticsB })
    }
  }
  for (const exclusion of exclusionsB) if (!exclusionsA.some((value) => value.kind === exclusion.kind)) changes.push({ kind: 'holiday-exclusion-added', to: exclusion })
  const ids = new Set([...Object.keys(a.models), ...Object.keys(b.models)])
  for (const modelId of [...ids].sort()) {
    if (!Object.hasOwn(a.models, modelId)) changes.push({ kind: 'model-added', modelId, to: b.models[modelId] })
    else if (!Object.hasOwn(b.models, modelId)) changes.push({ kind: 'model-removed', modelId, from: a.models[modelId] })
    else if (!equal(a.models[modelId], b.models[modelId])) changes.push({ kind: 'model-changed', modelId, from: a.models[modelId], to: b.models[modelId] })
  }
  return { changed: changes.length > 0, fromPolicyId: previous.policyId, toPolicyId: next.policyId, changes }
}
