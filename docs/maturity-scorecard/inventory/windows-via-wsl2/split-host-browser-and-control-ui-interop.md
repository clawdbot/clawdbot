---
title: "Windows via WSL2 - Browser and Control UI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Browser and Control UI Maturity Note

## Summary

Split-host browser and Control UI interop has a strong dedicated runbook, but remains a real Beta risk area. The common topology is clear: Gateway runs inside WSL2, the Control UI opens from Windows localhost, and Windows Chrome is controlled through raw remote CDP reachable from WSL2. Quality stays Beta because archive evidence shows users still confuse Control UI origin/auth failures, remote CDP reachability, host-local Chrome MCP, and node-host relay behavior.

## Category Scope

Included in this category:

- WSL2 Gateway with Windows browser: WSL2 Gateway with Windows browser and Windows Chrome
- Windows Control UI URL: Windows Control UI URL and origin guidance
- Raw remote CDP to Windows Chrome: Raw remote CDP access from WSL2 to a Windows Chrome instance.
- Host-local Chrome MCP: Host-local Chrome MCP and existing-session boundary
- Browser profile cdpUrl: Browser profile cdpUrl and attachOnly config
- Layered diagnostics: Layered diagnostics for auth/origin/CDP failures

## Features

- WSL2 Gateway with Windows browser: WSL2 Gateway with Windows browser and Windows Chrome
- Windows Control UI URL: Windows Control UI URL and origin guidance
- Raw remote CDP to Windows Chrome: Raw remote CDP access from WSL2 to a Windows Chrome instance.
- Host-local Chrome MCP: Host-local Chrome MCP and existing-session boundary
- Browser profile cdpUrl: Browser profile cdpUrl and attachOnly config
- Layered diagnostics: Layered diagnostics for auth/origin/CDP failures

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: the WSL2 + Windows remote CDP troubleshooting doc covers the full layered setup; browser docs define remote CDP, `attachOnly`, existing-session limits, and CDP readiness failures; Control UI docs and source enforce origin and device-auth rules.
- Negative signals: this is primarily documentation and source behavior, with no WSL2-specific browser/control UI e2e that opens Windows Chrome from a WSL2 Gateway.
- Integration gaps: no current live proof was found for end-to-end `openclaw browser open`, `browser tabs`, Control UI auth, and remote CDP after Windows/WSL network changes.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `WSL2 Windows browser CDP Control UI` returned issue #73836 for Control UI/Gateway responsiveness in Windows + WSL2 and PR #74163 with Microsoft issue refresh context. `Windows WSL2 OpenClaw` returned issue #81873 for existing-session/CDP confusion, issue #54669 for Chrome IPv6/portproxy breakage, and issue #87387 for WSL2 Control UI false in-progress state.
- Discrawl reports: WSL2 browser/CDP search returned issue #41553 comments, PR #42027, and user/support discussion explaining that raw remote CDP is viable but host-local Chrome MCP is not a WSL2-to-Windows bridge.
- Good qualities: docs are unusually explicit about layer order, exact curl checks, `cdpUrl` config, Control UI localhost, and misleading error messages.
- Bad qualities: user-visible failures still overlap across network reachability, Control UI origin, token/pairing, CDP HTTP, and CDP WebSocket readiness.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WSL2 Gateway with Windows browser, Windows Control UI URL, Raw remote CDP to Windows Chrome, Host-local Chrome MCP, Browser profile cdpUrl, Layered diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need an automated WSL2 + Windows Chrome remote-CDP smoke with a real Windows browser endpoint.
- Need a unified diagnostic command that summarizes Control UI origin/auth and CDP HTTP/WebSocket status in one place.
- Need clearer product distinction between Windows node-host relay, raw CDP, and existing-session Chrome MCP for same-machine WSL2 setups.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:10`: guide defines the split-host setup and why layered failures are confusing.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:16`: raw remote CDP is the recommended WSL2-to-Windows browser pattern.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:28`: existing-session/user profile is only for same-host Gateway and Chrome.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:64`: Windows Control UI should use `http://127.0.0.1:18789/` unless a deliberate HTTPS setup exists.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:95`: WSL2 users should curl the exact Windows CDP endpoint intended for `cdpUrl`.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:117`: remote browser profile example sets `cdpUrl` and `attachOnly`.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md:175`: common misleading errors distinguish Control UI auth/origin, CDP reachability, and existing-session misuse.
- `/Users/kevinlin/code/openclaw/docs/tools/browser.md:309`: general browser docs define remote CDP profiles.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:485`: public non-loopback Control UI deployments must configure allowed origins.

### Source

- `/Users/kevinlin/code/openclaw/src/infra/browser-open.ts:68`: Linux browser open support detects WSL and prefers `wslview` when available.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/message-handler.ts:679`: Gateway checks browser origin against `gateway.controlUi.allowedOrigins`.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/message-handler.ts:877`: Gateway records `control-ui-insecure-auth` for insecure Control UI device-identity failures.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/connect-policy.ts:131`: Control UI device-identity policy only allows insecure auth for localhost when explicitly configured.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-assistant-media.e2e.test.ts`: Control UI e2e coverage exists for Gateway/Control UI behavior, though not WSL2 Windows Chrome.
- `/Users/kevinlin/code/openclaw/src/gateway/server-plugin-bootstrap.browser-plugin.integration.test.ts`: browser plugin startup integration exists for Gateway startup behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/startup-control-ui-origins.test.ts:16`: startup tests seed localhost/127.0.0.1 origins for LAN bind.
- `/Users/kevinlin/code/openclaw/src/gateway/server.config-patch.test.ts:266`: config response tests redact browser `cdpUrl` credentials.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/connect-policy.test.ts:80`: connect-policy tests cover insecure Control UI rejection.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.suite.ts`: Control UI auth suite covers pairing and auth behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 Windows browser CDP Control UI" --mode keyword --limit 10 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 OpenClaw" --mode keyword --limit 12 --json`

Results:

- WSL2 Windows browser CDP Control UI returned issue #73836 and PR #74163.
- Windows WSL2 OpenClaw returned 12 hits, including browser profile issue #81873, Chrome IPv6/portproxy issue #54669, Control UI false in-progress issue #87387, Gateway stall #61616, placeholder reachability #80336, and WSL2 gateway responsiveness issues.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 Windows browser CDP Control UI"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 portproxy Gateway Windows host"`

Results:

- WSL2 browser/CDP search returned 8 hits, including issue #41553 comments, PR #42027, support guidance for raw remote CDP, and Control UI origin troubleshooting.
- Portproxy/Gateway search returned Windows node-host relay and Chrome extension relay reports that overlap with split-host browser setup.
