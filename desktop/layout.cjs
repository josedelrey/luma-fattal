'use strict'

const { windowSize } = require('./config.cjs')

function installDisplayScaling(window, screen) {
  const contents = window.webContents
  let displayKey
  let fitting = false
  const scaleContents = () => {
    contents.setZoomFactor(1)
  }
  const fitDisplay = () => {
    if (fitting) return
    const display = screen.getDisplayMatching(window.getBounds())
    const area = display.workArea
    const key = [display.id, display.bounds.width, display.bounds.height, area.x, area.y,
      area.width, area.height, display.scaleFactor].join(':')
    if (key === displayKey) return
    displayKey = key
    fitting = true
    try {
      const size = windowSize(display)
      window.setContentSize(size.width, size.height)
      const bounds = window.getBounds()
      const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))
      const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))
      if (x !== bounds.x || y !== bounds.y) window.setPosition(x, y)
      scaleContents()
    } finally {
      fitting = false
    }
  }

  // The renderer scales the canvas after layout. OS display scaling stays native.
  contents.setZoomMode('isolated')
  contents.on('zoom-changed', scaleContents)
  contents.on('did-finish-load', scaleContents)
  window.on('resize', scaleContents)
  window.on('move', fitDisplay)
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, fitDisplay)
  }
  window.once('closed', () => {
    contents.removeListener('zoom-changed', scaleContents)
    contents.removeListener('did-finish-load', scaleContents)
    window.removeListener('resize', scaleContents)
    window.removeListener('move', fitDisplay)
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.removeListener(event, fitDisplay)
    }
  })
  fitDisplay()
}

module.exports = { installDisplayScaling }
