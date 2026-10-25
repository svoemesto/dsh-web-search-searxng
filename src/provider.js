/**
 * `SearxngSearchProvider`: a `WebSearchProvider` over a SearXNG instance's JSON
 * API. The base URL may be resolved asynchronously, because in container mode
 * it is only known once the instance is healthy.
 *
 * @module dsh-web-search-searxng/provider
 */

/** Stable id this provider registers under (the bundle patch pins it). */
export const PROVIDER_ID = 'searxng'

/** No snippet longer than this: one result must not crowd out its neighbours. */
const MAX_SNIPPET_CHARS = 800

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-searxng/2.0.0'

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

/** True for an abort raised by the caller or by a timeout signal. */
function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
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

/** The SearXNG-backed search provider. */
export class SearxngSearchProvider {
  /**
   * @param {{resolveBaseURL: () => Promise<string> | string, timeoutMs: number, language?: string, categories?: string, safesearch?: number, timeRange?: string, numResults?: number, apiKey?: string}} options - resolved config plus the lazy base-URL resolver.
   */
  constructor(options) {
    this.id = PROVIDER_ID
    this.options = options
    /** Last resolved endpoint, reused while it keeps working. */
    this.resolvedBase = undefined
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
   * Run one search against the instance's JSON API.
   * @param {{query: string, maxResults?: number}} request - the query and optional bound.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{content?: string, sources: Array<object>, truncated: boolean}>} normalized results.
   */
  async search(request, signal) {
    const options = this.options
    const base = await this.baseURL()
    const endpoint = new URL('search', base)
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('format', 'json')
    if (options.language !== undefined) endpoint.searchParams.set('language', options.language)
    if (options.categories !== undefined) endpoint.searchParams.set('categories', options.categories)
    if (options.safesearch !== undefined) endpoint.searchParams.set('safesearch', String(options.safesearch))
    if (options.timeRange !== undefined) endpoint.searchParams.set('time_range', options.timeRange)
    if (options.apiKey !== undefined) endpoint.searchParams.set('preference[api_key]', options.apiKey)

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
      if (isAbortError(error) && signal !== undefined && signal.aborted) {
        throw webError('SearXNG search aborted', 'WEB_ABORTED', error)
      }
      if (isAbortError(error) && timeoutSignal.aborted) {
        throw webError(`SearXNG search timed out after ${options.timeoutMs} ms`, 'WEB_PROVIDER_ERROR', error)
      }
      throw webError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
    }

    if (!response.ok) {
      throw webError(`SearXNG API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (isAbortError(error) && signal !== undefined && signal.aborted) {
        throw webError('SearXNG search aborted', 'WEB_ABORTED', error)
      }
      throw webError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
    }

    const result = mapResponse(payload)
    const record = /** @type {Record<string, unknown>} */ (payload)
    const unresponsive = Array.isArray(record.unresponsive_engines) ? record.unresponsive_engines : []
    if (result.sources.length === 0 && unresponsive.length > 0) {
      const detail = unresponsive
        .map(entry => Array.isArray(entry) ? `${String(entry[0])}: ${String(entry[1])}` : String(entry))
        .join('; ')
      throw webError(`SearXNG returned no results and reported unresponsive engines — ${detail}`, 'WEB_PROVIDER_ERROR')
    }

    const bound = request.maxResults ?? options.numResults
    const sources = bound !== undefined && result.sources.length > bound
      ? result.sources.slice(0, bound)
      : result.sources
    return { ...result.content !== undefined ? { content: result.content } : {}, sources, truncated: false }
  }
}
