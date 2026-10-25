/**
 * Universal SearXNG search provider for the DeepSeek Harness web seam
 * (`ctx.web`). Installing this bundle is enough for the model-facing
 * `web_search` tool to search: unless `baseURL` points at an existing instance,
 * the plugin runs its own `searxng/searxng` container on a free loopback port,
 * generates the instance settings (JSON API on, limiter off), waits for health,
 * and stops the container when the plugin unloads.
 *
 * Self-contained: the profile links this package by path, so it uses only Node
 * built-ins and the platform `fetch`.
 *
 * @module dsh-web-search-searxng
 */

import { resolveConfig } from './src/config.js'
import { dockerAvailable, SearxngContainer } from './src/container.js'
import { SearxngSearchProvider } from './src/provider.js'

export { resolveConfig, DEFAULTS } from './src/config.js'
export { CONTAINER_LABEL, SearxngContainer, dockerAvailable, findFreePort, isPortFree, waitForHealth } from './src/container.js'
export { ensureSettingsFile, renderSettings } from './src/settings.js'
export { TtlCache } from './src/cache.js'
export {
  attemptPlan, describeUnresponsive, mapAnswer, mapResult, mapResponse, PROVIDER_ID, SearxngSearchProvider, webError,
} from './src/provider.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * A docker failure must reach the operator as a sentence, not a stack trace:
 * the plugin row stays active and the first search explains what to fix.
 * @param {string} message - actionable description.
 * @returns {Error} the failure a search will surface.
 */
function notReady(message) {
  const error = new Error(message)
  error.code = 'SEARXNG_NOT_READY'
  return error
}

/**
 * Register the provider and own the container's lifecycle.
 * @param {{web: {registerSearchProvider: (provider: SearxngSearchProvider) => () => void}, effect?: Function, logger?: {info?: Function, warn?: Function}}} ctx - plugin context.
 * @param {Record<string, unknown> | undefined} config - the loader row's config.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[web-search-searxng] ${message}`)
    } catch {
      // Logging must never break activation.
    }
  }

  /** @type {SearxngContainer | undefined} */
  let container
  /** @type {Promise<{baseURL: string, port: number, started: boolean}> | undefined} */
  let ready
  /** @type {() => Promise<string>} */
  let resolveBaseURL

  if (options.mode === 'external') {
    log('info', `using the existing SearXNG instance at ${options.baseURL} (no container is started)`)
    resolveBaseURL = async () => options.baseURL
  } else {
    container = new SearxngContainer({
      name: options.containerName,
      image: options.image,
      port: options.port,
      dataDir: options.dataDir,
      instanceName: options.instanceName,
      startupTimeoutMs: options.startupTimeoutMs,
      log,
    })
    const start = () => {
      const pending = dockerAvailable()
        ? container.ensure()
        : Promise.reject(notReady('docker is not available on this machine — install Docker, or set baseURL to an existing SearXNG instance'))
      // Attach a handler now: the first search may not await this promise for
      // minutes, and an unobserved rejection would be reported as a crash.
      pending.catch(() => {})
      return pending
    }
    ready = start()
    ready.then(state => log('info', `ready at ${state.baseURL}`)).catch(error => log('warn', error.message))
    resolveBaseURL = async () => {
      try {
        return (await ready).baseURL
      } catch (error) {
        // A transient failure (daemon restart, port taken in the meantime) must
        // not poison the plugin for the rest of the session: the next search
        // starts a fresh attempt.
        ready = start()
        throw error
      }
    }
  }

  const provider = new SearxngSearchProvider({ resolveBaseURL, ...options })

  const register = () => ctx.web.registerSearchProvider(provider)
  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      const dispose = register()
      yield async () => {
        dispose()
        if (container !== undefined) await container.stop()
      }
    }, 'web-search-searxng')
  } else {
    register()
  }
}
