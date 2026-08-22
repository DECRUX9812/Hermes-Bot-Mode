import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
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
    host: { state: { profile: { get: () => 'ops', listen: () => undefined } }, request: () => undefined }
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat(
      '\nglobalThis.__previewKind = previewKind;\nglobalThis.__generatedSessionTitle = generatedSessionTitle;\nglobalThis.__isGenericTitle = isGenericTitle;\nglobalThis.__rosterMatchesQuery = rosterMatchesQuery;\nglobalThis.__recentFleetActivity = recentFleetActivity;\nglobalThis.__recentHandoffs = recentHandoffs;\nglobalThis.__openLoopsByBot = openLoopsByBot;globalThis.__fleetSummary = fleetSummary;\nglobalThis.__needsYouOf = needsYouOf;\nglobalThis.__fleetDispatchCommand = fleetDispatchCommand;\nglobalThis.__rawChatCommand = rawChatCommand;\nglobalThis.__messagingProtocolSection = messagingProtocolSection;\nglobalThis.__fleetStatusOf = fleetStatusOf;\nglobalThis.__fleetEventKind = fleetEventKind;globalThis.__trackEntryOf = trackEntryOf;globalThis.__togglePinnedId = togglePinnedId;globalThis.__pinnedFirst = pinnedFirst;\nglobalThis.__fleetTimeline = fleetTimeline;\nglobalThis.__fleetSearchResults = fleetSearchResults;'
    )
  vm.runInNewContext(code, context)
  return context
}

// NOTE: objects created inside the vm realm carry that realm's Object
// prototype, so assert.deepEqual against host-realm literals fails on
// reference-equality. Compare fields explicitly.
function fromBotOf(preview) {
  return runtime().__previewKind(preview).fromBot
}

test('previewKind: a plain chat preview is a human exchange, not a DM', () => {
  assert.equal(fromBotOf('Can you check the vault sync?'), null)
})

test('previewKind: parses the current 🤖 delivery prefix and sender handle', () => {
  assert.equal(fromBotOf('Message from 🤖 manager (@manager): Learn-share: skill installed'), 'manager')
})

test('previewKind: parses the legacy agent-prefix shape', () => {
  assert.equal(fromBotOf("Message from agent 'researcher': here is the paper"), 'researcher')
})

test('previewKind: empty or absent preview is not a DM', () => {
  assert.equal(fromBotOf(''), null)
  assert.equal(fromBotOf(undefined), null)
})

test('isGenericTitle: auto-assigned titles are generic', () => {
  const r = runtime()
  assert.equal(r.__isGenericTitle('Bot Chat'), true)
  assert.equal(r.__isGenericTitle('New chat'), true)
  assert.equal(r.__isGenericTitle(''), true)
  assert.equal(r.__isGenericTitle('Weekly review planning'), false)
})

test('generatedSessionTitle: keeps a meaningful stored title', () => {
  const r = runtime()
  assert.equal(r.__generatedSessionTitle({ title: 'Weekly review' }, 'some preview'), 'Weekly review')
})

test('generatedSessionTitle: invents a label from the preview for generic titles', () => {
  const r = runtime()
  assert.equal(r.__generatedSessionTitle({ title: 'Bot Chat' }, 'The tailnet proxy binds 100.64.0.1'), 'The tailnet proxy binds 100.64.0.1')
})

test('generatedSessionTitle: strips the bot-to-bot prefix before generating', () => {
  const r = runtime()
  const out = r.__generatedSessionTitle({ title: '' }, 'Message from 🤖 manager (@manager): Learn-share: skill installed')
  assert.match(out, /Learn-share/)
  assert.doesNotMatch(out, /Message from/)
})

test('generatedSessionTitle: caps the generated label length', () => {
  const r = runtime()
  const out = r.__generatedSessionTitle({ title: '' }, 'this is a very long preview that goes on and on and on about something or other entirely')
  assert.ok(out.length <= 34, `expected <= 34 chars, got ${out.length}: ${out}`)
})

// ── render smoke: BotRow must paint the new row furniture without throwing ──

function renderRuntime() {
  const atom = value => ({ get: () => value, set: () => undefined })
  const jsx = (type, props = {}) => ({ type, props })
  const context = {
    atom,
    jsx,
    jsxs: jsx,
    cn: (...args) => args.filter(Boolean).join(' '),
    Button: 'Button',
    BotFace: 'BotFace',
    Codicon: 'Codicon',
    ContextMenu: 'ContextMenu',
    ContextMenuContent: 'ContextMenuContent',
    ContextMenuItem: 'ContextMenuItem',
    ContextMenuSeparator: 'ContextMenuSeparator',
    ContextMenuTrigger: 'ContextMenuTrigger',
    haptic: () => undefined,
    host: {
      state: {
        profile: { get: () => 'scribe', listen: () => undefined },
        gateway: { get: () => 'idle', listen: () => undefined }
      },
      request: () => Promise.resolve({ sessions: [] }),
      openSession: () => undefined,
      newChat: () => undefined,
      navigate: () => undefined
    },
    profileColor: () => '#8b5cf6',
    queryClient: { invalidateQueries: () => undefined },
    relativeTime: () => 'now',
    useQuery: () => ({}),
    useValue: value => (value?.get ? value.get() : value),
    useState: value => [value, () => undefined],
    useEffect: () => undefined,
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => undefined } }
  }
  const code = source
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat('\nglobalThis.__BotRow = BotRow;')
  vm.runInNewContext(code, context)
  return context
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') {
    if (node.props) return textOf(node.props.children ?? '')
    return Object.values(node).map(textOf).join(' ')
  }
  return ''
}

const DM_BOT = {
  name: 'scribe',
  title: 'Scribe',
  description: '',
  last_session: {
    id: 's1',
    title: 'Bot Chat',
    preview: 'Message from 🤖 manager (@manager): Learn-share: skill installed in your profile',
    last_active: Math.floor(Date.now() / 1000) - 5
  }
}

test('render: BotRow shows the sender badge, session chip, and stripped DM preview', () => {
  const r = renderRuntime()
  const tree = r.__BotRow({ bot: DM_BOT, onEdit: () => undefined })
  const text = textOf(tree)
  assert.match(text, /@manager/)
  assert.match(text, /Learn-share/)
  assert.doesNotMatch(text, /Message from/)
})

test('render: BotRow renders plain previews without a badge', () => {
  const r = renderRuntime()
  const tree = r.__BotRow({
    bot: { name: 'ops', title: 'Ops', description: '', last_session: { id: 's2', title: 'Weekly review', preview: 'All hosts are healthy', last_active: 1_700_000_000 } },
    onEdit: () => undefined
  })
  const text = textOf(tree)
  assert.match(text, /Weekly review/)
  assert.match(text, /All hosts are healthy/)
  assert.doesNotMatch(text, /@manager/)
})

test('render: BotRow tolerates a fresh bot with no sessions yet', () => {
  const r = renderRuntime()
  const tree = r.__BotRow({ bot: { name: 'newbie', title: '', description: 'Fresh bot' }, onEdit: () => undefined })
  const text = textOf(tree)
  assert.match(text, /Fresh bot/)
})

// ── roster search: pure filter over name / handle / title / description ─────

function matchOf(bot, meta, query) {
  return runtime().__rosterMatchesQuery(bot, meta, query)
}

test('rosterMatchesQuery: empty or whitespace query matches everything', () => {
  assert.equal(matchOf({ name: 'trader' }, null, ''), true)
  assert.equal(matchOf({ name: 'trader' }, null, '   '), true)
})

test('rosterMatchesQuery: matches profile name case-insensitively', () => {
  assert.equal(matchOf({ name: 'researcher' }, null, 'RESEARCH'), true)
  assert.equal(matchOf({ name: 'researcher' }, null, 'scribble'), false)
})

test('rosterMatchesQuery: matches the @handle (default presents as hermes)', () => {
  assert.equal(matchOf({ name: 'default' }, null, '@hermes'), true)
  assert.equal(matchOf({ name: 'default' }, null, '@default'), true)
  assert.equal(matchOf({ name: 'scribe' }, null, '@scribe'), true)
})

test('rosterMatchesQuery: matches display title and description', () => {
  assert.equal(matchOf({ name: 'trader', title: 'Trader' }, null, 'trader'), true)
  assert.equal(matchOf({ name: 'trader', description: 'Markets bot — premarket scans' }, null, 'premarket'), true)
})

test('rosterMatchesQuery: meta title (user-renamed) joins the haystack', () => {
  assert.equal(matchOf({ name: 'trader', title: 'Trader' }, { title: 'Quant' }, 'quant'), true)
})

// ── fleet activity: newest-first, capped, DM-attributed ─────────────────────

function activityOf(roster, limit) {
  return runtime().__recentFleetActivity(roster, limit)
}

const ACTIVE_ROSTER = [
  {
    name: 'scribe',
    last_session: { title: 'Bot Chat', preview: 'Message from 🤖 manager (@manager): Learn-share: skill installed', last_active: 100 }
  },
  { name: 'trader', last_session: { title: 'Premarket', preview: 'AAPL scan done', last_active: 200 } },
  { name: 'ops', last_session: { title: '', preview: 'Vault sync ok', last_active: 50 } },
  { name: 'fresh', description: 'no sessions yet' }
]

test('recentFleetActivity: newest message first, bots without sessions excluded', () => {
  const out = activityOf(ACTIVE_ROSTER)
  assert.deepEqual(out.map(e => e.bot.name), ['trader', 'scribe', 'ops'])
})

test('recentFleetActivity: caps at the limit', () => {
  const out = activityOf(ACTIVE_ROSTER, 2)
  assert.deepEqual(out.map(e => e.bot.name), ['trader', 'scribe'])
})

test('recentFleetActivity: attributes bot-to-bot previews to the sender', () => {
  const out = activityOf(ACTIVE_ROSTER)
  assert.equal(out.find(e => e.bot.name === 'scribe').fromBot, 'manager')
  assert.equal(out.find(e => e.bot.name === 'trader').fromBot, null)
})

test('recentFleetActivity: tolerates empty and null rosters', () => {
  assert.equal(activityOf([]).length, 0)
  assert.equal(activityOf(undefined).length, 0)
})

// ── handoff ledger: who threw what at whom, and whether they answered ───────

const HANDOFF_ROSTER = [
  {
    name: 'scribe',
    last_session: {
      title: 'Bot Chat',
      preview: 'Message from 🤖 manager (@manager): file the review',
      last_active: 100
    }
  },
  {
    name: 'manager',
    last_session: { title: 'Bot Chat', preview: 'Message from 🤖 scribe (@scribe): done — filed', last_active: 300 }
  },
  { name: 'trader', last_session: { title: 'Premarket', preview: 'AAPL scan done', last_active: 200 } },
  { name: 'fresh', description: 'no sessions yet' }
]

test('recentHandoffs: pairs a bot-to-bot send with the recipient reply', () => {
  const out = runtime().__recentHandoffs(HANDOFF_ROSTER)
  assert.equal(out.length, 1)
  assert.equal(out[0].from, 'manager')
  assert.equal(out[0].to, 'scribe')
  assert.equal(out[0].status, 'replied')
  assert.match(out[0].replyPreview, /done — filed/)
})

test('recentHandoffs: unanswered sends are awaiting_reply', () => {
  const out = runtime().__recentHandoffs([
    {
      name: 'scribe',
      last_session: { title: 'Bot Chat', preview: 'Message from 🤖 manager (@manager): urgent?', last_active: 100 }
    },
    { name: 'manager', last_session: { title: 'Weekly', preview: 'reviewing notes', last_active: 50 } }
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'awaiting_reply')
})

test('recentHandoffs: caps the list', () => {
  const out = runtime().__recentHandoffs(HANDOFF_ROSTER, 1)
  assert.equal(out.length, 1)
})

test('openLoopsByBot: counts only unanswered sends per sender', () => {
  const out = runtime().__openLoopsByBot([
    {
      name: 'scribe',
      last_session: { title: 'Bot Chat', preview: 'Message from 🤖 manager (@manager): do thing A', last_active: 100 }
    },
    { name: 'manager', last_session: { title: 'Bot Chat', preview: 'Message from 🤖 scribe (@scribe): did it', last_active: 300 } },
    {
      name: 'trader',
      last_session: { title: 'Bot Chat', preview: 'Message from 🤖 manager (@manager): do thing B', last_active: 90 }
    }
  ])
  // thing A was answered (scribe replied); thing B is still open.
  assert.equal(out.manager, 1)
  assert.equal(out.scribe, undefined)
})

test('needsYouOf: surfaces only unseen bot-to-bot replies', () => {
  const out = runtime().__needsYouOf(HANDOFF_ROSTER, { manager: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].bot.name, 'manager')
  assert.equal(out[0].from, 'scribe')
  assert.equal(out[0].kind, 'reply_to_relay')
})

test('needsYouOf: empty when everything is read', () => {
  assert.equal(runtime().__needsYouOf(HANDOFF_ROSTER, {}).length, 0)
})

// ── fleet summary: one-glance "what is happening" counts ───────────────────

const SUMMARY_ROSTER = [
  { name: 'scribe', last_session: { preview: 'Message from 🤖 manager (@manager): do thing A', last_active: 5 } },
  { name: 'trader', last_session: { preview: 'AAPL scan done', last_active: 200 } },
  { name: 'ops', last_session: { preview: 'vault sync ok', last_active: 400 } },
  { name: 'fresh', description: 'no sessions yet' }
]

function summaryOf(roster, meta, unread, active, busy, now) {
  return runtime().__fleetSummary(roster, meta, unread, active, busy, now)
}

test('fleetSummary: counts working only for the active profile while the gateway is busy', () => {
  assert.equal(summaryOf(SUMMARY_ROSTER, {}, {}, 'ops', true, 500).working, 1)
  assert.equal(summaryOf(SUMMARY_ROSTER, {}, {}, 'ops', false, 500).working, 0)
  assert.equal(summaryOf(SUMMARY_ROSTER, {}, {}, 'trader', true, 500).working, 1)
})

test('fleetSummary: counts unread and paused from meta', () => {
  const out = summaryOf(SUMMARY_ROSTER, { trader: { paused: true } }, { ops: true }, 'ops', false, 500)
  assert.equal(out.unread, 1)
  assert.equal(out.paused, 1)
})

test('fleetSummary: counts only bots that wrote within the 90s window as active', () => {
  const roster = [
    { name: 'a', last_session: { preview: 'x', last_active: 495 } }, // 5s before now → active
    { name: 'b', last_session: { preview: 'y', last_active: 400 } }, // 100s before now → not
    { name: 'c', last_session: { preview: 'z', last_active: 0 } } // ancient → not
  ]
  const out = summaryOf(roster, {}, {}, 'ops', false, 500)
  assert.equal(out.active, 1)
})

test('fleetSummary: needYou mirrors the needs-you inbox count', () => {
  const out = summaryOf(SUMMARY_ROSTER, {}, { scribe: true }, 'ops', false, 500)
  assert.equal(out.needYou, 1)
})

test('fleetSummary: tolerates empty roster and missing meta/unread', () => {
  const out = summaryOf([], null, null, 'ops', false, 100)
  assert.equal(out.working + out.unread + out.active + out.paused + out.needYou, 0)
})

// ── fleet dispatch: protocol commands and the SOUL protocol text ────────────

test('fleetDispatchCommand: wrapper command with sender attribution', () => {
  const r = runtime()
  const cmd = r.__fleetDispatchCommand('ops', 'scribe', 'check the vault')
  assert.match(cmd, /^fleet-dispatch send 'scribe'/)
  assert.match(cmd, /--as 'ops'$/)
  assert.match(cmd, /Message from 🤖 ops \(@ops\): check the vault/)
})

test('fleetDispatchCommand: POSIX single-quotes the payload so tricky messages and substitutions stay inert', () => {
  const r = runtime()
  const cmd = r.__fleetDispatchCommand('ops', 'scribe', 'say "$(whoami)" `echo inject` ${USER}')
  assert.match(cmd, /'Message from 🤖 ops \(@ops\): say "\$\(whoami\)" `echo inject` \$\{USER\}'/)
})

test('rawChatCommand: keeps the documented fallback shape', () => {
  const r = runtime()
  const cmd = r.__rawChatCommand('ops', 'scribe', 'hello')
  assert.match(cmd, /^hermes -p 'scribe' chat --in ~ -c "Bot Chat" -Q -q /)
  assert.match(cmd, /Message from 🤖 ops \(@ops\): hello/)
})

test('messagingProtocolSection: prefers fleet-dispatch, keeps the raw fallback', () => {
  const r = runtime()
  const section = r.__messagingProtocolSection('ops', [{ name: 'scribe', description: 'Scribe' }])
  assert.match(section, /fleet-dispatch send <agent-name> .* --as ops/)
  assert.match(section, /If fleet-dispatch is not installed, fall back to:/)
  assert.match(section, /hermes -p <agent-name> chat --in ~ -c "Bot Chat"/)
})

// ── fleet page (Phase 3): status ladder + timeline filter ───────────────────

test('fleetStatusOf: paused beats muted beats idle', () => {
  const r = runtime()
  assert.equal(r.__fleetStatusOf({ name: 'a' }, { paused: true, muted: true }), 'paused')
  assert.equal(r.__fleetStatusOf({ name: 'a' }, { paused: true }), 'paused')
  assert.equal(r.__fleetStatusOf({ name: 'a' }, { muted: true }), 'muted')
  assert.equal(r.__fleetStatusOf({ name: 'a' }, {}), 'idle')
  assert.equal(r.__fleetStatusOf(undefined, {}), 'idle')
})

test('fleetEventKind: delivery prefix is bot-to-bot, routine wrapper is cron, rest is human', () => {
  const r = runtime()
  assert.equal(r.__fleetEventKind('Message from 🤖 manager (@manager): vault sync failed'), 'bot_to_bot')
  assert.equal(r.__fleetEventKind('Routine: daily health check — all hosts up'), 'cron')
  assert.equal(r.__fleetEventKind('[Scheduled routine] scan the market at open'), 'cron')
  assert.equal(r.__fleetEventKind('Can you check the vault sync?'), 'human')
  assert.equal(r.__fleetEventKind(''), 'human')
})

// ── track record: one session's kind, sender, title, and stripped preview ──

test('trackEntryOf: labels a bot-to-bot session with sender and stripped preview', () => {
  const e = runtime().__trackEntryOf({
    id: 's1',
    title: 'Bot Chat',
    preview: 'Message from 🤖 manager (@manager): file the review',
    last_active: 100
  })
  assert.equal(e.kind, 'bot_to_bot')
  assert.equal(e.fromBot, 'manager')
  assert.match(e.preview, /file the review/)
  assert.doesNotMatch(e.preview, /Message from/)
  assert.equal(e.ts, 100)
})

test('trackEntryOf: labels routine and human sessions', () => {
  const r = runtime()
  const cron = r.__trackEntryOf({ preview: 'Routine: daily health check — all hosts up', last_active: 200 })
  const human = r.__trackEntryOf({ preview: 'Can you check the vault sync?', last_active: 300 })
  assert.equal(cron.kind, 'cron')
  assert.equal(cron.fromBot, null)
  assert.equal(human.kind, 'human')
  assert.equal(human.fromBot, null)
})

test('trackEntryOf: keeps a meaningful title, invents one from the preview', () => {
  const r = runtime()
  assert.equal(r.__trackEntryOf({ title: 'Weekly review', preview: 'notes' }).title, 'Weekly review')
  assert.match(r.__trackEntryOf({ title: 'Bot Chat', preview: 'vault sync ok' }).title, /vault sync ok/)
})

test('trackEntryOf: tolerates missing fields', () => {
  const e = runtime().__trackEntryOf({})
  assert.equal(e.kind, 'human')
  assert.equal(e.preview, '')
  assert.equal(e.ts, 0)
})

// ── pinned sessions: toggle + float-to-top ordering ────────────────────────

test('togglePinnedId: adds an id, toggles it off, returns new arrays', () => {
  const r = runtime()
  const one = r.__togglePinnedId([], 's1')
  assert.equal(one.length, 1)
  assert.equal(one[0], 's1')
  const two = r.__togglePinnedId(one, 's2')
  assert.equal(two.length, 2)
  assert.equal(one.length, 1) // original untouched
  const back = r.__togglePinnedId(one, 's1')
  assert.equal(back.length, 0)
})

test('pinnedFirst: floats pinned sessions to the top, sorts newest first', () => {
  const r = runtime()
  const sessions = [
    { id: 'a', ts: 1 },
    { id: 'b', ts: 2 },
    { id: 'c', ts: 3 }
  ]
  const out = r.__pinnedFirst(sessions, ['b'])
  assert.equal(out.length, 3)
  assert.equal(out[0].id, 'b')
  // Newest first: 'c' (ts:3) before 'a' (ts:1)
  assert.equal(out[1].id, 'c')
  assert.equal(out[2].id, 'a')
})

test('pinnedFirst: tolerates empty/null inputs', () => {
  const r = runtime()
  assert.equal(r.__pinnedFirst([], ['x']).length, 0)
  assert.equal(r.__pinnedFirst(undefined, ['x']).length, 0)
  assert.equal(r.__pinnedFirst([{ id: 'a' }], null).length, 1)
})

const TIMELINE_ROSTER = [
  { name: 'scribe', last_session: { preview: 'Message from 🤖 manager (@manager): vault sync failed', last_active: 300 } },
  { name: 'trader', last_session: { preview: 'AAPL scan done', last_active: 200 } },
  { name: 'ops', last_session: { preview: 'Routine: daily health check — all hosts up', last_active: 100 } },
  { name: 'fresh', description: 'no sessions yet' }
]

function timelineOf(roster, filter, limit) {
  return runtime().__fleetTimeline(roster, filter, limit)
}

test('fleetTimeline: newest first, all kinds by default, sessionless bots excluded', () => {
  const out = timelineOf(TIMELINE_ROSTER)
  assert.deepEqual(out.map(e => e.bot.name), ['scribe', 'trader', 'ops'])
})

test('fleetTimeline: filters to bot-to-bot / human / cron', () => {
  assert.deepEqual(timelineOf(TIMELINE_ROSTER, 'bot_to_bot').map(e => e.bot.name), ['scribe'])
  assert.deepEqual(timelineOf(TIMELINE_ROSTER, 'human').map(e => e.bot.name), ['trader'])
  assert.deepEqual(timelineOf(TIMELINE_ROSTER, 'cron').map(e => e.bot.name), ['ops'])
})

test('fleetTimeline: caps the list and tolerates empty rosters', () => {
  assert.equal(timelineOf(TIMELINE_ROSTER, 'all', 2).length, 2)
  assert.equal(timelineOf([], 'all').length, 0)
  assert.equal(timelineOf(undefined, 'all').length, 0)
})

// ── cross-bot search (Phase 3.2): pure fleetSearchResults filter ────────────

function searchOf(roster, sessions, query, limit) {
  return runtime().__fleetSearchResults(roster, sessions, query, limit)
}

const SEARCH_ROSTER = [
  { name: 'scribe', title: 'Scribe', description: 'notes and research' },
  { name: 'trader', title: 'Trader', description: 'markets' },
  { name: 'fresh', title: 'Fresh', description: 'no history' }
]

const SEARCH_SESSIONS = [
  { profile: 'scribe', id: 's1', title: 'Bot Chat', preview: 'Message from 🤖 manager (@manager): vault sync failed', last_active: 300 },
  { profile: 'trader', id: 't1', title: 'Premarket', preview: 'AAPL scan done', last_active: 200 },
  { profile: 'scribe', id: 's2', title: 'Vault review', preview: 'keys rotated', last_active: 100 }
]

test('fleetSearchResults: matches across bots and orders newest first', () => {
  const out = searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, 'vault')
  // s1 (ts 300) beats s2 (ts 100) even though s2's TITLE is the closer match.
  assert.equal(out.length, 2)
  assert.equal(out[0].profile, 'scribe')
  assert.equal(out[0].sessionId, 's1')
  assert.equal(out[1].sessionId, 's2')
  assert.ok(out[0].ts >= out[1].ts)
})

test('fleetSearchResults: bot name/title/description join the haystack', () => {
  const out = searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, 'markets')
  assert.equal(out.length, 1)
  assert.equal(out[0].profile, 'trader')
  assert.equal(out[0].sessionId, 't1')
})

test('fleetSearchResults: strips the delivery prefix and attributes the sender', () => {
  const out = searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, 'vault sync')
  assert.equal(out.length, 1)
  assert.match(out[0].preview, /vault sync failed/)
  assert.doesNotMatch(out[0].preview, /Message from/)
  assert.equal(out[0].fromBot, 'manager')
})

test('fleetSearchResults: caps results at the limit', () => {
  const out = searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, 'a', 1)
  assert.equal(out.length, 1)
})

test('fleetSearchResults: empty or whitespace query returns nothing', () => {
  assert.equal(searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, '').length, 0)
  assert.equal(searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, '   ').length, 0)
})

test('fleetSearchResults: tolerates null roster and null sessions', () => {
  // Sessions still searchable when the roster is missing (profile carried
  // on the session row); no sessions -> no results; no match -> no results.
  assert.equal(searchOf(undefined, SEARCH_SESSIONS, 'vault').length, 2)
  assert.equal(searchOf(SEARCH_ROSTER, undefined, 'vault').length, 0)
  assert.equal(searchOf(SEARCH_ROSTER, [], 'vault').length, 0)
  assert.equal(searchOf(SEARCH_ROSTER, SEARCH_SESSIONS, 'zzz-no-match').length, 0)
})

test('fleetSearchResults: sessions of bots outside the roster still surface', () => {
  const out = searchOf(SEARCH_ROSTER, [{ profile: 'ghost', id: 'g1', title: 'Older notes', preview: 'vault archive', last_active: 50 }], 'vault')
  assert.equal(out.length, 1)
  assert.equal(out[0].profile, 'ghost')
  assert.equal(out[0].bot, null)
})
