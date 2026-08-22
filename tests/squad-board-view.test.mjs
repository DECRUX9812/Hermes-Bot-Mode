import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function runtime() {
  const atom = value => ({ get: () => value, set: () => undefined, listen: () => () => undefined })
  const jsx = (type, props = {}) => ({ type, props })
  const context = {
    atom,
    jsx,
    jsxs: jsx,
    useQuery: () => ({}),
    useValue: value => (value?.get ? value.get() : value),
    useState: value => [value, () => undefined],
    useRef: value => ({ current: value }),
    useEffect: () => undefined,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    Button: 'Button',
    Badge: 'Badge',
    BotFace: 'BotFace',
    StatusDot: 'StatusDot',
    Codicon: 'Codicon',
    GlyphSpinner: 'GlyphSpinner',
    EditProfileDialog: 'EditProfileDialog',
    profileColor: () => '#000',
    PALETTE_AREA: 'palette',
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar.nav',
    COMPOSER_AREAS: { middleware: 'middleware' },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => undefined } },
    host: {
      state: {
        profile: { get: () => 'ops', listen: () => undefined },
        gateway: { get: () => 'open', listen: () => undefined }
      },
      request: () => Promise.resolve({}),
      notify: () => undefined
    }
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
  vm.runInNewContext(code, context)
  return context
}

function registeredItems() {
  const r = runtime()
  const entries = []
  r.plugin.register({
    register: item => entries.push(item),
    storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() }
  })
  return entries
}

test('registration: Squad Board is registered under ROUTES_AREA and SIDEBAR_NAV_AREA', () => {
  const registrations = registeredItems()
  
  const boardRoute = registrations.find(r => r.area === 'routes' && r.data?.path === '/board')
  assert.ok(boardRoute, 'has /board route registered')

  const boardNav = registrations.find(r => r.area === 'sidebar.nav' && r.data?.path === '/board')
  assert.ok(boardNav, 'has sidebar navigation entry for board')
  assert.equal(boardNav.data.label, 'Squad Board')
})
