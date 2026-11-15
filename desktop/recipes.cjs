'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const maxRecipeBytes = 1024 ** 2
const recipeExtensions = ['yaml', 'yml', 'toml', 'json']

async function readRecipe(filename, limit) {
  const info = await fs.stat(filename)
  if (!info.isFile()) throw new Error('Select a regular recipe file')
  if (!info.size || info.size > limit) throw new Error('Recipe is empty or too large')

  const file = await fs.open(filename, 'r')
  try {
    // Bound the read even if the file grows after the size check.
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (!length || length > info.size) throw new Error('Recipe size changed while reading')
    return buffer.toString('utf8', 0, length)
  } finally {
    await file.close()
  }
}

async function localParent(source, directory, realDirectory) {
  const candidate = path.resolve(directory, source)
  const relative = path.relative(directory, candidate)
  // Avoid resolving paths that already point outside the selected directory.
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null

  try {
    const resolved = await fs.realpath(candidate)
    // Compare canonical spelling, including on case-sensitive Windows directories.
    return resolved.startsWith(path.join(realDirectory, path.sep)) ? resolved : null
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

async function importRecipe(filename, url, selectParent) {
  const directory = path.dirname(filename)
  const realDirectory = await fs.realpath(directory)
  const root = path.basename(filename)
  const files = Object.create(null)
  const serialize = () => JSON.stringify({ filename: root, files })
  let source = root
  while (true) {
    if (!recipeExtensions.includes(path.extname(source).slice(1).toLowerCase())) {
      throw new Error('Recipes must use YAML, TOML or JSON')
    }
    const selected = source === root ? filename
      : (await localParent(source, directory, realDirectory)) ?? await selectParent(source)
    if (!selected) return null

    files[source] = ''
    files[source] = await readRecipe(selected, maxRecipeBytes - Buffer.byteLength(serialize()))
    const content = serialize()
    if (Buffer.byteLength(content) > maxRecipeBytes) throw new Error('Recipes are too large to import')

    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: content,
    })
    const result = await response.json()
    if (response.ok) return { name: root, config: result }
    source = result.missing_source
    if (typeof source !== 'string' || !source || Object.hasOwn(files, source)) {
      throw new Error(result.error || `Import failed (${response.status})`)
    }
  }
}

module.exports = { importRecipe, recipeExtensions }
