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
 *   - require_approval
 *     "never"            -> refused deterministically BEFORE the answerer
 *                           waterfall (no queue, no human prompt); a later
 *                           prepend answerer cannot bypass it
 *   - rate limit         -> refused when the sender exceeds max_per_hour
 *   - quiet hours        -> refused outside allowed hours
 *
 * Every decision is appended to FLEET_HOME/ledger.jsonl — the durable
 * record of who tried to send what, and what happened to it. Approval
 * asks and their decisions are an AUDIT PAIR: the ask appends
 * `approval/asked` (with requestId), the decision appends
 * `approval/decided` (same requestId, closed outcome). The ledger is
 * log-only — approval events never enter the model transcript; the only
 * model-visible artifact is the send payload itself.
 *
 * Closed approval outcomes (fail-closed, deepseek-harness approval.md):
 *   allowed-once | rejected | cancelled | unavailable
 *   - approve         -> allowed-once (one-shot grant, send proceeds)
 *   - reject          -> rejected
 *   - approve-refused -> cancelled (approved but re-check refuses, e.g.
 *                        sender paused since queue)
 *   - missing pending -> unavailable (answerer cannot resolve; never an
 *                        open gate — the send does not happen)
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
  if (!existsSync(POLICY_PATH)) {
    try {
      mkdirSync(FLEET_HOME, { recursive: true, mode: 0o700 })
      writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', { mode: 0o600 })
    } catch {
      /* best effort creation */
    }
    return { ...DEFAULT_POLICY }
  }

  try {
    return JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
  } catch (err) {
    console.error(`[fleet-dispatch] WARNING: Could not parse ${POLICY_PATH} (${err.message}). Using safe defaults without overwriting corrupted file.`)
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

function normalizeProfileName(name) {
  const n = String(name || '').trim().toLowerCase()
  return n === 'hermes' ? 'default' : n
}

/** Read a profile's ui_meta.hermes-bots block (paused/muted/require_approval
 *  are set there by the Bots pane via profiles.configure). Line-based YAML
 *  scan — handles default/primary profile and named profiles alike. */
function readProfileMeta(name) {
  const norm = normalizeProfileName(name)
  const p = norm === 'default'
    ? path.join(HERMES_HOME_ABS, 'profile.yaml')
    : path.join(HERMES_HOME_ABS, 'profiles', norm, 'profile.yaml')
  const fallbackP = norm === 'default'
    ? path.join(HERMES_HOME_ABS, 'profiles', 'default', 'profile.yaml')
    : p

  const targetPath = existsSync(p) ? p : existsSync(fallbackP) ? fallbackP : null
  if (!targetPath) return {}

  try {
    const lines = readFileSync(targetPath, 'utf8').split(/\r?\n/)
    const out = {}
    let inUiMeta = false
    let inBots = false

    for (const line of lines) {
      if (/^ui_meta:\s*$/.test(line)) {
        inUiMeta = true
        inBots = false
        continue
      }
      if (/^\S/.test(line)) {
        inUiMeta = false
        inBots = false
        continue
      }
      if (inUiMeta && /^  hermes-bots:\s*$/.test(line)) {
        inBots = true
        continue
      }
      if (inUiMeta && /^  \S/.test(line)) {
        inBots = false
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

  const sParts = String(q.start || '').split(':').map(Number)
  const eParts = String(q.end || '').split(':').map(Number)
  const sh = sParts[0]
  const sm = Number.isFinite(sParts[1]) ? sParts[1] : 0
  const eh = eParts[0]
  const em = Number.isFinite(eParts[1]) ? eParts[1] : 0

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
 *  paused gate still applies — the sender may have been paused since).
 *  `require_approval` semantics: `true`/`ask` queues for the human
 *  answerer; `"never"` refuses deterministically BEFORE the answerer
 *  waterfall (no queue, no prompt — a later prepend answerer cannot
 *  bypass it). */
function evaluateSend({ from, to, message, policy = DEFAULT_POLICY, meta = {}, nowMs = Date.now(), skipApproval = false }) {
  if (meta.paused) {
    return { action: 'refuse', reason: 'sender_paused' }
  }

  const approval = meta.require_approval ?? policy?.bots?.[from]?.require_approval

  if (approval === 'never') {
    // Service-enforced 'never': deterministic refusal before any answerer
    // runs — nothing to approve, no queue, no human prompt.
    return { action: 'refuse', reason: 'approval_never' }
  }

  if (!skipApproval && approval) {
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

const ID_RE = /^[a-zA-Z0-9_-]+$/

function safePendingPath(id) {
  if (!id || typeof id !== 'string' || !ID_RE.test(id)) {
    return null
  }
  const resolved = path.resolve(PENDING_DIR, `${id}.json`)
  const expectedDir = path.resolve(PENDING_DIR)
  if (!resolved.startsWith(expectedDir + path.sep)) {
    return null
  }
  return resolved
}

function queueApproval({ from, to, message }) {
  mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 })
  const safeFrom = String(from).replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeTo = String(to).replace(/[^a-zA-Z0-9_-]/g, '_')
  const rand = Math.random().toString(36).slice(2, 8)
  const id = `${Date.now()}-${safeFrom}-${safeTo}-${rand}`
  const p = path.join(PENDING_DIR, `${id}.json`)
  writeFileSync(p, JSON.stringify({ id, from, to, message, queuedAt: Date.now() }), { mode: 0o600 })
  return id
}

function readPending(id) {
  const p = safePendingPath(id)
  if (!p || !existsSync(p)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function dropPending(id) {
  const p = safePendingPath(id)
  if (p && existsSync(p)) {
    rmSync(p, { force: true })
  }
}

function listPending() {
  try {
    if (!existsSync(PENDING_DIR)) return []
    return readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(path.join(PENDING_DIR, f), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
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
        const detail = e.outcome ? ` (${e.outcome})` : (e.reason ? ` (${e.reason})` : '')
        console.log(`  ${when}  ${e.kind.padEnd(18)} ${e.from || ''} -> ${e.to || ''}${detail}`)
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
      // Audit pair, ask half: approval/asked (log-only, never in transcript)
      ledger('approval/asked', { requestId: id, from: sender, to, message })
      console.log(`[fleet-dispatch] queued for approval: ${id}`)
      console.log(`  approve: fleet-dispatch approve ${id}`)
      console.log(`  reject:  fleet-dispatch reject ${id}`)
      process.exit(0)
    }

    ledger('send', { from: sender, to, message })
    const res = execSend(sender, to, message)

    if (!res.ok) {
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
      // Fail closed: a missing/throwing answerer is `unavailable`, never an
      // open gate. The decision half is logged even when the ask is gone, so
      // the ledger stays a complete audit trail.
      ledger('approval/decided', { requestId: id, outcome: 'unavailable', reason: 'no_pending_item' })
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
        // Approved by the human, but policy check (e.g. quiet hours, paused) refuses.
        // Keep the item in pending queue so work is not lost!
        ledger('approval/decided', { requestId: id, outcome: 'refused_recheck', reason: `approve_${verdict.reason}`, from: item.from, to: item.to, message: item.message })
        console.error(`[fleet-dispatch] approve refused (${verdict.reason}); pending item remains queued`)
        process.exit(1)
      }

      ledger('approval/decided', { requestId: id, outcome: 'allowed-once', from: item.from, to: item.to, message: item.message })
      const res = execSend(item.from, item.to, item.message)
      dropPending(id)

      if (!res.ok) {
        console.error(`[fleet-dispatch] send failed (status ${res.status})`)
        process.exit(1)
      }

      console.log(`[fleet-dispatch] approved + sent: ${item.from} -> ${item.to}`)
    } else {
      ledger('approval/decided', { requestId: id, outcome: 'rejected', from: item.from, to: item.to, message: item.message })
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
