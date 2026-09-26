/**
 * Tests for the multi-frame Zstandard session-log reader.
 *
 * Frames are built with Node's own compressor rather than a fixture file, so the
 * container shape under test is exactly the one the harness writes: one complete
 * checksummed frame per durable batch, appended back to back.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'

import { collectSessionArtifacts, decodeSessionLog, parseSessionLog, readSessionLog, scanZstdFrames, sessionIdFromPath } from '../lib/session-scan.js'

/** Compress one JSONL batch the way the persistence backend does. */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })
}

/** One header event plus one billable assistant message. */
function sessionLines(id, extra) {
  const lines = [JSON.stringify({ type: 'session', version: 4, id, cwd: '/tmp', createdAt: 1 })]
  lines.push(JSON.stringify({ type: 'request/header', seq: 1, time: 10, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } } }))
  for (const event of extra ?? []) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

test('scanZstdFrames finds every appended frame structurally', () => {
  const buffer = Buffer.concat([frame('{"a":1}\n'), frame('{"b":2}\n'), frame('{"c":3}\n')])
  const { frames, tornStart } = scanZstdFrames(buffer)
  assert.equal(frames.length, 3)
  assert.equal(tornStart, undefined)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, frames[1].start)
})

test('scanZstdFrames is not fooled by the magic number inside payload bytes', () => {
  // A payload that contains the frame magic must still count as one frame: the
  // scanner walks the block structure instead of searching for the magic.
  const payload = `{"type":"assistant/message","text":"${Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).toString('latin1')}"}\n`
  const buffer = Buffer.concat([frame(payload), frame('{"tail":true}\n')])
  const { frames } = scanZstdFrames(buffer)
  assert.equal(frames.length, 2)
})

test('a torn trailing frame is reported, not thrown', () => {
  const complete = frame('{"a":1}\n')
  const partial = frame('{"b":2}\n').subarray(0, 12)
  const { frames, tornStart } = scanZstdFrames(Buffer.concat([complete, partial]))
  assert.equal(frames.length, 1)
  assert.equal(tornStart, complete.length)
})

test('decodeSessionLog returns the concatenated plaintext of every frame', () => {
  const buffer = Buffer.concat([frame('{"a":1}\n'), frame('{"b":2}\n')])
  assert.equal(decodeSessionLog(buffer), '{"a":1}\n{"b":2}\n')
})

test('a corrupt complete frame rejects instead of yielding half a log', () => {
  const good = frame('{"a":1}\n')
  const corrupt = Buffer.from(good)
  corrupt.writeUInt32LE(0, 0)
  assert.throws(() => scanZstdFrames(Buffer.concat([good, corrupt])), /invalid frame magic/)
})

test('parseSessionLog drops malformed and half-written lines', () => {
  const events = parseSessionLog('{"type":"session","id":"s"}\nnot json\n\n{"type":"session/title","seq":2}\n{"type":"tor')
  assert.deepEqual(events.map((event) => event.type), ['session', 'session/title'])
})

test('readSessionLog attributes usage through the ambient header', () => {
  const buffer = Buffer.concat([
    frame(sessionLines('session-x')),
    frame(`${JSON.stringify({ type: 'assistant/message', seq: 2, time: 20, data: { usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 7, totalTokens: 21 } } })}\n`),
  ])
  const { sessionId, records } = readSessionLog(buffer, 'fallback')
  assert.equal(sessionId, 'session-x')
  assert.equal(records.length, 1)
  assert.deepEqual(records[0], {
    id: 'session-x:2',
    t: 20,
    session: 'session-x',
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    input: 11,
    output: 3,
    cacheRead: 7,
    cacheWrite: 0,
    reasoning: 0,
  })
})

test('readSessionLog falls back to the directory name when the header is missing', () => {
  const buffer = frame(`${JSON.stringify({ type: 'assistant/message', seq: 1, time: 20, data: { usage: { inputTokens: 1, outputTokens: 1 } } })}\n`)
  const { sessionId, records } = readSessionLog(buffer, 'session-from-path')
  assert.equal(sessionId, 'session-from-path')
  assert.equal(records[0].id, 'session-from-path:1')
})

test('sessionIdFromPath reads the directory that holds the artifact', () => {
  assert.equal(sessionIdFromPath('/home/u/sessions/--proj--/session-abc/session.v4.jsonl.zstd'), 'session-abc')
})

test('collectSessionArtifacts walks nested session directories', async () => {
  const tree = {
    '/root': [
      { name: '--proj--', isDirectory: () => true, isFile: () => false },
      { name: 'readme.md', isDirectory: () => false, isFile: () => true },
    ],
    '/root/--proj--': [
      { name: 'session-1', isDirectory: () => true, isFile: () => false },
      { name: 'session.v5.jsonl.zstd', isDirectory: () => false, isFile: () => true },
    ],
    '/root/--proj--/session-1': [{ name: 'session.v4.jsonl.zstd', isDirectory: () => false, isFile: () => true }],
  }
  const readdir = async (path) => {
    if (tree[path] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return tree[path]
  }
  const found = await collectSessionArtifacts('/root', readdir)
  assert.deepEqual(found, ['/root/--proj--/session.v5.jsonl.zstd', '/root/--proj--/session-1/session.v4.jsonl.zstd'])
})

test('the decoder is stable across two identical reads', () => {
  const buffer = Buffer.concat([frame('{"a":1}\n'), frame('{"b":2}\n')])
  const digest = (text) => createHash('sha256').update(text).digest('hex')
  assert.equal(digest(decodeSessionLog(buffer)), digest(decodeSessionLog(buffer)))
})
