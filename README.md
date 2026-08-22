# Hermes Bot Mode

A **desktop-app plugin** for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (installs where the desktop app runs — see Install) that turns your agent profiles into a roster of named bots — each with its own chat, avatar, personality, and schedule.

![Hermes Agent desktop plugin](https://img.shields.io/badge/hermes-desktop%20plugin-8b5cf6) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

<img width="2525" height="1814" alt="image" src="https://github.com/user-attachments/assets/63c1e177-d098-42c4-999e-64cfaa493024" />

## What you get

- **Bots pane** — a left-side roster with one row per agent profile: avatar, latest-message preview, and timestamp. Click a bot to land in its chat.
- **New Agent** — create a bot in seconds: name, title, description. An **Advanced** disclosure opens the full profile config: clone from an existing profile, pin a provider/model, write a custom SOUL.md, skip bundled skills.
- **Edit Profile** (right-click a bot) — change the avatar, title, and description any time; its own Advanced section edits the live profile: per-skill and per-toolset enablement, model pin, and the full SOUL.md.
- **Duplicate** (right-click) — full clone of a bot: config, skills, SOUL.md, memory, and its look.
- **Delete Profile** (right-click) — permanently remove a bot after the same destructive confirmation used by Hermes Desktop's profile menu. The default profile cannot be deleted.
- **Avatars** — cute geometric faces (7 shapes × 10 colors with blinking eyes that scan while the bot works), an uploaded image, an AI-generated portrait (when an image backend is configured), or a pixel **pet** companion that bounces beside the avatar while the bot is busy.
- **Routines pane** — recurring tasks per bot, backed by Hermes cron. "Summarize my inbox every morning" lives next to the bot that does it. Runs land in the bot's own chat history.
- **Bot-to-bot messaging** — every bot has a persistent **Agent Inbox** conversation. Bots message each other with attribution (`[Message from agent 'researcher']`), and their SOUL.md teaches them the protocol, including how to reply.
- **@mentions** — type `@researcher have a look at this` in any chat and the active bot hands the message off, waits for the reply, and reports back.
- **Fleet page** — a command-center pane over the whole roster: per-bot status grid (busy / idle / muted / paused), cross-bot search, and one-line previews of recent handoffs.
- **Handoffs feed + Needs-you inbox** — every handoff a bot sends is written to a durable ledger. Open loops (sent, not yet replied) show as badges on the sender's row, and anything awaiting *you* — replies to relay, failed handoffs — lands in a Needs-you inbox that routes you to the right chat.
- **Pause / Mute per bot** — right-click a bot: **Pause** blocks all handoff dispatch (in-app and via `fleet-dispatch`); **Mute** keeps the bot working but silences its notifications.
- **Daily fleet digest** — `scripts/fleet-digest` composes a markdown Fleet report (per bot: actions, handoffs sent/received, open loops, needs-you items) straight from each profile's session store. Zero npm deps, no gateway needed — safe for cron.
- **Fleet dispatch CLI** — `scripts/fleet-dispatch` wraps every bot-to-bot send with policy enforcement: pause gate, approval gate, and per-bot rate limits, with a durable ledger of who tried to send what and what happened.

## How it works

A bot **is** a Hermes profile — isolated config, memory, skills, credentials, and chat history under `~/.hermes/profiles/<name>/`. This plugin is a UI over that primitive:

- Chats open via cross-profile session navigation.
- Creation/editing rides the `profiles.*` gateway RPCs (`list`, `create`, `describe`, `configure`).
- Avatar generation uses the `image.generate` RPC and works over both local and remote gateways (results return as data URLs).
- Routines are plain Hermes cron jobs namespaced `[bot:<name>] <routine>` — they also show up in `hermes cron list` and the core Cron page.
- Bot-to-bot messages are real CLI handoffs: `hermes -p <bot> chat -c "Agent Inbox" -q "..."`.

No core patches, no background daemons, no extra storage: everything is standard Hermes surface.

## Screenshots

| New Agent 

<img width="745" height="999" alt="image" src="https://github.com/user-attachments/assets/a1fc78bf-d8f8-4591-87c9-3f9ef06ac365" />

| PetDex avatars 

<img width="955" height="783" alt="image" src="https://github.com/user-attachments/assets/2a686fd2-45c5-44c0-86b5-7e2a4f7acd49" />

| Agent 2 Agent Communications

<img width="1313" height="612" alt="image" src="https://github.com/user-attachments/assets/c45b1e96-4362-4462-a049-ba8c44b87bed" />

## Fleet dispatch CLI

`scripts/fleet-dispatch` is the enforcement wrapper in front of every bot-to-bot send. It applies fleet policy before the message ships, and records every attempt in a durable ledger:

```bash
fleet-dispatch send <to> "<message>" --as <sender>   # send, subject to policy
fleet-dispatch approve <id>                           # approve a queued send
fleet-dispatch reject <id>                            # reject a queued send
fleet-dispatch status                                 # policy summary + last 10 ledger events
```

Gates, in order: **paused sender** → refused; **approval gate** (`require_approval` in policy) → queued, prints `approve <id>` / `reject <id>`; **rate limit** (`max_per_hour`) → refused when exceeded. Ledger entries record who tried to send what, and whether it shipped, was queued, or was refused — `status` shows the last 10.

Approvals are **fail-closed with a closed outcome set** and a **log-only audit pair** (deepseek-harness approval.md semantics): the ask appends `approval/asked` with a `requestId`; the decision appends `approval/decided` with the same `requestId` and one of `allowed-once | rejected | cancelled | unavailable` — approve → `allowed-once`, reject → `rejected`, approve-refused (sender paused since queue) → `cancelled`, missing pending item → `unavailable` (never an open gate). Ledger events never enter the model transcript; the only model-visible artifact is the send payload itself. `require_approval: "never"` refuses deterministically **before** the answerer waterfall — no queue, no prompt, and a later answerer cannot bypass it (the strict headless stance, like the `danger-full-access → never` preset).

### Policy

Fleet policy lives at `~/.hermes/fleet/policy.json` (template: `scripts/fleet-policy.json.example`):

```json
{
  "quiet_hours": { "enabled": false, "start": "22:00", "end": "07:00" },
  "default_max_per_hour": 30,
  "bots": {
    "trader": { "max_per_hour": 10 },
    "scribe": { "require_approval": false }
  }
}
```

- `quiet_hours` — `fleet-dispatch` refuses sends outside the allowed window when enabled.
- `default_max_per_hour` — default send throttle per bot.
- `bots.<name>` — per-bot overrides: `max_per_hour` throttle, `require_approval` gate (defaults to on for bots that need a human in the loop; accepts `true`/`ask` to queue for human approval, or `"never"` to refuse deterministically with no prompt).

The plugin reads the same `ui_meta` flags as the CLI, so Pause/Mute set in the app are enforced by `fleet-dispatch` too.

### Daily digest

`scripts/fleet-digest` [--window-hours 24] [--profiles a,b,c] composes the markdown Fleet report from each profile's SQLite session store (read-only, via `node:sqlite` with zero-dep fallbacks). No npm packages, no gateway — wire it to cron for a morning Fleet report.

## Testing

```bash
node --test tests/*.test.mjs
```

> **Gotcha:** the directory form `node --test tests/` fails — the test files import from `../scripts/` and need explicit glob expansion. Always use the glob form above.

## Install

> **This is a desktop plugin** — it must be installed on the machine running the **Hermes desktop app**, not on the gateway. Desktop plugins load from the app-side `~/.hermes/desktop-plugins/` directory; if you use a remote/SSH gateway, installing on the gateway box does nothing. (Example: gateway on your homelab, desktop app on your MacBook → install on the MacBook.)

```bash
git clone https://github.com/NousResearch/Hermes-Bot-Mode ~/.hermes/desktop-plugins/hermes-bots
```

(or download `plugin.js` into `~/.hermes/desktop-plugins/hermes-bots/`)

The fleet tooling lives in `scripts/` — symlink `fleet-dispatch` and `fleet-digest` onto your PATH (e.g. `~/.local/bin/`) so the wrapper is callable, and copy `scripts/fleet-policy.json.example` to `~/.hermes/fleet/policy.json` to tune policy. The plugin falls back to raw chat handoffs when `fleet-dispatch` is not installed.

Then reload plugins in the Hermes desktop app (Ctrl+K → "Reload desktop plugins") or restart the app. A **Bots** tab appears next to Sessions, and a **Routines** tile docks beside the conversation.

### Requirements

- Hermes desktop app with the plugin SDK (any recent build)
- The `profiles.*` / `image.generate` gateway RPCs ship in hermes-agent ≥ mid-2026 builds (`hermes update`). The plugin feature-detects older gateways and degrades gracefully — the roster works everywhere; Advanced editing and avatar generation light up when the RPCs exist.

## Notes

- Bot-to-bot delivery is policy-gated: `fleet-dispatch` enforces pause/mute, approval, and rate limits before any send; the receiving bot sees the message in its inbox when it next runs. Live interrupt of a mid-conversation bot is upstream future work.
- Avatar/pet customizations are stored in plugin storage; the profile itself stays clean.

## License

MIT © Nous Research
