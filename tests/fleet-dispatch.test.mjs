import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * fleet-dispatch policy tests. The module reads FLEET_HOME / HERMES_HOME at
 * import time, so each test gets a FRESH module instance (cache-busting
 * query) pointed at a fresh temp dir.
 */
async function freshEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'))
  process.env.FLEET_HOME = path.join(dir, 'fleet')
  process.env.HERMES_HOME = path.join(dir, 'hermes')
  process.env.FLEET_SEND_CMD = 'true'
  const mod = await import(`../scripts/fleet-dispatch.mjs?test=${Date.now()}-${Math.random()}`)
  return { mod, dir }
}

/** Spawn the real CLI in a fresh temp env (FLEET_SEND_CMD=true). Returns
 *  { status, stdout, stderr, dir, ledger() } where ledger() reads the
 *  parsed JSONL lines so audit-pair tests assert on real output. */
function cliEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-'))
  const env = {
    ...process.env,
    FLEET_HOME: path.join(dir, 'fleet'),
    HERMES_HOME: path.join(dir, 'hermes'),
    FLEET_SEND_CMD: 'true'
  }
  const run = (...args) => {
    const res = spawnSync(process.execPath, ['scripts/fleet-dispatch.mjs', ...args], {
      cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
      env,
      encoding: 'utf8'
    })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  }
  const ledger = () => {
    try {
      const p = path.join(dir, 'fleet', 'ledger.jsonl')
      return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
    } catch {
      return []
    }
  }
  const writeProfile = (name, uiMeta) => {
    const p = path.join(dir, 'hermes', 'profiles', name)
    mkdirSync(p, { recursive: true })
    let lines = ['name: ' + name, 'ui_meta:', '  hermes-bots:']
    for (const [k, v] of Object.entries(uiMeta)) {
      lines.push(`    ${k}: ${v}`)
    }
    writeFileSync(path.join(p, 'profile.yaml'), lines.join('\n') + '\n')
  }
  return { dir, env, run, ledger, writeProfile }
}

function writeProfile(dir, name, uiMeta) {
  const p = path.join(dir, 'hermes', 'profiles', name)
  mkdirSync(p, { recursive: true })
  let lines = ['name: ' + name, 'ui_meta:', '  hermes-bots:']
  for (const [k, v] of Object.entries(uiMeta)) {
    lines.push(`    ${k}: ${v}`)
  }
  writeFileSync(path.join(p, 'profile.yaml'), lines.join('\n') + '\n')
}

test('parseYamlScalar: scalars only — bools, numbers, strings, null', async () => {
  const { mod } = await freshEnv()
  assert.equal(mod.parseYamlScalar('true'), true)
  assert.equal(mod.parseYamlScalar('false'), false)
  assert.equal(mod.parseYamlScalar('42'), 42)
  assert.equal(mod.parseYamlScalar('hello world'), 'hello world')
  assert.equal(mod.parseYamlScalar('null'), null)
})

test('readProfileMeta: reads paused/muted/require_approval from profile.yaml', async () => {
  const { mod, dir } = await freshEnv()
  writeProfile(dir, 'trader', { paused: true, muted: false, chat: 'abc123' })
  const meta = mod.readProfileMeta('trader')
  assert.equal(meta.paused, true)
  assert.equal(meta.muted, false)
  assert.equal(meta.chat, 'abc123')
})

test('readProfileMeta: missing profile degrades to empty object', async () => {
  const { mod } = await freshEnv()
  assert.deepEqual(mod.readProfileMeta('nope'), {})
})

test('inQuietHours: disabled policy never blocks', async () => {
  const { mod } = await freshEnv()
  const policy = { quiet_hours: { enabled: false, start: '22:00', end: '07:00' } }
  const noon = new Date(2026, 7, 14, 12, 0)
  const midnight = new Date(2026, 7, 14, 0, 0)
  assert.equal(mod.inQuietHours(policy, noon), false)
  assert.equal(mod.inQuietHours(policy, midnight), false)
})

test('inQuietHours: overnight window blocks night and frees day', async () => {
  const { mod } = await freshEnv()
  const policy = { quiet_hours: { enabled: true, start: '22:00', end: '07:00' } }
  assert.equal(mod.inQuietHours(policy, new Date(2026, 7, 14, 23, 0)), true)
  assert.equal(mod.inQuietHours(policy, new Date(2026, 7, 14, 2, 30)), true)
  assert.equal(mod.inQuietHours(policy, new Date(2026, 7, 14, 12, 0)), false)
})

test('evaluateSend: paused sender is refused first', async () => {
  const { mod } = await freshEnv()
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta: { paused: true } })
  assert.deepEqual(verdict, { action: 'refuse', reason: 'sender_paused' })
})

test('evaluateSend: require_approval queues instead of sending', async () => {
  const { mod } = await freshEnv()
  const meta = { require_approval: true }
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta })
  assert.deepEqual(verdict, { action: 'queue', reason: 'approval_required' })
})

test('evaluateSend: skipApproval lets an approved queue item through', async () => {
  const { mod } = await freshEnv()
  const meta = { require_approval: true }
  const nowMs = new Date(2026, 7, 14, 12, 0).getTime()
  const policy = { quiet_hours: { enabled: false }, default_max_per_hour: 30, bots: {} }
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta, policy, nowMs, skipApproval: true })
  assert.equal(verdict.action, 'send')
})

test('evaluateSend: rate limit refuses over the per-hour cap', async () => {
  const { mod, dir } = await freshEnv()
  const fleet = path.join(dir, 'fleet')
  mkdirSync(fleet, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < 5; i += 1) {
    appendFileSync(path.join(fleet, 'ledger.jsonl'), JSON.stringify({ ts: now - 1000, kind: 'send', from: 'trader' }) + '\n')
  }
  const policy = { default_max_per_hour: 5, bots: {} }
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', policy, nowMs: now })
  assert.deepEqual(verdict, { action: 'refuse', reason: 'rate_limited' })
})

test('evaluateSend: quiet hours refuse during the window', async () => {
  const { mod } = await freshEnv()
  const nowMs = new Date(2026, 7, 14, 23, 0).getTime()
  const policy = { quiet_hours: { enabled: true, start: '22:00', end: '07:00' }, default_max_per_hour: 30, bots: {} }
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', policy, nowMs })
  assert.deepEqual(verdict, { action: 'refuse', reason: 'quiet_hours' })
})

test('evaluateSend: clears when nothing is blocking', async () => {
  const { mod } = await freshEnv()
  const nowMs = new Date(2026, 7, 14, 12, 0).getTime()
  const policy = { quiet_hours: { enabled: false, start: '22:00', end: '07:00' }, default_max_per_hour: 30, bots: {} }
  const verdict = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', policy, nowMs })
  assert.equal(verdict.action, 'send')
})

test('buildSendCommand: argv form (no shell), attribution payload, injection-safe', async () => {
  const { mod } = await freshEnv()
  const argv = mod.buildSendCommand('ops', 'scribe', 'check the vault')
  assert.deepEqual(argv.slice(0, 4), ['-p', 'scribe', 'chat', '--in'])
  assert.equal(argv[4].startsWith('/'), true) // real home path, no '~' (no shell to expand it)
  assert.deepEqual(argv.slice(5), ['-c', 'Bot Chat', '-Q', '-q', 'Message from 🤖 ops (@ops): check the vault'])

  // A hostile message must stay a LITERAL argv element — no shell to expand it.
  const hostile = '$(rm -rf ~) `id`; touch /tmp/pwned'
  const argv2 = mod.buildSendCommand('ops', 'scribe', hostile)
  assert.ok(argv2.includes(`Message from 🤖 ops (@ops): ${hostile}`))
})

test('queue -> approve -> send round trip', async () => {
  const { mod, dir } = await freshEnv()
  const id = mod.queueApproval({ from: 'trader', to: 'scribe', message: 'send me the scan' })
  assert.ok(id)

  const pending = mod.listPending()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].from, 'trader')
  assert.equal(pending[0].to, 'scribe')

  const res = mod.execSend('trader', 'scribe', 'send me the scan')
  assert.equal(res.ok, true)
})

test('evaluateSend: require_approval "never" refuses BEFORE the answerer waterfall', async () => {
  const { mod } = await freshEnv()
  const nowMs = new Date(2026, 7, 14, 12, 0).getTime()
  const policy = { quiet_hours: { enabled: false }, default_max_per_hour: 30, bots: {} }

  // profile-level never
  const fromMeta = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta: { require_approval: 'never' }, policy, nowMs })
  assert.deepEqual(fromMeta, { action: 'refuse', reason: 'approval_never' })

  // policy-level never (bots.<name>.require_approval = "never")
  const fromPolicy = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta: {}, policy: { ...policy, bots: { trader: { require_approval: 'never' } } }, nowMs })
  assert.deepEqual(fromPolicy, { action: 'refuse', reason: 'approval_never' })

  // skipApproval must NOT bypass never — it is a service-enforced gate
  const skip = mod.evaluateSend({ from: 'trader', to: 'scribe', message: 'hi', meta: { require_approval: 'never' }, policy, nowMs, skipApproval: true })
  assert.deepEqual(skip, { action: 'refuse', reason: 'approval_never' })
})

test('CLI: queue appends approval/asked; approve appends approval/decided (allowed-once) with matching requestId', () => {
  const env = cliEnv()
  env.writeProfile('trader', { require_approval: true })

  const queued = env.run('send', 'scribe', 'send me the scan', '--as', 'trader')
  assert.equal(queued.status, 0, queued.stderr)

  const idMatch = /queued for approval: (\S+)/.exec(queued.stdout)
  assert.ok(idMatch, `no queued id in: ${queued.stdout}`)
  const requestId = idMatch[1]

  const asked = env.ledger().filter(e => e.kind === 'approval/asked')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].requestId, requestId)
  assert.equal(asked[0].from, 'trader')
  assert.equal(asked[0].to, 'scribe')
  assert.equal(asked[0].message, 'send me the scan')

  const approved = env.run('approve', requestId)
  assert.equal(approved.status, 0, approved.stderr)

  const decided = env.ledger().filter(e => e.kind === 'approval/decided')
  assert.equal(decided.length, 1)
  assert.equal(decided[0].requestId, requestId)
  assert.equal(decided[0].outcome, 'allowed-once')

  // Audit pair: exactly one asked + one decided sharing the requestId
  const pairs = env.ledger().filter(e => e.requestId === requestId)
  assert.deepEqual(pairs.map(e => e.kind).sort(), ['approval/asked', 'approval/decided'])
})

test('CLI: reject appends approval/decided (rejected) paired to the ask', () => {
  const env = cliEnv()
  env.writeProfile('trader', { require_approval: true })

  const queued = env.run('send', 'scribe', 'draft the memo', '--as', 'trader')
  assert.equal(queued.status, 0, queued.stderr)
  const requestId = /queued for approval: (\S+)/.exec(queued.stdout)[1]

  const rejected = env.run('reject', requestId)
  assert.equal(rejected.status, 0, rejected.stderr)

  const pairs = env.ledger().filter(e => e.requestId === requestId)
  assert.equal(pairs.length, 2)
  assert.equal(pairs[0].kind, 'approval/asked')
  assert.equal(pairs[1].kind, 'approval/decided')
  assert.equal(pairs[1].outcome, 'rejected')
})

test('CLI: approving while the sender is now paused appends approval/decided (refused_recheck) — no send, item preserved', () => {
  const env = cliEnv()
  env.writeProfile('trader', { require_approval: true })

  const queued = env.run('send', 'scribe', 'ship it', '--as', 'trader')
  assert.equal(queued.status, 0, queued.stderr)
  const requestId = /queued for approval: (\S+)/.exec(queued.stdout)[1]

  // Sender gets paused while the request sits in the queue
  env.writeProfile('trader', { require_approval: true, paused: true })

  const approved = env.run('approve', requestId)
  assert.equal(approved.status, 1) // approve refused — hard gate still applies

  const decided = env.ledger().filter(e => e.requestId === requestId && e.kind === 'approval/decided')
  assert.equal(decided.length, 1)
  assert.equal(decided[0].outcome, 'refused_recheck')
  assert.match(decided[0].reason, /^approve_sender_paused$/)
})

test('CLI: missing pending item fails closed — approval/decided (unavailable), never an open gate', () => {
  const env = cliEnv()
  env.writeProfile('trader', { require_approval: true })

  const res = env.run('approve', 'nope-no-such-id')
  assert.equal(res.status, 1)

  const decided = env.ledger().filter(e => e.kind === 'approval/decided')
  assert.equal(decided.length, 1)
  assert.equal(decided[0].requestId, 'nope-no-such-id')
  assert.equal(decided[0].outcome, 'unavailable')
  assert.equal(decided[0].reason, 'no_pending_item')
})

test('CLI: require_approval "never" refuses with NO approval/asked ledger entry (service-enforced, no queue)', () => {
  const env = cliEnv()
  env.writeProfile('trader', { require_approval: 'never' })

  const res = env.run('send', 'scribe', 'hello', '--as', 'trader')
  assert.equal(res.status, 1)
  assert.match(res.stderr, /approval_never/)

  const entries = env.ledger()
  assert.equal(entries.filter(e => e.kind === 'approval/asked').length, 0)
  assert.equal(entries.filter(e => e.kind === 'approval/decided').length, 0)
  assert.equal(entries.filter(e => e.kind === 'refuse' && e.reason === 'approval_never').length, 1)
})
