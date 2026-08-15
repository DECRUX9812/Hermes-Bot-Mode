import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

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

test('failed send is corrected in the ledger (kind: fail, not silent success)', async () => {
  const { dir } = await freshEnv()
  // Drive the real CLI with a failing send command; the ledger must show
  // the attempt AND the failure correction.
  const env = {
    ...process.env,
    FLEET_HOME: path.join(dir, 'fleet'),
    HERMES_HOME: path.join(dir, 'hermes'),
    FLEET_SEND_CMD: 'false'
  }
  const cli = path.resolve('scripts/fleet-dispatch.mjs')
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })

  const res = run(['send', 'scribe', 'will fail', '--as', 'trader'])
  assert.equal(res.status, 1)

  const lines = readFileSync(path.join(dir, 'fleet', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(lines.at(-2).kind, 'send')
  assert.equal(lines.at(-1).kind, 'fail')
  assert.equal(lines.at(-1).from, 'trader')
  assert.equal(lines.at(-1).to, 'scribe')
  assert.equal(lines.at(-1).status, 1)
})
