# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.0.1 — 2026-10-25

Documentation release; no behaviour change.

- npm is out of scope: both READMEs describe GitHub as the only installation and
  release channel; the npm-name caveat and the publishing instructions are gone.
- Russian README is the page GitHub shows (`README.md`), English is `README.en.md`;
  both carry the language switcher and the CI badge.
- Releasing documented as version bump → tag → GitHub release, with the pinned
  `github:…#v<version>` install form.

## 2.0.0 — 2026-10-25

First public version.

- `WebSearchProvider` with id `searxng` for the DeepSeek Harness web seam
  (`ctx.web`), so the stock `web_search` tool searches through SearXNG — no
  vendor API key, no per-search cost.
- Own container by default: `searxng/searxng` image, first free loopback port
  from `port`, generated `$DSH_HOME/searxng/settings.yml` (JSON API on, limiter
  off, secret generated once), health wait on `/healthz`, stop on plugin unload.
- External instance mode: setting `baseURL` reuses an existing SearXNG and
  starts nothing (Docker not required).
- Result mapping: citeable http(s) sources only, trimmed/capped snippets, engine
  `answers[]` as `content`, `unresponsive_engines` surfaced as
  `WEB_PROVIDER_ERROR`; `WEB_ABORTED` for caller cancellation.
- Loud config validation (every field named), 23-test unit suite with a fake
  Docker runner, and a live Docker smoke test.
- Russian README (`README.ru.md`) with a language switcher, a CI badge, and an
  explicit note that the npm name belongs to an unrelated package.
