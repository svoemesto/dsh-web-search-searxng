# dsh-web-search-searxng

[![ci](https://github.com/svoemesto/dsh-web-search-searxng/actions/workflows/ci.yml/badge.svg)](https://github.com/svoemesto/dsh-web-search-searxng/actions/workflows/ci.yml)
[Русский](README.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
gives the agent a working `web_search` without a vendor API key. It plugs a
SearXNG-backed `WebSearchProvider` into the harness web seam (`ctx.web`) and, by
default, **brings up its own SearXNG container** — so installing the bundle is
the whole setup.

- Plain ESM, no dependencies, no build step.
- Own container (`searxng/searxng` image) on a free loopback port, generated
  settings, health wait, stop on unload — or point it at an instance you
  already run with one config field.
- No key, no per-search cost, no third-party API in the loop.
- Provider id `searxng`; the model-facing `web_search` tool is the stock one.

## Requirements

| Requirement | Why |
|---|---|
| Docker daemon reachable by the user running `dsh` (`docker version`) | the plugin runs and stops the container itself |
| ~400 MB disk, network for the first run | one-time image pull |
| Node 22+ (the harness already requires it) | `fetch`, `AbortSignal.timeout` |

No Docker? Set `baseURL` to an existing SearXNG instance instead — then nothing
is started (see [Reuse an existing instance](#reuse-an-existing-instance)).

## Install

The package declares `dsh.bundle`, so installing it also activates it:

```bash
# from GitHub (the supported channel)
dsh plugin --profile web add github:svoemesto/dsh-web-search-searxng

# from a local checkout (development)
dsh plugin --profile web add /path/to/dsh-web-search-searxng
```

Inside a running harness the same install is `plugin_manager` →
`install_bundle` with the package directory as `target`. Then ask the agent
something current: `web_search` answers through your instance.

**First run is slow, once.** The plugin pulls the image, creates the container,
and waits for `/healthz` (up to `startupTimeoutMs`, 90 s by default). Until it is
healthy a search fails with "SearXNG instance is not ready: …"; the pull keeps
going in the background, so the next search succeeds.

## What it creates

| Thing | Where |
|---|---|
| Container | `dsh-searxng` (configurable), `--restart unless-stopped`, bound to `127.0.0.1:<free port>:8080` |
| Settings | `$DSH_HOME/searxng/settings.yml` (default `~/.dsh/searxng/`), written once, never rewritten |
| Secret | generated into those settings; stable across restarts and upgrades |
| Port | first free port at or above `port` (8888), scanned up to 50 ports — a machine already running SearXNG keeps working |

The container starts when the plugin activates and is stopped when it unloads
(harness shutdown, HMR reload, uninstall). It is kept, not removed, so the next
start takes seconds; data and the secret stay in `$DSH_HOME/searxng`.

## Configuration

Every field is optional; all have working defaults.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | (unset) | Use this existing instance and start nothing. Unset → own container. |
| `port` | `8888` | First candidate port for the container; busy ports are skipped. |
| `image` | `searxng/searxng:latest` | Any compatible SearXNG image (mirror, pinned tag). |
| `containerName` | `dsh-searxng` | Container this plugin owns. |
| `dataDir` | `$DSH_HOME/searxng` | Host directory holding `settings.yml`. |
| `instanceName` | `DSH web search` | Label in the instance's own UI. |
| `startupTimeoutMs` | `90000` | Health-wait budget (1000–600000). |
| `timeoutMs` | `20000` | Per-search budget. |
| `language` | (unset) | Sent as `language`; unset = instance default. |
| `categories` | (unset) | `general`, `news`, … |
| `safesearch` | (unset) | `0`, `1`, `2`. |
| `timeRange` | (unset) | `day`, `week`, `month`, `year`. |
| `numResults` | (unset) | Trim only when a caller passes no `maxResults`; the seam owns the real bound. |
| `apiKey` | (unset) | Sent as `preference[api_key]` for instances behind a key. |

Invalid values stop activation with a message naming the field — a typo never
degrades into a silently disabled search.

Example row (in a bundle patch or profile patch):

```yaml
- insert:
    - id: web-search-searxng
      name: dsh-web-search-searxng
      config:
        port: 8888
        language: ru
```

### Reuse an existing instance

```yaml
config:
  baseURL: http://127.0.0.1:8888
```

Then no container is created, and no Docker is needed. Useful when the machine
already runs SearXNG for something else, or the instance lives on another host.

## Result mapping

- `results[]` → `{url, title?, snippet?, publishedAt?}`; entries without an
  absolute http(s) URL are dropped, blank snippets omitted (never invented),
  snippets capped at 800 characters;
- the first non-blank engine answer (`answers[]`) becomes `content` — real engine
  output, not prose composed here;
- no results **and** a non-empty `unresponsive_engines` list → `WEB_PROVIDER_ERROR`
  naming the engines, so a half-broken instance is visible instead of looking
  like a legitimate empty answer.

Failures carry the seam's codes: `WEB_PROVIDER_ERROR` (HTTP error, unparseable
body, timeout, network, not ready) and `WEB_ABORTED` (caller cancellation).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `docker is not available on this machine` | Start Docker, or set `baseURL`. |
| `SearXNG instance is not ready: … did not become healthy` | Check `docker logs dsh-searxng`; the first pull may still be running. |
| `no free port in 8888..8937` | Lower `port` or free a port; each container takes one. |
| Search returns odd/sparse results | SearXNG aggregates third-party engines; `docker logs` shows which ones refused (`unresponsive_engines`). |
| Two harnesses on one machine | They share the same container name/port; the second reuses the running container. Give one a distinct `containerName` + `port` if you want isolation. |
| Uninstall | Removing the bundle stops the container; delete `docker rm -f dsh-searxng` and `$DSH_HOME/searxng` to reclaim disk. |

## Security notes

- The container publishes only on `127.0.0.1`; it is not reachable from the LAN.
- JSON output is enabled and the rate limiter is off — safe only because of the
  loopback bind. If you expose the instance, re-enable the limiter in
  `settings.yml` and put it behind a proxy.
- The secret key is generated locally and lives only in `settings.yml`.

## Development

No dependencies, no build step: the sources are the artifact.

```
index.js              plugin entry (apply, lifecycle, mode selection)
src/config.js         validation and defaults
src/container.js      docker lifecycle: inspect / start / pull+create / health / stop
src/settings.js       settings.yml generation (+ one-time secret)
src/provider.js       SearXNG JSON client and result mapping
test/unit.test.mjs    unit suite (fake docker, no network)
test/docker.smoke.mjs live container: ensure → search → stop → rm
```

```bash
node --test test/unit.test.mjs   # config, settings, container lifecycle, mapping, errors
node test/docker.smoke.mjs       # real container; needs Docker + network, starts dsh-searxng-smoke
```

CI runs the unit suite on Node 22 and 24 for every push
(`.github/workflows/ci.yml`); the container smoke test is manual
(`.github/workflows/docker-smoke.yml`).

### Releasing

The repository is the distribution channel; there is no registry step.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, tag `v<version>`, push the tag.
3. Create a GitHub release for that tag (`gh release create v<version>` or the UI).

Users install — and pin a version — straight from GitHub:

```bash
dsh plugin --profile web add github:svoemesto/dsh-web-search-searxng
dsh plugin --profile web add github:svoemesto/dsh-web-search-searxng#v2.0.1
```

To make it discoverable from the community plugin lists, publish the repository
with the `dsh-plugin` GitHub topic.

## License

MIT — see [LICENSE](LICENSE).
