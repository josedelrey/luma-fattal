'use strict'

const path = require('node:path')

function runtimePaths(desktopDirectory, resourcesDirectory, userData, packaged) {
  const sourceRoot = path.resolve(desktopDirectory, '..')
  const resources = packaged ? resourcesDirectory : sourceRoot
  return {
    sourceRoot,
    presets: path.join(resources, 'configs'),
    icon: packaged
      ? path.join(resources, 'assets', 'logo-purple.png')
      : path.join(sourceRoot, 'src', 'luma_fatal', 'ui', 'assets', 'logo-purple.png'),
    sessions: path.join(userData, 'sessions'),
    logs: path.join(userData, 'logs'),
    cache: path.join(userData, 'cache'),
  }
}

module.exports = { runtimePaths }
