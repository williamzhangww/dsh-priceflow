import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const bundlePath = new URL('../client/client.js', import.meta.url)

async function loadClient({ fetchImpl = async () => jsonResponse({ ok: true, data: {} }), reactOverrides = {}, captureReact = false, locale = 'zh' } = {}) {
  const source = await readFile(bundlePath, 'utf8')
  let registration
  const hooks = { refs: [], states: [] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (value) => { const ref = { current: value }; hooks.refs.push(ref); return ref },
    useState: (initial) => { const state = { value: typeof initial === 'function' ? initial() : initial }; hooks.states.push(state); return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next }] },
    useEffect: () => {},
    ...reactOverrides,
  }
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: { visibilityState: 'visible', createElement: () => ({ remove() {} }), head: { append() {} } },
    fetch: fetchImpl,
    AbortController,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.runInNewContext(source, context)
  assert.equal(registration.id, 'dsh-priceflow')
  const client = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected client module request: ${name}`)
  })
  const component = client.PriceFlowDock
  client.PriceFlowDock = (props) => component({ ...props, t: (key, params = {}) => {
    const activeLocale = typeof locale === 'string' ? locale : locale.current
    return (client.dictionaries[activeLocale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
  } })
  if (captureReact) client.testHooks = hooks
  return client
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value }
}

const plainInput = (draft = 'hello') => ({ draft, draftRev: 1, attachmentIds: [], attachmentCount: 0, phase: 'plain' })
const snapshot = ({ phase = 'PEAK', trustStatus = 'verified', canAutoSchedule = true, waiting = 2, queue = {}, modelPricing = { modelId: null, prices: null } } = {}) => ({
  pricing: { phase, nextPhase: phase === 'PEAK' ? 'OFF-PEAK' : 'PEAK', transitionAtUtcMs: 1_800_000_000_000, trustStatus, canAutoSchedule, policyId: 'sha256:abcdef1234567890', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  modelPricing,
  sync: { lastSuccessfulFetchAt: 1_799_000_000_000 },
  calendar: { status: 'not-required' },
  queue: { waiting, queued: waiting, delivering: 1, submitted: 3, blocked: 1, cancelled: 0, ...queue },
  delivery: { backend: 'session-controller' },
})

function flatten(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  return flatten(node.children)
}

function findAll(node, predicate, result = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, result); return result }
  if (!node || typeof node !== 'object') return result
  if (predicate(node)) result.push(node)
  findAll(node.children, predicate, result)
  return result
}

test('countdown formatting is stable and clamps expired transitions', async () => {
  const client = await loadClient()
  assert.equal(client.formatCountdown(0), '00:00:00')
  assert.equal(client.formatCountdown(3_661_900), '01:01:01')
  assert.equal(client.formatCountdown(-10_000), '00:00:00')
})

test('queue eligibility exists only at trusted PEAK and accepts text references but refuses attachments', async () => {
  const client = await loadClient()
  const base = { sessionId: 'session-a', input: plainInput(), canAutoSchedule: true, pricingPhase: 'PEAK' }
  assert.equal(client.getEligibility({ ...base, input: plainInput('  ') }), false)
  assert.equal(client.getEligibility({ ...base, input: plainInput('@requirements.txt') }), true)
  assert.equal(client.getEligibility({ ...base, input: { ...plainInput('hello'), attachmentCount: 1 } }), false)
  assert.equal(client.getEligibility({ ...base, input: { ...plainInput(''), attachmentCount: 1 } }), false)
  assert.equal(client.getEligibility({ ...base, input: { ...plainInput(), attachmentCount: null } }), false)
  assert.equal(client.getEligibility({ ...base, input: plainInput(' /help') }), false)
  assert.equal(client.getEligibility({ ...base, input: { ...plainInput(' /help'), attachmentCount: 1 } }), false)
  for (const phase of ['adjudicating', 'claimed', 'submitting']) assert.equal(client.getEligibility({ ...base, input: { ...plainInput(), phase } }), false)
  assert.equal(client.getEligibility({ ...base, canAutoSchedule: false }), false)
  assert.equal(client.getEligibility({ ...base, pricingPhase: undefined }), false)
  assert.equal(client.getEligibility({ ...base, pricingPhase: 'OFF-PEAK' }), false)
  assert.equal(client.getEligibility({ ...base, pending: true }), false)
  assert.equal(client.getEligibility({ ...base, sessionId: undefined }), false)
  assert.equal(client.getEligibility(base), true)
})

test('trust warnings distinguish unverified and stale-verified pricing', async () => {
  const client = await loadClient()
  assert.equal(client.trustWarning('bundled-fixture'), '⚠ 规则未验证')
  assert.equal(client.trustWarning('untrusted'), '⚠ 规则未验证')
  assert.equal(client.trustWarning('stale-verified'), '⚠ 使用已验证缓存')
  assert.equal(client.trustWarning('verified'), '')
})

test('composer renders PEAK action with a compact pricing inspector', async () => {
  const client = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot(), error: null, busy: false, refreshing: false, now: 1_799_999_998_000, notice: null }, () => {}] } })
  const tree = client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: { setDraft() {} } })
  const text = flatten(tree)
  assert.match(text, /峰价/)
  assert.match(text, /队列 2/)
  assert.equal(findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本').length, 1)
  assert.doesNotMatch(text, /当前模型信息暂不可用|No official price| —/)
  assert.match(text, /价格规则 · 已验证/)
  assert.match(text, /官方来源 ↗/)
  assert.match(text, /有 1 条消息需要处理/)
  assert.doesNotMatch(text, /当前阶段|下一阶段|倒计时|api-docs\.deepseek\.com|sha256:abcdef1234567890/)
  const links = findAll(tree, (node) => node.type === 'a')
  assert.equal(links[0].props.href, 'https://api-docs.deepseek.com/quick_start/pricing/')
  assert.equal(links[0].props.rel, 'noopener noreferrer')
})

test('advanced inspector expands without exposing copy diagnostics', async () => {
  const client = await loadClient({
    reactOverrides: { useState: () => [{ snapshot: snapshot({ modelPricing: { modelId: 'deepseek-flash', prices: null } }), now: 1_799_999_998_000 }, () => {}] },
    locale: 'zh',
  })
  const tree = client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })
  const detail = findAll(tree, (node) => node.props?.className === 'pf-details')[0]
  const advanced = findAll(detail, (node) => node.props?.className === 'pf-advanced')[0]
  assert.ok(advanced)
  const advancedText = flatten(advanced)
  assert.match(advancedText, /Policy/)
  assert.match(advancedText, /投递/)
  assert.match(advancedText, /queued 2 · delivering 1 · submitted 3/)
  assert.doesNotMatch(flatten(detail), /Copy diagnostics|复制诊断信息/)
  assert.equal(findAll(detail, (node) => node.props?.className === 'pf-copy-diagnostics').length, 0)
  assert.doesNotMatch(flatten(detail), /Policy ID|Delivery backend/)
})

test('PriceFlow user-facing labels follow the injected DSH translator in both locales', async () => {
  for (const [locale, expected, forbidden] of [
    ['en', ['Using verified cache', 'PEAK', 'Pricing details', 'Current price · per 1M tokens', 'Cache hit', 'Cache miss', 'Output', 'Pricing rules · Verified cache', 'Official source', 'Refresh', 'Advanced', 'Send off-peak', 'Enter text'], ['使用已验证缓存', '峰价', '价格详情', '当前价格', '缓存命中', '价格规则', '官方来源', '高级信息', '低谷发送', '请输入文本']],
    ['zh', ['使用已验证缓存', '峰价', '价格详情', '当前价格 · 每百万 Token', '缓存命中', '缓存未命中', '输出', '价格规则 · 已验证缓存', '官方来源', '刷新', '高级信息', '低谷发送', '请输入文本'], ['Pricing details', 'Current price', 'Cache hit', 'Pricing rules', 'Official source', 'Advanced', 'Send off-peak', 'Enter text', 'OFF-PEAK', 'PEAK']],
  ]) {
    const data = snapshot({ trustStatus: 'stale-verified' })
    const model = { 'deepseek-flash': { peak: { cacheHitInput: '0.006', cacheMissInput: '0.3', output: '1.2' } } }
    data.priceBooks = { USD: { trustStatus: 'stale-verified', models: model }, CNY: { trustStatus: 'stale-verified', compatible: true, models: model } }
    const client = await loadClient({ locale, reactOverrides: { useState: () => [{ snapshot: data, now: 1_799_999_998_000 }, () => {}] } })
    const tree = client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput('')), useProjection: () => ({ next: { provider: 'deepseek-official', model: 'deepseek-flash' } }), inputActions: {} })
    const visible = flatten(tree)
    for (const text of expected) assert.ok(visible.includes(text), `${locale} missing ${text}: ${visible}`)
    for (const text of forbidden) assert.ok(!visible.includes(text), `${locale} unexpectedly contains ${text}: ${visible}`)
  }
})

test('mounted PriceFlow content updates when the DSH translator switches locale', async () => {
  const activeLocale = { current: 'en' }
  const client = await loadClient({ locale: activeLocale, reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'OFF-PEAK' }), now: 1_799_999_998_000 }, () => {}] } })
  const props = { sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} }
  const english = flatten(client.PriceFlowDock(props))
  assert.ok(english.includes('Pricing details'))
  assert.ok(english.includes('OFF-PEAK'))
  activeLocale.current = 'zh'
  const chinese = flatten(client.PriceFlowDock(props))
  assert.ok(chinese.includes('价格详情'))
  assert.ok(chinese.includes('谷价'))
  assert.ok(!chinese.includes('Pricing details'))
  assert.ok(!chinese.includes('OFF-PEAK'))
})

test('OFF-PEAK is informational and trust warnings remain visible without a send action', async () => {
  const client = await loadClient()
  const zeroQueue = { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0, cancelled: 0 }
  const offpeakClient = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'OFF-PEAK', queue: zeroQueue }), now: 1_799_999_999_000 }, () => {}] } })
  const offpeakTree = offpeakClient.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })
  const offpeak = flatten(offpeakTree)
  assert.match(offpeak, /谷价/)
  assert.equal(findAll(offpeakTree, (node) => node.props?.['aria-label'] === '低谷发送当前文本').length, 0)
  const compact = flatten(findAll(offpeakTree, (node) => node.props?.className === 'pf-status')[0])
  assert.doesNotMatch(compact, /队列|Queue/)
  assert.doesNotMatch(compact, /低谷发送|Send off-peak/)
  assert.match(offpeak, /谷价/)
  const untrustedClient = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ trustStatus: 'bundled-fixture', canAutoSchedule: false }), now: 1_799_999_999_000 }, () => {}] } })
  const untrusted = untrustedClient.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })
  assert.match(flatten(untrusted), /价格规则 · 尚未验证/)
  assert.equal(findAll(untrusted, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0].props.disabled, true)
  const staleClient = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ trustStatus: 'stale-verified' }), now: 1_799_999_999_000 }, () => {}] } })
  assert.match(flatten(staleClient.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })), /使用已验证缓存/)
  const unknownPhaseClient = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'unknown' }), now: 1_799_999_999_000 }, () => {}] } })
  const unknownPhaseTree = unknownPhaseClient.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })
  assert.match(flatten(unknownPhaseTree), /价格阶段不可用/)
  const unknownCompact = flatten(findAll(unknownPhaseTree, (node) => node.props?.className === 'pf-status')[0])
  assert.doesNotMatch(unknownCompact, /谷价|OFF-PEAK|🟢|后转峰价/)
  assert.equal(findAll(unknownPhaseTree, (node) => node.props?.['aria-label'] === '低谷发送当前文本').length, 0)
})

test('OFF-PEAK informational dock does not read draft or attachment fields', async () => {
  const accessed = []
  const inputState = new Proxy({}, { get(_target, key) { accessed.push(key); return undefined } })
  const client = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'OFF-PEAK' }), now: 1_799_999_999_000 }, () => {}] } })
  const tree = client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(inputState), inputActions: { submit() {} } })
  assert.match(flatten(tree), /谷价/)
  assert.equal(findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本').length, 0)
  assert.deepEqual(accessed, [])
})

test('host action posts the exact scoped session and captured text with same-origin credentials', async () => {
  const requests = []
  const client = await loadClient({ fetchImpl: async (url, init) => {
    requests.push({ url, init })
    return jsonResponse({ ok: true, data: { immediate: false, item: { id: 'q1' } } })
  } })
  const controller = client.createPriceFlowController({ sessionId: 'session-exact', fetchImpl: async (url, init) => {
    requests.push({ url, init })
    return jsonResponse({ ok: true, data: { immediate: false } })
  } })
  await controller.sendOffPeakAware('  captured draft  ')
  const post = requests[0]
  assert.equal(post.url, '/dsh-priceflow/action')
  assert.equal(post.init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(post.init.body), { action: 'sendOffPeakAware', args: { sessionId: 'session-exact', text: '  captured draft  ' } })
  controller.dispose()
})

test('Host queued and immediate ACK results remain distinct from client policy decisions', async () => {
  const client = await loadClient()
  for (const immediate of [false, true]) {
    const controller = client.createPriceFlowController({ sessionId: 'session-a', fetchImpl: async () => jsonResponse({ ok: true, data: { immediate } }) })
    const result = await controller.sendOffPeakAware('draft')
    assert.equal(result.immediate, immediate)
    assert.match(controller.getSnapshot().notice, immediate ? /立即提交/ : /队列/)
    controller.dispose()
  }
})

test('HTTP failure and pricing-untrusted 409 preserve action failure and never report success', async () => {
  const client = await loadClient()
  for (const [status, code] of [[503, 'service-not-ready'], [409, 'pricing-untrusted']]) {
    const controller = client.createPriceFlowController({ sessionId: 'session-a', fetchImpl: async () => jsonResponse({ ok: false, error: { code, message: 'refused' } }, status) })
    await assert.rejects(controller.sendOffPeakAware('keep me'), (error) => error.status === status && error.code === code)
    assert.equal(controller.getSnapshot().notice, null)
    assert.equal(controller.getSnapshot().error, 'refused')
    controller.dispose()
  }
})

test('draft drift guard clears only the exact acknowledged text and revision', async () => {
  const client = await loadClient()
  const captured = { sessionId: 'session-a', draft: 'original', draftRev: 4 }
  assert.equal(client.mayClearCapturedDraft({ draft: 'original', draftRev: 4 }, captured), true)
  assert.equal(client.mayClearCapturedDraft({ draft: 'new typing', draftRev: 5 }, captured), false)
  assert.equal(client.mayClearCapturedDraft({ draft: 'original', draftRev: 5 }, captured), false)
})

test('composer clears unchanged drafts only after queued or immediate Host ACK', async () => {
  for (const immediate of [false, true]) {
    const requests = []
    const client = await loadClient({ captureReact: true, fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return jsonResponse({ ok: true, data: url.endsWith('/action') ? { immediate } : snapshot() })
    }, reactOverrides: { useState: () => [{ snapshot: snapshot(), error: null, busy: false, refreshing: false, now: Date.now(), notice: null }, () => {}] } })
    const cleared = []
    const tree = client.PriceFlowDock({ sessionId: `session-${immediate}`, useInput: (select) => select(plainInput('captured text')), inputActions: { setDraft: (value) => cleared.push(value) } })
    const button = findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0]
    assert.equal(button.props.disabled, false)
    const action = button.props.onClick()
    while (!requests.some((request) => request.url.endsWith('/action'))) await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(cleared, [])
    await action
    assert.deepEqual(cleared, [''])
    client.testHooks.refs[1].current.dispose()
  }
})

test('composer preserves the captured draft after Host and pricing-untrusted errors', async () => {
  for (const status of [503, 409]) {
    const client = await loadClient({ captureReact: true, fetchImpl: async () => jsonResponse({ ok: false, error: { code: status === 409 ? 'pricing-untrusted' : 'service-not-ready', message: 'refused' } }, status), reactOverrides: { useState: () => [{ snapshot: snapshot(), error: null, busy: false, refreshing: false, now: Date.now(), notice: null }, () => {}] } })
    const cleared = []
    const tree = client.PriceFlowDock({ sessionId: 'session-error', useInput: (select) => select(plainInput('keep this draft')), inputActions: { setDraft: (value) => cleared.push(value) } })
    const button = findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0]
    await button.props.onClick()
    assert.deepEqual(cleared, [])
    client.testHooks.refs[1].current.dispose()
  }
})

test('composer Session A ACK cannot clear newer Session B draft after a session switch', async () => {
  let finishAction
  const client = await loadClient({ captureReact: true, fetchImpl: async (url) => {
    if (url.endsWith('/action')) return await new Promise((resolve) => { finishAction = () => resolve(jsonResponse({ ok: true, data: { immediate: false } })) })
    return jsonResponse({ ok: true, data: snapshot() })
  }, reactOverrides: { useState: () => [{ snapshot: snapshot(), error: null, busy: false, refreshing: false, now: Date.now(), notice: null }, () => {}] } })
  const cleared = []
  const tree = client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput('A captured')), inputActions: { setDraft: (value) => cleared.push(value) } })
  const button = findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0]
  const controllerA = client.testHooks.refs[1].current
  const action = button.props.onClick()
  while (!finishAction) await new Promise((resolve) => setImmediate(resolve))
  client.testHooks.refs[0].current = { draft: 'B draft', draftRev: 9 }
  client.testHooks.refs[1].current = { sessionId: 'session-b' }
  finishAction()
  await action
  assert.deepEqual(cleared, [])
  assert.equal(client.testHooks.refs[0].current.draft, 'B draft')
  controllerA.dispose()
})

test('pending Session A action uses only its captured target and cannot address Session B', async () => {
  const client = await loadClient()
  let finish
  const calls = []
  const controllerA = client.createPriceFlowController({ sessionId: 'session-a', fetchImpl: (url, init) => {
    calls.push(JSON.parse(init.body))
    return new Promise((resolve) => { finish = () => resolve(jsonResponse({ ok: true, data: { immediate: false } })) })
  } })
  const currentSessionB = { sessionId: 'session-b', draft: 'B draft', draftRev: 9 }
  const capturedA = { sessionId: 'session-a', draft: 'A draft', draftRev: 3 }
  const pending = controllerA.sendOffPeakAware(capturedA.draft)
  finish()
  await pending
  assert.equal(calls[0].args.sessionId, 'session-a')
  assert.equal(calls[0].args.text, 'A draft')
  assert.equal(client.mayClearCapturedDraft(currentSessionB, capturedA), false)
  controllerA.dispose()
})

test('poll, countdown and visibility timers are removed on dispose', async () => {
  const client = await loadClient()
  const intervals = new Set()
  const timeouts = new Set()
  const listeners = new Set()
  const target = { visibilityState: 'hidden', addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) }
  const controller = client.createPriceFlowController({
    sessionId: 'session-a', fetchImpl: async () => jsonResponse({ ok: true, data: snapshot() }), visibilityTarget: target,
    setTimer: (fn) => { timeouts.add(fn); return fn }, clearTimer: (id) => timeouts.delete(id),
    setIntervalFn: (fn) => { intervals.add(fn); return fn }, clearIntervalFn: (id) => intervals.delete(id),
  })
  controller.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(intervals.size, 2)
  assert.equal(timeouts.size, 1)
  assert.equal(listeners.size, 1)
  controller.dispose()
  assert.equal(intervals.size, 0)
  assert.equal(timeouts.size, 0)
  assert.equal(listeners.size, 0)
})

test('visibility restore refreshes state and disposed controller issues no later requests', async () => {
  const client = await loadClient()
  const listeners = new Set()
  const target = { visibilityState: 'hidden', addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) }
  let requests = 0
  const controller = client.createPriceFlowController({ sessionId: 'session-a', visibilityTarget: target, fetchImpl: async () => { requests++; return jsonResponse({ ok: true, data: snapshot() }) } })
  controller.start()
  await new Promise((resolve) => setImmediate(resolve))
  const before = requests
  target.visibilityState = 'visible'
  for (const listener of listeners) listener()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, before + 1)
  controller.dispose()
  const afterDispose = requests
  assert.equal(await controller.refresh(), null)
  assert.equal(requests, afterDispose)
})

test('OFF-PEAK has no PriceFlow send action for empty, text, attachment, mixed, or command drafts', async () => {
  const requests = []
  let nativeSubmits = 0
  const zeroQueue = { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0, cancelled: 0 }
  const client = await loadClient({ fetchImpl: async (url, init) => { requests.push({ url, init }); return jsonResponse({ ok: true, data: {} }) }, reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'OFF-PEAK', queue: zeroQueue }), error: null, busy: false, refreshing: false, now: 1_799_999_999_000, notice: null }, () => {}] } })
  const inputs = [
    plainInput(''),
    plainInput('ordinary text'),
    { ...plainInput(''), attachmentIds: ['image-a'], attachmentCount: 1 },
    { ...plainInput('ordinary text'), attachmentIds: ['image-a'], attachmentCount: 1 },
    plainInput('/help'),
  ]
  for (const input of inputs) {
    const tree = client.PriceFlowDock({ sessionId: 'session-offpeak', useInput: (select) => select(input), inputActions: { submit: () => { nativeSubmits++ } } })
    assert.equal(findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本').length, 0)
    const compact = flatten(findAll(tree, (node) => node.props?.className === 'pf-status')[0])
    assert.match(compact, /谷价/)
    assert.doesNotMatch(compact, /队列|Queue/)
    assert.doesNotMatch(flatten(tree), /附件将使用正常发送/)
  }
  assert.deepEqual(requests, [])
  assert.equal(nativeSubmits, 0)
})

test('OFF-PEAK hides empty and resolved queue counts but exposes queued, delivering and blocked work', async () => {
  const zeroQueue = { waiting: 0, queued: 0, delivering: 0, submitted: 4, blocked: 0, cancelled: 2 }
  const makeTree = async (queue) => {
    const client = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'OFF-PEAK', queue }), error: null, busy: false, refreshing: false, now: 1_799_999_999_000 }, () => {}] } })
    return client.PriceFlowDock({ sessionId: 'session-a', useInput: (select) => select(plainInput()), inputActions: {} })
  }
  const resolvedTree = await makeTree(zeroQueue)
  const compact = flatten(findAll(resolvedTree, (node) => node.props?.className === 'pf-status')[0])
  assert.doesNotMatch(compact, /队列|Queue/)
  assert.match(flatten(resolvedTree), /submitted 4/)
  assert.equal(findAll(resolvedTree, (node) => node.props?.className === 'pf-queue-alert').length, 0)

  for (const queue of [
    { waiting: 1, queued: 1, delivering: 0, submitted: 0, blocked: 0, cancelled: 0 },
    { waiting: 0, queued: 0, delivering: 1, submitted: 0, blocked: 0, cancelled: 0 },
    { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 1, cancelled: 0 },
  ]) {
    const tree = await makeTree(queue)
    const alert = findAll(tree, (node) => node.props?.className === 'pf-queue-alert' || node.props?.className?.startsWith('pf-queue-alert'))
    assert.equal(alert.length, 1)
    assert.match(flatten(alert[0]), /待处理 1 条|有 1 条消息需要处理/)
  }
  const blockedTree = await makeTree({ waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 2, cancelled: 0 })
  assert.match(flatten(findAll(blockedTree, (node) => node.props?.className?.includes('pf-queue-alert'))[0]), /有 2 条消息需要处理/)
})

test('dual-currency details use DSH next model selection and require verified compatible price books', async () => {
  const usdModels = { 'deepseek-flash': { displayName: 'DeepSeek-V4.1-Flash', offpeak: { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.6 }, peak: { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 } }, 'deepseek-v4-pro': { displayName: 'DeepSeek-V4-Pro-0813', offpeak: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 }, peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 } } }
  const cnyModels = { 'deepseek-flash': { displayName: 'DeepSeek-V4.1-Flash', offpeak: { cacheHitInput: '0.02', cacheMissInput: '1', output: '4' }, peak: { cacheHitInput: '0.04', cacheMissInput: '2', output: '8' } }, 'deepseek-v4-pro': { displayName: 'DeepSeek-V4-Pro-0813', offpeak: { cacheHitInput: '0.15', cacheMissInput: '4.5', output: '13.5' }, peak: { cacheHitInput: '0.30', cacheMissInput: '9.0', output: '27' } } }
  const makeTree = async ({ trustStatus = 'verified', cnyTrust = 'verified', model = 'deepseek-flash', provider = 'deepseek-official', reasoningEffort = 'high' } = {}) => {
    const data = snapshot({ phase: 'PEAK', trustStatus, queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } })
    data.priceBooks = { USD: { trustStatus, currency: 'USD', models: usdModels }, CNY: { trustStatus: cnyTrust, compatible: cnyTrust !== 'unavailable', currency: 'CNY', models: cnyModels } }
    const client = await loadClient({ reactOverrides: { useState: () => [{ snapshot: data, now: 1_799_999_999_000 }, () => {}] } })
    return client.PriceFlowDock({ sessionId: 'session-a', useProjection: (key) => key === 'modelSelection' ? { next: { provider, model, reasoningEffort } } : undefined, useInput: (select) => select(plainInput()), inputActions: {} })
  }
  const verified = await makeTree()
  const detailText = flatten(findAll(verified, (node) => node.props?.className === 'pf-detail-section pf-current-price')[0])
  assert.match(detailText, /¥0\.04/)
  assert.match(detailText, /\$0\.006/)
  assert.doesNotMatch(detailText, /PEAK|OFF-PEAK|phase|Policy|session-controller|queued 0/)
  assert.match(flatten(verified), /高级信息/)
  const advanced = findAll(verified, (node) => node.props?.className === 'pf-advanced')[0]
  assert.equal(advanced.props.open, undefined)
  assert.match(flatten(advanced), /session-controller/)
  assert.match(flatten(advanced), /DeepSeek-V4\.1-Flash · High/)
  assert.match(flatten(await makeTree({ reasoningEffort: undefined })), /DeepSeek-V4\.1-Flash/)
  assert.doesNotMatch(flatten(await makeTree({ reasoningEffort: undefined })), /DeepSeek-V4\.1-Flash · —/)
  const usdOnly = await makeTree({ cnyTrust: 'unavailable' })
  assert.equal(findAll(usdOnly, (node) => node.props?.className === 'pf-detail-section pf-current-price').length, 1)
  const usdOnlyText = flatten(findAll(usdOnly, (node) => node.props?.className === 'pf-detail-section pf-current-price')[0])
  assert.match(usdOnlyText, /USD|美元/)
  assert.doesNotMatch(usdOnlyText, /CNY|人民币|—/)
  const usdOnlyAdvanced = findAll(usdOnly, (node) => node.props?.className === 'pf-advanced')[0]
  assert.match(flatten(usdOnlyAdvanced), /价格源 美元 已验证/)
  assert.doesNotMatch(flatten(usdOnlyAdvanced), /不可用|Unavailable|人民币/)
  const cnyOnly = await makeTree({ trustStatus: 'unavailable' })
  const cnyOnlyText = flatten(findAll(cnyOnly, (node) => node.props?.className === 'pf-detail-section pf-current-price')[0])
  assert.match(cnyOnlyText, /CNY|人民币/)
  assert.doesNotMatch(cnyOnlyText, /USD|美元|—/)
  assert.match(flatten(findAll(cnyOnly, (node) => node.props?.className === 'pf-advanced')[0]), /价格源 人民币 已验证/)
  const noPriceBooks = await makeTree({ trustStatus: 'unavailable', cnyTrust: 'unavailable' })
  assert.equal(findAll(noPriceBooks, (node) => node.props?.className === 'pf-detail-section pf-current-price').length, 0)
  assert.match(flatten(await makeTree({ model: 'deepseek-v4-pro' })), /¥0\.30/)
  assert.doesNotMatch(flatten(await makeTree({ trustStatus: 'bundled-fixture' })), /\$0\.01/)
  assert.doesNotMatch(flatten(await makeTree({ model: 'unknown-model' })), /当前价格|Current price|—/)
  assert.doesNotMatch(flatten(await makeTree({ provider: 'other-provider' })), /当前价格|Current price|—/)
})

test('balance details distinguish missing currencies, zero amounts and stale successful data', async () => {
  const makeTree = async (balance) => {
    const data = snapshot({ phase: 'OFF-PEAK' }); data.priceBooks = {}; data.balance = balance
    const client = await loadClient({ reactOverrides: { useState: () => [{ snapshot: data, now: 1_799_999_999_000 }, () => {}] } })
    return client.PriceFlowDock({ sessionId: 'session-a', useProjection: () => ({ next: { provider: 'deepseek-official', model: 'deepseek-flash' } }), inputActions: {} })
  }
  const noBalance = await makeTree({ status: 'unavailable', fetchedAt: null, isAvailable: null, currencies: {} })
  assert.equal(findAll(noBalance, (node) => node.props?.className === 'pf-detail-section pf-balance-section').length, 0)
  assert.equal(findAll(noBalance, (node) => node.props?.className === 'pf-balance-breakdown').length, 0)
  const zero = await makeTree({ status: 'available', fetchedAt: 1_799_999_000_000, isAvailable: true, currencies: { USD: { totalBalance: '0.00', toppedUpBalance: '0.00', grantedBalance: '0.00' } } })
  const text = flatten(findAll(zero, (node) => node.props?.className === 'pf-detail-main')[0])
  assert.match(text, /美元 \$0\.00/)
  assert.doesNotMatch(text, /人民币|CNY|—/)
  const stale = await makeTree({ status: 'stale', fetchedAt: 1_799_999_000_000, isAvailable: false, currencies: { CNY: { totalBalance: '8.80', toppedUpBalance: '2.20', grantedBalance: '6.60' } } })
  const staleText = flatten(findAll(stale, (node) => node.props?.className === 'pf-detail-main')[0])
  assert.match(staleText, /¥8\.80/)
  assert.match(staleText, /API 当前因余额不足不可用/)
  const advanced = findAll(stale, (node) => node.props?.className === 'pf-advanced')[0]
  assert.match(flatten(advanced), /¥2\.20/)
  assert.match(flatten(advanced), /总额 ¥8\.80 · 充值 ¥2\.20 · 赠送 ¥6\.60/)
  for (const [currencies, expected, absent] of [
    [{ CNY: { totalBalance: '8.80', toppedUpBalance: '8.00', grantedBalance: '0.80' } }, /人民币 ¥8\.80/, /美元|USD|—/],
    [{ USD: { totalBalance: '18.20', toppedUpBalance: '18.20', grantedBalance: '0.00' } }, /美元 \$18\.20/, /人民币|CNY|—/],
    [{ CNY: { totalBalance: '8.80', toppedUpBalance: '8.00', grantedBalance: '0.80' }, USD: { totalBalance: '18.20', toppedUpBalance: '18.20', grantedBalance: '0.00' } }, /人民币 ¥8\.80.*美元 \$18\.20/, /—/],
  ]) {
    const populated = await makeTree({ status: 'available', fetchedAt: 1_799_999_000_000, isAvailable: true, currencies })
    assert.ok(findAll(populated, (node) => node.props?.className === 'pf-detail-section pf-balance-section')[0], flatten(populated))
    const visibleText = flatten(findAll(populated, (node) => node.props?.className === 'pf-detail-section pf-balance-section')[0])
    assert.match(visibleText, expected)
    assert.doesNotMatch(visibleText, absent)
  }
})

test('PEAK ordinary text and file references queue through the Host; no native submit is called', async () => {
  const requests = []
  let nativeSubmits = 0
  const client = await loadClient({ fetchImpl: async (url, init) => { requests.push({ url, init }); return jsonResponse({ ok: true, data: { immediate: false } }) }, reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'PEAK', queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } }), error: null, busy: false, refreshing: false, now: 1_799_999_999_000, notice: null }, () => {}] } })
  for (const input of [plainInput('ordinary prompt'), plainInput('@requirements.txt')]) {
    const tree = client.PriceFlowDock({ sessionId: 'session-peak', useInput: (select) => select(input), inputActions: { submit: () => { nativeSubmits++ }, setDraft() {} } })
    const button = findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0]
    assert.ok(button)
    assert.equal(button.props.disabled, false)
    assert.match(flatten(tree), /进入谷价后自动发送/)
    await button.props.onClick()
    const actionRequest = requests.findLast((request) => request.url.endsWith('/action'))
    assert.equal(JSON.parse(actionRequest.init.body).action, 'sendOffPeakAware')
  }
  assert.equal(nativeSubmits, 0)
})

test('PEAK attachments are visibly disabled, slash commands and empty drafts show their own hints', async () => {
  const requests = []
  let nativeSubmits = 0
  const client = await loadClient({ fetchImpl: async (url, init) => { requests.push({ url, init }); return jsonResponse({ ok: true, data: {} }) }, reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'PEAK' }), error: null, busy: false, refreshing: false, now: 1_799_999_999_000, notice: null }, () => {}] } })
  const cases = [
    [{ ...plainInput('hello'), attachmentIds: ['image-a'], attachmentCount: 1 }, /附件暂不支持延迟发送/],
    [{ ...plainInput(''), attachmentIds: ['image-a'], attachmentCount: 1 }, /附件暂不支持延迟发送/],
    [plainInput('/help'), /命令请使用正常发送/],
    [plainInput(''), /请输入文本/],
    [{ ...plainInput('hello'), attachmentIds: undefined, attachmentCount: null }, /附件状态不可用/],
  ]
  for (const [input, hint] of cases) {
    const tree = client.PriceFlowDock({ sessionId: 'session-peak', useInput: (select) => select(input), inputActions: { submit: () => { nativeSubmits++ } } })
    const button = findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0]
    assert.ok(button)
    assert.equal(button.props.disabled, true)
    assert.match(flatten(tree), hint)
    const row = findAll(tree, (node) => node.props?.className === 'pf-row')[0]
    const action = findAll(row, (node) => node.props?.className === 'pf-action-wrap')[0]
    assert.ok(action)
    assert.equal(findAll(tree, (node) => node.props?.className === 'pf-hint').length, 0)
    const details = findAll(tree, (node) => node.props?.className === 'pf-details')[0]
    assert.equal(findAll(details, (node) => node.props?.className === 'pf-action-hint').length, 0)
    await button.props.onClick()
  }
  const untrustedClient = await loadClient({ reactOverrides: { useState: () => [{ snapshot: snapshot({ phase: 'PEAK', canAutoSchedule: false, trustStatus: 'bundled-fixture' }), now: 1_799_999_999_000 }, () => {}] } })
  const untrusted = untrustedClient.PriceFlowDock({ sessionId: 'session-peak', useInput: (select) => select(plainInput()), inputActions: {} })
  assert.equal(findAll(untrusted, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0].props.disabled, true)
  assert.match(flatten(untrusted), /规则未验证/)
  assert.deepEqual(requests, [])
  assert.equal(nativeSubmits, 0)
})

test('mounted attachment and phase updates recompute PEAK eligibility and remove the action off-peak', async () => {
  const readyView = { snapshot: snapshot({ phase: 'PEAK', queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } }), error: null, busy: false, refreshing: false, now: 1_799_999_999_000, notice: null }
  let input = plainInput('ordinary text')
  const listeners = new Set()
  let hookIndex = 0
  const hooks = []
  let render
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef(initial) { const index = hookIndex++; return hooks[index] ??= { current: initial } },
    useState(initial) {
      const index = hookIndex++
      const value = typeof initial === 'function' ? initial() : initial
      const slot = hooks[index] ??= { value: value?.snapshot === null ? readyView : value }
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect() { hookIndex++ },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = hookIndex++
      let slot = hooks[index]
      if (!slot) {
        slot = { subscribe, snapshot: getSnapshot() }
        slot.unsubscribe = subscribe(() => {
          const next = getSnapshot()
          if (!Object.is(slot.snapshot, next)) { slot.snapshot = next; render() }
        })
        hooks[index] = slot
      } else if (slot.subscribe !== subscribe) {
        slot.unsubscribe?.()
        slot.subscribe = subscribe
        slot.snapshot = getSnapshot()
        slot.unsubscribe = subscribe(() => {
          const next = getSnapshot()
          if (!Object.is(slot.snapshot, next)) { slot.snapshot = next; render() }
        })
      }
      return slot.snapshot
    },
  }
  const requests = []
  let nativeSubmits = 0
  const client = await loadClient({ reactOverrides: React, fetchImpl: async (url, init) => { requests.push({ url, init }); return jsonResponse({ ok: true, data: {} }) } })
  const props = { sessionId: 'session-a', useInput: (select) => React.useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => select(input)), inputActions: { submit: () => { nativeSubmits++ }, setDraft() {} } }
  let tree
  render = () => { hookIndex = 0; tree = client.PriceFlowDock(props) }
  const button = () => findAll(tree, (node) => node.props?.['aria-label'] === '低谷发送当前文本')[0] ?? null
  const updateInput = (next) => { input = next; for (const listener of [...listeners]) listener() }

  render()
  assert.equal(button()?.props.disabled, false)
  const viewState = hooks.find((slot) => slot.value?.snapshot?.pricing)
  assert.ok(viewState)
  updateInput({ ...input, attachmentIds: ['image-a'], attachmentCount: 1 })
  assert.equal(button()?.props.disabled, true)
  assert.match(flatten(tree), /附件暂不支持延迟发送/)
  updateInput({ ...input, attachmentIds: [], attachmentCount: 0 })
  assert.equal(button()?.props.disabled, false)

  viewState.value = { ...viewState.value, snapshot: snapshot({ phase: 'OFF-PEAK', queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } }) }
  render()
  assert.equal(button(), null)
  const compactOffpeak = flatten(findAll(tree, (node) => node.props?.className === 'pf-status')[0])
  assert.doesNotMatch(compactOffpeak, /队列|Queue/)

  viewState.value = { ...viewState.value, snapshot: snapshot({ phase: 'PEAK', queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } }) }
  render()
  assert.equal(button()?.props.disabled, false)
  updateInput({ ...input, attachmentIds: ['image-a'], attachmentCount: 1 })
  assert.equal(button()?.props.disabled, true)
  viewState.value = { ...viewState.value, snapshot: snapshot({ phase: 'OFF-PEAK', queue: { waiting: 0, queued: 0, delivering: 0, submitted: 0, blocked: 0 } }) }
  render()
  assert.equal(button(), null)
  assert.deepEqual(requests, [])
  assert.equal(nativeSubmits, 0)
  hooks.forEach((slot) => slot.unsubscribe?.())
})

test('client registers session composer dock through effect and a disposer-owned slot', async () => {
  const client = await loadClient()
  const events = []
  const slotDispose = () => events.push('slot-dispose')
  const ctx = {
    locale: { register(namespace, dictionaries) { events.push(`locale:${namespace}`); assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort()); return () => events.push('locale-dispose') } },
    effect(effect, label) { events.push(label); const dispose = effect(); if (typeof dispose === 'function') events.push('effect-disposable') },
    slots: {
      inject(name, callback) { events.push(`inject:${name}`); return callback() },
      register(config, component) { events.push(`register:${config.id}:${config.order}`); assert.equal(config.name, 'conversation.composer.dock'); assert.equal(config.locale, 'priceflow'); assert.equal(config.inject('session-exact').sessionId, 'session-exact'); assert.equal(typeof component, 'function'); return slotDispose },
    },
  }
  client.apply(ctx)
  assert.ok(events.includes('dsh-priceflow: composer dock'))
  assert.ok(events.includes('dsh-priceflow: locale dictionary'))
  assert.ok(events.includes('locale:priceflow'))
  assert.ok(events.includes('inject:conversation.composer.dock'))
  assert.ok(events.includes('register:dsh-priceflow:20'))
})
