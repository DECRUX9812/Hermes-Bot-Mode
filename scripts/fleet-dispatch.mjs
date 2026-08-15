#!/usr/bin/env node
/**
 * fleet-dispatch — the enforcement seam for bot-to-bot handoffs.
 *
 * Bots hand tasks to each other by messaging the recipient's canonical
 * "Bot Chat". This wrapper sits in front of that send and applies fleet
 * policy, so the human keeps control:
 *
 *   - paused sender      -> refused (flag lives in profile.yaml ui_meta,
 *                           set from the Bots pane right-click menu)
 *   - require_approval   -> queued to FLEET_HOME/pending; the human
 *                           approves/rejects with `fleet-dispatch approve|reject <id>`
 *   - rate limit         -> refused when the sender exceeds max_per_hour
 *   - quiet hours        -> refused outside allowed hours
 *
 * Every decision is appended to FLEET_HOME/ledger.jsonl — the durable
 * record of who tried to send what, and what happened to it.
 *
 * Usage:
 *   fleet-dispatch send <to> "<message>" --as <sender>
 *   fleet-dispatch approve <id>
 *   fleet-dispatch reject <id>
 *   fleet-dispatch status
 *
 * Env:
 *   FLEET_HOME     state dir (default ~/.hermes/fleet)
 *   HERMES_HOME    where profiles live (default ~/.hermes)
 *   FLEET_SEND_CMD override the send execution (tests use `true`)
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the REAL hermes home even when HERMES_HOME points at a profile
 *  (…/.hermes/profiles/<name>) — the profiles tree sits two levels up. */
function realHermesHome() {
  const h = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')

  if (/[\\/]profiles[\\/][^\\/]+$/.test(h)) {
    return path.dirname(path.dirname(h))
  }

  return h
}

const HERMES_HOME_ABS = realHermesHome()
const FLEET_HOME = process.env.FLEET_HOME || path.join(HERMES_HOME_ABS, 'fleet')
const POLICY_PATH = path.join(FLEET_HOME, 'policy.json')
const LEDGER_PATH = path.join(FLEET_HOME, 'ledger.jsonl')
const PENDING_DIR = path.join(FLEET_HOME, 'pending')

/** Defaults written on first run; override in FLEET_HOME/policy.json. */
const DEFAULT_POLICY = {
  quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
  default_max_per_hour: 30,
  bots: {}
}

// ── policy ──────────────────────────────────────────────────────────────────

function loadPolicy() {
  try {
    return JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
  } catch {
    mkdirSync(FLEET_HOME, { recursive: true })
    writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n')
    return { ...DEFAULT_POLICY }
  }
}

/** YAML scalar -> JS. Only the scalars saveBotMeta writes matter here. */
function parseYamlScalar(value) {
  const s = String(value == null ? '' : value).trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  const n = Number(s)
  return s !== '' && Number.isFinite(n) ? n : s
}

/** Read a profile's ui_meta.hermes-bots block (paused/muted/require_approval
 *  are set there by the Bots pane via profiles.configure). Line-based YAML
 *  scan — enough for the flat boolean flags we write. */
function readProfileMeta(name) {
  const p = path.join(HERMES_HOME_ABS, 'profiles', name, 'profile.yaml')

  try {
    const lines = readFileSync(p, 'utf8').split(/\r?\n/)
    const out = {}
    let inBots = false

    for (const line of lines) {
      if (/^ui_meta:\s*$/.test(line)) {
        inBots = false
        continue
      }

      if (inBots && /^\S/.test(line)) {
        inBots = false
      }

      if (/^  hermes-bots:\s*$/.test(line)) {
        inBots = true
        continue
      }

      if (inBots) {
        const m = /^    ([A-Za-z0-9_]+):\s*(.*)$/.exec(line)

        if (m) {
          out[m[1]] = parseYamlScalar(m[2])
        }
      }
    }

    return out
  } catch {
    return {}
  }
}

// ── ledger (the durable track) ──────────────────────────────────────────────

function ledger(kind, entry) {
  mkdirSync(FLEET_HOME, { recursive: true })
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: Date.now(), kind, ...entry }) + '\n')
}

/** Sends from `from` in the last hour, counted from the ledger. */
function sendsInLastHour(from, nowMs = Date.now()) {
  try {
    const lines = readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
    const cutoff = nowMs - 3600 * 1000
    let count = 0

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        if (entry.kind === 'send' && entry.from === from && entry.ts >= cutoff) {
          count += 1
        }
      } catch {
        /* skip malformed line */
      }
    }

    return count
  } catch {
    return 0
  }
}

// ── quiet hours ─────────────────────────────────────────────────────────────

function inQuietHours(policy, date = new Date()) {
  const q = policy?.quiet_hours

  if (!q || !q.enabled) {
    return false
  }

  const [sh, sm] = String(q.start).split(':').map(Number)
  const [eh, em] = String(q.end).split(':').map(Number)

  if (!Number.isFinite(sh) || !Number.isFinite(eh)) {
    return false
  }

  const start = sh * 60 + sm
  const end = eh * 60 + em

  if (start === end) {
    return false
  }

  const mins = date.getHours() * 60 + date.getMinutes()
  return start < end ? mins >= start && mins < end : mins >= start || mins < end
}

// ── send evaluation ─────────────────────────────────────────────────────────

/** The real send command — argv form, NO shell. Bot-controlled message text
 *  can contain anything ($(), backticks, quotes) and stays literal: there is
 *  no shell to interpret it. `--in` is the real home (no tilde — no shell
 *  to expand it). */
function buildSendCommand(from, to, message) {
  const payload = `Message from 🤖 ${from} (@${from}): ${message}`
  return ['-p', to, 'chat', '--in', os.homedir(), '-c', 'Bot Chat', '-Q', '-q', payload]
}

function maxPerHour(policy, from) {
  return policy?.bots?.[from]?.max_per_hour ?? policy?.default_max_per_hour ?? 30
}

/** Decide what happens to a proposed handoff. Pure — tests pin every branch.
 *  `skipApproval` is set on the APPROVE path: a queued item was already
 *  human-approved, so the approval gate must not re-trigger (the hard
 *  paused gate still applies — the sender may have been paused since). */
function evaluateSend({ from, to, message, policy = DEFAULT_POLICY, meta = {}, nowMs = Date.now(), skipApproval = false }) {
  if (meta.paused) {
    return { action: 'refuse', reason: 'sender_paused' }
  }

  if (!skipApproval && (meta.require_approval || policy?.bots?.[from]?.require_approval)) {
    return { action: 'queue', reason: 'approval_required' }
  }

  if (sendsInLastHour(from, nowMs) >= maxPerHour(policy, from)) {
    return { action: 'refuse', reason: 'rate_limited' }
  }

  if (inQuietHours(policy, new Date(nowMs))) {
    return { action: 'refuse', reason: 'quiet_hours' }
  }

  return { action: 'send', reason: null }
}

// ── queue + execution ───────────────────────────────────────────────────────

function queueApproval({ from, to, message }) {
  mkdirSync(PENDING_DIR, { recursive: true })
  const id = `${Date.now()}-${from}-${to}`
  writeFileSync(path.join(PENDING_DIR, `${id}.json`), JSON.stringify({ id, from, to, message, queuedAt: Date.now() }))
  return id
}

function readPending(id) {
  const p = path.join(PENDING_DIR, `${id}.json`)

  if (!existsSync(p)) {
    return null
  }

  return JSON.parse(readFileSync(p, 'utf8'))
}

function dropPending(id) {
  rmSync(path.join(PENDING_DIR, `${id}.json`), { force: true })
}

function listPending() {
  try {
    return readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(path.join(PENDING_DIR, f), 'utf8')))
      .sort((a, b) => a.queuedAt - b.queuedAt)
  } catch {
    return []
  }
}

/** Execute a send. FLEET_SEND_CMD overrides the runner (tests use `true`). */
function execSend(from, to, message) {
  const override = process.env.FLEET_SEND_CMD

  if (override) {
    const res = spawnSync(override, [], { encoding: 'utf8', timeout: 30000 })
    return { ok: res.status === 0, status: res.status, output: (res.stdout || '') + (res.stderr || '') }
  }

  // argv form — no bash -c, so bot-controlled message text can never inject
  const res = spawnSync('hermes', buildSendCommand(from, to, message), { encoding: 'utf8', timeout: 60000 })
  return { ok: res.status === 0, status: res.status, output: (res.stdout || '') + (res.stderr || '') }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printStatus() {
  const policy = loadPolicy()
  const bots = Object.keys(policy?.bots || {})
  const pending = listPending()
  console.log(`FLEET_HOME: ${FLEET_HOME}`)
  console.log(`quiet hours: ${policy?.quiet_hours?.enabled ? `${policy.quiet_hours.start}-${policy.quiet_hours.end}` : 'off'}`)
  console.log(`max sends/hour (default): ${maxPerHour(policy, 'x')}`)
  console.log(`pending approvals: ${pending.length}`)

  for (const item of pending) {
    console.log(`  ${item.id}  ${item.from} -> ${item.to}: ${item.message}`)
  }

  if (bots.length) {
    console.log('per-bot overrides: ' + bots.join(', '))
  }

  // Recent ledger — the durable track of who tried to send what.
  try {
    const lines = readFileSync(LEDGER_PATH, 'utf8').split(/\r?\n/).filter(Boolean).slice(-10)
    console.log(`recent (last ${lines.length} ledger events):`)

    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        const when = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        console.log(`  ${when}  ${e.kind.padEnd(8)} ${e.from || ''} -> ${e.to || ''}${e.reason ? ` (${e.reason})` : ''}`)
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no ledger yet */
  }
}

function main(argv) {
  const [cmd, ...rest] = argv

  if (cmd === 'send') {
    // fleet-dispatch send <to> "<message>" --as <sender>
    const asIdx = rest.indexOf('--as')
    const sender = asIdx >= 0 ? rest[asIdx + 1] : null
    const args = asIdx >= 0 ? rest.slice(0, asIdx) : rest
    const to = args[0]
    const message = args.slice(1).join(' ')

    if (!to || !message || !sender) {
      console.error('usage: fleet-dispatch send <to> "<message>" --as <sender>')
      process.exit(2)
    }

    const policy = loadPolicy()
    const meta = readProfileMeta(sender)
    const verdict = evaluateSend({ from: sender, to, message, policy, meta })

    if (verdict.action === 'refuse') {
      ledger('refuse', { from: sender, to, message, reason: verdict.reason })
      console.error(`[fleet-dispatch] refused (${verdict.reason}): ${sender} -> ${to}`)
      process.exit(1)
    }

    if (verdict.action === 'queue') {
      const id = queueApproval({ from: sender, to, message })
      ledger('queue', { from: sender, to, message, id })
      console.log(`[fleet-dispatch] queued for approval: ${id}`)
      console.log(`  approve: fleet-dispatch approve ${id}`)
      console.log(`  reject:  fleet-dispatch reject ${id}`)
      process.exit(0)
    }

    ledger('send', { from: sender, to, message })
    const res = execSend(sender, to, message)

    if (!res.ok) {
      // The 'send' entry above records the attempt (and feeds the rate
      // limit); this corrects the record so the ledger never claims a
      // delivery that errored.
      ledger('fail', { from: sender, to, message, status: res.status })
      console.error(`[fleet-dispatch] send failed (status ${res.status}): ${res.output.slice(0, 500)}`)
      process.exit(1)
    }

    console.log(`[fleet-dispatch] sent: ${sender} -> ${to}`)
    process.exit(0)
  }

  if (cmd === 'approve' || cmd === 'reject') {
    const id = rest[0]

    if (!id) {
      console.error(`usage: fleet-dispatch ${cmd} <id>`)
      process.exit(2)
    }

    const item = readPending(id)

    if (!item) {
      console.error(`[fleet-dispatch] no pending approval '${id}'`)
      process.exit(1)
    }

    if (cmd === 'approve') {
      // Re-check policy at execution time — the sender may have been paused
      // while the request sat in the queue.
      const policy = loadPolicy()
      const meta = readProfileMeta(item.from)
      const verdict = evaluateSend({ ...item, policy, meta, skipApproval: true })

      if (verdict.action !== 'send') {
        ledger('refuse', { from: item.from, to: item.to, message: item.message, reason: `approve_${verdict.reason}`, id })
        dropPending(id)
        console.error(`[fleet-dispatch] approve refused (${verdict.reason}); pending item dropped`)
        process.exit(1)
      }

      ledger('approve', { from: item.from, to: item.to, message: item.message, id })
      const res = execSend(item.from, item.to, item.message)
      dropPending(id)

      if (!res.ok) {
        ledger('fail', { from: item.from, to: item.to, message: item.message, id, status: res.status })
        console.error(`[fleet-dispatch] send failed (status ${res.status})`)
        process.exit(1)
      }

      console.log(`[fleet-dispatch] approved + sent: ${item.from} -> ${item.to}`)
    } else {
      ledger('reject', { from: item.from, to: item.to, message: item.message, id })
      dropPending(id)
      console.log(`[fleet-dispatch] rejected: ${item.from} -> ${item.to}`)
    }

    process.exit(0)
  }

  if (cmd === 'status') {
    printStatus()
    process.exit(0)
  }

  console.error('usage: fleet-dispatch <send|approve|reject|status> …')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}

export {
  DEFAULT_POLICY,
  buildSendCommand,
  evaluateSend,
  inQuietHours,
  loadPolicy,
  parseYamlScalar,
  queueApproval,
  readProfileMeta,
  sendsInLastHour,
  listPending,
  execSend
}
