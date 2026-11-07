'use strict'

const { createReadStream, createWriteStream, promises: fs } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { dialog, ipcMain } = require('electron')

function installFileDialogs(window, entry) {
  const base = new URL(entry)
  const validSender = event => event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.sender.getURL() === entry
  const guard = (event, action) => {
    if (!validSender(event)) throw new Error('Invalid desktop file request')
    return action()
  }
  const endpoint = pathname => {
    const url = new URL(pathname, base)
    url.search = base.search
    return url
  }
  const postFile = async (pathname, filename) => {
    const { size } = await fs.stat(filename)
    if (!size || size > 20 * 1024 ** 3) throw new Error('The video is empty or too large')
    return new Promise((resolve, reject) => {
      const request = http.request(endpoint(pathname), {
        method: 'POST', headers: { 'Content-Length': size },
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString())
            if (response.statusCode !== 200) reject(new Error(body.error || `Upload failed (${response.statusCode})`))
            else resolve(body)
          } catch (error) { reject(error) }
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      createReadStream(filename).on('error', error => request.destroy(error)).pipe(request)
    })
  }
  const open = async kind => {
    const video = kind === 'video'
    if (!video && kind !== 'preset') throw new Error('Invalid file type')
    const choice = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: video
        ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }]
        : [{ name: 'Recipes', extensions: ['yaml', 'yml', 'json'] }],
    })
    if (choice.canceled) return null
    const filename = choice.filePaths[0]
    if (video) return { name: path.basename(filename), upload: await postFile('/api/upload', filename) }
    const data = await fs.readFile(filename)
    if (!data.length || data.length > 1024 ** 2) throw new Error('Recipe is empty or too large')
    const response = await fetch(endpoint('/api/import'), { method: 'POST', body: data })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `Import failed (${response.status})`)
    return { name: path.basename(filename), config: result }
  }
  const save = async (kind, mediaPath, content) => {
    const names = { video: 'luma-fatal.mp4', metadata: 'luma-fatal.meta.json', config: 'luma-fatal-config.json' }
    if (!Object.hasOwn(names, kind)) throw new Error('Invalid export type')
    if (kind === 'config') {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 ** 2) throw new Error('Invalid config')
    } else if (typeof mediaPath !== 'string' || !/^\/media\/[a-f0-9]{32}\/[a-zA-Z0-9._-]+$/.test(mediaPath)) {
      throw new Error('Invalid export path')
    }
    const choice = await dialog.showSaveDialog(window, {
      defaultPath: names[kind],
      filters: [{ name: kind === 'video' ? 'MP4 video' : 'JSON', extensions: [kind === 'video' ? 'mp4' : 'json'] }],
    })
    if (choice.canceled) return false
    const target = choice.filePath
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      if (kind === 'config') await fs.writeFile(temporary, content, { flag: 'wx' })
      else {
        const response = await fetch(endpoint(mediaPath))
        if (!response.ok || !response.body) throw new Error(`Export failed (${response.status})`)
        await pipeline(response.body, createWriteStream(temporary, { flags: 'wx' }))
      }
      await fs.rename(temporary, target)
      return true
    } finally { await fs.rm(temporary, { force: true }) }
  }
  ipcMain.handle('desktop:open', (event, kind) => guard(event, () => open(kind)))
  ipcMain.handle('desktop:save', (event, kind, mediaPath, content) => guard(event, () => save(kind, mediaPath, content)))
  window.on('closed', () => {
    ipcMain.removeHandler('desktop:open')
    ipcMain.removeHandler('desktop:save')
  })
}

module.exports = { installFileDialogs }
