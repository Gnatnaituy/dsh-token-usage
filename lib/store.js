/**
 * Durable ledger of token usage records.
 *
 * The plugin keeps its own append-only ledger instead of re-deriving statistics
 * from session logs on every request. Session logs remain the source of truth
 * and are what the ledger is built from, but they are write-optimized for
 * replay, not for "sum a month across 60 files"; a ledger that is loaded once
 * and appended to in memory keeps the settings page instant while the periodic
 * re-scan keeps it complete.
 *
 * Two files live under the plugin's own directory in the harness home:
 *
 *   `records.jsonl`  — one JSON usage record per line, append-only.
 *   `scan-cache.json` — per-artifact `{ size, mtimeMs }` marks, so a re-scan
 *                       only re-reads the artifacts that actually grew.
 *
 * Nothing here reads a location the plugin does not own, and nothing is ever
 * deleted: a corrupt line is skipped on load and left on disk for inspection.
 *
 * @module dsh-token-usage/store
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { mergeRecords } from './core.js'
import { collectSessionArtifacts, readSessionLog, sessionIdFromPath } from './session-scan.js'

/** Ledger format marker; bumped only if the record shape changes. */
const CACHE_VERSION = 1

/** How long live records are buffered before one append hits the disk. */
const FLUSH_DELAY_MS = 500

/**
 * A usage ledger with an in-memory index over an on-disk append log.
 */
export class UsageStore {
  #dir
  #logger
  #records = []
  #ids = new Set()
  #pending = []
  #flushTimer
  #scanPromise
  #lastScanAt = 0

  /**
   * @param options - plugin-owned ledger directory and a diagnostic sink.
   */
  constructor(options) {
    this.#dir = options.dir
    this.#logger = options.logger
    this.sessionsRoot = options.sessionsRoot
  }

  /** Absolute path of the append-only ledger. */
  get ledgerPath() {
    return join(this.#dir, 'records.jsonl')
  }

  /** Absolute path of the artifact scan cache. */
  get cachePath() {
    return join(this.#dir, 'scan-cache.json')
  }

  /** Number of records currently indexed. */
  get size() {
    return this.#records.length
  }

  /** True while a full or incremental scan is in flight. */
  get scanning() {
    return this.#scanPromise !== undefined
  }

  /** Epoch milliseconds of the last completed scan, or 0. */
  get lastScanAt() {
    return this.#lastScanAt
  }

  /**
   * Load the ledger from disk.
   *
   * Loading is deliberately tolerant: a truncated final line is the expected
   * shape of a crash, and dropping it costs at most the last batch — the next
   * scan re-derives those records from the session logs anyway.
   * @returns the number of records indexed.
   */
  async load() {
    let text = ''
    try {
      text = await readFile(this.ledgerPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') this.#warn('读取用量账本失败', error)
      return 0
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id.length === 0) continue
      if (this.#ids.has(record.id)) continue
      this.#ids.add(record.id)
      this.#records.push(record)
    }
    return this.#records.length
  }

  /**
   * Index new records and schedule one disk append.
   * @param incoming - candidate records from the live stream or a scan.
   * @returns the number of records actually accepted.
   */
  add(incoming) {
    const { accepted, seen } = mergeRecords(this.#records, incoming, this.#ids)
    if (accepted.length === 0) return 0
    this.#ids = seen
    this.#records.push(...accepted)
    this.#pending.push(...accepted)
    this.#scheduleFlush()
    return accepted.length
  }

  /**
   * Flush buffered records to the ledger immediately.
   * @returns a promise settling when the append is durable.
   */
  async flush() {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
    if (this.#pending.length === 0) return
    const batch = this.#pending
    this.#pending = []
    const body = `${batch.map((record) => JSON.stringify(record)).join('\n')}\n`
    try {
      await mkdir(this.#dir, { recursive: true })
      await appendFile(this.ledgerPath, body, 'utf8')
    } catch (error) {
      this.#warn('写入用量账本失败', error)
      // Keep the records in memory; they are re-derivable, and a later flush
      // for a newer batch must not silently drop this one.
      this.#pending.unshift(...batch)
    }
  }

  /**
   * Re-scan the harness session logs into the ledger.
   *
   * Concurrent callers share one in-flight scan, so a page load landing during
   * the startup scan never doubles the disk work.
   * @param options - `force` re-reads artifacts whose marks still match.
   * @returns a promise settling with how many records the scan added.
   */
  async backfill(options = {}) {
    if (this.#scanPromise !== undefined) return this.#scanPromise
    this.#scanPromise = this.#scan(options.force === true)
      .catch((error) => {
        this.#warn('扫描会话日志失败', error)
        return 0
      })
      .finally(() => {
        this.#scanPromise = undefined
        this.#lastScanAt = Date.now()
      })
    return this.#scanPromise
  }

  /**
   * The records the summary is built from.
   * @returns a shallow copy of the ledger array.
   */
  snapshot() {
    return this.#records.slice()
  }

  /**
   * Stop the flush timer and write what is buffered.
   * @returns a promise settling when the final append is durable.
   */
  async dispose() {
    await this.flush()
  }

  /**
   * Schedule the debounced flush.
   */
  #scheduleFlush() {
    if (this.#flushTimer !== undefined) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      void this.flush()
    }, FLUSH_DELAY_MS)
    // A pending write must not keep the process alive on shutdown.
    this.#flushTimer.unref?.()
  }

  /**
   * Walk every session artifact and ingest the ones that changed.
   * @param force - ignore the scan cache and re-read everything.
   * @returns the number of records accepted.
   */
  async #scan(force) {
    const artifacts = await collectSessionArtifacts(this.sessionsRoot, readdir)
    const cache = force ? { version: CACHE_VERSION, records: 0, files: {} } : await this.#readCache()
    const files = { ...cache.files }
    let accepted = 0
    let read = 0
    for (const path of artifacts) {
      let marks
      try {
        const info = await stat(path)
        marks = { size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        continue
      }
      const previous = files[path]
      if (previous !== undefined && previous.size === marks.size && previous.mtimeMs === marks.mtimeMs) continue
      let buffer
      try {
        buffer = await readFile(path)
      } catch {
        continue
      }
      read += 1
      let records = []
      try {
        records = readSessionLog(buffer, sessionIdFromPath(path)).records
      } catch (error) {
        this.#warn(`跳过无法读取的会话日志 ${path}`, error)
        files[path] = marks
        continue
      }
      accepted += this.add(records)
      files[path] = marks
    }
    // The marks are only trustworthy while the ledger is the one they were
    // measured against; a deleted ledger re-derives everything next boot.
    await this.flush()
    await this.#writeCache({ version: CACHE_VERSION, records: this.#records.length, files })
    this.#log(`扫描完成：${artifacts.length} 个会话日志，重读 ${read} 个，新增 ${accepted} 条记录`)
    return accepted
  }

  /**
   * Read the artifact scan cache, discarding it when it cannot be trusted.
   *
   * A cache that does not describe the ledger on disk — because the ledger was
   * deleted, truncated, or written by a different version — must not be reused:
   * skipping a read on its word would permanently lose that artifact's records.
   * @returns the cache, or an empty one when it is unusable.
   */
  async #readCache() {
    const empty = { version: CACHE_VERSION, records: 0, files: {} }
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.cachePath, 'utf8'))
    } catch {
      return empty
    }
    if (parsed === null || typeof parsed !== 'object') return empty
    if (parsed.version !== CACHE_VERSION) return empty
    if (parsed.records !== this.#records.length) {
      this.#log('扫描缓存与账本不一致，改为全量重扫')
      return empty
    }
    if (parsed.files === null || typeof parsed.files !== 'object') return empty
    return { version: CACHE_VERSION, records: parsed.records, files: parsed.files }
  }

  /**
   * Persist the artifact scan cache.
   * @param cache - marks measured against the current ledger.
   */
  async #writeCache(cache) {
    try {
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.cachePath, `${JSON.stringify(cache)}\n`, 'utf8')
    } catch (error) {
      this.#warn('写入扫描缓存失败', error)
    }
  }

  /**
   * Report a diagnostic through the host logger when one is available.
   * @param message - human-readable summary.
   * @param error - optional cause.
   */
  #warn(message, error) {
    this.#logger?.warn?.(`dsh-token-usage: ${message}`, error)
  }

  /**
   * Report progress through the host logger when one is available.
   * @param message - human-readable summary.
   */
  #log(message) {
    this.#logger?.info?.(`dsh-token-usage: ${message}`)
  }
}
