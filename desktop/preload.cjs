'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const layoutArgument = process.argv.find(value => value.startsWith('--luma-fattal-layout='))
const referenceSize = JSON.parse(layoutArgument.slice('--luma-fattal-layout='.length))

contextBridge.exposeInMainWorld('desktopFiles', {
  open: kind => ipcRenderer.invoke('desktop:open', kind),
  save: (kind, path, content) => ipcRenderer.invoke('desktop:save', kind, path, content),
})

contextBridge.exposeInMainWorld('desktopWindow', {
  referenceSize,
  minimize: () => ipcRenderer.invoke('desktop:window', 'minimize'),
  close: () => ipcRenderer.invoke('desktop:window', 'close'),
})
