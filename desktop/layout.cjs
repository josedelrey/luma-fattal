'use strict'

function installDisplayScaling(window, screen, initialSize) {
  const contents = window.webContents
  const [initialWidth, initialHeight] = initialSize
    ? [initialSize.width, initialSize.height] : window.getContentSize()
  const ratio = initialWidth / (initialHeight - 44)
  let lastSize = [initialWidth, initialHeight]
  let correcting = false
  let displayKey
  let fitting = false
  const scaleContents = () => {
    contents.setZoomFactor(1)
  }
  const resize = () => {
    scaleContents()
    if (correcting || fitting) return
    const [width, height] = window.getContentSize()
    const widthChange = Math.abs(width - lastSize[0]) / lastSize[0]
    const heightChange = Math.abs(height - lastSize[1]) / lastSize[1]
    let nextWidth = width
    let nextHeight = height
    if (widthChange >= heightChange) nextHeight = Math.round(44 + width / ratio)
    else nextWidth = Math.round((height - 44) * ratio)
    nextWidth = Math.max(1, nextWidth)
    nextHeight = Math.max(35, nextHeight)
    lastSize = [nextWidth, nextHeight]
    if (width !== nextWidth || height !== nextHeight) {
      correcting = true
      try { window.setContentSize(nextWidth, nextHeight) } finally { correcting = false }
    }
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
      const [width, height] = window.getContentSize()
      const fitWidth = Math.min(width, area.width, Math.max(1, (area.height - 44) * ratio))
      if (fitWidth < width || height > area.height) {
        const nextWidth = Math.floor(fitWidth)
        const nextHeight = Math.min(area.height, Math.round(44 + nextWidth / ratio))
        lastSize = [nextWidth, nextHeight]
        window.setContentSize(nextWidth, nextHeight)
      }
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
  window.on('resize', resize)
  window.on('move', fitDisplay)
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, fitDisplay)
  }
  window.once('closed', () => {
    contents.removeListener('zoom-changed', scaleContents)
    contents.removeListener('did-finish-load', scaleContents)
    window.removeListener('resize', resize)
    window.removeListener('move', fitDisplay)
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.removeListener(event, fitDisplay)
    }
  })
  fitDisplay()
}

module.exports = { installDisplayScaling }
