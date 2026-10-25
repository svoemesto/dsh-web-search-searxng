import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { DEFAULTS, resolveConfig } from '../src/config.js'
import { ensureSettingsFile, renderSettings } from '../src/settings.js'
import { findFreePort, isPortFree, SearxngContainer, waitForHealth } from '../src/container.js'
import { mapAnswer, mapResponse, mapResult, PROVIDER_ID, SearxngSearchProvider } from '../src/provider.js'

/** @returns {string} a fresh temporary directory */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-searxng-'))

// ── config ───────────────────────────────────────────────────────────────────

test('config: container mode by default, paths under DSH_HOME', () => {
  const options = resolveConfig(undefined, { env: { DSH_HOME: '/tmp/dsh-home' }, home: '/home/x' })
  assert.equal(options.mode, 'container')
  assert.equal(options.port, DEFAULTS.port)
  assert.equal(options.image, 'searxng/searxng:latest')
  assert.equal(options.dataDir, path.join('/tmp/dsh-home', 'searxng'))
  assert.equal(options.startupTimeoutMs, 90_000)
})

test('config: dataDir falls back to ~/.dsh when DSH_HOME is unset', () => {
  const options = resolveConfig({}, { env: {}, home: '/home/x' })
  assert.equal(options.dataDir, path.join('/home/x', '.dsh', 'searxng'))
})

test('config: baseURL switches to external mode without a trailing slash', () => {
  const options = resolveConfig({ baseURL: 'http://searx.local:8080/' })
  assert.equal(options.mode, 'external')
  assert.equal(options.baseURL, 'http://searx.local:8080')
})

test('config: every optional knob reaches the resolved object', () => {
  const options = resolveConfig({
    language: 'ru', categories: 'news', safesearch: 2, timeRange: 'week', numResults: 7, apiKey: 'k', timeoutMs: 1000,
  })
  assert.deepEqual(
    { language: options.language, categories: options.categories, safesearch: options.safesearch, timeRange: options.timeRange, numResults: options.numResults, apiKey: options.apiKey, timeoutMs: options.timeoutMs },
    { language: 'ru', categories: 'news', safesearch: 2, timeRange: 'week', numResults: 7, apiKey: 'k', timeoutMs: 1000 },
  )
})

test('config: invalid values are rejected loudly, naming the field', () => {
  const cases = [
    [{ baseURL: 'ftp://x' }, /baseURL must use http or https/],
    [{ baseURL: 'nope' }, /baseURL is not a URL/],
    [{ port: 0 }, /port must be an integer/],
    [{ port: 70_000 }, /port must be an integer/],
    [{ port: '8888' }, /port must be an integer/],
    [{ image: ' ' }, /image must be a non-empty string/],
    [{ containerName: 'bad name' }, /containerName is not a valid Docker name/],
    [{ startupTimeoutMs: 500 }, /startupTimeoutMs/],
    [{ timeoutMs: -1 }, /timeoutMs/],
    [{ numResults: 0 }, /numResults/],
    [{ safesearch: 3 }, /safesearch/],
    [{ timeRange: 'decade' }, /timeRange/],
  ]
  for (const [config, pattern] of cases) {
    assert.throws(() => resolveConfig(config), pattern, JSON.stringify(config))
  }
})

// ── settings ─────────────────────────────────────────────────────────────────

test('settings: generated YAML enables JSON, disables the limiter, carries a secret', () => {
  const yaml = renderSettings({ instanceName: 'Test', secretKey: 'secret-value' })
  assert.match(yaml, /use_default_settings: true/)
  assert.match(yaml, /limiter: false/)
  assert.match(yaml, /- json/)
  assert.match(yaml, /secret_key: "secret-value"/)
  assert.match(yaml, /instance_name: "Test"/)
})

test('settings: written once, never rewritten', () => {
  const dir = tmp()
  const first = ensureSettingsFile(dir, { instanceName: 'One' })
  assert.equal(first.created, true)
  const body = fs.readFileSync(first.path, 'utf8')
  const second = ensureSettingsFile(dir, { instanceName: 'Two' })
  assert.equal(second.created, false)
  assert.equal(second.path, first.path)
  assert.equal(fs.readFileSync(first.path, 'utf8'), body)
  assert.match(body, /instance_name: "One"/)
})

// ── container: pieces ────────────────────────────────────────────────────────

test('port scan: skips busy ports and returns the first free one', async () => {
  const asked = []
  const port = await findFreePort(8888, {
    attempts: 5,
    probe: async candidate => {
      asked.push(candidate)
      return candidate >= 8892
    },
  })
  assert.equal(port, 8892)
  assert.deepEqual(asked, [8888, 8889, 8890, 8891, 8892])
})

test('port scan: fails clearly when the whole range is busy', async () => {
  await assert.rejects(() => findFreePort(8888, { attempts: 3, probe: async () => false }), /no free port in 8888..8890/)
})

test('port probe: a bound port is not free, a released one is', async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const { port } = server.address()
  assert.equal(await isPortFree(port), false)
  await new Promise(resolve => server.close(resolve))
  assert.equal(await isPortFree(port), true)
})

test('health wait: retries until the instance answers', async () => {
  let calls = 0
  await waitForHealth('http://127.0.0.1:1/', 5_000, {
    fetchImpl: async () => {
      calls++
      return { status: calls < 3 ? 503 : 200 }
    },
    sleep: async () => {},
  })
  assert.equal(calls, 3)
})

test('health wait: a 404 still proves the HTTP layer is up', async () => {
  await waitForHealth('http://127.0.0.1:1/', 5_000, {
    fetchImpl: async () => ({ status: 404 }),
    sleep: async () => {},
  })
})

test('health wait: fails with the budget in the message', async () => {
  await assert.rejects(
    () => waitForHealth('http://127.0.0.1:1/', 40, {
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      sleep: async () => {},
    }),
    /did not become healthy within 40 ms \(ECONNREFUSED\)/,
  )
})

// ── container: lifecycle with a fake docker ──────────────────────────────────

/**
 * Build a container over a scripted docker runner.
 * @param {{inspect?: () => Promise<string>, image?: () => Promise<string>, extra?: (args: string[]) => Promise<string> | undefined}} script - per-call behaviour.
 * @returns {{container: SearxngContainer, calls: string[][]}} container plus recorded argv lists.
 */
function bench(script) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const extra = script.extra?.(args)
    if (extra !== undefined) return extra
    if (args[0] === 'inspect') return script.inspect()
    if (args[0] === 'image') return script.image?.() ?? (() => { throw new Error('no such image') })()
    return ''
  }
  const container = new SearxngContainer({
    name: 'dsh-searxng-test',
    image: 'searxng/searxng:latest',
    port: 8888,
    dataDir: script.dataDir ?? tmp(),
    instanceName: 'Test',
    startupTimeoutMs: 5_000,
    run,
    fetchImpl: async () => ({ status: 200 }),
    sleep: async () => {},
    probe: async candidate => candidate === 8892,
    log: () => {},
  })
  return { container, calls }
}

test('container: creates, pulls, publishes on the free port, reports the endpoint', async () => {
  const dataDir = tmp()
  const { container, calls } = bench({
    inspect: async () => { throw new Error('Error: No such object: dsh-searxng-test') },
    dataDir,
  })
  const state = await container.ensure()
  assert.deepEqual(state, { baseURL: 'http://127.0.0.1:8892/', port: 8892, started: true })
  const verbs = calls.map(args => args[0])
  assert.deepEqual(verbs, ['inspect', 'image', 'pull', 'run'])
  const runArgs = calls.at(-1)
  assert.ok(runArgs.includes('--restart'))
  assert.ok(runArgs.includes('127.0.0.1:8892:8080'))
  assert.ok(runArgs.includes(`${path.join(dataDir, 'settings.yml')}:/etc/searxng/settings.yml:ro`))
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.yml')))
})

test('container: reuses a running container and starts a stopped one', async () => {
  const running = JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '8893' }] } } }])
  const reused = bench({ inspect: async () => running })
  assert.deepEqual(await reused.container.ensure(), { baseURL: 'http://127.0.0.1:8893/', port: 8893, started: false })
  assert.deepEqual(reused.calls.map(args => args[0]), ['inspect'])

  const stopped = JSON.stringify([{ State: { Running: false }, NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '8894' }] } } }])
  const started = bench({ inspect: async () => stopped })
  assert.deepEqual(await started.container.ensure(), { baseURL: 'http://127.0.0.1:8894/', port: 8894, started: true })
  assert.deepEqual(started.calls.map(args => args[0]), ['inspect', 'start'])
})

test('container: stop only stops a running container', async () => {
  const running = JSON.stringify([{ State: { Running: true }, NetworkSettings: {} }])
  const live = bench({ inspect: async () => running })
  await live.container.stop()
  assert.deepEqual(live.calls.map(args => args[0]), ['inspect', 'stop'])

  const absent = bench({ inspect: async () => { throw new Error('No such object: x') } })
  await absent.container.stop()
  assert.deepEqual(absent.calls.map(args => args[0]), ['inspect'])
})

test('container: inspect tolerates a missing port binding', async () => {
  const { container } = bench({ inspect: async () => JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: {} } }]) })
  assert.deepEqual(await container.inspect(), { exists: true, running: true })
})

// ── provider ─────────────────────────────────────────────────────────────────

test('mapping: only citeable entries survive, snippets are trimmed and capped', () => {
  assert.equal(mapResult({ url: 'javascript:alert(1)' }), undefined)
  assert.equal(mapResult({ title: 'no url' }), undefined)
  assert.deepEqual(mapResult({ url: ' https://a.example/x ', title: ' T ', content: '  ' }), { url: 'https://a.example/x', title: 'T' })
  assert.equal(mapResult({ url: 'https://a.example/x', content: 'x'.repeat(900) }).snippet.length, 801)
  assert.deepEqual(mapResult({ url: 'https://a.example/x', publishedDate: '2026-01-02' }), { url: 'https://a.example/x', publishedAt: '2026-01-02' })
  assert.equal(mapAnswer([{ answer: ' 42 ' }]), '42')
  assert.equal(mapAnswer(['', 'second']), 'second')
  assert.equal(mapAnswer(undefined), undefined)
})

test('mapping: a body without results is a provider error', () => {
  assert.throws(() => mapResponse(null), /non-object/)
  assert.throws(() => mapResponse({ answers: [] }), /no results array/)
})

test('provider: search builds the JSON request and maps the answer', async () => {
  const originalFetch = globalThis.fetch
  let requested
  globalThis.fetch = async (url) => {
    requested = new URL(String(url))
    return { ok: true, status: 200, json: async () => ({ answers: [{ answer: 'answer text' }], results: [{ url: 'https://a.example/1', title: 'One', content: 'snippet' }] }) }
  }
  try {
    const provider = new SearxngSearchProvider({
      resolveBaseURL: async () => 'http://127.0.0.1:8892',
      timeoutMs: 5_000,
      language: 'ru',
      numResults: 5,
    })
    assert.equal(provider.id, PROVIDER_ID)
    assert.equal(provider.available(), true)
    const result = await provider.search({ query: 'hello world', maxResults: 3 })
    assert.equal(requested.pathname, '/search')
    assert.equal(requested.searchParams.get('q'), 'hello world')
    assert.equal(requested.searchParams.get('format'), 'json')
    assert.equal(requested.searchParams.get('language'), 'ru')
    assert.equal(result.content, 'answer text')
    assert.deepEqual(result.sources, [{ url: 'https://a.example/1', title: 'One', snippet: 'snippet' }])
    assert.equal(result.truncated, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider: HTTP and empty-result failures carry the seam codes', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) })
    const http = new SearxngSearchProvider({ resolveBaseURL: async () => 'http://127.0.0.1:8892', timeoutMs: 5_000 })
    await assert.rejects(() => http.search({ query: 'x' }), error => error.code === 'WEB_PROVIDER_ERROR' && /HTTP 502/.test(error.message))

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [], unresponsive_engines: [['google', 'access denied']] }) })
    const empty = new SearxngSearchProvider({ resolveBaseURL: async () => 'http://127.0.0.1:8892', timeoutMs: 5_000 })
    await assert.rejects(() => empty.search({ query: 'x' }), error => /google: access denied/.test(error.message))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider: caller cancellation is WEB_ABORTED, a dead instance is not ready', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
    const controller = new AbortController()
    controller.abort()
    const provider = new SearxngSearchProvider({ resolveBaseURL: async () => 'http://127.0.0.1:8892', timeoutMs: 5_000 })
    await assert.rejects(() => provider.search({ query: 'x' }, controller.signal), error => error.code === 'WEB_ABORTED')
  } finally {
    globalThis.fetch = originalFetch
  }

  const dead = new SearxngSearchProvider({
    resolveBaseURL: async () => { throw new Error('docker is not available on this machine') },
    timeoutMs: 5_000,
  })
  await assert.rejects(() => dead.search({ query: 'x' }), error => error.code === 'WEB_PROVIDER_ERROR' && /not ready: docker is not available/.test(error.message))
})

// ── plugin wiring ────────────────────────────────────────────────────────────

test('apply: external mode registers the provider and releases it on dispose', async () => {
  let registered
  let disposed = false
  const disposers = []
  const ctx = {
    web: { registerSearchProvider: provider => { registered = provider; return () => { disposed = true } } },
    effect: executor => {
      const step = executor().next()
      if (!step.done) disposers.push(step.value)
    },
  }
  apply(ctx, { baseURL: 'http://127.0.0.1:8892' })
  assert.equal(registered.id, PROVIDER_ID)
  assert.equal(typeof registered.search, 'function')
  assert.equal(disposers.length, 1)
  await disposers[0]()
  assert.equal(disposed, true)
})
