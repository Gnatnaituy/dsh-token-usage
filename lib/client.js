/**
 * Browser half of dsh-token-usage.
 *
 * One page, registered as a top-level section of the Settings panel. It reads
 * exactly one route — the host half's `/dsh-token-usage/summary` — and renders
 * three things from it:
 *
 *   - a hero card: the deployment-wide total across every provider and every
 *     model, switchable between today / 7 days / 30 days / all time;
 *   - a usage calendar: one cell per day, GitHub-contribution-graph style, with
 *     a hover card naming the day and its consumption;
 *   - a provider-grouped table: every model's today / 7-day / 30-day numbers.
 *
 * The bundle is intentionally build-free plain JavaScript in the module-loader
 * CJS form, so the whole plugin is editable in the profile without a toolchain.
 * `React.createElement` stands in for JSX; there is no other dependency beyond
 * the frozen platform table (`react`) and the two services it injects.
 *
 * The page never computes statistics of its own: every number it shows is the
 * host's, so the page and the ledger can never disagree.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    'use strict'

    var React = require('react')
    var h = React.createElement

    /** Package id: equals the Loader row name and the host plugin's prompt name. */
    var PLUGIN_ID = 'dsh-token-usage'
    /** Locale dictionary namespace owned by this plugin. */
    var NS = 'settings.tokenUsage'
    /** Host route this page reads. */
    var SUMMARY_ROUTE = '/dsh-token-usage/summary'
    /** Host route that forces a full re-scan of the session logs. */
    var RESCAN_ROUTE = '/dsh-token-usage/rescan'
    /** Style element id, so a reload replaces rather than stacks stylesheets. */
    var STYLE_ID = 'dsh-token-usage-style'
    /** Segmented windows of the hero and the per-model table, in display order. */
    var WINDOWS = [
      { id: 'today', label: 'today' },
      { id: 'd7', label: 'd7' },
      { id: 'd30', label: 'd30' },
      { id: 'all', label: 'all' },
    ]
    /** Calendar ranges offered above the heatmap, as days of history. */
    var RANGES = [
      { id: 91, label: 'range13' },
      { id: 182, label: 'range26' },
      { id: 371, label: 'range53' },
    ]
    /** How many heat levels the calendar quantizes into. */
    var HEAT_LEVELS = 4
    /** How long the page waits before polling again while the host is scanning. */
    var POLL_MS = 2500
    /** How many times a single page open will poll for a running scan. */
    var POLL_LIMIT = 40

    /** Simplified Chinese copy. */
    var zh = {
      title: 'Token 用量',
      subtitle: '汇总本机所有供应商与模型的 token 消耗，数据来自会话日志。',
      today: '今日',
      d7: '近 7 日',
      d30: '近 30 日',
      all: '全部',
      total: '总用量',
      input: '输入',
      output: '输出',
      cacheRead: '缓存读',
      cacheWrite: '缓存写',
      reasoning: '推理',
      providers: '供应商',
      models: '模型',
      requests: '请求',
      provider: '供应商',
      model: '模型',
      requestsUnit: '次请求',
      calendar: '用量日历',
      calendarHint: '每天一格，颜色越深用量越大；悬停查看当日明细。',
      range13: '近 3 月',
      range26: '近 6 月',
      range53: '近 1 年',
      legendLess: '少',
      legendMore: '多',
      activeDays: '活跃 {n} 天',
      busiestDay: '峰值 {value}',
      noData: '还没有用量记录',
      noDataHint: '开始一次对话后，这里会自动出现统计。',
      loading: '正在汇总用量…',
      failed: '读取用量失败',
      retry: '重试',
      rescan: '重新扫描',
      rescanning: '扫描中…',
      scanning: '正在扫描历史会话日志…',
      updatedAt: '更新于 {time}',
      timeZone: '时区 {zone}',
      records: '{n} 条记录',
      dayUsage: '{date} · {value}',
      empty: '无',
      other: '未标注',
      since: '自 {date} 起',
      month1: '1月',
      month2: '2月',
      month3: '3月',
      month4: '4月',
      month5: '5月',
      month6: '6月',
      month7: '7月',
      month8: '8月',
      month9: '9月',
      month10: '10月',
      month11: '11月',
      month12: '12月',
      dow0: '一',
      dow1: '二',
      dow2: '三',
      dow3: '四',
      dow4: '五',
      dow5: '六',
      dow6: '日',
    }

    /** English copy; the framework falls back to Chinese keys the moment one is missing. */
    var en = {
      title: 'Token usage',
      subtitle: 'Token consumption across every provider and model on this machine, folded from session logs.',
      today: 'Today',
      d7: 'Last 7d',
      d30: 'Last 30d',
      all: 'All time',
      total: 'Total',
      input: 'Input',
      output: 'Output',
      cacheRead: 'Cache read',
      cacheWrite: 'Cache write',
      reasoning: 'Reasoning',
      providers: 'Providers',
      models: 'Models',
      requests: 'Requests',
      provider: 'Provider',
      model: 'Model',
      requestsUnit: 'requests',
      calendar: 'Usage calendar',
      calendarHint: 'One cell per day; darker means more tokens. Hover for the day breakdown.',
      range13: '3 months',
      range26: '6 months',
      range53: '1 year',
      legendLess: 'Less',
      legendMore: 'More',
      activeDays: '{n} active days',
      busiestDay: 'peak {value}',
      noData: 'No usage recorded yet',
      noDataHint: 'Statistics appear here once a conversation has run.',
      loading: 'Summarizing usage…',
      failed: 'Could not read usage',
      retry: 'Retry',
      rescan: 'Rescan',
      rescanning: 'Scanning…',
      scanning: 'Scanning historical session logs…',
      updatedAt: 'Updated {time}',
      timeZone: 'Zone {zone}',
      records: '{n} records',
      dayUsage: '{date} · {value}',
      empty: 'None',
      other: 'Unattributed',
      since: 'since {date}',
      month1: 'Jan',
      month2: 'Feb',
      month3: 'Mar',
      month4: 'Apr',
      month5: 'May',
      month6: 'Jun',
      month7: 'Jul',
      month8: 'Aug',
      month9: 'Sep',
      month10: 'Oct',
      month11: 'Nov',
      month12: 'Dec',
      dow0: 'Mon',
      dow1: 'Tue',
      dow2: 'Wed',
      dow3: 'Thu',
      dow4: 'Fri',
      dow5: 'Sat',
      dow6: 'Sun',
    }

    var STYLE_CSS = [
      '.dtu-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#111);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px}',
      '.dtu-head{display:flex;align-items:flex-start;gap:12px}',
      '.dtu-headText{flex:1;min-width:0}',
      '.dtu-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-subtitle{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-headActions{display:flex;align-items:center;gap:6px;flex:none}',
      '.dtu-ghost{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.dtu-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-ghost:disabled{cursor:default;opacity:.55}',
      '.dtu-card{box-sizing:border-box;padding:16px;border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 1px 2px #0000000a)}',
      '.dtu-hero{border-color:transparent;background:var(--dsw-alias-state-business-tertiary,#e4edfd)}',
      '.dtu-heroTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dtu-heroLabel{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-seg{display:inline-flex;gap:2px;margin-left:auto;padding:3px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dtu-segBtn{height:26px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.dtu-segBtn:hover{color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-segBtn[data-active="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-soft,0 1px 2px #0000000a)}',
      '.dtu-heroValue{margin-top:10px;font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}',
      '.dtu-heroMeta{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-splits{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin-top:14px}',
      '.dtu-split{padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dtu-splitLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-splitValue{margin-top:2px;font-size:14px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-cardHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.dtu-cardTitle{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-cardHint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-cardStats{display:flex;align-items:center;gap:12px;margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6);white-space:nowrap}',
      '.dtu-heatWrap{position:relative}',
      '.dtu-heatScroll{overflow-x:auto;overflow-y:hidden;padding-bottom:2px}',
      '.dtu-heat{position:relative;display:inline-block;min-width:100%}',
      '.dtu-months{position:relative;height:14px;margin-left:22px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-month{position:absolute;top:0;white-space:nowrap}',
      '.dtu-grid{display:flex;gap:3px}',
      '.dtu-dow{display:grid;grid-template-rows:repeat(7,11px);gap:3px;width:19px;flex:none;font-size:9px;line-height:11px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-dowCell{display:flex;align-items:center}',
      '.dtu-cols{display:flex;gap:3px}',
      '.dtu-col{display:grid;grid-template-rows:repeat(7,11px);gap:3px}',
      '.dtu-cell{width:11px;height:11px;border-radius:2.5px;background:var(--dsw-alias-interactive-bg-hover,#2631480f);cursor:default}',
      '.dtu-cell[data-pad="true"]{background:transparent}',
      '.dtu-cell[data-level="1"]{background:var(--dsw-alias-state-business-primary,#4176e6);opacity:.3}',
      '.dtu-cell[data-level="2"]{background:var(--dsw-alias-state-business-primary,#4176e6);opacity:.5}',
      '.dtu-cell[data-level="3"]{background:var(--dsw-alias-state-business-primary,#4176e6);opacity:.72}',
      '.dtu-cell[data-level="4"]{background:var(--dsw-alias-state-business-primary,#4176e6);opacity:1}',
      '.dtu-cell[data-today="true"]{outline:1px solid var(--dsw-alias-label-tertiary,#81858c);outline-offset:1px}',
      '.dtu-tip{position:absolute;z-index:5;transform:translate(-50%,-100%);padding:7px 10px;border:.5px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 6px 24px #00000024);pointer-events:none;white-space:nowrap}',
      '.dtu-tipDate{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-tipValue{font-size:13px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-tipSplit{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-legend{display:flex;align-items:center;gap:6px;margin-top:12px;font-size:11px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-legendSwatch{width:11px;height:11px;border-radius:2.5px}',
      '.dtu-groups{display:flex;flex-direction:column;gap:10px}',
      '.dtu-group{border:.5px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-md,10px);overflow:hidden}',
      '.dtu-groupHead{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dtu-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.dtu-groupName{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-groupMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-row{display:grid;grid-template-columns:minmax(0,1fr) 68px 68px 74px;align-items:center;gap:4px;padding:9px 12px;border-top:.5px solid var(--dsw-alias-border-l1,#0000000a)}',
      '.dtu-row[data-head="true"]{border-top:0;padding-top:7px;padding-bottom:6px}',
      '.dtu-colHead{font-size:10px;line-height:14px;font-weight:500;text-align:right;color:var(--dsw-alias-label-caption,#979da6)}',
      '.dtu-colHead[data-first="true"]{text-align:left}',
      '.dtu-rowTotal{font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}',
      '.dtu-modelCell{min-width:0}',
      '.dtu-modelName{display:block;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#111);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dtu-bar{margin-top:5px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1,#0000000a);overflow:hidden}',
      '.dtu-barFill{height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4176e6);transition:width .2s ease}',
      '.dtu-cellNum{font-variant-numeric:tabular-nums;font-size:12px;text-align:right;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-cellNum[data-strong="true"]{color:var(--dsw-alias-label-primary,#111);font-weight:600}',
      '.dtu-cellNum[data-zero="true"]{color:var(--dsw-alias-label-dimmed,#cfd3d6)}',
      '.dtu-status{display:flex;align-items:center;justify-content:center;gap:8px;padding:44px 16px;font-size:13px;color:var(--dsw-alias-label-secondary,#555)}',
      '.dtu-error{color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.dtu-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,#0000001f);border-top-color:var(--dsw-alias-state-business-primary,#4176e6);animation:dtu-spin .7s linear infinite}',
      '@keyframes dtu-spin{to{transform:rotate(360deg)}}',
      '.dtu-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#979da6)}',
      '@media(prefers-reduced-motion:reduce){.dtu-spinner{animation:none}.dtu-barFill{transition:none}}',
    ].join('')

    /**
     * Install this page's stylesheet once per document.
     *
     * The module loader can load a plugin's bundle more than once across an HMR
     * revision, so the tag is looked up by id rather than appended blindly.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing !== null) {
        existing.textContent = STYLE_CSS
        return
      }
      var tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = STYLE_CSS
      document.head.appendChild(tag)
    }

    /**
     * Format a token count with thousands separators.
     * @param value - token count.
     * @returns the exact number, or `0` for a non-finite input.
     */
    function exact(value) {
      return Number.isFinite(value) ? Math.round(value).toLocaleString() : '0'
    }

    /**
     * Format a token count compactly for a narrow numeric column.
     *
     * Table columns are 68–74px wide, so an exact eight-digit number would be
     * clipped; one decimal place keeps magnitude readable while staying inside
     * the column. Exact values remain available in the row tooltip.
     * @param value - token count.
     * @returns a compact label such as `1.2M` or `812`.
     */
    function compact(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      var units = [
        { limit: 1e9, suffix: 'B' },
        { limit: 1e6, suffix: 'M' },
        { limit: 1e3, suffix: 'K' },
      ]
      for (var index = 0; index < units.length; index += 1) {
        var unit = units[index]
        if (value >= unit.limit) {
          var scaled = value / unit.limit
          return (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)) + unit.suffix
        }
      }
      return String(Math.round(value))
    }

    /**
     * Day key of a date shifted by whole days, using the same UTC-midnight
     * arithmetic as the host, so the grid can never disagree with the payload.
     * @param key - `YYYY-MM-DD`.
     * @param delta - day offset.
     * @returns the shifted key.
     */
    function shiftDay(key, delta) {
      var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
      if (match === null) return key
      var epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + delta * 86400000
      var date = new Date(epoch)
      var month = date.getUTCMonth() + 1
      var day = date.getUTCDate()
      return date.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day
    }

    /**
     * Monday-based weekday index of a day key.
     * @param key - `YYYY-MM-DD`.
     * @returns 0 for Monday through 6 for Sunday.
     */
    function weekdayIndex(key) {
      var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
      if (match === null) return 0
      var epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      return (new Date(epoch).getUTCDay() + 6) % 7
    }

    /**
     * Month label of a day key, for the calendar's month rail.
     *
     * Resolved through the page's own dictionary rather than a hardcoded name
     * table: the tier is a locale value like every other string on the page, and
     * a locale switch re-renders the rail with everything else.
     * @param key - `YYYY-MM-DD`.
     * @param t - locale reader.
     * @returns the label shown above the week that contains the day.
     */
    function monthLabel(key, t) {
      var month = Number(key.slice(5, 7))
      if (!Number.isFinite(month) || month < 1 || month > 12) return ''
      return t('month' + String(month))
    }

    /**
     * Quantize one day's total into a heat level.
     *
     * Levels are relative to the range's own peak rather than to a fixed scale:
     * a machine that only ever spends thousands would otherwise render an
     * all-empty calendar. A peak of zero therefore leaves every cell empty.
     * @param total - the day's tokens.
     * @param peak - the range's maximum day total.
     * @returns 0 for no usage, else 1..HEAT_LEVELS.
     */
    function heatLevel(total, peak) {
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(peak) || peak <= 0) return 0
      var ratio = total / peak
      var level = Math.ceil(ratio * HEAT_LEVELS)
      if (level < 1) return 1
      return level > HEAT_LEVELS ? HEAT_LEVELS : level
    }

    /**
     * Arrange calendar days into Monday-first week columns.
     *
     * Padding cells keep every column's rows aligned to a weekday, which is the
     * whole point of the layout; they are rendered transparent and never
     * interactive.
     * @param days - the host's ascending calendar days.
     * @param rangeDays - how much history to show.
     * @returns the visible week columns, plus the month rail positions.
     */
    function buildCalendar(days, rangeDays) {
      if (!Array.isArray(days) || days.length === 0) return { weeks: [], months: [] }
      var visible = days.slice(Math.max(0, days.length - rangeDays))
      var lead = weekdayIndex(visible[0].date)
      var cells = []
      for (var pad = 0; pad < lead; pad += 1) cells.push(null)
      for (var index = 0; index < visible.length; index += 1) cells.push(visible[index])
      while (cells.length % 7 !== 0) cells.push(null)
      var weeks = []
      for (var at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7))
      var months = []
      var lastMonth = ''
      for (var column = 0; column < weeks.length; column += 1) {
        for (var row = 0; row < weeks[column].length; row += 1) {
          var day = weeks[column][row]
          if (day === null || day === undefined) continue
          var month = day.date.slice(0, 7)
          if (month === lastMonth) continue
          lastMonth = month
          months.push({ column: column, date: day.date })
          break
        }
      }
      return { weeks: weeks, months: months }
    }

    /**
     * Every token counter a window carries, in the order the page shows them.
     *
     * Cache writes and reasoning tokens are only offered when the selected
     * window actually has them: providers differ in what they report, and two
     * permanently-zero tiles would read as missing data rather than as absent
     * counters.
     * @param t - locale reader.
     * @param window - the window being displayed.
     * @returns label/counter pairs.
     */
    function splitFields(t, window) {
      var fields = [
        { key: 'input', label: t('input'), always: true },
        { key: 'output', label: t('output'), always: true },
        { key: 'cacheRead', label: t('cacheRead'), always: true },
        { key: 'cacheWrite', label: t('cacheWrite') },
        { key: 'reasoning', label: t('reasoning') },
      ]
      return fields.filter(function (field) {
        return field.always === true || window[field.key] > 0
      })
    }

    /**
     * Read one window with a zeroed fallback, so a missing window renders as
     * zero instead of crashing a partially-updated page.
     * @param window - window from the payload.
     * @returns the window or a fresh zero window.
     */
    function windowOf(window) {
      return window !== null && typeof window === 'object' ? window : { total: 0, requests: 0 }
    }

    /**
     * The page's data source: one host route plus a bounded poll while the host
     * reports that it is still scanning session logs.
     * @returns the request state and the two actions the header exposes.
     */
    function useSummary() {
      var [state, setState] = React.useState({ phase: 'loading', data: undefined, error: '' })
      var [rescanning, setRescanning] = React.useState(false)
      var polls = React.useRef(0)
      var mounted = React.useRef(true)

      React.useEffect(function () {
        mounted.current = true
        return function () {
          mounted.current = false
        }
      }, [])

      var load = React.useCallback(function () {
        return fetch(SUMMARY_ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + String(response.status))
            return response.json()
          })
          .then(function (payload) {
            if (!mounted.current) return
            if (payload !== null && typeof payload === 'object' && payload.ok === false) {
              throw new Error(typeof payload.error === 'string' ? payload.error : 'unknown error')
            }
            setState({ phase: 'ready', data: payload, error: '' })
          })
          .catch(function (error) {
            if (!mounted.current) return
            setState(function (previous) {
              // A failed poll must not blank an already-rendered page.
              if (previous.phase === 'ready') return previous
              return { phase: 'failed', data: undefined, error: String(error && error.message ? error.message : error) }
            })
          })
      }, [])

      React.useEffect(function () {
        void load()
      }, [load])

      var scanning = state.phase === 'ready' && state.data !== undefined && state.data.scanning === true
      React.useEffect(
        function () {
          if (!scanning || polls.current >= POLL_LIMIT) return undefined
          var timer = window.setTimeout(function () {
            polls.current += 1
            void load()
          }, POLL_MS)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [scanning, state.data, load],
      )

      var rescan = React.useCallback(
        function () {
          setRescanning(true)
          fetch(RESCAN_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + String(response.status))
              return response.json()
            })
            .then(function (payload) {
              if (!mounted.current) return
              setState({ phase: 'ready', data: payload, error: '' })
            })
            .catch(function () {
              // The force scan failing still leaves the previous numbers valid.
            })
            .finally(function () {
              if (mounted.current) setRescanning(false)
            })
        },
        [],
      )

      return { state: state, rescanning: rescanning, scanning: scanning, reload: load, rescan: rescan }
    }

    /**
     * Hero card: the deployment-wide total for the selected window.
     * @param props - `t`, the summary and the selected window id.
     * @returns the hero card element tree.
     */
    function HeroCard(props) {
      var t = props.t
      var data = props.data
      var totals = data.totals !== null && typeof data.totals === 'object' ? data.totals : {}
      var window = windowOf(totals[props.window])
      var providers = Array.isArray(data.providers) ? data.providers.length : 0
      var models = Array.isArray(data.providers)
        ? data.providers.reduce(function (count, provider) {
            return count + (Array.isArray(provider.models) ? provider.models.length : 0)
          }, 0)
        : 0
      return h(
        'section',
        { className: 'dtu-card dtu-hero' },
        h(
          'div',
          { className: 'dtu-heroTop' },
          h('span', { className: 'dtu-heroLabel' }, h(GlyphSpark, { size: 14 }), t('total')),
          h(
            'div',
            { className: 'dtu-seg', role: 'tablist' },
            WINDOWS.map(function (item) {
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': props.window === item.id ? 'true' : 'false',
                  'data-active': props.window === item.id ? 'true' : 'false',
                  className: 'dtu-segBtn',
                  onClick: function () {
                    props.onWindow(item.id)
                  },
                },
                t(item.label),
              )
            }),
          ),
        ),
        h('div', { className: 'dtu-heroValue' }, exact(window.total)),
        h(
          'div',
          { className: 'dtu-heroMeta' },
          String(providers) + ' ' + t('providers') + ' · ' + String(models) + ' ' + t('models') + ' · ' + exact(window.requests) + ' ' + t('requestsUnit'),
        ),
        h(
          'div',
          { className: 'dtu-splits' },
          splitFields(t, window).map(function (field) {
            return h(
              'div',
              { key: field.key, className: 'dtu-split' },
              h('div', { className: 'dtu-splitLabel' }, field.label),
              h('div', { className: 'dtu-splitValue', title: exact(window[field.key]) }, compact(window[field.key])),
            )
          }),
        ),
      )
    }

    /**
     * Usage calendar: one cell per day with a hover card.
     * @param props - `t`, the calendar payload, the range and its setter.
     * @returns the calendar card element tree.
     */
    function CalendarCard(props) {
      var t = props.t
      var calendar = props.calendar
      var days = calendar !== null && typeof calendar === 'object' && Array.isArray(calendar.days) ? calendar.days : []
      var visible = days.slice(Math.max(0, days.length - props.range))
      var peak = visible.reduce(function (top, day) {
        return day.total > top ? day.total : top
      }, 0)
      var layout = buildCalendar(days, props.range)
      var scrollRef = React.useRef(null)
      var wrapRef = React.useRef(null)
      var [tip, setTip] = React.useState(undefined)

      React.useEffect(
        function () {
          var node = scrollRef.current
          if (node === null) return
          // The newest days matter most, so a range wider than the card opens
          // on its right edge rather than on a year-old January.
          node.scrollLeft = node.scrollWidth
        },
        [props.range, layout.weeks.length],
      )

      var activeDays = visible.reduce(function (count, day) {
        return count + (day.total > 0 ? 1 : 0)
      }, 0)

      return h(
        'section',
        { className: 'dtu-card' },
        h(
          'div',
          { className: 'dtu-cardHead' },
          h('h3', { className: 'dtu-cardTitle' }, t('calendar')),
          h(
            'div',
            { className: 'dtu-cardStats' },
            h('span', null, t('activeDays', { n: activeDays })),
            peak > 0 ? h('span', null, t('busiestDay', { value: compact(peak) })) : null,
            h(
              'div',
              { className: 'dtu-seg', style: { marginLeft: '4px' } },
              RANGES.map(function (item) {
                return h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    'data-active': props.range === item.id ? 'true' : 'false',
                    className: 'dtu-segBtn',
                    style: { height: '22px', padding: '0 8px', fontSize: '11px' },
                    onClick: function () {
                      props.onRange(item.id)
                    },
                  },
                  t(item.label),
                )
              }),
            ),
          ),
        ),
        layout.weeks.length === 0
          ? h('p', { className: 'dtu-cardHint' }, t('noData'))
          : h(
              // The hover card lives outside the scroll container on purpose: an
              // `overflow-x: auto` box clips its other axis too, so a tooltip
              // anchored inside it would be cut off above the first row.
              'div',
              { className: 'dtu-heatWrap', ref: wrapRef },
              h(
                'div',
                { className: 'dtu-heatScroll', ref: scrollRef },
                h(
                  'div',
                  { className: 'dtu-heat' },
                  h(
                    'div',
                    { className: 'dtu-months' },
                    layout.months.map(function (month) {
                      return h(
                        'span',
                        { key: month.date, className: 'dtu-month', style: { left: String(month.column * 14) + 'px' } },
                        monthLabel(month.date, t),
                      )
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dtu-grid' },
                    h(
                      'div',
                      { className: 'dtu-dow' },
                      [0, 1, 2, 3, 4, 5, 6].map(function (row) {
                        return h('span', { key: String(row), className: 'dtu-dowCell' }, row % 2 === 0 ? t('dow' + String(row)) : '')
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dtu-cols' },
                      layout.weeks.map(function (week, column) {
                        return h(
                          'div',
                          { key: 'w' + String(column), className: 'dtu-col' },
                          week.map(function (day, row) {
                            if (day === null || day === undefined) {
                              return h('span', { key: 'p' + String(row), className: 'dtu-cell', 'data-pad': 'true' })
                            }
                            var level = heatLevel(day.total, peak)
                            return h('span', {
                              key: day.date,
                              className: 'dtu-cell',
                              'data-level': String(level),
                              'data-today': day.date === props.today ? 'true' : undefined,
                              title: day.date + ' · ' + exact(day.total),
                              onMouseEnter: function (event) {
                                var cell = event.currentTarget.getBoundingClientRect()
                                var wrap = wrapRef.current
                                if (wrap === null) return
                                var box = wrap.getBoundingClientRect()
                                // Clamp so a tooltip on either edge column stays
                                // inside the card instead of hanging off it.
                                var left = Math.min(Math.max(cell.left - box.left + cell.width / 2, 78), Math.max(box.width - 78, 78))
                                setTip({ day: day, left: left, top: cell.top - box.top - 7 })
                              },
                              onMouseLeave: function () {
                                setTip(undefined)
                              },
                            })
                          }),
                        )
                      }),
                    ),
                  ),
                ),
              ),
              tip === undefined
                ? null
                : h(
                    'div',
                    { className: 'dtu-tip', style: { left: String(tip.left) + 'px', top: String(tip.top) + 'px' } },
                    h('div', { className: 'dtu-tipDate' }, tip.day.date),
                    h('div', { className: 'dtu-tipValue' }, exact(tip.day.total)),
                    h(
                      'div',
                      { className: 'dtu-tipSplit' },
                      t('input') + ' ' + compact(tip.day.input) + ' · ' + t('output') + ' ' + compact(tip.day.output) + ' · ' + t('cacheRead') + ' ' + compact(tip.day.cacheRead),
                    ),
                    h('div', { className: 'dtu-tipSplit' }, exact(tip.day.requests) + ' ' + t('requestsUnit')),
                  ),
            ),
        h(
          'div',
          { className: 'dtu-legend' },
          h('span', null, t('legendLess')),
          h('span', { className: 'dtu-legendSwatch', 'data-level': '0', style: { background: 'var(--dsw-alias-interactive-bg-hover,#2631480f)' } }),
          [1, 2, 3, 4].map(function (level) {
            return h('span', {
              key: String(level),
              className: 'dtu-legendSwatch',
              style: {
                background: 'var(--dsw-alias-state-business-primary,#4176e6)',
                opacity: String([0.3, 0.5, 0.72, 1][level - 1]),
              },
            })
          }),
          h('span', null, t('legendMore')),
          h('span', { style: { marginLeft: 'auto' } }, t('calendarHint')),
        ),
      )
    }

    /**
     * Display name of a provider row.
     *
     * A record whose log never named its route lands under the synthetic
     * `unknown` id; that one case is localized rather than echoing a
     * placeholder the host would have to translate.
     * @param provider - provider row from the payload.
     * @param t - locale reader.
     * @returns the label to render.
     */
    function displayName(provider, t) {
      if (provider.id === 'unknown') return t('other')
      if (typeof provider.name === 'string' && provider.name.length > 0) return provider.name
      return String(provider.id)
    }

    /**
     * Provider-grouped model table.
     * @param props - `t`, the provider rows and the selected window.
     * @returns the groups element tree.
     */
    function ProviderGroups(props) {
      var t = props.t
      var providers = Array.isArray(props.providers) ? props.providers : []
      var totals = props.totals !== null && typeof props.totals === 'object' ? props.totals : {}
      var overall = windowOf(totals[props.window])
      var widest = providers.reduce(function (top, provider) {
        var models = Array.isArray(provider.models) ? provider.models : []
        return models.reduce(function (inner, model) {
          var total = windowOf(model.windows[props.window]).total
          return total > inner ? total : inner
        }, top)
      }, 0)

      return h(
        'div',
        { className: 'dtu-groups' },
        providers.map(function (provider) {
          var providerWindow = windowOf(provider.windows[props.window])
          var share = overall.total > 0 ? Math.round((providerWindow.total / overall.total) * 100) : 0
          return h(
            'section',
            { key: provider.id, className: 'dtu-group' },
            h(
              'div',
              { className: 'dtu-groupHead' },
              h('span', { className: 'dtu-dot' }),
              h('span', { className: 'dtu-groupName' }, displayName(provider, t)),
              h('span', { className: 'dtu-groupMeta' }, String(Array.isArray(provider.models) ? provider.models.length : 0) + ' ' + t('models') + ' · ' + String(share) + '%'),
              h('span', { className: 'dtu-groupMeta', style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' } }, exact(providerWindow.total)),
            ),
            h(
              'div',
              { className: 'dtu-row', 'data-head': 'true' },
              h('span', { className: 'dtu-colHead', 'data-first': 'true' }, t('model')),
              WINDOWS.slice(0, 3).map(function (item) {
                return h('span', { key: item.id, className: 'dtu-colHead' }, t(item.label))
              }),
            ),
            provider.models.map(function (model) {
              var cells = WINDOWS.slice(0, 3).map(function (item) {
                var window = windowOf(model.windows[item.id])
                var isSelected = item.id === props.window
                return h(
                  'span',
                  {
                    key: item.id,
                    className: 'dtu-cellNum',
                    'data-strong': isSelected ? 'true' : undefined,
                    'data-zero': window.total === 0 ? 'true' : undefined,
                    title: t(item.label) + ' · ' + exact(window.total) + ' · ' + exact(window.requests) + ' ' + t('requestsUnit'),
                  },
                  compact(window.total),
                )
              })
              var all = windowOf(model.windows.all)
              var width = widest > 0 ? Math.max(2, Math.round((all.total / widest) * 100)) : 0
              return h(
                'div',
                { key: model.id, className: 'dtu-row' },
                h(
                  'div',
                  { className: 'dtu-modelCell' },
                  h(
                    'span',
                    { className: 'dtu-modelName', title: model.id + ' · ' + t('all') + ' ' + exact(all.total) + ' · ' + exact(all.requests) + ' ' + t('requestsUnit') },
                    typeof model.name === 'string' && model.name.length > 0 ? model.name : String(model.id),
                  ),
                  h('div', { className: 'dtu-bar' }, h('div', { className: 'dtu-barFill', style: { width: String(width) + '%' } })),
                ),
                cells,
              )
            }),
          )
        }),
      )
    }

    /**
     * The settings section this plugin contributes.
     * @param props - composed slot props: `t` from the locale seat, `close` from the shell.
     * @returns the page element tree.
     */
    function TokenUsageSection(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      var [selected, setSelected] = React.useState('d30')
      var [range, setRange] = React.useState(182)
      var source = useSummary()

      if (source.state.phase === 'loading') {
        return h('div', { className: 'dtu-root' }, h('div', { className: 'dtu-status' }, h('span', { className: 'dtu-spinner' }), t('loading')))
      }
      if (source.state.phase === 'failed') {
        return h(
          'div',
          { className: 'dtu-root' },
          h(
            'div',
            { className: 'dtu-status dtu-error' },
            h('span', null, t('failed') + '：' + source.state.error),
            h(
              'button',
              {
                type: 'button',
                className: 'dtu-ghost',
                onClick: function () {
                  void source.reload()
                },
              },
              t('retry'),
            ),
          ),
        )
      }

      var data = source.state.data
      if (typeof data !== 'object' || data === null) {
        return h('div', { className: 'dtu-root' }, h('div', { className: 'dtu-status' }, t('noData')))
      }

      var updatedAt = new Date()
      var hasRecords = Number.isFinite(data.records) && data.records > 0

      return h(
        'div',
        { className: 'dtu-root' },
        h(
          'header',
          { className: 'dtu-head' },
          h(
            'div',
            { className: 'dtu-headText' },
            h('h2', { className: 'dtu-title' }, t('title')),
            h('p', { className: 'dtu-subtitle' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'dtu-headActions' },
            source.scanning ? h('span', { className: 'dtu-cardHint' }, h('span', { className: 'dtu-spinner', style: { display: 'inline-block', verticalAlign: '-2px', marginRight: '6px' } }), t('scanning')) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dtu-ghost',
                disabled: source.rescanning,
                onClick: source.rescan,
              },
              h(GlyphRefresh, { size: 12 }),
              source.rescanning ? t('rescanning') : t('rescan'),
            ),
          ),
        ),
        // Cards are mounted as elements, never called as plain functions: the
        // calendar owns hooks of its own, and calling it inline would push
        // those hooks onto this section's list and break every later render.
        h(HeroCard, { t: t, data: data, window: selected, onWindow: setSelected }),
        h(CalendarCard, {
          t: t,
          calendar: data.calendar,
          today: data.today,
          range: range,
          onRange: setRange,
        }),
        hasRecords
          ? h(
              'section',
              { className: 'dtu-card' },
              h(
                'div',
                { className: 'dtu-cardHead' },
                h('h3', { className: 'dtu-cardTitle' }, t('providers')),
                h('div', { className: 'dtu-cardStats' }, h('span', null, t(windowLabel(selected)))),
              ),
              h(ProviderGroups, { t: t, providers: data.providers, totals: data.totals, window: selected }),
            )
          : h(
              'section',
              { className: 'dtu-card' },
              h('div', { className: 'dtu-status' }, h('div', null, h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, t('noData')), h('div', { className: 'dtu-cardHint' }, t('noDataHint')))),
            ),
        h(
          'div',
          { className: 'dtu-footer' },
          h('span', null, t('updatedAt', { time: updatedAt.toLocaleTimeString() })),
          h('span', null, t('timeZone', { zone: data.timeZone || 'local' })),
          h('span', null, t('records', { n: exact(data.records) })),
          data.firstDay !== null && data.firstDay !== undefined ? h('span', null, t('since', { date: String(data.firstDay) })) : null,
        ),
      )
    }

    /**
     * Dictionary key of one window id.
     * @param id - window id from `WINDOWS`.
     * @returns the key, falling back to `all`.
     */
    function windowLabel(id) {
      for (var index = 0; index < WINDOWS.length; index += 1) if (WINDOWS[index].id === id) return WINDOWS[index].label
      return 'all'
    }

    /**
     * Install the page into the Settings panel's section ledger.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, { zh: zh, en: en })
        } catch (error) {
          // A duplicate registration means a previous fiber still owns the
          // namespace; the page still renders, just with literal keys.
          ctx.logger?.warn?.('dsh-token-usage: 词条注册失败', error)
          return function () {}
        }
      }, 'dsh-token-usage: dictionaries')
      ctx.effect(
        function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'token-usage',
                order: 60,
                label: function () {
                  return ctx.locale.bind(NS)('title')
                },
                locale: NS,
              },
              TokenUsageSection,
            )
          })
        },
        'dsh-token-usage: settings section',
      )
    }

    /**
     * Four-pointed spark, the hero's glyph.
     * @param props - `size` in pixels.
     * @returns the svg element tree.
     */
    function GlyphSpark(props) {
      var size = props && props.size ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M8 1.2l1.5 4.4 4.4 1.5-4.4 1.5L8 13l-1.5-4.4L2.1 7.1l4.4-1.5L8 1.2zM13 11l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z',
        }),
      )
    }

    /**
     * Circular arrow, the rescan button's glyph.
     * @param props - `size` in pixels.
     * @returns the svg element tree.
     */
    function GlyphRefresh(props) {
      var size = props && props.size ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M8 2.4a5.6 5.6 0 105.5 6.6h-1.6A4 4 0 118 4h.5l-1.3-1.3L8 2.4zm4.6-.9v3.2H9.4l3.2-3.2z',
        }),
      )
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots', 'locale'],
      apply: apply,
    }

    return module.exports
  },
})
