/**
 * Configuration for the universal SearXNG search provider.
 *
 * Two modes, decided by config alone:
 * - `baseURL` set  → use an existing instance (nothing is started);
 * - `baseURL` unset → this plugin runs its own container on a free local port.
 *
 * Plain ESM, no dependencies: the package is installed by path link, so only
 * Node built-ins are available.
 *
 * @module dsh-web-search-searxng/config
 */

import os from 'node:os'
import path from 'node:path'

/** Defaults for container mode. */
export const DEFAULTS = {
  /** First port to try; a busy port moves the container up the range. */
  port: 8888,
  /** Official image; any compatible SearXNG image works. */
  image: 'searxng/searxng:latest',
  /** Container name this plugin owns. */
  containerName: 'dsh-searxng',
  /** Shown in the instance's own UI. */
  instanceName: 'DSH web search',
  /** Per-search budget (ms). */
  timeoutMs: 20_000,
  /** How long to wait for the container to answer `/healthz` (ms). */
  startupTimeoutMs: 90_000,
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/**
 * Parse a configured endpoint base.
 * @param {unknown} value - the configured value.
 * @param {string} field - config field name for the error message.
 * @returns {string} the URL without a trailing slash.
 * @throws {Error} when the value is not an absolute http(s) URL.
 */
export function parseHttpUrl(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`web-search-searxng: ${field} must be a non-empty http(s) URL`)
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`web-search-searxng: ${field} is not a URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`web-search-searxng: ${field} must use http or https, got ${url.protocol}`)
  }
  return url.href.replace(/\/+$/, '')
}

/** Validate an optional non-empty string; `undefined`/`null` stay absent. */
function optionalString(field, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`web-search-searxng: ${field} must be a non-empty string when set`)
  }
  return value.trim()
}

/**
 * Resolve and validate the plugin config. Validation is loud: a typo stops
 * activation with a message naming the field instead of degrading silently.
 *
 * @param {Record<string, unknown> | undefined} config - the loader row's config.
 * @param {{env?: Record<string, string | undefined>, home?: string}} [options] - environment seams for tests.
 * @returns {Readonly<Record<string, any>>} resolved options, including `mode`.
 */
export function resolveConfig(config, options = {}) {
  const raw = config ?? {}
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()

  const external = raw.baseURL === undefined || raw.baseURL === null || raw.baseURL === ''
    ? undefined
    : parseHttpUrl(raw.baseURL, 'baseURL')

  const port = raw.port ?? DEFAULTS.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('web-search-searxng: port must be an integer from 1 to 65535')
  }

  const image = optionalString('image', raw.image) ?? DEFAULTS.image
  const containerName = optionalString('containerName', raw.containerName) ?? DEFAULTS.containerName
  if (!CONTAINER_NAME_RE.test(containerName)) {
    throw new Error(`web-search-searxng: containerName is not a valid Docker name: ${JSON.stringify(containerName)}`)
  }

  const instanceName = optionalString('instanceName', raw.instanceName) ?? DEFAULTS.instanceName
  const dataDir = optionalString('dataDir', raw.dataDir)
    ?? path.join(env.DSH_HOME ?? path.join(home, '.dsh'), 'searxng')

  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('web-search-searxng: timeoutMs must be a positive integer')
  }

  const startupTimeoutMs = raw.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 600_000) {
    throw new Error('web-search-searxng: startupTimeoutMs must be an integer from 1000 to 600000')
  }

  const numResults = raw.numResults
  if (numResults !== undefined && (!Number.isInteger(numResults) || numResults < 1)) {
    throw new Error('web-search-searxng: numResults must be a positive integer when set')
  }

  const safesearch = raw.safesearch
  if (safesearch !== undefined && (!Number.isInteger(safesearch) || safesearch < 0 || safesearch > 2)) {
    throw new Error('web-search-searxng: safesearch must be 0, 1, or 2 when set')
  }

  const timeRange = optionalString('timeRange', raw.timeRange)
  if (timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(timeRange)) {
    throw new Error('web-search-searxng: timeRange must be day, week, month, or year when set')
  }

  return Object.freeze({
    mode: external === undefined ? 'container' : 'external',
    ...external !== undefined ? { baseURL: external } : {},
    port,
    image,
    containerName,
    instanceName,
    dataDir,
    timeoutMs,
    startupTimeoutMs,
    ...optionalString('language', raw.language) !== undefined ? { language: optionalString('language', raw.language) } : {},
    ...optionalString('categories', raw.categories) !== undefined ? { categories: optionalString('categories', raw.categories) } : {},
    ...safesearch !== undefined ? { safesearch } : {},
    ...timeRange !== undefined ? { timeRange } : {},
    ...numResults !== undefined ? { numResults } : {},
    ...optionalString('apiKey', raw.apiKey) !== undefined ? { apiKey: optionalString('apiKey', raw.apiKey) } : {},
  })
}
