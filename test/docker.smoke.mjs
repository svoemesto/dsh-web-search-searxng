/**
 * Live smoke test: starts a real SearXNG container, searches through the
 * provider, stops and removes the container. Needs Docker and network (image
 * pull on a cold machine); the unit suite covers everything without either.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SearxngContainer, dockerRunner } from '../src/container.js'
import { SearxngSearchProvider } from '../src/provider.js'

const NAME = 'dsh-searxng-smoke'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-searxng-smoke-'))
const run = dockerRunner()

const container = new SearxngContainer({
  name: NAME,
  image: 'searxng/searxng:latest',
  port: 8899,
  dataDir,
  instanceName: 'DSH smoke test',
  startupTimeoutMs: 120_000,
  log: (level, message) => console.log(`[${level}] ${message}`),
})

const started = Date.now()
try {
  const state = await container.ensure()
  console.log(`ready in ${Date.now() - started} ms at ${state.baseURL}`)

  const provider = new SearxngSearchProvider({
    resolveBaseURL: async () => state.baseURL,
    timeoutMs: 20_000,
  })
  const result = await provider.search({ query: 'searxng json api', maxResults: 5 })
  assert.ok(result.sources.length > 0, 'expected live sources from the new container')
  assert.ok(result.sources.length <= 5)
  assert.match(result.sources[0].url, /^https?:\/\//)
  console.log(`live search ok: ${result.sources.length} sources, first: ${result.sources[0].title}`)

  await container.stop()
  console.log('container stopped')
} finally {
  await run(['rm', '-f', NAME]).catch(() => {})
  fs.rmSync(dataDir, { recursive: true, force: true })
}
