import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Load plugin.js in a bare vm realm (same harness as roster-preview /
 *  canonical-chat-pin tests) and expose the pure matrix builder. */
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
    host: { state: { profile: { get: () => 'ops', listen: () => undefined } }, request: () => undefined }
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat('\nglobalThis.__buildHandoffMatrix = buildHandoffMatrix;')
  vm.runInNewContext(code, context)
  return context
}

// Objects created inside the vm realm carry that realm's prototypes, so
// normalize through JSON before deep-comparing against host literals.
const norm = value => JSON.parse(JSON.stringify(value))

test('fleetMatrix: aggregates bot-to-bot handoff volume and status matrix', () => {
  const r = runtime()
  const handoffs = [
    { from: 'manager', to: 'ops', status: 'replied' },
    { from: 'ops', to: 'teknium', status: 'awaiting_reply' }
  ]
  const matrix = r.__buildHandoffMatrix(handoffs, [])
  assert.equal(matrix.totalFlows, 2)
  assert.equal(matrix.pendingReplies, 1)
})

test('fleetMatrix: activePairs counts distinct directed pairs, not rows', () => {
  const r = runtime()
  const handoffs = [
    { from: 'manager', to: 'ops', status: 'replied' },
    { from: 'manager', to: 'ops', status: 'awaiting_reply' },
    { from: 'ops', to: 'teknium', status: 'awaiting_reply' }
  ]
  const matrix = r.__buildHandoffMatrix(handoffs, [])
  assert.equal(matrix.activePairs, 2)
})

test('fleetMatrix: flowVolumeByBot tallies sent and received per bot', () => {
  const r = runtime()
  const handoffs = [
    { from: 'manager', to: 'ops', status: 'replied' },
    { from: 'ops', to: 'teknium', status: 'awaiting_reply' }
  ]
  const matrix = r.__buildHandoffMatrix(handoffs, [])
  assert.deepEqual(norm(matrix.flowVolumeByBot.manager), { sent: 1, received: 0 })
  assert.deepEqual(norm(matrix.flowVolumeByBot.ops), { sent: 1, received: 1 })
  assert.deepEqual(norm(matrix.flowVolumeByBot.teknium), { sent: 0, received: 1 })
})

test('fleetMatrix: roster-only bots appear as zero-volume nodes for layout', () => {
  const r = runtime()
  const roster = [{ name: 'manager' }, { name: 'scribe' }]
  const handoffs = [{ from: 'manager', to: 'scribe', status: 'replied' }]
  const matrix = r.__buildHandoffMatrix(handoffs, roster)
  assert.deepEqual(norm(matrix.flowVolumeByBot.scribe), { sent: 0, received: 1 })
})

test('fleetMatrix: connectionGraph merges roster and handoff names into nodes + links', () => {
  const r = runtime()
  const roster = [{ name: 'manager' }, { name: 'scribe' }, { name: 'fresh' }]
  const handoffs = [
    { from: 'manager', to: 'scribe', status: 'replied' },
    { from: 'manager', to: 'scribe', status: 'awaiting_reply' },
    { from: 'scribe', to: 'teknium', status: 'awaiting_reply' }
  ]
  const matrix = r.__buildHandoffMatrix(handoffs, roster)
  const graph = norm(matrix.connectionGraph)

  // Every roster bot AND every handoff participant gets a node.
  const nodeIds = graph.nodes.map(node => node.id).sort()
  assert.deepEqual(nodeIds, ['fresh', 'manager', 'scribe', 'teknium'])

  // Nodes carry their volume so the renderer needs no second lookup.
  const scribeNode = graph.nodes.find(node => node.id === 'scribe')
  assert.equal(scribeNode.sent, 1)
  assert.equal(scribeNode.received, 2)
  const freshNode = graph.nodes.find(node => node.id === 'fresh')
  assert.equal(freshNode.sent, 0)
  assert.equal(freshNode.received, 0)

  // Links are per directed pair, with flow + pending counts.
  assert.equal(graph.links.length, 2)
  const managerToScribe = graph.links.find(link => link.from === 'manager' && link.to === 'scribe')
  assert.equal(managerToScribe.flows, 2)
  assert.equal(managerToScribe.pending, 1)
  const scribeToTeknium = graph.links.find(link => link.from === 'scribe' && link.to === 'teknium')
  assert.equal(scribeToTeknium.flows, 1)
  assert.equal(scribeToTeknium.pending, 1)
})

test('fleetMatrix: empty or garbage input degrades to a zero matrix', () => {
  const r = runtime()

  const empty = r.__buildHandoffMatrix([], [])
  assert.equal(empty.totalFlows, 0)
  assert.equal(empty.pendingReplies, 0)
  assert.equal(empty.activePairs, 0)
  assert.deepEqual(norm(empty.flowVolumeByBot), {})
  assert.deepEqual(norm(empty.connectionGraph), { nodes: [], links: [] })

  // Entries without a from/to pair are not flows; unknown status is not pending.
  const dirty = r.__buildHandoffMatrix(
    [
      { from: 'manager', to: 'ops', status: 'awaiting_reply' },
      { from: null, to: 'ops', status: 'awaiting_reply' },
      { from: 'ops', to: undefined, status: 'replied' },
      { from: 'scribe', to: 'ops', status: 'weird' }
    ],
    []
  )
  assert.equal(dirty.totalFlows, 2)
  assert.equal(dirty.pendingReplies, 1)
  assert.equal(dirty.activePairs, 2)
})

test('fleetMatrix: tolerates undefined roster and non-array handoffs', () => {
  const r = runtime()
  const matrix = r.__buildHandoffMatrix(undefined, undefined)
  assert.equal(matrix.totalFlows, 0)
  assert.equal(matrix.pendingReplies, 0)
  assert.equal(matrix.activePairs, 0)
  assert.deepEqual(norm(matrix.connectionGraph), { nodes: [], links: [] })
})
