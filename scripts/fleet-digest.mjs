#!/usr/bin/env node
/**
 * fleet-digest — the daily "Fleet report" for the human.
 *
 * Phase 4 of the Fleet Command & Control plan. Composes a markdown report —
 * per bot: actions taken, handoffs sent/received, open loops, needs-you
 * items — from the REAL per-bot session stores, for delivery as a chat
 * message (cron wires it up after this ships).
 *
 * Data source: each bot profile's SQLite session store, read-only:
 *   - primary profile "default"  -> ~/.hermes/state.db
 *   - bot profiles               -> ~/.hermes/profiles/<name>/state.db
 * Read via node's built-in `node:sqlite` (DatabaseSync, readOnly) with a
 * zero-dependency fallback to `sqlite3 -json` or `python3` when unavailable.
 * No npm packages. No gateway needed — safe for cron.
 *
 * The pure functions below (previewKind, handoffsOf, needsYouOf,
 * openLoopsByBot, generatedSessionTitle) are verbatim re-implementations of
 * the same-named logic in the plugin (plugin.js, Phase 1 commit 379bf88) —
 * plugin.js cannot be imported directly (JSX + host SDK), so the plan's
 * "import the same pure functions" is satisfied by faithful copies that stay
 * in lockstep with the pane's heuristics.
 *
 * Usage:
 *   node scripts/fleet-digest.mjs [--window-hours 24] [--profiles a,b,c]
 * Env:
 *   HERMES_HOME  where profiles live (default ~/.hermes)
 */
process.removeAllListeners('warning') // silence node:sqlite experimental warning on stderr

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Resolve the REAL hermes home even when HERMES_HOME points at a profile
 *  (…/.hermes/profiles/<name>) — the profiles tree sits two levels up.
 *  Same rule as fleet-dispatch.mjs. */
function realHermesHome() {
  const h = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
  if (/[\\/]profiles[\\/][^\\/]+$/.test(h)) {
    return path.dirname(path.dirname(h))
  }
  return h
}

const HERMES_HOME_ABS = realHermesHome()

/** Static roster: every fleet profile the digest reports on, in display
 *  order, with a human role label (the pane pulls these from ui_meta; a
 *  tiny local table keeps the digest zero-dependency and deterministic).
 *  `default` is the primary profile and is rendered as Hermes. */
const ROSTER = [
  { name: 'default', role: 'Hermes — primary profile' }
]

const DEFAULT_WINDOW_HOURS = 24
const MAX_ACTIONS_PER_BOT = 3
const SNIPPET_LEN = 110

// ── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { windowHours: DEFAULT_WINDOW_HOURS, profiles: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--window-hours') opts.windowHours = Number(argv[++i]) || DEFAULT_WINDOW_HOURS
    else if (a === '--profiles') opts.profiles = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean)
    else { console.error(`unknown flag: ${a}`); opts.help = true }
  }
  return opts
}

// ── db access (zero-dependency: node:sqlite -> sqlite3 CLI -> python3) ─────

let DatabaseSync = null
try {
  const mod = await import('node:sqlite')
  DatabaseSync = mod.DatabaseSync
} catch {
  DatabaseSync = null
}

/** Run a SELECT and return rows as objects. Node:sqlite first; falls back to
 *  the sqlite3 CLI (-json) then a tiny python3 one-liner. All SQL is
 *  internal constants, so no parameter binding is needed on the fallbacks. */
function queryAll(dbPath, sql) {
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return JSON.parse(out || '[]')
  } catch {
    const py = [
      'import sqlite3,json,sys',
      'db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)',
      'db.row_factory=sqlite3.Row',
      'print(json.dumps([dict(r) for r in db.execute(sys.argv[2]).fetchall()]))'
    ].join(';')
    const out = execFileSync('python3', ['-c', py, dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return JSON.parse(out || '[]')
  }
}

/** Read-only handle for one profile's store. Returns null when the profile
 *  has no session DB (fresh profile, or `default` whose store lives at the
 *  hermes-home root). */
function openProfileDB(name) {
  const p = name === 'default'
    ? path.join(HERMES_HOME_ABS, 'state.db')
    : path.join(HERMES_HOME_ABS, 'profiles', name, 'state.db')
  return existsSync(p) ? p : null
}

// ── pure functions — verbatim from plugin.js (Phase 1) ──────────────────────

/** Bot-to-bot delivery prefix: either the current "Message from 🤖 name
 *  (@handle):" form or the older "[Message from agent 'name']" shape.
 *  Captures the sender's handle. (plugin.js A2A_RE) */
const A2A_RE = /^Message from (?:agent '([^']+)'|🤖\s*([^\s(@]+))/i

/** Strip the delivery prefix so a DM preview reads like a DM, not a log
 *  line. (plugin.js A2A_PREFIX_RE) */
const A2A_PREFIX_RE = /^Message from (?:agent '[^']+'|🤖[^:]+):\s*/i

/** Classify a roster preview: `{ fromBot: handle|null }`. A preview that
 *  starts with the delivery prefix is a bot-to-bot message. (plugin.js) */
function previewKind(preview) {
  const text = (preview || '').trim()
  if (!text) {
    return { fromBot: null }
  }
  const match = text.match(A2A_RE)
  if (match) {
    return { fromBot: (match[1] || match[2] || '').trim().toLowerCase() || null }
  }
  return { fromBot: null }
}

/** Session titles the gateway auto-assigns that carry no information.
 *  (plugin.js GENERIC_TITLES) */
const GENERIC_TITLES = new Set(['', 'bot chat', 'new chat', 'new conversation', 'conversation', 'chat', 'untitled'])

function isGenericTitle(title) {
  return GENERIC_TITLES.has((title || '').trim().toLowerCase())
}

/** Title for a session chip: the real title when it means something,
 *  otherwise a short label generated from the newest message. (plugin.js) */
function generatedSessionTitle(session, preview) {
  const raw = (session?.title || '').trim()
  if (raw && !isGenericTitle(raw)) {
    return raw
  }
  const cleaned = (preview || '').trim().replace(A2A_PREFIX_RE, '').trim()
  if (!cleaned) {
    return raw || 'Conversation'
  }
  const words = cleaned.split(/\s+/).slice(0, 5).join(' ').replace(/[,;:.]+$/, '')
  if (!words) {
    return raw || 'Conversation'
  }
  return words.length > 34 ? `${words.slice(0, 33)}…` : words
}

/** Derived bot-to-bot exchanges from the roster's newest session previews —
 *  the SAME heuristic the Bots pane uses (plugin.js recentHandoffs): a
 *  handoff is `replied` when the sender's newest preview is a DM back from
 *  the recipient with a later timestamp. The digest additionally runs a
 *  message-level scan (scanHandoffs) over the window for full counts; this
 *  function stays for parity and needs-you classification. */
function handoffsOf(roster, limit = 6) {
  const byName = new Map((roster || []).map(bot => [bot.name, bot]))
  const sends = []

  for (const bot of roster || []) {
    const last = bot.last_session
    const from = last ? previewKind(last.preview || '').fromBot : null

    if (!last || !from) {
      continue
    }

    sends.push({
      bot,
      from,
      to: bot.name,
      message: (last.preview || '').replace(A2A_PREFIX_RE, '').trim() || '…',
      sentAt: last.last_active || 0
    })
  }

  // A send whose (from,to) reverses an EARLIER send is that handoff's reply,
  // so it doesn't get its own ledger row.
  const handoffs = sends
    .filter(send => !sends.some(other => other.from === send.to && other.to === send.from && other.sentAt < send.sentAt))
    .map(send => {
      const senderLast = byName.get(send.from)?.last_session
      const reply =
        senderLast &&
        previewKind(senderLast.preview || '').fromBot === send.to &&
        (senderLast.last_active || 0) > send.sentAt
          ? senderLast
          : null

      return {
        ...send,
        status: reply ? 'replied' : 'awaiting_reply',
        replyPreview: reply ? (reply.preview || '').replace(A2A_PREFIX_RE, '').trim() : null,
        replyAt: reply ? reply.last_active : null
      }
    })

  return handoffs.sort((a, b) => b.sentAt - a.sentAt).slice(0, limit)
}

/** What needs a human right now: bot-to-bot replies that landed (the human
 *  should relay/read them), plus previews that look like a failed handoff.
 *  Newest first. (plugin.js needsYouOf — unread=null means "flag every
 *  windowed DM", which is the honest read of stores that carry no
 *  last_read_at watermark.) */
function needsYouOf(roster, unread) {
  const out = []

  for (const bot of roster || []) {
    const last = bot.last_session
    const from = last ? previewKind(last.preview || '').fromBot : null

    if (!last || !from || (unread && !unread[bot.name])) {
      continue
    }

    const preview = (last.preview || '').replace(A2A_PREFIX_RE, '').trim() || '…'

    out.push({
      bot,
      from,
      preview,
      kind: /No session found matching|handoff failed|Error/i.test(preview) ? 'handoff_failed' : 'reply_to_relay',
      ts: last.last_active || 0
    })
  }

  return out.sort((a, b) => b.ts - a.ts)
}

/** Open loops per bot name: how many handoffs THAT bot sent that haven't
 *  been answered. Same shape as plugin.js openLoopsByBot, computed over the
 *  windowed message-level handoff scan instead of newest-preview-only. */
function openLoopsByBot(handoffs) {
  const counts = {}
  for (const h of handoffs || []) {
    if (h.status === 'awaiting_reply') {
      counts[h.from] = (counts[h.from] || 0) + 1
    }
  }
  return counts
}

// ── data loading ────────────────────────────────────────────────────────────

const SESSIONS_SQL = `
  SELECT id, title, last_activity_at, message_count, last_activity_description, archived
  FROM sessions
  WHERE archived = 0
  ORDER BY COALESCE(last_activity_at, 0) DESC
  LIMIT 12`

const DMS_SQL = `
  SELECT content, timestamp
  FROM messages
  WHERE role = 'user' AND content LIKE 'Message from%' AND timestamp >= ?
  ORDER BY timestamp ASC`

const MSG_COUNT_SQL = `
  SELECT COUNT(*) AS n
  FROM messages
  WHERE timestamp >= ? AND content IS NOT NULL AND length(content) > 0`

const NEWEST_MSG_SQL = `
  SELECT content
  FROM messages
  WHERE session_id = ? AND role IN ('user','assistant') AND content IS NOT NULL AND length(content) > 0
  ORDER BY timestamp DESC LIMIT 1`

function queryAllWith(dbPath, sql, ts) {
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(sql).all(ts)
    } finally {
      db.close()
    }
  }
  // CLI fallbacks can't bind; inline the literal (internal SQL + numeric ts).
  return queryAll(dbPath, sql.replace('?', String(ts)))
}

/** Load one profile's digest data for the window. Robust to missing DBs and
 *  empty stores — a profile always yields a section, possibly a stub. */
function loadProfile(name, role, sinceTs) {
  const out = {
    name,
    role,
    dbPath: null,
    sessions: [],
    dms: [],
    msgCount: 0,
    newestPreview: '',
    newestAt: 0,
    newestSession: null
  }

  const dbPath = openProfileDB(name)
  if (!dbPath) {
    out.error = 'no session store (state.db not found)'
    return out
  }
  out.dbPath = dbPath

  try {
    out.sessions = queryAll(dbPath, SESSIONS_SQL).filter(s => !s.archived)
    const dmRows = queryAllWith(dbPath, DMS_SQL, sinceTs)
    const countRows = queryAllWith(dbPath, MSG_COUNT_SQL, sinceTs)
    out.msgCount = countRows[0]?.n ?? 0

    for (const row of dmRows) {
      const m = (row.content || '').match(A2A_RE)
      if (!m) continue
      out.dms.push({
        from: (m[1] || m[2] || '').trim().toLowerCase(),
        message: (row.content || '').replace(A2A_PREFIX_RE, '').trim() || '…',
        sentAt: row.timestamp || 0
      })
    }

    for (const s of out.sessions) {
      const rows = queryAllWith(dbPath, NEWEST_MSG_SQL, s.id)
      s.preview = (rows[0]?.content || '').trim()
    }

    const newest = out.sessions[0]
    if (newest) {
      out.newestSession = newest
      out.newestAt = newest.last_activity_at || 0
      out.newestPreview = newest.preview || ''
    }
  } catch (err) {
    out.error = `read failed: ${err.message}`
  }

  return out
}

/** Windowed message-level handoff scan: every inbound bot DM in every
 *  profile's store within the window, with reply detection (a later DM in
 *  the reverse direction). This is the digest's authoritative handoff list —
 *  a superset of the newest-preview heuristic the pane uses. */
function scanHandoffs(profilesData, sinceTs) {
  const dms = []
  for (const pd of profilesData) {
    for (const dm of pd.dms || []) {
      dms.push({ from: dm.from, to: pd.name, message: dm.message, sentAt: dm.sentAt || 0 })
    }
  }
  dms.sort((a, b) => a.sentAt - b.sentAt)

  return dms
    .map(h => {
      const reply = dms.find(o => o.from === h.to && o.to === h.from && o.sentAt > h.sentAt)
      return {
        ...h,
        status: reply ? 'replied' : 'awaiting_reply',
        replyAt: reply ? reply.sentAt : null
      }
    })
    .sort((a, b) => b.sentAt - a.sentAt)
}

// ── report helpers ──────────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function fmtStamp(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function snippet(text, len = SNIPPET_LEN) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > len ? `${flat.slice(0, len - 1)}…` : flat
}

/** Shortest unique sender handle for readability in bullets. */
function handle(bot) {
  return bot.name === 'default' ? 'hermes' : bot.name
}

function bulletList(items, render) {
  if (!items.length) return []
  return items.map(render)
}

// ── report composition ──────────────────────────────────────────────────────

function composeReport(profilesData, opts) {
  const sinceTs = Date.now() / 1000 - opts.windowHours * 3600
  const handoffs = scanHandoffs(profilesData, sinceTs)
  const openLoops = openLoopsByBot(handoffs)
  const byName = new Map(profilesData.map(pd => [pd.name, pd]))
  const loopsTotal = handoffs.filter(h => h.status === 'awaiting_reply').length
  const replied = handoffs.filter(h => h.status === 'replied').length

  // Roster for the pane-parity pure functions: last_session carries the
  // newest WINDOWED user/assistant message, so needs-you reflects today.
  const windowRoster = profilesData
    .filter(pd => pd.dms.length)
    .map(pd => ({
      name: pd.name,
      last_session: {
        preview: pd.dms.length ? `Message from 🤖 ${pd.dms[pd.dms.length - 1].from} (@${pd.dms[pd.dms.length - 1].from}): ${pd.dms[pd.dms.length - 1].message}` : '',
        last_active: pd.dms.length ? pd.dms[pd.dms.length - 1].sentAt : 0
      }
    }))
  const needsYou = needsYouOf(windowRoster, null)
  const needsYouByBot = new Map(needsYou.map(item => [item.bot.name, item]))

  const L = []
  const push = line => L.push(line)

  push(`# 🚀 Fleet Report — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`)
  push('')
  push(`> Window: last ${opts.windowHours}h · ${profilesData.length} bots polled · ${handoffs.length} handoffs · ${loopsTotal} open loops · ${needsYou.length} need${needsYou.length === 1 ? '' : 's'} you`)
  push('')

  // ── needs your attention (top of the report — that's the actionable bit)
  if (needsYou.length) {
    push('## ⚠️ Needs your attention')
    push('')
    for (const item of needsYou) {
      const kind = item.kind === 'handoff_failed' ? '⚠️ handoff failed' : '📥 relay/read'
      push(`- **@${handle(item.bot)}** ← **@${item.from}** (${kind}, ${relTime(item.ts)}): ${snippet(item.preview, 120)}`)
    }
    push('')
  }

  // ── per-bot sections
  for (const pd of profilesData) {
    const role = pd.role ? ` — ${pd.role}` : ''
    push(`## 🤖 ${pd.name}${role}`)
    push('')

    if (pd.error) {
      push(`_${pd.error}_`)
      push('')
      push('---')
      push('')
      continue
    }

    const windowed = pd.sessions.filter(s => (s.last_activity_at || 0) >= sinceTs)
    const sent = handoffs.filter(h => h.from === pd.name)
    const received = handoffs.filter(h => h.to === pd.name)
    const awaiting = sent.filter(h => h.status === 'awaiting_reply')
    const mineNeeds = needsYouByBot.get(pd.name)

    push(`**Last activity:** ${relTime(pd.newestAt)} (${fmtStamp(pd.newestAt)})`)
    push(`**Window:** ${windowed.length} session${windowed.length === 1 ? '' : 's'} active · ${pd.msgCount} messages`)
    push('')

    // actions taken — top sessions in the window
    push('**Actions taken:**')
    const actions = windowed.slice(0, MAX_ACTIONS_PER_BOT)
    if (actions.length) {
      for (const s of actions) {
        const title = generatedSessionTitle(s, s.preview || '')
        const bits = [`\`${title}\``, `${s.message_count ?? 0} msgs`]
        if (s.last_activity_description) bits.push(snippet(s.last_activity_description, 60))
        const prev = snippet(s.preview || '', 100)
        push(`- ${bits.join(' · ')}${prev ? ` — ${prev}` : ''}`)
      }
      if (windowed.length > actions.length) {
        push(`- _…and ${windowed.length - actions.length} more session${windowed.length - actions.length === 1 ? '' : 's'}_`)
      }
    } else {
      push('- _no session activity in window_')
    }
    push('')

    // handoffs sent
    push(`**Handoffs sent (${opts.windowHours}h):** ${sent.length}`)
    if (sent.length) {
      for (const h of sent) {
        const mark = h.status === 'replied' ? '✅ replied' : '🟡 awaiting reply'
        push(`- → **@${handle(byName.get(h.to) || { name: h.to })}**: ${snippet(h.message)} _(${mark})_`)
      }
    } else {
      push('- _none_')
    }
    push('')

    // handoffs received
    push(`**Handoffs received (${opts.windowHours}h):** ${received.length}`)
    if (received.length) {
      for (const h of received) {
        const mark = h.status === 'replied' ? '✅ replied' : '🟡 awaiting reply'
        push(`- ← **@${handle(byName.get(h.from) || { name: h.from })}**: ${snippet(h.message)} _(${mark})_`)
      }
    } else {
      push('- _none_')
    }
    push('')

    // open loops
    const loops = openLoops[pd.name] || 0
    push(`**Open loops:** ${loops}`)
    if (awaiting.length) {
      for (const h of awaiting) {
        push(`- 🟡 → **@${handle(byName.get(h.to) || { name: h.to })}** ${relTime(h.sentAt)}: ${snippet(h.message, 90)}`)
      }
    } else if (loops > 0) {
      push(`- _${loops} handoff${loops === 1 ? '' : 's'} awaiting reply_`)
    }
    push('')

    // needs-you (per-bot echo of the top block)
    push('**Needs you:**')
    if (mineNeeds) {
      const kind = mineNeeds.kind === 'handoff_failed' ? '⚠️ handoff failed' : '📥 relay/read'
      push(`- ← **@${mineNeeds.from}** (${kind}, ${relTime(mineNeeds.ts)}): ${snippet(mineNeeds.preview, 100)}`)
    } else {
      push('- _none_')
    }
    push('')
    push('---')
    push('')
  }

  // ── summary line
  const active = profilesData.filter(pd => !pd.error && pd.newestAt >= sinceTs)
  const idle = profilesData.filter(pd => !pd.error && pd.newestAt < sinceTs)
  const busiest = profilesData.reduce((best, pd) => (pd.msgCount > (best?.msgCount || 0) ? pd : best), null)

  push('## 📊 Summary')
  push('')
  push(`- **Bots covered:** ${profilesData.length} (${active.length} active in window${idle.length ? `, ${idle.length} idle: ${idle.map(pd => `@${handle(pd)}`).join(', ')}` : ''})`)
  const openLoopsList = Object.entries(openLoops).filter(([k]) => k !== 'total')
  const calculatedLoopsTotal = openLoopsList.reduce((acc, [, v]) => acc + v, 0)
  push(`- **Handoffs (${opts.windowHours}h):** ${handoffs.length} total — ${replied} replied, ${calculatedLoopsTotal} open`)
  push(`- **Open loops:** ${calculatedLoopsTotal}${calculatedLoopsTotal > 0 ? ` (per bot: ${openLoopsList.map(([k, v]) => `@${handle(byName.get(k) || { name: k })}×${v}`).join(', ')})` : ''}`)
  push(`- **Needs you:** ${needsYou.length} item${needsYou.length === 1 ? '' : 's'} — ${needsYou.map(i => `@${handle(i.bot)}←@${i.from}`).join(', ') || 'all clear'}`)
  push(`- **Busiest bot:** ${busiest ? `@${handle(busiest)} (${busiest.msgCount} messages in window)` : '—'}`)

  return L.join('\n') + '\n'
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    console.log(`fleet-digest — daily Fleet report from the per-bot session stores.

Usage:
  node scripts/fleet-digest.mjs [--window-hours 24] [--profiles trader,ops]

Options:
  --window-hours N   report window (default ${DEFAULT_WINDOW_HOURS})
  --profiles a,b,c   restrict to listed profiles (default: all roster bots)
  --help             this message

Reads ~/.hermes/profiles/<name>/state.db (and ~/.hermes/state.db for the
default profile) read-only via node:sqlite, falling back to sqlite3/python3.
Zero npm dependencies.`)
    process.exit(0)
  }

  const sinceTs = Date.now() / 1000 - opts.windowHours * 3600
  const wanted = opts.profiles ? new Set(opts.profiles) : null
  const roster = ROSTER.filter(bot => !wanted || wanted.has(bot.name))

  // Explicit --profiles may name bots not in the static roster (renamed or
  // new) — keep them so the report shows a stub instead of silently dropping
  // the profile. The stub explains why (missing store) when there's no DB.
  if (wanted) {
    for (const name of wanted) {
      if (!roster.some(bot => bot.name === name)) {
        roster.push({ name, role: 'Fleet bot' })
      }
    }
  }

  // Auto-include profile dirs that exist but aren't in the static roster
  // (a bot added later should still show up rather than vanish silently).
  if (!wanted) {
    const profilesDir = path.join(HERMES_HOME_ABS, 'profiles')
    try {
      for (const dir of readdirSync(profilesDir)) {
        if (dir === 'default') continue
        if (!roster.some(bot => bot.name === dir) && existsSync(path.join(profilesDir, dir, 'state.db'))) {
          roster.push({ name: dir, role: 'Fleet bot' })
        }
      }
    } catch {
      // profiles dir missing — static roster only
    }
  }

  const data = roster.map(bot => loadProfile(bot.name, bot.role, sinceTs))
  const report = composeReport(data, opts)

  process.stdout.write(report)

  const errored = data.filter(pd => pd.error)
  if (errored.length) {
    process.stderr.write(`fleet-digest: ${errored.length} profile(s) unreadable (${errored.map(pd => pd.name).join(', ')})\n`)
  }
}

await main()
