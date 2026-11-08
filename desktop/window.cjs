'use strict'

const path = require('node:path')
const { existsSync } = require('node:fs')
const { app, BrowserWindow, ipcMain, nativeImage, screen, session } = require('electron')
const { referenceSize, workbenchURL, windowSize, isWorkbenchNavigation } = require('./config.cjs')
const { installDisplayScaling } = require('./layout.cjs')
const { installFileDialogs } = require('./files.cjs')

function createWorkbenchWindow(value, iconPath) {
  const url = workbenchURL(value)
  if (!existsSync(iconPath)) throw new Error(`Window icon is missing: ${iconPath}`)
  const icon = nativeImage.createFromPath(iconPath)
  if (app.dock) app.dock.setIcon(icon)
  const isolatedSession = session.fromPartition('luma-fattal-workbench')
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)

  const window = new BrowserWindow({
    ...windowSize(screen.getPrimaryDisplay()),
    useContentSize: true,
    title: 'Luma Fattal',
    icon,
    backgroundColor: '#030000',
    frame: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
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
      additionalArguments: [`--luma-fattal-layout=${JSON.stringify(referenceSize)}`],
    },
  })
  window.setMenu(null)
  installDisplayScaling(window, screen)
  const handleControl = (event, action) => {
    if (event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.sender.getURL() !== url) throw new Error('Invalid window control request')
    if (action === 'minimize') window.minimize()
    else if (action === 'close') window.close()
    else throw new Error('Invalid window control')
  }
  ipcMain.handle('desktop:window', handleControl)
  window.on('closed', () => ipcMain.removeHandler('desktop:window'))
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) event.preventDefault()
    if ((input.control || input.meta) && ['+', '=', '-', '0'].includes(input.key)) event.preventDefault()
  })
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
