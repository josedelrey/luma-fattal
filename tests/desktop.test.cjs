'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { workbenchURL, windowSize, isWorkbenchNavigation } = require('../desktop/config.cjs')
const { runtimePaths } = require('../desktop/paths.cjs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { runInThisContext } = require('node:vm')
const { installDisplayScaling } = require('../desktop/layout.cjs')
const { download } = require('../desktop/download.cjs')
const { importRecipe } = require('../desktop/recipes.cjs')
const http = require('node:http')
const { Readable } = require('node:stream')
const fs = require('node:fs/promises')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const os = require('node:os')

const entry = 'http://127.0.0.1:8765/?token=session-secret'

test('streams desktop exports and reports interrupted responses', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luma-download-'))
  const original = http.get
  const payload = Buffer.alloc(1024 * 1024, 73)
  let response
  http.get = (url, callback) => {
    const request = new EventEmitter()
    process.nextTick(() => callback(response))
    return request
  }
  try {
    response = Readable.from([payload.subarray(0, 200000), payload.subarray(200000)])
    response.statusCode = 200
    const destination = path.join(directory, 'result')
    await download('http://127.0.0.1/test', destination)
    assert.deepEqual(await readFile(destination), payload)

    response = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('connection interrupted'))
      },
    })
    response.statusCode = 200
    await assert.rejects(download('http://127.0.0.1/test', path.join(directory, 'partial')), /connection interrupted/)

    response = Readable.from(['missing'])
    response.statusCode = 404
    await assert.rejects(download('http://127.0.0.1/test', path.join(directory, 'missing')), /Export failed \(404\)/)
  } finally {
    http.get = original
    await rm(directory, { recursive: true, force: true })
  }
})

test('offers photos in the desktop picker and saves each result with its actual format', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luma-media-'))
  const handlers = new Map()
  const filename = require.resolve('../desktop/files.cjs')
  const localRequire = createRequire(filename)
  const module = { exports: {} }
  const window = new EventEmitter()
  window.webContents = { mainFrame: {}, getURL: () => entry }
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const saved = []
  let opened
  let destination
  const electron = {
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
    },
    dialog: {
      async showOpenDialog(_window, options) { opened = options; return { canceled: true } },
      async showSaveDialog(_window, options) {
        saved.push(options)
        destination = path.join(directory, options.defaultPath)
        return { filePath: destination }
      },
    },
  }
  const load = runInThisContext(`(function(require, module) {${await readFile(filename, 'utf8')}\n})`)
  load(name => name === 'electron' ? electron : localRequire(name), module)
  module.exports.installFileDialogs(window, entry)
  t.after(async () => {
    for (const options of saved) await fs.rm(path.join(directory, options.defaultPath), { force: true })
    await fs.rmdir(directory)
  })
  const payload = 'rendered media'
  t.mock.method(http, 'get', (url, callback) => {
    assert.equal(url.searchParams.get('token'), 'session-secret')
    const response = Readable.from([Buffer.from(payload)])
    response.statusCode = 200
    process.nextTick(() => callback(response))
    return new EventEmitter()
  })
  await handlers.get('desktop:open')(event, 'media')
  assert.ok(['mp4', 'jpg', 'jpeg', 'png'].every(ext => opened.filters[0].extensions.includes(ext)))
  for (const ext of ['jpg', 'png', 'mp4']) {
    const url = `/media/${'a'.repeat(32)}/processed.${ext}`
    assert.equal(await handlers.get('desktop:save')(event, 'media', url), true)
    assert.equal(saved.at(-1).defaultPath, `luma-fattal.${ext}`)
    assert.deepEqual(saved.at(-1).filters[0].extensions, [ext])
    assert.equal(await readFile(destination, 'utf8'), payload)
  }
  await assert.rejects(handlers.get('desktop:save')(event, 'media', `/media/${'a'.repeat(32)}/processed.html`), /Invalid media export path/)
})

async function recipeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'luma-recipes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const recipes = path.join(directory, 'recipes')
  const neighbor = path.join(directory, 'recipes-neighbor')
  await Promise.all([fs.mkdir(recipes), fs.mkdir(neighbor)])
  const root = path.join(recipes, 'root.yaml')
  await fs.writeFile(root, 'filter: fattal1\n')
  return { root, recipes, neighbor }
}

test('automatically supplies parents from the selected recipe folder and subfolders', async t => {
  const { root, recipes } = await recipeFixture(t)
  const first = path.join('parents', 'base.toml')
  const second = path.join('parents', 'defaults.json')
  await fs.mkdir(path.join(recipes, 'parents'))
  await fs.writeFile(root, 'extends: parents/base.toml\nfilter: fattal1\n')
  await fs.writeFile(path.join(recipes, first), 'extends = "defaults.json"')
  await fs.writeFile(path.join(recipes, second), '{"filter": "fattal2"}')
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { filename, files } = JSON.parse(options.body)
    assert.equal(filename, 'root.yaml')
    if (!Object.hasOwn(files, first)) return Response.json({ missing_source: first }, { status: 400 })
    assert.equal(files[first], 'extends = "defaults.json"')
    if (!Object.hasOwn(files, second)) return Response.json({ missing_source: second }, { status: 400 })
    assert.equal(files[second], '{"filter": "fattal2"}')
    return Response.json({ filter: 'fattal1' })
  })
  assert.deepEqual(await importRecipe(root, entry, () => assert.fail('Unexpected picker')), {
    name: 'root.yaml', config: { filter: 'fattal1' },
  })
})

test('asks before even resolving external paths and keeps external selections explicit', async t => {
  const { root, recipes, neighbor } = await recipeFixture(t)
  const parent = path.join(neighbor, 'base.yaml')
  const first = path.relative(recipes, parent)
  const second = path.join(neighbor, 'defaults.yaml')
  const originalResolve = fs.realpath
  const resolved = t.mock.method(fs, 'realpath', originalResolve)
  const parentContent = `extends: ${JSON.stringify(second)}\n`
  await fs.writeFile(root, `extends: ${JSON.stringify(first)}\nfilter: fattal1\n`)
  await fs.writeFile(parent, parentContent)
  await fs.writeFile(second, 'filter: fattal2\n')
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { files } = JSON.parse(options.body)
    if (!Object.hasOwn(files, first)) return Response.json({ missing_source: first }, { status: 400 })
    assert.equal(files[first], parentContent)
    if (!Object.hasOwn(files, second)) return Response.json({ missing_source: second }, { status: 400 })
    assert.equal(files[second], 'filter: fattal2\n')
    return Response.json({ filter: 'fattal1' })
  })
  const selected = []
  const result = await importRecipe(root, entry, async source => {
    selected.push(source)
    return path.resolve(recipes, source)
  })
  assert.equal(result.config.filter, 'fattal1')
  assert.deepEqual(selected, [first, second])
  assert.deepEqual(resolved.mock.calls.map(call => call.arguments[0]), [recipes])
})

test('prompts for a parent reached through a link that escapes the recipe folder', async t => {
  const { root, recipes, neighbor } = await recipeFixture(t)
  const link = path.join(recipes, 'linked')
  const source = path.join('linked', 'base.yaml')
  await fs.writeFile(root, 'extends: linked/base.yaml\n')
  await fs.writeFile(path.join(neighbor, 'base.yaml'), 'filter: fattal2\n')
  try {
    await fs.symlink(neighbor, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Creating directory links requires permission')
    throw error
  }
  const opened = t.mock.method(fs, 'open', fs.open)
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ missing_source: source }, { status: 400 }))
  const selected = []
  assert.equal(await importRecipe(root, entry, async name => {
    selected.push(name)
    return null
  }), null)
  assert.deepEqual(selected, [source])
  assert.deepEqual(opened.mock.calls.map(call => call.arguments[0]), [root])
  assert.equal(request.mock.callCount(), 1)
})

test('rejects oversized roots and inherited files before opening them', async t => {
  const { root, recipes } = await recipeFixture(t)
  const source = 'base.yaml'
  const base = path.join(recipes, source)
  await fs.writeFile(root, Buffer.alloc(1024 ** 2 + 1))
  const opened = t.mock.method(fs, 'open', fs.open)
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ missing_source: source }, { status: 400 }))
  const selectParent = () => assert.fail('Unexpected picker')
  await assert.rejects(importRecipe(root, entry, selectParent), /too large/)
  assert.equal(opened.mock.callCount(), 0)
  assert.equal(request.mock.callCount(), 0)

  await fs.writeFile(root, ' '.repeat(128))
  await fs.writeFile(base, Buffer.alloc(1024 ** 2 - 128))
  await assert.rejects(importRecipe(root, entry, selectParent), /too large/)
  assert.deepEqual(opened.mock.calls.map(call => call.arguments[0]), [root])
  assert.equal(request.mock.callCount(), 1)
})

test('accepts the authenticated loopback URL printed by the UI server', () => {
  assert.equal(workbenchURL(entry), entry)
})

test('rejects external pages, missing tokens, credentials and alternate entry paths', () => {
  for (const value of [
    undefined, '', 'file:///tmp/index.html',
    'https://127.0.0.1:8765/?token=session-secret',
    'http://example.com/?token=session-secret',
    'http://127.0.0.1.example.com/?token=session-secret',
    'http://user:password@127.0.0.1:8765/?token=session-secret',
    'http://127.0.0.1:8765/', 'http://127.0.0.1:8765/?token=',
    `${entry}&token=second`, `${entry}&other=value`, `${entry}#fragment`,
    'http://127.0.0.1:8765/api/presets?token=session-secret',
  ]) {
    assert.throws(() => workbenchURL(value), error => {
      assert.ok(!error.message.includes('session-secret'))
      return true
    })
  }
})

test('keeps page navigation inside the authenticated workbench', () => {
  assert.equal(isWorkbenchNavigation(entry, entry), true)
  assert.equal(isWorkbenchNavigation(`${entry}#preview`, entry), true)
  for (const target of [
    'https://example.com', 'file:///tmp/index.html', 'javascript:alert(1)',
    'http://127.0.0.1:8766/?token=session-secret',
    'http://127.0.0.1:8765/?token=other',
    'http://127.0.0.1:8765/api/presets?token=session-secret',
  ]) assert.equal(isWorkbenchNavigation(target, entry), false)
})

test('matches the display long side without changing the window aspect ratio', () => {
  for (const area of [
    { width: 1920, height: 1080 },
    { width: 1024, height: 768 },
    { width: 640, height: 480 },
    { width: 1365, height: 741 },
    { width: 1080, height: 1920 },
    { width: 3440, height: 1440 },
    { width: 2560, height: 1440 },
    { width: 2560, height: 1600 },
  ]) {
    const size = windowSize({ bounds: area, workArea: area })
    assert.ok(size.width <= area.width && size.height <= area.height)
    assert.equal(size.minWidth, undefined)
    assert.equal(size.minHeight, undefined)
    assert.ok(size.width > 0 && size.height > 0)
    assert.ok(Math.abs(size.width - size.height * 4 / 3) < 2)
    const longSide = Math.max(area.width, area.height)
    const expectedWidth = longSide * 0.5390625
    if (area.width >= expectedWidth && area.height >= expectedWidth * 3 / 4) {
      assert.ok(Math.abs(size.width / longSide - 0.5390625) <= 1 / longSide)
    } else {
      assert.ok(area.width - size.width < 2 || area.height - size.height < 2)
    }
  }
})

test('enlarges the laptop window by fifteen percent and scales with larger displays', () => {
  assert.deepEqual(windowSize({
    bounds: { width: 2560, height: 1600 }, workArea: { width: 2560, height: 1530 },
  }), { width: 1380, height: 1035 })
  assert.deepEqual(windowSize({
    bounds: { width: 3840, height: 2160 }, workArea: { width: 3840, height: 2080 },
  }), { width: 2070, height: 1552 })
})

test('preserves physical long-side coverage across OS scale factors', () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const display = {
      bounds: { width: 3840 / scaleFactor, height: 2160 / scaleFactor },
      workArea: { width: 3840 / scaleFactor, height: 2080 / scaleFactor },
      scaleFactor,
    }
    const size = windowSize(display)
    assert.ok(Math.abs(size.width * scaleFactor - 2070) <= scaleFactor + 1e-9)
    assert.ok(Math.abs(size.height * scaleFactor - 1552.5) < scaleFactor)
  }
})

test('keeps the window size when rotating a display or changing its taskbar', () => {
  const bounds = { width: 1920, height: 1080 }
  const ordinary = windowSize({ bounds, workArea: { width: 1920, height: 1040 } })
  const largerTaskbar = windowSize({ bounds, workArea: { width: 1920, height: 980 } })
  const portrait = windowSize({
    bounds: { width: 1080, height: 1920 }, workArea: { width: 1080, height: 1880 },
  })
  assert.deepEqual(ordinary, largerTaskbar)
  assert.deepEqual(ordinary, portrait)
  const restricted = windowSize({ bounds, workArea: { width: 1920, height: 450 } })
  assert.deepEqual(restricted, { width: 600, height: 450 })
  const ultrawide = windowSize({
    bounds: { width: 3440, height: 1440 }, workArea: { width: 3440, height: 1400 },
  })
  assert.deepEqual(ultrawide, { width: 1854, height: 1390 })
  const narrow = windowSize({
    bounds: { width: 1080, height: 3840 }, workArea: { width: 1080, height: 3800 },
  })
  assert.deepEqual(narrow, { width: 1080, height: 810 })
})

test('preserves user size on display changes and fits smaller work areas', () => {
  const screen = new EventEmitter()
  let display = { id: 1, bounds: { width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  screen.getDisplayMatching = () => display
  const window = new EventEmitter()
  let bounds = { x: 400, y: 100, width: 1200, height: 900 }
  let zoom, zoomMode
  window.webContents = new EventEmitter()
  window.webContents.setZoomFactor = value => { zoom = value }
  window.webContents.setZoomMode = value => { zoomMode = value }
  window.setAspectRatio = () => {}
  window.getBounds = () => ({ ...bounds })
  window.getContentSize = () => [bounds.width, bounds.height]
  window.setContentSize = (width, height) => {
    bounds = { ...bounds, width, height }
    window.emit('resize')
  }
  window.setPosition = (x, y) => {
    bounds = { ...bounds, x, y }
    window.emit('move')
  }
  installDisplayScaling(window, screen)
  assert.equal(zoom, 1)
  assert.equal(zoomMode, 'isolated')
  assert.deepEqual(window.getContentSize(), [1200, 900])

  display = { id: 2, bounds: { width: 1024, height: 768 },
    workArea: { x: -1024, y: -768, width: 1024, height: 768 }, scaleFactor: 2 }
  window.emit('move')
  assert.deepEqual(window.getContentSize(), [1024, 768])
  assert.equal(zoom, 1)
  assert.deepEqual(bounds, { x: -1024, y: -768, width: 1024, height: 768 })

  display.bounds.width = 1280
  screen.emit('display-metrics-changed', {}, display, ['bounds'])
  assert.deepEqual(window.getContentSize(), [1024, 768])

  display.workArea.height = 300
  screen.emit('display-metrics-changed', {}, display, ['workArea', 'scaleFactor'])
  assert.deepEqual(window.getContentSize(), [400, 300])
  assert.equal(zoom, 1)
  zoom = 1.5
  window.webContents.emit('zoom-changed', {}, 'in')
  assert.equal(zoom, 1)
  zoom = 1.5
  window.webContents.emit('did-finish-load')
  assert.equal(zoom, 1)

  window.setContentSize(720, 558)
  assert.equal(zoom, 1)
  display = { id: 1, bounds: { width: 2560, height: 1600 },
    workArea: { x: 0, y: 0, width: 2560, height: 1530 }, scaleFactor: 1 }
  screen.emit('display-removed')
  assert.deepEqual(window.getContentSize(), [720, 558])
  assert.equal(zoom, 1)

  window.emit('closed')
  assert.equal(screen.listenerCount('display-metrics-changed'), 0)
  assert.equal(screen.listenerCount('display-removed'), 0)
  assert.equal(screen.listenerCount('display-added'), 0)
  assert.equal(window.listenerCount('move'), 0)
})

test('delegates interactive aspect ratio enforcement to the native window', () => {
  const screen = new EventEmitter()
  screen.getDisplayMatching = () => ({ id: 1, bounds: { width: 3000, height: 2000 },
    workArea: { x: 0, y: 0, width: 3000, height: 2000 }, scaleFactor: 1 })
  const window = new EventEmitter()
  window.webContents = new EventEmitter()
  window.webContents.setZoomFactor = () => {}
  window.webContents.setZoomMode = () => {}
  window.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 900 })
  window.getContentSize = () => [1200, 900]
  let constraint
  window.setAspectRatio = (ratio, extraSize) => { constraint = { ratio, extraSize } }
  window.setContentSize = () => { throw new Error('Unexpected resize correction') }
  window.setPosition = () => {}
  installDisplayScaling(window, screen)
  assert.deepEqual(constraint, { ratio: 1200 / 900, extraSize: undefined })
  window.emit('resize')
  window.emit('closed')
})

test('resolves desktop resources separately from writable application data', () => {
  const checkout = path.resolve('checkout')
  const resources = path.resolve('bundle', 'resources')
  const userData = path.resolve('user-data')
  const source = runtimePaths(path.join(checkout, 'desktop'), resources, userData, false)
  const bundle = runtimePaths(path.resolve('bundle', 'app.asar'), resources, userData, true)
  assert.equal(source.presets, path.join(checkout, 'configs'))
  assert.equal(source.icon, path.join(checkout, 'desktop', 'icons', 'app-icon.png'))
  assert.equal(bundle.presets, path.join(resources, 'configs'))
  assert.equal(bundle.icon, path.join(resources, 'assets', 'app-icon.png'))
  for (const paths of [source, bundle]) {
    for (const name of ['sessions', 'logs', 'cache']) {
      assert.equal(paths[name], path.join(userData, name))
    }
  }
})
