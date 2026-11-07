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
    backend: path.join(resources, 'backend', 'luma-fattal-backend',
      process.platform === 'win32' ? 'luma-fattal-backend.exe' : 'luma-fattal-backend'),
    tools: path.join(resources, 'backend', 'luma-fattal-backend', '_internal', 'tools'),
    packaged,
    sessions: path.join(userData, 'sessions'),
    logs: path.join(userData, 'logs'),
    cache: path.join(userData, 'cache'),
  }
}

module.exports = { runtimePaths }
