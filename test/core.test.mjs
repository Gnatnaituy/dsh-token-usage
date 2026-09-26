/**
 * Unit tests for the pure aggregation core.
 *
 * These run without a harness, a browser, or the filesystem: every case builds
 * plain records and asserts the exact numbers the settings page would render.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSummary,
  dayKey,
  dayRange,
  emptyWindow,
  mergeRecords,
  prettifyId,
  recordFromEvent,
  recordsFromEvents,
  shiftDay,
  totalOf,
} from '../lib/core.js'

/** One `assistant/message` event that reported usage. */
function message(seq, time, provider, model, usage) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn: 1, step: seq, message: { role: 'assistant', source: { kind: 'model', provider, model } }, usage },
  }
}

/** A local-noon epoch for a day key, so a record lands unambiguously on that day. */
function noon(day) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 12, 0, 0, 0).getTime()
}

test('dayKey renders the local calendar day', () => {
  assert.equal(dayKey(noon('2026-09-26')), '2026-09-26')
  assert.equal(dayKey(Number.NaN), '')
})

test('shiftDay moves by whole days across month and year boundaries', () => {
  assert.equal(shiftDay('2026-09-26', -1), '2026-09-25')
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2026-09-26', 0), '2026-09-26')
  assert.equal(shiftDay('nonsense', 1), '')
})

test('dayRange is inclusive and empty when reversed', () => {
  assert.deepEqual(dayRange('2026-09-24', '2026-09-26'), ['2026-09-24', '2026-09-25', '2026-09-26'])
  assert.deepEqual(dayRange('2026-09-26', '2026-09-24'), [])
})

test('emptyWindow sums to zero and totalOf agrees', () => {
  const window = emptyWindow()
  assert.equal(totalOf(window), 0)
  assert.equal(window.requests, 0)
})

test('usageOf is dropped when the provider reported nothing', () => {
  assert.equal(recordFromEvent('s', { type: 'assistant/message', seq: 1, time: 1, data: {} }), undefined)
  assert.equal(
    recordFromEvent('s', { type: 'assistant/message', seq: 1, time: 1, data: { usage: { inputTokens: 0, outputTokens: 0 } } }),
    undefined,
  )
  assert.equal(recordFromEvent('s', { type: 'tool/call', seq: 1, time: 1, data: {} }), undefined)
})

test('a live message becomes a record keyed by session and seq', () => {
  const record = recordFromEvent('session-a', message(7, noon('2026-09-26'), 'command-code', 'zai-org/GLM-5.3', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, totalTokens: 15 }))
  assert.deepEqual(record, {
    id: 'session-a:7',
    t: noon('2026-09-26'),
    session: 'session-a',
    provider: 'command-code',
    model: 'zai-org/GLM-5.3',
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    reasoning: 0,
  })
})

test('the ambient request header attributes a message that carries no source', () => {
  const events = [
    { type: 'request/header', seq: 1, time: 1, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { usage: { inputTokens: 5, outputTokens: 5 } } },
    { type: 'request/header', seq: 3, time: 3, data: { header: { config: { provider: 'command-code', model: 'deepseek/deepseek-v4-pro' } } } },
    { type: 'assistant/message', seq: 4, time: 4, data: { usage: { inputTokens: 1, outputTokens: 1 } } },
  ]
  const records = recordsFromEvents(events, 's')
  assert.deepEqual(
    records.map((record) => [record.provider, record.model]),
    [
      ['opencode-go', 'deepseek-v4-flash'],
      ['command-code', 'deepseek/deepseek-v4-pro'],
    ],
  )
})

test('a message source wins over the ambient header', () => {
  const events = [
    { type: 'request/header', seq: 1, time: 1, data: { header: { config: { provider: 'stale', model: 'stale-model' } } } },
    message(2, 2, 'fresh', 'fresh-model', { inputTokens: 1, outputTokens: 1 }),
  ]
  assert.deepEqual(recordsFromEvents(events, 's').map((record) => record.provider), ['fresh'])
})

test('mergeRecords deduplicates by id and reports only what it accepted', () => {
  const first = recordFromEvent('s', message(1, noon('2026-09-26'), 'p', 'm', { inputTokens: 1, outputTokens: 1 }))
  const second = recordFromEvent('s', message(2, noon('2026-09-26'), 'p', 'm', { inputTokens: 1, outputTokens: 1 }))
  const initial = mergeRecords([], [first])
  assert.equal(initial.accepted.length, 1)
  const again = mergeRecords([first], [first, second], initial.seen)
  assert.deepEqual(again.accepted.map((record) => record.id), ['s:2'])
  const malformed = mergeRecords([], [{ id: '', t: 1 }, { id: 'x', t: Number.NaN }, null])
  assert.deepEqual(malformed.accepted, [])
})

test('buildSummary splits windows, calendar and provider groups', () => {
  const today = '2026-09-26'
  const records = [
    recordFromEvent('s', message(1, noon(today), 'command-code', 'model-a', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1, totalTokens: 111 })),
    recordFromEvent('s', message(2, noon(shiftDay(today, -3)), 'command-code', 'model-a', { inputTokens: 200, outputTokens: 20, totalTokens: 220 })),
    recordFromEvent('s', message(3, noon(shiftDay(today, -10)), 'opencode-go', 'model-b', { inputTokens: 300, outputTokens: 30, cacheReadTokens: 5, totalTokens: 335 })),
    recordFromEvent('s', message(4, noon(shiftDay(today, -100)), 'opencode-go', 'model-b', { inputTokens: 400, outputTokens: 40, totalTokens: 440 })),
  ]
  const summary = buildSummary(records, { now: noon(today) })

  assert.equal(summary.today, today)
  assert.equal(summary.firstDay, shiftDay(today, -100))
  assert.equal(summary.totals.today.total, 111)
  assert.equal(summary.totals.d7.total, 331)
  assert.equal(summary.totals.d30.total, 666)
  assert.equal(summary.totals.all.total, 1106)
  assert.equal(summary.totals.d30.requests, 3)

  assert.equal(summary.calendar.days.length, 371)
  assert.equal(summary.calendar.days[summary.calendar.days.length - 1].date, today)
  assert.equal(summary.calendar.max, 440)
  assert.equal(summary.calendar.activeDays, 4)

  assert.deepEqual(summary.providers.map((provider) => provider.id), ['opencode-go', 'command-code'])
  const commandCode = summary.providers.find((provider) => provider.id === 'command-code')
  assert.equal(commandCode.windows.today.total, 111)
  assert.equal(commandCode.windows.d30.total, 331)
  assert.equal(commandCode.models[0].id, 'model-a')
  assert.equal(commandCode.models[0].windows.d7.total, 331)
})

test('a record outside the calendar range still counts in the all-time window', () => {
  const today = '2026-09-26'
  const records = [recordFromEvent('s', message(1, noon(shiftDay(today, -400)), 'p', 'm', { inputTokens: 7, outputTokens: 1 }))]
  const summary = buildSummary(records, { now: noon(today) })
  assert.equal(summary.totals.all.total, 8)
  assert.equal(summary.calendar.activeDays, 0)
  assert.equal(summary.firstDay, shiftDay(today, -400))
})

test('unattributed usage lands under the synthetic unknown provider', () => {
  const today = '2026-09-26'
  const records = [recordFromEvent('s', { type: 'assistant/message', seq: 1, time: noon(today), data: { usage: { inputTokens: 4, outputTokens: 4 } } })]
  const summary = buildSummary(records, { now: noon(today) })
  assert.deepEqual(summary.providers.map((provider) => provider.id), ['unknown'])
  assert.deepEqual(summary.providers[0].models.map((model) => model.id), ['unknown'])
})

test('an empty ledger yields a full calendar of zeros', () => {
  const summary = buildSummary([], { now: noon('2026-09-26') })
  assert.equal(summary.records, 0)
  assert.equal(summary.firstDay, null)
  assert.equal(summary.calendar.max, 0)
  assert.equal(summary.calendar.days.length, 371)
  assert.deepEqual(summary.providers, [])
  assert.equal(summary.totals.all.total, 0)
})

test('prettifyId title-cases the id shapes a provider directory uses', () => {
  assert.equal(prettifyId('opencode-go'), 'Opencode Go')
  assert.equal(prettifyId('command-code'), 'Command Code')
  assert.equal(prettifyId(''), '')
  assert.equal(prettifyId(undefined), '')
})
