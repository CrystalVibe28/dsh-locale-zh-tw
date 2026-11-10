/**
 * Offline smoke test for the generated Client bundle.
 *
 * Loads `dsh-locale-zh-tw/lib/client.js` in a VM with the exact
 * `window.__ModuleLoader__.load({ id, factory })` contract, calls the factory,
 * then runs `apply` against a mock locale service that ports the validation and
 * lookup rules of the shipped `LocaleRuntime`
 * (`@deepseek-ai/dsh-client-locale`: `addLanguage` / `register` / `translate` /
 * `resolveText`).
 *
 * It proves that the bundle:
 *   - registers the zh-TW language definition and all namespace dictionaries;
 *   - resolves copy through zh-TW -> zh -> en;
 *   - converts LocalizedText package titles/descriptions (which bypass
 *     namespace dictionaries) while zh-TW is active, and leaves other locales
 *     and already-Traditional text untouched;
 *   - restores the original `resolveText` when the plugin unloads.
 *
 * Usage: node verify-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const clientFile = path.join(pluginDir, 'lib', 'client.js')
const LANG_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
// Expected coverage comes from the build output so installed-client additions do not stale-lock the test.
const expectedNamespaces = JSON.parse(fs.readFileSync(path.join(here, 'out', 'dicts-zh.json'), 'utf8'))

const failures = []
const check = (condition, message) => {
  if (condition) return
  failures.push(message)
  console.error('FAIL ' + message)
}

/** Mock of the shipped LocaleRuntime, with methods on the prototype like the real class. */
class MockLocaleRuntime {
  constructor() {
    this.catalog = new Map([
      ['zh', { id: 'zh', label: '中文', fallback: 'en' }],
      ['en', { id: 'en', label: 'English' }],
    ])
    this.dicts = new Map()
    this.active = 'en'
  }

  static keyOf(value) {
    return value.toLowerCase()
  }

  chain(start) {
    const out = []
    const seen = new Set()
    let current = this.catalog.get(MockLocaleRuntime.keyOf(start))
    while (current !== undefined && !seen.has(MockLocaleRuntime.keyOf(current.id))) {
      seen.add(MockLocaleRuntime.keyOf(current.id))
      out.push(current.id)
      current = current.fallback === undefined ? undefined : this.catalog.get(MockLocaleRuntime.keyOf(current.fallback))
    }
    if (!seen.has('en')) out.push('en')
    return out
  }

  assertChain(start) {
    const seen = new Set()
    let current = this.catalog.get(MockLocaleRuntime.keyOf(start))
    while (current !== undefined) {
      const key = MockLocaleRuntime.keyOf(current.id)
      if (seen.has(key)) throw new Error('cycle')
      seen.add(key)
      if (key === 'en') return
      if (current.fallback === undefined) throw new Error('chain does not reach en')
      const next = this.catalog.get(MockLocaleRuntime.keyOf(current.fallback))
      if (next === undefined) throw new Error('fallback not registered: ' + current.fallback)
      current = next
    }
  }

  getLocale() {
    return { active: this.active, locales: [...this.catalog.values()], revision: 0 }
  }

  addLanguage(input) {
    if (!LANG_ID.test(input.id)) throw new Error('bad locale id: ' + input.id)
    if (input.label.trim() === '') throw new Error('empty label')
    if (!LANG_ID.test(input.fallback)) throw new Error('bad fallback id')
    if (this.catalog.has(MockLocaleRuntime.keyOf(input.id))) throw new Error('duplicate locale: ' + input.id)
    if (!this.catalog.has(MockLocaleRuntime.keyOf(input.fallback))) throw new Error('unknown fallback: ' + input.fallback)
    const language = { ...input, fallback: this.catalog.get(MockLocaleRuntime.keyOf(input.fallback)).id }
    this.catalog.set(MockLocaleRuntime.keyOf(language.id), language)
    try {
      this.assertChain(language.id)
    } catch (error) {
      this.catalog.delete(MockLocaleRuntime.keyOf(language.id))
      throw error
    }
    return () => this.catalog.delete(MockLocaleRuntime.keyOf(language.id))
  }

  register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
    for (const [locale] of pairs) if (!LANG_ID.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`)
    let locales = this.dicts.get(ns)
    if (!locales) {
      locales = new Map()
      this.dicts.set(ns, locales)
    }
    for (const [locale] of pairs) if (locales.has(MockLocaleRuntime.keyOf(locale))) throw new Error(`namespace "${ns}" already has locale "${locale}"`)
    for (const [locale, entries] of pairs) locales.set(MockLocaleRuntime.keyOf(locale), entries)
    return () => {}
  }

  /** Port of LocaleRuntime#resolveText: plain strings verbatim, maps via the fallback chain. */
  resolveText(text) {
    if (typeof text === 'string') return text
    return this.chain(this.active).reduceRight((resolved, locale) => text[MockLocaleRuntime.keyOf(locale)] ?? resolved, text.en)
  }
}

const source = fs.readFileSync(clientFile, 'utf8')
const context = vm.createContext({ window: {}, console, URL, setTimeout, clearTimeout })
let captured
context.window.__ModuleLoader__ = { load: (definition) => { captured = definition } }
vm.runInContext(source, context, { filename: clientFile })

check(captured !== undefined, 'bundle calls window.__ModuleLoader__.load')
if (!captured) process.exit(1)
check(captured.id === '@local/dsh-locale-zh-tw', 'module id equals the package name (got ' + captured.id + ')')
check(typeof captured.factory === 'function', 'bundle exposes a lazy factory')

const factory = captured.factory(() => {
  throw new Error('bundle must not require external modules')
})
check(factory && typeof factory.apply === 'function', 'factory returns a plugin object with apply')
check(Array.isArray(factory.inject) && factory.inject.includes('locale'), 'plugin injects the locale service')

const locale = new MockLocaleRuntime()
const disposers = []
const ctx = {
  locale,
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  on() {
    return () => {}
  },
}
const originalResolveText = locale.resolveText
factory.apply(ctx)

const language = locale.catalog.get('zh-tw')
check(language !== undefined, 'zh-TW language definition registered')
check(language?.label === '正體中文', 'language label is 正體中文 (got ' + language?.label + ')')
check(language?.fallback === 'zh', 'language falls back to zh (got ' + language?.fallback + ')')

const namespaces = [...locale.dicts.keys()]
const expectedNamespaceCount = Object.keys(expectedNamespaces).length
const expectedKeyCount = Object.values(expectedNamespaces).reduce((sum, dict) => sum + Object.keys(dict).length, 0)
check(namespaces.length === expectedNamespaceCount, `${expectedNamespaceCount} namespaces registered (got ${namespaces.length})`)
let keys = 0
let empty = 0
let nonString = 0
for (const [ns, locales] of locale.dicts) {
  const dict = locales.get('zh-tw')
  if (!dict) { failures.push('namespace without zh-TW dictionary: ' + ns); continue }
  const entries = Object.entries(dict)
  keys += entries.length
  if (entries.length === 0) empty += 1
  for (const [, value] of entries) if (typeof value !== 'string') nonString += 1
}
check(empty === 0, 'no empty dictionaries (got ' + empty + ')')
check(nonString === 0, 'all dictionary values are strings (got ' + nonString + ' non-strings)')
check(keys === expectedKeyCount, `${expectedKeyCount} keys across namespaces (got ${keys})`)

// Translation resolves in the zh-TW dictionary, then falls through.
const translate = (ns, key) => {
  const lookup = (namespace) => {
    const locales = locale.dicts.get(namespace)
    for (const id of locale.chain('zh-TW')) {
      const value = locales?.get(id.toLowerCase())?.[key]
      if (value !== undefined) return value
    }
    return undefined
  }
  return lookup(ns) ?? (ns !== 'common' ? lookup('common') : undefined) ?? key
}
check(translate('chat', 'message.stepProcess.thinking') === '正在分析請求', 'zh-TW copy translates a chat key')
check(translate('common', 'save') === '儲存', 'zh-TW copy uses Taiwan terminology for save')
check(translate('settings.models', 'modelReasoningLevel') === '等級', 'glossary replaced 檔位 with 等級')
check(translate('pet.config', 'nav') === '桌寵設定', 'installed plugin dictionary (dsh-pet pet.config) is translated (got ' + translate('pet.config', 'nav') + ')')
check(translate('pet.chat', 'tabTitle') === '桌寵對話', 'installed plugin dictionary (dsh-pet pet.chat) is translated (got ' + translate('pet.chat', 'tabTitle') + ')')
check(translate('pet.chat', 'loading') === '載入中…', 'installed plugin dictionary uses Taiwan terminology (got ' + translate('pet.chat', 'loading') + ')')
const fallback = (() => {
  const chat = locale.dicts.get('chat')
  const before = chat.get('zh-tw')
  chat.set('zh', { ...chat.get('zh'), synthetic_key: '简体回退值' })
  const resolved = translate('chat', 'synthetic_key')
  chat.set('zh-tw', before)
  return resolved
})()
check(fallback === '简体回退值', 'missing zh-TW keys fall back to zh (got ' + fallback + ')')

// The package display-text resolver is replaced while the plugin is loaded.
const patched = locale.resolveText
check(patched !== originalResolveText, 'resolveText is wrapped by the language pack')

locale.active = 'zh-TW'
const simplifiedTitle = locale.resolveText({ en: 'Timer service', zh: '计时服务' })
check(simplifiedTitle === '計時服務', 'package title map resolves to Traditional Chinese (got ' + simplifiedTitle + ')')
const englishOnly = locale.resolveText({ en: 'Only English' })
check(englishOnly === 'Only English', 'English-only package text stays verbatim (got ' + englishOnly + ')')
const ownTraditional = locale.resolveText({ en: 'X', 'zh-tw': '正體值' })
check(ownTraditional === '正體值', 'an existing zh-TW metadata entry wins untouched (got ' + ownTraditional + ')')
const plainSimplified = locale.resolveText('吃白饭的蓝色大肥鱼')
check(plainSimplified.includes('藍') && plainSimplified.includes('魚') && !plainSimplified.includes('蓝'), 'plain Simplified copy converts with the character map (got ' + plainSimplified + ')')
const plainTraditional = locale.resolveText('檔案與設定')
check(plainTraditional === '檔案與設定', 'already-Traditional plain copy is left untouched (got ' + plainTraditional + ')')
const plainEnglish = locale.resolveText('A blue fish')
check(plainEnglish === 'A blue fish', 'English plain copy is left untouched (got ' + plainEnglish + ')')

// Other active locales keep the shipped resolution.
locale.active = 'en'
check(locale.resolveText({ en: 'Settings', zh: '设置' }) === 'Settings', 'other locales use the shipped resolver')
locale.active = 'zh'
check(locale.resolveText({ en: 'Settings', zh: '设置' }) === '设置', 'Simplified Chinese users keep Simplified metadata')
locale.active = 'zh-TW'

// Unloading restores the original resolver on the prototype.
for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
check(locale.resolveText === originalResolveText, 'unload restores the original resolveText method')
check(!Object.prototype.hasOwnProperty.call(locale, 'resolveText'), 'unload removes the resolver shadow property')
locale.active = 'zh'
check(locale.resolveText({ en: 'Settings', zh: '设置' }) === '设置', 'restored resolver returns shipped Simplified metadata again')

if (failures.length !== 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`verified: ${captured.id}; ${namespaces.length} namespaces / ${keys} keys; zh-TW -> zh -> en; package display text resolver`)
