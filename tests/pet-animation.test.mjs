import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function load(fetchImpl) {
  const values = new Map()
  const atom = initial => {
    const slot = { get: () => values.get(slot), set: value => values.set(slot, value) }
    values.set(slot, initial)
    return slot
  }
  const fetches = []
  const context = {
    atom,
    PALETTE_AREA: 'palette',
    COMPOSER_AREAS: { middleware: 'middleware' },
    document: {
      getElementById: () => null,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/png;base64,ok'
      }),
      head: { appendChild: () => undefined }
    },
    host: { state: { profile: { listen: () => undefined } } },
    fetch: async (url, opts) => {
      fetches.push({ url, opts })
      return fetchImpl(url, opts)
    },
    AbortSignal,
    URL: { createObjectURL: () => 'blob:test-object-url' },
    createImageBitmap: async () => ({ close() {} })
  }
  const source = pluginSource
    .replace(/^import\s+\*\s+as\s+sdk\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^const \{ McpTab, ToolsetConfigPanel \} = sdk\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat(
      '\nglobalThis.__api = { petFrameIcon, petRowFor, petFrameIndex, petSheetObjectUrl, paintPetTile };'
    )
  vm.runInNewContext(source, context, { filename: 'plugin.js' })
  return { context, fetches }
}

/** Minimal element stub: mood + geometry attributes, a style object. */
function tile(mood) {
  return {
    getAttribute: key =>
      ({
        'data-hb-mood': mood,
        'data-hb-pet': 'test-pet',
        'data-hb-dw': '31',
        'data-hb-dh': '34'
      })[key] || '',
    style: {}
  }
}

test('petRowFor: idle stays put, work jumps once then runs', () => {
  const { context } = load(async () => {
    throw new Error('unused')
  })
  assert.equal(context.__api.petRowFor('idle', false), 0, 'idle → row 0')
  assert.equal(context.__api.petRowFor('idle', true), 0, 'idle never bursts')
  assert.equal(context.__api.petRowFor('work', true), 4, 'work burst → jumping row')
  assert.equal(context.__api.petRowFor('work', false), 1, 'settled work → running-right row')
})

test('petFrameIndex: 6 frames over the 1100ms petdex loop', () => {
  const { context } = load(async () => {
    throw new Error('unused')
  })
  assert.equal(context.__api.petFrameIndex(0), 0)
  assert.equal(context.__api.petFrameIndex(0.2), 1, '~183ms per frame')
  assert.equal(context.__api.petFrameIndex(0.5), 2)
  assert.equal(context.__api.petFrameIndex(0.9), 4)
  assert.equal(context.__api.petFrameIndex(1.09), 5, 'last frame before the loop wraps')
  assert.equal(context.__api.petFrameIndex(1.1), 0, 'loop wraps at 1100ms')
  assert.equal(context.__api.petFrameIndex(2.2), 0, 'second loop')
})

test('paintPetTile: work mood bursts into a jump, then settles into a run', () => {
  const { context } = load(async () => {
    throw new Error('unused')
  })
  // First paint: mood flips to work → jump burst (row 4). The exact column
  // depends on the per-pet phase offset — the ROW is the contract. Rows
  // step by the tile height (34px here): row 4 → -136px, row 1 → -34px.
  const el = tile('work')
  context.__api.paintPetTile(el, 0)
  assert.equal(el.style.backgroundPosition.split(' ')[1], '-136px', 'burst shows the jumping row')
  // Still inside the 2.2s burst window.
  context.__api.paintPetTile(el, 1.5)
  assert.equal(el.style.backgroundPosition.split(' ')[1], '-136px', 'still jumping at 1.5s')
  // Burst expired → running-right row.
  context.__api.paintPetTile(el, 3)
  assert.equal(el.style.backgroundPosition.split(' ')[1], '-34px', 'settles into running')
})

test('paintPetTile: idle pets never leave the idle row', () => {
  const { context } = load(async () => {
    throw new Error('unused')
  })
  const el = tile('idle')
  context.__api.paintPetTile(el, 0)
  assert.equal(el.style.backgroundPosition.split(' ')[1], '0px', 'idle row 0')
  context.__api.paintPetTile(el, 5)
  assert.equal(el.style.backgroundPosition.split(' ')[1], '0px', 'idle stays at row 0')
})

test('petSheetObjectUrl: one fetch per sheet, cached object URL', async () => {
  let n = 0
  const { context, fetches } = load(async () => {
    n += 1
    return { blob: async () => new Blob() }
  })
  const a = await context.__api.petSheetObjectUrl('https://pets.example/sheet.webp')
  const b = await context.__api.petSheetObjectUrl('https://pets.example/sheet.webp')
  assert.equal(a, 'blob:test-object-url')
  assert.equal(b, a, 'same object URL from cache')
  assert.equal(n, 1, 'only one network fetch')
  assert.equal(fetches.length, 1)
  assert.ok(fetches[0].opts.signal, 'fetch is abortable')
})

test('petSheetObjectUrl: failed fetch is not cached and retries', async () => {
  let n = 0
  const { context } = load(async () => {
    n += 1
    throw new Error('network')
  })
  const a = await context.__api.petSheetObjectUrl('https://pets.example/bad.webp')
  const b = await context.__api.petSheetObjectUrl('https://pets.example/bad.webp')
  assert.equal(a, null)
  assert.equal(b, null)
  assert.equal(n, 2, 'cache entry dropped so the next render retries')
})
