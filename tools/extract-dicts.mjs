/**
 * Extract the Simplified Chinese (`zh`) locale dictionaries that the bundled DSH
 * client packages register through the Client locale service.
 *
 * The client half of every UI package is compiled into `lib/client.js`; each
 * package that owns UI copy registers one or more namespaces with
 * `ctx.locale.register(namespace, { zh, en, ... })`. This module parses those
 * bundles with `@babel/parser` and statically evaluates the `zh` dictionary
 * object literal (including spread, `Array#join`, and module-level constant
 * references), so the emitted JSON is the exact shipped source copy rather than
 * a regex approximation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'type', 'extra', 'errors', 'comments', 'tokens'])

function childNodes(node) {
  const out = []
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (value && typeof value === 'object') out.push(value)
  }
  return out
}

function walkAll(ast, visit) {
  const stack = [ast]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    visit(node)
    for (const child of childNodes(node)) stack.push(child)
  }
}

function collectSymbols(ast) {
  const symbols = new Map()
  walkAll(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (!symbols.has(node.id.name)) symbols.set(node.id.name, [])
      symbols.get(node.id.name).push({ start: node.start, init: node.init })
    }
  })
  return symbols
}

function resolveIdentifier(node, symbols, pos) {
  const candidates = (symbols.get(node.name) ?? []).filter((c) => c.start < pos)
  if (candidates.length === 0) throw new Error('unresolved-identifier:' + node.name)
  const decl = candidates[candidates.length - 1]
  return { init: decl.init, pos: decl.start }
}

function evalNode(node, symbols, pos, depth = 0) {
  if (!node || depth > 20) throw new Error('unresolvable')
  switch (node.type) {
    case 'StringLiteral':
      return node.value
    case 'NumericLiteral':
      return node.value
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'TemplateLiteral':
      if (node.expressions.length !== 0) throw new Error('template-expression')
      return node.quasis.map((q) => q.value.cooked).join('')
    case 'BinaryExpression':
      if (node.operator !== '+') throw new Error('binary-' + node.operator)
      return String(evalNode(node.left, symbols, pos, depth + 1)) + String(evalNode(node.right, symbols, pos, depth + 1))
    case 'Identifier': {
      const resolved = resolveIdentifier(node, symbols, pos)
      return evalNode(resolved.init, symbols, resolved.pos, depth + 1)
    }
    case 'ObjectExpression': {
      const out = {}
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          const spread = evalNode(prop.argument, symbols, pos, depth + 1)
          if (!spread || typeof spread !== 'object') throw new Error('bad-spread')
          Object.assign(out, spread)
          continue
        }
        if (prop.type !== 'ObjectProperty' || prop.computed) throw new Error('unsupported-property')
        const key = prop.key.type === 'Identifier' ? prop.key.name
          : prop.key.type === 'StringLiteral' ? prop.key.value
            : prop.key.type === 'NumericLiteral' ? String(prop.key.value)
              : null
        if (key === null) throw new Error('key-type:' + prop.key.type)
        out[key] = evalNode(prop.value, symbols, pos, depth + 1)
      }
      return out
    }
    case 'ArrayExpression':
      return node.elements.map((element) => (element ? evalNode(element, symbols, pos, depth + 1) : null))
    case 'MemberExpression': {
      const target = evalNode(node.object, symbols, pos, depth + 1)
      if (!node.computed && node.property.type === 'Identifier' && target && typeof target === 'object' && node.property.name in target) {
        return target[node.property.name]
      }
      throw new Error('member-expression')
    }
    case 'CallExpression': {
      if (node.callee.type === 'Identifier' && node.callee.name === 'String') {
        return String(evalNode(node.arguments[0], symbols, pos, depth + 1))
      }
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier') {
        const target = evalNode(node.callee.object, symbols, pos, depth + 1)
        const method = node.callee.property.name
        if (Array.isArray(target) && method === 'join') {
          const separator = node.arguments.length ? String(evalNode(node.arguments[0], symbols, pos, depth + 1)) : ','
          return target.join(separator)
        }
        if (typeof target === 'string' && method === 'trim') return target.trim()
        if (typeof target === 'object' && target && method === 'freeze') return target
      }
      throw new Error('call-expression')
    }
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value
      throw new Error('unary-expression')
    case 'ParenthesizedExpression':
      return evalNode(node.expression, symbols, pos, depth + 1)
    default:
      throw new Error('node-type:' + node.type)
  }
}

/** Evaluate an object literal property by property, tolerating individual failures. */
function evalObjectPartial(node, symbols, pos) {
  if (node.type !== 'ObjectExpression') {
    try {
      return { value: evalNode(node, symbols, pos), errors: [] }
    } catch (error) {
      return { value: null, errors: [String(error.message ?? error)] }
    }
  }
  const value = {}
  const errors = []
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      try {
        Object.assign(value, evalNode(prop.argument, symbols, pos))
      } catch (error) {
        errors.push('spread:' + String(error.message ?? error))
      }
      continue
    }
    if (prop.type !== 'ObjectProperty' || prop.computed) {
      errors.push('unsupported-property')
      continue
    }
    const key = prop.key.type === 'Identifier' ? prop.key.name
      : prop.key.type === 'StringLiteral' ? prop.key.value
        : null
    if (key === null) {
      errors.push('key-type')
      continue
    }
    try {
      value[key] = evalNode(prop.value, symbols, pos)
    } catch (error) {
      errors.push(key + ':' + String(error.message ?? error))
    }
  }
  return { value, errors }
}

/** Evaluate a locale dictionary value (identifier pointing at an object literal, or the literal itself). */
function evalLocalePartial(node, symbols, pos) {
  let target = node
  let at = pos
  for (let i = 0; i < 8 && target && target.type === 'Identifier'; i++) {
    try {
      const resolved = resolveIdentifier(target, symbols, at)
      target = resolved.init
      at = resolved.pos
    } catch (error) {
      return { value: null, errors: [String(error.message ?? error)] }
    }
  }
  return evalObjectPartial(target, symbols, at)
}

function findForOfRanges(ast) {
  const ranges = []
  walkAll(ast, (node) => {
    if (node.type === 'ForOfStatement'
      && node.left.type === 'VariableDeclaration'
      && node.left.declarations[0]?.id.type === 'ArrayPattern'
      && node.right.type === 'Identifier') {
      ranges.push({ start: node.start, end: node.end, arrayId: node.right.name })
    }
  })
  return ranges
}

function isLocaleRegisterCall(node) {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== 'register') return false
  const owner = callee.object
  if (owner.type === 'Identifier' && owner.name === 'locale') return true
  return owner.type === 'MemberExpression' && !owner.computed && owner.property.type === 'Identifier' && owner.property.name === 'locale'
}

/**
 * @param {Array<{ pkg: string, source: string }>} files
 * @returns {{ namespaces: Record<string, Record<string, string>>, owners: Record<string, string>, problems: string[][] }}
 */
export function extractDictionaries(files) {
  const found = []
  const problems = []

  for (const { pkg, source } of files) {
    let ast
    try {
      ast = parse(source, { sourceType: 'module', plugins: ['jsx'] })
    } catch (error) {
      problems.push([pkg, 'parse', String(error.message ?? error)])
      continue
    }
    const symbols = collectSymbols(ast)
    const forOfRanges = findForOfRanges(ast)

    walkAll(ast, (node) => {
      if (!isLocaleRegisterCall(node) || node.arguments.length < 2) return
      const position = node.start
      try {
        const namespace = evalNode(node.arguments[0], symbols, position)
        if (typeof namespace !== 'string') throw new Error('namespace-not-a-string')

        if (node.arguments.length === 2) {
          const { value: dictionaries, errors } = evalObjectPartial(node.arguments[1], symbols, position)
          if (!dictionaries || typeof dictionaries !== 'object' || !dictionaries.zh || typeof dictionaries.zh !== 'object') {
            const partial = evalLocalePartial(node.arguments[1], symbols, position)
            if (partial.value && partial.value.zh && typeof partial.value.zh === 'object') {
              found.push({ pkg, namespace, dict: partial.value.zh })
              problems.push([pkg, 'partial-dictionaries', namespace + ':' + partial.errors.join(';').slice(0, 160)])
              return
            }
            throw new Error('missing-zh-dictionary:' + errors.join(';').slice(0, 120))
          }
          found.push({ pkg, namespace, dict: dictionaries.zh })
          if (errors.length !== 0) problems.push([pkg, 'partial-dictionaries', namespace + ':' + errors.join(';').slice(0, 160)])
          return
        }

        // Form B: register(namespace, localeId, dictionary) — used by language-pack style rows.
        const range = forOfRanges.find((r) => r.start <= position && position <= r.end)
        if (range) {
          const pairs = evalNode({ type: 'Identifier', name: range.arrayId }, symbols, position)
          const pair = Array.isArray(pairs) ? pairs.find((entry) => Array.isArray(entry) && entry[0] === 'zh') : undefined
          if (pair && pair[1] && typeof pair[1] === 'object') found.push({ pkg, namespace, dict: pair[1] })
          else throw new Error('no-zh-pair')
          return
        }
        const localeId = evalNode(node.arguments[1], symbols, position)
        const dictionary = evalNode(node.arguments[2], symbols, position)
        if (localeId === 'zh' && dictionary && typeof dictionary === 'object') found.push({ pkg, namespace, dict: dictionary })
        else throw new Error('form-b-other-locale')
      } catch (error) {
        problems.push([pkg, 'register@' + position, String(error.message ?? error).slice(0, 140)])
      }
    })
  }

  const nonString = []
  for (const entry of found) {
    for (const [key, value] of Object.entries(entry.dict)) {
      if (typeof value !== 'string') {
        nonString.push([entry.pkg, entry.namespace, key, typeof value])
        delete entry.dict[key]
      }
    }
  }
  for (const entry of nonString) problems.push([entry[0], 'non-string-value', entry[1] + '/' + entry[2]])

  const merged = new Map()
  for (const entry of found) {
    const previous = merged.get(entry.namespace)
    if (previous) {
      problems.push([entry.pkg, 'duplicate-namespace', entry.namespace])
      merged.set(entry.namespace, { pkg: [...new Set([...previous.pkg.split(','), entry.pkg])].join(','), dict: { ...previous.dict, ...entry.dict } })
    } else {
      merged.set(entry.namespace, { pkg: entry.pkg, dict: { ...entry.dict } })
    }
  }

  const namespaces = {}
  const owners = {}
  for (const [namespace, entry] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    namespaces[namespace] = entry.dict
    owners[namespace] = entry.pkg
  }
  return { namespaces, owners, problems }
}

/** Read every bundled client half from a DSH asar archive without unpacking it. */
export function readAsarClientBundles(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(32)
    fs.readSync(fd, head, 0, 32, 0)
    const headerPickleSize = head.readUInt32LE(4)
    const headerJsonLength = head.readUInt32LE(12)
    const headerJson = Buffer.alloc(headerJsonLength)
    fs.readSync(fd, headerJson, 0, headerJsonLength, 16)
    const header = JSON.parse(headerJson.toString('utf8'))
    const dataBase = 8 + headerPickleSize

    const files = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files)) {
        const fullPath = prefix ? prefix + '/' + name : name
        if (entry.files) {
          walk(entry, fullPath)
          continue
        }
        const match = fullPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/lib\/client\.js$/)
        if (!match || entry.unpacked) continue
        const source = Buffer.alloc(entry.size)
        if (entry.size > 0) fs.readSync(fd, source, 0, entry.size, dataBase + Number(entry.offset))
        files.push({ pkg: match[1], source: source.toString('utf8') })
      }
    }
    walk(header, '')
    files.sort((a, b) => a.pkg.localeCompare(b.pkg))
    return files
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read every package manifest under the asar's `node_modules`, plus the root
 * `dsh` package, so a build can record which npm packages the translation reads.
 * @param {string} asarPath
 * @returns {Array<{ name: string, version: string, dshClientPlatform?: string }>}
 */
export function readAsarPackageManifests(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(32)
    fs.readSync(fd, head, 0, 32, 0)
    const headerPickleSize = head.readUInt32LE(4)
    const headerJsonLength = head.readUInt32LE(12)
    const headerJson = Buffer.alloc(headerJsonLength)
    fs.readSync(fd, headerJson, 0, headerJsonLength, 16)
    const header = JSON.parse(headerJson.toString('utf8'))
    const dataBase = 8 + headerPickleSize

    const manifests = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files)) {
        const fullPath = prefix ? prefix + '/' + name : name
        if (entry.files) {
          walk(entry, fullPath)
          continue
        }
        if (!fullPath.endsWith('/package.json') || entry.unpacked) continue
        if (!/^(?:dsh|dsh\/node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/.test(fullPath)) continue
        const bytes = Buffer.alloc(entry.size)
        if (entry.size > 0) fs.readSync(fd, bytes, 0, entry.size, dataBase + Number(entry.offset))
        try {
          const manifest = JSON.parse(bytes.toString('utf8'))
          if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') continue
          manifests.push({
            name: manifest.name,
            version: manifest.version,
            dshClientPlatform: manifest?.dsh?.client?.platform,
          })
        } catch {
          // ignore a malformed manifest; the loader would reject the package anyway
        }
      }
    }
    walk(header, '')
    manifests.sort((a, b) => a.name.localeCompare(b.name))
    return manifests
  } finally {
    fs.closeSync(fd)
  }
}

const PACKAGE_LOCALE_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)\/locale\/(?:([^/]+)\/)?([^/]+)\.json$/

/**
 * Read the display-metadata locale JSON files (`locale/<language>.json`) that
 * every shipped plugin package exports, straight from the asar archive.
 * @param {string} asarPath
 * @returns {Array<{ packageName: string, locale: string, json: string }>}
 */
export function readAsarLocaleMessages(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(32)
    fs.readSync(fd, head, 0, 32, 0)
    const headerPickleSize = head.readUInt32LE(4)
    const headerJsonLength = head.readUInt32LE(12)
    const headerJson = Buffer.alloc(headerJsonLength)
    fs.readSync(fd, headerJson, 0, headerJsonLength, 16)
    const header = JSON.parse(headerJson.toString('utf8'))
    const dataBase = 8 + headerPickleSize

    const messages = []
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files)) {
        const fullPath = prefix ? prefix + '/' + name : name
        if (entry.files) {
          walk(entry, fullPath)
          continue
        }
        const match = fullPath.match(PACKAGE_LOCALE_PATH)
        if (!match || entry.unpacked) continue
        const bytes = Buffer.alloc(entry.size)
        if (entry.size > 0) fs.readSync(fd, bytes, 0, entry.size, dataBase + Number(entry.offset))
        const packageName = match[2] === undefined ? match[1] : `${match[1]}/${match[2]}`
        messages.push({ packageName, locale: match[3], json: bytes.toString('utf8') })
      }
    }
    walk(header, '')
    messages.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.locale.localeCompare(b.locale))
    return messages
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read `locale/<language>.json` files from packages installed in a profile's
 * `node_modules` (installed bundles such as `dsh-subagent-*` or profile-only
 * plugins). Missing directories yield an empty list.
 * @param {string} nodeModulesDir
 * @returns {Array<{ packageName: string, locale: string, json: string }>}
 */
export function readDirectoryLocaleMessages(nodeModulesDir) {
  const messages = []
  if (!fs.existsSync(nodeModulesDir)) return messages
  const packageRoots = []
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.pnpm') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) packageRoots.push(path.join(nodeModulesDir, entry.name, scoped.name))
      }
    } else {
      packageRoots.push(path.join(nodeModulesDir, entry.name))
    }
  }
  for (const packageRoot of packageRoots) {
    const localeDir = path.join(packageRoot, 'locale')
    if (!fs.existsSync(localeDir) || !fs.statSync(localeDir).isDirectory()) continue
    const packageName = packageNameOf(packageRoot)
    const collect = (directory, subpath) => {
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, file.name)
        if (file.isDirectory()) {
          collect(fullPath, subpath === undefined ? file.name : `${subpath}/${file.name}`)
          continue
        }
        if (!file.name.endsWith('.json')) continue
        try {
          messages.push({
            packageName: subpath === undefined ? packageName : `${packageName}/${subpath}`,
            locale: file.name.slice(0, -5),
            json: fs.readFileSync(fullPath, 'utf8'),
          })
        } catch {
          // A linked package may disappear while the profile is edited; skip it.
        }
      }
    }
    collect(localeDir, undefined)
  }
  return messages
}

/**
 * Read the compiled Client half of every profile-installed plugin that declares
 * `dsh.client` and serves a `./client` bundle. Shipped packages are read from the
 * asar archive instead, so callers usually skip names already present there.
 * @param {string} nodeModulesDir
 * @param {{ exclude?: string[] }} [options]
 * @returns {Array<{ pkg: string, source: string }>}
 */
export function readDirectoryClientBundles(nodeModulesDir, options = {}) {
  const excluded = new Set(options.exclude ?? [])
  const files = []
  if (!fs.existsSync(nodeModulesDir)) return files
  const packageRoots = []
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.pnpm') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) packageRoots.push(path.join(nodeModulesDir, entry.name, scoped.name))
      }
    } else {
      packageRoots.push(path.join(nodeModulesDir, entry.name))
    }
  }
  for (const packageRoot of packageRoots) {
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const packageName = manifest?.name
    if (typeof packageName !== 'string') continue
    if (excluded.has(packageName)) continue
    const declaration = manifest?.dsh?.client
    if (declaration === null || typeof declaration !== 'object' || declaration.platform !== 'web') continue
    const clientRel = clientExportOf(manifest.exports) ?? 'lib/client.js'
    const clientPath = path.join(packageRoot, clientRel)
    try {
      files.push({ pkg: packageName, source: fs.readFileSync(clientPath, 'utf8') })
    } catch {
      // A declared Client half without built bytes is skipped: it fails to load anyway.
    }
  }
  files.sort((a, b) => a.pkg.localeCompare(b.pkg))
  return files
}

function clientExportOf(exportsField) {
  if (typeof exportsField === 'string') return exportsField
  const entry = exportsField?.['./client']
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') return entry.default ?? entry.import ?? undefined
  return undefined
}

function packageNameOf(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    if (typeof manifest.name === 'string' && manifest.name !== '') return manifest.name
  } catch {
    // fall through to the directory name
  }
  return path.basename(packageRoot)
}

// CLI: node extract-dicts.mjs <asarPath> <outFile>
if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  const asarPath = process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  const outFile = process.argv[3]
  const files = readAsarClientBundles(asarPath)
  const { namespaces, problems } = extractDictionaries(files)
  let keys = 0
  for (const dict of Object.values(namespaces)) keys += Object.keys(dict).length
  const report = { files: files.length, namespaces: Object.keys(namespaces).length, keys, problems }
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(namespaces, null, 1))
  console.log(JSON.stringify(report, null, 2))
}
