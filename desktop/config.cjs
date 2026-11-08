'use strict'

const referenceSize = Object.freeze({ width: 1200, height: 900 })
// Display the complete reference canvas 15 percent larger on every display.
const windowLongSideRatio = 1380 / 2560

function workbenchURL(value) {
  const message = 'The local UI server returned an invalid workbench URL.'
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(message)
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/' || url.hash ||
      url.searchParams.size !== 1 || !url.searchParams.get('token')) {
    throw new Error(message)
  }
  return url.href
}

function windowSize(display) {
  const { workArea, bounds } = display
  // All dimensions are DIPs. Applying scaleFactor again would double OS scaling.
  const scale = Math.min(Math.max(bounds.width, bounds.height) * windowLongSideRatio /
    Math.max(referenceSize.width, referenceSize.height),
    workArea.width / referenceSize.width,
    workArea.height / referenceSize.height)
  return {
    width: Math.max(1, Math.floor(referenceSize.width * scale)),
    height: Math.max(1, Math.floor(referenceSize.height * scale)),
  }
}

function isWorkbenchNavigation(target, entry) {
  try {
    const url = new URL(target)
    url.hash = ''
    return url.href === entry
  } catch {
    return false
  }
}

module.exports = { referenceSize, workbenchURL, windowSize, isWorkbenchNavigation }
