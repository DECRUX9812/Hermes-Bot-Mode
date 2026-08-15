import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'fleet-digest.mjs')
const HERMES_HOME = path.join(os.homedir(), '.hermes')

function runDigest(args = []) {
  return execFileSync(process.execPath, ['--no-warnings', SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
}

/** Profiles that actually have a session store on this machine — the digest
 *  must cover every one of them, and must not crash on the rest. */
function profilesWithStore() {
  const names = []
  const profilesDir = path.join(HERMES_HOME, 'profiles')
  if (existsSync(profilesDir)) {
    for (const dir of readdirSync(profilesDir)) {
      if (existsSync(path.join(profilesDir, dir, 'state.db'))) names.push(dir)
    }
  }
  // The primary profile's store lives at the hermes-home root.
  if (existsSync(path.join(HERMES_HOME, 'state.db'))) names.push('default')
  return names
}

test('fleet-digest runs end-to-end and prints a complete report', () => {
  const out = runDigest()

  assert.match(out, /^# 🚀 Fleet Report —/, 'report header')
  assert.match(out, /## 📊 Summary/, 'summary section')
  assert.match(out, /Bots covered:/, 'summary counts bots')

  // Every profile with a real session store gets its own section.
  for (const name of profilesWithStore()) {
    assert.match(out, new RegExp(`## 🤖 ${name}\\b`), `section for profile ${name}`)
  }

  // Report shape: per-bot sections carry the four required blocks.
  for (const block of ['Actions taken:', 'Handoffs sent', 'Handoffs received', 'Open loops:', 'Needs you:']) {
    assert.ok(out.includes(block), `report contains "${block}"`)
  }
})

test('fleet-digest honors --profiles and --window-hours', () => {
  const out = runDigest(['--profiles', 'trader,ops', '--window-hours', '6'])

  assert.match(out, /## 🤖 trader\b/, 'only trader section')
  assert.match(out, /## 🤖 ops\b/, 'only ops section')
  assert.doesNotMatch(out, /## 🤖 teknium\b/, 'teknium excluded')
  assert.match(out, /Window: last 6h/, 'window override applied')
})

test('fleet-digest is robust to unknown profiles', () => {
  const out = runDigest(['--profiles', 'trader,no-such-bot'])

  assert.match(out, /## 🤖 trader\b/, 'known profile still reported')
  assert.match(out, /## 🤖 no-such-bot\b/, 'unknown profile gets a stub section')
  assert.match(out, /no session store/, 'stub explains missing store')
})
