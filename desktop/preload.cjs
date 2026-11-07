'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopFiles', {
  open: kind => ipcRenderer.invoke('desktop:open', kind),
  save: (kind, path, content) => ipcRenderer.invoke('desktop:save', kind, path, content),
})
