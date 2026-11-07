'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, createWriteStream } = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const { workbenchURL } = require('./config.cjs')

class Backend {
  constructor(paths, onUnexpectedExit) {
    if (!existsSync(paths.presets)) throw new Error(`Preset resources are missing: ${paths.presets}`)
    for (const directory of [paths.sessions, paths.logs, paths.cache]) mkdirSync(directory, { recursive: true })
    const localPython = path.join(paths.sourceRoot, '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const python = paths.packaged ? paths.backend : process.env.LUMA_FATAL_PYTHON ||
      (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3')
    if (paths.packaged && !existsSync(python)) throw new Error(`Packaged backend is missing: ${python}`)
    const backendArgs = paths.packaged ? [] : ['-u', '-m', 'luma_fatal.ui']
    const toolPath = paths.packaged ? `${paths.tools}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH
    this.stopping = false
    this.diagnostics = ''
    this.log = createWriteStream(path.join(paths.logs, 'backend.log'), { flags: 'a', mode: 0o600 })
    this.child = spawn(python, [...backendArgs, '--no-browser',
      '--presets', paths.presets, '--output-dir', paths.sessions], {
      cwd: paths.sessions,
      env: { ...process.env, PATH: toolPath, NUMBA_CACHE_DIR: paths.cache },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.closed = new Promise(resolve => this.child.once('close', resolve))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', text => {
      this.diagnostics = (this.diagnostics + text).slice(-8192)
      this.log.write(text)
    })
    this.child.once('close', () => this.log.end())

    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject
      const timeout = setTimeout(() => reject(new Error('The Python backend did not become ready within 30 seconds.')), 30000)
      const lines = readline.createInterface({ input: this.child.stdout })
      const finish = () => {
        clearTimeout(timeout)
        lines.close()
      }
      this.child.once('error', error => {
        finish()
        reject(new Error(`Could not start Python: ${error.message}\nRun uv sync --locked first, or set LUMA_FATAL_PYTHON to your Python executable.`))
      })
      this.child.once('exit', () => {
        finish()
        const error = new Error(this.diagnostics.trim() || 'The Python backend exited unexpectedly.')
        reject(error)
        if (this.started && !this.stopping) onUnexpectedExit(error)
      })
      lines.on('line', async line => {
        if (!line.startsWith('Luma Fattal: ')) return
        finish()
        try {
          const url = workbenchURL(line.slice('Luma Fattal: '.length).trim())
          const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' })
          await response.body?.cancel()
          if (!response.ok) throw new Error('The Python backend did not accept its session URL.')
          if (this.stopping || this.child.exitCode !== null) return
          this.started = true
          resolve(url)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  stop() {
    if (!this.stopPromise) this.stopPromise = this.stopTree()
    return this.stopPromise
  }

  async stopTree() {
    this.stopping = true
    this.rejectReady(new Error('The application is shutting down.'))
    if (!this.child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      await new Promise((resolve, reject) => {
        killer.once('error', reject)
        killer.once('exit', code => {
          if (code === 0 || this.child.exitCode !== null) resolve()
          else reject(new Error('Could not stop the Python backend process tree.'))
        })
      })
    } else {
      const signalTree = signal => {
        try {
          process.kill(-this.child.pid, signal)
          return true
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
          return false
        }
      }
      signalTree('SIGTERM')
      for (let attempt = 0; attempt < 30 && signalTree(0); attempt++) await delay(100)
      if (signalTree(0)) signalTree('SIGKILL')
    }
    await this.closed
  }
}

module.exports = { Backend }
