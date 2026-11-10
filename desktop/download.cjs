'use strict'

const http = require('node:http')
const { createWriteStream } = require('node:fs')
const { pipeline } = require('node:stream/promises')

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`Export failed (${response.statusCode})`))
        return
      }
      pipeline(response, createWriteStream(destination, { flags: 'wx' })).then(resolve, reject)
    })
    request.on('error', reject)
  })
}

module.exports = { download }
