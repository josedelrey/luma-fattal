'use strict'

const path = require('node:path')
const { existsSync } = require('node:fs')
const { app, BrowserWindow, nativeImage, screen, session } = require('electron')
const { workbenchURL, windowSize, isWorkbenchNavigation } = require('./config.cjs')
const { installFileDialogs } = require('./files.cjs')

function createWorkbenchWindow(value, iconPath) {
  const url = workbenchURL(value)
  if (!existsSync(iconPath)) throw new Error(`Window icon is missing: ${iconPath}`)
  const icon = nativeImage.createFromPath(iconPath)
  if (app.dock) app.dock.setIcon(icon)
  const isolatedSession = session.fromPartition('luma-fatal-workbench')
  isolatedSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen')
  })
  isolatedSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen')

  const window = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay().workAreaSize),
    title: 'Luma Fatal',
    icon,
    backgroundColor: '#030000',
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    center: true,
    show: false,
    webPreferences: {
      session: isolatedSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  window.setMenu(null)
  installFileDialogs(window, url)
  window.once('ready-to-show', () => window.show())
  window.on('page-title-updated', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    window.webContents.on(eventName, event => {
      if (!isWorkbenchNavigation(event.url, url)) event.preventDefault()
    })
  }
  return { window, loaded: window.loadURL(url) }
}

module.exports = { createWorkbenchWindow }
