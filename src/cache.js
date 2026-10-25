/**
 * Small TTL cache for search results.
 *
 * Agents repeat the same query more often than one expects (retries, several
 * sessions, re-reading a page), and SearXNG pays for every miss with a round of
 * upstream engine requests. The cache is process-local and deliberately dumb:
 * a Map with expiry and a size cap, no persistence, no background eviction.
 *
 * @module dsh-web-search-searxng/cache
 */

/**
 * Entries older than `ttlMs` are misses; a full cache evicts its oldest entry
 * (insertion order), which is enough for the small working set of one host.
 */
export class TtlCache {
  /**
   * @param {{ttlMs: number, maxEntries: number, now?: () => number}} options - lifetime, capacity, clock seam.
   */
  constructor(options) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries
    this.now = options.now ?? Date.now
    /** @type {Map<string, {value: unknown, expires: number}>} */
    this.entries = new Map()
  }

  /**
   * Read a live entry and refresh its recency.
   * @param {string} key - cache key.
   * @returns {unknown | undefined} the cached value, or `undefined` on a miss.
   */
  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() >= entry.expires) {
      this.entries.delete(key)
      return undefined
    }
    // Re-insert so eviction drops the least recently used entry, not the oldest written.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /**
   * Store a value until it expires.
   * @param {string} key - cache key.
   * @param {unknown} value - value to keep.
   * @returns {void}
   */
  set(key, value) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return
    this.entries.delete(key)
    this.entries.set(key, { value, expires: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** @returns {number} number of live entries */
  get size() {
    return this.entries.size
  }
}
