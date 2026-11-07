'use strict'

const { app, dialog, Menu } = require('electron')
const { Backend } = require('./backend.cjs')
const { createWorkbenchWindow } = require('./window.cjs')

app.setName('Luma Fatal')

let backend
let quitting = false

async function openWindow() {
  backend = new Backend(error => {
    if (quitting) return
    dialog.showErrorBox('Luma Fatal backend stopped', error.message)
    app.quit()
  })
  const url = await backend.ready
  if (quitting) return
  const { loaded } = createWorkbenchWindow(url)
  await loaded
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
  } else {
    Menu.setApplicationMenu(null)
  }
  return openWindow()
}).catch(error => {
  if (quitting) return
  dialog.showErrorBox('Luma Fatal could not start', error.message)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  quitting = true
  if (!backend) return
  event.preventDefault()
  backend.stop().then(() => {
    backend = null
    app.quit()
  }).catch(error => {
    dialog.showErrorBox('Luma Fatal could not stop its backend', error.message)
    app.exit(1)
  })
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit())
