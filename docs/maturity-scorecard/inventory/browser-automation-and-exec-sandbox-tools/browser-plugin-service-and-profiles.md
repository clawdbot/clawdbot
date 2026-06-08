---
title: "Browser automation and exec/sandbox tools - Browser Plugin Service and Profiles Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Browser Plugin Service and Profiles Maturity Note

## Summary

Browser plugin service and profiles is a Stable component. The bundled plugin has
explicit manifest contracts, CLI and Gateway request registration, a lazy control
service, profile CRUD, default/openclaw/user/remote profile resolution, and hot
reload coverage. The remaining risk is operational profile brittleness around
existing Chrome sessions, WSL/macOS profile behavior, and remote CDP reachability.

## Category Scope

This note covers bundled browser plugin activation, browser CLI registration,
`browser.request` Gateway routing, control-service startup, known profile
enumeration, default profile resolution, profile create/delete, local managed
profiles, `user`/existing-session profiles, attach-only and remote CDP profiles,
and profile hot reload.

## Features

- Browser Plugin Service: Covers Browser Plugin Service across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Profiles: Covers Profiles across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - Browser setup and profile docs cover plugin enablement, tool allowlists,
    default profile selection, openclaw/user profile behavior, remote CDP, and
    lifecycle commands.
  - Source registration is manifest-first and connects tool, CLI, Gateway,
    node-host proxy, plugin service, and security audit surfaces.
  - Runtime tests cover lazy plugin startup, profile request routing, profile
    CRUD, lifecycle cleanup, and hot reload after config changes.
  - Docker browser CDP snapshot smoke reaches a live Gateway/browser fixture and
    verifies browser doctor, tab opening, and snapshot assertions.
- Negative signals:
  - Existing-session and user-profile flows have current archive bugs around
    macOS, WSL, and timeout behavior.
  - Remote browser Chrome DevTools MCP requests mostly resolve outside first
    party core, leaving a sharper boundary between core CDP profiles and plugin
    ecosystem work.
- Integration gaps:
  - Add a profile lifecycle E2E matrix across managed, user/existing-session,
    remote CDP, attach-only, macOS, WSL, and headless Linux profiles.
  - Add a release-gate browser.request profile-routing scenario that exercises
    profile selection from both query string and body.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports:
  - `browser plugin profiles browser.request openclaw browser command missing`
    returned open PR #81076 for top-level act field backfill, open PR #85993
    expanding Chrome MCP web capabilities, and open PR #74411 for download
    actions.
  - `browser profile` returned open PR #80143 for honoring `cdpUrl` on the user
    default profile, issue #80036 for Chrome MCP existing-session timeout on
    macOS, issue #62288 for brittle existing-session attach, and issue #43803
    for browser profile hot-reload routing.
- Discrawl reports:
  - `browser profiles openclaw browser` returned release/archive messages
    around browser existing-session status probes, remote browser MCP being
    plugin-path work, proxy configuration, and managed browser timeout fixes.
- Good qualities:
  - The plugin is self-contained and defaults to enabled through a clear manifest
    contract.
  - Profile resolution is centralized, supports known runtime profiles, and
    refreshes config when selecting/listing profiles.
  - Profile CRUD validates remote/private-network CDP settings and avoids
    deleting remote or existing-session browser data.
  - Lazy startup avoids starting the control server during Gateway boot while
    still supporting on-demand runtime cleanup.
- Bad qualities:
  - The product surface combines several profile models with different behavior:
    managed, existing-session, attach-only, remote CDP, and node-host proxy.
  - Users can observe a profile as "ready" while later page tools time out if
    the external browser/Chrome MCP/CDP layer is unhealthy.
  - Hot reload and profile reconciliation are strong but subtle enough that
    stale runtime state remains a current operational theme.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Plugin Service, Profiles.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Existing-session profile behavior needs more cross-platform proof and clearer
  failure taxonomy.
- Remote CDP and Chrome MCP profile lanes need stronger operator diagnostics
  before this component should be considered Lovable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:10`: browser tool uses a dedicated isolated profile by default and can control an existing Chrome profile via Chrome MCP.
- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:21`: documented features include separate profile, deterministic tab control, actions, snapshots, screenshots, PDF, and multi-profile support.
- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:67`: disabling the plugin removes CLI commands, Gateway method, agent tool, and control service.
- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:119`: docs distinguish openclaw managed profile from user existing-session profile.
- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:138`: docs describe browser config fields and profile config.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:14`: browser control API exposes status, tabs, open, focus, close, screenshot, snapshot, console, errors, requests, PDF, response body, and act.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:32`: profile query param selects profile and loopback auth follows gateway auth.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:125`: control service is an internal loopback server backed by CDP/Playwright.

### Source

- `/Users/kevinlin/code/openclaw/extensions/browser/openclaw.plugin.json:1`: browser plugin manifest declares id, default enablement, startup/config hooks, tool contract, CLI aliases, and skills.
- `/Users/kevinlin/code/openclaw/extensions/browser/register.runtime.ts:1`: runtime exports browser tool, Gateway request handler, node-host proxy, plugin service, and security audit.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.ts:40`: known profile names are merged from config and runtime state.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.ts:51`: profile context wires profile lifecycle, tab operations, and availability.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.ts:143`: profile selection refreshes config and resolves default/current profile.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.ts:161`: profile listing includes Chrome MCP and CDP reachability.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/profiles-service.ts:48`: profile service validates and manages profile list/create/delete operations.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser-tool.ts:213`: browser node target resolution uses capabilities, commands, and connected browser-capable nodes.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/browser-cdp-snapshot-docker.sh:84`: Docker E2E runs browser doctor, opens the fixture, snapshots, and asserts the result.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs:6`: snapshot assertion checks page text, docs link, URL, and iframe refs.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/browser-runtime.ts:111`: QA browser runtime helper exercises `browser.request`, open, snapshot, and act flows.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/browser-runtime.ts:185`: QA helper waits for enabled/running/CDP-ready status.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/browser/src/plugin-service.test.ts:54`: verifies browser control service does not start during gateway startup by default.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/plugin-service.test.ts:101`: verifies on-demand browser runtime stops even when startup was lazy.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.hot-reload-profiles.test.ts:86`: verifies new profiles are hot-reloaded from config.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server-context.hot-reload-profiles.test.ts:177`: verifies profile listing refreshes config before enumerating profiles.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/profiles-service.test.ts:204`: verifies remote Chrome profiles accept `cdpUrl`.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/gateway/browser-request.profile-from-body.test.ts:95`: verifies `browser.request` can use profile from the request body.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "browser plugin profiles browser.request openclaw browser command missing" --json`

Results:

- Open PR #81076: `fix(browser): backfill top-level act fields into nested request`.
- Open PR #85993: `feat(browser): expand Chrome MCP web capabilities`.
- Open PR #74411: `feat(browser): add agent download actions`.

Query:

`gitcrawl search openclaw/openclaw --query "browser profile" --json`

Results:

- Open PR #80143: `fix(browser): honor cdpUrl for user default profile`.
- Open issue #80036: Chrome MCP existing-session `profile=user` reports ready but page tools time out on macOS.
- Open issue #62288: existing-session attach is brittle and needs improved fallback/diagnostics.
- Open issue #43803: browser profile hot-reload path still has reload-mode risk.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "browser profiles openclaw browser"`

Results:

- Maintainers/release archive entry on 2026-05-10 includes browser existing-session status probe extension.
- OpenClaw archive comments on 2026-04-26 discuss browser proxy configuration, remote browser MCP as plugin work, and managed browser timeout fixes.
