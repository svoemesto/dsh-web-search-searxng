/**
 * `SearxngSearchProvider`: a `WebSearchProvider` over a SearXNG instance's JSON
 * API. The base URL may be resolved asynchronously, because in container mode
 * it is only known once the instance is healthy.
 *
 * Two behaviours go beyond a plain adapter, both learned from the Karaoke
 * project's lyrics search, where a single dead engine used to look like "no
 * results":
 *
 * - **A second pass when the first one comes back empty because engines
 *   failed.** SearXNG answers 200 with zero results and an `unresponsive_engines`
 *   list; the retry either asks the configured `fallbackEngines` or repeats the
 *   query without the narrowing filters (`language`, `categories`, `time_range`)
 *   that can zero out an otherwise answerable query. Transient transport
 *   failures (network, 429, 5xx, per-attempt timeout) are retried too.
 * - **A short TTL cache.** Repeating an identical query within `cacheTtlMs`
 *   costs nothing, which matters because the model re-issues searches.
 *
 * @module dsh-web-search-searxng/provider
 */

import { TtlCache } from './cache.js'

/** Stable id this provider registers under (the bundle patch pins it). */
export const PROVIDER_ID = 'searxng'

/** No snippet longer than this: one result must not crowd out its neighbours. */
const MAX_SNIPPET_CHARS = 800

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-searxng/2.1.0'

/**
 * Build a provider failure carrying the seam's machine-routable `code`.
 * `WebError` is not importable here (no dependency edge), so its shape is
 * reproduced: a plain `Error` with `name` and `code`.
 * @param {string} message - what went wrong, phrased for the operator.
 * @param {string} code - `WEB_PROVIDER_ERROR` or `WEB_ABORTED`.
 * @param {unknown} [cause] - the underlying failure.
 * @returns {Error} the error to throw.
 */
export function webError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = 'WebError'
  error.code = code
  return error
}

/**
 * Map one SearXNG `results[]` entry to a citeable source. An entry without a
 * parseable http(s) URL cannot be cited and is dropped; a blank snippet is
 * omitted rather than invented.
 * @param {unknown} entry - one element of the JSON response's `results`.
 * @returns {{url: string, title?: string, snippet?: string, publishedAt?: string} | undefined} the source, or `undefined` when unusable.
 */
export function mapResult(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (entry)
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  if (url.length === 0) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  } catch {
    return undefined
  }
  const title = typeof record.title === 'string' && record.title.trim().length > 0
    ? record.title.trim()
    : undefined
  const rawSnippet = typeof record.content === 'string' ? record.content.trim() : ''
  const snippet = rawSnippet.length > 0
    ? rawSnippet.length > MAX_SNIPPET_CHARS ? `${rawSnippet.slice(0, MAX_SNIPPET_CHARS)}…` : rawSnippet
    : undefined
  const publishedAt = typeof record.publishedDate === 'string' && record.publishedDate.trim().length > 0
    ? record.publishedDate.trim()
    : undefined
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Extract SearXNG's engine-provided answer, when one exists. This is real
 * engine output (Wikipedia, Wikidata, …), never prose composed here.
 * @param {unknown} answers - the response's `answers` array.
 * @returns {string | undefined} the first non-blank answer.
 */
export function mapAnswer(answers) {
  if (!Array.isArray(answers)) return undefined
  for (const entry of answers) {
    const text = typeof entry === 'string'
      ? entry
      : entry !== null && typeof entry === 'object' && typeof (/** @type {Record<string, unknown>} */ (entry)).answer === 'string'
        ? /** @type {string} */ (entry.answer)
        : ''
    if (text.trim().length > 0) return text.trim()
  }
  return undefined
}

/**
 * Map a SearXNG JSON envelope to the seam's normalized result.
 * @param {unknown} payload - the parsed response body.
 * @returns {{content?: string, sources: Array<object>, truncated: false}} the normalized result.
 * @throws {Error} when the body is not a SearXNG search envelope.
 */
export function mapResponse(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw webError('SearXNG returned a non-object response body', 'WEB_PROVIDER_ERROR')
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  if (!Array.isArray(record.results)) {
    throw webError('SearXNG response carries no results array', 'WEB_PROVIDER_ERROR')
  }
  const sources = record.results.map(mapResult).filter(source => source !== undefined)
  const content = mapAnswer(record.answers)
  // The web service owns the final maxResults truncation, so this provider
  // reports truncated: false.
  return { ...content !== undefined ? { content } : {}, sources, truncated: false }
}

/**
 * Render the `unresponsive_engines` detail as a readable sentence.
 * @param {unknown} unresponsive - the response's `unresponsive_engines` value.
 * @returns {string} e.g. `google: access denied; yandex: parsing error`.
 */
export function describeUnresponsive(unresponsive) {
  if (!Array.isArray(unresponsive)) return ''
  return unresponsive
    .map(entry => Array.isArray(entry) ? `${String(entry[0])}: ${String(entry[1])}` : String(entry))
    .join('; ')
}

/**
 * Build the attempt plan: the full request first, then broadening passes.
 * A configured `fallbackEngines` list wins over dropping filters, because the
 * operator knows which engines their instance can actually run.
 * @param {{retries: number, fallbackEngines: readonly string[]}} options - retry budget and engine list.
 * @returns {ReadonlyArray<{engines?: readonly string[], dropFilters?: true}>} one descriptor per attempt.
 */
export function attemptPlan(options) {
  /** @type {Array<{engines?: readonly string[], dropFilters?: true}>} */
  const plan = [{}]
  const broadening = options.fallbackEngines.length > 0
    ? { engines: options.fallbackEngines }
    : { dropFilters: true }
  for (let index = 0; index < options.retries; index++) plan.push(broadening)
  return plan
}

/**
 * Stable cache key for one logical search.
 * @param {string} base - endpoint base.
 * @param {string} query - caller query.
 * @param {number | undefined} bound - effective result bound.
 * @param {{language?: string, categories?: string, safesearch?: number, timeRange?: string, fallbackEngines: readonly string[]}} options - parameters that change results.
 * @returns {string} the key.
 */
function cacheKey(base, query, bound, options) {
  return [
    base,
    query,
    bound ?? '',
    options.language ?? '',
    options.categories ?? '',
    options.safesearch ?? '',
    options.timeRange ?? '',
    options.fallbackEngines.join(','),
  ].join('\u0000')
}

/** The SearXNG-backed search provider. */
export class SearxngSearchProvider {
  /**
   * @param {{resolveBaseURL: () => Promise<string> | string, timeoutMs: number, language?: string, categories?: string, safesearch?: number, timeRange?: string, numResults?: number, apiKey?: string, retries?: number, retryDelayMs?: number, fallbackEngines?: readonly string[], cacheTtlMs?: number, cacheMaxEntries?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} options - resolved config plus the lazy base-URL resolver and test seams.
   */
  constructor(options) {
    this.id = PROVIDER_ID
    this.options = {
      retries: 1,
      retryDelayMs: 300,
      fallbackEngines: [],
      cacheTtlMs: 60_000,
      cacheMaxEntries: 200,
      ...options,
    }
    /** Last resolved endpoint, reused while it keeps working. */
    this.resolvedBase = undefined
    this.cache = new TtlCache({
      ttlMs: this.options.cacheTtlMs,
      maxEntries: this.options.cacheMaxEntries,
      ...this.options.now === undefined ? {} : { now: this.options.now },
    })
    this.sleep = this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /**
   * Cheap local check that never touches the network. It stays `true` even
   * before the container is healthy on purpose: the seam's
   * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` carries no hint, while a failed
   * search here names the real cause ("docker is not available…", "did not
   * become healthy…"), which is what the operator needs.
   * @returns {boolean} always true.
   */
  available() {
    return true
  }

  /**
   * Resolve the endpoint, memoized after the first success.
   * @returns {Promise<string>} base URL with a trailing slash.
   */
  async baseURL() {
    if (this.resolvedBase !== undefined) return this.resolvedBase
    let base
    try {
      base = await this.options.resolveBaseURL()
    } catch (error) {
      throw webError(`SearXNG instance is not ready: ${String(error instanceof Error ? error.message : error)}`, 'WEB_PROVIDER_ERROR', error)
    }
    this.resolvedBase = base.endsWith('/') ? base : `${base}/`
    return this.resolvedBase
  }

  /**
   * Run one search: cache first, then the attempt plan.
   * @param {{query: string, maxResults?: number}} request - the query and optional bound.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{content?: string, sources: Array<object>, truncated: boolean}>} normalized results.
   */
  async search(request, signal) {
    const base = await this.baseURL()
    const bound = request.maxResults ?? this.options.numResults
    const key = cacheKey(base, request.query, bound, this.options)

    const cached = this.cache.get(key)
    if (cached !== undefined) return /** @type {{content?: string, sources: Array<object>, truncated: boolean}} */ (cached)

    const plan = attemptPlan(this.options)
    /** @type {{ok: false, error: Error} | undefined} */
    let lastFailure
    for (const [index, attempt] of plan.entries()) {
      if (index > 0) await this.sleep(this.options.retryDelayMs)
      const outcome = await this.attempt(base, request, attempt, signal, bound)
      if (outcome.ok) {
        this.cache.set(key, outcome.result)
        return outcome.result
      }
      lastFailure = outcome
      if (!outcome.retryable) throw outcome.error
    }
    throw lastFailure === undefined
      ? webError('SearXNG search failed without an attempt', 'WEB_PROVIDER_ERROR')
      : lastFailure.error
  }

  /**
   * One HTTP attempt with one parameter shape.
   * @param {string} base - endpoint base with a trailing slash.
   * @param {{query: string, maxResults?: number}} request - the caller's request.
   * @param {{engines?: readonly string[], dropFilters?: true}} attempt - parameter overrides for this pass.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @param {number | undefined} bound - result bound after mapping.
   * @returns {Promise<{ok: true, result: {content?: string, sources: Array<object>, truncated: boolean}} | {ok: false, error: Error, retryable: boolean}>} the attempt outcome.
   */
  async attempt(base, request, attempt, signal, bound) {
    const options = this.options
    const endpoint = new URL('search', base)
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'json')
    if (attempt.dropFilters !== true) {
      if (options.language !== undefined) endpoint.searchParams.set('language', options.language)
      if (options.categories !== undefined) endpoint.searchParams.set('categories', options.categories)
      if (options.timeRange !== undefined) endpoint.searchParams.set('time_range', options.timeRange)
    }
    if (options.safesearch !== undefined) endpoint.searchParams.set('safesearch', String(options.safesearch))
    if (options.apiKey !== undefined) endpoint.searchParams.set('preference[api_key]', options.apiKey)
    if (attempt.engines !== undefined && attempt.engines.length > 0) endpoint.searchParams.set('engines', attempt.engines.join(','))

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])

    let response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: requestSignal,
      })
    } catch (error) {
      if (signal !== undefined && signal.aborted) {
        return { ok: false, retryable: false, error: webError('SearXNG search aborted', 'WEB_ABORTED', error) }
      }
      if (timeoutSignal.aborted) {
        return { ok: false, retryable: true, error: webError(`SearXNG search timed out after ${options.timeoutMs} ms`, 'WEB_PROVIDER_ERROR', error) }
      }
      return { ok: false, retryable: true, error: webError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error) }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return { ok: false, retryable, error: webError(`SearXNG API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR') }
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (signal !== undefined && signal.aborted) {
        return { ok: false, retryable: false, error: webError('SearXNG search aborted', 'WEB_ABORTED', error) }
      }
      return { ok: false, retryable: false, error: webError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', error) }
    }

    let result
    try {
      result = mapResponse(payload)
    } catch (error) {
      return { ok: false, retryable: false, error: /** @type {Error} */ (error) }
    }

    const record = /** @type {Record<string, unknown>} */ (payload)
    const unresponsive = Array.isArray(record.unresponsive_engines) ? record.unresponsive_engines : []
    if (result.sources.length === 0 && unresponsive.length > 0) {
      return {
        ok: false,
        retryable: true,
        error: webError(`SearXNG returned no results and reported unresponsive engines — ${describeUnresponsive(unresponsive)}`, 'WEB_PROVIDER_ERROR'),
      }
    }

    const sources = bound !== undefined && result.sources.length > bound
      ? result.sources.slice(0, bound)
      : result.sources
    return { ok: true, result: { ...result.content !== undefined ? { content: result.content } : {}, sources, truncated: false } }
  }
}
