---
title: "TUI - Runtime Modes Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Runtime Modes Maturity Note

## Summary

The TUI is a first-class CLI command with Gateway mode, local embedded mode, and
`chat` / `terminal` aliases. The docs and command registration are clear, and
there is targeted unit and PTY proof for local launch behavior. The main product
risk is still launch-context polish: hatch/setup relaunches, stale Gateway port
selection, and slow terminal-mode startup have active archive signal.

## Category Scope

Included in this category:

- Gateway TUI launch: Covers Gateway TUI launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Local chat launch: Covers Local chat launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Terminal alias launch: Covers Terminal alias launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Initial message launch: Covers Initial message launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Launch option validation: Covers Launch option validation across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Gateway connection: Covers Gateway connection across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway authentication: Covers Gateway authentication across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- History load on attach: Covers History load on attach across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Reconnect visibility: Covers Reconnect visibility across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway command RPCs: Covers Gateway command RPCs across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Embedded local chat: Covers Embedded local chat across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Local auth flow: Covers Local auth flow across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Config repair loop: Covers Config repair loop across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Gateway-free recovery: Covers Gateway-free recovery across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.

## Features

- Gateway TUI launch: Covers Gateway TUI launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Local chat launch: Covers Local chat launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Terminal alias launch: Covers Terminal alias launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Initial message launch: Covers Initial message launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Launch option validation: Covers Launch option validation across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Gateway connection: Covers Gateway connection across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway authentication: Covers Gateway authentication across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- History load on attach: Covers History load on attach across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Reconnect visibility: Covers Reconnect visibility across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway command RPCs: Covers Gateway command RPCs across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Embedded local chat: Covers Embedded local chat across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Local auth flow: Covers Local auth flow across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Config repair loop: Covers Config repair loop across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Gateway-free recovery: Covers Gateway-free recovery across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: CLI docs, command registration, launch helper tests, and PTY local-mode tests cover the main user entrypoints and alias semantics.
- Negative signals: Gateway-mode launch coverage is mostly unit-level and transport-adapter level rather than a recurring real Gateway terminal scenario.
- Integration gaps: add a recurring real-host launch scorecard that starts `openclaw tui` against a managed Gateway, against `--url`, and through setup/hatch relaunch.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `gitcrawl search issues "tui terminal local chat" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned open TUI launch-adjacent reports including `#42461` for stale Gateway port selection, `#74385` for slow Hatch terminal mode, and `#74614` / `#78360` for visible chat lifecycle issues after launch.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui terminal local chat"` returned release/maintainer discussion that local embedded TUI mode landed in PR `#66767`, docs landed in PR `#69995`, and follow-up setup/hatch fixes remained open.
- Good qualities: command aliases are explicit, local mode is mutually exclusive with remote credentials, invalid timeout and history-limit values are handled at launch, and relaunch code preserves mode and child stdio.
- Bad qualities: active archive reports show launch context still leaks stale Gateway assumptions and Hatch/setup terminal-mode performance can be surprising.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway TUI launch, Local chat launch, Terminal alias launch, Initial message launch, Launch option validation, Gateway connection, Gateway authentication, History load on attach, Reconnect visibility, Gateway command RPCs, Embedded local chat, Local auth flow, Config repair loop, Gateway-free recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Gateway-mode launch lacks the same PTY-level proof that local mode has.
- Setup/hatch relaunch still needs a crisp operator contract for when it should stay local versus attach to a Gateway.

## Evidence

### Docs

- `docs/cli/tui.md:20` documents `--local`, `--url`, auth flags, `--message`, `--timeout-ms`, and `--history-limit`.
- `docs/cli/tui.md:35` documents `openclaw chat` and `openclaw terminal` as local-mode aliases.
- `docs/web/tui.md:35` documents Gateway-free local mode and the alias behavior.
- `docs/cli/index.md:32` lists `tui`, `chat`, and `terminal` under the runtime and sandbox command family.

### Source

- `src/cli/tui-cli.ts:10` registers `tui`; `src/cli/tui-cli.ts:11` and `src/cli/tui-cli.ts:12` register the `terminal` and `chat` aliases.
- `src/cli/tui-cli.ts:34` detects aliases and implies local mode; `src/cli/tui-cli.ts:37` rejects local mode with URL/token/password overrides.
- `src/tui/tui-launch.ts:36` builds child process args and preserves `--local`, `--url`, auth, session, thinking, message, timeout, history limit, and deliver flags.
- `src/tui/tui.ts:479` initializes `runTui()` with local/Gateway mode, config, agent, session, and UI state.

### Integration tests

- `src/tui/tui-pty-harness.e2e.test.ts:368` drives the real TUI terminal loop through typed input with a fake backend.
- `src/tui/tui-pty-local.e2e.test.ts:249` launches `scripts/run-node.mjs tui --local` and drives a local backend against a mocked model endpoint.
- `test/vitest/vitest.tui-pty.config.ts:5` defines the targetable TUI PTY e2e files and serializes the lane.

### Unit tests

- `src/tui/tui-launch.test.ts:98` verifies local mode is passed to the relaunched TUI.
- `src/tui/tui-launch.test.ts:111` verifies initial message and timeout propagation.
- `src/tui/tui.test.ts:404` covers terminal drain before shutdown.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui terminal local chat" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned 6 open reports. Relevant launch/entrypoint items included `#42461` stale Gateway port selection and `#74385` slow Hatch terminal mode.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui terminal local chat"`

Results:

- Returned maintainer and PR discussion confirming local embedded TUI mode and aliases landed, with follow-up setup/hatch polish still active.
