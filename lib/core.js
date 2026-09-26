/**
 * Pure core of dsh-token-usage: no filesystem, no Cordis, no clock of its own.
 *
 * Everything here is a plain function over plain data so the aggregation can be
 * unit-tested in isolation and shared verbatim between the host half (which
 * serves it) and the tests. Nothing in this module throws on malformed input:
 * a usage record that cannot be read is dropped, because one bad line must
 * never blank the whole statistics page.
 *
 * @module dsh-token-usage/core
 */

/** Token counters every window and every row carries, in display order. */
export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

/** The usage keys a provider may report, mapped onto our counter names. */
const USAGE_KEYS = {
  inputTokens: 'input',
  outputTokens: 'output',
  cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite',
  reasoningTokens: 'reasoning',
}

/**
 * Pad a number to two digits.
 * @param value - non-negative integer below 100.
 * @returns the zero-padded decimal string.
 */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Local-calendar day key of one instant, in the host's own time zone.
 *
 * The plugin aggregates where the harness runs, not where the browser is: the
 * session logs already carry absolute instants and a single local calendar is
 * the only reading that can be consistent across a whole deployment.
 * @param time - epoch milliseconds.
 * @returns `YYYY-MM-DD` in local time, or `''` for a non-finite instant.
 */
export function dayKey(time) {
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * A zeroed token counter.
 * @returns every field at zero.
 */
export function emptyWindow() {
  const window = { total: 0, requests: 0 }
  for (const field of TOKEN_FIELDS) window[field] = 0
  return window
}

/**
 * Add one record's counters into a window.
 * @param window - accumulator, mutated in place.
 * @param record - usage record or any object with the counters.
 */
export function addInto(window, record) {
  for (const field of TOKEN_FIELDS) window[field] += number(record[field])
  window.requests += 1
  window.total = window.input + window.output + window.cacheRead + window.cacheWrite + window.reasoning
}

/**
 * Coerce one counter to a usable number.
 * @param value - raw counter from a log line or a request.
 * @returns a finite, non-negative integer.
 */
function number(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

/**
 * Read the provider-reported usage of one `assistant/message` event.
 *
 * A step whose provider reported nothing is not a billable record: the harness
 * only persists usage when the provider sent it, so an absent block means
 * "unknown", never "zero". Counting it as zero would inflate the request count
 * of every model that streams without usage.
 * @param event - a session event.
 * @returns the normalized counters, or undefined when the event carries none.
 */
export function usageOf(event) {
  const usage = event?.data?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const record = { provider: '', model: '' }
  let seen = false
  for (const [key, field] of Object.entries(USAGE_KEYS)) {
    const value = number(usage[key])
    record[field] = value
    if (value > 0) seen = true
  }
  if (!seen && number(usage.totalTokens) === 0) return undefined
  return record
}

/**
 * Provider and model an assistant message was produced by.
 *
 * `message.source` is the authoritative per-message attribution (it survives a
 * mid-session model switch); the ambient `request/header` only supplies the
 * fallback for messages persisted without a source.
 * @param event - a session event.
 * @param ambient - the latest `{ provider, model }` seen in the log.
 * @returns the attribution, with empty strings when nothing is known.
 */
function attributionOf(event, ambient) {
  const source = event?.data?.message?.source
  const provider = typeof source?.provider === 'string' && source.provider.length > 0 ? source.provider : ambient.provider
  const model = typeof source?.model === 'string' && source.model.length > 0 ? source.model : ambient.model
  return { provider, model }
}

/**
 * Fold one session log (or one live event stream) into usage records.
 *
 * The fold tracks the ambient request header because older logs predate
 * per-message attribution, and it keeps one record per `assistant/message`
 * that reported usage. `assistant/attempt` and `llm/retry-started` are
 * deliberately ignored: in this harness they carry no usage, and counting them
 * alongside the message they precede would double-count a retried step.
 *
 * @param events - session events in log order.
 * @param sessionId - owning session identity, stamped onto every record.
 * @returns usage records in log order.
 */
export function recordsFromEvents(events, sessionId) {
  const records = []
  const ambient = { provider: '', model: '' }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.provider === 'string' && config.provider.length > 0) ambient.provider = config.provider
      if (typeof config?.model === 'string' && config.model.length > 0) ambient.model = config.model
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = usageOf(event)
      if (usage === undefined) continue
      const { provider, model } = attributionOf(event, ambient)
      records.push({
        id: `${sessionId}:${number(event.seq)}`,
        t: number(event.time),
        session: sessionId,
        provider,
        model,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
      })
    }
  }
  return records
}

/**
 * Record one live `session/event` observation.
 *
 * The live path shares {@link recordsFromEvents} semantics; it simply carries no
 * ambient header, because the message itself is attributed in every format
 * version that streams into a running harness.
 * @param sessionId - owning session identity.
 * @param event - the appended session event.
 * @returns one record, or undefined when the event is not billable.
 */
export function recordFromEvent(sessionId, event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return undefined
  return recordsFromEvents([event], sessionId)[0]
}

/**
 * Reject a record that cannot be aggregated.
 * @param record - candidate record.
 * @returns true when the record carries an id and a finite instant.
 */
function isUsable(record) {
  return record !== null && typeof record === 'object' && typeof record.id === 'string' && record.id.length > 0 && Number.isFinite(record.t)
}

/**
 * Merge records into a ledger, skipping identities already present.
 *
 * Identity is `sessionId:seq`, so a re-scan of a growing session log re-offers
 * every earlier record of that file and only the new tail is accepted. The
 * function never mutates its inputs and reports what it accepted, which is what
 * lets the store decide whether the on-disk ledger needs another append.
 *
 * @param ledger - existing records, in any order.
 * @param incoming - candidate records.
 * @param seen - optional identity set already in `ledger` (built when omitted).
 * @returns the accepted records and the updated identity set.
 */
export function mergeRecords(ledger, incoming, seen) {
  const known = seen ?? new Set()
  if (seen === undefined) for (const record of ledger) if (isUsable(record)) known.add(record.id)
  const accepted = []
  for (const record of incoming) {
    if (!isUsable(record)) continue
    if (known.has(record.id)) continue
    known.add(record.id)
    accepted.push(record)
  }
  return { accepted, seen: known }
}

/**
 * Every day from `from` to `to` inclusive, as local day keys.
 * @param from - start day key `YYYY-MM-DD`.
 * @param to - end day key `YYYY-MM-DD`.
 * @returns the inclusive day keys; empty when either bound is malformed.
 */
export function dayRange(from, to) {
  const start = parseDayKey(from)
  const end = parseDayKey(to)
  if (start === undefined || end === undefined || end < start) return []
  const days = []
  for (let cursor = start; cursor <= end; cursor += 86_400_000) days.push(keyOfEpoch(cursor))
  return days
}

/**
 * Parse a local day key into the epoch of its UTC midnight.
 *
 * Day arithmetic runs on UTC midnights so a DST transition can never produce a
 * duplicated or skipped calendar column, while the keys themselves stay local.
 * @param key - `YYYY-MM-DD`.
 * @returns epoch milliseconds, or undefined when the key is malformed.
 */
function parseDayKey(key) {
  if (typeof key !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (match === null) return undefined
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(epoch) ? undefined : epoch
}

/**
 * Render the UTC-midnight epoch of a local day back into a day key.
 * @param epoch - epoch milliseconds at UTC midnight.
 * @returns `YYYY-MM-DD`.
 */
function keyOfEpoch(epoch) {
  const date = new Date(epoch)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/**
 * Shift a day key by a whole number of days.
 * @param key - `YYYY-MM-DD`.
 * @param delta - day offset, negative for the past.
 * @returns the shifted key, or `''` when `key` is malformed.
 */
export function shiftDay(key, delta) {
  const epoch = parseDayKey(key)
  if (epoch === undefined) return ''
  return keyOfEpoch(epoch + delta * 86_400_000)
}

/**
 * Human-facing default for an id we have no display name for.
 *
 * The provider directory is the only authority on display names; this is the
 * fallback for a route that has since been removed from the deployment, and it
 * never invents a language the page has not chosen.
 * @param id - provider id from a session log or the LLM directory.
 * @returns a title-cased label, or `''` when there is nothing to title-case.
 */
export function prettifyId(id) {
  const text = typeof id === 'string' ? id : ''
  if (text.length === 0) return ''
  return text
    .split(/[-_/\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Window ids every summary exposes, in display order. */
export const WINDOWS = [
  { id: 'today', days: 1 },
  { id: 'd7', days: 7 },
  { id: 'd30', days: 30 },
  { id: 'all', days: Number.POSITIVE_INFINITY },
]

/**
 * Aggregate a ledger into the payload the settings page renders.
 *
 * One pass over the records builds every window, the calendar and the
 * provider/model tree at once; the result is fully detached and JSON-safe, so
 * the route can serialize it without further work.
 *
 * @param records - usage records from the ledger.
 * @param options - `now` (epoch ms, defaults to the current clock) and the
 *   `calendarDays` floor for how much history the heatmap shows.
 * @returns the summary payload.
 */
export function buildSummary(records, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const calendarDays = Number.isFinite(options.calendarDays) ? options.calendarDays : 371
  const today = dayKey(now)
  const calendarStart = shiftDay(today, -(calendarDays - 1))

  /** Day offset (0 = today) for every day a window cares about. */
  const offsets = new Map()
  for (let offset = 0; offset < 30; offset += 1) offsets.set(shiftDay(today, -offset), offset)

  const totals = { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow(), all: emptyWindow() }
  const calendar = new Map()
  const providers = new Map()
  let firstDay = ''

  for (const record of records) {
    if (!isUsable(record)) continue
    const day = dayKey(record.t)
    if (day === '') continue
    if (firstDay === '' || day < firstDay) firstDay = day

    const offset = offsets.get(day)

    if (day >= calendarStart) {
      let bucket = calendar.get(day)
      if (bucket === undefined) {
        bucket = emptyWindow()
        calendar.set(day, bucket)
      }
      addInto(bucket, record)
    }

    const providerId = record.provider.length > 0 ? record.provider : 'unknown'
    const modelId = record.model.length > 0 ? record.model : 'unknown'
    let provider = providers.get(providerId)
    if (provider === undefined) {
      provider = {
        id: providerId,
        models: new Map(),
        windows: { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow(), all: emptyWindow() },
      }
      providers.set(providerId, provider)
    }
    let model = provider.models.get(modelId)
    if (model === undefined) {
      model = { id: modelId, windows: { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow(), all: emptyWindow() } }
      provider.models.set(modelId, model)
    }

    // One record belongs to a window exactly when its day falls inside it, so
    // the same guard list drives the three levels and no level can drift.
    const applicable = [
      ['all', true],
      ['d30', offset !== undefined],
      ['d7', offset !== undefined && offset < 7],
      ['today', offset === 0],
    ]
    for (const [id, applies] of applicable) {
      if (!applies) continue
      addInto(totals[id], record)
      addInto(provider.windows[id], record)
      addInto(model.windows[id], record)
    }
  }

  const days = []
  for (const day of dayRange(calendarStart, today)) {
    const bucket = calendar.get(day)
    days.push({
      date: day,
      total: bucket === undefined ? 0 : bucket.total,
      input: bucket === undefined ? 0 : bucket.input,
      output: bucket === undefined ? 0 : bucket.output,
      cacheRead: bucket === undefined ? 0 : bucket.cacheRead,
      requests: bucket === undefined ? 0 : bucket.requests,
    })
  }

  return {
    timeZone: resolvedTimeZone(),
    today,
    firstDay: firstDay === '' ? null : firstDay,
    calendar: {
      start: calendarStart,
      end: today,
      max: days.reduce((peak, day) => Math.max(peak, day.total), 0),
      activeDays: days.reduce((count, day) => count + (day.total > 0 ? 1 : 0), 0),
      days,
    },
    totals,
    providers: [...providers.values()]
      .map((provider) => ({
        id: provider.id,
        name: provider.name ?? '',
        windows: provider.windows,
        models: [...provider.models.values()]
          .map((model) => ({ id: model.id, name: model.name ?? '', windows: model.windows }))
          .sort((a, b) => b.windows.all.total - a.windows.all.total || a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => b.windows.all.total - a.windows.all.total || a.id.localeCompare(b.id)),
    records: records.length,
  }
}

/**
 * Sum every counter of a window into its `total`.
 * @param window - window with per-field counters.
 * @returns the summed total.
 */
export function totalOf(window) {
  let total = 0
  for (const field of TOKEN_FIELDS) total += number(window[field])
  return total
}

/**
 * Best-effort local time-zone name for the page's footer caption.
 * @returns an IANA zone name, or `'local'` when the runtime cannot name it.
 */
function resolvedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}
