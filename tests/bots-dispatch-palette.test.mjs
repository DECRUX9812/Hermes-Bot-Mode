import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Load plugin.js in a bare vm realm (same harness as pane-registration /
 *  roster-preview tests) and expose the pure palette builder. */
function runtime() {
  const atom = value => ({ get: () => value, set: () => undefined })
  const jsx = (type, props = {}) => ({ type, props })
  const context = {
    atom,
    jsx,
    jsxs: jsx,
    useQuery: () => ({}),
    useValue: value => (value?.get ? value.get() : value),
    useState: value => [value, () => undefined],
    haptic: () => undefined,
    Codicon: props => props ?? {},
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => undefined } },
    host: { state: { profile: { get: () => 'ops', listen: () => undefined } }, request: () => undefined }
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat('\nglobalThis.__botPaletteActions = botPaletteActions;')
  vm.runInNewContext(code, context)
  return context
}

test('palette: generates one quick-dispatch action per active bot in the roster', () => {
  const r = runtime()
  const roster = [{ name: 'trader' }, { name: 'researcher' }, { name: 'ops' }]
  const actions = r.__botPaletteActions(roster)
  assert.equal(actions.length, 3)
  assert.equal(actions[0].id, 'dispatch.trader')
  assert.equal(actions[0].label, 'Ask @trader…')
  assert.ok(Array.isArray(actions[0].keywords), 'keywords must be an array')
  assert.equal(typeof actions[0].run, 'function', 'run must be a handler')
  assert.equal(actions[2].id, 'dispatch.ops')
  assert.equal(actions[2].label, 'Ask @ops…')
})

test('palette: primary profile dispatches under its @hermes handle', () => {
  const r = runtime()
  const actions = r.__botPaletteActions([{ name: 'default' }])
  assert.equal(actions[0].id, 'dispatch.default')
  assert.equal(actions[0].label, 'Ask @hermes…')
  assert.ok(actions[0].keywords.includes('@hermes'))
})

test('palette: keywords cover the handle, dispatch verb, and bot identity', () => {
  const r = runtime()
  const [action] = r.__botPaletteActions([{ name: 'trader' }])
  for (const kw of ['@trader', 'trader', 'dispatch', 'ask', 'bot']) {
    assert.ok(action.keywords.includes(kw), `keywords should include "${kw}"`)
  }
})

test('palette: empty or garbage roster yields no actions', () => {
  const r = runtime()
  // vm-realm arrays aren't reference-equal to host literals — assert length.
  assert.equal(r.__botPaletteActions([]).length, 0)
  assert.equal(r.__botPaletteActions(null).length, 0)
  assert.equal(r.__botPaletteActions(undefined).length, 0)
  assert.equal(r.__botPaletteActions([{ nope: 'x' }]).length, 0)
})

test('palette: run handler opens the bot canonical chat without throwing', () => {
  const r = runtime()
  const [action] = r.__botPaletteActions([{ name: 'trader' }])
  assert.doesNotThrow(() => action.run())
})
