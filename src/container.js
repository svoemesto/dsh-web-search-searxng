/**
 * The SearXNG container this plugin owns: find, start, wait for health, stop.
 *
 * Every Docker call goes through an injected runner, so the unit tests exercise
 * the whole lifecycle without a daemon. `docker` is invoked as an argv list —
 * never through a shell — so config values cannot become command injection.
 *
 * @module dsh-web-search-searxng/container
 */

import { execFile, execFileSync } from 'node:child_process'
import net from 'node:net'
import { ensureSettingsFile } from './settings.js'

/** Generous ceiling for image pulls; a cold pull can take minutes. */
const DOCKER_TIMEOUT_MS = 300_000

/** SearXNG listens on 8080 inside the official image. */
const CONTAINER_PORT = 8080

/** Label that marks containers this plugin owns. */
export const CONTAINER_LABEL = 'dsh.plugin=dsh-web-search-searxng'

/**
 * Build an argv-based Docker runner.
 * @param {typeof execFile} [execFileImpl] - executable seam for tests.
 * @returns {(args: string[], options?: {timeout?: number}) => Promise<string>} runner resolving stdout.
 */
export function dockerRunner(execFileImpl = execFile) {
  return (args, options = {}) => new Promise((resolve, reject) => {
    execFileImpl('docker', args, { timeout: options.timeout ?? DOCKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`docker ${args[0]} failed: ${(stderr || error.message).trim()}`)
        failure.code = 'DOCKER_FAILED'
        failure.stdout = stdout
        failure.stderr = stderr
        reject(failure)
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

/**
 * Is a working Docker daemon reachable? Synchronous and cheap, used once at
 * activation because the provider's `available()` must not do I/O per call.
 * @returns {boolean} true when `docker version` succeeds.
 */
export function dockerAvailable() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Can a TCP port be bound on the loopback interface?
 * @param {number} port - candidate port.
 * @param {string} [host] - interface to bind.
 * @returns {Promise<boolean>} true when the port is free.
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * First free port at or above `start`, so a machine that already runs a
 * SearXNG (or anything else) on the default port still works.
 * @param {number} start - first candidate.
 * @param {{attempts?: number, host?: string, probe?: typeof isPortFree}} [options] - scan width and seams.
 * @returns {Promise<number>} the free port.
 * @throws {Error} when no candidate is free.
 */
export async function findFreePort(start, options = {}) {
  const attempts = options.attempts ?? 50
  const probe = options.probe ?? isPortFree
  for (let port = start; port < start + attempts && port <= 65535; port++) {
    if (await probe(port, options.host)) return port
  }
  throw new Error(`web-search-searxng: no free port in ${start}..${Math.min(65535, start + attempts - 1)}`)
}

/**
 * Poll the instance until its HTTP layer answers.
 * @param {string} baseURL - instance base ending in `/`.
 * @param {number} timeoutMs - readiness budget.
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, intervalMs?: number}} [options] - seams.
 * @returns {Promise<void>} resolves once the instance answers.
 * @throws {Error} when the budget runs out.
 */
export async function waitForHealth(baseURL, timeoutMs, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseURL}healthz`, { signal: AbortSignal.timeout(2_000) })
      // Any answer below 500 proves the HTTP layer is up; a 404 only means this
      // SearXNG build has no /healthz, not that it is unusable.
      if (response.status < 500) return
      lastError = new Error(`healthz answered HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`web-search-searxng: SearXNG did not become healthy within ${timeoutMs} ms${lastError === undefined ? '' : ` (${lastError.message})`}`)
}

/**
 * The container lifecycle. One instance per plugin activation.
 */
export class SearxngContainer {
  /**
   * @param {{name: string, image: string, port: number, dataDir: string, instanceName: string, startupTimeoutMs: number, run?: ReturnType<typeof dockerRunner>, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, probe?: typeof isPortFree, log?: (level: 'info' | 'warn', message: string) => void}} options - resolved config plus test seams.
   */
  constructor(options) {
    this.name = options.name
    this.image = options.image
    this.port = options.port
    this.dataDir = options.dataDir
    this.instanceName = options.instanceName
    this.startupTimeoutMs = options.startupTimeoutMs
    this.run = options.run ?? dockerRunner()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep
    this.probe = options.probe
    this.log = options.log ?? (() => {})
    this.startedByUs = false
  }

  /**
   * Read the container's state without starting anything.
   * @returns {Promise<{exists: boolean, running: boolean, managed?: boolean, port?: number}>} the state; `managed` reports our ownership label.
   */
  async inspect() {
    let stdout
    try {
      stdout = await this.run(['inspect', this.name])
    } catch (error) {
      // A missing container is a normal answer; a dead daemon is not.
      if (/no such (object|container)/i.test(String(error.message))) return { exists: false, running: false }
      throw error
    }
    const [record] = JSON.parse(stdout)
    const binding = record?.NetworkSettings?.Ports?.[`${CONTAINER_PORT}/tcp`]?.[0]
    const hostPort = binding?.HostPort === undefined ? undefined : Number(binding.HostPort)
    const managed = record?.Config?.Labels?.['dsh.plugin'] === 'dsh-web-search-searxng'
    return { exists: true, running: record?.State?.Running === true, managed, ...hostPort === undefined ? {} : { port: hostPort } }
  }

  /** @returns {Promise<boolean>} whether the image is already local. */
  async imageExists() {
    try {
      await this.run(['image', 'inspect', this.image])
      return true
    } catch {
      return false
    }
  }

  /**
   * Make sure a healthy instance answers on loopback.
   * @returns {Promise<{baseURL: string, port: number, started: boolean}>} the endpoint.
   */
  async ensure() {
    const state = await this.inspect()
    // Adopting a foreign container by name would mean starting and later
    // stopping someone else's workload: refuse and name the way out instead.
    if (state.exists && state.managed !== true) {
      throw new Error(`web-search-searxng: container "${this.name}" exists but was not created by this plugin (no ${CONTAINER_LABEL} label) — set a different containerName in config, or remove that container`)
    }
    if (state.running) {
      const port = state.port ?? this.port
      const baseURL = `http://127.0.0.1:${port}/`
      await waitForHealth(baseURL, this.startupTimeoutMs, { fetchImpl: this.fetchImpl, ...this.sleep === undefined ? {} : { sleep: this.sleep } })
      this.log('info', `searxng: reusing running container ${this.name} on ${baseURL}`)
      return { baseURL, port, started: false }
    }
    if (state.exists) {
      this.log('info', `searxng: starting existing container ${this.name}`)
      await this.run(['start', this.name])
      const port = state.port ?? this.port
      const baseURL = `http://127.0.0.1:${port}/`
      await waitForHealth(baseURL, this.startupTimeoutMs, { fetchImpl: this.fetchImpl, ...this.sleep === undefined ? {} : { sleep: this.sleep } })
      this.startedByUs = true
      return { baseURL, port, started: true }
    }

    const port = await findFreePort(this.port, { ...this.probe === undefined ? {} : { probe: this.probe } })
    const settings = ensureSettingsFile(this.dataDir, { instanceName: this.instanceName })
    if (settings.created) this.log('info', `searxng: wrote ${settings.path}`)
    if (!(await this.imageExists())) {
      this.log('info', `searxng: pulling ${this.image} (first run; this can take a few minutes)`)
      await this.run(['pull', this.image])
    }
    this.log('info', `searxng: creating container ${this.name} on 127.0.0.1:${port}`)
    await this.run([
      'run', '-d',
      '--name', this.name,
      '--restart', 'unless-stopped',
      '--label', CONTAINER_LABEL,
      '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`,
      '-v', `${settings.path}:/etc/searxng/settings.yml:ro`,
      '-e', `SEARXNG_BASE_URL=http://127.0.0.1:${port}/`,
      this.image,
    ])
    this.startedByUs = true
    const baseURL = `http://127.0.0.1:${port}/`
    await waitForHealth(baseURL, this.startupTimeoutMs, { fetchImpl: this.fetchImpl, ...this.sleep === undefined ? {} : { sleep: this.sleep } })
    return { baseURL, port, started: true }
  }

  /**
   * Stop the container (if it runs) and keep it for a fast next start. Data and
   * the generated secret stay on disk.
   * @returns {Promise<void>} resolves when the stop attempt is over.
   */
  async stop() {
    const state = await this.inspect().catch(() => undefined)
    // Only ever stop a container this plugin created: a name collision must not
    // turn plugin unload into someone else's outage.
    if (state?.running !== true || state.managed !== true) return
    try {
      await this.run(['stop', '-t', '5', this.name])
      this.log('info', `searxng: stopped container ${this.name}`)
    } catch (error) {
      this.log('warn', `searxng: could not stop ${this.name}: ${error.message}`)
    }
  }
}
