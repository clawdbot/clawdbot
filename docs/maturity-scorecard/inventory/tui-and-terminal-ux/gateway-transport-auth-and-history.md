---
title: "TUI - Gateway Transport, Auth, and History Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Gateway Transport, Auth, and History Maturity Note

## Summary

Gateway-backed TUI has a clear transport adapter, explicit auth resolution, TUI
client identity, protocol bounds, history loading, command/model/session RPCs,
and disconnect/gap handling. Coverage is good for adapter behavior and startup
history retry, but weaker for full real-Gateway PTY proof. Quality is held back
by active reports around Gateway port selection, SecretRef resolution, and
stream buffering across Gateway-backed clients.

## Category Scope

This category covers Gateway connection resolution, token/password/SecretRef
auth for TUI, `--url` auth requirements, client mode/capability registration,
`chat.send`, `chat.history`, command/model/session RPCs, reconnect/disconnect
state, event gaps, and history load on attach.

## Features

- Gateway connection: Covers Gateway connection across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway authentication: Covers Gateway authentication across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- History load on attach: Covers History load on attach across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Reconnect visibility: Covers Reconnect visibility across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway command RPCs: Covers Gateway command RPCs across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Gateway client unit tests cover auth precedence, explicit `--url` auth, SecretRef resolution, client identity, insecure loopback operator UI handling, startup `chat.history` retry, and `commands.list`.
- Negative signals: there is no recurring PTY e2e that starts a real managed Gateway, attaches the TUI, streams a response, disconnects, and reconnects.
- Integration gaps: add a Gateway-mode PTY smoke with token/password variants and a restarted Gateway history reload.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `gitcrawl search issues "tui gateway auth history port" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned `#86050` on Gateway buffering stream events. Broader `gitcrawl search issues "tui commands"` returned `#81547` for TUI/CLI SecretRef resolution and `#42461` for stale Gateway runtime port selection.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui gateway auth history port"` returned no direct TUI transport hits beyond generic stuck-agent diagnostics, so absence of Discord reports is neutral after freshness checks.
- Good qualities: auth failure messages include concrete remediation, explicit `--url` requires explicit auth, startup history retry is bounded, and TUI registers with Gateway capabilities for tool events.
- Bad qualities: active issue reports show TUI attach can still choose the wrong runtime port, SecretRef resolution can diverge from active Gateway state, and Gateway buffering can degrade visible streaming.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway connection, Gateway authentication, History load on attach, Reconnect visibility, Gateway command RPCs.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Real Gateway attach/reconnect proof is thinner than local embedded PTY proof.
- Auth resolution spans config, env, SecretRefs, setup launch env, and insecure loopback policy, which increases operator confusion when one path fails.

## Evidence

### Docs

- `docs/web/tui.md:27` documents remote Gateway launch with `--url` and token/password auth.
- `docs/web/tui.md:204` says TUI registers with the Gateway as mode `tui`, and surfaces reconnects and event gaps.
- `docs/web/tui.md:222` warns that explicit `--url` requires explicit token or password.
- `docs/cli/tui.md:41` documents configured Gateway auth SecretRef resolution for TUI.

### Source

- `src/tui/gateway-chat.ts:103` implements `GatewayChatClient` as a `TuiBackend`.
- `src/tui/gateway-chat.ts:122` constructs `GatewayClient` with TUI client name, mode, protocol bounds, and tool-event capability.
- `src/tui/gateway-chat.ts:189` sends `chat.send`; `src/tui/gateway-chat.ts:210` loads `chat.history` with startup retry.
- `src/tui/gateway-chat.ts:264` resolves Gateway connection details, explicit auth, config/env auth, and insecure local operator UI mode.
- `src/tui/tui.ts:196` formats pairing-required disconnect guidance for terminal display.

### Integration tests

- `src/cli/gateway-rpc.runtime.test.ts` validates CLI Gateway RPC routing for related command surfaces.
- `src/tui/tui-pty-harness.e2e.test.ts:368` proves the real TUI loop against a fake backend, but does not prove Gateway transport.

### Unit tests

- `src/tui/gateway-chat.test.ts:139` rejects `--url` without explicit credentials.
- `src/tui/gateway-chat.test.ts:174` carries configured handshake timeout into TUI client connection.
- `src/tui/gateway-chat.test.ts:304` resolves env-template SecretRef auth.
- `src/tui/gateway-chat.test.ts:518` identifies the client as `openclaw-tui`.
- `src/tui/gateway-chat.test.ts:572` retries startup-unavailable `chat.history` until Gateway startup completes.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui gateway auth history port" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned `#86050` on Gateway buffering claude-cli stream events. Broader query `gitcrawl search issues "tui commands" ...` returned `#81547` on TUI/CLI SecretRef resolution and `#42461` on stale Gateway runtime port selection.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui gateway auth history port"`

Results:

- Returned generic stuck-agent Gateway diagnostics, not a direct TUI transport defect.
