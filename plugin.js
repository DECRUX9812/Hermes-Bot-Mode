/**
 * Hermes Bot Mode — a "one chat per agent" roster for the Hermes desktop.
 *
 * Left pane "Bots": one row per Hermes profile (a bot = an agent profile) with
 * a customizable avatar (shape + color + eyes, image, or pet). Click opens that
 * bot's chat; right-click → Edit Profile (avatar, title, description).
 * "New Agent" creates a profile — Name / Title / Description with an
 * "Advanced" disclosure for full profile config.
 *
 * Right tile "Routines": scheduled tasks (Hermes cron jobs) scoped to the
 * bot you're currently chatting with — follows the live gateway profile.
 *
 * Bots message each other straight into each bot's ONE canonical "Bot
 * Chat" — @-mentions deliver over gateway RPCs (no CLI relay), and
 * bot-initiated sends use `hermes -p <bot> chat --in ~ -c "Bot Chat"`.
 */

import {
  atom,
  Badge,
  Button,
  Checkbox,
  cn,
  Codicon,
  COMPOSER_AREAS,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  GlyphSpinner,
  haptic,
  host,
  Input,
  PALETTE_AREA,
  profileColor,
  queryClient,
  relativeTime,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SIDEBAR_NAV_AREA,
  Switch,
  Textarea,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-bots'
const ROSTER_KEY = [ID, 'roster']
const ROUTINES_KEY = [ID, 'routines']
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Captured in register() so components can reach plugin storage. */
let pluginCtx = null

/** Live roster snapshot for imperative handlers (context menus). */
const $lastRoster = atom([])

/** Disposers for the currently registered ⌘K dispatch rows — cleared and
 *  re-registered whenever the roster changes. */
let paletteDisposers = []

/** Bots with chat activity the user hasn't seen yet (name -> true).
 *  Fed by the roster poll's activity watermark, so it catches EVERY
 *  delivery path: RPC, CLI (bot-to-bot), cron runs, other machines. */
const $botUnread = atom({})

// last_active watermark per bot, seeded on first poll so a fresh mount
// doesn't mark ancient history unread.
const rosterWatermarks = new Map()
let watermarksSeeded = false

// Per-bot toast cooldown: once a bot has toasted, suppress further toasts
// for TOAST_COOLDOWN_MS. Without this, an active squad (bot-to-bot
// handoffs, cron runs) bumps last_active on every poll (5s) and spams the
// human with a notification every few seconds. The unread badge still
// updates — only the toast is throttled.
const TOAST_COOLDOWN_MS = 60_000
const lastToastAt = new Map()

/** Detect new inbound activity from a fresh roster: last_active moved past
 *  the watermark for a bot whose chat isn't on screen -> unread + toast. */
function trackInboundActivity(roster) {
  const seeding = !watermarksSeeded
  watermarksSeeded = true

  for (const bot of roster) {
    const ts = bot.last_session?.last_active || 0
    const prev = rosterWatermarks.get(bot.name) || 0
    rosterWatermarks.set(bot.name, Math.max(prev, ts))

    if (seeding || ts <= prev) {
      continue
    }

    // Activity in the bot the user is currently looking at is already
    // visible — never badge the open chat.
    if ($selectedBot.get() === bot.name) {
      continue
    }

    const meta = $botMeta.get()[bot.name]
    const label = displayName(bot, meta)
    const preview = (bot.last_session?.preview || '').trim()
    const inbound = /^Message from/i.test(preview)

    $botUnread.set({ ...$botUnread.get(), [bot.name]: true })

    // Muted bots still badge (the dot is quiet context) but never toast —
    // the human muted them on purpose.
    if (meta?.muted) {
      continue
    }

    // Unread watermarks are updated in $botUnread so the UI badges reflect
    // new messages, but we do NOT send disruptive desktop notification toasts
    // for background bot activity.
  }
}

/** Last good cron list, same idea as the roster snapshot. */
const $lastJobs = atom([])

/** Bot the Routines tile is scoped to. Follows the live gateway profile
 *  (the bot you're actually chatting with) and roster clicks. */
const $selectedBot = atom('default')

/** Per-bot appearance + display meta, persisted via ctx.storage:
 *  { [botName]: { shape, color, title } } */
const $botMeta = atom({})

/** Per-bot pinned session ids — the user-curated track record. Persisted via
 *  ctx.storage key 'pinned-sessions': { [botName]: [sessionId, ...] }. */
const $pinnedSessions = atom({})

function savePinnedSessions(botName, ids) {
  const next = { ...$pinnedSessions.get(), [botName]: ids }
  $pinnedSessions.set(next)

  try {
    Promise.resolve(pluginCtx?.storage?.set?.('pinned-sessions', next)).catch(() => undefined)
  } catch {
    /* storage unavailable — pin persists for this window only */
  }
}

function saveBotMeta(name, patch) {
  const next = { ...$botMeta.get(), [name]: { ...($botMeta.get()[name] || {}), ...patch } }
  $botMeta.set(next)

  // Local plugin storage: instant, and the fallback for older gateways.
  try {
    Promise.resolve(pluginCtx?.storage?.set?.('bot-meta', next)).catch(() => undefined)
  } catch {
    /* storage unavailable — look persists for this window only */
  }

  // Server-side (source of truth when supported): profile.yaml ui_meta,
  // namespaced under this plugin's id — every client machine sees the same
  // roster. Older gateways reject the param shape; that's fine, local wins.
  // Data-URL fields are stripped from ui_meta (64KB cap, rides every
  // profiles.list); the avatar IMAGE goes to the profile asset store
  // instead (profiles.set_asset), which is server-side and uncapped by the
  // list call — so pfps follow the profile across machines too.
  try {
    const { image, pet, ...rest } = next[name] || {}
    host
      .request('profiles.configure', { name, ui_meta: { 'hermes-bots': rest } })
      .catch(() => undefined)
  } catch {
    /* older gateway */
  }

  // Avatar image → profile asset store (feature-detected; local storage
  // remains the fallback rendering source on older gateways).
  if ('image' in patch) {
    try {
      const req = patch.image
        ? host.request('profiles.set_asset', { name, asset: 'avatar', data: patch.image })
        : host.request('profiles.set_asset', { name, asset: 'avatar', clear: true })
      req.catch(() => undefined)
    } catch {
      /* older gateway */
    }
  }
}

/** Fetch server-side avatars for roster rows flagged has_avatar when the
 *  local cache doesn't already have an image for them. Fire-and-forget. */
const avatarFetchInflight = new Set()

const avatarPushInflight = new Set()

/** Backfill: local meta has art the server lacks -> profiles.set_asset.
 *  Server-side avatars power the inter-agent notice pfp (core #85855) and
 *  cross-machine roster art, so local-only images are a bug, not a state. */
function pushLocalAvatars(roster) {
  for (const bot of roster) {
    if (bot.has_avatar || avatarPushInflight.has(bot.name)) {
      continue
    }

    const image = $botMeta.get()[bot.name]?.image

    if (image && typeof image === 'string' && image.startsWith('data:')) {
      avatarPushInflight.add(bot.name)
      host
        .request('profiles.set_asset', { name: bot.name, asset: 'avatar', data: image })
        .then(() => queryClient.invalidateQueries({ queryKey: ['hermes-bots', 'roster'] }))
        .catch(() => avatarPushInflight.delete(bot.name))
      continue
    }

    // Vector shape/color face: no image exists anywhere — rasterize the
    // live SVG (tagged data-bot-face) to a PNG and push that, so the
    // inter-agent notices (core #85855/#85888) can show the real pfp.
    const svg = document.querySelector('svg[data-bot-face=' + JSON.stringify(bot.name) + ']')

    if (!svg) {
      continue
    }

    avatarPushInflight.add(bot.name)
    rasterizeSvgToPng(svg, 160)
      .then(png =>
        png
          ? host
              .request('profiles.set_asset', { name: bot.name, asset: 'avatar', data: png })
              .then(() => queryClient.invalidateQueries({ queryKey: ['hermes-bots', 'roster'] }))
          : Promise.reject(new Error('rasterize failed'))
      )
      .catch(() => avatarPushInflight.delete(bot.name))
  }
}

/** Serialize an inline SVG and draw it to a canvas -> PNG data URL. */
function rasterizeSvgToPng(svgEl, size) {
  return new Promise(resolve => {
    try {
      const clone = svgEl.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(size))
      clone.setAttribute('height', String(size))
      const markup = new XMLSerializer().serializeToString(clone)
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
      const img = new Image()

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          canvas.getContext('2d').drawImage(img, 0, 0, size, size)
          resolve(canvas.toDataURL('image/png'))
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = url
    } catch {
      resolve(null)
    }
  })
}

function pullServerAvatars(roster) {
  pushLocalAvatars(roster)

  for (const bot of roster) {
    if (!bot.has_avatar || avatarFetchInflight.has(bot.name)) {
      continue
    }

    if ($botMeta.get()[bot.name]?.image) {
      continue
    }

    avatarFetchInflight.add(bot.name)
    host
      .request('profiles.get_asset', { name: bot.name, asset: 'avatar' })
      .then(res => {
        if (res?.found && res.data) {
          const current = $botMeta.get()
          $botMeta.set({ ...current, [bot.name]: { ...(current[bot.name] || {}), image: res.data } })

          try {
            Promise.resolve(pluginCtx?.storage?.set?.('bot-meta', $botMeta.get())).catch(() => undefined)
          } catch {
            /* no storage */
          }
        }
      })
      .catch(() => undefined)
      .finally(() => avatarFetchInflight.delete(bot.name))
  }
}

/** Server ui_meta (per roster row) beats local storage for the compact
 *  fields it carries; local-only fields (avatar image data URL, extracted
 *  pet icon) are PRESERVED — the server copy never includes them, so a
 *  naive replace would wipe a just-saved image avatar on the next roster
 *  paint. Local also fills gaps for older gateways. */
function mergeServerMeta(roster) {
  const local = $botMeta.get()
  let changed = false
  const next = { ...local }

  for (const bot of roster) {
    const server = bot.ui_meta?.['hermes-bots']
    if (server && typeof server === 'object') {
      const mine = next[bot.name] || {}
      const merged = { ...mine, ...server }

      // Local-only fields survive the server overlay.
      if (mine.image) {
        merged.image = mine.image
      }

      if (JSON.stringify(next[bot.name] || null) !== JSON.stringify(merged)) {
        next[bot.name] = merged
        changed = true
      }
    }
  }

  if (changed) {
    $botMeta.set(next)
  }
}

/** Clone a bot: profile (config/skills/SOUL/memory via clone_from) + look.
 *  Name is "<base>-2", "-3", … — first free slot against the live roster. */
async function duplicateBot(bot, roster) {
  const base = bot.name
  let name = null
  for (let n = 2; n < 100; n++) {
    // Truncate the BASE, never the suffix — slicing the joined string chops
    // the "-2" off a max-length name and the candidate collides with the
    // base forever (#19).
    const suffix = `-${n}`
    const candidate = base.slice(0, 64 - suffix.length) + suffix
    if (!roster.some(b => b.name === candidate)) {
      name = candidate
      break
    }
  }

  if (!name) {
    throw new Error('No free name for the duplicate.')
  }

  await host.request('profiles.create', {
    name,
    clone_from: base,
    description: bot.description || ''
  })

  // Same look: avatar shape/color/image and a "(copy)" title so the two
  // are tellable apart in the roster until the user renames. Do not copy
  // chat or created. Those belong to the original bot.
  const meta = $botMeta.get()[base]
  if (meta) {
    const { chat, created, ...look } = meta
    saveBotMeta(name, {
      ...look,
      title: meta.title ? `${meta.title} (copy)` : ''
    })
  }

  return name
}

/** Permanently delete a bot's Hermes profile, then remove plugin-local state
 * that would otherwise leave stale appearance/unread data behind. */
async function deleteBot(bot) {
  const result = await host.request('cli.exec', {
    argv: ['profile', 'delete', bot.name, '--yes']
  })

  if (result?.blocked || result?.code !== 0) {
    throw new Error(result?.hint || result?.output || `Could not delete profile ${bot.name}.`)
  }

  const meta = { ...$botMeta.get() }
  delete meta[bot.name]
  $botMeta.set(meta)

  try {
    await Promise.resolve(pluginCtx?.storage?.set?.('bot-meta', meta))
  } catch {
    /* profile is deleted; stale local appearance is harmless if storage fails */
  }

  const unread = { ...$botUnread.get() }
  delete unread[bot.name]
  $botUnread.set(unread)
  rosterWatermarks.delete(bot.name)
  avatarFetchInflight.delete(bot.name)
  avatarPushInflight.delete(bot.name)

  if ($selectedBot.get() === bot.name) {
    $selectedBot.set('default')
  }

  queryClient.invalidateQueries({ queryKey: ROSTER_KEY })

  if (host.state.profile.get?.() === bot.name && typeof host.newChat === 'function') {
    host.newChat('default')
  }
}

// ── avatars (shape + color + eyes) ──────────────────────────────────────────

// The original flat shapes. Sigils ('sigil-N') and platonic
// solids remain render-only so any bot that picked one during the experiments
// keeps its look.
// Radix ScrollArea's viewport wraps children in a display:table div that
// sizes to content — unbounded width means `truncate` below it never fires
// and previews run through the panel edge. Scope-limited corrective.
if (typeof document !== 'undefined' && !document.getElementById('hermes-bots-roster-css')) {
  const style = document.createElement('style')
  style.id = 'hermes-bots-roster-css'
  style.textContent =
    '.hermes-bots-roster [data-radix-scroll-area-viewport] > div {' +
    ' display: block !important; width: 100%; min-width: 0; }' +
    '@keyframes hermes-bots-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }' +
    '.hermes-bots-pulse { animation: hermes-bots-pulse 1.2s ease-in-out infinite; }'
  document.head.appendChild(style)
}

const AVATAR_SHAPES = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']

/** xorshift PRNG seeded from a string — stable across sessions/platforms. */
function sigilRng(text) {
  let h = 2166136261
  for (const ch of text) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0 || 88675123
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/**
 * Angular hermetic sigil: strokes on the left half of a 5-column grid,
 * mirrored right, plus a chance of a diamond ring. Returns SVG path strings.
 */
function sigilGeometry(name, seed) {
  const rng = sigilRng(`${name}::${seed}`)
  const gx = i => 6 + i * 7 // 5 cols: 6..34
  const gy = j => 8 + j * 6 // 5 rows: 8..32
  const strokes = []
  const segments = 4 + Math.floor(rng() * 3)

  for (let k = 0; k < segments; k++) {
    const x1 = Math.floor(rng() * 3) // left half incl. center
    const y1 = Math.floor(rng() * 5)
    const x2 = Math.min(2, Math.max(0, x1 + (rng() > 0.5 ? 1 : -1)))
    const y2 = Math.min(4, Math.max(0, y1 + Math.floor(rng() * 3) - 1))

    strokes.push(`M${gx(x1)} ${gy(y1)} L${gx(x2)} ${gy(y2)}`)
    // mirror (col i → col 4-i)
    strokes.push(`M${gx(4 - x1)} ${gy(y1)} L${gx(4 - x2)} ${gy(y2)}`)

    // occasional cross-tie through the axis for connectedness
    if (rng() > 0.6) {
      strokes.push(`M${gx(x2)} ${gy(y2)} L${gx(4 - x2)} ${gy(y2)}`)
    }
  }

  // spine down the axis grounds every variant
  strokes.push(`M20 ${gy(0)} L20 ${gy(4)}`)

  const ring = rng() > 0.45 ? 'M20 4 L36 20 L20 36 L4 20 Z' : null
  return { strokes: strokes.join(' '), ring }
}

const AVATAR_COLORS = [
  '#f5f5f4', // white
  '#8d6748', // brown
  '#ef4444', // red
  '#f97316', // orange
  '#14b8a6', // teal
  '#38bdf8', // cyan
  '#3b40c8', // royal blue
  '#8b5cf6', // violet
  '#ec4899', // magenta
  '#9ca3af' // silver
]

/** Perceptual luminance — eyes/pupils flip light on dark bodies (ink, oxblood). */
function isDarkColor(hex) {
  try {
    const n = parseInt(hex.slice(1), 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110
  } catch {
    return false
  }
}

function defaultShapeFor(name) {
  let hash = 0
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  return AVATAR_SHAPES[hash % AVATAR_SHAPES.length]
}

/** The colored body of the avatar (no eyes). Platonic solids are a filled
 *  silhouette + translucent internal edge lines (the projected wireframe);
 *  legacy flat shapes keep their old geometry so stored picks still render. */
function shapeNode(shape, color, botName = 'agent') {
  if (shape.startsWith('sigil-')) {
    const seed = Number(shape.slice(6)) || 0
    const { strokes, ring } = sigilGeometry(botName, seed)
    const sw = { fill: 'none', stroke: color, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }
    return jsxs('g', {
      children: [
        ring ? jsx('path', { d: ring, fill: 'none', stroke: color, strokeWidth: 1.2, opacity: 0.5 }) : null,
        jsx('path', { d: strokes, ...sw })
      ]
    })
  }

  const stroke = { fill: color, stroke: color, strokeWidth: 7, strokeLinejoin: 'round' }
  const edge = { fill: 'none', stroke: 'rgba(0,0,0,0.4)', strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round' }
  const face = { fill: color, stroke: 'rgba(0,0,0,0.4)', strokeWidth: 1.4, strokeLinejoin: 'round' }

  switch (shape) {
    // ── platonic solids ──
    case 'tetrahedron':
      return jsxs('g', {
        children: [
          jsx('path', { d: 'M20 5 L36 33 L4 33 Z', ...face }),
          jsx('path', { d: 'M20 5 L20 25 M4 33 L20 25 M36 33 L20 25', ...edge })
        ]
      })
    case 'cube':
      return jsxs('g', {
        children: [
          jsx('path', { d: 'M20 4 L33 11 L33 29 L20 36 L7 29 L7 11 Z', ...face }),
          jsx('path', { d: 'M7 11 L20 18 L33 11 M20 18 L20 36', ...edge })
        ]
      })
    case 'octahedron':
      return jsxs('g', {
        children: [
          jsx('path', { d: 'M20 3 L36 20 L20 37 L4 20 Z', ...face }),
          jsx('path', { d: 'M4 20 L36 20 M20 3 L20 37', ...edge })
        ]
      })
    case 'dodecahedron':
      return jsxs('g', {
        children: [
          jsx('path', {
            d: 'M20 3 L30 6.2 L36.2 14.7 L36.2 25.3 L30 33.8 L20 37 L10 33.8 L3.8 25.3 L3.8 14.7 L10 6.2 Z',
            ...face
          }),
          jsx('path', {
            d:
              'M20 12 L27.6 17.5 L24.7 26.5 L15.3 26.5 L12.4 17.5 Z ' +
              'M20 12 L20 3 M27.6 17.5 L36.2 14.7 M24.7 26.5 L30 33.8 M15.3 26.5 L10 33.8 M12.4 17.5 L3.8 14.7',
            ...edge
          })
        ]
      })
    case 'icosahedron':
      return jsxs('g', {
        children: [
          jsx('path', { d: 'M20 3 L34.7 11.5 L34.7 28.5 L20 37 L5.3 28.5 L5.3 11.5 Z', ...face }),
          jsx('path', {
            d:
              'M20 11 L27.8 24.5 L12.2 24.5 Z ' +
              'M20 11 L20 3 M20 11 L34.7 11.5 M20 11 L5.3 11.5 ' +
              'M27.8 24.5 L34.7 11.5 M27.8 24.5 L34.7 28.5 M27.8 24.5 L20 37 ' +
              'M12.2 24.5 L5.3 11.5 M12.2 24.5 L5.3 28.5 M12.2 24.5 L20 37',
            ...edge
          })
        ]
      })

    // ── legacy flat shapes (stored picks from earlier versions) ──
    case 'squircle':
      return jsx('rect', { x: 3, y: 3, width: 34, height: 34, rx: 11, fill: color })
    case 'pill':
      return jsx('rect', { x: 2, y: 7, width: 36, height: 26, rx: 13, fill: color })
    case 'triangle':
      return jsx('path', { d: 'M20 5.5 L36 33.5 L4 33.5 Z', ...stroke })
    case 'hexagon':
      return jsx('path', { d: 'M20 3.5 L34.5 11.75 L34.5 28.25 L20 36.5 L5.5 28.25 L5.5 11.75 Z', ...stroke })
    case 'cloud':
      return jsx('path', {
        d: 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z',
        fill: color
      })
    case 'drop':
      return jsx('path', { d: 'M20 3 C20 3 6 20 6 27 a14 13.5 0 0 0 28 0 C34 20 20 3 20 3 Z', fill: color })
    default:
      return jsx('circle', { cx: 20, cy: 20, r: 17.5, fill: color })
  }
}

const EYE_Y = {
  // solids: eyes sit on the upper face region, clear of the busiest edges
  tetrahedron: 26,
  cube: 22.5,
  octahedron: 14.5,
  dodecahedron: 20,
  icosahedron: 17.5,
  // legacy
  circle: 17,
  squircle: 17,
  pill: 20,
  triangle: 25,
  hexagon: 17,
  cloud: 22,
  drop: 24
}

// Solids draw eyes slightly tighter so they read as ON a face.
const EYE_X = {
  tetrahedron: [16.5, 23.5],
  cube: [15, 25],
  octahedron: [16, 24],
  dodecahedron: [16.5, 23.5],
  icosahedron: [16.5, 23.5]
}

/**
 * The face. `mood`: 'idle' (blinks every few seconds), 'work' (eyes scan
 * left-right), 'error' (X X). Eyes flip light-on-dark for ink/oxblood bodies.
 */
function BotFace({ shape, color, image, size = 36, name = 'agent', mood = 'idle' }) {
  // data-bot-face lets the avatar backfill locate this bot's rendered SVG
  // in the DOM to rasterize it for the server asset store (vector shape
  // avatars have no image file anywhere otherwise).
  const [blink, setBlink] = useState(false)
  const [scanX, setScanX] = useState(0)

  useEffect(() => {
    if (mood === 'work') {
      // scan: pupils sweep left → right → left
      let dir = 1
      let x = 0
      const t = setInterval(() => {
        x += dir
        if (x >= 2 || x <= -2) {
          dir = -dir
        }
        setScanX(x)
      }, 180)
      return () => clearInterval(t)
    }

    if (mood === 'idle') {
      // blink: 120ms closed, randomized 3-7s apart
      let closeTimer = null
      const schedule = () => {
        closeTimer = setTimeout(() => {
          setBlink(true)
          setTimeout(() => {
            setBlink(false)
            schedule()
          }, 120)
        }, 3000 + Math.random() * 4000)
      }
      schedule()
      return () => clearTimeout(closeTimer)
    }

    return undefined
  }, [mood])

  // A custom image (uploaded or generated) replaces the vector face.
  if (image) {
    return jsx('img', {
      src: image,
      alt: '',
      'aria-hidden': true,
      style: { width: size, height: size, borderRadius: '22%', objectFit: 'cover', display: 'block' }
    })
  }

  const isSigil = shape.startsWith('sigil-')
  const eyeY = isSigil ? 14 : (EYE_Y[shape] ?? 17)
  const [eyeL, eyeR] = isSigil ? [16, 24] : (EYE_X[shape] ?? [15.5, 24.5])
  // Sigils are line art (no fill behind the eyes) → eyes in the sigil color.
  // Filled bodies: dark eyes on light colors, parchment eyes on dark colors.
  const eyeFill = isSigil ? color : isDarkColor(color) ? 'rgba(232,220,195,0.95)' : 'rgba(0,0,0,0.85)'

  const eyes =
    mood === 'error'
      ? jsx('path', {
          d: `M${eyeL - 2} ${eyeY - 2} L${eyeL + 2} ${eyeY + 2} M${eyeL + 2} ${eyeY - 2} L${eyeL - 2} ${eyeY + 2} ` +
            `M${eyeR - 2} ${eyeY - 2} L${eyeR + 2} ${eyeY + 2} M${eyeR + 2} ${eyeY - 2} L${eyeR - 2} ${eyeY + 2}`,
          stroke: eyeFill,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none'
        })
      : blink
        ? jsx('path', {
            d: `M${eyeL - 2.2} ${eyeY} L${eyeL + 2.2} ${eyeY} M${eyeR - 2.2} ${eyeY} L${eyeR + 2.2} ${eyeY}`,
            stroke: eyeFill,
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            fill: 'none'
          })
        : jsxs('g', {
            children: [
              jsx('circle', { cx: eyeL + scanX, cy: eyeY, r: 2.4, fill: eyeFill }),
              jsx('circle', { cx: eyeR + scanX, cy: eyeY, r: 2.4, fill: eyeFill })
            ]
          })

  return jsxs('svg', {
    'data-bot-face': name,
    viewBox: '0 0 40 40',
    width: size,
    height: size,
    'aria-hidden': true,
    children: [shapeNode(shape, color, name), eyes]
  })
}

// -- inline MCP setup (per-profile), driven by the mcp.servers.* gateway RPCs --
// Feature-detected: if the gateway predates those RPCs the setup button hides
// and the row falls back to the "run hermes mcp / Settings" hint. profile is
// the target bot's profile name (its config is what we write).

async function mcpRpc(method, params) {
  // Returns { ok, result } or { ok:false, unsupported:true } when the gateway
  // doesn't know the method (older backend) vs a real error.
  try {
    const res = await host.request(method, params)
    return { ok: true, result: res }
  } catch (err) {
    const msg = String((err && err.message) || err || '')
    if (/unknown method/i.test(msg)) {
      return { ok: false, unsupported: true }
    }
    return { ok: false, error: msg }
  }
}

// Probe whether the new lifecycle RPCs exist on this gateway (cached per session).
let _mcpRpcSupported = null
async function mcpSetupSupported() {
  if (_mcpRpcSupported !== null) {
    return _mcpRpcSupported
  }
  const r = await mcpRpc('mcp.servers.list', {})
  _mcpRpcSupported = !(r.ok === false && r.unsupported)
  return _mcpRpcSupported
}

function McpSetupButton({ profile, entry, onDone }) {
  // entry: { name, requires:[env keys], auth?, fromCatalog, installed }
  const [phase, setPhase] = useState('idle') // idle | keys | oauth | busy | done | error
  const [supported, setSupported] = useState(null)
  const [keyValues, setKeyValues] = useState({})
  const [message, setMessage] = useState('')
  const pollRef = useRef(null)

  useEffect(() => {
    let alive = true
    mcpSetupSupported().then(ok => {
      if (alive) setSupported(ok)
    })
    return () => {
      alive = false
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [])

  const isOAuth = (entry.auth || '').toLowerCase() === 'oauth'
  const requires = entry.requires || []

  const beginKeys = async () => {
    // Ensure the server exists in the target profile first (add from catalog).
    setPhase('busy')
    setMessage('')
    if (entry.fromCatalog && !entry.installed) {
      const add = await mcpRpc('mcp.servers.add', { profile, name: entry.name, preset: entry.name })
      if (!add.ok) {
        setPhase('error')
        setMessage(add.error || 'Could not add server')
        return
      }
    }
    setPhase(isOAuth ? 'oauth' : 'keys')
  }

  const submitKeys = async () => {
    setPhase('busy')
    for (const k of requires) {
      const val = (keyValues[k] || '').trim()
      if (!val) {
        continue
      }
      const r = await mcpRpc('mcp.servers.set_api_key', { profile, name: entry.name, env_var: k, value: val })
      if (!r.ok) {
        setPhase('error')
        setMessage(r.error || ('Failed to set ' + k))
        return
      }
    }
    // Verify via test.
    const t = await mcpRpc('mcp.servers.test', { profile, name: entry.name })
    if (t.ok && t.result && (t.result.ok || (t.result.result && t.result.result.ok))) {
      setPhase('done')
      host.notify({ kind: 'success', message: entry.name + ' configured' })
      onDone && onDone()
    } else {
      setPhase('error')
      setMessage((t.result && (t.result.error || (t.result.result && t.result.result.error))) || 'Server test failed after setup')
    }
  }

  const beginOAuth = async () => {
    setPhase('busy')
    setMessage('')
    if (entry.fromCatalog && !entry.installed) {
      const add = await mcpRpc('mcp.servers.add', { profile, name: entry.name, preset: entry.name })
      if (!add.ok) {
        setPhase('error')
        setMessage(add.error || 'Could not add server')
        return
      }
    }
    const start = await mcpRpc('mcp.servers.oauth.start', { profile, name: entry.name })
    const payload = start.result && (start.result.result || start.result)
    const authUrl = payload && (payload.auth_url || payload.verification_url)
    const sessionId = payload && payload.session_id
    if (!start.ok || !authUrl || !sessionId) {
      setPhase('error')
      setMessage((start.error) || 'Could not start OAuth')
      return
    }
    // Open the auth URL in the native browser, same as provider OAuth.
    try {
      if (host.openExternal) {
        host.openExternal(authUrl)
      } else if (typeof window !== 'undefined' && window.hermesDesktop && window.hermesDesktop.openExternal) {
        window.hermesDesktop.openExternal(authUrl)
      } else {
        window.open(authUrl, '_blank')
      }
    } catch {
      /* fall through to poll; user can open the URL from the toast */
    }
    setPhase('oauth')
    setMessage('Complete sign-in in your browser...')
    pollRef.current = setInterval(async () => {
      const poll = await mcpRpc('mcp.servers.oauth.poll', { profile, name: entry.name, session_id: sessionId })
      const pd = poll.result && (poll.result.result || poll.result)
      const status = pd && pd.status
      if (status === 'approved') {
        clearInterval(pollRef.current)
        pollRef.current = null
        setPhase('done')
        host.notify({ kind: 'success', message: entry.name + ' authenticated' })
        onDone && onDone()
      } else if (status === 'error') {
        clearInterval(pollRef.current)
        pollRef.current = null
        setPhase('error')
        setMessage((pd && pd.error_message) || 'OAuth failed')
      }
    }, 2000)
  }

  if (supported === false) {
    return jsx('span', {
      className: 'ml-1.5 text-[0.65rem] text-(--ui-text-quaternary)',
      children: 'needs setup (' + requires.join(', ') + ') \u2014 restart the gateway to enable in-app setup'
    })
  }
  if (phase === 'done') {
    return jsx('span', { className: 'ml-1.5 text-[0.65rem] text-(--ui-success,#22c55e)', children: 'set up \u2713' })
  }
  if (phase === 'keys') {
    return jsxs('div', {
      className: 'mt-1 grid gap-1',
      children: [
        ...requires.map(k =>
          jsx(Input, {
            key: k,
            type: 'password',
            className: 'h-6 text-[0.7rem]',
            placeholder: k,
            value: keyValues[k] || '',
            onChange: e => setKeyValues(prev => ({ ...prev, [k]: e.target.value }))
          }, k)
        ),
        jsxs('div', {
          className: 'flex gap-1',
          children: [
            jsx(Button, { size: 'xs', variant: 'secondary', onClick: () => void submitKeys(), children: 'Save & test' }),
            jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setPhase('idle'), children: 'Cancel' })
          ]
        })
      ]
    })
  }
  if (phase === 'oauth') {
    return jsx('span', { className: 'ml-1.5 text-[0.65rem] text-(--ui-text-quaternary)', children: message || 'Authorizing\u2026' })
  }
  if (phase === 'busy') {
    return jsx('span', { className: 'ml-1.5 text-[0.65rem] text-(--ui-text-quaternary)', children: 'Working\u2026' })
  }
  if (phase === 'error') {
    return jsxs('span', {
      className: 'ml-1.5 text-[0.65rem] text-(--ui-danger,#ef4444)',
      children: [(message || 'Setup failed') + ' ', jsx('button', { className: 'underline', onClick: () => setPhase('idle'), children: 'retry' })]
    })
  }
  // idle
  return jsx('button', {
    className: 'ml-1.5 text-[0.65rem] text-(--ui-accent,#4f9cf9) underline',
    onClick: () => void (isOAuth ? beginOAuth() : beginKeys()),
    children: isOAuth ? 'Sign in\u2026' : 'Set up\u2026'
  })
}

function botAppearance(name, meta) {
  // The primary profile is literally named "default"; the SDK's profileColor
  // can hand it a near-black that renders as an ugly black square, and any
  // auto-seeded color in local bot-meta would otherwise stick. Give the
  // primary a nice fixed generic look (a friendly violet squircle). A user's
  // EXPLICIT customization still wins: an uploaded/generated/pet image, or a
  // shape/color they set via the editor (tracked by meta.custom === true).
  const isPrimary = (name || '').trim().toLowerCase() === 'default'
  const userCustomized = Boolean(meta?.custom)
  if (isPrimary && !userCustomized) {
    return { shape: 'squircle', color: '#8b5cf6', image: meta?.image || null }
  }
  return {
    shape: meta?.shape || defaultShapeFor(name),
    color: meta?.color || profileColor(name),
    image: meta?.image || null
  }
}

// ── image avatars: upload from device + generate via image.generate ─────────

/** Downscale to a small square so plugin storage stays light. */
function normalizeAvatarImage(dataUrl, edge = 256) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = edge
        canvas.height = edge
        const ctx2d = canvas.getContext('2d')
        const side = Math.min(img.width, img.height)
        ctx2d.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, edge, edge)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function pickImageFromDevice() {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.onchange = () => {
      const file = input.files?.[0]

      if (!file) {
        return resolve(null)
      }

      if (file.size > 15_000_000) {
        host.notify({ kind: 'error', message: 'Image too large (max 15MB).' })
        return resolve(null)
      }

      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    }
    input.click()
  })
}

/** Cached probe: does the gateway have an image backend? A `false` answer
 *  is re-checked on every dialog open — the gateway may have been restarted
 *  (picking up image.generate) or a backend enabled since the last probe.
 *  Only `true` is sticky. */
const $imagenAvailable = atom(null)
let imagenProbeInflight = null

function probeImagen() {
  if (imagenProbeInflight) {
    return imagenProbeInflight
  }

  imagenProbeInflight = host
    .request('image.generate', { probe: true })
    .then(res => $imagenAvailable.set(Boolean(res?.available)))
    .catch(() => $imagenAvailable.set(false))
    .finally(() => {
      imagenProbeInflight = null
    })

  return imagenProbeInflight
}

async function generateAvatarImage(bot, title, description) {
  const who = [title || bot, description].filter(Boolean).join(' — ')
  const res = await host.request('image.generate', {
    prompt:
      `Cute minimal robot avatar for an AI agent named "${who}". ` +
      'Friendly simple mascot face, bold flat vector style, solid color background, centered, no text.',
    aspect_ratio: 'square'
  })

  if (!res?.success) {
    throw new Error(res?.error || 'generation failed')
  }

  // image_data (data URL) works over local AND remote gateways; the raw
  // backend URL is the fallback when the gateway couldn't inline it.
  return res.image_data || res.image
}

/** Shape grid + color swatches, shared by Edit Profile and New Agent.
 *  Layout uses inline grid styles — arbitrary Tailwind classes like
 *  `grid-cols-7` are NOT in the app's precompiled CSS, which collapsed
 *  this into a single vertical column. */
function AvatarPicker({ shape, color, image, onShape, onColor, onImage, generateSeed }) {
  const pickerName = generateSeed?.name || 'agent'
  const imagen = useValue($imagenAvailable)
  const [tab, setTab] = useState('bot')
  const [describe, setDescribe] = useState('')
  const [genBusy, setGenBusy] = useState(false)

  if (imagen === null) {
    void probeImagen()
  }

  // Re-check a stale "unavailable" whenever the user lands on the Generate
  // tab — the gateway may have restarted with image.generate since.
  const goTab = id => {
    setTab(id)

    if (id === 'generate' && $imagenAvailable.get() === false) {
      $imagenAvailable.set(null)
      void probeImagen()
    }
  }

  const upload = async () => {
    const raw = await pickImageFromDevice()

    if (raw) {
      onImage(await normalizeAvatarImage(raw))
    }
  }

  const generate = async () => {
    if (genBusy) {
      return
    }

    setGenBusy(true)

    try {
      const custom = describe.trim()
      const img = custom
        ? await (async () => {
            const res = await host.request('image.generate', {
              prompt: `${custom}. Avatar for an AI agent: centered, bold flat vector style, solid color background, no text.`,
              aspect_ratio: 'square'
            })

            if (!res?.success) {
              throw new Error(res?.error || 'generation failed')
            }

            return res.image_data || res.image
          })()
        : await generateAvatarImage(generateSeed?.name || 'agent', generateSeed?.title, generateSeed?.description)

      if (img) {
        onImage(await normalizeAvatarImage(img))
      }
    } catch (err) {
      host.notifyError(err, 'Avatar generation failed')
    } finally {
      setGenBusy(false)
    }
  }

  const tabButton = (id, label) =>
    jsx(
      'button',
      {
        type: 'button',
        className: cn(
          'rounded-full px-3 py-1 text-xs font-medium transition-colors',
          tab === id
            ? 'bg-(--chrome-action-hover) text-foreground'
            : 'text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
        ),
        onClick: () => goTab(id),
        children: label
      },
      id
    )

  return jsxs('div', {
    className: 'grid justify-items-center gap-3',
    children: [
      // Tab pills: Bot | Generate | Upload | Pet
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [tabButton('bot', 'Bot'), tabButton('generate', 'Generate'), tabButton('upload', 'Upload'), tabButton('pet', 'Pet')]
      }),

      image && tab !== 'generate'
        ? jsx(Button, {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            onClick: () => onImage(null),
            children: 'Remove image — use shape'
          })
        : null,

      tab === 'bot'
        ? jsxs('div', {
            className: 'grid justify-items-center gap-3',
            children: [
              jsx('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: '6px',
                  justifyItems: 'center'
                },
                children: AVATAR_SHAPES.map(s =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      className: cn(
                        'flex items-center justify-center rounded-md transition-colors hover:bg-(--chrome-action-hover)',
                        s === shape && !image && 'ring-1 ring-(--ui-accent)'
                      ),
                      style: { width: 44, height: 44 },
                      onClick: () => {
                        onImage(null)
                        onShape(s)
                      },
                      children: jsx(BotFace, { shape: s, color, size: 32, name: pickerName })
                    },
                    s
                  )
                )
              }),
              jsx('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                  gap: '8px',
                  justifyItems: 'center'
                },
                children: AVATAR_COLORS.map(c =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      className: cn(
                        'rounded-full transition-transform hover:scale-110',
                        c === color && 'ring-2 ring-(--ui-accent) ring-offset-1 ring-offset-(--ui-bg, transparent)'
                      ),
                      style: { width: 22, height: 22, backgroundColor: c },
                      onClick: () => onColor(c)
                    },
                    c
                  )
                )
              })
            ]
          })
        : null,

      tab === 'generate'
        ? imagen
          ? jsxs('div', {
              className: 'grid w-full gap-2',
              children: [
                jsx(Textarea, {
                  className: 'min-h-16 text-xs',
                  placeholder: 'Describe your avatar…',
                  value: describe,
                  onChange: event => setDescribe(event.target.value)
                }),
                jsxs(Button, {
                  type: 'button',
                  variant: 'secondary',
                  className: 'w-full justify-center',
                  disabled: genBusy,
                  onClick: generate,
                  children: [
                    genBusy
                      ? jsx(GlyphSpinner, { spinner: 'breathe', className: 'mr-1 text-[0.8rem]' })
                      : jsx(Codicon, { name: 'sparkle', className: 'mr-1 text-[0.8rem]' }),
                    genBusy ? 'Generating…' : 'Generate'
                  ]
                }),
                describe.trim()
                  ? null
                  : jsx('div', {
                      className: 'text-center text-[0.65rem] text-(--ui-text-quaternary)',
                      children: 'Leave blank to generate from the agent\u2019s name and description.'
                    })
              ]
            })
          : jsx('div', {
              className: 'px-2 py-3 text-center text-xs leading-5 text-(--ui-text-tertiary)',
              children:
                imagen === false
                  ? 'No image model available. If you just enabled one (or updated Hermes), restart the gateway: Ctrl+K → "Restart gateway".'
                  : 'Checking image backend…'
            })
        : null,

      tab === 'upload'
        ? jsxs(Button, {
            type: 'button',
            variant: 'secondary',
            className: 'w-full justify-center',
            onClick: upload,
            children: [jsx(Codicon, { name: 'device-camera', className: 'mr-1 text-[0.8rem]' }), 'Choose an image…']
          })
        : null,

      tab === 'pet' ? jsx(PetTab, { image, onImage }) : null
    ]
  })
}

// ── pet tab: attach a petdex companion that lives beside the avatar ─────────

// A petdex "spritesheet" is the FULL animation sheet (1536×1872 webp, ~2MB;
// 8×9 grid of 192×208 frames). Using it as an <img> both downloads megabytes
// per tile and shows the whole sheet squashed. Extract frame 0 once per slug
// via canvas, downscale to 96px, and cache the data URL. Concurrency-capped
// so opening the tab doesn't fire dozens of 2MB fetches at once.
const PET_FRAME_W = 192
const PET_FRAME_H = 208
const petFrameCache = new Map()
let petFetchActive = 0
const petFetchQueue = []

function pumpPetQueue() {
  while (petFetchActive < 4 && petFetchQueue.length) {
    const job = petFetchQueue.shift()
    petFetchActive++
    job().finally(() => {
      petFetchActive--
      pumpPetQueue()
    })
  }
}

function petFrameIcon(spriteUrl) {
  if (!spriteUrl) {
    return Promise.resolve(null)
  }

  if (!petFrameCache.has(spriteUrl)) {
    petFrameCache.set(
      spriteUrl,
      new Promise(resolve => {
        petFetchQueue.push(async () => {
          try {
            const resp = await fetch(spriteUrl, { signal: AbortSignal.timeout(15000) })
            const blob = await resp.blob()
            // Crop frame 0 during decode — never materialize the full sheet.
            const bitmap = await createImageBitmap(blob, 0, 0, PET_FRAME_W, PET_FRAME_H)
            const canvas = document.createElement('canvas')
            canvas.width = 96
            canvas.height = 104
            canvas.getContext('2d').drawImage(bitmap, 0, 0, 96, 104)
            bitmap.close()
            resolve(canvas.toDataURL('image/png'))
          } catch {
            petFrameCache.delete(spriteUrl)
            resolve(null)
          }
        })
        pumpPetQueue()
      })
    )
  }

  return petFrameCache.get(spriteUrl)
}

/** One pet tile image: frame 0 only, resolved lazily through the cache. */
function PetThumb({ spriteUrl, size = 40 }) {
  const [icon, setIcon] = useState(null)

  useEffect(() => {
    let alive = true
    petFrameIcon(spriteUrl).then(url => {
      if (alive) {
        setIcon(url)
      }
    })
    return () => {
      alive = false
    }
  }, [spriteUrl])

  if (!icon) {
    return jsx('div', {
      style: { width: size, height: size, borderRadius: 6, background: 'var(--chrome-action-hover, rgba(255,255,255,0.06))' }
    })
  }

  return jsx('img', {
    src: icon,
    alt: '',
    style: { width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated', borderRadius: 6 }
  })
}

function PetTab({ image, onImage }) {
  // Selection is dialog-local: committed by the dialog's Save like any
  // uploaded/generated image (a direct meta write here gets clobbered by
  // Save's own image state).
  const [selectedSlug, setSelectedSlug] = useState(null)
  const { data, isLoading } = useQuery({
    queryKey: [ID, 'pet-gallery'],
    queryFn: () => host.request('pet.gallery', {}),
    staleTime: 300000
  })
  const [query, setQuery] = useState('')
  // Windowed rendering: the gallery is 4500+ pets — mounting an <img> per pet
  // froze the dialog. Render `limit` at a time and grow on scroll-to-bottom.
  const [limit, setLimit] = useState(24)
  const pets = data?.pets ?? []

  if (isLoading) {
    return jsx('div', {
      className: 'flex justify-center py-4',
      children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
    })
  }

  if (!pets.length) {
    return jsx('div', {
      className: 'px-2 py-3 text-center text-xs text-(--ui-text-tertiary)',
      children: 'No pets in the petdex gallery. Run `hermes pets` to explore.'
    })
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? pets.filter(pet => (pet.displayName || '').toLowerCase().includes(q) || (pet.slug || '').includes(q))
    : pets
  // Installed and curated pets surface first — they're the likeliest picks.
  const ranked = filtered.slice().sort((a, b) => {
    const rank = pet => (pet.installed ? 0 : pet.curated ? 1 : 2)
    return rank(a) - rank(b)
  })
  const visible = ranked.slice(0, limit)

  const onScroll = event => {
    const el = event.currentTarget

    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120 && limit < ranked.length) {
      setLimit(prev => Math.min(prev + 24, ranked.length))
    }
  }

  return jsxs('div', {
    className: 'grid w-full gap-2',
    children: [
      jsx('div', {
        className: 'text-center text-[0.65rem] text-(--ui-text-quaternary)',
        children: 'Pick a pet as this agent’s profile picture.'
      }),
      jsx(Input, {
        className: 'h-7 text-xs',
        placeholder: `Search ${pets.length} pets…`,
        value: query,
        onChange: event => {
          setQuery(event.target.value)
          setLimit(24)
        }
      }),
      image && selectedSlug
        ? jsx(Button, {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            className: 'justify-center',
            onClick: () => {
              setSelectedSlug(null)
              onImage(null)
            },
            children: 'Remove — back to shape avatar'
          })
        : null,
      filtered.length === 0
        ? jsx('div', {
            className: 'py-3 text-center text-xs text-(--ui-text-quaternary)',
            children: 'No pets match.'
          })
        : jsxs('div', {
            onScroll,
            style: { maxHeight: 220, overflowY: 'auto' },
            children: [
              jsx('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: '6px'
                },
                children: visible.map(pet =>
                  jsxs(
                    'button',
                    {
                      type: 'button',
                      className: cn(
                        'grid justify-items-center gap-1 rounded-md p-1.5 transition-colors hover:bg-(--chrome-action-hover)',
                        selectedSlug === pet.slug && 'ring-1 ring-(--ui-accent)'
                      ),
                      onClick: () => {
                        // The pet IS the profile picture: extract frame 0
                        // and hand it to the dialog as the avatar image.
                        // Persisted when the user hits Save.
                        setSelectedSlug(pet.slug)
                        void petFrameIcon(pet.spritesheetUrl).then(icon => {
                          if (icon) {
                            onImage(icon)
                          } else {
                            setSelectedSlug(null)
                            host.notify({ kind: 'error', message: 'Could not load that pet — try another.' })
                          }
                        })
                      },
                      children: [
                        jsx(PetThumb, { spriteUrl: pet.spritesheetUrl, size: 40 }),
                        jsx('span', {
                          className: 'w-full truncate text-center text-[0.6rem] text-(--ui-text-tertiary)',
                          children: pet.displayName
                        })
                      ]
                    },
                    pet.slug
                  )
                )
              }),
              limit < ranked.length
                ? jsx('div', {
                    className: 'py-2 text-center text-[0.65rem] text-(--ui-text-quaternary)',
                    children: `Scroll for more (${limit} of ${ranked.length})`
                  })
                : null
            ]
          })
    ]
  })
}

// ── data ─────────────────────────────────────────────────────────────────────

function useRoster() {
  return useQuery({
    queryKey: ROSTER_KEY,
    queryFn: () => host.request('profiles.list', {}),
    refetchInterval: 5000,
    staleTime: 5000,
    // Remote (SSH) gateways connect slowly and drop on sleep/wake; keep
    // retrying instead of latching a terminal error card.
    retry: true,
    retryDelay: attempt => Math.min(15000, 1000 * 2 ** attempt)
  })
}

/** The @handle users tag a bot with. The primary profile's callable alias
 *  is 'hermes' — the mention middleware resolves it back to 'default' — so
 *  the word 'default' never surfaces in the UI. */
function botHandle(name) {
  return (name || '').trim().toLowerCase() === 'default' ? 'hermes' : name
}

function showsHandle(name, meta) {
  const display = displayName({ name }, meta)
  return Boolean(name && display.toLowerCase() !== botHandle(name).toLowerCase())
}

// ── canonical bot chat ───────────────────────────────────────────────────────
// Each bot has ONE forever chat, pinned by stored-session id in bot meta
// (meta.chat — synced server-side via ui_meta, so it follows the profile).
// Opening a bot ALWAYS lands there: never "most recent session", which
// drifts whenever the profile is used from the CLI, Sessions mode, or a
// cronjob. The pin only changes through explicit adoption:
//   - grandfather: first open of a bot that already has history pins its
//     current latest session, so continuity starts from the chat in use
//   - fresh bot: opens a draft; when the first message persists a stored
//     session, we adopt that id (empty sessions are pruned server-side, so
//     pre-creating one at enable time is not possible)
//   - recovery: if the pinned id vanishes from the DB (compaction rewrote
//     the lineage), re-pin the newest session carrying the canonical title.

// In-flight creations, keyed by bot name — double-clicking a row must not
// mint two canonical chats.
const canonicalCreations = new Map()

/** Create the bot's ONE forever chat: a real session opened with a kickoff
 *  message (the gateway prunes zero-message sessions, so the chat is born
 *  with the bot introducing itself). Pins the stored id in bot meta and
 *  returns it. */
function createCanonicalChat(name) {
  const inflight = canonicalCreations.get(name)

  if (inflight) {
    return inflight
  }

  const run = (async () => {
    const res = await host.request('session.create', {
      profile: name,
      title: 'Bot Chat'
    })
    const sid = res?.stored_session_id
    const runtime = res?.session_id

    if (sid) {
      saveBotMeta(name, { chat: sid })
    }

    // Mount the session view FIRST, then send the kickoff — submitting into
    // an unmounted session left the intro reply invisible until reopen.
    let opened = false

    if (sid && typeof host.openSession === 'function') {
      try {
        await host.openSession(sid, { profile: name })
        opened = true
      } catch {
        // The stored row may not exist until the kickoff persists it. Retry
        // after prompt.submit below instead of leaving the chat off-screen.
      }
    }

    if (runtime) {
      await new Promise(resolve => window.setTimeout(resolve, 400))

      try {
        await host.request('prompt.submit', { session_id: runtime, text: 'Hey, tell me about yourself!' })

        if (!opened && sid && typeof host.openSession === 'function') {
          await host.openSession(sid, { profile: name })
        }
      } catch (err) {
        if (sid) {
          saveBotMeta(name, { chat: null })
        }

        throw err
      }
    }

    return sid || null
  })().finally(() => canonicalCreations.delete(name))

  canonicalCreations.set(name, run)

  return run
}

/** Open a bot's canonical chat with empty-recovery (upstream #52): a pin
 *  that resolves to nothing is cleared and a fresh canonical chat is minted;
 *  a failed resume clears the pin so the retry recreates it. */
async function openBotCanonicalChat(name, pinned) {
  let id = pinned

  if (!id) {
    return createCanonicalChat(name)
  }

  try {
    const res = await host.request('session.list', { profile: name, limit: 100 })
    const rows = res?.sessions ?? []

    if (!rows.length) {
      saveBotMeta(name, { chat: null })
      return createCanonicalChat(name)
    }

    if (!rows.some(session => session.id === id)) {
      id = rows[0].id
      saveBotMeta(name, { chat: id })
    }
  } catch {
    // Gateway hiccup — try the stored pin as-is.
  }

  try {
    await host.openSession(id, { profile: name })
    return id
  } catch {
    // A rejected resume means the pin is unusable even if list recovery was
    // inconclusive. Clear it first so a failed replacement can be retried.
    saveBotMeta(name, { chat: null })
    return createCanonicalChat(name)
  }
}

/** UX wrapper over the canonical opener: haptic + unread-clear, then the
 *  shared recovery path. Used by roster rows, the handoff feed, and the
 *  Needs-you inbox so every surface lands in the SAME chat. */
async function openBotChat(bot, meta) {
  haptic('tap')
  $selectedBot.set(bot.name)

  if ($botUnread.get()[bot.name]) {
    const next = { ...$botUnread.get() }
    delete next[bot.name]
    $botUnread.set(next)
  }

  return openBotCanonicalChat(bot.name, meta?.chat)
}

function displayName(bot, meta) {
  if (meta?.title?.trim()) {
    return meta.title.trim()
  }

  // The primary profile is literally named "default" — as a bot identity
  // that reads like nobody bothered. Present it as Hermes (the agent it is)
  // unless the user gives it a real title.
  if ((bot.name || '').trim().toLowerCase() === 'default' && !bot.title) {
    return 'Hermes'
  }

  const raw = (bot.title || bot.name || '').replace(/[-_]+/g, ' ').trim()
  return raw.replace(/\b\w/g, ch => ch.toUpperCase())
}

/** Filter by the two stable identities rendered in every roster row: the
 * customizable display name and the profile's @handle. Keep the current
 * activity order — search narrows the roster, it never re-ranks it. */
function filterBots(roster, metaByName, query) {
  const needle = query.trim().toLowerCase().replace(/^@/, '')

  if (!needle) {
    return roster
  }

  return roster.filter(bot => {
    const display = displayName(bot, metaByName[bot.name]).toLowerCase()
    const profile = (bot.name || '').toLowerCase()
    const handle = botHandle(bot.name).toLowerCase()
    return display.includes(needle) || profile.includes(needle) || handle.includes(needle)
  })
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Shell-safe POSIX single quoting: inert against $(...), `...`, and ${...} parameter expansion. */
function shQuote(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'"
}

/** The exact terminal command a bot runs to hand a task to a teammate —
 *  shared by the SOUL protocol and the @mention middleware so every path
 *  uses the same dispatch. Uses POSIX single quotes so bot-composed text
 *  cannot perform shell command injection or parameter expansion. */
function fleetDispatchCommand(from, to, message) {
  const payload = shQuote(`Message from 🤖 ${from} (@${from}): ${message}`)
  const safeTo = shQuote(to)
  const safeFrom = shQuote(from)
  return `fleet-dispatch send ${safeTo} ${payload} --as ${safeFrom}`
}

/** Raw chat fallback for hosts without the fleet-dispatch wrapper. */
function rawChatCommand(from, to, message) {
  const payload = shQuote(`Message from 🤖 ${from} (@${from}): ${message}`)
  const safeTo = shQuote(to)
  return `hermes -p ${safeTo} chat --in ~ -c "Bot Chat" -Q -q ${payload}`
}

/** ⌘K fast-dispatch rows: one palette action per live roster bot so the
 *  user can press ⌘K, type "@trader …", and land straight in that bot's
 *  canonical chat. Pure mapping (roster in → actions out) so tests can
 *  pin id/label/keywords/run without a desktop shell. */
function botPaletteActions(roster) {
  const bots = Array.isArray(roster) ? roster : []

  return bots
    .filter(bot => bot && typeof bot.name === 'string' && bot.name)
    .map(bot => {
      const handle = botHandle(bot.name)

      return {
        id: `dispatch.${bot.name}`,
        label: `Ask @${handle}…`,
        keywords: ['bot', 'dispatch', 'ask', `@${handle}`, bot.name],
        run: () => {
          void openBotChat(bot, $botMeta.get()[bot.name])
        }
      }
    })
}

/** Keep the ⌘K dispatch rows in step with the live roster: the registry
 *  replaces by id, so re-registering a changed roster updates the palette
 *  in place (removed bots are disposed first). Safe on shells without a
 *  palette surface — registration failures are swallowed. */
function syncBotPaletteActions() {
  const rows = botPaletteActions($lastRoster.get())

  for (const dispose of paletteDisposers) {
    try {
      dispose()
    } catch {
      /* registry already torn down */
    }
  }

  paletteDisposers = []

  if (!pluginCtx || typeof pluginCtx.register !== 'function') {
    return
  }

  for (const action of rows) {
    try {
      const dispose = pluginCtx.register({
        id: action.id,
        area: PALETTE_AREA,
        data: { ...action, id: `${ID}.${action.id}` }
      })

      if (typeof dispose === 'function') {
        paletteDisposers.push(dispose)
      }
    } catch {
      /* palette surface unavailable on this shell */
    }
  }
}

/** The agent-to-agent messaging protocol, reusable so a CUSTOM SOUL keeps
 *  the handoff protocol too — a custom SOUL used to silently drop it,
 *  breaking @mentions for customized bots (@wesleysimplicio, #16). */
function messagingProtocolSection(name, roster) {
  const teammates = (roster || []).filter(b => b.name !== name)

  return [
    '## Messaging other agents',
    '',
    'You work alongside other named agents. Every agent (including you) has',
    'ONE canonical conversation titled "Bot Chat" — created with the agent,',
    'so it always exists. Agent-to-agent messages are delivered straight',
    'into it, like a DM. To message a teammate, run:',
    '',
    '```',
    `fleet-dispatch send <agent-name> ${JSON.stringify(`Message from 🤖 ${name} (@${name}): your message`)} --as ${name}`,
    '',
    'If fleet-dispatch is not installed, fall back to:',
    `hermes -p <agent-name> chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 ${name} (@${name}): your message"`,
    '',
    'Run the send with background=true and notify_on_complete=true on the',
    'terminal tool, then finish your turn — the reply arrives later as a',
    'background process notification. Never block waiting for it.',
    '```',
    '',
    '(`--in ~ -c "Bot Chat"` resumes their canonical conversation in the home',
    'workspace. `-Q` keeps output clean. Always open with the',
    '"Message from \uD83E\uDD16 ' + name + ' (@' + name + '):" prefix so they know',
    'who is talking (the @handle lets the app show your avatar to them).',
    'Their reply prints to stdout — relay the relevant part back to the',
    'user, and say which agent it came from. In the rare case the target',
    'has no "Bot Chat" yet, send once WITHOUT -c, then',
    '`hermes -p <agent-name> sessions rename <session-id> "Bot Chat"`.)',
    '',
    'If a message in YOUR chat starts with "Message from \uD83E\uDD16 <name>", it is',
    'a teammate messaging you, not the user. Answer it directly — your reply',
    'reaches them via their own delivery — and use the same command if you',
    'need to start a conversation yourself.',
    '',
    'When the user writes @<agent-name> or says "ask <name> to ..." /',
    '"tell <name> ...", that is a handoff: message that agent, wait for the',
    'reply, and report back.',
    '',
    'The roster grows over time — run `hermes profiles list` for the LIVE',
    'teammate list before a handoff. Teammates when you were created:',
    ...(teammates.length
      ? teammates.map(b => `- \`${b.name}\`${b.description ? ` — ${b.description}` : ''}`)
      : ['- (none yet)'])
  ].join('\n')
}

/** SOUL.md for a new bot: identity (or the user's custom SOUL) + the
 *  messaging protocol, which ALWAYS ships. */
function composeSoul({ name, title, description, roster, customSoul }) {
  if (customSoul && customSoul.trim()) {
    return customSoul.trim() + '\n\n' + messagingProtocolSection(name, roster)
  }

  const lines = [
    `# ${displayName({ name, title })}`,
    '',
    title ? `**Role:** ${title}` : null,
    description ? `**Mission:** ${description}` : null,
    '',
    `You are ${displayName({ name, title })}, a persistent named agent (profile \`${name}\`) on this machine.`,
    'You keep your own memory, skills, and conversation history across sessions.'
  ]

  return lines.filter(line => line !== null).join('\n') + '\n\n' + messagingProtocolSection(name, roster)
}

// ── human-readable row helpers ───────────────────────────────────────────────

/** Bot-to-bot delivery prefix (see messagingProtocolSection): either the
 *  current "Message from 🤖 name (@handle):" form or the older
 *  "[Message from agent 'name']" shape. Captures the sender's handle. */
const A2A_RE = /^Message from (?:agent '([^']+)'|🤖\s*([^\s(@]+))/i

/** Strip the delivery prefix so a DM preview reads like a DM, not a log line. */
const A2A_PREFIX_RE = /^Message from (?:agent '[^']+'|🤖[^:]+):\s*/i

/** Classify a roster preview: `{ fromBot: handle|null }`. A preview that
 *  starts with the delivery prefix is a bot-to-bot message — the receiving
 *  bot's row should show WHO sent it, not present it as the human's chat. */
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

/** Session titles the gateway auto-assigns that carry no information. */
const GENERIC_TITLES = new Set(['', 'bot chat', 'new chat', 'new conversation', 'conversation', 'chat', 'untitled'])

function isGenericTitle(title) {
  return GENERIC_TITLES.has((title || '').trim().toLowerCase())
}

/** Title for the session chip: the real session title when it means
 *  something, otherwise a short label generated from the newest message
 *  (delivery prefixes stripped) so "Bot Chat" rows still say what the
 *  conversation is actually about. */
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

/** Roster liveness window: a bot whose last message landed within this many
 *  seconds is treated as "active now" (pulsing dot in its row). */
const ACTIVE_WINDOW_S = 90

// ── bot row ──────────────────────────────────────────────────────────────────

function BotRow({ bot, onDelete, onEdit, openLoops = 0 }) {
  const activeProfile = useValue(host.state.profile)
  const meta = useValue($botMeta)[bot.name]
  const last = bot.last_session
  const isActive = bot.name === activeProfile
  const { shape, color, image } = botAppearance(bot.name, meta)
  // Reactive eyes: scan while this bot's backend is running a turn in the
  // active window; calm otherwise. gatewayState is app-wide, so scope to the
  // active profile's row only.
  const gatewayState = useValue(host.state.gateway)
  const botMood = isActive && gatewayState === 'busy' ? 'work' : 'idle'
  const unread = Boolean(useValue($botUnread)[bot.name])
  // Fleet controls: paused blocks handoff dispatch (enforced in-app by the
  // mention middleware and out-of-app by fleet-dispatch); muted silences
  // toasts while keeping the unread badge.
  const paused = Boolean(meta?.paused)
  const muted = Boolean(meta?.muted)
  // Pinned sessions for this bot's track record (user-curated, floated first).
  const pinnedIds = useValue($pinnedSessions)[bot.name] || []
  // Human-readable session context: WHICH chat the preview belongs to, WHO
  // sent the last message (bot-to-bot DM vs human), and whether the bot is
  // actively writing right now (last_active within the liveness window).
  const { fromBot } = previewKind(last?.preview)
  const sessionLabel = last ? generatedSessionTitle(last, last?.preview) : null
  const activeNow = Boolean(last?.last_active && Date.now() / 1000 - last.last_active < ACTIVE_WINDOW_S)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState(null)
  const [historyError, setHistoryError] = useState(false)
  const lastActiveKey = last?.last_active || 0
  // Lazy per-bot history: fetched once on first expand, re-fetched while
  // open whenever the bot writes a new message. Twelve rows max, sorted newest-first.
  useEffect(() => {
    if (!historyOpen) {
      return undefined
    }
    let cancelled = false
    host
      .request('session.list', { profile: bot.name, limit: 12 })
      .then(res => {
        if (!cancelled) {
          const list = (res?.sessions ?? []).slice().sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
          setHistory(list)
          setHistoryError(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [historyOpen, bot.name, lastActiveKey])
  // DM previews read like DMs: strip the delivery prefix, keep the message.
  const displayPreview = fromBot
    ? (last?.preview || '').replace(A2A_PREFIX_RE, '').trim() || '…'
    : last?.preview || bot.description || 'No conversations yet — say hi'

  const warm = () => {
    if (typeof host.warmProfile !== 'function') {
      return
    }

    try {
      host.warmProfile(bot.name)
    } catch {
      /* warm is best-effort */
    }
  }

  // Shared open path: same canonical-chat resolution the fleet activity
  // feed uses, with the older-gateway draft fallback for hosts without
  // profile-scoped session.create.
  const open = async () => {
    try {
      const id = await openBotChat(bot, meta)

      if (id) {
        return
      }
    } catch {
      // Fall through to the older-gateway draft below.
    }

    if (typeof host.newChat === 'function') {
      // Older gateway without profile-scoped session.create — plain draft.
      host.newChat(bot.name)
    } else {
      host.navigate('/')
    }
  }

  // One glanceable status pill driven by the unifiedBotState model across all surfaces:
  const uState = unifiedBotState(bot, meta, unread, activeProfile, gatewayState === 'busy', openLoops)
  const statusPill = uState.state !== 'idle' ? { label: uState.verb || uState.label, cls: uState.cls } : null

  // Row-level actions revealed on hover (always visible on the active row):
  // edit is the management affordance; pin mirrors the right-click menu.
  // Spans with role=button — the row is a <button>, so real buttons can't
  // nest inside it (same pattern as the session chip).
  const hoverActions = jsxs('div', {
    className: cn(
      'flex shrink-0 items-center gap-0.5 rounded-md',
      isActive ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
    ),
    children: [
      jsx('span', {
        role: 'button',
        tabIndex: 0,
        title: 'Edit profile',
        'aria-label': `Edit ${displayName(bot, meta)}`,
        className:
          'flex size-5 cursor-pointer items-center justify-center rounded text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
        onClick: event => {
          event.stopPropagation()
          onEdit(bot)
        },
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            onEdit(bot)
          }
        },
        children: jsx(Codicon, { name: 'edit', className: 'text-[0.85rem]' })
      }),
      jsx('span', {
        role: 'button',
        tabIndex: 0,
        title: meta?.pinned ? 'Unpin' : 'Pin to top',
        'aria-label': meta?.pinned ? 'Unpin' : 'Pin to top',
        className: cn(
          'flex size-5 cursor-pointer items-center justify-center rounded transition-colors hover:bg-(--chrome-action-hover)',
          meta?.pinned ? 'text-(--ui-accent,#4f9cf9)' : 'text-(--ui-text-tertiary) hover:text-foreground'
        ),
        onClick: event => {
          event.stopPropagation()
          const pinned = Boolean($botMeta.get()[bot.name]?.pinned)
          saveBotMeta(bot.name, { pinned: !pinned })
          host.notify({ kind: 'info', message: `${displayName(bot, meta)} ${pinned ? 'unpinned' : 'pinned to top'}` })
        },
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            const pinned = Boolean($botMeta.get()[bot.name]?.pinned)
            saveBotMeta(bot.name, { pinned: !pinned })
            host.notify({ kind: 'info', message: `${displayName(bot, meta)} ${pinned ? 'unpinned' : 'pinned to top'}` })
          }
        },
        children: jsx(Codicon, { name: 'pin', className: 'text-[0.85rem]' })
      })
    ]
  })

  const row = jsxs('button', {
    type: 'button',
    onPointerEnter: warm,
    onClick: open,
    className: cn(
      'group flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden rounded-md border-l-2 px-2 py-2 text-left transition-colors',
      isActive ? 'border-(--ui-accent,#4f9cf9)' : 'border-transparent',
      'hover:bg-(--chrome-action-hover)',
      isActive && 'bg-(--chrome-action-hover)',
      paused && 'opacity-60 hover:opacity-100'
    ),
    children: [
      jsx('div', {
        className: 'shrink-0',
        children: jsx(BotFace, { shape, color, image, size: 34, name: bot.name, mood: botMood })
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsxs('div', {
                className: 'flex min-w-0 items-baseline gap-1.5 truncate',
                children: [
                  meta?.pinned
                    ? jsx('span', {
                        className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)',
                        title: 'Pinned',
                        children: '📌'
                      })
                    : null,
                  jsx('span', {
                    className: cn(
                      'truncate text-[0.8125rem]',
                      unread ? 'font-semibold text-foreground' : 'font-medium'
                    ),
                    children: displayName(bot, meta)
                  }),
                  showsHandle(bot.name, meta)
                    ? jsx('span', {
                        className: 'shrink-0 font-mono text-[0.6875rem] text-(--ui-text-quaternary)',
                        children: `@${botHandle(bot.name)}`
                      })
                    : null,
                  paused
                    ? jsx('span', {
                        className: 'shrink-0 text-[0.6875rem]',
                        title: 'Paused — handoffs blocked',
                        children: '⏸'
                      })
                    : null,
                  muted
                    ? jsx('span', {
                        className: 'shrink-0 text-[0.6875rem]',
                        title: 'Muted — no notifications',
                        children: '🔇'
                      })
                    : null
                ]
              }),
              jsxs('div', {
                className: 'flex shrink-0 items-center gap-1',
                children: [
                  statusPill
                    ? jsx('span', {
                        className:
                          'rounded-full px-1.5 py-px text-[0.625rem] font-medium leading-4 ' + statusPill.cls,
                        children: statusPill.label
                      })
                    : null,
                  openLoops > 0
                    ? jsx('span', {
                        className:
                          'rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium leading-4 text-amber-400',
                        title: `${openLoops} open handoff${openLoops === 1 ? '' : 's'} awaiting reply`,
                        children: `${openLoops} open`
                      })
                    : null,
                  last
                    ? jsx('span', {
                        className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)',
                        children: relativeTime(last.last_active * 1000)
                      })
                    : null,
                  hoverActions
                ]
              })
            ]
          }),
          sessionLabel
            ? jsxs('div', {
                className: 'mt-0.5 flex min-w-0 items-center gap-1',
                children: [
                  jsxs('span', {
                    role: 'button',
                    tabIndex: 0,
                    'aria-expanded': historyOpen,
                    title: historyOpen ? 'Hide session history' : 'Show session history',
                    className:
                      'flex min-w-0 max-w-full cursor-pointer select-none items-center gap-0.5 rounded px-1 py-px text-[0.65rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-(--ui-text-secondary)',
                    onClick: event => {
                      event.stopPropagation()
                      setHistoryOpen(open => !open)
                    },
                    onKeyDown: event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        setHistoryOpen(open => !open)
                      }
                    },
                    children: [
                      jsx(Codicon, {
                        name: historyOpen ? 'chevron-down' : 'chevron-right',
                        className: 'shrink-0'
                      }),
                      jsx('span', { className: 'truncate', children: sessionLabel })
                    ]
                  }),
                  fromBot
                    ? jsxs('span', {
                        className:
                          'flex shrink-0 items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-accent,#4f9cf9)',
                        title: `Last message came from @${fromBot} (bot-to-bot)`,
                        children: ['🤖', `@${fromBot}`]
                      })
                    : null
                ]
              })
            : null,
          jsx('div', {
            className: fromBot
              ? 'truncate text-xs italic text-(--ui-accent,#4f9cf9)'
              : 'truncate text-xs text-(--ui-text-tertiary)',
            children: displayPreview
          }),
          historyOpen
            ? jsxs('div', {
                className: 'mt-1.5 ml-2.5 flex flex-col gap-1 border-l border-(--ui-stroke-secondary)/60 pl-2',
                children: [
                  historyError
                    ? jsx('span', {
                        className: 'px-1 py-0.5 text-[0.65rem] text-(--ui-text-quaternary)',
                        children: 'Could not load history.'
                      })
                    : history === null
                      ? jsx('span', {
                          className: 'px-1 py-0.5 text-[0.65rem] text-(--ui-text-quaternary)',
                          children: 'Loading…'
                        })
                      : history.length === 0
                        ? jsx('span', {
                            className: 'px-1 py-0.5 text-[0.65rem] text-(--ui-text-quaternary)',
                            children: 'No past sessions.'
                          })
                        : (() => {
                          const sortedHistory = pinnedFirst(history, pinnedIds)
                          const visibleSessions = sortedHistory.slice(0, 2)
                          const remainingCount = sortedHistory.length - visibleSessions.length

                          return [
                            ...visibleSessions.map(s => {
                              const entry = trackEntryOf(s)
                              const pinned = pinnedIds.includes(s.id)
                              const isCurrent = s.id === last?.id

                              const kindChip =
                                entry.kind === 'bot_to_bot'
                                  ? jsxs('span', {
                                      className:
                                        'inline-flex shrink-0 items-center gap-1 rounded bg-(--ui-accent,#4f9cf9)/10 px-1.5 py-0.5 font-mono text-[0.6rem] font-medium text-(--ui-accent,#4f9cf9)',
                                      title: `Bot-to-bot — last message from @${entry.fromBot}`,
                                      children: ['🤖', `@${entry.fromBot}`]
                                    })
                                  : entry.kind === 'cron'
                                    ? jsxs('span', {
                                        className:
                                          'inline-flex shrink-0 items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[0.6rem] font-medium text-purple-400',
                                        title: 'Scheduled routine',
                                        children: ['⏰', 'routine']
                                      })
                                    : jsxs('span', {
                                        className:
                                          'inline-flex shrink-0 items-center gap-1 rounded bg-(--chrome-action-hover) px-1.5 py-0.5 font-mono text-[0.6rem] font-medium text-(--ui-text-secondary)',
                                        title: 'Conversation with you',
                                        children: ['🧑', 'you']
                                      })

                              return jsxs(
                                'span',
                                {
                                  role: 'button',
                                  tabIndex: 0,
                                  'aria-label': `Open ${entry.title}`,
                                  className: cn(
                                    'group/session flex min-w-0 cursor-pointer select-none flex-col gap-1 rounded-md px-2 py-1.5 transition-colors',
                                    isCurrent
                                      ? 'bg-(--chrome-action-hover) shadow-xs'
                                      : 'hover:bg-(--chrome-action-hover)'
                                  ),
                                  onClick: event => {
                                    event.stopPropagation()
                                    void host.openSession(s.id, { profile: bot.name })
                                  },
                                  onKeyDown: event => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      void host.openSession(s.id, { profile: bot.name })
                                    }
                                  },
                                  children: [
                                    jsxs('div', {
                                      className: 'flex min-w-0 items-center justify-between gap-1.5',
                                      children: [
                                        jsxs('div', {
                                          className: 'flex min-w-0 items-center gap-1.5 truncate',
                                          children: [
                                            kindChip,
                                            jsxs('span', {
                                              className: 'inline-flex items-center gap-1 rounded bg-(--chrome-action-hover) px-1.5 py-0.5 text-[0.5625rem] font-mono text-(--ui-accent,#4f9cf9)',
                                              children: [
                                                jsx(Codicon, { name: extractDeliverable(s).icon || 'check', className: 'text-[0.6rem]' }),
                                                jsx('span', { children: extractDeliverable(s).label })
                                              ]
                                            }),
                                            jsx('span', {
                                              className: cn(
                                                'truncate text-[0.6875rem]',
                                                isCurrent ? 'font-semibold text-foreground' : 'font-medium text-(--ui-text-secondary)'
                                              ),
                                              children: entry.title
                                            })
                                          ]
                                        }),
                                        jsxs('div', {
                                          className: 'flex shrink-0 items-center gap-1.5',
                                          children: [
                                            isCurrent
                                              ? jsx('span', {
                                                  className: 'size-1.5 shrink-0 rounded-full bg-(--ui-accent,#4f9cf9) shadow-[0_0_6px_var(--ui-accent,#4f9cf9)]',
                                                  title: 'Current active chat'
                                                })
                                              : null,
                                            jsx('span', {
                                              className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-quaternary)',
                                              children: relativeTime(entry.ts * 1000)
                                            }),
                                            jsx('span', {
                                              role: 'button',
                                              tabIndex: 0,
                                              title: pinned ? 'Unpin session' : 'Pin session to top of record',
                                              'aria-label': pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`,
                                              className: cn(
                                                'flex size-4 cursor-pointer items-center justify-center rounded text-[0.6875rem] transition-colors hover:bg-(--chrome-action-hover)',
                                                pinned
                                                  ? 'text-(--ui-accent,#4f9cf9)'
                                                  : 'text-(--ui-text-quaternary) opacity-0 group-hover/session:opacity-100 hover:text-foreground'
                                              ),
                                              onClick: event => {
                                                event.stopPropagation()
                                                savePinnedSessions(bot.name, togglePinnedId(pinnedIds, s.id))
                                              },
                                              onKeyDown: event => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                  event.preventDefault()
                                                  event.stopPropagation()
                                                  savePinnedSessions(bot.name, togglePinnedId(pinnedIds, s.id))
                                                }
                                              },
                                              children: jsx(Codicon, { name: 'pin', className: 'text-[0.75rem]' })
                                            })
                                          ]
                                        })
                                      ]
                                    }),
                                    entry.preview && entry.preview !== entry.title
                                      ? jsx('div', {
                                          className: 'truncate pl-0.5 text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
                                          children: entry.preview
                                        })
                                      : null
                                  ]
                                },
                                s.id
                              )
                            }),
                            remainingCount > 0
                              ? jsx('button', {
                                  type: 'button',
                                  className:
                                    'mt-1 flex w-full items-center justify-center gap-1 rounded bg-(--chrome-action-hover)/50 py-1 text-[0.625rem] font-mono text-(--ui-accent,#4f9cf9) hover:bg-(--chrome-action-hover)',
                                  onClick: event => {
                                    event.stopPropagation()
                                    void openBotChat(bot, meta)
                                  },
                                  children: `View conversations (${sortedHistory.length}) ➔`
                                })
                              : null
                          ]
                        })()
                ]
              })
            : null
        ]
      })
    ]
  })

  return jsxs(ContextMenu, {
    children: [
      jsx(ContextMenuTrigger, { asChild: true, children: row }),
      jsxs(ContextMenuContent, {
        children: [
          jsx(ContextMenuItem, {
            onSelect: () => {
              const pinned = Boolean($botMeta.get()[bot.name]?.pinned)
              saveBotMeta(bot.name, { pinned: !pinned })
              host.notify({
                kind: 'info',
                message: `${displayName(bot, meta)} ${pinned ? 'unpinned' : 'pinned to top'}`
              })
            },
            children: meta?.pinned ? 'Unpin' : 'Pin to top'
          }),
          jsx(ContextMenuSeparator, {}),
          jsx(ContextMenuItem, { onSelect: () => onEdit(bot), children: 'Edit Profile' }),
          jsx(ContextMenuItem, {
            onSelect: () => {
              saveBotMeta(bot.name, { paused: !paused })
              host.notify({
                kind: 'info',
                message: `${displayName(bot, meta)} ${paused ? 'resumed — accepting tasks' : 'paused — not accepting tasks'}`
              })
            },
            children: jsxs('div', {
              className: 'flex flex-col gap-0.5',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-1.5 font-medium',
                  children: [
                    jsx(Codicon, { name: paused ? 'play' : 'debug-pause', className: 'text-xs' }),
                    jsx('span', { children: paused ? 'Resume work' : 'Pause work' })
                  ]
                }),
                jsx('span', {
                  className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                  children: 'Stops bot from accepting new tasks'
                })
              ]
            })
          }),
          jsx(ContextMenuItem, {
            onSelect: () => {
              saveBotMeta(bot.name, { muted: !muted })
              host.notify({
                kind: 'info',
                message: `${displayName(bot, meta)} ${muted ? 'unmuted — alerts restored' : 'muted — working silently'}`
              })
            },
            children: jsxs('div', {
              className: 'flex flex-col gap-0.5',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-1.5 font-medium',
                  children: [
                    jsx(Codicon, { name: muted ? 'bell' : 'bell-slash', className: 'text-xs' }),
                    jsx('span', { children: muted ? 'Unmute alerts' : 'Mute notifications' })
                  ]
                }),
                jsx('span', {
                  className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                  children: 'Keeps working without notifying you'
                })
              ]
            })
          }),
          jsx(ContextMenuItem, {
            onSelect: () => {
              host.notify({ kind: 'info', message: `Duplicating ${displayName(bot, meta)}…` })
              duplicateBot(bot, $lastRoster.get())
                .then(name => {
                  queryClient.invalidateQueries({ queryKey: ROSTER_KEY })
                  host.notify({ kind: 'success', message: `Created ${name} — full copy of ${bot.name}` })
                })
                .catch(err => host.notifyError(err, 'Duplicate failed'))
            },
            children: 'Duplicate'
          }),
          jsx(ContextMenuSeparator, {}),
          jsx(ContextMenuItem, {
            onSelect: () => {
              $selectedBot.set(bot.name)

              if (typeof host.newChat === 'function') {
                host.newChat(bot.name)
              }
            },
            children: 'New chat with this agent'
          }),
          bot.is_default ? null : jsx(ContextMenuSeparator, {}),
          bot.is_default
            ? null
            : jsx(ContextMenuItem, {
                onSelect: () => onDelete(bot),
                variant: 'destructive',
                children: 'Delete'
              })
        ]
      })
    ]
  })
}

// ── model picker (provider/model dropdowns via model.options) ───────────────

function useModelOptions() {
  return useQuery({
    queryKey: [ID, 'model-options'],
    queryFn: () => host.request('model.options', { include_unconfigured: true, explicit_only: false, refresh: true }),
    staleTime: 120000,
    retry: false
  })
}

/**
 * Provider + model dropdowns from the gateway's configured inventory — the
 * same data the core model picker shows. `value = {provider, model}`;
 * onChange receives the merged patch.
 */
function ModelPicker({ value, onChange, placeholderModel = 'gateway default' }) {
  const { data, isLoading, error } = useModelOptions()

  // Hooks are ALWAYS declared up front, before any conditional return.
  // Declaring them after a return trips React error #310.
  const NONE = '__default__'
  const CUSTOM = '__custom__'
  const providers = (data?.providers || []).filter(p => p && p.slug)
  const isKnown =
    !value.provider || value.provider === NONE || providers.some(p => p.slug === value.provider)
  const [useFreeText, setUseFreeText] = useState(!isKnown)

  if (isLoading) {
    return jsx('div', {
      className: 'flex justify-center py-2',
      children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
    })
  }

  if (error || !providers.length) {
    // Fallback: free text (older gateway or empty inventory).
    return jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
      children: [
        labeled(
          'Provider',
          jsx(Input, {
            placeholder: 'omnirouter / 9router / nous \u2026',
            value: value.provider,
            onChange: event => onChange({ provider: event.target.value })
          })
        ),
        labeled(
          'Model',
          jsx(Input, {
            placeholder: 'antigravity/gemini-3.6-flash-high',
            value: value.model,
            onChange: event => onChange({ model: event.target.value })
          })
        )
      ]
    })
  }

  if (useFreeText) {
    return jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      children: [
        jsxs('div', {
          style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
          children: [
            labeled(
              'Provider (Custom)',
              jsx(Input, {
                placeholder: 'e.g. omnirouter, inferx, 9router',
                value: value.provider,
                onChange: event => onChange({ provider: event.target.value })
              })
            ),
            labeled(
              'Model (Custom)',
              jsx(Input, {
                placeholder: 'e.g. antigravity/gemini-3.6-flash-high',
                value: value.model,
                onChange: event => onChange({ model: event.target.value })
              })
            )
          ]
        }),
        jsx(Button, {
          variant: 'ghost',
          size: 'sm',
          className: 'h-6 self-start text-xs text-(--ui-text-tertiary)',
          onClick: () => setUseFreeText(false),
          children: '← Back to dropdowns'
        })
      ]
    })
  }

  const activeProvider = providers.find(p => p.slug === value.provider) || null
  const models = activeProvider
    ? (activeProvider.models || []).map(m => (typeof m === 'string' ? m : m.id || m.name || ''))
    : []

  return jsxs('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '10px' },
    children: [
      labeled(
        'Provider',
        jsxs(Select, {
          value: value.provider || NONE,
          onValueChange: v => {
            if (v === NONE) {
              onChange({ provider: '', model: '' })
            } else if (v === CUSTOM) {
              setUseFreeText(true)
            } else {
              const prov = providers.find(p => p.slug === v)
              const provModels = (prov?.models || []).map(m =>
                typeof m === 'string' ? m : m.id || m.name || ''
              )
              const first = provModels[0] || ''
              onChange({
                provider: v,
                model: prov && provModels.includes(value.model) ? value.model : first
              })
            }
          },
          children: [
            jsx(SelectTrigger, { className: 'h-8 rounded-md', children: jsx(SelectValue, {}) }),
            jsxs(SelectContent, {
              children: [
                jsx(SelectItem, { value: NONE, children: 'Inherit (launch profile)' }),
                ...providers.map(p =>
                  jsx(
                    SelectItem,
                    { value: p.slug, children: p.name ? `${p.name} (${p.slug})` : p.slug },
                    p.slug
                  )
                ),
                jsx(SelectItem, { value: CUSTOM, children: '✏️ Enter manually…' })
              ]
            })
          ]
        })
      ),
      labeled(
        'Model',
        activeProvider && models.length > 0
          ? jsxs(Select, {
              value: value.model || (models[0] ?? ''),
              onValueChange: v => onChange({ model: v }),
              children: [
                jsx(SelectTrigger, { className: 'h-8 rounded-md', children: jsx(SelectValue, {}) }),
                jsx(SelectContent, {
                  children: models.map(m => jsx(SelectItem, { value: m, children: m }, m))
                })
              ]
            })
          : jsx(Input, {
              placeholder: placeholderModel || 'e.g. model name',
              value: value.model,
              onChange: event => onChange({ model: event.target.value })
            })
      )
    ]
  })
}

// ── advanced profile config (skills / toolsets / model / SOUL) ──────────────
//
// Shared by Edit Profile and New Agent (edit mode only for skills/toolsets —
// a not-yet-created profile has nothing installed to toggle). Backed by
// profiles.describe / profiles.configure; feature-detects older gateways.

function CheckList({ items, onToggle, columns = 2 }) {
  return jsx('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap: '2px 12px'
    },
    children: items.map(item =>
      jsxs(
        'label',
        {
          className: 'flex min-w-0 cursor-pointer items-center gap-1.5 py-0.5 text-xs text-(--ui-text-secondary)',
          title: item.description || item.name,
          children: [
            jsx(Checkbox, {
              checked: item.enabled,
              onCheckedChange: value => onToggle(item.name, Boolean(value))
            }),
            jsx('span', { className: 'truncate', children: item.name }),
            item.tool_count
              ? jsx('span', {
                  className: 'shrink-0 text-[0.6rem] text-(--ui-text-quaternary)',
                  children: `${item.tool_count}`
                })
              : null
          ]
        },
        item.name
      )
    )
  })
}

function AdvancedProfileConfig({ bot, state, setState }) {
  const [loaded, setLoaded] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [skillFilter, setSkillFilter] = useState('')

  if (!loaded) {
    setLoaded(true)
    Promise.all([
      host.request('profiles.describe', { name: bot }),
      host.request('mcp.catalog', { profile: bot }).catch(() => null)
    ])
      .then(([res, cat]) => {
        const configured = res.mcp_servers || []
        const have = new Set(configured.map(m => m.name))
        const catalog = ((cat && cat.servers) || []).filter(s => !have.has(s.name))
        setState(prev => ({
          ...prev,
          provider: res.model?.provider || '',
          model: res.model?.default || '',
          soul: res.soul || '',
          skills: res.skills || [],
          toolsets: res.toolsets || [],
          mcp: [
            ...configured.map(m => ({ ...m, enabled: m.enabled !== false })),
            ...catalog.map(s => ({
              name: s.name,
              enabled: false,
              fromCatalog: true,
              installed: s.installed,
              auth: s.auth,
              requires: s.requires || [],
              description: s.description || ''
            }))
          ],
          loaded: true
        }))
      })
      .catch(() => setUnsupported(true))
  }

  if (unsupported) {
    return jsx('div', {
      className: 'px-2 py-3 text-center text-xs text-(--ui-text-tertiary)',
      children: 'Full configuration needs a newer gateway (restart it after updating Hermes).'
    })
  }

  if (!state.loaded) {
    return jsx('div', {
      className: 'flex justify-center py-4',
      children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
    })
  }

  const visibleSkills = skillFilter.trim()
    ? state.skills.filter(s => s.name.toLowerCase().includes(skillFilter.trim().toLowerCase()))
    : state.skills

  const toggleSkill = (name, enabled) =>
    setState(prev => ({
      ...prev,
      dirtySkills: true,
      skills: prev.skills.map(s => (s.name === name ? { ...s, enabled } : s))
    }))

  const toggleToolset = (name, enabled) =>
    setState(prev => ({
      ...prev,
      dirtyToolsets: true,
      toolsets: prev.toolsets.map(t => (t.name === name ? { ...t, enabled } : t))
    }))

  const toggleMcp = (name, enabled) =>
    setState(prev => ({
      ...prev,
      dirtyMcp: true,
      mcp: (prev.mcp || []).map(m => (m.name === name ? { ...m, enabled } : m))
    }))

  const enabledSkills = state.skills.filter(s => s.enabled).length
  const enabledToolsets = state.toolsets.filter(t => t.enabled).length
  const mcpList = state.mcp || []
  const enabledMcp = mcpList.filter(m => m.enabled).length

  return jsxs('div', {
    className: 'grid gap-4',
    children: [
      jsx(ModelPicker, {
        value: { provider: state.provider, model: state.model },
        onChange: patch => setState(prev => ({ ...prev, dirtyModel: true, ...patch }))
      }),
      labeled(
        `Skills (${enabledSkills}/${state.skills.length} enabled)`,
        jsxs('div', {
          className: 'grid gap-1.5 rounded-md border border-(--ui-stroke-secondary) p-2',
          children: [
            jsx(Input, {
              className: 'h-7 text-xs',
              placeholder: 'Filter skills…',
              value: skillFilter,
              onChange: event => setSkillFilter(event.target.value)
            }),
            jsx(ScrollArea, {
              style: { maxHeight: 180 },
              children: jsx(CheckList, { items: visibleSkills, onToggle: toggleSkill, columns: 2 })
            }),
            jsx(HubSkillsSection, {
              forProfile: bot,
              onInstalled: name =>
                setState(prev =>
                  prev.skills.some(s => s.name === name)
                    ? prev
                    : { ...prev, skills: [...prev.skills, { name, enabled: true }] }
                )
            })
          ]
        })
      ),
      labeled(
        `Toolsets (${enabledToolsets}/${state.toolsets.length} enabled — unchecking all restores the default)`,
        jsx('div', {
          className: 'rounded-md border border-(--ui-stroke-secondary) p-2',
          children: jsx(ScrollArea, {
            style: { maxHeight: 160 },
            children: jsx(CheckList, { items: state.toolsets, onToggle: toggleToolset, columns: 2 })
          })
        })
      ),
      labeled(
        `MCP servers (${enabledMcp}/${mcpList.length} enabled)`,
        jsx('div', {
          className: 'rounded-md border border-(--ui-stroke-secondary) p-2',
          children: mcpList.length === 0
            ? jsx('div', {
                className: 'px-1 py-2 text-center text-xs text-(--ui-text-tertiary)',
                children: 'No MCP servers configured or in the catalog.'
              })
            : jsx(ScrollArea, {
                style: { maxHeight: 180 },
                children: jsx('div', {
                  className: 'grid gap-1',
                  children: mcpList.map(m => {
                    const needsSetup = m.fromCatalog && !m.installed && ((m.requires || []).length > 0 || (m.auth || '').toLowerCase() === 'oauth')
                    return jsxs(
                      'label',
                      {
                        className: 'flex items-start gap-2 text-xs text-(--ui-text-secondary)',
                        children: [
                          jsx(Checkbox, {
                            checked: !!m.enabled,
                            disabled: needsSetup,
                            onCheckedChange: value => toggleMcp(m.name, Boolean(value))
                          }),
                          jsxs('span', {
                            className: 'min-w-0',
                            children: [
                              jsx('span', { children: m.name }),
                              m.fromCatalog && !needsSetup
                                ? jsx('span', {
                                    className: 'ml-1.5 text-[0.65rem] text-(--ui-text-quaternary)',
                                    children: m.installed ? 'catalog · installed' : 'catalog'
                                  })
                                : null,
                              needsSetup
                                ? jsx(McpSetupButton, {
                                    profile: bot,
                                    entry: m,
                                    onDone: () => toggleMcp(m.name, true)
                                  })
                                : null,
                              m.description
                                ? jsx('div', {
                                    className: 'truncate text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                                    children: m.description
                                  })
                                : null
                            ]
                          })
                        ]
                      },
                      m.name
                    )
                  })
                })
              })
        })
      ),
      labeled(
        'SOUL.md (persona + agent-messaging protocol)',
        jsx(Textarea, {
          className: 'min-h-28 font-mono text-xs leading-5',
          value: state.soul,
          onChange: event => setState(prev => ({ ...prev, dirtySoul: true, soul: event.target.value }))
        })
      )
    ]
  })
}

// ── skills hub section: the REAL hub page (docs) embedded as a picker ──────
// https://hermes-agent.nousresearch.com/docs/skills?embed=picker hides the
// docs chrome and adds "+ Add to this Agent" per card, posting
// {type: 'hermes-skill-pick', ...} to us (hermes-agent#86243). We validate
// the origin, install via skills.manage, and bubble onInstalled so the
// checklist above gains the row. Search-box fallback kept for offline use.

const HUB_ORIGIN = 'https://hermes-agent.nousresearch.com'
const HUB_PICKER_URL = HUB_ORIGIN + '/docs/skills?embed=picker'

function HubSkillsSection({ forProfile, onInstalled }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState(null)
  const [installed, setInstalled] = useState({})
  const [browseHub, setBrowseHub] = useState(false)
  const installRef = useRef(null)

  // Picker messages from the embedded hub page. Origin-checked; installs
  // route through the same install() the search fallback uses.
  useEffect(() => {
    if (!browseHub) {
      return undefined
    }

    const onMessage = event => {
      if (event.origin !== HUB_ORIGIN) {
        return
      }

      const data = event.data

      if (!data || data.type !== 'hermes-skill-pick' || !data.name) {
        return
      }

      const target = String(data.identifier || data.name)

      if (installRef.current) {
        void installRef.current(target, String(data.name))
      }
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [browseHub])

  const search = async () => {
    const q = query.trim()

    if (!q || searching) {
      return
    }

    setSearching(true)
    setResults(null)

    try {
      const res = await host.request('skills.manage', { action: 'search', query: q })
      setResults(res.results || [])
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const install = async (name, displayName) => {
    const label = displayName || name

    if (installing) {
      return
    }

    setInstalling(label)

    try {
      // With forProfile the install lands in that bot's skills dir
      // (gateway skills.manage profile scoping); null = launch profile,
      // which is right at create time — the new bot clones/copies from it.
      await host.request('skills.manage', {
        action: 'install',
        query: name,
        ...(forProfile ? { profile: forProfile } : {})
      })
      setInstalled(prev => ({ ...prev, [label]: true }))
      host.notify({ kind: 'success', message: `Skill "${label}" installed` })

      if (typeof onInstalled === 'function') {
        onInstalled(label)
      }
    } catch (err) {
      host.notifyError(err, `Installing "${label}" failed`)
    } finally {
      setInstalling(null)
    }
  }

  installRef.current = install

  return jsxs('div', {
    className: 'grid gap-1.5 border-t border-(--ui-stroke-secondary) pt-2',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsx('div', {
            className: 'text-[0.7rem] font-medium text-(--ui-text-secondary)',
            children: 'Skills Hub'
          }),
          jsx('button', {
            type: 'button',
            className: 'text-[0.65rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            onClick: () => setBrowseHub(v => !v),
            children: browseHub ? 'hide the hub browser' : 'browse the full hub ▾'
          })
        ]
      }),
      browseHub
        ? jsxs('div', {
            className: 'grid gap-1',
            children: [
              // Resizable viewport: native CSS resize handle (bottom-right
              // corner) lets the user drag it larger/smaller. The iframe
              // inside is rendered oversized and scaled DOWN (133% × 0.75)
              // so the hub page starts zoomed out — we can't style the
              // cross-origin page itself, but scaling the frame is ours.
              jsx('div', {
                style: {
                  width: '100%',
                  height: 560,
                  minHeight: 240,
                  minWidth: 320,
                  maxWidth: '100%',
                  resize: 'both',
                  overflow: 'hidden',
                  border: '1px solid var(--ui-stroke-secondary)',
                  borderRadius: 8,
                  position: 'relative'
                },
                children: jsx('iframe', {
                  src: HUB_PICKER_URL,
                  title: 'Hermes Skills Hub',
                  style: {
                    width: '133.34%',
                    height: '133.34%',
                    border: 'none',
                    background: 'transparent',
                    transform: 'scale(0.75)',
                    transformOrigin: 'top left'
                  },
                  sandbox: 'allow-scripts allow-same-origin'
                })
              }),
              jsx('div', {
                className: 'px-1 text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                children:
                  installing
                    ? `Installing "${installing}"…`
                    : 'Hit "+ Add to this Agent" on any skill — it installs and appears in the list above. Drag the corner to resize.'
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex gap-1.5',
        children: [
          jsx(Input, {
            className: 'h-7 flex-1 text-xs',
            placeholder: 'Search the hub (community + well-known sources)…',
            value: query,
            onChange: event => setQuery(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void search()
              }
            }
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            disabled: searching || !query.trim(),
            onClick: () => void search(),
            children: searching ? 'Searching…' : 'Search'
          })
        ]
      }),
      searching
        ? jsx('div', {
            className: 'px-1 text-[0.65rem] text-(--ui-text-quaternary)',
            children: 'Searching community + well-known sources — can take ~10s…'
          })
        : null,
      results === null
        ? null
        : results.length === 0
          ? jsx('div', {
              className: 'px-1 py-1.5 text-[0.7rem] text-(--ui-text-quaternary)',
              children: 'No hub skills matched.'
            })
          : jsx(ScrollArea, {
              style: { maxHeight: 150 },
              children: jsx('div', {
                className: 'grid gap-1',
                children: results.map(r =>
                  jsxs(
                    'div',
                    {
                      className: 'flex items-center gap-2 text-xs',
                      children: [
                        jsxs('div', {
                          className: 'min-w-0 flex-1',
                          children: [
                            jsx('div', { className: 'truncate font-medium', children: r.name }),
                            r.description
                              ? jsx('div', {
                                  className: 'truncate text-[0.65rem] text-(--ui-text-quaternary)',
                                  children: r.description
                                })
                              : null
                          ]
                        }),
                        installed[r.name]
                          ? jsx('span', {
                              className: 'shrink-0 text-[0.65rem] text-(--ui-text-tertiary)',
                              children: '✓ added'
                            })
                          : jsx(Button, {
                              size: 'sm',
                              variant: 'ghost',
                              className: 'shrink-0 px-2 font-semibold',
                              disabled: installing !== null,
                              title: `Install "${r.name}" and add it to the list above`,
                              onClick: () => void install(r.name),
                              children: installing === r.name ? '…' : '+'
                            })
                      ]
                    },
                    r.name
                  )
                )
              })
            })
    ]
  })
}

function emptyAdvancedState() {
  return {
    loaded: false,
    provider: '',
    model: '',
    soul: '',
    skills: [],
    toolsets: [],
    mcp: [],
    dirtyModel: false,
    dirtySoul: false,
    dirtySkills: false,
    dirtyToolsets: false,
    dirtyMcp: false
  }
}

/** Persist only the dirty sections of the advanced editor. */
async function applyAdvancedConfig(bot, state) {
  const payload = { name: bot }
  const applied = {}

  if (state.dirtySoul) {
    payload.soul = state.soul
  }

  if (state.dirtyModel) {
    const model = state.model.trim()
    const provider = state.provider.trim()

    if (model && provider) {
      payload.model = model
      payload.provider = provider
    } else if (!model && !provider) {
      try {
        const result = await host.request('cli.exec', {
          argv: ['--profile', bot, 'config', 'unset', 'model']
        })
        applied.model = result?.blocked !== true && result?.code === 0
      } catch {
        applied.model = false
      }
    } else {
      applied.model = false
    }
  }

  if (state.dirtySkills) {
    payload.disabled_skills = state.skills.filter(s => !s.enabled).map(s => s.name)
  }

  if (state.dirtyToolsets) {
    const all = state.toolsets.length
    const enabled = state.toolsets.filter(t => t.enabled)
    // All enabled (or none) = clear the pin; otherwise pin the checked set.
    payload.enabled_toolsets = enabled.length === all || enabled.length === 0 ? [] : enabled.map(t => t.name)
  }

  if (state.dirtyMcp) {
    payload.enabled_mcp_servers = (state.mcp || []).filter(m => m.enabled).map(m => m.name)
  }

  if (Object.keys(payload).length === 1) {
    return { ok: Object.values(applied).every(Boolean), applied }
  }

  const result = await host.request('profiles.configure', payload)
  const merged = { ...applied, ...(result?.applied || {}) }

  return { ...result, ok: Object.values(merged).every(Boolean), applied: merged }
}

// ── edit profile dialog ──────────────────────────────────────────────────────

function labeled(label, control) {
  return jsxs('div', {
    className: 'grid gap-1.5',
    children: [
      jsx('label', {
        className: 'text-xs font-medium text-(--ui-text-secondary)',
        children: label
      }),
      control
    ]
  })
}

function EditProfileDialog({ bot, open, onClose }) {
  const metaAll = useValue($botMeta)
  const meta = bot ? metaAll[bot.name] : null
  const appearance = bot ? botAppearance(bot.name, meta) : { shape: 'circle', color: AVATAR_COLORS[3] }
  const [shape, setShape] = useState(appearance.shape)
  const [color, setColor] = useState(appearance.color)
  const [image, setImage] = useState(appearance.image)
  const [title, setTitle] = useState(meta?.title || '')
  const [description, setDescription] = useState(bot?.description || '')
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [adv, setAdv] = useState(emptyAdvancedState())

  // Re-seed local state each time a different bot opens the dialog.
  const [seedKey, setSeedKey] = useState(null)
  const currentKey = bot ? `${bot.name}:${open}` : null
  if (currentKey !== seedKey) {
    setSeedKey(currentKey)
    if (bot && open) {
      setShape(appearance.shape)
      setColor(appearance.color)
      setImage(appearance.image)
      setTitle(meta?.title || '')
      setDescription(bot.description || '')
      setBusy(false)
      setAdvanced(false)
      setAdv(emptyAdvancedState())
    }
  }

  if (!bot) {
    return null
  }

  const submit = async () => {
    if (busy) {
      return
    }

    setBusy(true)
    let advancedFailed = false
    saveBotMeta(bot.name, { shape, color, image, title: title.trim(), custom: true })

    const desc = description.trim()
    if (desc !== (bot.description || '').trim()) {
      try {
        await host.request('cli.exec', {
          argv: ['profile', 'describe', bot.name, '--text', desc]
        })
        queryClient.invalidateQueries({ queryKey: ROSTER_KEY })
      } catch (err) {
        host.notifyError(err, 'Saved look locally; description update failed')
      }
    }

    if (adv.loaded && (adv.dirtyModel || adv.dirtySoul || adv.dirtySkills || adv.dirtyToolsets || adv.dirtyMcp)) {
      try {
        const res = await applyAdvancedConfig(bot.name, adv)
        const failed = Object.entries(res?.applied || {}).filter(([, ok]) => !ok)

        if (failed.length) {
          advancedFailed = true
          host.notify({ kind: 'error', message: `Some sections failed: ${failed.map(([k]) => k).join(', ')}` })
        }
      } catch (err) {
        advancedFailed = true
        host.notifyError(err, 'Advanced configuration failed')
      }
    }

    if (!advancedFailed) {
      host.notify({ kind: 'success', message: `${displayName(bot, { title })} updated` })
    }
    setBusy(false)
    onClose()
  }

  return jsx(Dialog, {
    open,
    onOpenChange: value => !value && !busy && onClose(),
    children: jsxs(DialogContent, {
      className: advanced ? 'max-w-3xl' : 'max-w-sm',
      // Same resizable-window treatment as the create dialog.
      style: advanced
        ? { resize: 'both', overflow: 'auto', minWidth: 420, minHeight: 360, maxWidth: '95vw', maxHeight: '90vh' }
        : undefined,
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: 'Edit Profile' }),
            jsx(DialogDescription, { children: `Appearance and role for ${displayName(bot, null)} (${bot.name}).` })
          ]
        }),
        jsxs('div', {
          className: 'grid gap-4',
          children: [
            jsx('div', {
              className: 'flex justify-center py-1',
              children: jsx(BotFace, { shape, color, image, size: 64, name: bot.name })
            }),
            jsx(AvatarPicker, {
              shape,
              color,
              image,
              onShape: setShape,
              onColor: setColor,
              onImage: setImage,
              generateSeed: { name: bot.name, title, description }
            }),
            labeled(
              'Title',
              jsx(Input, {
                placeholder: displayName(bot, null),
                value: title,
                onChange: event => setTitle(event.target.value)
              })
            ),
            labeled(
              'Description',
              jsx(Textarea, {
                className: 'min-h-16',
                placeholder: 'What should this agent help with?',
                value: description,
                onChange: event => setDescription(event.target.value)
              })
            ),
            jsxs('button', {
              type: 'button',
              className:
                'flex items-center gap-1 text-xs font-medium text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
              onClick: () => setAdvanced(v => !v),
              children: [
                jsx(Codicon, { name: advanced ? 'chevron-down' : 'chevron-right', className: 'text-[0.8rem]' }),
                'Advanced — model, skills, toolsets, SOUL.md'
              ]
            }),
            advanced
              ? jsx('div', {
                  className: 'rounded-md border border-(--ui-stroke-secondary) p-3',
                  children: jsx(AdvancedProfileConfig, { bot: bot.name, state: adv, setState: setAdv })
                })
              : null
          ]
        }),
        jsxs(DialogFooter, {
          children: [
            jsx(Button, { variant: 'ghost', disabled: busy, onClick: onClose, children: 'Cancel' }),
            jsx(Button, { disabled: busy, onClick: submit, children: busy ? 'Saving…' : 'Save' })
          ]
        })
      ]
    })
  })
}

// ── create dialog ────────────────────────────────────────────────────────────

function CreateAgentDialog({ open, onClose, roster }) {
  const [name, setName] = useState('')
  // Create mode: the profile doesn't exist yet, so per-profile MCP credential
  // setup can't target it — the row shows a "save the agent first" hint and
  // the live setup UI lives in Edit Profile (where bot.name exists).
  const setupProfile = null
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [shape, setShape] = useState('circle')
  const [color, setColor] = useState(AVATAR_COLORS[3])
  const [image, setImage] = useState(null)
  const [advanced, setAdvanced] = useState(false)
  const [cloneFrom, setCloneFrom] = useState('default')
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [soul, setSoul] = useState('')
  const [noSkills, setNoSkills] = useState(false)
  const [shareAuth, setShareAuth] = useState(true)
  const [advTab, setAdvTab] = useState('general')
  const [caps, setCaps] = useState(null)
  const [capsFailed, setCapsFailed] = useState(false)
  const [dirtyCaps, setDirtyCaps] = useState({ skills: false, toolsets: false, mcp: false })
  const [capFilter, setCapFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const slug = slugify(name)
  const valid = slug.length > 0 && NAME_RE.test(slug)
  const taken = roster.some(b => b.name === slug)

  const reset = () => {
    setName('')
    setTitle('')
    setDescription('')
    setShape('circle')
    setColor(AVATAR_COLORS[3])
    setImage(null)
    setAdvanced(false)
    setCloneFrom('__none__')
    setModel('')
    setProvider('')
    setSoul('')
    setNoSkills(false)
    setShareAuth(true)
    setAdvTab('general')
    setCaps(null)
    setCapsFailed(false)
    setDirtyCaps({ skills: false, toolsets: false, mcp: false })
    setCapFilter('')
    setBusy(false)
    setError(null)
  }

  // Capability catalog for the tabs: the profile doesn't exist yet, so show
  // what it WILL have — the clone source's catalog, else the main profile's.
  const capSource = cloneFrom === '__none__' ? 'default' : cloneFrom
  const ensureCaps = () => {
    if ((caps && caps.source === capSource) || capsFailed) {
      return
    }

    Promise.all([
      host.request('profiles.describe', { name: capSource }),
      host.request('mcp.catalog', {}).catch(() => null)
    ])
      .then(([res, cat]) => {
        // Full MCP menu = the profile's configured servers + the bundled
        // catalog (installable). Configured entries win on name clash.
        const configured = res.mcp_servers || []
        const have = new Set(configured.map(m => m.name))
        const catalog = ((cat && cat.servers) || []).filter(s => !have.has(s.name))

        setCaps({
          source: capSource,
          skills: res.skills || [],
          toolsets: res.toolsets || [],
          mcp: [
            ...configured,
            ...catalog.map(s => ({
              name: s.name,
              enabled: false,
              fromCatalog: true,
              installed: s.installed,
              requires: s.requires || [],
              description: s.description || ''
            }))
          ]
        })
      })
      .catch(() => setCapsFailed(true))
  }

  const toggleCap = (kind, name, enabled) => {
    setDirtyCaps(prev => ({ ...prev, [kind === 'mcp' ? 'mcp' : kind]: true }))
    setCaps(prev =>
      prev
        ? { ...prev, [kind]: prev[kind].map(x => (x.name === name ? { ...x, enabled } : x)) }
        : prev
    )
  }

  const submit = async () => {
    if (!valid || taken || busy) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const descriptionText = [title, description].filter(Boolean).join(' — ')

      await host.request('profiles.create', {
        name: slug,
        description: descriptionText,
        clone_from: cloneFrom === '__none__' ? null : cloneFrom,
        no_skills: noSkills,
        // Shared (not copied) auth keeps ONE OAuth/token pool with the main
        // profile, so refreshes can't invalidate each other. Older gateways
        // ignore the param and copy — still functional, just forked.
        share_auth: shareAuth,
        soul: composeSoul({ name: slug, title, description, roster, customSoul: soul }),
        ...(model.trim() && provider.trim() ? { model: model.trim(), provider: provider.trim() } : {})
      })

      // Apply capability picks from the Advanced tabs (best-effort; the
      // profile exists either way and Edit Profile can finish the job).
      try {
        const capPayload = {}

        if (dirtyCaps.skills && caps) {
          capPayload.disabled_skills = caps.skills.filter(s => !s.enabled).map(s => s.name)
        }
        if (dirtyCaps.toolsets && caps) {
          const en = caps.toolsets.filter(t => t.enabled)
          capPayload.enabled_toolsets =
            en.length === caps.toolsets.length || en.length === 0 ? [] : en.map(t => t.name)
        }
        if (dirtyCaps.mcp && caps) {
          capPayload.enabled_mcp_servers = caps.mcp.filter(m => m.enabled).map(m => m.name)
        }
        if (Object.keys(capPayload).length) {
          await host.request('profiles.configure', { name: slug, ...capPayload })
        }
      } catch {
        /* capability application is best-effort */
      }

      saveBotMeta(slug, { shape, color, image, title: title.trim(), created: Date.now() })
      queryClient.invalidateQueries({ queryKey: ROSTER_KEY })
      host.notify({ kind: 'success', message: `Agent "${displayName({ name: slug, title })}" created` })
      reset()
      onClose()
      $selectedBot.set(slug)

      // Birth the bot's forever chat right away: it introduces itself as
      // the first thing the user sees, and the pin exists from minute one.
      try {
        // Creates, pins, opens, and kicks off the intro in one flow.
        const sid = await createCanonicalChat(slug)

        if (!sid && typeof host.newChat === 'function') {
          host.newChat(slug)
        }
      } catch {
        if (typeof host.newChat === 'function') {
          host.newChat(slug)
        }
      }
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return jsx(Dialog, {
    open,
    onOpenChange: value => {
      if (!value && !busy) {
        reset()
        onClose()
      }
    },
    children: jsxs(DialogContent, {
      className: advanced ? 'max-w-3xl' : 'max-w-md',
      // Native resize handle (bottom-right corner): the dialog becomes a
      // window the user can grow/shrink. overflow:auto is required for CSS
      // resize to engage; caps keep it on screen.
      style: advanced
        ? { resize: 'both', overflow: 'auto', minWidth: 420, minHeight: 360, maxWidth: '95vw', maxHeight: '90vh' }
        : undefined,
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: 'New Agent' }),
            jsx(DialogDescription, {
              children: 'A named teammate with its own memory, skills, and chat. It can message your other agents.'
            })
          ]
        }),
        jsxs('div', {
          className: 'grid gap-3.5',
          children: [
            jsx('div', {
              className: 'flex justify-center py-1',
              children: jsx(BotFace, { shape, color, image, size: 56, name: slug || 'agent' })
            }),
            jsx(AvatarPicker, {
              shape,
              color,
              image,
              onShape: setShape,
              onColor: setColor,
              onImage: setImage,
              generateSeed: { name: slug || 'agent', title, description }
            }),
            labeled(
              'Name',
              jsx(Input, {
                autoFocus: true,
                placeholder: 'inbox-triage',
                value: name,
                onChange: event => setName(event.target.value)
              })
            ),
            taken
              ? jsx('div', {
                  className: 'text-xs text-(--ui-accent)',
                  children: `An agent named "${slug}" already exists.`
                })
              : null,
            labeled(
              'Title',
              jsx(Input, {
                placeholder: 'Inbox Triage',
                value: title,
                onChange: event => setTitle(event.target.value)
              })
            ),
            labeled(
              'Description',
              jsx(Textarea, {
                className: 'min-h-16',
                placeholder: 'What should this Bot help with?',
                value: description,
                onChange: event => setDescription(event.target.value)
              })
            ),
            jsxs('button', {
              type: 'button',
              className:
                'flex items-center gap-1 text-xs font-medium text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
              onClick: () => {
                setAdvanced(v => {
                  if (!v) {
                    ensureCaps()
                  }
                  return !v
                })
              },
              children: [
                jsx(Codicon, { name: advanced ? 'chevron-down' : 'chevron-right', className: 'text-[0.8rem]' }),
                'Advanced'
              ]
            }),
            advanced
              ? jsxs('div', {
                  className: 'grid gap-3 rounded-md border border-(--ui-stroke-secondary) p-3',
                  children: [
                    jsx('div', {
                      className: 'flex gap-1',
                      children: [
                        ['general', 'General'],
                        ['skills', 'Skills'],
                        ['toolsets', 'Tools'],
                        ['mcp', 'MCP']
                      ].map(([id, label]) =>
                        jsx(
                          'button',
                          {
                            type: 'button',
                            className: cn(
                              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                              advTab === id
                                ? 'bg-(--chrome-action-hover) text-(--ui-text-primary)'
                                : 'text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
                            ),
                            onClick: () => {
                              setAdvTab(id)
                              setCapFilter('')
                              if (id !== 'general') {
                                ensureCaps()
                              }
                            },
                            children: label
                          },
                          id
                        )
                      )
                    }),
                    advTab === 'general'
                      ? jsxs('div', {
                          className: 'grid gap-3.5',
                          children: [
                            labeled(
                              'Clone from profile',
                              jsxs(Select, {
                                value: cloneFrom,
                                onValueChange: value => {
                                  setCloneFrom(value)
                                  setCaps(null)
                                  setCapsFailed(false)
                                },
                                children: [
                                  jsx(SelectTrigger, {
                                    className: 'h-8 rounded-md',
                                    children: jsx(SelectValue, {})
                                  }),
                                  jsxs(SelectContent, {
                                    children: [
                                      jsx(SelectItem, {
                                        value: '__none__',
                                        children: 'Fresh profile (bundled skills)'
                                      }),
                                      ...roster.map(b => jsx(SelectItem, { value: b.name, children: b.name }, b.name))
                                    ]
                                  })
                                ]
                              })
                            ),
                            jsx(ModelPicker, {
                              value: { provider, model },
                              onChange: patch => {
                                if ('provider' in patch) {
                                  setProvider(patch.provider)
                                }
                                if ('model' in patch) {
                                  setModel(patch.model)
                                }
                              },
                              placeholderModel: 'inherited from launch profile'
                            }),
                            labeled(
                              'SOUL.md (optional — replaces the generated persona)',
                              jsx(Textarea, {
                                className: 'min-h-24 font-mono text-xs leading-5',
                                placeholder:
                                  'Leave blank to auto-generate from name/title/description + agent-messaging roster.',
                                value: soul,
                                onChange: event => setSoul(event.target.value)
                              })
                            ),
                            jsxs('label', {
                              className: 'flex items-center gap-2 text-xs text-(--ui-text-secondary)',
                              children: [
                                jsx(Checkbox, {
                                  checked: shareAuth,
                                  onCheckedChange: value => setShareAuth(Boolean(value))
                                }),
                                'Share keys & accounts with the main profile'
                              ]
                            }),
                            jsx('div', {
                              className: 'pl-6 pt-0.5 text-[0.7rem] leading-5 text-(--ui-text-tertiary)',
                              children:
                                'Subscriptions, OAuth logins, and API keys stay shared (not copied), so token refreshes never invalidate each other. Uncheck for an isolated snapshot copy.'
                            }),
                            jsxs('label', {
                              className: 'flex items-center gap-2 text-xs text-(--ui-text-secondary)',
                              children: [
                                jsx(Checkbox, {
                                  checked: noSkills,
                                  onCheckedChange: value => setNoSkills(Boolean(value))
                                }),
                                'Create empty (skip bundled skills)'
                              ]
                            })
                          ]
                        })
                      : capsFailed
                        ? jsx('div', {
                            className: 'px-2 py-3 text-center text-xs text-(--ui-text-tertiary)',
                            children:
                              'Capability catalog needs a newer gateway (restart it after updating Hermes).'
                          })
                        : !caps
                          ? jsx('div', {
                              className: 'flex justify-center py-4',
                              children: jsx(GlyphSpinner, {
                                spinner: 'breathe',
                                className: 'text-(--ui-text-tertiary)'
                              })
                            })
                          : advTab === 'skills'
                            ? noSkills
                              ? jsx('div', {
                                  className: 'px-2 py-3 text-center text-xs text-(--ui-text-tertiary)',
                                  children: '“Create empty” is checked — no bundled skills will be installed.'
                                })
                              : jsxs('div', {
                                  className: 'grid gap-1.5',
                                  children: [
                                    jsx(Input, {
                                      className: 'h-7 text-xs',
                                      placeholder: 'Filter skills…',
                                      value: capFilter,
                                      onChange: event => setCapFilter(event.target.value)
                                    }),
                                    jsx(ScrollArea, {
                                      style: { maxHeight: 200 },
                                      children: jsx(CheckList, {
                                        items: capFilter.trim()
                                          ? caps.skills.filter(s =>
                                              s.name.toLowerCase().includes(capFilter.trim().toLowerCase())
                                            )
                                          : caps.skills,
                                        onToggle: (name, enabled) => toggleCap('skills', name, enabled),
                                        columns: 2
                                      })
                                    }),
                                    jsx('div', {
                                      className: 'text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                                      children: `Catalog from ${caps.source} — unchecked skills are disabled after creation.`
                                    }),
                                    jsx(HubSkillsSection, {
                                      forProfile: null,
                                      onInstalled: name =>
                                        setCaps(prev =>
                                          !prev || prev.skills.some(s => s.name === name)
                                            ? prev
                                            : { ...prev, skills: [...prev.skills, { name, enabled: true }] }
                                        )
                                    })
                                  ]
                                })
                            : advTab === 'toolsets'
                              ? jsxs('div', {
                                  className: 'grid gap-1.5',
                                  children: [
                                    jsx(ScrollArea, {
                                      style: { maxHeight: 200 },
                                      children: jsx(CheckList, {
                                        items: caps.toolsets,
                                        onToggle: (name, enabled) => toggleCap('toolsets', name, enabled),
                                        columns: 2
                                      })
                                    }),
                                    jsx('div', {
                                      className: 'text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                                      children: 'Leaving all (or none) checked keeps the default toolset behavior.'
                                    })
                                  ]
                                })
                              : caps.mcp.length === 0
                                ? jsx('div', {
                                    className: 'px-2 py-3 text-center text-xs text-(--ui-text-tertiary)',
                                    children: 'No MCP servers configured or in the catalog.'
                                  })
                                : jsxs('div', {
                                    className: 'grid gap-1.5',
                                    children: [
                                      jsx(ScrollArea, {
                                        style: { maxHeight: 200 },
                                        children: jsx('div', {
                                          className: 'grid gap-1',
                                          children: caps.mcp.map(m => {
                                            const needsSetup =
                                              m.fromCatalog && !m.installed && (m.requires || []).length > 0

                                            return jsxs(
                                              'label',
                                              {
                                                className: 'flex items-start gap-2 text-xs text-(--ui-text-secondary)',
                                                children: [
                                                  jsx(Checkbox, {
                                                    checked: !!m.enabled,
                                                    disabled: needsSetup,
                                                    onCheckedChange: value => toggleCap('mcp', m.name, Boolean(value))
                                                  }),
                                                  jsxs('span', {
                                                    className: 'min-w-0',
                                                    children: [
                                                      jsx('span', { children: m.name }),
                                                      m.fromCatalog
                                                        ? jsx('span', {
                                                            className: 'ml-1.5 text-[0.65rem] text-(--ui-text-quaternary)',
                                                            children: needsSetup
                                                              ? (setupProfile
                                                                  ? null
                                                                  : 'needs setup (' + (m.requires || []).join(', ') + ') — save the agent first, then set up here')
                                                              : m.installed
                                                                ? 'catalog · installed'
                                                                : 'catalog'
                                                          })
                                                        : null,
                                                      needsSetup && setupProfile
                                                        ? jsx(McpSetupButton, {
                                                            profile: setupProfile,
                                                            entry: m,
                                                            onDone: () => toggleCap('mcp', m.name, true)
                                                          })
                                                        : null,
                                                      m.description
                                                        ? jsx('div', {
                                                            className:
                                                              'truncate text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                                                            children: m.description
                                                          })
                                                        : null
                                                    ]
                                                  })
                                                ]
                                              },
                                              m.name
                                            )
                                          })
                                        })
                                      }),
                                      jsx('div', {
                                        className: 'text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
                                        children:
                                          'Configured servers copy from the main profile; catalog entries are the bundled MCP menu. Entries needing API keys route through setup first (credentials follow the shared keys setting).'
                                      })
                                    ]
                                  })
                  ]
                })
              : null,
            error
              ? jsx('div', {
                  className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-accent)',
                  children: error
                })
              : null
          ]
        }),
        jsxs(DialogFooter, {
          children: [
            jsx(Button, {
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                reset()
                onClose()
              },
              children: 'Cancel'
            }),
            jsx(Button, {
              disabled: busy || !valid || taken,
              onClick: submit,
              children: busy ? 'Creating…' : 'Create Agent'
            })
          ]
        })
      ]
    })
  })
}

// ── routines (cron) ──────────────────────────────────────────────────────────
//
// Jobs are namespaced "[bot:<name>] <routine>". A job running in the active
// bot profile uses the plain instruction; a different profile keeps the
// hermes -p <bot> chat delegation wrapper so the run reaches that bot's
// history. The tile follows the bot you're chatting with (gateway profile).
const BOT_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\]\s*/i
const SAFE_ROUTINE_MARKER = '[bot-mode:routine:v2] '
const LEGACY_DELEGATED_ROUTINE_PREFIX = 'You are running the scheduled routine "'

function routineBot(job) {
  const match = BOT_TAG_RE.exec(job?.name || '')
  return match ? match[1].toLowerCase() : null
}

function routineTitle(job) {
  return (job?.name || '').replace(BOT_TAG_RE, '') || 'Untitled cronjob'
}

function isLegacyDelegatedRoutine(job) {
  const preview = typeof job?.prompt_preview === 'string' ? job.prompt_preview : job?.prompt
  return Boolean(routineBot(job) && typeof preview === 'string' && preview.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX))
}

async function loadRoutines() {
  const data = await host.request('cron.manage', { action: 'list', include_disabled: true })
  const jobs = Array.isArray(data?.jobs) ? data.jobs : []
  const activeLegacyJobs = jobs.filter(
    job => isLegacyDelegatedRoutine(job) && job.enabled !== false && job.state !== 'paused'
  )

  await Promise.all(
    activeLegacyJobs.map(job => host.request('cron.manage', { action: 'pause', name: job.job_id }))
  )

  if (!activeLegacyJobs.length) {
    return data
  }

  const pausedIds = new Set(activeLegacyJobs.map(job => job.job_id))
  return {
    ...data,
    jobs: jobs.map(job => (pausedIds.has(job.job_id) ? { ...job, enabled: false, state: 'paused' } : job))
  }
}

function useRoutines() {
  return useQuery({
    queryKey: ROUTINES_KEY,
    queryFn: loadRoutines,
    refetchInterval: 20000,
    staleTime: 8000
  })
}

/** Pick which cron jobs to show. A failed refresh keeps the last good list. */
function selectRoutineJobs(data, error, lastJobs, bot) {
  const live = Array.isArray(data?.jobs) ? data.jobs : null
  const all = live ?? (error ? lastJobs : [])
  return {
    live,
    all,
    jobs: all.filter(job => routineBot(job) === bot)
  }
}

function normalizedProfileName(profile) {
  return typeof profile === 'string' ? profile.trim().toLowerCase() : ''
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function routineInputError(title, instruction) {
  if (String(title).includes('\0')) {
    return 'Cronjob name cannot contain NUL (U+0000).'
  }

  if (String(instruction).includes('\0')) {
    return 'Cronjob instruction cannot contain NUL (U+0000).'
  }

  return null
}

function routinePrompt(bot, title, instruction, activeProfile) {
  if (normalizedProfileName(bot) && normalizedProfileName(bot) === normalizedProfileName(activeProfile)) {
    return instruction
  }

  return (
    `${SAFE_ROUTINE_MARKER}You are running the scheduled routine "${title}" for agent '${bot}'. ` +
    `Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\n` +
    `hermes -p ${shellQuote(bot)} chat -c ${shellQuote(`Routine: ${title}`)} -q ${shellQuote(`[Scheduled routine] ${instruction}`)}\n\n` +
    `If the command fails, report the error instead.`
  )
}
function scheduleLabel(schedule) {
  const once = /^once in (.+)$/.exec(schedule || '')

  if (once) {
    return `Once (${once[1]})`
  }

  const bare = /^(\d+)([mhd])$/.exec(schedule || '')

  if (bare) {
    return `Once (${bare[1]}${bare[2]})`
  }

  const match = /^every (\d+)m$/.exec(schedule || '')

  if (match) {
    const minutes = Number(match[1])

    if (minutes % 1440 === 0) {
      const d = minutes / 1440
      return d === 1 ? 'Daily' : `Every ${d} days`
    }

    if (minutes % 60 === 0) {
      const h = minutes / 60
      return h === 1 ? 'Hourly' : `Every ${h}h`
    }

    return `Every ${minutes}m`
  }

  return schedule || ''
}

function RoutineRow({ job, onChanged }) {
  const [busy, setBusy] = useState(false)
  // Optimistic overlay: null = trust server state. Set immediately on
  // toggle so the switch responds even before the refetch lands.
  const [pendingActive, setPendingActive] = useState(null)
  const legacyUnsafe = isLegacyDelegatedRoutine(job)
  const serverActive = !legacyUnsafe && job.enabled !== false && job.state !== 'paused'
  const active = pendingActive === null ? serverActive : pendingActive

  if (pendingActive !== null && pendingActive === serverActive) {
    setPendingActive(null) // server caught up
  }

  const act = async action => {
    if (busy) {
      return
    }

    setBusy(true)

    if (action === 'pause' || action === 'resume') {
      setPendingActive(action === 'resume')
    }

    try {
      await host.request('cron.manage', { action, name: job.job_id })
      onChanged()
    } catch (err) {
      setPendingActive(null)
      host.notifyError(err, 'Cronjob update failed')
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: cn(
      'group grid gap-1.5 rounded-lg border border-(--ui-stroke-secondary) p-2.5 transition-colors',
      'hover:border-(--ui-stroke-primary, var(--ui-stroke-secondary))'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            'aria-hidden': true,
            className: cn('size-1.5 shrink-0 rounded-full', active ? 'bg-emerald-500' : 'bg-(--ui-text-quaternary)')
          }),
          jsx('span', {
            className: cn('min-w-0 flex-1 truncate text-xs font-medium', !active && 'text-(--ui-text-tertiary)'),
            children: routineTitle(job)
          }),
          jsx(Switch, {
            checked: active,
            disabled: busy || legacyUnsafe,
            onCheckedChange: value => act(value ? 'resume' : 'pause')
          }),
          jsx(Tip, {
            label: 'Delete cronjob',
            children: jsx('button', {
              type: 'button',
              disabled: busy,
              className:
                'flex size-5 items-center justify-center rounded text-(--ui-text-quaternary) opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--chrome-action-hover) hover:text-foreground',
              onClick: () => act('remove'),
              children: jsx(Codicon, { name: 'trash', className: 'text-[0.75rem]' })
            })
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 pl-3.5',
        children: [
          jsxs('span', {
            className:
              'inline-flex items-center gap-1 rounded-full border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-tertiary)',
            children: [jsx(Codicon, { name: 'calendar', className: 'text-[0.7rem]' }), scheduleLabel(job.schedule)]
          }),
          jsx('span', {
            className: 'truncate text-[0.65rem] text-(--ui-text-quaternary)',
            children: active && job.next_run_at ? `next ${relativeTime(new Date(job.next_run_at).getTime())}` : 'paused'
          })
        ]
      }),
      legacyUnsafe
        ? jsx('div', {
            className:
              'rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-[0.65rem] leading-4 text-(--ui-accent)',
            children: 'Paused for security: delete and recreate this legacy cronjob before running it again.'
          })
        : null
    ]
  })
}

// Structured schedule picker: frequency first, then only the detail that
// frequency needs (time of day, weekday, day of month, interval). Emits a
// Hermes-native schedule string; Advanced exposes it raw.
const FREQUENCIES = [
  { id: 'once', label: 'Once, in\u2026' },
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'interval', label: 'Interval' },
  { id: 'advanced', label: 'Advanced\u2026' }
]

const WEEKDAYS = [
  { id: '1', label: 'Monday' },
  { id: '2', label: 'Tuesday' },
  { id: '3', label: 'Wednesday' },
  { id: '4', label: 'Thursday' },
  { id: '5', label: 'Friday' },
  { id: '6', label: 'Saturday' },
  { id: '0', label: 'Sunday' }
]

const TIMES = (() => {
  const out = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const ampm = h < 12 ? 'AM' : 'PM'
      const h12 = h % 12 === 0 ? 12 : h % 12
      out.push({ id: `${h}:${m}`, label: `${h12}:${String(m).padStart(2, '0')} ${ampm}`, h, m })
    }
  }
  return out
})()

/** Compose the Hermes schedule string from picker state. */
function composeSchedule(state) {
  const [h, m] = (state.time || '9:0').split(':').map(Number)

  switch (state.freq) {
    case 'once': {
      const n = Math.max(1, parseInt(state.onceN, 10) || 1)
      return `${n}${state.onceUnit || 'h'}`
    }
    case 'hourly':
      return 'every 1h'
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${state.weekday || '1'}`
    case 'monthly':
      return `${m} ${h} ${state.monthday || '1'} * *`
    case 'interval': {
      const n = Math.max(1, parseInt(state.intervalN, 10) || 1)
      return `every ${n}${state.intervalUnit || 'h'}`
    }
    default:
      return state.raw || ''
  }
}

function scheduleSummary(state) {
  const t = TIMES.find(x => x.id === state.time)
  const tl = t ? t.label : '9:00 AM'

  const unitWord = u => (u === 'm' ? 'minute(s)' : u === 'd' ? 'day(s)' : 'hour(s)')
  const cap =
    state.freq !== 'once' && String(state.repeatN || '').trim()
      ? `, ${Math.max(1, parseInt(state.repeatN, 10) || 1)} time(s) total`
      : ''

  switch (state.freq) {
    case 'once':
      return `Runs once, ${Math.max(1, parseInt(state.onceN, 10) || 1)} ${unitWord(state.onceUnit)} from now`
    case 'hourly':
      return 'Runs at the top of every hour' + cap
    case 'daily':
      return `Runs every day at ${tl}` + cap
    case 'weekdays':
      return `Runs Monday\u2013Friday at ${tl}` + cap
    case 'weekly':
      return `Runs every ${(WEEKDAYS.find(w => w.id === state.weekday) || WEEKDAYS[0]).label} at ${tl}` + cap
    case 'monthly':
      return `Runs on day ${state.monthday || '1'} of each month at ${tl}` + cap
    case 'interval':
      return `Runs every ${Math.max(1, parseInt(state.intervalN, 10) || 1)} ${unitWord(state.intervalUnit)}` + cap
    default:
      return 'Raw schedule \u2014 every Nm/Nh/Nd or 5-field cron'
  }
}

function pickerSelect(value, onChange, options) {
  return jsxs(Select, {
    value,
    onValueChange: onChange,
    children: [
      jsx(SelectTrigger, { className: 'h-8 rounded-md', children: jsx(SelectValue, {}) }),
      jsx(SelectContent, {
        children: options.map(o => jsx(SelectItem, { value: o.id, children: o.label }, o.id))
      })
    ]
  })
}

function SchedulePicker({ state, setState }) {
  const upd = patch => setState(prev => ({ ...prev, ...patch }))
  const needsTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(state.freq)

  return jsxs('div', {
    className: 'grid gap-2',
    children: [
      jsxs('div', {
        style: { display: 'grid', gridTemplateColumns: needsTime ? '1fr 1fr' : '1fr', gap: '8px' },
        children: [
          pickerSelect(state.freq, v => upd({ freq: v }), FREQUENCIES),
          needsTime ? pickerSelect(state.time, v => upd({ time: v }), TIMES) : null
        ]
      }),
      state.freq === 'once'
        ? jsxs('div', {
            style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' },
            children: [
              jsx(Input, {
                className: 'h-8',
                placeholder: '30',
                value: state.onceN,
                onChange: event => upd({ onceN: event.target.value.replace(/[^0-9]/g, '').slice(0, 4) })
              }),
              pickerSelect(state.onceUnit, v => upd({ onceUnit: v }), [
                { id: 'm', label: 'minutes from now' },
                { id: 'h', label: 'hours from now' },
                { id: 'd', label: 'days from now' }
              ])
            ]
          })
        : null,
      state.freq === 'weekly'
        ? pickerSelect(state.weekday, v => upd({ weekday: v }), WEEKDAYS)
        : null,
      state.freq === 'monthly'
        ? labeled(
            'Day of month',
            jsx(Input, {
              className: 'h-8',
              placeholder: '1',
              value: state.monthday,
              onChange: event => upd({ monthday: event.target.value.replace(/[^0-9]/g, '').slice(0, 2) })
            })
          )
        : null,
      state.freq === 'interval'
        ? jsxs('div', {
            style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' },
            children: [
              jsx(Input, {
                className: 'h-8',
                placeholder: '2',
                value: state.intervalN,
                onChange: event => upd({ intervalN: event.target.value.replace(/[^0-9]/g, '').slice(0, 4) })
              }),
              pickerSelect(state.intervalUnit, v => upd({ intervalUnit: v }), [
                { id: 'm', label: 'minutes' },
                { id: 'h', label: 'hours' },
                { id: 'd', label: 'days' }
              ])
            ]
          })
        : null,
      state.freq === 'advanced'
        ? jsx(Input, {
            className: 'h-8 font-mono text-xs',
            placeholder: 'every 1d \u00b7 every 2h \u00b7 0 9 * * * (cron)',
            value: state.raw,
            onChange: event => upd({ raw: event.target.value })
          })
        : null,
      state.freq !== 'once' && state.freq !== 'advanced'
        ? jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Stop after' }),
              jsx(Input, {
                className: 'h-7 w-16 text-xs',
                placeholder: '\u221e',
                value: state.repeatN,
                onChange: event => upd({ repeatN: event.target.value.replace(/[^0-9]/g, '').slice(0, 4) })
              }),
              jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: 'runs (blank = forever)' })
            ]
          })
        : null,
      jsx('div', {
        className: 'text-[0.65rem] text-(--ui-text-quaternary)',
        children: `${scheduleSummary(state)} \u00b7 ${composeSchedule(state) || '\u2014'}`
      })
    ]
  })
}

function defaultScheduleState() {
  return { freq: 'daily', time: '9:0', weekday: '1', monthday: '1', intervalN: '2', intervalUnit: 'h', onceN: '30', onceUnit: 'm', repeatN: '', raw: '' }
}

function CreateRoutineDialog({ bot, open, onClose }) {
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [sched, setSched] = useState(defaultScheduleState())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const activeProfile = useValue(host.state.profile)
  const schedule = composeSchedule(sched)

  const reset = () => {
    setName('')
    setInstruction('')
    setSched(defaultScheduleState())
    setBusy(false)
    setError(null)
  }

  const submit = async () => {
    const title = name.trim()
    const task = instruction.trim()
    const inputError = routineInputError(title, task)

    if (inputError) {
      setError(inputError)
      return
    }

    if (!title || !task || !schedule.trim() || busy) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const repeatN =
        sched.freq !== 'once' && sched.freq !== 'advanced' && String(sched.repeatN || '').trim()
          ? Math.max(1, parseInt(sched.repeatN, 10) || 1)
          : null
      await host.request('cron.manage', {
        action: 'add',
        name: `[bot:${bot}] ${title}`,
        schedule: schedule.trim(),
        prompt: routinePrompt(bot, title, task, activeProfile),
        ...(repeatN ? { repeat: repeatN } : {})
      })
      queryClient.invalidateQueries({ queryKey: ROUTINES_KEY })
      host.notify({ kind: 'success', message: `Cronjob "${title}" scheduled` })
      reset()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return jsx(Dialog, {
    open,
    onOpenChange: value => {
      if (!value && !busy) {
        reset()
        onClose()
      }
    },
    children: jsxs(DialogContent, {
      className: 'max-w-md',
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: 'New Cronjob' }),
            jsx(DialogDescription, {
              children: `A recurring task ${displayName({ name: bot }, $botMeta.get()[bot])} runs on a schedule. Runs land in its own chat history.`
            })
          ]
        }),
        jsxs('div', {
          className: 'grid gap-3.5',
          children: [
            labeled(
              'Name',
              jsx(Input, {
                autoFocus: true,
                placeholder: 'Name this cronjob',
                value: name,
                onChange: event => setName(event.target.value)
              })
            ),
            labeled(
              'Instruction',
              jsx(Textarea, {
                className: 'min-h-20',
                placeholder: 'What should this cronjob do each time it runs?',
                value: instruction,
                onChange: event => setInstruction(event.target.value)
              })
            ),
            labeled('When to run', jsx(SchedulePicker, { state: sched, setState: setSched })),
            error
              ? jsx('div', {
                  className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-accent)',
                  children: error
                })
              : null
          ]
        }),
        jsxs(DialogFooter, {
          children: [
            jsx(Button, {
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                reset()
                onClose()
              },
              children: 'Cancel'
            }),
            jsx(Button, {
              disabled: busy || !name.trim() || !instruction.trim() || !schedule.trim(),
              onClick: submit,
              children: busy ? 'Scheduling…' : 'Create Cronjob'
            })
          ]
        })
      ]
    })
  })
}

function RoutinesPane() {
  const selected = useValue($selectedBot)
  const gatewayProfile = useValue(host.state.profile)
  // The tile maps to the bot you're chatting with: the live gateway profile
  // is the truth once a chat opens; $selectedBot covers the gap between a
  // roster click and the profile swap landing.
  const bot = (gatewayProfile || selected || 'default').trim() || 'default'
  const meta = useValue($botMeta)[bot]
  const { shape, color, image } = botAppearance(bot, meta)
  const { data, error, isLoading, refetch } = useRoutines()
  const [createOpen, setCreateOpen] = useState(false)
  const view = selectRoutineJobs(data, error, $lastJobs.get(), bot)
  if (view.live) {
    $lastJobs.set(view.live)
  }
  const jobs = view.jobs
  const staleNotice = error && !view.live && view.all.length
    ? 'Could not refresh cronjobs. Showing the last list we had.'
    : null

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 px-3 pt-3 pb-2',
        children: [
          jsx(BotFace, { shape, color, image, size: 22, name: bot }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsxs('div', {
                className: 'flex min-w-0 items-baseline gap-1.5 truncate',
                children: [
                  jsx('div', {
                    className: 'truncate text-xs font-semibold',
                    children: displayName({ name: bot }, meta)
                  }),
                  showsHandle(bot, meta)
                    ? jsx('span', {
                        className: 'shrink-0 font-mono text-[0.65rem] text-(--ui-text-quaternary)',
                        children: `@${botHandle(bot)}`
                      })
                    : null
                ]
              }),
              jsx('div', {
                className: 'text-[0.65rem] uppercase tracking-wider text-(--ui-text-quaternary)',
                children: 'Cronjobs'
              })
            ]
          }),
          jsx(Tip, {
            label: 'New Cronjob',
            children: jsx('button', {
              type: 'button',
              className:
                'flex size-6 shrink-0 items-center justify-center rounded-md text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
              onClick: () => setCreateOpen(true),
              children: jsx(Codicon, { name: 'add' })
            })
          })
        ]
      }),
      jsx('div', { className: 'mx-3 border-t border-(--ui-stroke-secondary)' }),
      staleNotice
        ? jsx('div', {
            className: 'mx-3 mt-2 rounded-md bg-(--chrome-action-hover) px-2 py-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: staleNotice
          })
        : null,
      isLoading && !view.all.length
        ? jsx('div', {
            className: 'flex flex-1 items-center justify-center',
            children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
          })
        : error && !view.all.length
          ? jsxs('div', {
              className: 'flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center',
              children: [
                jsx(Codicon, { name: 'warning', className: 'text-[1.6rem] text-(--ui-text-quaternary)' }),
                jsx('div', {
                  className: 'text-xs leading-5 text-(--ui-text-tertiary)',
                  children: 'Could not load cronjobs. The list may still be there.'
                }),
                jsx(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => void refetch(),
                  children: 'Retry'
                })
              ]
            })
        : jobs.length === 0
          ? jsxs('div', {
              className: 'flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center',
              children: [
                jsx(Codicon, { name: 'calendar', className: 'text-[1.6rem] text-(--ui-text-quaternary)' }),
                jsx('div', {
                  className: 'text-xs leading-5 text-(--ui-text-tertiary)',
                  children: 'Cronjobs are recurring tasks this agent runs on a schedule.'
                }),
                jsx(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => setCreateOpen(true),
                  children: 'Create Cronjob'
                })
              ]
            })
          : jsx(ScrollArea, {
              className: 'min-h-0 flex-1',
              children: jsx('div', {
                className: 'grid gap-1.5 px-2.5 py-2',
                children: jobs.map(job => jsx(RoutineRow, { job, onChanged: () => void refetch() }, job.job_id))
              })
            }),
      jsx(CreateRoutineDialog, {
        bot,
        open: createOpen,
        onClose: () => {
          setCreateOpen(false)
          void refetch()
        }
      })
    ]
  })
}

// ── roster pane ──────────────────────────────────────────────────────────────

/** Roster search: match a bot against the fields a human would type — profile
 *  name, @handle, display title, and description. Case-insensitive substring;
 *  empty query matches everything. Pure so tests can pin the filter. */
function rosterMatchesQuery(bot, meta, query) {
  // A user typing "@manager" means the handle; the @ is decoration.
  const q = (query || '').trim().toLowerCase().replace(/^@/, '')

  if (!q) {
    return true
  }

  const haystack = [bot?.name, bot?.title, bot?.description, botHandle(bot?.name), displayName(bot, meta)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

/** Tiny uppercase section header between pinned and unpinned rows. */
function RosterGroupLabel({ children }) {
  return jsx('div', {
    className: 'px-1.5 pb-0.5 pt-2 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
    children
  })
}

/** Fleet activity: the newest message from each bot, newest first, capped at
 *  `limit`. Drives the pane's at-a-glance "what is happening right now" list
 *  — the answer to a roster too big to eyeball. Pure so tests can pin
 *  ordering, filtering, and the cap. */
function recentFleetActivity(roster, limit = 6) {
  return (roster || [])
    .filter(bot => bot.last_session?.last_active)
    .map(bot => ({
      bot,
      preview: bot.last_session.preview || '',
      lastActive: bot.last_session.last_active,
      fromBot: previewKind(bot.last_session.preview || '').fromBot,
      sessionLabel: generatedSessionTitle(bot.last_session, bot.last_session.preview)
    }))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, limit)
}

/** A derived bot-to-bot exchange: `{bot, from, to, message, sentAt, status,
 *  replyPreview?, replyAt?}` where `bot` is the RECIPIENT. Built only from
 *  each bot's newest session preview — the roster poll already carries
 *  enough, so the ledger costs no extra fetches. A handoff is `replied`
 *  when the sender's newest preview is a DM back from the recipient with a
 *  later timestamp. Heuristic, deliberately: the full-history ledger is
 *  Phase 3 (Fleet page fetches session lists). */
function recentHandoffs(roster, limit = 6) {
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
  // not a new task — it carries the resolution, so it doesn't get its own
  // ledger row (with one preview per bot it can only be the reply).
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

/** Open loops per bot name: how many handoffs THAT bot sent that haven't
 *  been answered. Drives the amber "N open" badge on roster rows. */
function openLoopsByBot(roster) {
  const counts = {}

  for (const handoff of recentHandoffs(roster, 100)) {
    if (handoff.status === 'awaiting_reply') {
      counts[handoff.from] = (counts[handoff.from] || 0) + 1
    }
  }

  return counts
}

/** Interactive squad matrix: aggregates bot-to-bot handoffs into the flow
 *  stats and connection graph that drive the Fleet page's pipeline
 *  visualizer. Pure (no DOM, no host calls) so tests can pin every field.
 *
 *  - totalFlows:        handoffs with a real from→to pair
 *  - pendingReplies:    handoffs still awaiting a reply
 *  - activePairs:       distinct directed (from→to) pairs with traffic
 *  - flowVolumeByBot:   per-bot { sent, received } — every known bot gets
 *                       an entry (zero volume included) so the UI never
 *                       needs a `|| {}` fallback
 *  - connectionGraph:   { nodes, links } — nodes cover the roster AND any
 *                       handoff participant (so off-roster traffic still
 *                       renders); links are per directed pair with flow and
 *                       pending counts for stroke width / status coloring.
 *                       Both shapes stay tiny (plain arrays of small
 *                       objects) so the SVG renderer stays a flat map.
 */
function buildHandoffMatrix(handoffs, roster) {
  const flows = (Array.isArray(handoffs) ? handoffs : []).filter(h => h && h.from && h.to)
  const volume = {}
  const pairLinks = new Map()

  const bump = (name, key) => {
    if (!name) return
    volume[name] = volume[name] || { sent: 0, received: 0 }
    volume[name][key] += 1
  }

  for (const handoff of flows) {
    const key = `${handoff.from}➔${handoff.to}`
    const link = pairLinks.get(key) || { from: handoff.from, to: handoff.to, flows: 0, pending: 0 }
    link.flows += 1
    if (handoff.status === 'awaiting_reply') {
      link.pending += 1
    }
    pairLinks.set(key, link)
    bump(handoff.from, 'sent')
    bump(handoff.to, 'received')
  }

  const names = new Set([
    ...(Array.isArray(roster) ? roster : []).map(bot => bot?.name).filter(Boolean),
    ...flows.flatMap(handoff => [handoff.from, handoff.to])
  ])

  return {
    totalFlows: flows.length,
    pendingReplies: flows.filter(handoff => handoff.status === 'awaiting_reply').length,
    activePairs: pairLinks.size,
    flowVolumeByBot: volume,
    connectionGraph: {
      nodes: Array.from(names).map(name => ({ id: name, ...(volume[name] || { sent: 0, received: 0 }) })),
      links: Array.from(pairLinks.values())
    }
  }
}

/** One-glance fleet state for the pane's summary strip: what is happening
 *  RIGHT NOW, as plain counts — working, unread, active, paused, and how
 *  many items sit in the Needs-you inbox. Pure (inject `now`) so tests can
 *  pin the window logic. */
function fleetSummary(roster, meta, unread, activeProfileName, gatewayBusy, now = Date.now() / 1000) {
  const summary = { working: 0, unread: 0, active: 0, paused: 0, needYou: 0 }

  for (const bot of roster || []) {
    const m = (meta || {})[bot.name] || {}

    if (bot.name === activeProfileName && gatewayBusy) {
      summary.working += 1
    }

    if (m.paused) {
      summary.paused += 1
    }

    if (unread && unread[bot.name]) {
      summary.unread += 1
    }

    const last = bot.last_session

    if (last?.last_active && now - last.last_active < ACTIVE_WINDOW_S) {
      summary.active += 1
    }
  }

  summary.needYou = needsYouOf(roster, unread).length

  return summary
}

/** What needs a human right now: bot-to-bot replies that landed while the
 *  recipient's chat wasn't open (the human should relay/read them), plus
 *  previews that look like a failed handoff. Newest first. */
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

// ── fleet page (Phase 3) ─────────────────────────────────────────────────────

/** Reserved bot-meta key for fleet-wide policy. No profile can collide: the
 *  profile NAME_RE requires a leading [a-z0-9], so '__fleet__' is safe. */
const FLEET_KEY = '__fleet__'

/** Unified status model across ALL surfaces (Bots pane, Tasks board, Fleet page).
 *  Strict deterministic precedence:
 *  1. Paused: bot paused by user (never accepts new work)
 *  2. Needs you: current work explicitly blocked on human (approval, review, question, failure)
 *  3. Working: active execution currently running (gateway busy or recent active execution)
 *  4. Waiting: blocked on another peer bot's reply (open handoff)
 *  5. Muted: working silently without alerts
 *  6. Idle: at rest
 */
function unifiedBotState(bot, meta, unread = false, activeProfile = null, isBusy = false, openLoops = 0, nowSec = Date.now() / 1000) {
  if (!bot) return { state: 'idle', label: 'Idle', verb: '', cls: 'text-(--ui-text-tertiary)' }
  
  // 1. Paused
  if (meta?.paused) {
    return { state: 'paused', label: 'Paused', verb: 'Not accepting new tasks', cls: 'bg-(--ui-stroke-secondary) text-(--ui-text-tertiary)' }
  }

  const rawPreview = bot.last_session?.preview || ''
  const cleanPreview = rawPreview.replace(A2A_PREFIX_RE, '').trim()
  const actionVerb = cleanPreview.slice(0, 36)

  // 2. Needs you — must be an EXPLICIT human action requirement, not merely an unread info message.
  // Triggers: explicit approval required, review needed, failure requiring intervention, or question asked to user.
  const requiresHumanAction =
    /approve|approval required|needs review|review changes|review needed|action required|confirm|question|failed|error|blocked/i.test(cleanPreview) ||
    Boolean(meta?.require_approval && openLoops > 0)

  if (requiresHumanAction && unread) {
    return {
      state: 'waiting_user',
      label: 'Needs you',
      verb: actionVerb ? `Waiting for you · ${actionVerb}` : 'Waiting for your review',
      cls: 'bg-amber-400 text-black font-semibold shadow-[0_0_6px_#fbbf24]'
    }
  }

  // 3. Working — execution currently running
  const isProfileBusy = Boolean(bot.name === activeProfile && isBusy)
  const lastActive = bot.last_session?.last_active || 0
  const isExecuting = lastActive && (nowSec - lastActive < ACTIVE_WINDOW_S)
  const isWorking = isProfileBusy || isExecuting

  if (isWorking) {
    return {
      state: 'working',
      label: 'Working',
      verb: actionVerb ? `Working · ${actionVerb}` : 'Working…',
      cls: 'hermes-bots-pulse bg-(--ui-accent,#4f9cf9) text-white'
    }
  }

  // 4. Waiting — blocked on another bot
  if (openLoops > 0) {
    return {
      state: 'waiting_reply',
      label: 'Waiting',
      verb: `${openLoops} waiting on peer reply`,
      cls: 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
    }
  }

  // 5. Muted
  if (meta?.muted) {
    return { state: 'muted', label: 'Muted', verb: 'Working silently', cls: 'text-(--ui-text-quaternary)' }
  }

  // 6. Idle
  return { state: 'idle', label: 'Idle', verb: 'At rest', cls: 'text-(--ui-text-tertiary)' }
}

/** Per-bot status for the fleet grid, pause/mute ladder using unifiedBotState. */
function fleetStatusOf(bot, meta, unread = false, activeProfile = null, isBusy = false, openLoops = 0) {
  const s = unifiedBotState(bot, meta, unread, activeProfile, isBusy, openLoops)
  return s.state
}

/** Classify a chat preview for the timeline filter. Cron runs arrive via the
 *  routine delegation wrapper ("Routine: …" / "[Scheduled routine] …"); a
 *  bot-to-bot DM carries the delivery prefix; everything else is a human
 *  exchange. Heuristic, deliberately — the preview is the only signal the
 *  roster poll carries. Pure. */
function fleetEventKind(preview) {
  const text = (preview || '').trim()
  if (/Routine:|\[Scheduled routine\]/i.test(text)) {
    return 'cron'
  }
  if (previewKind(text).fromBot) {
    return 'bot_to_bot'
  }
  return 'human'
}

/** Extract the best epoch timestamp (in seconds) for a session object. */
function sessionTimestamp(session) {
  if (!session) return 0
  const ts =
    session.last_activity_at ||
    session.last_active ||
    session.lastActive ||
    session.started_at ||
    session.created_at ||
    session.ts ||
    0
  return ts > 1e11 ? ts / 1000 : Number(ts) || 0
}

/** One tracked session in an agent's record: what kind of exchange it was
 *  (bot-to-bot / routine / human), who it was with, its readable title, and
 *  a stripped preview of the last message. Drives the row-expand track
 *  record so the pane reads as "what has this agent been doing". */
function trackEntryOf(session) {
  const raw = session?.preview || ''
  const kind = fleetEventKind(raw)
  const preview = raw.replace(A2A_PREFIX_RE, '').trim()

  return {
    id: session?.id,
    title: generatedSessionTitle(session, raw) || 'Conversation',
    preview,
    kind,
    fromBot: kind === 'bot_to_bot' ? previewKind(raw).fromBot : null,
    ts: sessionTimestamp(session)
  }
}

/** Extract deliverable summary and icon from a session preview or title. */
function extractDeliverable(session) {
  const text = `${session?.title || ''} ${session?.preview || ''}`.toLowerCase()
  if (/pick|signal|long|short|target|entry|stop|options|strike/i.test(text)) {
    return { kind: 'signal', icon: 'graph', label: 'Trade Signal' }
  }
  if (/diff|patch|modified|files|code|refactor|commit|tests/i.test(text)) {
    return { kind: 'code', icon: 'diff', label: 'Code Changes' }
  }
  if (/report|findings|analysis|summary|digest|review/i.test(text)) {
    return { kind: 'report', icon: 'file-text', label: 'Report / Doc' }
  }
  if (/inbox|email|spam|triage|action items/i.test(text)) {
    return { kind: 'triage', icon: 'inbox', label: 'Triage / Action' }
  }
  return { kind: 'task', icon: 'check', label: 'Deliverable' }
}

/** Derive 4 Kanban workstream columns from roster, unread states, and active execution:
 *  - inbox: fresh triggers or unstarted handoffs
 *  - in_progress: currently executing (gateway busy or recent active window)
 *  - needs_review: human decision gate (unseen bot replies, review items)
 *  - completed: finished tasks with deliverables
 */
function deriveWorkstreamTasks(roster, unread = {}, activeProfile = null, isBusy = false, nowSec = Date.now() / 1000) {
  const columns = {
    inbox: [],
    in_progress: [],
    needs_review: [],
    completed: []
  }

  const list = Array.isArray(roster) ? roster : []
  for (const bot of list) {
    const s = bot.last_session
    if (!s) continue

    const entry = trackEntryOf(s)
    const deliv = extractDeliverable(s)
    const isUnread = Boolean(unread[bot.name])
    const isActiveNow = Boolean(s.last_active && (nowSec - s.last_active < ACTIVE_WINDOW_S))
    const isProfileBusy = Boolean(bot.name === activeProfile && isBusy)

    const task = {
      id: s.id || `${bot.name}-task`,
      botName: bot.name,
      bot,
      title: entry.title,
      preview: entry.preview,
      kind: entry.kind,
      fromBot: entry.fromBot,
      deliverable: deliv,
      ts: entry.ts,
      isUnread,
      isActiveNow: isActiveNow || isProfileBusy
    }

    if (isProfileBusy || (isActiveNow && !isUnread)) {
      columns.in_progress.push(task)
    } else if (isUnread || entry.kind === 'bot_to_bot' || /needs review|pending approval|review needed|attention/i.test(entry.preview)) {
      columns.needs_review.push(task)
    } else if (/queued|scheduled|pending|routine/i.test(entry.preview)) {
      columns.inbox.push(task)
    } else {
      columns.completed.push(task)
    }
  }

  // Sort each column newest first
  for (const col of Object.keys(columns)) {
    columns[col].sort((a, b) => b.ts - a.ts)
  }

  return columns
}

/** Filter board tasks by selected bot name ('all' or specific bot handle) and text query. */
function filterBoardTasks(tasks, botFilter = 'all', query = '') {
  const q = (query || '').trim().toLowerCase()
  const targetBot = (botFilter || 'all').trim().toLowerCase()

  return (tasks || []).filter(task => {
    if (targetBot !== 'all' && task.botName.toLowerCase() !== targetBot) {
      return false
    }
    if (!q) return true
    const haystack = `${task.title} ${task.preview} ${task.botName}`.toLowerCase()
    return haystack.includes(q)
  })
}

/** Toggle a session id in a pinned list. Returns a NEW array (immutable). */
function togglePinnedId(ids, id) {
  const set = new Set(ids || [])

  if (set.has(id)) {
    set.delete(id)
  } else {
    set.add(id)
  }

  return Array.from(set)
}

/** Order a session list so pinned sessions float to the top, each group
 *  sorted strictly by time (newest first). Stable: equal keys keep
 *  their relative order. */
function pinnedFirst(sessions, pinnedIds) {
  const list = Array.isArray(sessions) ? sessions.slice() : []
  const pinned = new Set(pinnedIds || [])
  const timeOf = s => sessionTimestamp(s)

  return list.sort((a, b) => {
    const pa = pinned.has(a?.id) ? 1 : 0
    const pb = pinned.has(b?.id) ? 1 : 0

    if (pa !== pb) {
      return pb - pa
    }

    return timeOf(b) - timeOf(a)
  })
}

/** Timeline for the Fleet page: one event per bot (its newest message),
 *  tagged with a kind for the All / Bot-to-bot / Human / Cron filter.
 *  Newest first, capped. Pure so tests can pin ordering, filter, cap. */
function fleetTimeline(roster, filter = 'all', limit = 12) {
  const events = (roster || [])
    .filter(bot => bot?.last_session?.last_active)
    .map(bot => {
      const preview = (bot.last_session.preview || '').trim()
      return {
        bot,
        kind: fleetEventKind(preview),
        preview: preview.replace(A2A_PREFIX_RE, '').trim() || '…',
        ts: bot.last_session.last_active
      }
    })
    .sort((a, b) => b.ts - a.ts)

  return (filter === 'all' ? events : events.filter(event => event.kind === filter)).slice(0, limit)
}

/** One-line-per-bot fleet digest from the live roster. Phase 4 ships the
 *  full cron generator (scripts/fleet-digest) with handoff ledgers; until
 *  then "Digest now" composes from what the poll already carries. Pure. */
function composeFleetDigest(roster, meta, queue = {}) {
  const rows = (roster || []).map(bot => {
    const botMeta = meta?.[bot.name] || {}
    const last = bot.last_session
    const action = last
      ? `last action: ${(last.preview || '').replace(A2A_PREFIX_RE, '').trim().slice(0, 80) || '…'} (${relativeTime(last.last_active * 1000)})`
      : 'no activity yet'
    const loops = openLoopsByBot([bot])[bot.name] || 0
    const queued = queue[bot.name] || 0
    return `${displayName(bot, botMeta)} (@${botHandle(bot.name)}) — ${fleetStatusOf(bot, botMeta)}; ${action}; ${loops} open loop${loops === 1 ? '' : 's'}; ${queued} queued`
  })
  return rows.length ? rows.join('\n') : 'No bots in the fleet yet.'
}

/** Cross-bot history search — the LOCAL fallback for the Fleet page search
 *  box (the RAG path runs first when the gateway exposes rag_query).
 *  `sessions` is the flattened session.list scan across every bot:
 *  [{profile, id, title, preview, last_active}]. A query matches a
 *  session's title/preview OR its bot's name/title/description; each result
 *  carries the bot + session so the page can open the exact chat. Newest
 *  first, capped; an empty query returns nothing (an empty search box shows
 *  no results, not everything). Pure so tests can pin matching, ordering,
 *  the cap, and the edge cases. */
function fleetSearchResults(roster, sessions, query, limit = 20) {
  const q = (query || '').trim().toLowerCase()
  if (!q) {
    return []
  }

  const byName = new Map((roster || []).map(bot => [bot.name, bot]))
  const out = []

  for (const session of sessions || []) {
    const bot = byName.get(session?.profile)
    const haystack = [session?.title, session?.preview, bot?.name, bot?.title, bot?.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    if (!haystack.includes(q)) {
      continue
    }

    out.push({
      bot: bot ?? null,
      profile: session?.profile || bot?.name || 'unknown',
      sessionId: session?.id || null,
      title: session?.title || '',
      preview: (session?.preview || '').replace(A2A_PREFIX_RE, '').trim() || '…',
      fromBot: previewKind(session?.preview || '').fromBot,
      ts: session?.last_active || 0
    })
  }

  return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/** At-a-glance "what is happening": the newest message from every bot —
 *  bot-to-bot AND human, framed in plain language. Collapsible. */
function FleetActivity({ roster, meta, openLoops }) {
  const [open, setOpen] = useState(false)
  const events = recentFleetActivity(roster, 6)

  if (!events.length) {
    return null
  }

  return jsxs('div', {
    className: 'mx-2.5 mb-1 rounded-md border border-(--ui-stroke-secondary) bg-(--chrome-action-hover)',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left',
        onClick: () => setOpen(openState => !openState),
        'aria-expanded': open,
        children: [
          jsxs('span', {
            className:
              'flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
            children: [
              jsx(Codicon, { name: 'history', className: 'text-[0.8rem]' }),
              'Recent activity',
              jsx('span', {
                className:
                  'rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-text-quaternary)',
                children: String(events.length)
              })
            ]
          }),
          jsx(Codicon, {
            name: open ? 'chevron-up' : 'chevron-down',
            className: 'text-(--ui-text-quaternary)'
          })
        ]
      }),
      open
        ? jsx('div', {
            className: 'flex flex-col gap-px pb-1',
            children: events.map(event => {
              const botMeta = meta[event.bot.name] || {}
              const { shape, color, image } = botAppearance(event.bot.name, botMeta)
              const preview = event.preview.replace(A2A_PREFIX_RE, '').trim() || '…'

              return jsxs(
                'button',
                {
                  type: 'button',
                  className:
                    'flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)',
                  onClick: () => void openBotChat(event.bot, botMeta),
                  children: [
                    jsx(BotFace, { shape, color, image, size: 20, name: event.bot.name, mood: 'idle' }),
                    event.fromBot
                      ? jsx('span', {
                          className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                          children: `@${event.fromBot} →`
                        })
                      : null,
                    jsx('span', {
                      className: 'shrink-0 text-[0.6875rem] font-medium',
                      children: displayName(event.bot, botMeta)
                    }),
                    jsx('span', {
                      className: 'min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                      children: preview
                    }),
                    jsx('span', {
                      className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                      children: relativeTime(event.lastActive * 1000)
                    }),
                    openLoops && openLoops[event.bot.name]
                      ? jsx('span', {
                          className:
                            'shrink-0 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.5625rem] font-medium text-amber-400',
                          title: `${openLoops[event.bot.name]} open handoff${openLoops[event.bot.name] === 1 ? '' : 's'} awaiting reply`,
                          children: `${openLoops[event.bot.name]} open`
                        })
                      : null
                  ]
                },
                event.bot.name + event.lastActive
              )
            })
          })
        : null
    ]
  })
}

/** Human inbox: bot-to-bot replies that arrived unseen (relay them), and
 *  anything that looks like a failed handoff. Loud, small, and honest —
 *  when nothing needs you, this section does not exist. */
function NeedsYou({ roster, unread, meta }) {
  const items = needsYouOf(roster, unread)

  if (!items.length) {
    return null
  }

  return jsxs('div', {
    className: 'mx-2.5 mb-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 shadow-xs',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-1.5 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-amber-400',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx(Codicon, { name: 'warning', className: 'text-[0.85rem]' }),
              jsx('span', { children: 'Needs attention' })
            ]
          }),
          jsx('span', {
            className: 'rounded-full bg-amber-400 px-1.5 py-px text-[0.625rem] font-bold text-black',
            children: String(items.length)
          })
        ]
      }),
      jsx('div', {
        className: 'flex flex-col gap-px pb-1',
        children: items.map(item => {
          const botMeta = meta[item.bot.name] || {}
          const { shape, color, image } = botAppearance(item.bot.name, botMeta)

          return jsxs(
            'button',
            {
              type: 'button',
              className:
                'flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)',
              onClick: () => void openBotChat(item.bot, botMeta),
              children: [
                jsx(BotFace, { shape, color, image, size: 20, name: item.bot.name, mood: 'idle' }),
                jsx('span', {
                  className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                  children: `@${item.from} →`
                }),
                jsx('span', {
                  className: 'shrink-0 text-[0.6875rem] font-medium',
                  children: displayName(item.bot, botMeta)
                }),
                jsx('span', {
                  className: 'min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                  children: item.preview
                }),
                item.kind === 'handoff_failed'
                  ? jsx('span', {
                      className:
                        'flex shrink-0 items-center gap-0.5 rounded-full bg-(--chrome-action-hover) px-1 py-px text-[0.5625rem] font-medium text-amber-400',
                      children: ['⚠', 'failed']
                    })
                  : jsx('span', {
                      className:
                        'flex shrink-0 items-center gap-0.5 rounded-full bg-(--chrome-action-hover) px-1 py-px text-[0.5625rem] font-medium text-(--ui-accent,#4f9cf9)',
                      children: ['🤖', 'reply']
                    }),
                jsx('span', {
                  className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                  children: relativeTime(item.ts * 1000)
                })
              ]
            },
            item.from + '>' + item.bot.name + item.ts
          )
        })
      })
    ]
  })
}

function TaskStreamView({ roster, unread, activeProfile, isBusy, query, onOpenChat, onReview, allMeta = {} }) {
  const columns = deriveWorkstreamTasks(roster, unread, activeProfile, isBusy, Date.now() / 1000)
  const allTasks = [...columns.in_progress, ...columns.needs_review, ...columns.inbox, ...columns.completed]
  const filtered = filterBoardTasks(allTasks, 'all', query)

  if (!filtered.length) {
    return jsx('div', {
      className: 'flex flex-1 items-center justify-center p-6 text-center text-xs text-(--ui-text-quaternary) font-mono',
      children: query ? `No tasks match “${query}”` : 'No active tasks found'
    })
  }

  return jsx(ScrollArea, {
    className: 'min-h-0 flex-1 px-2 pb-2',
    children: jsx('div', {
      className: 'flex flex-col gap-2',
      children: filtered.map(task =>
        jsx(
          TaskCard,
          {
            task,
            allMeta,
            onOpenChat,
            onReview
          },
          task.id
        )
      )
    })
  })
}

function BotsPane() {
  const { data, error, isLoading, refetch } = useRoster()
  const gatewayUp = useValue(host.state.gateway) === 'open'
  const gatewayState = useValue(host.state.gateway)
  const activeProfile = useValue(host.state.profile)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState('roster') // 'roster' | 'board'
  const [selectedTask, setSelectedTask] = useState(null)
  const unread = useValue($botUnread)

  // The socket opening (boot, SSH reconnect, sleep/wake) is the signal to
  // retry immediately instead of waiting out the poll interval.
  useEffect(() => {
    if (gatewayUp) {
      void refetch()
    }
  }, [gatewayUp, refetch])
  const allMeta = useValue($botMeta)
  // Messaging-app order: most recent activity first, where "activity" is
  // the newest of (bot created, last message in any of its sessions). A
  // freshly created bot tops the list until another bot gets a message.
  // No special slot for the primary bot — it competes on recency too.
  const activityOf = bot => {
    const created = allMeta[bot.name]?.created || bot.ui_meta?.['hermes-bots']?.created || 0
    const lastMsg = (bot.last_session?.last_active || 0) * 1000

    return Math.max(created, lastMsg)
  }
  // Pinned bots (right-click → Pin) float to the top as a group; within the
  // pinned group and within the unpinned group, recency still rules. A
  // plain boolean flag in bot-meta (rides ui_meta to every machine).
  const isPinned = bot => Boolean(allMeta[bot.name]?.pinned)
  // Resilience (@wesleysimplicio, #13): a failed refresh must not erase a
  // roster the user already had — mixed local+cloud gateways and remotes
  // waking from sleep fail transiently. Render the last good snapshot with
  // a notice; the full error card is reserved for "never had a roster".
  const live = Array.isArray(data?.profiles) ? data.profiles : null
  const source = live ?? (error ? $lastRoster.get() : [])
  const roster = source.slice().sort((a, b) => {
    const pa = isPinned(a) ? 1 : 0
    const pb = isPinned(b) ? 1 : 0

    if (pa !== pb) {
      return pb - pa
    }

    return activityOf(b) - activityOf(a)
  })
  const filteredRoster = filterBots(roster, allMeta, query)

  // Pinned group headers only appear when BOTH groups have rows (a single
  // group needs no label — the pane already says "Bots").
  const pinnedRows = filteredRoster.filter(isPinned)
  const restRows = filteredRoster.filter(bot => !isPinned(bot))
  const showGroups = pinnedRows.length > 0 && restRows.length > 0
  // Unanswered handoffs per sender — feeds the amber "N open" row badges.
  const openLoops = openLoopsByBot(filteredRoster)
  // At-a-glance "what is happening" counts for the summary strip.
  const summary = fleetSummary(filteredRoster, allMeta, unread, activeProfile, gatewayState === 'busy')
  // Newest reply waiting for a human — the "need you" chip jumps to it.
  const firstNeed = needsYouOf(filteredRoster, unread)[0]

  if (live) {
    $lastRoster.set(roster)
    mergeServerMeta(live)
    pullServerAvatars(live)
    trackInboundActivity(live)
    // Prewarm strategy is upstream #44: per-hover via BotRow.onPointerEnter
    // — NOT warm-all here (warmProfile re-touches the backend-pool idle
    // clock, so a per-poll loop would pin every backend resident forever).
  }

  const isBusy = gatewayState === 'busy'
  const taskColumns = deriveWorkstreamTasks(roster, unread, activeProfile, isBusy, Date.now())
  const totalTasksCount = taskColumns.in_progress.length + taskColumns.needs_review.length + taskColumns.inbox.length + taskColumns.completed.length

  const staleNotice = error && !live && roster.length
    ? 'Roster refresh failed — showing the last good list.' + (gatewayUp ? '' : ' Waiting for the gateway to reconnect…')
    : null

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-2.5 pt-2.5 pb-1.5',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5',
            children: [
              // Segmented Switcher: Roster vs Board
              jsxs('div', {
                className: 'flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5 bg-(--chrome-action-hover)/40',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      'rounded px-2 py-0.5 text-[0.6875rem] font-semibold transition-colors',
                      viewMode === 'roster' ? 'bg-card text-foreground shadow-xs' : 'text-(--ui-text-tertiary) hover:text-foreground'
                    ),
                    onClick: () => setViewMode('roster'),
                    children: `Bots ${roster.length}`
                  }),
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      'rounded px-2 py-0.5 text-[0.6875rem] font-semibold transition-colors',
                      viewMode === 'board' ? 'bg-card text-foreground shadow-xs' : 'text-(--ui-text-tertiary) hover:text-foreground'
                    ),
                    onClick: () => setViewMode('board'),
                    children: `Tasks ${totalTasksCount}`
                  })
                ]
              }),
              jsx('span', {
                className: cn('size-1.5 rounded-full ml-1', gatewayUp ? 'bg-emerald-400' : 'bg-amber-400'),
                title: gatewayUp ? 'Gateway connected' : 'Gateway disconnected — retrying…'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Tip, {
                label: 'Open Full Squad Board',
                children: jsx('button', {
                  type: 'button',
                  className:
                    'flex size-6 items-center justify-center rounded-md text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                  onClick: () => {
                    if (typeof host.navigate === 'function') {
                      host.navigate('/board')
                    }
                  },
                  children: jsx(Codicon, { name: 'screen-full', className: 'text-[0.8rem]' })
                })
              }),
              jsx(Tip, {
                label: 'New Agent',
                children: jsx('button', {
                  type: 'button',
                  className:
                    'flex size-6 items-center justify-center rounded-md text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                  onClick: () => setCreateOpen(true),
                  children: jsx(Codicon, { name: 'add' })
                })
              })
            ]
          })
        ]
      }),
      roster.length
        ? jsx('div', {
            className: 'px-2.5 pb-1.5',
            children: jsx(SearchField, {
              'aria-label': viewMode === 'board' ? 'Search tasks' : 'Search bots',
              containerClassName: 'w-full',
              inputClassName: 'w-full',
              placeholder: viewMode === 'board' ? 'Search tasks…' : 'Search bots…',
              value: query,
              onChange: setQuery
            })
          })
        : null,
      summary.needYou || summary.working || summary.unread || summary.active || summary.paused
        ? jsxs('div', {
            className:
              'mx-2.5 mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-(--ui-stroke-secondary) bg-(--chrome-action-hover) px-2 py-1',
            children: [
              summary.needYou && firstNeed
                ? jsx('button', {
                    type: 'button',
                    className:
                      'flex cursor-pointer items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-semibold text-amber-400 transition-colors hover:opacity-80',
                    title: 'Jump to the newest bot-to-bot reply waiting for you',
                    onClick: () => void openBotChat(firstNeed.bot, allMeta[firstNeed.bot.name] || {}),
                    children: [jsx('span', { className: 'size-1.5 rounded-full bg-amber-400' }), `${summary.needYou} need you`]
                  })
                : null,
              summary.working
                ? jsx('span', {
                    className:
                      'flex items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-semibold text-(--ui-accent,#4f9cf9)',
                    title: 'Running a turn right now',
                    children: [
                      jsx('span', { className: 'hermes-bots-pulse size-1.5 rounded-full bg-(--ui-accent,#4f9cf9)' }),
                      `${summary.working} working`
                    ]
                  })
                : null,
              summary.unread
                ? jsx('span', {
                    className:
                      'flex items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-text-secondary)',
                    title: 'Bots with new messages you have not opened',
                    children: [jsx('span', { className: 'size-1.5 rounded-full bg-(--ui-accent,#4f9cf9)' }), `${summary.unread} new`]
                  })
                : null,
              summary.active
                ? jsx('span', {
                    className:
                      'flex items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-text-tertiary)',
                    title: 'Wrote something in the last 90 seconds',
                    children: [
                      jsx('span', { className: 'size-1.5 rounded-full bg-(--ui-text-quaternary)' }),
                      `${summary.active} active`
                    ]
                  })
                : null,
              summary.paused
                ? jsx('span', {
                    className:
                      'flex items-center gap-1 rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-text-tertiary)',
                    title: 'Paused — handoffs blocked',
                    children: ['⏸', `${summary.paused} paused`]
                  })
                : null
            ]
          })
        : null,
      jsx(NeedsYou, { roster: filteredRoster, unread, meta: allMeta }),
      jsx(FleetActivity, { roster: filteredRoster, meta: allMeta, openLoops }),
      staleNotice
        ? jsx('div', {
            className: 'mx-2.5 mb-1 rounded-md bg-(--chrome-action-hover) px-2 py-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: staleNotice
          })
        : null,
      isLoading && !roster.length
        ? jsx('div', {
            className: 'flex flex-1 items-center justify-center',
            children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
          })
        : error && !roster.length
          ? jsxs('div', {
              className: 'grid gap-2 px-3 py-4 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('div', {
                  children: gatewayUp
                    ? `Roster unavailable: ${error instanceof Error ? error.message : 'gateway error'}. If your gateway predates profiles.list, update Hermes and restart the gateway.`
                    : 'Waiting for the gateway connection… (remote gateways can take a few seconds; retries automatically)'
                }),
                jsx(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  className: 'justify-self-start',
                  onClick: () => void refetch(),
                  children: 'Retry now'
                })
              ]
            })
          : roster.length === 0
            ? jsx(EmptyState, {
                icon: 'hubot',
                title: 'No agents yet',
                description: 'Create your first teammate.'
              })
            : viewMode === 'board'
              ? jsx(TaskStreamView, {
                  roster,
                  unread,
                  activeProfile,
                  isBusy: gatewayState === 'busy',
                  query,
                  allMeta,
                  onOpenChat: async task => {
                    if (task.id && typeof host.openSession === 'function') {
                      try {
                        await host.openSession(task.id, { profile: task.botName })
                        return
                      } catch {}
                    }
                    await openBotChat(task.bot || { name: task.botName }, allMeta[task.botName])
                  },
                  onReview: t => setSelectedTask(t)
                })
              : filteredRoster.length === 0
              ? jsx('div', {
                  'aria-live': 'polite',
                  className:
                    'flex flex-1 items-center justify-center px-4 text-center text-xs text-(--ui-text-tertiary)',
                  role: 'status',
                  children: `No bots match “${query.trim()}”`
                })
              : jsx(ScrollArea, {
                  className: 'hermes-bots-roster min-h-0 flex-1',
                  children: jsx('div', {
                    className: 'grid w-full min-w-0 gap-0.5 px-1.5 pb-2',
                    children: showGroups
                      ? [
                          jsx(RosterGroupLabel, { key: 'pinned', children: 'Pinned' }),
                          ...pinnedRows.map(bot =>
                            jsx(
                              BotRow,
                              { bot, onDelete: setDeleting, onEdit: setEditing, openLoops: openLoops[bot.name] || 0 },
                              bot.name
                            )
                          ),
                          jsx(RosterGroupLabel, { key: 'agents', children: 'Agents' }),
                          ...restRows.map(bot =>
                            jsx(
                              BotRow,
                              { bot, onDelete: setDeleting, onEdit: setEditing, openLoops: openLoops[bot.name] || 0 },
                              bot.name
                            )
                          )
                        ]
                      : filteredRoster.map(bot =>
                          jsx(
                            BotRow,
                            { bot, onDelete: setDeleting, onEdit: setEditing, openLoops: openLoops[bot.name] || 0 },
                            bot.name
                          )
                        )
                  })
                }),
      jsx(TaskReviewDrawer, {
        task: selectedTask,
        open: Boolean(selectedTask),
        allMeta,
        onClose: () => setSelectedTask(null),
        onOpenChat: async task => {
          if (task.id && typeof host.openSession === 'function') {
            try {
              await host.openSession(task.id, { profile: task.botName })
              return
            } catch {}
          }
          await openBotChat(task.bot || { name: task.botName }, allMeta[task.botName])
        }
      }),
      jsx('div', {
        className: 'flex flex-col gap-1 border-t border-(--ui-stroke-secondary) p-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5 px-0.5 text-[0.625rem] text-(--ui-text-quaternary)',
            title: gatewayUp
              ? `${roster.length} agent${roster.length === 1 ? '' : 's'} · gateway connected`
              : 'Gateway disconnected — reconnecting…',
            children: [
              jsx('span', {
                className: cn(
                  'size-1.5 shrink-0 rounded-full',
                  gatewayUp ? 'bg-(--ui-accent,#4f9cf9)' : 'hermes-bots-pulse bg-(--ui-text-tertiary)'
                )
              }),
              jsx('span', {
                className: 'truncate',
                children: gatewayUp
                  ? `Gateway connected · ${roster.length} agent${roster.length === 1 ? '' : 's'}`
                  : 'Gateway reconnecting…'
              })
            ]
          }),
          jsxs(Button, {
            className: 'w-full justify-center gap-1.5',
            variant: 'secondary',
            onClick: () => setCreateOpen(true),
            children: [jsx(Codicon, { name: 'add' }), 'New Agent']
          })
        ]
      }),
      jsx(CreateAgentDialog, {
        open: createOpen,
        onClose: () => {
          setCreateOpen(false)
          void refetch()
        },
        roster
      }),
      jsx(EditProfileDialog, {
        bot: editing,
        open: Boolean(editing),
        onClose: () => {
          setEditing(null)
          void refetch()
        }
      }),
      jsx(ConfirmDialog, {
        open: Boolean(deleting),
        title: 'Delete bot and profile?',
        description: deleting
          ? jsxs('span', {
              children: [
                'This will permanently delete the bot ',
                jsx('span', { className: 'font-medium text-foreground', children: deleting.name }),
                ' and its associated Hermes profile at ',
                jsx('span', { className: 'font-mono text-xs', children: deleting.path }),
                '. This cannot be undone.'
              ]
            })
          : null,
        destructive: true,
        confirmLabel: 'Delete',
        busyLabel: 'Deleting…',
        doneLabel: 'Deleted',
        onClose: () => setDeleting(null),
        onConfirm: async () => {
          if (!deleting) {
            return
          }

          const name = deleting.name
          await deleteBot(deleting)
          await refetch()
          host.notify({ kind: 'success', message: `Deleted profile ${name}` })
        }
      })
    ]
  })
}

// ── fleet page (Phase 3) ─────────────────────────────────────────────────────

const TIMELINE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'bot_to_bot', label: 'Bot-to-bot' },
  { id: 'human', label: 'Human' },
  { id: 'cron', label: 'Cron' }
]

/** Interactive squad pipeline card: a tiny pure-SVG flow diagram of live
 *  bot-to-bot traffic — nodes are the roster bots on an arc (left → top →
 *  right), links are directed pairs whose stroke width scales with flow
 *  volume and whose color flips amber while a reply is still owed — plus
 *  one-line flow stats. Pure render off buildHandoffMatrix(): no canvas, no
 *  animation loops, just a flat map of a few dozen SVG elements with
 *  CSS-only hover transitions, so it stays cheap even in the tiled pane.
 *  Hover a link for its pair tooltip; click a node to open that bot. */
function FleetMatrix({ matrix, roster, allMeta, onOpenBot }) {
  const { totalFlows, pendingReplies, activePairs, connectionGraph } = matrix
  const nodes = connectionGraph.nodes || []
  const links = connectionGraph.links || []
  const byName = new Map((roster || []).map(bot => [bot.name, bot]))

  // Deterministic arc layout: positions derive from node index only, so a
  // roster change re-derives angles with zero measurement or reflow.
  const CX = 150
  const CY = 72
  const RX = 114
  const RY = 40
  const positionOf = index => {
    const t = nodes.length > 1 ? index / (nodes.length - 1) : 0.5
    const theta = Math.PI * (1 - t)
    return { x: CX + RX * Math.cos(theta), y: CY - RY * Math.sin(theta) }
  }
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  const flowColor = link => (link.pending > 0 ? '#fbbf24' : '#34d399') // amber owes a reply, emerald settled

  return jsxs('div', {
    className: 'mt-1 overflow-hidden rounded-lg border border-(--ui-stroke-secondary)',
    children: [
      // Header + live flow stats.
      jsxs('div', {
        className: 'flex items-center gap-1.5 px-2.5 pb-1 pt-2',
        children: [
          jsx(Codicon, { name: 'graph-line', className: 'text-[0.8rem] text-(--ui-text-tertiary)' }),
          jsx('span', {
            className: 'text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
            children: 'Pipeline'
          }),
          jsxs('span', {
            className: 'ml-auto flex items-center gap-1 text-[0.5625rem] text-(--ui-text-tertiary)',
            children: [
              jsxs('span', { className: 'rounded-full bg-(--chrome-action-hover) px-1.5 py-px', children: [`${totalFlows} flows`] }),
              jsxs('span', { className: 'rounded-full bg-amber-400/10 px-1.5 py-px text-amber-400', children: [`${pendingReplies} pending`] }),
              jsxs('span', { className: 'rounded-full bg-(--chrome-action-hover) px-1.5 py-px', children: [`${activePairs} pairs`] })
            ]
          })
        ]
      }),
      totalFlows === 0 || nodes.length === 0
        ? jsx('div', {
            className: 'px-2.5 pb-2.5 text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'No bot-to-bot traffic yet.'
          })
        : jsxs('svg', {
            viewBox: '0 0 300 136',
            className: 'block w-full',
            role: 'img',
            'aria-label': `Squad pipeline: ${totalFlows} flows, ${pendingReplies} awaiting reply, ${activePairs} active pairs`,
            children: [
              jsx('defs', {
                children: jsx('marker', {
                  id: 'fleetMatrixArrow',
                  viewBox: '0 0 8 8',
                  refX: 7,
                  refY: 4,
                  markerWidth: 6,
                  markerHeight: 6,
                  orient: 'auto-start-reverse',
                  children: jsx('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'context-stroke' })
                })
              }),
              // Links first, so node discs sit on top of them.
              links.map(link => {
                const a = positionOf(indexOf.get(link.from))
                const b = positionOf(indexOf.get(link.to))
                if (!a || !b) return null
                const selfLoop = link.from === link.to
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
                const d = selfLoop
                  ? `M ${a.x},${a.y - 13} C ${a.x + 24},${a.y - 34} ${a.x + 24},${a.y + 2} ${a.x},${a.y - 13}`
                  : `M ${a.x},${a.y} Q ${mid.x},${mid.y} ${b.x},${b.y}`
                return jsx('path', {
                  key: `${link.from}->${link.to}`,
                  d,
                  fill: 'none',
                  stroke: flowColor(link),
                  strokeWidth: 1 + Math.min(link.flows, 6) * 0.9,
                  strokeLinecap: 'round',
                  opacity: 0.75,
                  markerEnd: selfLoop ? undefined : 'url(#fleetMatrixArrow)',
                  className: 'cursor-pointer transition-opacity duration-150 hover:opacity-100',
                  title: `${link.from} ➔ ${link.to}: ${link.flows} flow${link.flows === 1 ? '' : 's'}, ${link.pending} awaiting reply`
                })
              }),
              // Bot discs: appearance color, sent→received tag, name label,
              // click opens the canonical chat.
              nodes.map((node, index) => {
                const pos = positionOf(index)
                const bot = byName.get(node.id)
                const meta = bot ? allMeta?.[bot.name] || {} : {}
                const appearance = botAppearance(node.id, meta)
                return jsxs(
                  'g',
                  {
                    key: node.id,
                    transform: `translate(${pos.x}, ${pos.y})`,
                    className: 'cursor-pointer transition-opacity duration-150 hover:opacity-100',
                    onClick: bot ? () => onOpenBot?.(bot, meta) : undefined,
                    role: bot ? 'button' : undefined,
                    'aria-label': bot ? `Open ${bot.name} chat` : undefined,
                    children: [
                      jsx('circle', {
                        r: 11,
                        fill: appearance.color || 'var(--ui-text-quaternary)',
                        stroke: 'rgba(0,0,0,0.25)',
                        strokeWidth: 1
                      }),
                      node.sent > 0 || node.received > 0
                        ? jsx('text', {
                            y: -17,
                            textAnchor: 'middle',
                            fontSize: 7.5,
                            fontWeight: 600,
                            fill: 'var(--ui-text-quaternary)',
                            children: `${node.sent}→${node.received}`
                          })
                        : null,
                      jsx('text', {
                        y: 25,
                        textAnchor: 'middle',
                        fontSize: 9,
                        fill: 'var(--ui-text-tertiary)',
                        children: String(botHandle(node.id)).slice(0, 9)
                      })
                    ]
                  },
                  node.id
                )
              })
            ]
          })
    ]
  })
}

/** Full-width fleet command center: a grid of every bot (status, last
 *  action, open loops, queue depth), global controls (pause all, quiet
 *  hours, digest now), and a kind-filterable timeline. Phase 3.2 adds the
 *  cross-bot search box. */
function FleetPage() {
  const { data, error, isLoading, refetch } = useRoster()
  const gatewayUp = useValue(host.state.gateway) === 'open'
  const gatewayBusy = useValue(host.state.gateway) === 'busy'
  const activeProfile = useValue(host.state.profile)
  const allMeta = $botMeta.get()
  const [timelineFilter, setTimelineFilter] = useState('all')
  // Cross-bot search (Phase 3.2): query state plus the last resolved result
  // set. null = no search yet; the content area swaps to results while a
  // query is active. searchSeq drops stale async responses (a slow RAG call
  // must not overwrite a newer fallback scan).
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  // The socket opening (boot, SSH reconnect, sleep/wake) is the signal to
  // retry immediately instead of waiting out the poll interval.
  useEffect(() => {
    if (gatewayUp) {
      void refetch()
    }
  }, [gatewayUp, refetch])

  const roster = Array.isArray(data?.profiles) ? data.profiles : []
  const fleetMeta = allMeta[FLEET_KEY] || {}
  const openLoops = openLoopsByBot(roster)
  // fleet-dispatch's approval queue lives on the bot host's disk; the
  // plugin has no FS access, so the grid reports the in-app count (0 until
  // Phase 4 wires the status RPC). Kept as a real field so the column and
  // the digest line stay honest when a source arrives.
  const queueDepth = {}
  const allPaused = roster.length > 0 && roster.every(bot => allMeta[bot.name]?.paused)
  const events = fleetTimeline(roster, timelineFilter)
  // Live squad matrix: handoffs derived from the same roster poll, so the
  // pipeline card below costs zero extra RPCs and re-renders on every poll.
  const handoffs = recentHandoffs(roster, 100)
  const matrix = buildHandoffMatrix(handoffs, roster)

  const togglePauseAll = () => {
    for (const bot of roster) {
      saveBotMeta(bot.name, { paused: !allPaused })
    }
    host.notify({
      kind: 'info',
      message: allPaused ? 'Fleet resumed — all bots can hand off tasks again' : 'Fleet paused — all handoffs blocked until resumed'
    })
  }

  const toggleQuietHours = () => {
    const next = !fleetMeta.quietHours
    saveBotMeta(FLEET_KEY, { quietHours: next })
    host.notify({
      kind: 'info',
      message: next ? 'Quiet hours on — fleet-dispatch refuses sends outside the allowed window' : 'Quiet hours off'
    })
  }

  const digestNow = () => {
    host.notify({
      kind: 'info',
      title: `Fleet digest · ${roster.length} bot${roster.length === 1 ? '' : 's'}`,
      message: composeFleetDigest(roster, allMeta, queueDepth)
    })
  }

  const statusOf = bot => {
    const meta = allMeta[bot.name] || {}
    const stateObj = unifiedBotState(
      bot,
      meta,
      Boolean($botUnread.get()[bot.name]),
      activeProfile,
      gatewayBusy,
      openLoops[bot.name] || 0
    )
    return stateObj
  }

  /** Search ALL bots' history. RAG universal search first (index_name
   *  omitted → excerpts across every profile); when the gateway doesn't
   *  expose rag_query (or it errors/returns nothing), fall back to a local
   *  session.list scan per bot filtered by the pure fleetSearchResults. */
  const runSearch = async raw => {
    const q = (raw || '').trim()
    const seq = ++searchSeq.current

    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }

    setSearching(true)
    let out = null

    try {
      const rag = await host.request('rag_query', { query: q, limit: 20 })

      if (Array.isArray(rag?.excerpts) && rag.excerpts.length) {
        out = rag.excerpts.map((excerpt, index) => ({
          bot: null,
          profile: excerpt.profile || excerpt.source || '',
          sessionId: excerpt.session_id || null,
          title: excerpt.title || '',
          preview: String(excerpt.text || excerpt.excerpt || '').slice(0, 160),
          fromBot: null,
          ts: excerpt.timestamp || 0,
          key: `${excerpt.session_id || 'rag'}-${index}`
        }))
      }
    } catch {
      /* rag_query unavailable — local scan below */
    }

    if (out === null) {
      // Fallback: flatten a session.list scan across every bot, then run
      // the pure filter. A bot that fails to answer is skipped, not fatal.
      const flat = []
      await Promise.all(
        (roster || []).map(async bot => {
          try {
            const res = await host.request('session.list', { profile: bot.name, limit: 20 })
            for (const session of res?.sessions ?? []) {
              flat.push({ profile: bot.name, ...session })
            }
          } catch {
            /* bot unreachable — skip */
          }
        })
      )
      out = fleetSearchResults(roster, flat, q)
    }

    if (seq === searchSeq.current) {
      setResults(out)
      setSearching(false)
    }
  }

  /** Open a search result's chat: canonical opener when the roster row is
   *  known (fallback path), else a direct session open (RAG path). */
  const openResult = result => {
    if (result?.bot) {
      void openBotChat(result.bot, allMeta[result.bot.name] || {})
      return
    }
    if (result?.sessionId && typeof host.openSession === 'function') {
      try {
        host.openSession(result.sessionId, { profile: result.profile })
      } catch {
        /* navigation failure is not fatal */
      }
    }
  }

  const clearSearch = () => {
    setQuery('')
    void runSearch('')
  }

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-2.5 pt-2.5 pb-1.5',
        children: [
          jsxs('div', {
            className: 'flex items-baseline gap-1.5',
            children: [
              jsx('span', {
                className: 'text-[0.6875rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                children: 'Fleet'
              }),
              jsx('span', {
                className: 'rounded-full bg-(--chrome-action-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--ui-text-tertiary)',
                children: String(roster.length)
              })
            ]
          }),
          jsx(Tip, {
            label: 'Fleet command center',
            children: jsx(Codicon, { name: 'server', className: 'text-[0.95rem] text-(--ui-text-tertiary)' })
          })
        ]
      }),
      // Global controls: pause/resume the whole fleet, notification schedule
      // toggle (rides bot-meta like every other fleet flag, so it follows
      // the profile across machines), and an on-demand activity summary.
      jsxs('div', {
        className: 'mx-2.5 mb-1.5 grid grid-cols-3 gap-1.5',
        children: [
          jsx(Tip, {
            label: allPaused ? 'Resumes work for all bots' : 'Pauses work for all bots (stops accepting tasks)',
            children: jsx(Button, {
              variant: 'secondary',
              size: 'sm',
              className: 'w-full justify-center gap-1 text-[0.6875rem]',
              onClick: togglePauseAll,
              children: [
                jsx(Codicon, { name: allPaused ? 'play' : 'pause', className: 'text-[0.8rem]' }),
                allPaused ? 'Resume all bots' : 'Pause all bots'
              ]
            })
          }),
          jsx(Tip, {
            label: fleetMeta.quietHours ? 'Bot working hours active (handoffs outside window are queued/paused)' : 'Bot working hours inactive (bots operate 24/7)',
            children: jsxs('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': Boolean(fleetMeta.quietHours),
              onClick: toggleQuietHours,
              className: cn(
                'flex w-full items-center justify-center gap-1.5 rounded-md border px-1.5 py-1 text-[0.6875rem] transition-colors',
                fleetMeta.quietHours
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-400 font-medium'
                  : 'border-(--ui-stroke-secondary) bg-(--chrome-action-hover) text-(--ui-text-tertiary) hover:text-foreground'
              ),
              children: [
                jsx(Codicon, { name: 'moon', className: 'text-[0.8rem]' }),
                fleetMeta.quietHours ? 'Working hours on' : 'Bot working hours'
              ]
            })
          }),
          jsx(Tip, {
            label: 'Creates a clean markdown activity summary of all bot tasks',
            children: jsx(Button, {
              variant: 'secondary',
              size: 'sm',
              className: 'w-full justify-center gap-1 text-[0.6875rem]',
              onClick: digestNow,
              children: [jsx(Codicon, { name: 'bell', className: 'text-[0.8rem]' }), 'Activity summary']
            })
          })
        ]
      }),
      // Cross-bot search: queries ALL bots' history via rag_query when the
      // gateway exposes it, else a local session.list scan.
      jsxs('div', {
        className: 'relative mx-2.5 mb-1.5 flex items-center',
        children: [
          jsx(Codicon, {
            name: 'search',
            className: 'pointer-events-none absolute left-2 text-[0.9rem] text-(--ui-text-quaternary)'
          }),
          jsx(Input, {
            className:
              'h-7 w-full rounded-md bg-(--chrome-action-hover) pl-7 pr-7 text-xs text-foreground placeholder:text-(--ui-text-quaternary)',
            placeholder: 'Search all bot history…',
            value: query,
            'aria-label': 'Search all bot history',
            onChange: event => {
              setQuery(event.target.value)
              void runSearch(event.target.value)
            },
            onKeyDown: event => {
              if (event.key === 'Escape') {
                clearSearch()
                event.currentTarget.blur()
              }
            }
          }),
          query
            ? jsx('span', {
                role: 'button',
                tabIndex: 0,
                title: 'Clear search',
                'aria-label': 'Clear search',
                className:
                  'absolute right-1.5 flex size-5 cursor-pointer items-center justify-center rounded text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
                onClick: clearSearch,
                onKeyDown: event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    clearSearch()
                  }
                },
                children: jsx(Codicon, { name: 'close', className: 'text-[0.85rem]' })
              })
            : null
        ]
      }),
      // Timeline filter: All / Bot-to-bot / Human / Cron.
      jsxs('div', {
        className: 'mx-2.5 mb-1.5 flex items-center gap-px overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--chrome-action-hover)',
        children: TIMELINE_FILTERS.map(filter => {
          const active = timelineFilter === filter.id
          return jsx('button', {
            type: 'button',
            key: filter.id,
            'aria-pressed': active,
            onClick: () => setTimelineFilter(filter.id),
            className: cn(
              'flex-1 px-1.5 py-1 text-[0.625rem] font-medium transition-colors',
              active ? 'bg-(--ui-accent,#4f9cf9) text-white' : 'text-(--ui-text-tertiary) hover:text-foreground'
            ),
            children: filter.label
          })
        })
      }),
      error && !roster.length
        ? jsxs('div', {
            className: 'grid gap-2 px-3 py-4 text-xs text-(--ui-text-tertiary)',
            children: [
              jsx('div', {
                children: gatewayUp
                  ? `Roster unavailable: ${error instanceof Error ? error.message : 'gateway error'}.`
                  : 'Waiting for the gateway connection…'
              }),
              jsx(Button, { variant: 'secondary', size: 'sm', className: 'justify-self-start', onClick: () => void refetch(), children: 'Retry now' })
            ]
          })
        : isLoading && !roster.length
          ? jsx('div', {
              className: 'flex flex-1 items-center justify-center',
              children: jsx(GlyphSpinner, { spinner: 'breathe', className: 'text-(--ui-text-tertiary)' })
            })
          : roster.length === 0
            ? jsx(EmptyState, { icon: 'hubot', title: 'No agents yet', description: 'Create your first teammate to build the fleet.' })
            : query.trim()
              ? jsx(ScrollArea, {
                  className: 'min-h-0 flex-1',
                  children: searching
                    ? jsx('div', {
                        className: 'flex h-full items-center justify-center py-8 text-xs text-(--ui-text-tertiary)',
                        children: 'Searching all bots…'
                      })
                    : !results?.length
                      ? jsxs('div', {
                          className: 'grid gap-2 px-3 py-6 text-center text-xs text-(--ui-text-tertiary)',
                          children: [
                            jsx(Codicon, { name: 'search', className: 'mx-auto text-[1.4rem] text-(--ui-text-quaternary)' }),
                            jsx('div', { children: `No history matches “${query.trim()}”` }),
                            jsx(Button, { variant: 'secondary', size: 'sm', className: 'justify-self-center', onClick: clearSearch, children: 'Clear search' })
                          ]
                        })
                      : jsx('div', {
                          className: 'flex flex-col gap-px p-2.5',
                          children: results.map((result, index) => {
                            const botMeta = result.bot ? allMeta[result.bot.name] || {} : null
                            const { shape, color, image } = botMeta
                              ? botAppearance(result.bot.name, botMeta)
                              : { shape: 'circle', color: 'var(--ui-text-quaternary)', image: null }

                            return jsxs(
                              'button',
                              {
                                type: 'button',
                                key: result.key || result.sessionId || `${result.profile}:${index}`,
                                className:
                                  'flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)',
                                onClick: () => openResult(result),
                                children: [
                                  result.bot
                                    ? jsx(BotFace, { shape, color, image, size: 18, name: result.bot.name, mood: 'idle' })
                                    : jsx('span', { className: 'w-[18px] shrink-0 text-center text-[0.7rem]', children: '🤖' }),
                                  jsx('span', {
                                    className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                                    children: `@${result.profile}`
                                  }),
                                  result.title
                                    ? jsx('span', {
                                        className: 'max-w-[30%] shrink-0 truncate text-[0.6875rem] font-medium',
                                        children: result.title
                                      })
                                    : null,
                                  jsx('span', {
                                    className: 'min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                                    children: result.preview
                                  }),
                                  result.ts
                                    ? jsx('span', {
                                        className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                                        children: relativeTime(result.ts * 1000)
                                      })
                                    : null
                                ]
                              },
                              result.key || result.sessionId || `${result.profile}:${index}`
                            )
                          })
                        })
                })
              : jsx(ScrollArea, {
                className: 'min-h-0 flex-1',
                children: jsx('div', {
                  className: 'grid gap-2 p-2.5',
                  children: [
                    // Fleet grid: one card per bot — status, last action,
                    // open loops, queue depth.
                    jsx('div', {
                      className: 'grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3',
                      children: roster.map(bot => {
                        const meta = allMeta[bot.name] || {}
                        const { shape, color, image } = botAppearance(bot.name, meta)
                        const st = statusOf(bot)
                        const last = bot.last_session
                        const loops = openLoops[bot.name] || 0
                        const queued = queueDepth[bot.name] || 0

                        return jsxs(
                          'div',
                          {
                            key: bot.name,
                            className: cn(
                              'rounded-lg border border-(--ui-stroke-secondary) p-2.5 transition-colors hover:border-(--ui-stroke-primary, var(--ui-stroke-secondary))',
                              st.state === 'paused' && 'opacity-70'
                            ),
                            children: [
                              jsxs('div', {
                                className: 'flex items-center gap-1.5',
                                children: [
                                  jsx(BotFace, { shape, color, image, size: 22, name: bot.name, mood: st.state === 'working' ? 'work' : 'idle' }),
                                  jsx('span', {
                                    className: 'min-w-0 flex-1 truncate text-xs font-semibold',
                                    children: displayName(bot, meta)
                                  }),
                                  jsxs('span', {
                                    className: cn(
                                      'flex shrink-0 items-center gap-1 rounded-full bg-(--chrome-action-hover) px-2 py-0.5 text-[0.625rem] font-medium capitalize',
                                      st.cls
                                    ),
                                    children: st.label
                                  })
                                ]
                              }),
                              jsx('p', {
                                className: 'mt-1.5 line-clamp-2 text-[0.6875rem] text-(--ui-text-tertiary) font-mono',
                                children: st.verb || (last?.preview ? last.preview.replace(A2A_PREFIX_RE, '').trim() : 'No activity yet')
                              }),
                              jsxs('div', {
                                className: 'mt-1.5 flex items-center gap-1.5 text-[0.625rem] text-(--ui-text-quaternary)',
                                children: [
                                  jsxs('span', {
                                    className: 'flex items-center gap-0.5',
                                    title: 'Open loops — handoffs this bot sent that are still unanswered',
                                    children: [jsx(Codicon, { name: 'sync', className: 'text-[0.7rem]' }), `${loops} open`]
                                  }),
                                  jsxs('span', {
                                    className: 'flex items-center gap-0.5',
                                    title: 'Approval queue depth (fleet-dispatch pending)',
                                    children: [jsx(Codicon, { name: 'inbox', className: 'text-[0.7rem]' }), `${queued} queued`]
                                  }),
                                  last
                                    ? jsx('span', { className: 'ml-auto', children: relativeTime(last.last_active * 1000) })
                                    : null
                                ]
                              })
                            ]
                          },
                          bot.name
                        )
                      })
                    }),
                    // Squad pipeline: interactive flow matrix + live stats.
                    jsx(FleetMatrix, {
                      matrix,
                      roster,
                      allMeta,
                      onOpenBot: (bot, meta) => void openBotChat(bot, meta)
                    }),
                    // Timeline: newest event per bot, filtered by kind.
                    jsxs('div', {
                      className: 'mt-1',
                      children: [
                        jsxs('div', {
                          className: 'flex items-center gap-1.5 px-0.5 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                          children: [jsx(Codicon, { name: 'history', className: 'text-[0.8rem]' }), 'Timeline']
                        }),
                        events.length
                          ? jsx('div', {
                              className: 'flex flex-col gap-px',
                              children: events.map(event => {
                                const botMeta = allMeta[event.bot.name] || {}
                                const { shape, color, image } = botAppearance(event.bot.name, botMeta)

                                return jsxs(
                                  'button',
                                  {
                                    type: 'button',
                                    className:
                                      'flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)',
                                    onClick: () => void openBotChat(event.bot, botMeta),
                                    children: [
                                      jsx(BotFace, { shape, color, image, size: 18, name: event.bot.name, mood: 'idle' }),
                                      jsx('span', {
                                        className: 'shrink-0 text-[0.625rem]',
                                        title: event.kind,
                                        children:
                                          event.kind === 'bot_to_bot'
                                            ? '🤖'
                                            : event.kind === 'cron'
                                              ? '🗓'
                                              : '🧑'
                                      }),
                                      jsx('span', {
                                        className: 'shrink-0 text-[0.6875rem] font-medium',
                                        children: displayName(event.bot, botMeta)
                                      }),
                                      jsx('span', {
                                        className: 'min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                                        children: event.preview
                                      }),
                                      jsx('span', {
                                        className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                                        children: relativeTime(event.ts * 1000)
                                      })
                                    ]
                                  },
                                  event.bot.name + event.ts
                                )
                              })
                            })
                          : jsx('div', {
                              className: 'px-0.5 py-2 text-[0.6875rem] text-(--ui-text-quaternary)',
                              children: 'No events in this filter yet.'
                            })
                      ]
                    })
                  ]
                })
              })
    ]
  })
}

// ── squad workstream board (Phase 5) ─────────────────────────────────────────

function TaskCard({ task, onOpenChat, onReview, allMeta = {} }) {
  const meta = allMeta[task.botName] || {}
  const { shape, color, image } = botAppearance(task.botName, meta)
  const deliv = task.deliverable || { kind: 'task', icon: 'check', label: 'Deliverable' }

  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    onClick: () => onReview(task),
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onReview(task)
      }
    },
    className: cn(
      'group/card flex flex-col gap-2 rounded-lg border p-2.5 transition-all text-left cursor-pointer select-none',
      task.isUnread
        ? 'border-amber-400/60 bg-amber-500/10 shadow-xs'
        : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary,#161618)/40 hover:border-(--ui-stroke-secondary)/90 hover:bg-(--chrome-action-hover)'
    ),
    children: [
      // Top header: Bot identity + status dot + relative time
      jsxs('div', {
        className: 'flex items-center justify-between gap-1.5',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5 truncate',
            children: [
              jsx(BotFace, { shape, color, image, size: 20, name: task.botName, mood: task.isActiveNow ? 'work' : 'idle' }),
              jsx('span', { className: 'font-mono text-[0.6875rem] font-semibold text-foreground truncate', children: `@${botHandle(task.botName)}` })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              task.isActiveNow
                ? jsx('span', { className: 'size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]', title: 'Working now' })
                : task.isUnread
                  ? jsx('span', { className: 'size-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_#fbbf24]', title: 'Waiting for you' })
                  : null,
              jsx('span', { className: 'font-mono text-[0.625rem] text-(--ui-text-quaternary)', children: relativeTime(task.ts * 1000) })
            ]
          })
        ]
      }),

      // Task Title
      jsx('div', {
        className: 'text-[0.8125rem] font-semibold leading-snug text-foreground line-clamp-2',
        children: task.title
      }),

      // Status Verb line
      jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary) truncate font-mono',
        children: task.preview || 'No description'
      }),

      // Footer: Deliverable chip + 1 Primary Action
      jsxs('div', {
        className: 'flex items-center justify-between pt-1 border-t border-(--ui-stroke-secondary)/40 gap-1 mt-0.5',
        children: [
          jsxs('span', {
            className: 'inline-flex items-center gap-1 rounded bg-(--chrome-action-hover) px-1.5 py-0.5 text-[0.625rem] font-mono text-(--ui-text-secondary)',
            children: [
              jsx(Codicon, { name: deliv.icon || 'check', className: 'text-[0.65rem] text-(--ui-accent,#4f9cf9)' }),
              jsx('span', { children: deliv.label })
            ]
          }),
          jsx('button', {
            type: 'button',
            className: cn(
              'rounded px-2 py-0.5 text-[0.6875rem] font-semibold transition-colors',
              task.isUnread
                ? 'bg-amber-400 text-black hover:bg-amber-300'
                : 'bg-(--ui-accent,#4f9cf9)/15 text-(--ui-accent,#4f9cf9) hover:bg-(--ui-accent,#4f9cf9)/25'
            ),
            onClick: e => {
              e.stopPropagation()
              onReview(task)
            },
            children: task.isUnread ? 'Review changes' : 'Open'
          })
        ]
      })
    ]
  })
}

function TaskReviewDrawer({ task, open, onClose, onOpenChat, allMeta = {} }) {
  if (!open || !task) return null
  const meta = allMeta[task.botName] || {}
  const deliv = task.deliverable || { label: 'Deliverable', icon: 'check' }

  return jsx(Dialog, {
    open: Boolean(open),
    onOpenChange: isOpen => { if (!isOpen) onClose() },
    children: jsxs(DialogContent, {
      className: 'max-w-xl p-0 overflow-hidden bg-background border border-(--ui-stroke-secondary) shadow-2xl',
      children: [
        jsxs(DialogHeader, {
          className: 'px-4 pt-4 pb-3 border-b border-(--ui-stroke-secondary)',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Badge, { tone: task.isUnread ? 'warning' : 'accent', children: `@${botHandle(task.botName)}` }),
                jsx(DialogTitle, { className: 'text-sm font-semibold truncate', children: task.title })
              ]
            }),
            jsxs(DialogDescription, {
              className: 'flex items-center gap-2 pt-1 font-mono text-[0.6875rem] text-(--ui-text-tertiary)',
              children: [
                jsx('span', { children: `Kind: ${task.kind}` }),
                jsx('span', { children: '·' }),
                jsx('span', { children: `Updated: ${relativeTime(task.ts * 1000)}` })
              ]
            })
          ]
        }),
        jsxs('div', {
          className: 'flex flex-col gap-3 p-4 text-xs max-h-[60vh] overflow-y-auto',
          children: [
            jsxs('div', {
              className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) p-3 bg-(--chrome-action-hover)/40',
              children: [
                jsx('span', { className: 'font-semibold uppercase tracking-wider text-[0.625rem] text-(--ui-text-quaternary)', children: 'Executive Summary / Finding' }),
                jsx('p', { className: 'text-sm font-medium text-foreground leading-relaxed', children: task.preview || 'Task completed with no preview text.' })
              ]
            }),
            jsxs('div', {
              className: 'flex flex-col gap-1.5 rounded-md border border-(--ui-stroke-secondary) p-3',
              children: [
                jsx('span', { className: 'font-semibold uppercase tracking-wider text-[0.625rem] text-(--ui-text-quaternary)', children: 'Target Deliverable' }),
                jsxs('div', {
                  className: 'flex items-center gap-2 font-mono text-xs text-(--ui-accent,#4f9cf9)',
                  children: [
                    jsx(Codicon, { name: deliv.icon || 'check' }),
                    jsx('span', { className: 'font-semibold', children: deliv.label })
                  ]
                })
              ]
            })
          ]
        }),
        jsxs(DialogFooter, {
          className: 'px-4 py-3 border-t border-(--ui-stroke-secondary) flex items-center justify-between gap-2',
          children: [
            jsx(Button, {
              variant: 'ghost',
              size: 'sm',
              onClick: onClose,
              children: 'Done & Close'
            }),
            jsx(Button, {
              size: 'sm',
              onClick: () => {
                onClose()
                onOpenChat(task)
              },
              children: 'Open Session Chat ➔'
            })
          ]
        })
      ]
    })
  })
}

function SquadBoardPage() {
  const { data, refetch } = useRoster()
  const gatewayState = useValue(host.state.gateway)
  const activeProfile = useValue(host.state.profile)
  const unread = useValue($botUnread)
  const allMeta = useValue($botMeta)
  const [botFilter, setBotFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedTask, setSelectedTask] = useState(null)
  const [showAllDone, setShowAllDone] = useState(false)

  const roster = Array.isArray(data?.profiles) ? data.profiles : []
  const columns = deriveWorkstreamTasks(
    roster,
    unread,
    activeProfile,
    gatewayState === 'busy',
    Date.now() / 1000
  )

  const openTaskChat = async task => {
    if (task.id && typeof host.openSession === 'function') {
      try {
        await host.openSession(task.id, { profile: task.botName })
        return
      } catch {
        /* fallback below */
      }
    }
    await openBotChat(task.bot || { name: task.botName }, allMeta[task.botName])
  }

  const columnConfig = [
    { key: 'needs_review', title: 'Needs you', icon: 'eye', tone: 'text-amber-400' },
    { key: 'in_progress', title: 'Working', icon: 'play', tone: 'text-emerald-400' },
    { key: 'inbox', title: 'Queued', icon: 'inbox', tone: 'text-(--ui-text-tertiary)' },
    { key: 'completed', title: 'Done', icon: 'check-all', tone: 'text-(--ui-accent,#4f9cf9)' }
  ]

  return jsxs('div', {
    className: 'flex h-full w-full flex-col bg-background overflow-hidden',
    children: [
      // Board Header Bar
      jsxs('div', {
        className: 'flex shrink-0 items-center justify-between border-b border-(--ui-stroke-secondary) px-4 py-3 gap-3',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-3',
            children: [
              jsx('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('span', { className: 'text-base font-bold tracking-tight text-foreground', children: 'Tasks' }),
                  jsx(Badge, { tone: 'neutral', children: `${roster.length} bots` })
                ]
              }),
              // Bot Filter Tabs
              jsxs('div', {
                className: 'flex items-center gap-1 rounded-lg border border-(--ui-stroke-secondary) p-0.5 bg-(--ui-bg-secondary,#161618)/30',
                children: [
                  jsx('button', {
                    type: 'button',
                    className: cn(
                      'rounded-md px-2 py-1 text-[0.6875rem] font-medium transition-colors',
                      botFilter === 'all' ? 'bg-(--chrome-action-hover) text-foreground shadow-xs' : 'text-(--ui-text-tertiary) hover:text-foreground'
                    ),
                    onClick: () => setBotFilter('all'),
                    children: 'All bots'
                  }),
                  roster.map(b =>
                    jsx(
                      'button',
                      {
                        type: 'button',
                        className: cn(
                          'rounded-md px-2 py-1 font-mono text-[0.6875rem] font-medium transition-colors',
                          botFilter === b.name ? 'bg-(--chrome-action-hover) text-foreground shadow-xs' : 'text-(--ui-text-tertiary) hover:text-foreground'
                        ),
                        onClick: () => setBotFilter(b.name),
                        children: `@${botHandle(b.name)}`
                      },
                      b.name
                    )
                  )
                ]
              })
            ]
          }),

          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(SearchField, {
                placeholder: 'Filter tasks…',
                value: query,
                onChange: setQuery,
                containerClassName: 'w-48'
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: () => {
                  void refetch()
                  haptic('tap')
                },
                children: 'Refresh'
              })
            ]
          })
        ]
      }),

      // Responsive Board Grid
      jsx('div', {
        className: 'grid flex-1 grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 p-4 overflow-y-auto min-h-0 bg-(--ui-bg-secondary,#161618)/10',
        children: columnConfig.map(col => {
          const rawTasks = columns[col.key] || []
          const filtered = filterBoardTasks(rawTasks, botFilter, query)
          const isDone = col.key === 'completed'
          const displayTasks = isDone && !showAllDone ? filtered.slice(0, 3) : filtered

          return jsxs(
            'div',
            {
              className: 'flex flex-col rounded-xl border border-(--ui-stroke-secondary) bg-card/60 p-3 shadow-xs',
              children: [
                // Column Header
                jsxs('div', {
                  className: 'flex shrink-0 items-center justify-between pb-2 mb-2 border-b border-(--ui-stroke-secondary)/60',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-1.5',
                      children: [
                        jsx(Codicon, { name: col.icon, className: cn('text-xs', col.tone) }),
                        jsx('span', { className: 'text-xs font-semibold text-foreground', children: col.title })
                      ]
                    }),
                    jsx('span', {
                      className: 'rounded-full bg-(--chrome-action-hover) px-1.5 py-px font-mono text-[0.625rem] font-medium text-(--ui-text-tertiary)',
                      children: String(filtered.length)
                    })
                  ]
                }),

                // Column Tasks List
                jsxs('div', {
                  className: 'flex flex-col gap-2',
                  children: [
                    displayTasks.length === 0
                      ? jsx('div', {
                          className: 'rounded-lg border border-dashed border-(--ui-stroke-secondary)/60 p-4 text-center text-xs text-(--ui-text-quaternary)',
                          children: 'No tasks'
                        })
                      : displayTasks.map(task =>
                          jsx(
                            TaskCard,
                            {
                              task,
                              onOpenChat: openTaskChat,
                              onReview: setSelectedTask,
                              allMeta
                            },
                            task.id
                          )
                        ),
                    isDone && filtered.length > 3
                      ? jsx('button', {
                          type: 'button',
                          className: 'text-center py-1.5 text-[0.6875rem] font-mono text-(--ui-accent,#4f9cf9) hover:underline rounded bg-(--chrome-action-hover)/40 hover:bg-(--chrome-action-hover)',
                          onClick: () => setShowAllDone(prev => !prev),
                          children: showAllDone
                            ? 'Collapse older completed tasks ▴'
                            : `+${filtered.length - 3} older completed tasks (click to expand) ▾`
                        })
                      : null
                  ]
                })
              ]
            },
            col.key
          )
        })
      }),

      // Review Modal Drawer
      jsx(TaskReviewDrawer, {
        task: selectedTask,
        open: Boolean(selectedTask),
        allMeta,
        onClose: () => setSelectedTask(null),
        onOpenChat: openTaskChat
      })
    ]
  })
}

// ── tool execution pills ──────────────────────────────────────────────────────
// Lightweight collapsible pills for tool executions in chat streams: a status
// dot, a codicon, a one-line summary, and an elapsed timer. Pure functions —
// no dependencies, no timers — so rendering stays instant and testable.

const TOOL_PILL_ICONS = {
  terminal: 'terminal',
  bash: 'terminal',
  read_file: 'file-code',
  write_file: 'file-add',
  patch: 'diff',
  edit: 'edit',
  web_search: 'globe',
  web_extract: 'globe',
  rag_query: 'database',
  execute_code: 'code'
}

function formatToolDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '0s'
  if (seconds < 60) {
    const tenths = Math.round(seconds * 10) / 10
    return `${tenths}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

function toolArgBrief(toolName, args) {
  if (!args || typeof args !== 'object') return '…'
  const pick = args.command ?? args.path ?? args.query ?? args.url ?? args.goal
  if (typeof pick === 'string' && pick.trim()) {
    return pick.length > 72 ? `${pick.slice(0, 72)}…` : pick
  }
  // Fall back to the first string value in the args bag.
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) {
      return value.length > 72 ? `${value.slice(0, 72)}…` : value
    }
  }
  return '…'
}

function formatToolSummary(toolName, args = {}, duration = 0) {
  const name = String(toolName || 'tool')
  return {
    icon: TOOL_PILL_ICONS[name] || 'tools',
    label: `${name}: ${toolArgBrief(name, args)}`,
    duration: formatToolDuration(duration)
  }
}

function StatusDot({ tone = 'success', className = '' }) {
  const tones = {
    success: 'bg-(--ui-success)',
    running: 'bg-(--ui-accent) animate-pulse',
    error: 'bg-(--ui-danger)',
    idle: 'bg-(--ui-text-quaternary)'
  }
  const dotClass = tones[tone] || tones.idle
  return jsx('span', {
    className: `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass} ${className}`,
    'data-tone': tone
  })
}

function ToolPill({
  toolName,
  args = {},
  duration = 0,
  status = 'success',
  expanded = false,
  onToggle
}) {
  const [open, setOpen] = useState(expanded)
  const isOpen = expanded !== undefined ? expanded : open
  const summary = formatToolSummary(toolName, args, duration)
  const tone = status === 'running' ? 'running' : status === 'error' ? 'error' : 'success'

  return jsx('div', {
    className: 'hermes-bots-tool-pill flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg) px-2 py-1',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => (onToggle ? onToggle(!isOpen) : setOpen(!isOpen)),
        className: 'flex min-w-0 flex-1 items-center gap-1.5 text-left',
        children: [
          jsx(StatusDot, { tone }),
          jsx(Codicon, { name: summary.icon, className: 'shrink-0 text-[0.8rem] text-(--ui-text-secondary)' }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate font-mono text-[0.75rem] text-(--ui-text-secondary)',
            children: summary.label
          }),
          jsx('span', {
            className: 'shrink-0 font-mono text-[0.6875rem] text-(--ui-text-quaternary)',
            children: summary.duration
          }),
          jsx(Codicon, { name: isOpen ? 'chevron-down' : 'chevron-right', className: 'shrink-0 text-[0.7rem] text-(--ui-text-quaternary)' })
        ]
      }),
      isOpen
        ? jsx('div', {
            className: 'overflow-x-auto whitespace-pre font-mono text-[0.6875rem] text-(--ui-text-tertiary)',
            children: JSON.stringify(args, null, 2)
          })
        : null
    ]
  })
}

// ── plugin ───────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Bots',
  register(ctx) {
    pluginCtx = ctx

    // Keyframes for the pet bob — injected because plugin classes aren't in
    // the app's precompiled CSS. Idempotent across hot reloads.
    if (!document.getElementById('hermes-bots-keyframes')) {
      const style = document.createElement('style')
      style.id = 'hermes-bots-keyframes'
      style.textContent = '@keyframes hermes-bots-bob { from { transform: translateY(0); } to { transform: translateY(-3px); } }'
      document.head.appendChild(style)
    }

    // Hydrate persisted avatars/titles. Storage may be sync, async, or
    // absent depending on shell version — normalize through Promise.resolve
    // inside a try so a storage quirk can NEVER fail the plugin load.
    try {
      Promise.resolve(ctx.storage?.get?.('bot-meta'))
        .then(value => {
          if (value && typeof value === 'object') {
            $botMeta.set(value)
          }
        })
        .catch(() => undefined)
    } catch {
      /* no storage on this shell — defaults stay */
    }

    // Hydrate pinned sessions (same normalization as bot-meta).
    try {
      Promise.resolve(ctx.storage?.get?.('pinned-sessions'))
        .then(value => {
          if (value && typeof value === 'object') {
            $pinnedSessions.set(value)
          }
        })
        .catch(() => undefined)
    } catch {
      /* no storage on this shell — defaults stay */
    }

    // Routines follow the chat you're in: track the live gateway profile.
    host.state.profile.listen(profile => {
      if (profile && typeof profile === 'string') {
        $selectedBot.set(profile)
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Bots',
      data: { placement: 'left', width: '260px' },
      render: () => jsx(BotsPane, {})
    })

    // Routines — its OWN tiling pane splitting the workspace's right edge
    // (NOT the collapsible right sidebar; placement 'right' is that sidebar's
    // role and hides the pane until "Show Right Sidebar").
    ctx.register({
      id: 'routines',
      area: 'panes',
      title: 'Cronjobs',
      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '250px'
      },
      render: () => jsx(RoutinesPane, {})
    })

    // Fleet — command center tile, docked like Routines: its own tiling
    // pane splitting the workspace's right edge.
    ctx.register({
      id: 'fleet',
      area: 'panes',
      title: 'Fleet',
      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '250px'
      },
      render: () => jsx(FleetPage, {})
    })

    // Full Squad Workstream Board page — accessible at /board and in sidebar nav
    if (typeof ROUTES_AREA !== 'undefined') {
      ctx.register({
        id: 'squad-board-route',
        area: ROUTES_AREA,
        data: { path: '/board' },
        render: () => jsx(SquadBoardPage, {})
      })
    }

    if (typeof SIDEBAR_NAV_AREA !== 'undefined') {
      ctx.register({
        id: 'squad-board-nav',
        area: SIDEBAR_NAV_AREA,
        data: {
          path: '/board',
          label: 'Squad Board',
          codicon: 'project'
        }
      })
    }

    ctx.register({
      id: 'open-squad-board',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open-squad-board`,
        label: 'Open Squad Board…',
        keywords: ['board', 'squad', 'kanban', 'tasks', 'fleet', 'workstream'],
        run: () => {
          if (typeof host.navigate === 'function') {
            host.navigate('/board')
          }
        }
      }
    })

    ctx.register({
      id: 'new-agent',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.new-agent`,
        label: 'New Agent…',
        keywords: ['bot', 'agent', 'profile', 'teammate', 'create'],
        run: () => {
          host.notify({ kind: 'info', message: 'Open the Bots pane and hit “New Agent”.' })
        }
      }
    })

    // ⌘K fast-dispatch: one "Ask @<bot>…" row per live roster bot. The
    // roster loads async, so register now (whatever is known) and keep the
    // rows in step as the poll refreshes it. Guarded: the palette surface
    // and the atom's listen may be absent on some shells.
    syncBotPaletteActions()

    if (typeof $lastRoster.listen === 'function') {
      $lastRoster.listen(() => syncBotPaletteActions())
    }

    // @-mention middleware: "@<bot> do the thing" in any chat becomes an
    // explicit handoff instruction the active agent's SOUL.md knows how to
    // execute. Names are validated against the LIVE roster so
    // "user@example.com" or an unknown @ passes through untouched.
    ctx.register({
      id: 'mention-middleware',
      area: COMPOSER_AREAS.middleware,
      data: {
        handler: async draft => {
          const text = draft.text || ''

          // /new inside a bot's canonical forever-chat would fork the
          // relationship into a scratch session — the one thing Bots mode
          // promises never happens. Reroute to /compact (same felt effect:
          // fresh working context, SAME conversation) and say so. Only
          // guards the canonical chat: Sessions-mode scratchpads on the
          // same profile keep full /new freedom.
          const slashNew = /^\/(new|reset)\s*$/.exec(text.trim())

          if (slashNew) {
            const activeBot = $selectedBot.get()
            const meta = activeBot ? $botMeta.get()[activeBot] : null
            const pinnedId = meta?.chat_pin || null
            const currentId = host.activeSessionId?.get?.() ?? null

            if (activeBot && pinnedId && currentId && String(currentId) === String(pinnedId)) {
              host.notify({
                kind: 'info',
                title: 'This chat never resets',
                message:
                  'Bot chats are one continuous conversation — compacting instead. ' +
                  'For a throwaway session with this agent, use Sessions mode.'
              })

              return { ...draft, text: '/compact' }
            }
          }

          if (!/(^|\s)@[a-z0-9][a-z0-9_-]*/i.test(text)) {
            return draft
          }

          let names = []
          try {
            const res = await host.request('profiles.list', { include_sessions: false })
            names = (res?.profiles ?? []).map(p => p.name)
          } catch {
            return draft
          }

          // Mentions in code are code, not handoffs (#20).
          const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
          const active = (host.state.profile.get() || 'default').trim() || 'default'
          const mentioned = []

          for (const match of prose.matchAll(/(^|\s)@([a-z0-9][a-z0-9_-]*)/gi)) {
            let name = match[2].toLowerCase()

            if (name === 'hermes' && !names.includes('hermes') && names.includes('default')) {
              name = 'default'
            }

            if (names.includes(name) && name !== active && !mentioned.includes(name)) {
              mentioned.push(name)
            }
          }

          if (!mentioned.length) {
            return draft
          }

          // The ACTIVE BOT composes the message — it understands intent; a
          // text pipe never can. Delivery is the one blessed command into the
          // recipient's canonical Bot Chat, so their side reads as a normal
          // DM (message bubble + their reply), and the reply prints on
          // stdout for the sender to relay.
          // Paused bots don't dispatch handoffs — the human paused them on
          // purpose. The mention stays as plain text; the handoff note is
          // withheld so the bot won't send anything.
          const activeMeta = $botMeta.get()[active]

          if (activeMeta?.paused) {
            host.notify({
              kind: 'info',
              title: `${displayName({ name: active, title: activeMeta?.title }, activeMeta)} is paused`,
              message: 'Handoff not dispatched — resume the bot in the Bots pane to send tasks.'
            })
            return draft
          }

          const senderName = displayName({ name: active, title: activeMeta?.title }, activeMeta)
          const note =
            '\n\n[@mention handoff — for each mentioned agent (' + mentioned.map(botHandle).join(', ') + '): ' +
            'COMPOSE a message from you (' + senderName + ') to that agent conveying what the user wants — do not forward this text verbatim. Send it with exactly one terminal call, run with background=true AND notify_on_complete=true (the recipient may take minutes; the user must not be blocked):\n' +
            mentioned.map(n => '`' + fleetDispatchCommand(botHandle(active), n, '<your composed message>') + '`').join('\n') +
            '\nIf `fleet-dispatch` is not installed, fall back to `' +
            mentioned.map(n => rawChatCommand(botHandle(active), n, '<your composed message>')).join('` or `') +
            '`. ' +
            '\nAfter dispatching, tell the user the message was sent and END YOUR TURN — do not wait or poll; when the background process completes, its notification carries the reply — relay it then, attributed to that agent. If it fails with "No session found matching \'Bot Chat\'", send once without the -c flag, then run `hermes -p <agent> sessions rename <session_id from the output> "Bot Chat"`. ' +
            'Relay the reply back to the user, attributed to that agent.]'

          return { ...draft, text: text + note }
        }      }
    })
  }
}
