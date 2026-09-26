/**
 * Smoke test for the browser half.
 *
 * The bundle is a module-loader CJS registration, so it can be loaded in plain
 * Node by providing the two globals it reaches for: `window.__ModuleLoader__`
 * and a `require` that answers from the frozen platform table. React is replaced
 * by a shim that records elements instead of rendering them, which lets the test
 * call the registered section component directly and walk the element tree it
 * returns — the same tree the slot renderer would mount.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PLUGIN_ID = 'dsh-token-usage'

/** A React shim: elements are plain objects, hooks are inert but ordered. */
function createReact() {
  const state = { overrides: new Map(), calls: 0 }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      state.calls += 1
      const override = state.overrides.get(state.calls)
      return [override === undefined ? (typeof initial === 'function' ? initial() : initial) : override, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    Fragment: 'Fragment',
  }
  return { React, state }
}

/** Load the bundle and capture what it registered. */
function loadBundle() {
  const captured = { registrations: [], effects: [], localeRegistrations: [], injections: [] }
  const { React, state } = createReact()
  const requireShim = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require("${id}")`)
  }
  let registration
  const windowShim = { __ModuleLoader__: { load: (value) => { registration = value } } }
  // The bundle is a module-loader CJS registration rather than an ESM module, so
  // it is evaluated with the two globals it reaches for and then asked for its
  // factory result — exactly what the client module system does at boot.
  const evaluate = new Function('window', 'require', 'module', 'exports', 'fetch', readFileSync(CLIENT_PATH, 'utf8'))
  evaluate(windowShim, requireShim, { exports: {} }, {}, () => Promise.reject(new Error('offline')))
  assert.ok(registration !== undefined, 'the bundle registered nothing with window.__ModuleLoader__')
  const plugin = registration.factory(requireShim)
  return { plugin, registration, captured, state, React }
}

/** The context a browser plugin receives, recording every registration. */
function createContext(captured) {
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (callback, label) => {
      const disposer = callback()
      captured.effects.push({ label, disposer })
      return () => {}
    },
    locale: {
      register: (ns, dicts) => {
        captured.localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (key, callback) => {
        captured.injections.push(key)
        return callback()
      },
      register: (options, component) => {
        captured.registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return ctx
}

/** A summary payload shaped exactly like the host route's answer. */
function payload() {
  const today = new Date()
  const pad = (value) => (value < 10 ? `0${value}` : String(value))
  const key = (offset) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - offset * 86400000)
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  const window = (total) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total, requests: 1 })
  const days = []
  for (let offset = 370; offset >= 0; offset -= 1) days.push({ date: key(offset), total: offset % 7 === 0 ? offset * 10 : 0, input: 0, output: 0, cacheRead: 0, requests: 1 })
  return {
    ok: true,
    timeZone: 'Asia/Shanghai',
    today: key(0),
    firstDay: key(370),
    records: 2,
    scanning: false,
    calendar: { start: key(370), end: key(0), max: 3700, activeDays: 53, days },
    totals: { today: window(100), d7: window(400), d30: window(900), all: window(5000) },
    providers: [
      {
        id: 'command-code',
        name: 'Command Code',
        windows: { today: window(90), d7: window(300), d30: window(700), all: window(4000) },
        models: [
          {
            id: 'zai-org/GLM-5.3',
            name: '',
            windows: { today: window(90), d7: window(300), d30: window(700), all: window(4000) },
          },
        ],
      },
      {
        id: 'unknown',
        name: '',
        windows: { today: window(10), d7: window(100), d30: window(200), all: window(1000) },
        models: [{ id: 'unknown', name: '', windows: { today: window(10), d7: window(100), d30: window(200), all: window(1000) } }],
      },
    ],
  }
}

/**
 * Expand one element: a component element renders itself, host output is
 * walked as it stands. The cards below the section are components, so a tree
 * is only readable once they have rendered.
 * @param node - element or host output.
 * @returns the rendered tree.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    const { type, props, children } = node
    return expand(type({ ...props, children: children.length > 0 ? children : undefined }))
  }
  return { ...node, children: (node.children ?? []).map(expand) }
}

/** Collect every element of one type in the tree. */
function findAll(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  for (const child of node.children ?? []) findAll(child, type, found)
  return found
}

/** Read the concatenated text of a subtree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

test('the bundle registers one module-loader factory under the plugin id', () => {
  const { plugin, registration } = loadBundle()
  assert.equal(registration.id, PLUGIN_ID)
  assert.equal(typeof registration.factory, 'function')
  assert.equal(plugin.name, PLUGIN_ID)
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers dictionaries and one settings section', () => {
  const { plugin, captured } = loadBundle()
  plugin.apply(createContext(captured))
  assert.equal(captured.localeRegistrations.length, 1)
  assert.equal(captured.localeRegistrations[0].ns, 'settings.tokenUsage')
  assert.ok(captured.localeRegistrations[0].dicts.zh.title.length > 0)
  assert.ok(captured.localeRegistrations[0].dicts.en.title.length > 0)
  assert.deepEqual(captured.injections, ['settings.section'])
  assert.equal(captured.registrations.length, 1)
  const { options } = captured.registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'token-usage')
  assert.equal(options.locale, 'settings.tokenUsage')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof options.order, 'number')
})

test('a duplicate dictionary registration does not fail the mount', () => {
  const { plugin, captured } = loadBundle()
  const ctx = createContext(captured)
  ctx.locale.register = () => {
    throw new Error('already has locale "zh"')
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(captured.registrations.length, 1)
})

test('the section renders the hero, the calendar and the provider groups', () => {
  const { plugin, captured, state } = loadBundle()
  plugin.apply(createContext(captured))
  const component = captured.registrations[0].component
  // The third useState in this tree is the fetch state; hand it a ready payload
  // so the component renders its real body instead of the loading placeholder.
  state.overrides.set(3, { phase: 'ready', data: payload(), error: '' })
  const tree = expand(component({ t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`) }))

  const text = textOf(tree)
  assert.ok(text.includes('title'), 'hero title')
  assert.ok(text.includes('900'), 'the default 30-day window drives the hero')
  assert.ok(text.includes('Command Code'), 'provider display name')
  assert.ok(text.includes('zai-org/GLM-5.3'), 'model id')
  assert.ok(text.includes('other'), 'the synthetic unknown provider is localized')
  assert.ok(text.includes('Asia/Shanghai'), 'time zone caption')
  assert.ok(
    findAll(tree, 'span').some((node) => typeof node.props.title === 'string' && node.props.title.includes('4,000')),
    'the exact all-time total of a model stays available as a tooltip',
  )

  const cells = findAll(tree, 'span').filter((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dtu-cell'))
  assert.equal(cells.length % 7, 0, 'the grid is a whole number of weeks')
  const realDays = cells.filter((node) => node.props['data-pad'] !== 'true')
  assert.equal(realDays.length, 182, 'a 6-month range shows 182 days')
  assert.equal(realDays.filter((node) => node.props['data-today'] === 'true').length, 1, 'exactly one cell is marked as today')
  const levels = new Set(realDays.map((node) => node.props['data-level']))
  assert.ok(levels.has('4'), 'the peak day reaches the top heat level')

  const buttons = findAll(tree, 'button')
  assert.equal(buttons.filter((node) => node.props.role === 'tab').length, 4, 'four hero windows')
  assert.ok(buttons.some((node) => textOf(node) === 'rescan'), 'a rescan action')
})

test('the section renders a placeholder while the first request is in flight', () => {
  const { plugin, captured } = loadBundle()
  plugin.apply(createContext(captured))
  const component = captured.registrations[0].component
  const tree = expand(component({ t: (key) => key }))
  assert.ok(textOf(tree).includes('loading'))
})

test('the section renders an empty state for a ledger with no records', () => {
  const { plugin, captured, state } = loadBundle()
  plugin.apply(createContext(captured))
  const component = captured.registrations[0].component
  const data = payload()
  data.records = 0
  data.providers = []
  data.totals = { today: { total: 0, requests: 0 }, d7: { total: 0, requests: 0 }, d30: { total: 0, requests: 0 }, all: { total: 0, requests: 0 } }
  data.firstDay = null
  data.calendar.days = data.calendar.days.map((day) => ({ ...day, total: 0 }))
  state.overrides.set(3, { phase: 'ready', data, error: '' })
  const tree = expand(component({ t: (key) => key }))
  assert.ok(textOf(tree).includes('noData'))
  const painted = findAll(tree, 'span').filter(
    (node) => node.props.className === 'dtu-cell' && node.props['data-pad'] !== 'true' && node.props['data-level'] !== '0',
  )
  assert.equal(painted.length, 0, 'a ledger of zeros paints no heat at all')
})

test('a failed request keeps the retry affordance', () => {
  const { plugin, captured, state } = loadBundle()
  plugin.apply(createContext(captured))
  const component = captured.registrations[0].component
  state.overrides.set(3, { phase: 'failed', data: undefined, error: 'HTTP 500' })
  const tree = expand(component({ t: (key) => key }))
  const text = textOf(tree)
  assert.ok(text.includes('failed'))
  assert.ok(text.includes('HTTP 500'))
  assert.ok(findAll(tree, 'button').some((node) => textOf(node) === 'retry'))
})


/**
 * A React-shaped hook dispatcher, strict enough to enforce React's own hook
 * rule: every render of one component must use the same hooks in the same
 * order. The page crashed in the browser with React error #310 because the
 * section called a card that owns hooks as a plain function, so those hooks
 * landed on the section's list — and only on the renders where the fetch had
 * already answered. A single-render smoke test cannot see that.
 */
function createStrictReact() {
  const rendered = new Map()
  let current = null
  const stack = []
  const enter = (name) => {
    current = { name, count: 0 }
    stack.push(current)
  }
  const exit = () => {
    const finished = stack.pop()
    const previous = rendered.get(finished.name)
    if (previous !== undefined && previous !== finished.count) {
      throw new Error(
        `React error #310: "${finished.name}" used ${finished.count} hooks, but its previous render used ${previous}`,
      )
    }
    rendered.set(finished.name, finished.count)
    current = stack[stack.length - 1] ?? null
  }
  const hook = (kind) => (...args) => {
    if (current === null) throw new Error(`React error #321: ${kind} called outside a render`)
    current.count += 1
    if (kind === 'useState') return [typeof args[0] === 'function' ? args[0]() : args[0], () => {}]
    if (kind === 'useRef') return { current: args[0] === undefined ? null : args[0] }
    if (kind === 'useCallback') return args[0]
    return undefined
  }
  /**
   * Render one element the way React does: a function element is a component
   * with a hook list of its own, anything else is host output to walk.
   * @param element - element tree returned by a component.
   * @returns the same tree with every nested component rendered.
   */
  const render = (element) => {
    if (element === null || element === undefined || typeof element !== 'object') return element
    if (Array.isArray(element)) return element.map(render)
    const { type, props, children } = element
    if (typeof type === 'function') {
      const name = type.name === '' ? 'anonymous' : type.name
      enter(name)
      let produced
      try {
        produced = type({ ...props, children: children.length > 0 ? children : undefined })
      } finally {
        exit()
      }
      return render(produced)
    }
    return { ...element, children: children.map(render) }
  }
  return {
    React: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
      useState: hook('useState'),
      useEffect: hook('useEffect'),
      useCallback: hook('useCallback'),
      useRef: hook('useRef'),
      Fragment: 'Fragment',
    },
    render,
  }
}

/** A summary payload with a ledger that holds nothing yet. */
function emptyPayload() {
  const data = payload()
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0 }
  data.records = 0
  data.providers = []
  data.totals = { today: zero, d7: zero, d30: zero, all: zero }
  data.firstDay = null
  data.calendar = { ...data.calendar, max: 0, activeDays: 0, days: data.calendar.days.map((day) => ({ ...day, total: 0 })) }
  return data
}

/**
 * Mount the section and render it three times: a ledger with usage, an empty
 * ledger, then usage again — the reload, first-run and rescan sequence a
 * settings page actually walks through.
 *
 * The fetch state is the third hook this tree calls, so it is swapped through
 * the module's own `useState`: every pass renders the same mounted component,
 * which is what makes React's hook bookkeeping apply at all.
 * @param states - fetch states to render, in order.
 * @returns the last tree and its concatenated text.
 */
function renderSequence(states) {
  const { React, render } = createStrictReact()
  const captured = { effects: [], localeRegistrations: [], injections: [], registrations: [] }
  const requireShim = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require("${id}")`)
  }
  let registration
  new Function('window', 'require', 'module', 'exports', 'fetch', readFileSync(CLIENT_PATH, 'utf8'))(
    { __ModuleLoader__: { load: (value) => { registration = value } } },
    requireShim,
    { exports: {} },
    {},
    () => Promise.reject(new Error('offline')),
  )
  const plugin = registration.factory(requireShim)
  const ctx = createContext(captured)
  ctx.locale.bind = () => (key) => key
  plugin.apply(ctx)
  const component = captured.registrations[0].component

  const original = React.useState
  const trees = []
  for (const state of states) {
    let call = 0
    React.useState = (initial) => {
      call += 1
      return call === 3 ? [state, () => {}] : original(initial)
    }
    try {
      trees.push(render(React.createElement(component, { t: (key) => key, close: () => {} })))
    } finally {
      React.useState = original
    }
  }
  const tree = trees[trees.length - 1]
  return { tree, text: textOf(tree), trees }
}

test('the section survives re-rendering after its data arrives', () => {
  // The browser's first render is the loading placeholder, so the sequence
  // starts there and ends with real data: same component, three renders.
  const { tree, text } = renderSequence([
    { phase: 'loading', data: undefined, error: '' },
    { phase: 'ready', data: payload(), error: '' },
    { phase: 'ready', data: emptyPayload(), error: '' },
  ])
  assert.ok(text.includes('noData'), 'the empty ledger renders its placeholder')
  const { tree: populated, text: populatedText } = renderSequence([
    { phase: 'loading', data: undefined, error: '' },
    { phase: 'ready', data: emptyPayload(), error: '' },
    { phase: 'ready', data: payload(), error: '' },
  ])
  assert.ok(populatedText.includes('900'), 'the populated ledger renders its numbers')
  assert.ok(textOf(populated).includes('Command Code'), 'and its provider names')
  assert.ok(tree !== undefined)
})

test('the calendar card mounts with its own hook list, not the section\u2019s', () => {
  // Guards the fix directly: a card called as a plain function would add its
  // hooks to the caller's list, and the strict dispatcher rejects that.
  const { tree } = renderSequence([
    { phase: 'ready', data: payload(), error: '' },
    { phase: 'ready', data: payload(), error: '' },
  ])
  const sections = findAll(tree, 'section')
  assert.ok(sections.length >= 2, 'the hero, calendar and provider cards are mounted')
  assert.ok(findAll(tree, 'button').some((node) => textOf(node) === 'rescan'))
})
