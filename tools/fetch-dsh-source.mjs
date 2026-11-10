/**
 * Fetch the DSH packages this translator reads from the public npm registry.
 *
 * CI cannot open the macOS desktop `app.asar`, so the auto-translate workflow
 * reproduces the local source tree from npm instead: every package recorded in
 * `tools/dsh-packages.json` (client bundles and display-metadata locales) is
 * downloaded as a tarball and unpacked into a `node_modules`-shaped directory
 * that `node tools/build.mjs --source <dir>` can read.
 *
 * Usage:
 *   node fetch-dsh-source.mjs [--version <semver|dist-tag>] [--out <dir>]
 *                             [--manifest <file>] [--registry <url>] [--concurrency <n>]
 *
 * Without `--version` the pinned versions in the manifest are replayed, which
 * keeps a rebuild reproducible. With `--version` (for example `next`) every
 * package resolves that version, and the manifest is updated so a pull request
 * records the refreshed DSH version.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultManifest = path.join(here, 'dsh-packages.json')

function fail(message) {
  console.error(`fetch-dsh-source: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { version: undefined, out: path.join(here, '..', '.dsh-source'), manifest: defaultManifest, registry: process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org', concurrency: 6 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version') args.version = argv[++i]
    else if (arg === '--out') args.out = path.resolve(argv[++i])
    else if (arg === '--manifest') args.manifest = path.resolve(argv[++i])
    else if (arg === '--registry') args.registry = argv[++i]
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else fail(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) fail('--concurrency must be a positive integer')
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!fs.existsSync(args.manifest)) fail(`manifest not found: ${args.manifest}`)
const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'))
if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) fail('manifest lists no packages')
const targets = manifest.packages
const registry = args.registry.replace(/\/+$/u, '')

const packageUrl = (name, version) => `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`

async function withRetries(label, operation, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-locale-zh-tw/translator' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}

/** Resolve the release version a dist-tag (or exact version) points at. */
async function resolveVersion(requested) {
  if (requested === undefined) return undefined
  const representative = '@deepseek-ai/dsh-client-locale'
  try {
    const metadata = await fetchJson(packageUrl(representative, requested))
    return metadata.version
  } catch (error) {
    fail(`cannot resolve DSH version "${requested}" via ${representative}: ${error.message}`)
  }
}

const releaseVersion = await resolveVersion(args.version)
if (releaseVersion !== undefined) console.log(`resolved DSH version: ${releaseVersion} (from "${args.version}")`)
console.log(`fetching ${targets.length} packages from ${registry}${releaseVersion === undefined ? ' (pinned versions)' : ''}`)

const nodeModulesDir = path.join(args.out, 'node_modules')
fs.mkdirSync(nodeModulesDir, { recursive: true })
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-source-'))

const versions = new Map()
let completed = 0
let fallbackCount = 0
const failures = []

async function fetchPackage(target) {
  const requested = releaseVersion ?? target.version
  let metadata
  try {
    metadata = await withRetries(`${target.name}@${requested}`, () => fetchJson(packageUrl(target.name, requested)))
  } catch (error) {
    // Vendored packages (for example the cordis plugins) version independently
    // from the DSH release, and a pinned version can be unpublished. Fall back
    // to the version the app bundles, then to the package's own dist-tag.
    const fallbacks = []
    if (releaseVersion !== undefined && target.version !== releaseVersion) fallbacks.push(target.version)
    if (manifest.tag !== undefined) fallbacks.push(manifest.tag)
    for (const candidate of fallbacks) {
      const picked = await fetchJson(packageUrl(target.name, candidate)).catch(() => undefined)
      if (picked === undefined) continue
      metadata = picked
      fallbackCount += 1
      console.log(`  fallback: ${target.name} ${requested} -> ${picked.version}`)
      break
    }
    if (metadata === undefined) throw error
  }
  const tarballUrl = metadata?.dist?.tarball
  if (typeof tarballUrl !== 'string') throw new Error(`${target.name}: response has no dist.tarball`)
  const tarball = await withRetries(`${target.name} tarball`, async () => {
    const response = await fetch(tarballUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  })
  const archivePath = path.join(stagingDir, `${target.name.replace(/[/@]/gu, '_')}.tgz`)
  fs.writeFileSync(archivePath, tarball)
  const destination = path.join(nodeModulesDir, target.name)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components=1'])
  fs.rmSync(archivePath, { force: true })
  const installed = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'))
  if (installed.name !== target.name) throw new Error(`expected ${target.name}, unpacked ${installed.name}`)
  versions.set(target.name, installed.version)
  completed += 1
  if (completed % 25 === 0 || completed === targets.length) console.log(`  ${completed}/${targets.length} packages`)
}

async function runPool(items, worker, concurrency) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) return
      const item = items[current]
      try {
        await worker(item)
      } catch (error) {
        failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  await Promise.all(workers)
}

await runPool(targets, fetchPackage, args.concurrency)
fs.rmSync(stagingDir, { recursive: true, force: true })

if (failures.length !== 0) {
  console.error(`\n${failures.length} package(s) failed:`)
  for (const failure of failures.slice(0, 20)) console.error('  - ' + failure)
  process.exit(1)
}

const summary = {
  dshVersion: releaseVersion ?? manifest.dshVersion,
  fetchedAt: new Date().toISOString(),
  registry,
  packages: Object.fromEntries([...versions.entries()].sort(([a], [b]) => a.localeCompare(b))),
}
fs.writeFileSync(path.join(args.out, 'fetch-report.json'), JSON.stringify(summary, null, 2) + '\n')
fs.writeFileSync(path.join(args.out, 'dsh-version.txt'), summary.dshVersion + '\n')

// With an explicit version request, refresh the committed manifest so the pull
// request records both the new release and each package's resolved version.
if (releaseVersion !== undefined) {
  const refreshed = {
    ...manifest,
    dshVersion: releaseVersion,
    packages: targets.map((target) => ({ ...target, version: versions.get(target.name) ?? target.version })),
  }
  fs.writeFileSync(args.manifest, JSON.stringify(refreshed, null, 1) + '\n')
  console.log(`updated ${path.relative(here, args.manifest)} -> DSH ${releaseVersion}`)
}

console.log(`fetched ${versions.size} packages into ${nodeModulesDir}${fallbackCount === 0 ? '' : ` (${fallbackCount} version fallback(s))`}`)
console.log(`DSH version: ${summary.dshVersion}`)
console.log(`next: node tools/build.mjs --source ${path.relative(here, nodeModulesDir)} --version ${summary.dshVersion}`)
