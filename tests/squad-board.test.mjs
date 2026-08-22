import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Load plugin.js in a bare vm realm and expose the board helper functions. */
function runtime() {
  const atom = value => {
    let current = value
    const listeners = new Set()
    return {
      get: () => current,
      set: next => {
        current = next
        listeners.forEach(fn => fn(current))
      },
      listen: fn => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    }
  }

  const context = {
    atom,
    computed: (atoms, fn) => ({ get: () => fn(...atoms.map(a => a.get())) }),
    jsx: (type, props = {}) => ({ type, props }),
    jsxs: (type, props = {}) => ({ type, props }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useQuery: () => ({}),
    useValue: value => (value?.get ? value.get() : value),
    useState: value => [value, () => undefined],
    useRef: value => ({ current: value }),
    useEffect: () => undefined,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    document: {
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: () => undefined }
    },
    host: {
      state: {
        gateway: atom('open'),
        profile: atom('ops')
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
    .concat(
      '\nglobalThis.__deriveWorkstreamTasks = deriveWorkstreamTasks;' +
      'globalThis.__extractDeliverable = extractDeliverable;' +
      'globalThis.__filterBoardTasks = filterBoardTasks;'
    )

  vm.runInNewContext(code, context)
  return context
}

test('deriveWorkstreamTasks: categorizes sessions into 4 board columns', () => {
  const r = runtime()
  const nowSec = 1786778000
  const roster = [
    { name: 'trader', last_session: { id: 's1', preview: 'AAPL scan done — 1 pick found', last_active: nowSec - 300 } },
    { name: 'ops', last_session: { id: 's2', preview: 'Backing up Proxmox VM...', last_active: nowSec - 10 } },
    { name: 'researcher', last_session: { id: 's3', preview: 'Message from 🤖 manager (@manager): review needed', last_active: nowSec - 500 } }
  ]

  const unread = { researcher: true }
  const activeProfile = 'ops'
  const isBusy = true

  const board = r.__deriveWorkstreamTasks(roster, unread, activeProfile, isBusy, nowSec)

  assert.ok(board.inbox, 'has inbox column')
  assert.ok(board.in_progress, 'has in_progress column')
  assert.ok(board.needs_review, 'has needs_review column')
  assert.ok(board.completed, 'has completed column')

  // Ops is active profile and gateway is busy -> in_progress
  assert.ok(board.in_progress.some(t => t.botName === 'ops'))

  // Researcher has unread handoff -> needs_review
  assert.ok(board.needs_review.some(t => t.botName === 'researcher'))

  // Trader finished earlier -> completed
  assert.ok(board.completed.some(t => t.botName === 'trader'))
})

test('extractDeliverable: detects report, code diff, and signal deliverables', () => {
  const r = runtime()
  
  const reportDeliv = r.__extractDeliverable({
    title: 'Market Analysis',
    preview: 'Full analysis report written to ~/report.md with 5 key findings.'
  })
  assert.equal(reportDeliv.kind, 'report')
  assert.equal(reportDeliv.icon, 'file-text')

  const codeDeliv = r.__extractDeliverable({
    title: 'Refactor Auth',
    preview: 'Modified 3 files: plugin.js, server.py. All tests pass.'
  })
  assert.equal(codeDeliv.kind, 'code')
  assert.equal(codeDeliv.icon, 'diff')

  const tradeDeliv = r.__extractDeliverable({
    title: 'Premarket Scan',
    preview: 'Pick: TSLA at $210 with target $225 and stop $205.'
  })
  assert.equal(tradeDeliv.kind, 'signal')
  assert.equal(tradeDeliv.icon, 'graph')
})

test('filterBoardTasks: filters board tasks by selected bot handle or search query', () => {
  const r = runtime()
  const tasks = [
    { id: '1', botName: 'trader', title: 'AAPL Options', preview: 'Scan complete' },
    { id: '2', botName: 'researcher', title: 'EUV Lithography', preview: 'Paper review' },
    { id: '3', botName: 'ops', title: 'Proxmox Backup', preview: 'Backup verified' }
  ]

  const byBot = r.__filterBoardTasks(tasks, 'trader', '')
  assert.equal(byBot.length, 1)
  assert.equal(byBot[0].botName, 'trader')

  const byQuery = r.__filterBoardTasks(tasks, 'all', 'Lithography')
  assert.equal(byQuery.length, 1)
  assert.equal(byQuery[0].botName, 'researcher')
})
