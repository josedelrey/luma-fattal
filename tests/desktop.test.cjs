'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { workbenchURL, windowSize, isWorkbenchNavigation } = require('../desktop/config.cjs')
const { runtimePaths } = require('../desktop/paths.cjs')
const path = require('node:path')

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

test('fits small displays while retaining usable resize limits', () => {
  for (const area of [
    { width: 1920, height: 1080 },
    { width: 1024, height: 768 },
    { width: 640, height: 480 },
  ]) {
    const size = windowSize(area)
    assert.ok(size.width <= area.width && size.height <= area.height)
    assert.ok(size.minWidth <= size.width && size.minHeight <= size.height)
    assert.ok(size.width > 0 && size.height > 0)
  }
})

test('resolves desktop resources separately from writable application data', () => {
  const source = runtimePaths('/checkout/desktop', '/bundle/resources', '/home/user/app-data', false)
  const bundle = runtimePaths('/bundle/app.asar', '/bundle/resources', '/home/user/app-data', true)
  assert.equal(source.presets, path.join('/checkout', 'configs'))
  assert.equal(bundle.presets, path.join('/bundle/resources', 'configs'))
  assert.equal(bundle.icon, path.join('/bundle/resources', 'assets', 'logo-purple.png'))
  for (const paths of [source, bundle]) {
    for (const name of ['sessions', 'logs', 'cache']) {
      assert.equal(paths[name], path.join('/home/user/app-data', name))
    }
  }
})
