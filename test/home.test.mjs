/**
 * Unit tests for harness-home resolution.
 *
 * The host half reads a deployment's ledger and session logs, so picking the
 * wrong home silently reports another harness's usage. These cases pin the
 * precedence: the harness's own `dshHomePath` service, `$DSH_HOME`, the shipped
 * default `~/.dsh`, then the legacy Electron home — with a real `sessions`
 * directory deciding between candidates.
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { homeCandidates, resolveHarnessHome } from '../lib/index.js'

/** The shipped default home, `~/.dsh`. */
const DEFAULT_HOME = join(homedir(), '.dsh')
/** The legacy Electron home. */
const ELECTRON_HOME = join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')

/** An `existsSync` stub: only the listed homes own a `sessions` directory. */
function sessionsIn(...homes) {
  const present = new Set(homes.map((home) => join(home, 'sessions')))
  return (path) => present.has(path)
}

afterEach(() => {
  delete process.env.DSH_HOME
})

test('the first candidate owning a sessions directory wins', () => {
  assert.equal(
    resolveHarnessHome(['/a', '/b', '/c'], sessionsIn('/b', '/c')),
    '/b',
  )
})

test('a candidate with no sessions directory loses to a later one that has it', () => {
  assert.equal(resolveHarnessHome(['/fresh', '/live'], sessionsIn('/live')), '/live')
})

test('with no sessions directory anywhere the first candidate stands', () => {
  assert.equal(resolveHarnessHome(['/first', '/second'], sessionsIn()), '/first')
})

test('blank and non-string candidates are skipped', () => {
  assert.equal(resolveHarnessHome([undefined, '', '   ', null, '/real'], sessionsIn('/real')), '/real')
})

test('an empty candidate list falls back to the legacy harness home', () => {
  assert.equal(resolveHarnessHome([], sessionsIn()), ELECTRON_HOME)
})

test('the harness home service outranks the environment and the defaults', () => {
  process.env.DSH_HOME = '/from-env'
  const ctx = { get: (name) => (name === 'dshHomePath' ? () => '/from-service' : undefined) }
  assert.deepEqual(homeCandidates(ctx), ['/from-service', '/from-env', DEFAULT_HOME, ELECTRON_HOME])
})

test('without the service the environment still outranks the defaults', () => {
  process.env.DSH_HOME = '/from-env'
  assert.deepEqual(homeCandidates({ get: () => undefined }), ['/from-env', DEFAULT_HOME, ELECTRON_HOME])
})

test('a blank $DSH_HOME is ignored, and a missing context cannot break the load', () => {
  process.env.DSH_HOME = '   '
  assert.deepEqual(homeCandidates(undefined), [DEFAULT_HOME, ELECTRON_HOME])
  delete process.env.DSH_HOME
  assert.deepEqual(homeCandidates({}), [DEFAULT_HOME, ELECTRON_HOME])
})

test('a throwing service read falls back instead of failing the plugin', () => {
  const ctx = {
    get: () => {
      throw new Error('service unavailable')
    },
  }
  assert.deepEqual(homeCandidates(ctx), [DEFAULT_HOME, ELECTRON_HOME])
})

test('the new deployment wins over the legacy Electron home once it has sessions', () => {
  assert.equal(resolveHarnessHome(homeCandidates({}), sessionsIn(DEFAULT_HOME)), DEFAULT_HOME)
})
