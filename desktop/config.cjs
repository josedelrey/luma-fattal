'use strict'

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

function windowSize(workArea) {
  const width = Math.min(1200, workArea.width)
  const height = Math.min(900, workArea.height)
  return {
    width,
    height,
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

module.exports = { workbenchURL, windowSize, isWorkbenchNavigation }
