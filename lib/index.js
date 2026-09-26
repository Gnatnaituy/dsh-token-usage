/**
 * Host half of dsh-token-usage.
 *
 * Two responsibilities, one directory:
 *
 *   - keep a durable ledger of provider-reported token usage by folding every
 *     `assistant/message` the harness appends, and backfilling that ledger from
 *     the session logs already on disk;
 *   - serve the aggregated statistics the settings page renders, over the
 *     harness web server, under this plugin's own path prefix.
 *
 * The browser half registers the page; it reads nothing but these routes. The
 * plugin writes only inside its own directory in the harness home.
 *
 * @module dsh-token-usage
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildSummary, prettifyId, recordFromEvent } from './core.js'
import { UsageStore } from './store.js'

/** Plugin identity: equals the package name and the Loader row name. */
export const name = 'dsh-token-usage'

/** Services that must exist before the routes can be registered. */
export const inject = ['webServer']

/** Path prefix this plugin owns on the harness web server. */
const ROUTE_PREFIX = '/dsh-token-usage'

/** How long one built summary is reused before it is rebuilt from the ledger. */
const SUMMARY_TTL_MS = 20_000

/** Harness home of the legacy DSH Desktop (Electron) build, the oldest fallback. */
function legacyHome() {
  return join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
}

/** `$DSH_HOME` when it carries a real path. */
function environmentHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined
}

/**
 * Candidate harness homes, most authoritative first.
 *
 * The harness ships a single home resolver (`@deepseek-ai/dsh-home-paths`:
 * configured path, then `$DSH_HOME`, then `~/.dsh`) and exposes it as the
 * `dshHomePath` service, so reading it answers with the home this deployment
 * actually booted with instead of a guess.
 *
 * `$DSH_HOME` stays a candidate because a harness that did not export it — an
 * Electron build, or a process started from a shell without it — would
 * otherwise resolve to `~/.dsh` and read an empty directory, reporting zero
 * usage forever without ever looking broken. The legacy Electron home is the
 * last candidate so an older deployment keeps working.
 *
 * @param ctx - host plugin context; services are read through `ctx.get`, which
 *   answers `undefined` instead of throwing when the service is absent.
 * @returns home directories to probe, most authoritative first.
 */
export function homeCandidates(ctx) {
  const candidates = []
  try {
    const fromService = ctx?.get?.('dshHomePath')
    if (typeof fromService === 'function') candidates.push(fromService())
  } catch {
    // An absent or still-mounting service must not stop the plugin from loading.
  }
  candidates.push(environmentHome(), join(homedir(), '.dsh'), legacyHome())
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
}

/**
 * Resolve the harness home that actually holds this deployment's sessions.
 *
 * The first candidate holding a real `sessions` directory wins: that is the
 * difference between the home this harness booted with and another harness's
 * home on the same machine. When none exists yet, the first candidate is still
 * the best answer — the harness creates its sessions directory on first use.
 *
 * @param candidates - home directories to probe, most authoritative first.
 * @param exists - `fs.existsSync`, injected so the probe is testable.
 * @returns the first candidate holding a sessions directory, else the first.
 */
export function resolveHarnessHome(candidates, exists = existsSync) {
  const usable = candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of usable) {
    if (exists(join(candidate, 'sessions'))) return candidate
  }
  return usable[0] ?? legacyHome()
}

/**
 * Register the plugin.
 * @param ctx - host plugin context carrying the web server service.
 */
export function apply(ctx) {
  const home = resolveHarnessHome(homeCandidates(ctx))
  const ledgerDir = join(home, 'dsh-token-usage')
  const store = new UsageStore({
    dir: ledgerDir,
    sessionsRoot: join(home, 'sessions'),
    logger: ctx.logger,
  })

  let summaryCache
  let providerNames = new Map()
  let providerNamesReadAt = 0

  ctx.effect(() => () => store.dispose(), 'dsh-token-usage: ledger flush')

  // Live capture: every assistant message that reported usage becomes one
  // ledger record the moment the harness persists it.
  ctx.on('session/event', (session, event) => {
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    const record = recordFromEvent(sessionId, event)
    if (record === undefined) return
    store.add([record])
    summaryCache = undefined
  })

  // Backfill after mounting so boot is never blocked on reading 30 MB of logs;
  // the page renders the ledger it has and picks up the rest on its next poll.
  void (async () => {
    const loaded = await store.load()
    ctx.logger?.info?.(`dsh-token-usage: 账本已载入 ${loaded} 条记录（${store.ledgerPath}）`)
    await store.backfill()
  })()

  /**
   * Read provider display names from the optional LLM directory.
   *
   * The directory is the only place that knows what a route wants to be called;
   * a deployment without an LLM service simply gets prettified ids. A failed
   * read never breaks the page, so this is best-effort by construction.
   * @returns a map of provider id to display name.
   */
  function readProviderNames() {
    const now = Date.now()
    if (now - providerNamesReadAt < SUMMARY_TTL_MS) return providerNames
    providerNamesReadAt = now
    const names = new Map()
    try {
      const llm = ctx.get('llm')
      const providers = llm?.listProviders?.()
      if (Array.isArray(providers)) {
        for (const provider of providers) {
          if (typeof provider?.id !== 'string') continue
          const label = typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id
          names.set(provider.id, label)
        }
      }
    } catch {
      // No LLM directory in this deployment: ids stand in for names.
    }
    providerNames = names
    return names
  }

  /**
   * Build (or reuse) the payload the settings page renders.
   *
   * The heavy aggregation is memoized, but the two volatile status fields are
   * re-read on every call so a finished scan stops the page's polling promptly
   * instead of waiting out the TTL.
   * @returns a detached, JSON-safe summary.
   */
  function summary() {
    const records = store.snapshot()
    const now = Date.now()
    const status = { scanning: store.scanning, ledger: { records: store.size, lastScanAt: store.lastScanAt } }
    if (summaryCache !== undefined && summaryCache.count === records.length && now - summaryCache.at < SUMMARY_TTL_MS) {
      const cached = summaryCache.value
      cached.scanning = status.scanning
      cached.ledger = status.ledger
      return cached
    }
    const value = buildSummary(records)
    const names = readProviderNames()
    for (const provider of value.providers) {
      provider.name = names.get(provider.id) ?? prettifyId(provider.id)
    }
    value.scanning = status.scanning
    value.ledger = status.ledger
    summaryCache = { at: now, count: records.length, value }
    return value
  }

  /**
   * Write one JSON response.
   * @param res - node:http response.
   * @param status - HTTP status code.
   * @param body - JSON-serializable payload.
   */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      // The page polls this route; a cached copy would freeze the numbers.
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  /**
   * Serve one request under this plugin's prefix.
   * @param req - node:http request.
   * @param res - node:http response.
   */
  async function handle(req, res) {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = path.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (route === '/summary' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (store.size === 0 && !store.scanning) void store.backfill()
        sendJson(res, 200, { ok: true, ...summary() })
        return
      }
      if (route === '/rescan' && req.method === 'POST') {
        summaryCache = undefined
        const added = await store.backfill({ force: true })
        sendJson(res, 200, { ok: true, added, ...summary() })
        return
      }
      if (route === '/status' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          records: store.size,
          scanning: store.scanning,
          lastScanAt: store.lastScanAt,
          ledgerPath: store.ledgerPath,
          sessionsRoot: store.sessionsRoot,
        })
        return
      }
      sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${path}` })
    } catch (error) {
      ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void handle(req, res) }),
    'dsh-token-usage: routes',
  )
}
