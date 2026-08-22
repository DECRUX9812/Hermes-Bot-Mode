import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

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
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => undefined } },
    host: { state: { profile: { get: () => 'ops', listen: () => undefined } }, request: () => undefined },
    // SDK surface used by the ToolPill component (Codicon renders a span in-app).
    Codicon: props => props ?? {}
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat(
      '\nglobalThis.__formatToolSummary = formatToolSummary;' +
        '\nglobalThis.__formatToolDuration = formatToolDuration;' +
        '\nglobalThis.__StatusDot = StatusDot;' +
        '\nglobalThis.__ToolPill = ToolPill;'
    )
  vm.runInNewContext(code, context)
  return context
}

test('formatToolSummary: terminal shows command, codicon, and tenths duration', () => {
  const r = runtime()
  const summary = r.__formatToolSummary('terminal', { command: 'git status -s' }, 0.24)
  assert.equal(summary.icon, 'terminal')
  assert.equal(summary.label, 'terminal: git status -s')
  assert.equal(summary.duration, '0.2s')
})

test('formatToolSummary: file tools (read_file, write_file, patch) carry their path', () => {
  const r = runtime()
  const read = r.__formatToolSummary('read_file', { path: 'plugin.js' }, 1.53)
  assert.equal(read.icon, 'file-code')
  assert.equal(read.label, 'read_file: plugin.js')
  assert.equal(read.duration, '1.5s')

  const write = r.__formatToolSummary('write_file', { path: 'tests/tool-pill-rendering.test.mjs' }, 3)
  assert.equal(write.icon, 'file-add')
  assert.equal(write.label, 'write_file: tests/tool-pill-rendering.test.mjs')

  const patch = r.__formatToolSummary('patch', { path: 'plugin.js' }, 0.5)
  assert.equal(patch.icon, 'diff')
  assert.equal(patch.label, 'patch: plugin.js')
})

test('formatToolSummary: web_search and rag_query summarize by query', () => {
  const r = runtime()
  const web = r.__formatToolSummary('web_search', { query: 'hyperliquid funding' }, 2.4)
  assert.equal(web.icon, 'globe')
  assert.equal(web.label, 'web_search: hyperliquid funding')

  const rag = r.__formatToolSummary('rag_query', { query: 'session store' }, 8.25)
  assert.equal(rag.icon, 'database')
  assert.equal(rag.label, 'rag_query: session store')
})

test('formatToolSummary: unknown tools get the generic tools icon and fall back to first string arg', () => {
  const r = runtime()
  const summary = r.__formatToolSummary('delegate_task', { goal: 'review PR' }, 42)
  assert.equal(summary.icon, 'tools')
  assert.equal(summary.label, 'delegate_task: review PR')
})

test('formatToolSummary: missing or empty args degrades to an ellipsis, never crashes', () => {
  const r = runtime()
  assert.equal(r.__formatToolSummary('terminal').label, 'terminal: …')
  assert.equal(r.__formatToolSummary('read_file', {}).label, 'read_file: …')
  assert.equal(r.__formatToolSummary('read_file', null).label, 'read_file: …')
  assert.equal(r.__formatToolSummary('web_search', { query: '' }).label, 'web_search: …')
})

test('formatToolDuration: seconds, tenths, and minute bands', () => {
  const r = runtime()
  assert.equal(r.__formatToolDuration(undefined), '0s')
  assert.equal(r.__formatToolDuration(0), '0s')
  assert.equal(r.__formatToolDuration(0.24), '0.2s')
  assert.equal(r.__formatToolDuration(1.53), '1.5s')
  assert.equal(r.__formatToolDuration(12), '12s')
  assert.equal(r.__formatToolDuration(125), '2m 05s')
})

test('StatusDot: maps tone to a native-theme dot class', () => {
  const r = runtime()
  const success = r.__StatusDot({ tone: 'success' })
  assert.match(success.props.className, /bg-\(--ui-success\)/)
  assert.equal(success.props['data-tone'], 'success')

  const running = r.__StatusDot({ tone: 'running' })
  assert.match(running.props.className, /bg-\(--ui-accent\)/)
  assert.match(running.props.className, /animate-pulse/)

  const error = r.__StatusDot({ tone: 'error' })
  assert.match(error.props.className, /bg-\(--ui-danger\)/)
})

test('ToolPill: collapsed pill shows status dot, icon, label, duration, and chevron-right', () => {
  const r = runtime()
  const pill = r.__ToolPill({ toolName: 'terminal', args: { command: 'git status -s' }, duration: 0.24 })
  assert.equal(pill.type, 'div')
  assert.match(pill.props.className, /hermes-bots-tool-pill/)

  const header = pill.props.children[0]
  assert.equal(header.type, 'button')
  assert.equal(header.props.children[0].props.tone, 'success')
  assert.equal(header.props.children[1].props.name, 'terminal')
  assert.equal(header.props.children[2].props.children, 'terminal: git status -s')
  assert.equal(header.props.children[3].props.children, '0.2s')
  assert.equal(header.props.children[4].props.name, 'chevron-right')
  // Collapsed: no details block.
  assert.equal(pill.props.children[1], null)
})

test('ToolPill: running status pulses the dot; expanded shows raw args', () => {
  const r = runtime()
  const running = r.__ToolPill({ toolName: 'web_search', args: { query: 'x' }, duration: 1.2, status: 'running' })
  assert.equal(running.props.children[0].props.children[0].props.tone, 'running')

  const expanded = r.__ToolPill({
    toolName: 'read_file',
    args: { path: 'plugin.js' },
    duration: 0.4,
    expanded: true
  })
  const header = expanded.props.children[0]
  assert.equal(header.props.children[4].props.name, 'chevron-down')
  const details = expanded.props.children[1]
  assert.equal(details.type, 'div')
  assert.match(details.props.children, /plugin\.js/)
})
