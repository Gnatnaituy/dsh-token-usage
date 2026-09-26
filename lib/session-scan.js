/**
 * Reader for DSH's durable session logs.
 *
 * A session log is a JSONL file whose bytes are an append-only sequence of
 * independently decodable Zstandard frames: the persistence backend appends one
 * complete, checksummed frame per durable batch so a torn tail is recoverable
 * without rewriting the file. Node's one-shot `zstdDecompressSync` refuses
 * trailing bytes, so the frames have to be located structurally before any of
 * them can be decoded — that scan is the whole reason this module exists.
 *
 * Runtime compression is separate from the frozen session-format versions: a
 * `session.v3.jsonl.zstd` and a `session.v4.jsonl.zstd` differ in event shape,
 * not in container, so both read through this same path.
 *
 * @module dsh-token-usage/session-scan
 */

import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib'

import { recordsFromEvents } from './core.js'

/** Little-endian `0xFD2FB528`: the magic number that opens every Zstandard frame. */
export const ZSTD_MAGIC = 4247762216

/**
 * Locate every structurally complete Zstandard frame in a buffer.
 *
 * This walks the container rather than searching for the magic number, so a
 * copy of those four bytes inside compressed data can never be mistaken for a
 * frame boundary. An incomplete trailing frame — the normal state of a log
 * being written right now — is reported instead of throwing.
 *
 * @param buffer - complete bytes currently present in the artifact.
 * @returns the complete frame ranges, plus the start of a torn final frame.
 * @throws when a complete frame's structure is corrupt, which means the file
 *   itself cannot be trusted and must not be silently half-read.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode a whole session artifact into JSONL text.
 *
 * The torn final frame is decoded in flush mode so a log being written during
 * the scan still contributes every batch that has already landed, and a frame
 * that fails its checksum is skipped rather than blanking the file: a partly
 * readable history is far more useful than none.
 *
 * @param buffer - raw `.jsonl.zstd` bytes.
 * @returns the concatenated plaintext of every readable frame.
 */
export function decodeSessionLog(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  const chunks = []
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      // A frame that fails validation contributes nothing; later frames still do.
    }
  }
  if (tornStart !== undefined) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: zlibConstants.ZSTD_e_flush }).toString('utf8'))
    } catch {
      // The tail had no complete block yet.
    }
  }
  return chunks.join('')
}

/**
 * Parse JSONL text, dropping every line that is not a usable JSON object.
 * @param text - decoded session log text.
 * @returns the parsed events in file order.
 */
export function parseSessionLog(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') events.push(parsed)
    } catch {
      // A half-written trailing line is expected while a session is live.
    }
  }
  return events
}

/**
 * Identity of the session a log belongs to.
 *
 * The `session` header is authoritative; the directory name is the fallback for
 * a log whose header never landed, which keeps those records addressable rather
 * than discarding them.
 * @param events - parsed session events.
 * @param fallbackId - session id inferred from the artifact path.
 * @returns the owning session id.
 */
export function sessionIdOf(events, fallbackId) {
  for (const event of events) {
    if (event.type === 'session' && typeof event.id === 'string' && event.id.length > 0) return event.id
  }
  return fallbackId
}

/**
 * Read one session artifact into usage records.
 * @param buffer - raw `.jsonl.zstd` bytes.
 * @param fallbackId - session id used when the header is missing.
 * @returns the session id and its usage records.
 */
export function readSessionLog(buffer, fallbackId) {
  const events = parseSessionLog(decodeSessionLog(buffer))
  const sessionId = sessionIdOf(events, fallbackId)
  return { sessionId, records: recordsFromEvents(events, sessionId) }
}

/**
 * Recursively collect every session artifact under a harness `sessions` root.
 *
 * Matching is by suffix, not by an exact `session.v4.jsonl.zstd` name: the
 * format version is a migration axis and a future `v5` must not silently stop
 * the statistics from updating.
 *
 * @param root - absolute `sessions` directory.
 * @param readdir - `fs/promises` `readdir` used for traversal (injected so the
 *   caller owns the filesystem seam and tests can supply a fixture tree).
 * @returns absolute artifact paths, in discovery order.
 */
export async function collectSessionArtifacts(root, readdir) {
  const found = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(path)
    }
  }
  return found
}

/**
 * Infer a session id from an artifact path.
 * @param path - `<root>/<encoded-cwd>/<session-id>/session.vN.jsonl.zstd`.
 * @returns the directory name holding the artifact.
 */
export function sessionIdFromPath(path) {
  const parts = path.split('/')
  return parts.length >= 2 ? parts[parts.length - 2] : path
}
