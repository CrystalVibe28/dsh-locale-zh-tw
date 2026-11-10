/**
 * Build the Traditional Chinese (zh-TW) client bundle for the DSH Web GUI.
 *
 * The translation is generated from copy shipped inside DSH, so a build needs a
 * source tree. Three modes cover local authoring and CI:
 *
 *   node build.mjs
 *     Default: read the installed DSH desktop `app.asar` plus client plugins
 *     installed in the current profile ($DSH_PROFILE_DIR). Writes the package
 *     manifest and a source snapshot for CI.
 *
 *   node build.mjs --source <node_modules>
 *     Read a node_modules-shaped tree (CI fetches it from the npm registry with
 *     `tools/fetch-dsh-source.mjs`).
 *
 *   node build.mjs --from-snapshot
 *     Rebuild from the committed `tools/out/source-snapshot.json` only. This is
 *     the deterministic CI check: it must reproduce `lib/client.js` exactly.
 *
 * Options: --asar <path>, --version <dsh version>, --source <dir>, --from-snapshot
 *
 * Pipeline:
 *   1. Collect every client bundle (`lib/client.js`) and display-metadata locale
 *      file (`locale/*.json`, including `locale/<subpath>/`) from the source.
 *   2. Statically extract each locale namespace's shipped `zh` (Simplified)
 *      dictionary.
 *   3. Convert every string to Traditional Chinese with OpenCC `cn -> twp`
 *      (Taiwan standard characters and terminology) plus a product glossary.
 *   4. Convert package display metadata (`LocalizedText` plugin titles and
 *      descriptions, which bypass namespace dictionaries) and prepare a
 *      character-level fallback map for text this build never saw.
 *   5. Run quality gates (placeholder parity, leftover Simplified characters,
 *      newline parity) and write reports.
 *   6. Emit `lib/client.js` and, outside snapshot mode, the committed source
 *      snapshot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Converter } from 'opencc-js'
import {
  extractDictionaries,
  readAsarClientBundles,
  readAsarLocaleMessages,
  readAsarPackageManifests,
  readDirectoryClientBundles,
  readDirectoryLocaleMessages,
} from './extract-dicts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const outDir = path.join(here, 'out')
const snapshotPath = path.join(outDir, 'source-snapshot.json')
const manifestPath = path.join(here, 'dsh-packages.json')
const pluginsPath = path.join(here, 'plugins.json')

const PACKAGE_NAME = '@local/dsh-locale-zh-tw'
const LOCALE_ID = 'zh-TW'
const LOCALE_LABEL = '正體中文'
const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const placeholder = /\{[A-Za-z0-9_.\-:/]+\}|\$\{[^}]+\}|%[sd@]/g

/*
 * OpenCC `cn -> twp` already covers the bulk of Taiwan standard characters and
 * vocabulary, but a few classes of copy stay wrong or read as Mainland usage:
 *   - ambiguous characters whose phrase context OpenCC cannot disambiguate
 *     (`只`/`隻`, `并`/`併`, `回复`);
 *   - Taiwan preferences OpenCC does not apply (`帳號`, `權限`, `設定`, `核准`);
 *   - OpenCC's own choices that read oddly in this product (`檔位`, `迴復`).
 * Longer phrases must come before their substrings.
 */
const GLOSSARY = [
  ['配置檔案', '設定檔'],
  ['配置文件', '設定檔'],
  ['配置項', '設定項'],
  ['配置', '設定'],
  ['許可權', '權限'],
  ['賬號', '帳號'],
  ['賬戶', '帳戶'],
  ['賬單', '帳單'],
  ['檔位', '等級'],
  ['憑據', '憑證'],
  ['校驗', '驗證'],
  ['軟體包', '軟體套件'],
  ['外掛包', '外掛套件'],
  ['全域性', '全域'],
  ['其它', '其他'],
  ['創建', '建立'],
  ['運行', '執行'],
  ['加載', '載入'],
  ['彈窗', '彈出視窗'],
  ['審批', '核准'],
  ['計劃', '計畫'],
  ['撤銷後', '復原後'],
  ['撤銷失敗', '復原失敗'],
  ['隻影響', '只影響'],
  ['這隻會', '這只會'],
  ['迴復', '回覆'],
  ['併發執行', '並行執行'],
  ['併發送', '並發送'],
  ['周{weekday}', '週{weekday}'],
  ['周的周', '週的週'],
  ['訪問網頁', '造訪網頁'],
  ['訪問權限', '存取權限'],
  ['訪問範圍', '存取範圍'],
  ['訪問', '存取'],
  ['服務端', '伺服器端'],
  ['客戶端', '使用者端'],
  ['用戶', '使用者'],
  ['例項', '實例'],
  ['反饋', '回饋'],
  ['響應', '回應'],
  ['令牌', '權杖'],
  ['倉庫', '儲存庫'],
  ['選中', '選取'],
  ['文本', '文字'],
  ['斷開', '中斷'],
  ['身份', '身分'],
]
/** Whole-value replacements, for copy whose meaning depends on the button it labels. */
const VALUE_OVERRIDES = new Map([['撤銷', '復原']])

/** Characters that a naive single-character Simplified -> Traditional mapping changes but that are
 * still correct Traditional Chinese here; each entry records why it is kept. */
const REVIEWED_AMBIGUOUS_CHARACTERS = new Map([
  ['准', '批准 uses 准 (permit), which is standard Traditional; 準 is the standard/exact sense.'],
  ['台', '控制台/平台/後台 are written with 台 in Taiwan; 臺 is the formal variant, not a correction.'],
  ['游', '游標 (cursor) is standard Taiwan copy and keeps 游; 遊 is the travel sense.'],
])

/**
 * Characters that must not, on their own, classify a string as Simplified when
 * the source language is unknown: each one is also a legitimate Traditional
 * character (`皇后`, `台灣`, `批准`, `乾淨`). They are still converted when a
 * string is known to be Simplified, so phrase-level copy stays correct.
 */
const AMBIGUOUS_SIMPLIFIED_CHARACTERS = new Set([
  '后', '里', '台', '只', '干', '系', '松', '制', '折', '划', '采', '表', '注',
  '于', '并', '云', '了', '蒙', '向', '准', '卷', '万', '与', '丑', '冲', '致',
  '别', '斗', '谷', '曲', '克', '支', '复', '历', '舍', '姜', '叶', '余', '征',
  '御', '郁', '借', '伙', '布', '占', '沈', '杰', '苏', '范', '刮', '托', '板',
  '彩', '面', '累', '弥', '扎', '划', '了', '伙', '冲', '别', '致', '云',
])

function localize(text) {
  let out = text
  for (const [from, to] of GLOSSARY) out = out.split(from).join(to)
  return VALUE_OVERRIDES.get(out) ?? out
}

/** Flatten every string value of a parsed locale JSON document. */
function flattenStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) flattenStrings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) flattenStrings(item, out)
  return out
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { asar: undefined, source: undefined, fromSnapshot: false, version: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--asar') args.asar = argv[++i]
    else if (arg === '--source') args.source = argv[++i]
    else if (arg === '--version') args.version = argv[++i]
    else if (arg === '--from-snapshot') args.fromSnapshot = true
    else fail(`unknown argument: ${arg}`)
  }
  if (args.fromSnapshot && args.source !== undefined) fail('--from-snapshot and --source are exclusive')
  return args
}

function readPackageManifest(nodeModulesDir, packageName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nodeModulesDir, packageName, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function packageNameOfDirectory(directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

/** "@deepseek-ai/dsh-tool-subagent/model-selection-settings" -> "@deepseek-ai/dsh-tool-subagent" */
function parentPackageOf(packageName) {
  const parts = packageName.split('/')
  return packageName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Collect every zh display-metadata string, in first-seen order. */
function collectMetadataStrings(localeMessages) {
  const strings = []
  const seen = new Set()
  for (const message of localeMessages) {
    if (message.locale.toLowerCase() !== 'zh') continue
    let parsed
    try {
      parsed = JSON.parse(message.json)
    } catch {
      fail(`unreadable locale file for ${message.packageName}: ${message.locale}`)
    }
    for (const text of flattenStrings(parsed)) {
      if (seen.has(text)) continue
      seen.add(text)
      strings.push(text)
    }
  }
  return strings
}

const args = parseArgs(process.argv.slice(2))
const mode = args.fromSnapshot ? 'snapshot' : args.source !== undefined ? 'source' : 'asar'
const sourceDir = args.source === undefined ? undefined : path.resolve(args.source)

let dictionaries
let metadataStrings
let owners = {}
let dshVersion = args.version
let shippedBundleCount = 0
let installedBundles = []
let installedBundleSources = []
let sourcePackageCount = 0

console.log(`mode: ${mode}${sourceDir === undefined ? '' : ` (${sourceDir})`}`)

if (mode === 'snapshot') {
  if (!fs.existsSync(snapshotPath)) fail(`source snapshot not found: ${snapshotPath}`)
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  dictionaries = snapshot.dictionaries
  metadataStrings = snapshot.metadata
  owners = snapshot.owners ?? {}
  dshVersion = dshVersion ?? snapshot.dshVersion ?? 'unknown'
  shippedBundleCount = snapshot.bundles?.shipped ?? 0
  installedBundles = snapshot.bundles?.installed ?? []
  sourcePackageCount = Object.keys(owners).length
  console.log(`      snapshot: ${Object.keys(dictionaries).length} namespaces, ${metadataStrings.length} display strings (DSH ${dshVersion})`)
} else {
  let bundles
  let localeMessages
  let packages = []

  if (mode === 'source') {
    if (!fs.existsSync(sourceDir)) fail(`source node_modules not found: ${sourceDir}`)
    bundles = readDirectoryClientBundles(sourceDir, { exclude: [PACKAGE_NAME] })
    localeMessages = readDirectoryLocaleMessages(sourceDir)
    shippedBundleCount = bundles.length
    sourcePackageCount = [...new Set(localeMessages.map((message) => parentPackageOf(message.packageName)))].length
    if (dshVersion === undefined) {
      for (const candidate of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-locale']) {
        dshVersion = packageNameOfDirectory(path.join(sourceDir, candidate)) === candidate
          ? JSON.parse(fs.readFileSync(path.join(sourceDir, candidate, 'package.json'), 'utf8')).version
          : undefined
        if (dshVersion !== undefined) break
      }
    }
    localeMessages.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.locale.localeCompare(b.locale))
    console.log(`      ${bundles.length} client bundles, ${localeMessages.length} display-metadata locale files`)
  } else {
    const asarPath = args.asar ?? DEFAULT_ASAR
    if (!fs.existsSync(asarPath)) {
      fail(`DSH asar archive not found: ${asarPath}\nUse --source <node_modules> or --from-snapshot instead.`)
    }
    const asarBundles = readAsarClientBundles(asarPath)
    const profileDir = process.env.DSH_PROFILE_DIR
    const profileNodeModules = profileDir === undefined ? undefined : path.join(profileDir, 'node_modules')
    const nodeModulesForProfile = profileNodeModules
    const profileBundles = profileNodeModules === undefined
      ? []
      : readDirectoryClientBundles(profileNodeModules, { exclude: [PACKAGE_NAME] })
    const shippedNames = new Set(asarBundles.map((bundle) => bundle.pkg))
    const installed = profileBundles.filter((bundle) => !shippedNames.has(bundle.pkg))
    bundles = [...asarBundles, ...installed]
    shippedBundleCount = asarBundles.length
    installedBundles = installed.map((bundle) => bundle.pkg)
    installedBundleSources = installed
    // Only shipped packages and third-party profile plugins contribute display
    // metadata. Profile copies of shipped packages are ignored: CI replays them
    // from the npm registry at the manifest version, so including a possibly
    // different profile version here would make builds non-reproducible.
    const asarLocaleMessages = readAsarLocaleMessages(asarPath)
    const shippedPackageNames = new Set(asarLocaleMessages.map((message) => parentPackageOf(message.packageName)))
    const profileLocaleMessages = (profileNodeModules === undefined ? [] : readDirectoryLocaleMessages(profileNodeModules))
      .filter((message) => {
        const parent = parentPackageOf(message.packageName)
        return parent !== PACKAGE_NAME && !shippedPackageNames.has(parent)
      })
    localeMessages = [...asarLocaleMessages, ...profileLocaleMessages]
    console.log(`      ${asarBundles.length} shipped client bundles, ${installed.length} installed client bundles (${installedBundles.join(', ') || 'none'})`)
    localeMessages.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.locale.localeCompare(b.locale))
    console.log(`      ${localeMessages.length} display-metadata locale files`)

    // Record which npm packages carry the sources, so CI can fetch them.
    const manifests = readAsarPackageManifests(asarPath)
    dshVersion = dshVersion ?? manifests.find((manifest) => manifest.name === '@deepseek-ai/dsh')?.version ?? 'unknown'
    const localeParents = new Set(localeMessages.map((message) => parentPackageOf(message.packageName)))
    packages = manifests
      .filter((manifest) => manifest.name.startsWith('@deepseek-ai/'))
      .map((manifest) => ({
        name: manifest.name,
        version: manifest.version,
        client: manifest.dshClientPlatform === 'web',
        locale: localeParents.has(manifest.name),
      }))
      .filter((manifest) => manifest.client || manifest.locale)
    // Profile-installed first-party bundles (for example the subagent packs)
    // also carry display metadata but are not shipped inside the app; fetch
    // them from npm too so CI sees the same metadata strings.
    const knownNames = new Set(packages.map((manifest) => manifest.name))
    const profileParents = new Set(localeMessages.map((message) => parentPackageOf(message.packageName)))
    const profileCandidates = new Set([
      ...profileParents,
      ...installedBundles.filter((name) => name.startsWith('@deepseek-ai/')),
    ])
    for (const name of profileCandidates) {
      if (knownNames.has(name) || nodeModulesForProfile === undefined) continue
      const manifest = readPackageManifest(nodeModulesForProfile, name)
      if (manifest === undefined || typeof manifest.version !== 'string') continue
      packages.push({
        name,
        version: manifest.version,
        client: manifest?.dsh?.client?.platform === 'web',
        locale: profileParents.has(name),
      })
      knownNames.add(name)
    }
    packages.sort((a, b) => a.name.localeCompare(b.name))
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, dshVersion, tag: 'next', packages }, null, 1) + '\n',
    )
    sourcePackageCount = packages.length
    console.log(`      ${packages.length} npm packages recorded in ${path.relative(pluginDir, manifestPath)}`)
  }

  const extracted = extractDictionaries(bundles)
  if (extracted.problems.length !== 0) {
    console.error('      extraction problems:')
    for (const problem of extracted.problems) console.error('       ', problem.join(' | '))
    process.exit(1)
  }
  dictionaries = extracted.namespaces
  owners = extracted.owners

  // Locally installed third-party plugins are not part of the npm fetch, so
  // their extracted dictionaries live in a committed layer that every mode
  // merges. A local asar build refreshes that layer; CI replays it.
  if (mode === 'asar' && installedBundleSources.length !== 0) {
    const plugins = []
    const dictionariesByPlugin = {}
    for (const bundle of installedBundleSources) {
      const layer = extractDictionaries([bundle])
      if (layer.problems.length !== 0) {
        console.error(`      installed plugin ${bundle.pkg}: extraction problems`)
        for (const problem of layer.problems) console.error('       ', problem.join(' | '))
        process.exit(1)
      }
      const namespaces = Object.keys(layer.namespaces)
      if (namespaces.length === 0) continue
      let version = 'unknown'
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(process.env.DSH_PROFILE_DIR ?? '', 'node_modules', bundle.pkg, 'package.json'), 'utf8'))
        if (typeof manifest.version === 'string') version = manifest.version
      } catch {
        // version is informational only
      }
      plugins.push({ name: bundle.pkg, version, namespaces })
      dictionariesByPlugin[bundle.pkg] = layer.namespaces
    }
    fs.writeFileSync(pluginsPath, JSON.stringify({
      schemaVersion: 1,
      description: 'Dictionaries of profile-installed client plugins that are not shipped inside DSH; merged by every build mode.',
      plugins,
      dictionaries: Object.assign({}, ...Object.values(dictionariesByPlugin)),
    }, null, 1) + '\n')
    console.log(`      installed plugin layer: ${plugins.map((plugin) => `${plugin.name}@${plugin.version}`).join(', ') || 'none'} -> ${path.relative(pluginDir, pluginsPath)}`)
  }

  if (fs.existsSync(pluginsPath)) {
    const layer = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'))
    for (const [namespace, dict] of Object.entries(layer.dictionaries ?? {})) {
      if (dictionaries[namespace] !== undefined) continue
      dictionaries[namespace] = dict
      owners[namespace] = (layer.plugins ?? []).find((plugin) => plugin.namespaces.includes(namespace))?.name + ' (installed)'
    }
  }

  dictionaries = Object.fromEntries(Object.entries(dictionaries).sort(([a], [b]) => a.localeCompare(b)))
  owners = Object.fromEntries(Object.entries(owners).sort(([a], [b]) => a.localeCompare(b)))
  metadataStrings = collectMetadataStrings(localeMessages)
  console.log(`      ${Object.keys(dictionaries).length} namespaces, ${Object.values(dictionaries).reduce((sum, dict) => sum + Object.keys(dict).length, 0)} interface keys`)
  console.log(`      ${metadataStrings.length} display-metadata strings`)
}

const sourceKeys = Object.values(dictionaries).reduce((sum, dict) => sum + Object.keys(dict).length, 0)

console.log('[2/5] converting zh (Simplified) to zh-TW (Taiwan standard)')
const convert = Converter({ from: 'cn', to: 'twp' })
const converted = {}
const glossaryHits = new Map()
for (const namespace of Object.keys(dictionaries)) {
  const dict = {}
  for (const [key, value] of Object.entries(dictionaries[namespace])) {
    const opencc = convert(value)
    const final = localize(opencc)
    dict[key] = final
    for (const [from, to] of GLOSSARY) {
      if (!opencc.includes(from)) continue
      const count = opencc.split(from).length - 1
      const entry = glossaryHits.get(from) ?? { to, count: 0 }
      entry.count += count
      glossaryHits.set(from, entry)
    }
  }
  converted[namespace] = dict
}
console.log(`      glossary applied: ${glossaryHits.size} rules`)

console.log('[3/5] converting package display metadata (LocalizedText)')
const packageText = {}
let metadataTranslated = 0
for (const text of metadataStrings) {
  if (![...text].some((char) => cjk.test(char))) continue
  const translated = localize(convert(text))
  if (translated === text) continue
  packageText[text] = translated
  metadataTranslated += 1
}
const packageTextKeys = Object.keys(packageText)
console.log(`      ${metadataStrings.length} strings, ${metadataTranslated} translated`)

// Character-level fallback for Simplified text this build never saw, such as a
// profile-installed plugin that authors package.json/localization in Simplified.
const charMap = new Map()
const strongSimplified = []
for (const [start, end] of [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]) {
  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    const char = String.fromCodePoint(codePoint)
    const traditional = convert(char)
    if (traditional === char) continue
    charMap.set(char, traditional)
    if (!AMBIGUOUS_SIMPLIFIED_CHARACTERS.has(char)) strongSimplified.push(char)
  }
}
const charPairs = [...charMap.entries()].map(([from, to]) => `${from} ${to}`).join('|')
console.log(`      character fallback map: ${charMap.size} pairs, ${strongSimplified.length} classifier characters`)

console.log('[4/5] quality gates')
const placeholderMismatches = []
const newlineMismatches = []
for (const namespace of Object.keys(dictionaries)) {
  for (const [key, sourceValue] of Object.entries(dictionaries[namespace])) {
    const target = converted[namespace][key]
    const sourceTokens = [...sourceValue.matchAll(placeholder)].map((match) => match[0]).sort()
    const targetTokens = [...target.matchAll(placeholder)].map((match) => match[0]).sort()
    if (sourceTokens.join('\u0000') !== targetTokens.join('\u0000')) {
      placeholderMismatches.push({ namespace, key, source: sourceValue, target, sourceTokens, targetTokens })
    }
    const sourceNewlines = (sourceValue.match(/\n/g) ?? []).length
    const targetNewlines = (target.match(/\n/g) ?? []).length
    if (sourceNewlines !== targetNewlines) newlineMismatches.push({ namespace, key, sourceNewlines, targetNewlines })
  }
}

// Leftover Simplified characters: a character whose single-character
// Simplified -> Traditional mapping differs from itself is Simplified-only, so
// finding it in converted output means the phrase was not converted.
const toTraditional = Converter({ from: 'cn', to: 't' })
const candidateChars = new Set()
for (const dict of Object.values(dictionaries)) {
  for (const value of Object.values(dict)) {
    for (const char of value) if (cjk.test(char)) candidateChars.add(char)
  }
}
const simplifiedOnly = new Map()
for (const char of candidateChars) {
  const traditional = toTraditional(char)
  if (traditional !== char) simplifiedOnly.set(char, traditional)
}
const leftoverCounts = new Map()
const reviewedCharacters = new Map()
const leftoverSamples = []
for (const namespace of Object.keys(converted)) {
  for (const [key, value] of Object.entries(converted[namespace])) {
    for (const char of value) {
      if (!simplifiedOnly.has(char)) continue
      if (REVIEWED_AMBIGUOUS_CHARACTERS.has(char)) {
        reviewedCharacters.set(char, (reviewedCharacters.get(char) ?? 0) + 1)
        continue
      }
      leftoverCounts.set(char, (leftoverCounts.get(char) ?? 0) + 1)
      if (leftoverSamples.length < 40) leftoverSamples.push({ namespace, key, char, traditional: simplifiedOnly.get(char), value })
    }
  }
}
const metadataLeftovers = []
for (const [source, target] of Object.entries(packageText)) {
  for (const char of target) {
    if (!simplifiedOnly.has(char) || REVIEWED_AMBIGUOUS_CHARACTERS.has(char)) continue
    metadataLeftovers.push({ source, target, char })
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  mode,
  dshVersion,
  source: { asar: args.asar ?? (mode === 'asar' ? DEFAULT_ASAR : undefined), sourceDir },
  bundles: { shipped: shippedBundleCount, installed: installedBundles },
  packages: sourcePackageCount,
  namespaces: Object.keys(converted).length,
  keys: sourceKeys,
  owners,
  displayMetadata: {
    strings: metadataStrings.length,
    translated: packageTextKeys.length,
    leftovers: metadataLeftovers,
  },
  characterFallback: { pairs: charMap.size, classifiers: strongSimplified.length },
  glossary: Object.fromEntries([...glossaryHits.entries()].map(([from, entry]) => [from, { to: entry.to, count: entry.count }])),
  reviewedAmbiguousCharacters: Object.fromEntries([...reviewedCharacters.entries()].map(([char, count]) => [char, { count, reason: REVIEWED_AMBIGUOUS_CHARACTERS.get(char) }])),
  placeholderMismatches,
  newlineMismatches,
  leftoverSimplified: [...leftoverCounts.entries()].map(([char, count]) => ({ char, traditional: simplifiedOnly.get(char), count })),
  leftoverSamples,
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'dicts-zh.json'), JSON.stringify(dictionaries, null, 1))
fs.writeFileSync(path.join(outDir, 'dicts-zh-tw.json'), JSON.stringify(converted, null, 1))
fs.writeFileSync(path.join(outDir, 'package-text-zh-tw.json'), JSON.stringify(packageText, null, 1))
fs.writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(report, null, 2))

if (mode !== 'snapshot') {
  // Deterministic on purpose: CI rebuilds this snapshot from npm and must
  // reproduce the committed bytes, so no timestamps or environment counts.
  fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: 1,
    dshVersion,
    dictionaries,
    metadata: metadataStrings,
  }, null, 1) + '\n')
}

const gateFailures = []
if (placeholderMismatches.length !== 0) gateFailures.push(`${placeholderMismatches.length} placeholder mismatches`)
if (leftoverCounts.size !== 0) gateFailures.push(`${leftoverCounts.size} leftover Simplified characters (${[...leftoverCounts.keys()].join('')})`)
if (newlineMismatches.length !== 0) gateFailures.push(`${newlineMismatches.length} newline mismatches`)
if (metadataLeftovers.length !== 0) gateFailures.push(`${metadataLeftovers.length} leftover Simplified characters in display metadata`)

console.log(`      namespaces: ${report.namespaces}, keys: ${report.keys}`)
console.log(`      placeholder mismatches: ${placeholderMismatches.length}`)
console.log(`      newline mismatches: ${newlineMismatches.length}`)
console.log(`      glossary replacements: ${[...glossaryHits.values()].reduce((sum, entry) => sum + entry.count, 0)} across ${glossaryHits.size} rules`)
console.log(`      reviewed ambiguous characters kept: ${[...reviewedCharacters.entries()].map(([char, count]) => `${char}x${count}`).join(' ') || 'none'}`)
console.log(`      leftover Simplified characters: ${leftoverCounts.size}${leftoverCounts.size ? ' -> ' + [...leftoverCounts.entries()].map(([char, count]) => `${char}x${count}`).join(' ') : ''}`)
console.log(`      display metadata leftovers: ${metadataLeftovers.length}`)

console.log('[5/5] emitting client bundle')
const header = `/**
 * Traditional Chinese (zh-TW) language pack for the DSH Web GUI.
 *
 * Generated by tools/build.mjs from DSH ${dshVersion}:
 *   - ${report.keys} interface strings across ${report.namespaces} locale namespaces
 *   - ${packageTextKeys.length} package titles/descriptions (LocalizedText)
 * converted with OpenCC cn -> twp (Taiwan standard characters and terminology)
 * plus a product terminology glossary, and a ${charMap.size}-pair character
 * fallback map for Simplified text this build never saw.
 *
 * Do not edit by hand; run \`node tools/build.mjs\` to regenerate.
 */
`
const body = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory(require) {
    const DICTIONARIES = ${JSON.stringify(converted)};
    const PACKAGE_TEXT = ${JSON.stringify(packageText)};
    const CHAR_PAIRS = ${JSON.stringify(charPairs)};
    const STRONG_SIMPLIFIED = ${JSON.stringify(strongSimplified.join(''))};
    const PHRASES = ${JSON.stringify(GLOSSARY)};

    let characterMap;
    let classifier;
    const translatedText = new Map();
    const characterMapOf = () => {
      if (characterMap !== undefined) return characterMap;
      characterMap = new Map();
      for (const pair of CHAR_PAIRS.split('|')) {
        const separator = pair.indexOf(' ');
        characterMap.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return characterMap;
    };
    const classifierOf = () => {
      if (classifier !== undefined) return classifier;
      classifier = new Set(STRONG_SIMPLIFIED);
      return classifier;
    };
    const convertCharacters = (text) => {
      const map = characterMapOf();
      let out = '';
      for (const char of text) out += map.get(char) ?? char;
      for (const [from, to] of PHRASES) if (out.includes(from)) out = out.split(from).join(to);
      return out;
    };
    const looksSimplified = (text) => {
      const strong = classifierOf();
      for (const char of text) if (strong.has(char)) return true;
      return false;
    };
    /** Translate one package title/description; \`knownSimplified\` skips detection. */
    const localizePackageText = (text, knownSimplified) => {
      const cached = translatedText.get(text);
      if (cached !== undefined) return cached;
      let out = Object.prototype.hasOwnProperty.call(PACKAGE_TEXT, text) ? PACKAGE_TEXT[text] : undefined;
      if (out === undefined) out = knownSimplified || looksSimplified(text) ? convertCharacters(text) : text;
      translatedText.set(text, out);
      return out;
    };
    const stringField = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && typeof object[key] === 'string'
      ? object[key]
      : undefined;

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.addLanguage({ id: ${JSON.stringify(LOCALE_ID)}, label: ${JSON.stringify(LOCALE_LABEL)}, fallback: 'zh' }),
          'dsh-locale-zh-tw: language definition',
        );
        for (const namespace of Object.keys(DICTIONARIES)) {
          ctx.effect(
            () => ctx.locale.register(namespace, ${JSON.stringify(LOCALE_ID)}, DICTIONARIES[namespace]),
            'dsh-locale-zh-tw: ' + namespace + ' dictionary',
          );
        }
        // Package titles and descriptions arrive as LocalizedText maps that only
        // carry the shipped locale ids, and LocaleRuntime#resolveText never
        // consults namespace dictionaries. Resolve them through the converted
        // table while zh-TW is active, and restore the original method on unload.
        ctx.effect(() => {
          const service = ctx.locale;
          if (typeof service.resolveText !== 'function') return () => {};
          const original = service.resolveText;
          const hadOwnMethod = Object.prototype.hasOwnProperty.call(service, 'resolveText');
          const patched = function (text) {
            if (service.getLocale().active !== ${JSON.stringify(LOCALE_ID)}) return original.call(service, text);
            if (typeof text === 'string') return localizePackageText(text, false);
            if (text === null || typeof text !== 'object') return original.call(service, text);
            const translated = stringField(text, 'zh-tw');
            if (translated !== undefined) return translated;
            const upper = stringField(text, 'zh-TW');
            if (upper !== undefined) return upper;
            const simplified = stringField(text, 'zh');
            if (simplified !== undefined) return localizePackageText(simplified, true);
            return original.call(service, text);
          };
          try {
            service.resolveText = patched;
          } catch {
            return () => {};
          }
          if (service.resolveText !== patched) return () => {};
          return () => {
            if (service.resolveText !== patched) return;
            if (hadOwnMethod) service.resolveText = original;
            else delete service.resolveText;
          };
        }, 'dsh-locale-zh-tw: package display text resolver');
      },
    };
  },
});
`
fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
fs.writeFileSync(path.join(pluginDir, 'lib', 'client.js'), header + body)
const clientSize = fs.statSync(path.join(pluginDir, 'lib', 'client.js')).size
console.log(`      ${path.relative(pluginDir, path.join(pluginDir, 'lib', 'client.js'))} (${(clientSize / 1024).toFixed(1)} KiB)`)

if (gateFailures.length !== 0) {
  console.error('quality gates failed: ' + gateFailures.join(', '))
  console.error('see tools/out/qa-report.json')
  process.exit(2)
}
console.log(`done (DSH ${dshVersion})`)
