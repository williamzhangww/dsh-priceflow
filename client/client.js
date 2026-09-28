window.__ModuleLoader__.load({
  id: 'dsh-priceflow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const STATE_URL = '/dsh-priceflow/state'
    const ACTION_URL = '/dsh-priceflow/action'
    const REFRESH_MS = 20_000
    const en = {
      aria: 'PriceFlow pricing and send controls', verified: 'Using verified cache', peak: 'PEAK', offpeak: 'OFF-PEAK', phaseUnavailable: 'Price phase unavailable', phaseLoading: 'Loading price status', untilOffpeak: 'until off-peak', untilPeak: 'until peak', queue: 'Queue', send: 'Send off-peak', sendCurrent: 'Send current text off-peak', enterText: 'Enter text', commands: 'Commands should use normal Send', attachments: 'Attachments cannot be queued yet; send normally or wait for off-peak', unverified: 'Unverified policy cannot guarantee off-peak delivery.', attachmentUnknown: 'Attachment state is unavailable; queuing is disabled.', sessionUnavailable: 'Session unavailable', inputBusy: 'Input is busy', queueHint: 'This only queues the text; it will send after off-peak begins.', submitted: 'Submitted; newer draft text was kept.', immediate: 'Sent immediately because off-peak is active.', queued: 'Added to the off-peak queue.', sendFailed: 'Off-peak send failed.', refreshFailed: 'Official pricing refresh failed.', balanceRefreshFailed: 'Balance refresh failed.', details: 'Pricing details', current: 'Current price · per 1M tokens', hit: 'Cache hit', miss: 'Cache miss', output: 'Output', balance: 'Account balance', refreshBalance: 'Refresh account balance', cny: 'CNY', usd: 'USD', insufficient: 'API is currently unavailable due to insufficient balance', updated: 'Updated {time}', refreshFailedLabel: 'Refresh failed', updatedAt: 'Updated {time}', verifiedRules: 'Pricing rules · Verified', cachedRules: 'Pricing rules · Verified cache', unverifiedRules: 'Pricing rules · Not verified', checkRules: 'Pricing rules · Check status', verifiedLabel: 'Verified', cachedLabel: 'Verified cache', unavailable: 'Unavailable', refresh: 'Refresh', refreshing: 'Refreshing…', lastSync: 'Last successful sync {time}', updatedShort: '{time} updated', official: 'Official source ↗', attentionOne: '{count} message needs attention', attentionMany: '{count} messages need attention', pending: 'Pending: {count}', advanced: 'Advanced', model: 'Model', modelId: 'Model ID', priceSource: 'Price source', calendar: 'Calendar', delivery: 'Delivery', lastSyncLabel: 'Last sync', total: 'Total', toppedUp: 'Topped up', granted: 'Granted', queuedCount: 'queued {count}', deliveringCount: 'delivering {count}', submittedCount: 'submitted {count}', blockedCount: 'blocked {count}', cancelledCount: 'cancelled {count}', warningUnverified: '⚠ Pricing rules are not verified', warningCache: '⚠ Using verified cache', peakShort: 'until off-peak', offpeakShort: 'until peak', toOffpeak: 'until off-peak', toPeak: 'until peak', peakQueue: 'Queue {count}', actionUnavailable: 'Pricing phase unavailable; queuing is disabled.', balanceTotal: 'Total', balanceTopup: 'Topped up', balanceGrant: 'Granted', today: 'Today', phasePeak: 'PEAK', phaseOffpeak: 'OFF-PEAK', error: 'PriceFlow state unavailable', stillAttention: '{count} item still needs attention', stillAttentionMany: '{count} items still need attention', blocked: '{count} blocked'
    }
    const zh = {
      aria: 'PriceFlow 价格与发送控制', verified: '使用已验证缓存', peak: '峰价', offpeak: '谷价', phaseUnavailable: '价格状态不可用', phaseLoading: '价格状态加载中', untilOffpeak: '后转谷价', untilPeak: '后转峰价', queue: '队列', send: '低谷发送', sendCurrent: '低谷发送当前文本', enterText: '请输入文本', commands: '命令请使用正常发送', attachments: '附件暂不支持延迟发送；请正常发送或等到谷价', unverified: '规则未验证，不能保证低谷发送。', attachmentUnknown: '附件状态不可用，无法安全排队。', sessionUnavailable: '当前会话不可用', inputBusy: '输入当前不可提交', queueHint: '峰价下点击只会排队，进入谷价后自动发送。', submitted: '已提交；你之后输入的草稿已保留。', immediate: '当前即为谷价，已立即提交。', queued: '已加入低谷发送队列。', sendFailed: '低谷发送失败。', refreshFailed: '官方价格刷新失败。', balanceRefreshFailed: '余额刷新失败。', details: '价格详情', current: '当前价格 · 每百万 Token', hit: '缓存命中', miss: '缓存未命中', output: '输出', balance: '账户余额', refreshBalance: '刷新账户余额', cny: '人民币', usd: '美元', insufficient: 'API 当前因余额不足不可用', updated: '更新于 {time}', refreshFailedLabel: '刷新失败', updatedAt: '更新于 {time}', verifiedRules: '价格规则 · 已验证', cachedRules: '价格规则 · 已验证缓存', unverifiedRules: '价格规则 · 尚未验证', checkRules: '价格规则 · 状态需检查', verifiedLabel: '已验证', cachedLabel: '已验证缓存', unavailable: '不可用', refresh: '刷新', refreshing: '正在刷新…', lastSync: '上次成功同步 {time}', updatedShort: '{time} 更新', official: '官方来源 ↗', attentionOne: '有 {count} 条消息需要处理', attentionMany: '有 {count} 条消息需要处理', pending: '待处理 {count} 条', advanced: '高级信息', model: '模型', modelId: '模型 ID', priceSource: '价格源', calendar: '日历', delivery: '投递', lastSyncLabel: '上次同步', total: '总额', toppedUp: '充值', granted: '赠送', queuedCount: 'queued {count}', deliveringCount: 'delivering {count}', submittedCount: 'submitted {count}', blockedCount: 'blocked {count}', cancelledCount: 'cancelled {count}', warningUnverified: '⚠ 规则未验证', warningCache: '⚠ 使用已验证缓存', actionUnavailable: '价格阶段不可用，暂不提供排队操作。', balanceTotal: '总额', balanceTopup: '充值', balanceGrant: '赠送', today: '今天', phasePeak: '峰价', phaseOffpeak: '谷价', stillAttention: '仍有 {count} 条待处理', stillAttentionMany: '仍有 {count} 条待处理', blocked: '阻塞 {count}', error: '价格状态暂不可用', offpeakShort: '后转峰价', peakQueue: '队列 {count}', peakShort: '后转谷价', toOffpeak: '后转谷价', toPeak: '后转峰价'
    }
    const dictionaries = { en, zh }
    const interpolate = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    const registerLocale = (ctx) => {
      return ctx.locale.register('priceflow', { zh, en })
    }

    function formatCountdown(milliseconds) {
      const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
    }

    function getEligibility({ sessionId, input, canAutoSchedule, pricingPhase, pending = false }) {
      if (pricingPhase !== 'PEAK' || !sessionId || !input || input.phase !== 'plain' || pending || !canAutoSchedule) return false
      if (!Number.isInteger(input.attachmentCount) || input.attachmentCount < 0) return false
      if (input.draft?.trimStart().startsWith('/')) return false
      return input.attachmentCount === 0 && Boolean(input.draft?.trim())
    }

    function mayClearCapturedDraft(current, captured) {
      return current?.draftRev === captured.draftRev && current?.draft === captured.draft
    }

    function responseError(data, response) {
      const code = data?.error?.code ?? `http-${response.status}`
      const message = data?.error?.message ?? 'PriceFlow request failed'
      const error = new Error(message)
      error.code = code
      error.status = response.status
      return error
    }

    function createPriceFlowController({
      sessionId,
      fetchImpl = globalThis.fetch,
      now = () => Date.now(),
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      visibilityTarget = globalThis.document,
      onChange = () => {},
    }) {
      let disposed = false
      let stateRequest = null
      let transitionTimer = null
      let pollTimer = null
      let clockTimer = null
      let current = { snapshot: null, error: null, busy: false, refreshing: false, now: now(), notice: null }
      const listeners = new Set()
      const publish = (patch) => {
        if (disposed) return
        current = { ...current, ...patch }
        onChange(current)
        for (const listener of [...listeners]) listener(current)
      }
      const listen = () => () => {}
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const getSnapshot = () => current

      async function getJson(url, init = {}) {
        if (disposed) throw Object.assign(new Error('PriceFlow component disposed'), { code: 'disposed' })
        const response = await fetchImpl(url, { credentials: 'same-origin', ...init })
        let data
        try { data = await response.json() } catch { throw Object.assign(new Error('Invalid PriceFlow response'), { code: 'invalid-response' }) }
        if (!response.ok || data?.ok !== true) throw responseError(data, response)
        return data.data
      }

      function scheduleTransition() {
        if (transitionTimer !== null) clearTimer(transitionTimer)
        transitionTimer = null
        const at = current.snapshot?.pricing?.transitionAtUtcMs
        if (!Number.isFinite(at)) return
        const delay = Math.max(250, Math.min(2_147_000_000, at - now()))
        transitionTimer = setTimer(() => {
          transitionTimer = null
          if (!disposed) void refresh().catch(() => {})
        }, delay)
      }

      async function refresh() {
        if (disposed) return null
        if (stateRequest) return stateRequest
        publish({ refreshing: true })
        stateRequest = getJson(STATE_URL, { method: 'GET', signal: abortController.signal })
          .then((snapshot) => {
            if (!disposed) {
              publish({ snapshot, error: null, now: now() })
              scheduleTransition()
            }
            return snapshot
          })
          .catch((error) => {
            if (!disposed && error?.name !== 'AbortError') publish({ error: error.message ?? 'PriceFlow state unavailable' })
            throw error
          })
          .finally(() => {
            stateRequest = null
            if (!disposed) publish({ refreshing: false })
          })
        return stateRequest
      }

      const abortController = new AbortController()
      const onVisibility = () => {
        if (visibilityTarget?.visibilityState === 'visible') void refresh().catch(() => {})
      }

      async function action(actionName, args = {}) {
        return getJson(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: actionName, args }),
          signal: abortController.signal,
        })
      }

      async function sendOffPeakAware(text) {
        if (disposed) throw Object.assign(new Error('PriceFlow component disposed'), { code: 'disposed' })
        if (current.busy) throw Object.assign(new Error('PriceFlow action already in progress'), { code: 'busy' })
        publish({ busy: true, notice: null, error: null })
        try {
          const result = await action('sendOffPeakAware', { sessionId, text })
          if (!disposed) {
            publish({ notice: result?.immediate ? '当前即为谷价，已立即提交。' : '已加入低谷发送队列。' })
            void refresh().catch(() => {})
          }
          return result
        } catch (error) {
          if (!disposed) publish({ error: error.message ?? '低谷发送失败。' })
          throw error
        } finally {
          if (!disposed) publish({ busy: false })
        }
      }

      async function refreshPricing() {
        if (disposed || current.refreshing) return null
        publish({ refreshing: true, error: null })
        try {
          await action('refreshPricing')
          return await refresh()
        } catch (error) {
          if (!disposed) publish({ error: error.message ?? '官方价格刷新失败。' })
          throw error
        } finally {
          if (!disposed) publish({ refreshing: false })
        }
      }

      async function refreshBalance() {
        try { await action('refreshBalance'); return await refresh() }
        catch (error) { if (!disposed) publish({ error: error.message ?? '余额刷新失败。' }); throw error }
      }

      async function ensureBalanceFresh() {
        try { await action('ensureBalance'); return await refresh() }
        catch { return null }
      }

      function start() {
        if (disposed) return
        void refresh().catch(() => {})
        pollTimer = setIntervalFn(() => { void refresh().catch(() => {}) }, REFRESH_MS)
        clockTimer = setIntervalFn(() => publish({ now: now() }), 1000)
        visibilityTarget?.addEventListener?.('visibilitychange', onVisibility)
      }

      function dispose() {
        if (disposed) return
        disposed = true
        abortController.abort()
        if (transitionTimer !== null) clearTimer(transitionTimer)
        if (pollTimer !== null) clearIntervalFn(pollTimer)
        if (clockTimer !== null) clearIntervalFn(clockTimer)
        visibilityTarget?.removeEventListener?.('visibilitychange', onVisibility)
        listeners.clear()
      }

      return { start, dispose, refresh, refreshPricing, refreshBalance, ensureBalanceFresh, sendOffPeakAware, subscribe, getSnapshot, action, get isDisposed() { return disposed } }
    }

    function localTime(epochMs) {
      if (!Number.isFinite(epochMs)) return '—'
      try {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium', timeStyle: 'medium', timeZoneName: 'short',
        }).format(new Date(epochMs))
      } catch { return new Date(epochMs).toLocaleString() }
    }

    function shortLocalTime(epochMs, now = Date.now(), t) {
      if (!Number.isFinite(epochMs)) return '—'
      const date = new Date(epochMs)
      const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
      const today = new Date(now)
      if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) return `${t('today')} ${time}`
      return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    }

    function trustedRuleLabel(status, t) {
      if (status === 'verified') return t('verifiedRules')
      if (status === 'stale-verified') return t('cachedRules')
      if (status === 'bundled-fixture') return t('unverifiedRules')
      return t('checkRules')
    }

    function trustLabel(status, t) {
      if (status === 'verified') return t('verifiedLabel')
      if (status === 'stale-verified') return t('cachedLabel')
      return t('unavailable')
    }

    function trustWarning(trustStatus, t = (key) => key === 'warningUnverified' ? '⚠ 规则未验证' : '⚠ 使用已验证缓存') {
      if (trustStatus === 'bundled-fixture' || trustStatus === 'untrusted') return t('warningUnverified')
      if (trustStatus === 'stale-verified') return t('warningCache')
      return ''
    }

    function PriceFlowDock({ sessionId, useInput, useProjection, inputActions, t }) {
      const [view, setView] = React.useState({ snapshot: null, error: null, busy: false, refreshing: false, now: Date.now(), notice: null })
      const pricingPhase = view.snapshot?.pricing?.phase
      const peak = pricingPhase === 'PEAK'
      const actionVisible = peak
      // Subscribe to stable scalar slices. The attachment rail and this dock
      // must observe the same session InputState, even if its object identity
      // is retained while attachmentIds changes. OFF-PEAK and unknown-phase
      // states are informational, so their selectors intentionally read none
      // of the composer draft or attachment fields.
      const inputAvailable = actionVisible && typeof useInput === 'function'
      const draft = typeof useInput === 'function' ? useInput((state) => actionVisible ? state?.draft : undefined) : undefined
      const draftRev = typeof useInput === 'function' ? useInput((state) => actionVisible ? state?.draftRev : undefined) : undefined
      const phase = typeof useInput === 'function' ? useInput((state) => actionVisible ? state?.phase : undefined) : undefined
      const attachmentCount = typeof useInput === 'function' ? useInput((state) => actionVisible ? (Array.isArray(state?.attachmentIds) ? state.attachmentIds.length : null) : undefined) : null
      const input = inputAvailable ? { draft, draftRev, phase, attachmentCount } : null
      const inputRef = React.useRef(input)
      inputRef.current = input
      const controllerRef = React.useRef(null)
      if (controllerRef.current === null || controllerRef.current.sessionId !== sessionId) {
        controllerRef.current?.dispose()
        const controller = createPriceFlowController({ sessionId, onChange: setView })
        controller.sessionId = sessionId
        controllerRef.current = controller
      }
      const controller = controllerRef.current
      React.useEffect(() => {
        const unsubscribe = controller.subscribe(setView)
        controller.start()
        return () => { unsubscribe(); controller.dispose() }
      }, [controller])

      const modelSelectionProjection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined

      const snapshot = view.snapshot
      const pricing = snapshot?.pricing
      const trust = pricing?.trustStatus
      const waiting = snapshot?.queue?.waiting ?? snapshot?.queue?.queued ?? 0
      const delivering = snapshot?.queue?.delivering ?? 0
      const blocked = snapshot?.queue?.blocked ?? 0
      const unresolved = waiting + delivering + blocked
      const eligible = actionVisible && getEligibility({
        sessionId,
        input,
        canAutoSchedule: pricing?.canAutoSchedule === true,
        pricingPhase: pricing?.phase,
        pending: view.busy,
      })
      const knownPhase = peak || pricing?.phase === 'OFF-PEAK'
      const phaseIcon = peak ? '🟠 ' : pricing?.phase === 'OFF-PEAK' ? '🟢 ' : ''
      const phaseLabel = knownPhase
        ? t(peak ? 'phasePeak' : 'phaseOffpeak')
        : t(pricing ? 'phaseUnavailable' : 'phaseLoading')
      const warning = trustWarning(trust, t)
      const remaining = Number.isFinite(pricing?.transitionAtUtcMs) ? Math.max(0, pricing.transitionAtUtcMs - view.now) : null
      const selection = modelSelectionProjection?.next
      const selectionAvailable = typeof selection?.provider === 'string' && typeof selection?.model === 'string' && selection.model.length > 0
      const usdBook = snapshot?.priceBooks?.USD
      const cnyBook = snapshot?.priceBooks?.CNY
      const canonicalProvider = selectionAvailable ? selection.provider : null
      const canonicalModel = selectionAvailable ? selection.model : null
      const officialModel = selectionAvailable && canonicalProvider === 'deepseek-official' ? usdBook?.models?.[canonicalModel] : null
      const modelDisplayName = officialModel?.displayName ?? null
      const phaseKey = pricing?.phase === 'PEAK' ? 'peak' : pricing?.phase === 'OFF-PEAK' ? 'offpeak' : null
      const verifiedBookStatus = (status) => status === 'verified' || status === 'stale-verified'
      const usdPrices = officialModel && verifiedBookStatus(usdBook?.trustStatus) && phaseKey ? officialModel[phaseKey] : null
      const cnyModel = selectionAvailable && canonicalProvider === 'deepseek-official' ? cnyBook?.models?.[canonicalModel] : null
      const cnyPrices = cnyModel && cnyBook?.compatible === true && verifiedBookStatus(cnyBook.trustStatus) && phaseKey ? cnyModel[phaseKey] : null
      const hasOfficialModel = Boolean(officialModel)
      const priceRows = [
        { code: 'CNY', label: t('cny'), currency: 'CNY', values: cnyPrices },
        { code: 'USD', label: t('usd'), currency: 'USD', values: usdPrices },
      ]
      const formatPrice = (raw, currency) => {
        if (raw == null) return null
        const text = String(raw)
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null
        const [integer, fraction = ''] = text.replace(/^\./, '0.').split('.')
        const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        const decimals = fraction.padEnd(2, '0')
        return `${currency === 'CNY' ? '¥' : '$'}${grouped}${decimals ? `.${decimals}` : ''}`
      }
      const balance = snapshot?.balance
      const balanceValue = (currency, field = 'totalBalance') => {
        const amount = balance?.currencies?.[currency]?.[field]
        return typeof amount === 'string' || typeof amount === 'number' ? formatPrice(amount, currency) : null
      }
      const balanceFetched = Number.isFinite(balance?.fetchedAt) ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(balance.fetchedAt)) : null
      const visiblePriceRows = priceRows.filter((row) => row.values && ['cacheHitInput', 'cacheMissInput', 'output'].every((field) => formatPrice(row.values[field], row.currency) !== null))
      const visibleBalances = ['CNY', 'USD'].filter((currency) => balanceValue(currency) !== null)
      const balanceHasData = ['available', 'stale'].includes(balance?.status) && Number.isFinite(balance?.fetchedAt) && visibleBalances.length > 0
      const balanceBreakdown = (currency) => [
        [t('total'), balanceValue(currency)],
        [t('toppedUp'), balanceValue(currency, 'toppedUpBalance')],
        [t('granted'), balanceValue(currency, 'grantedBalance')],
      ].filter(([, value]) => value !== null).map(([label, value]) => `${label} ${value}`).join(' · ')
      const modelLabel = selectionAvailable ? `${modelDisplayName ?? canonicalModel}${selection.reasoningEffort ? ` · ${selection.reasoningEffort.replace(/^./, (c) => c.toUpperCase())}` : ''}` : null
      const sourceLabels = [
        verifiedBookStatus(usdBook?.trustStatus) && officialModel ? `${t('usd')} ${trustLabel(usdBook.trustStatus, t)}` : null,
        verifiedBookStatus(cnyBook?.trustStatus) && cnyBook?.compatible === true && cnyModel ? `${t('cny')} ${trustLabel(cnyBook.trustStatus, t)}` : null,
      ].filter(Boolean)
      const queue = snapshot?.queue ?? {}
      const queueDetails = `${t('queuedCount', { count: queue.queued ?? waiting })} · ${t('deliveringCount', { count: queue.delivering ?? delivering })} · ${t('submittedCount', { count: queue.submitted ?? 0 })} · ${t('blockedCount', { count: queue.blocked ?? blocked })} · ${t('cancelledCount', { count: queue.cancelled ?? 0 })}`
      const onSend = async () => {
        if (!eligible) return
        const captured = { sessionId, draft: input.draft, draftRev: input.draftRev }
        try {
          await controller.sendOffPeakAware(captured.draft)
          if (!controller.isDisposed && controllerRef.current === controller && captured.sessionId === sessionId && mayClearCapturedDraft(inputRef.current, captured)) {
            inputActions?.setDraft('')
          } else if (!controller.isDisposed && controllerRef.current === controller) {
            setView((old) => ({ ...old, notice: 'submitted' }))
          }
        } catch { /* The Host error is displayed and the draft remains intact. */ }
      }
      const buttonReason = !actionVisible ? undefined
        : pricing?.canAutoSchedule !== true ? t('unverified')
          : !Number.isInteger(input?.attachmentCount) || input.attachmentCount < 0 ? t('attachmentUnknown')
            : input?.draft?.trimStart().startsWith('/') ? t('commands')
              : input.attachmentCount > 0 ? t('attachments')
                : !input?.draft?.trim() ? t('enterText')
                  : !sessionId ? t('sessionUnavailable')
                    : !input || input.phase !== 'plain' || view.busy ? t('inputBusy')
                      : undefined
      const queueActionHint = t('queueHint')

      return h('section', { className: 'pf-root', 'aria-label': t('aria') },
        h('div', { className: 'pf-row' },
          h('div', { className: 'pf-status', 'aria-live': 'polite' },
            warning ? `${warning} · ` : '',
            `${phaseIcon}${phaseLabel}`,
            !knownPhase || remaining === null ? '' : ` · ${formatCountdown(remaining)} ${t(peak ? 'untilOffpeak' : 'untilPeak')}`,
            peak ? ` · ${t('queue')} ${waiting}` : ''),
          actionVisible ? h('div', { className: 'pf-action-wrap' }, h('button', { type: 'button', className: 'pf-send', onClick: onSend, disabled: !eligible, title: buttonReason, 'aria-label': t('sendCurrent') }, t('send')), h('span', { className: 'pf-action-hint', role: 'status' }, buttonReason ?? (eligible ? queueActionHint : ''))) : null),
        h('details', { className: 'pf-details', onToggle: (event) => { if (event.currentTarget.open) void controller.ensureBalanceFresh() } },
          h('summary', null, t('details')),
          h('div', { className: 'pf-detail-main' },
            visiblePriceRows.length ? h('section', { className: 'pf-detail-section pf-current-price' },
              h('div', { className: 'pf-section-title' }, t('current')),
              h('div', { className: 'pf-price-table' },
                h('div', { className: 'pf-price-table-head' }, h('span', null), h('span', null, t('hit')), h('span', null, t('miss')), h('span', null, t('output'))),
                ...visiblePriceRows.map((row) => h('div', { className: 'pf-price-table-row', key: row.code }, h('strong', null, row.label), ...['cacheHitInput', 'cacheMissInput', 'output'].map((field) => h('span', { key: field }, formatPrice(row.values[field], row.currency)))))
              )) : null,
            balanceHasData ? h('section', { className: 'pf-detail-section pf-balance-section' },
              h('div', { className: 'pf-rule-heading' }, h('div', { className: 'pf-section-title' }, t('balance')), h('button', { type: 'button', className: 'pf-refresh pf-balance-refresh', 'aria-label': t('refreshBalance'), onClick: () => { void controller.refreshBalance().catch(() => {}) } }, '↻')),
              h('div', { className: 'pf-balance-grid' }, ...visibleBalances.map((currency) => h('div', { key: currency }, h('span', null, t(currency === 'CNY' ? 'cny' : 'usd')), h('strong', null, balanceValue(currency))))),
              balance?.isAvailable === false ? h('p', { className: 'pf-balance-warning' }, t('insufficient')) : null,
              balance?.status === 'stale' ? h('p', { className: 'pf-balance-updated' }, `${t('updated', { time: balanceFetched })} · ${t('refreshFailedLabel')}`) : balanceFetched ? h('p', { className: 'pf-balance-updated' }, t('updated', { time: balanceFetched })) : null) : null,
            h('section', { className: 'pf-detail-section pf-rule-status' }, h('div', { className: 'pf-rule-heading' }, h('strong', null, trustedRuleLabel(trust, t)), h('button', { type: 'button', className: 'pf-refresh', disabled: view.refreshing, onClick: () => { void controller.refreshPricing().catch(() => {}) } }, view.refreshing ? t('refreshing') : t('refresh'))), h('div', { className: 'pf-rule-meta' }, h('span', null, trust === 'stale-verified' ? t('lastSync', { time: shortLocalTime(snapshot?.sync?.lastSuccessfulFetchAt, view.now, t) }) : Number.isFinite(snapshot?.sync?.lastSuccessfulFetchAt) ? t('updatedShort', { time: shortLocalTime(snapshot.sync.lastSuccessfulFetchAt, view.now, t) }) : '', pricing?.sourceUrl ? h(React.Fragment, null, ' · ', h('a', { href: pricing.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, t('official'))) : null))),
            unresolved > 0 ? h('p', { className: blocked > 0 ? 'pf-queue-alert pf-queue-blocked' : 'pf-queue-alert', role: 'status' }, blocked > 0 ? t('attentionMany', { count: blocked }) : t('pending', { count: unresolved })) : null,
            h('div', { className: 'pf-advanced-row' }, h('details', { className: 'pf-advanced' }, h('summary', null, t('advanced')), h('dl', null,
              selectionAvailable ? h(React.Fragment, null, h('dt', null, t('model')), h('dd', null, modelLabel), h('dt', null, t('modelId')), h('dd', null, canonicalModel), h('dt', null, 'Provider'), h('dd', null, canonicalProvider)) : null,
              sourceLabels.length ? h(React.Fragment, null, h('dt', null, t('priceSource')), h('dd', null, sourceLabels.join(' · '))) : null,
              pricing?.policyId ? h(React.Fragment, null, h('dt', null, 'Policy'), h('dd', { title: pricing.policyId }, `${pricing.policyId.slice(0, 6)}…${pricing.policyId.slice(-4)}`)) : null,
              snapshot?.calendar?.status ? h(React.Fragment, null, h('dt', null, t('calendar')), h('dd', null, snapshot.calendar.status)) : null,
              snapshot?.delivery?.backend ? h(React.Fragment, null, h('dt', null, t('delivery')), h('dd', null, snapshot.delivery.backend)) : null,
              Number.isFinite(snapshot?.sync?.lastSuccessfulFetchAt) ? h(React.Fragment, null, h('dt', null, t('lastSyncLabel')), h('dd', null, new Date(snapshot.sync.lastSuccessfulFetchAt).toLocaleString())) : null),
              balanceHasData ? h('div', { className: 'pf-balance-breakdown' }, h('strong', null, t('balance')), ...visibleBalances.map((currency) => {
                const item = balance?.currencies?.[currency]
                if (!item) return null
                return h('div', { className: 'pf-balance-currency', key: currency }, h('span', null, t(currency === 'CNY' ? 'cny' : 'usd')), h('p', null, balanceBreakdown(currency)))
              })) : null,
            h('div', { className: 'pf-queue-advanced' }, h('strong', null, t('queue')), h('p', null, queueDetails))), null))),
        view.error ? h('p', { className: 'pf-error', role: 'alert' }, t('error')) : null,
        !knownPhase || !pricing ? h('p', { className: 'pf-hint', role: 'status' }, t('actionUnavailable')) : null,
        view.notice ? h('p', { className: 'pf-notice', role: 'status' }, t(view.notice === '当前即为谷价，已立即提交。' ? 'immediate' : view.notice === '已加入低谷发送队列。' ? 'queued' : view.notice === '已提交；你之后输入的草稿已保留。' ? 'submitted' : 'error')) : null)
    }

    const css = '.pf-root{font:inherit;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 2px}.pf-row{display:flex;align-items:center;gap:8px;min-width:0}.pf-status,.pf-send,.pf-refresh{font:inherit;color:inherit;border:0;border-radius:var(--dsw-radius-sm);background:transparent;min-height:28px;padding:4px 8px}.pf-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;flex:1}.pf-send,.pf-refresh{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;flex:none}.pf-status:hover,.pf-send:hover:not(:disabled),.pf-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}.pf-send:disabled,.pf-refresh:disabled{opacity:.55;cursor:not-allowed}.pf-action-wrap{display:grid;justify-items:start;gap:3px;flex:none;min-width:0}.pf-action-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;max-width:220px}.pf-details{padding:2px 8px}.pf-details summary{cursor:pointer;width:max-content}.pf-detail-main{max-width:660px;padding:8px 0 2px}.pf-price-table{display:grid;gap:5px;min-width:0}.pf-price-table-head,.pf-price-table-row{display:grid;grid-template-columns:minmax(58px,.72fr) repeat(3,minmax(0,1fr));gap:8px;align-items:center}.pf-price-table-head{color:var(--dsw-alias-label-tertiary);font-size:11px}.pf-price-table-head span,.pf-price-table-row span{text-align:right;overflow-wrap:anywhere}.pf-price-table-row strong{font-weight:500;color:var(--dsw-alias-label-secondary)}.pf-balance-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.pf-balance-grid>div{display:grid;gap:3px}.pf-balance-grid span,.pf-balance-updated{color:var(--dsw-alias-label-tertiary)}.pf-balance-grid strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}.pf-balance-updated{margin:4px 0 0}.pf-balance-warning{margin:4px 0 0;color:var(--dsw-alias-state-warning-primary)}.pf-balance-refresh{font-size:16px}.pf-balance-breakdown{padding:6px 0;color:var(--dsw-alias-label-tertiary)}.pf-balance-currency{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;padding:3px 0}.pf-balance-currency>span{color:var(--dsw-alias-label-secondary)}.pf-balance-currency p{margin:0}.pf-balance-currency strong{font-weight:500;color:var(--dsw-alias-label-secondary)}@media(max-width:460px){.pf-price-table-head,.pf-price-table-row{grid-template-columns:minmax(48px,.65fr) repeat(3,minmax(0,1fr));gap:4px;font-size:11px}.pf-balance-grid{gap:8px}.pf-balance-currency{grid-template-columns:70px minmax(0,1fr);gap:4px}}.pf-detail-section{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.16))}.pf-phase-summary{padding-top:2px}.pf-phase-summary strong{font-size:14px;color:var(--dsw-alias-label-primary)}.pf-phase-summary p,.pf-unknown-price,.pf-queue-advanced p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary)}.pf-section-title{margin-bottom:6px;color:var(--dsw-alias-label-tertiary)}.pf-price-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.pf-price-cell{min-width:0;display:grid;grid-template-columns:auto auto;justify-content:start;column-gap:4px}.pf-price-cell span{grid-column:1/-1;color:var(--dsw-alias-label-tertiary)}.pf-price-cell strong{color:var(--dsw-alias-label-primary);font-weight:600;overflow-wrap:anywhere}.pf-price-cell small{align-self:end;color:var(--dsw-alias-label-tertiary)}.pf-rule-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.pf-rule-heading strong{color:var(--dsw-alias-label-primary);font-weight:500}.pf-rule-meta{color:var(--dsw-alias-label-tertiary)}.pf-rule-meta a{color:inherit}.pf-refresh{min-height:24px;padding:2px 6px;background:transparent}.pf-advanced-row{display:flex;align-items:flex-start;gap:12px}.pf-advanced{padding:8px 0;flex:1;min-width:0}.pf-advanced summary{display:inline-block;color:var(--dsw-alias-label-tertiary)}.pf-advanced dl{grid-template-columns:90px minmax(0,1fr);font-size:11px}.pf-queue-advanced{padding:4px 0;color:var(--dsw-alias-label-tertiary)}.pf-queue-blocked{color:var(--dsw-alias-state-warning-primary)}.pf-details dl{display:grid;grid-template-columns:minmax(120px,auto) minmax(0,1fr);gap:4px 12px;margin:8px 0}.pf-details dt{color:var(--dsw-alias-label-tertiary)}.pf-details dd{margin:0;overflow-wrap:anywhere}.pf-details a{color:var(--dsw-alias-label-primary)}.pf-error{color:var(--dsw-alias-state-error-primary)}.pf-hint,.pf-queue-alert{color:var(--dsw-alias-label-tertiary);margin:2px 8px}.pf-queue-alert{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}.pf-notice{color:var(--dsw-alias-label-secondary);margin:2px 8px}'
    const styleId = 'dsh-priceflow-styles'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.id = styleId
        tag.textContent = css
        document.head.append(tag)
        return () => tag.remove()
      }, 'dsh-priceflow: styles')
      ctx.effect(() => registerLocale(ctx), 'dsh-priceflow: locale dictionary')
      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-priceflow',
        order: 20,
        inject: (sessionId) => ({ sessionId }),
        locale: 'priceflow',
      }, PriceFlowDock)), 'dsh-priceflow: composer dock')
    }

    return { apply, inject, PriceFlowDock, createPriceFlowController, formatCountdown, getEligibility, mayClearCapturedDraft, localTime, trustWarning, dictionaries }
  },
})
