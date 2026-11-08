'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { workbenchURL, windowSize, isWorkbenchNavigation } = require('../desktop/config.cjs')
const { runtimePaths } = require('../desktop/paths.cjs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { installDisplayScaling } = require('../desktop/layout.cjs')

const entry = 'http://127.0.0.1:8765/?token=session-secret'

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
  assert.deepEqual(window.getContentSize(), [1014, 767])
  assert.equal(zoom, 1)
  assert.deepEqual(bounds, { x: -1014, y: -767, width: 1014, height: 767 })

  display.bounds.width = 1280
  screen.emit('display-metrics-changed', {}, display, ['bounds'])
  assert.deepEqual(window.getContentSize(), [1014, 767])

  display.workArea.height = 300
  screen.emit('display-metrics-changed', {}, display, ['workArea', 'scaleFactor'])
  assert.deepEqual(window.getContentSize(), [358, 299])
  assert.equal(zoom, 1)
  zoom = 1.5
  window.webContents.emit('zoom-changed', {}, 'in')
  assert.equal(zoom, 1)
  zoom = 1.5
  window.webContents.emit('did-finish-load')
  assert.equal(zoom, 1)

  window.setContentSize(720, 554)
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

test('corrects wide and tall resizes to fill the window below the title', () => {
  const screen = new EventEmitter()
  screen.getDisplayMatching = () => ({ id: 1, bounds: { width: 3000, height: 2000 },
    workArea: { x: 0, y: 0, width: 3000, height: 2000 }, scaleFactor: 1 })
  const window = new EventEmitter()
  let bounds = { x: 0, y: 0, width: 1200, height: 900 }
  window.webContents = new EventEmitter()
  window.webContents.setZoomFactor = () => {}
  window.webContents.setZoomMode = () => {}
  window.getBounds = () => ({ ...bounds })
  window.getContentSize = () => [bounds.width, bounds.height]
  window.setContentSize = (width, height) => {
    bounds = { ...bounds, width, height }
    window.emit('resize')
  }
  window.setPosition = () => {}
  installDisplayScaling(window, screen)
  window.setContentSize(1600, 900)
  assert.deepEqual(window.getContentSize(), [1600, 1185])
  window.setContentSize(1600, 600)
  assert.deepEqual(window.getContentSize(), [779, 600])
  window.setContentSize(900, 650)
  assert.deepEqual(window.getContentSize(), [900, 686])
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
