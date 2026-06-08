---
title: "TUI - Local Shell Execution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Local Shell Execution Maturity Note

## Summary

The local shell feature is useful and intentionally gated: a leading `!`
triggers a once-per-session approval prompt, commands run on the TUI host with
`OPENCLAW_SHELL=tui-local`, output is capped, and declined sessions stay
disabled. The UX has clear docs and unit coverage, but little real PTY proof and
the safety boundary is high-risk because it intentionally uses a shell on the
operator machine.

## Category Scope

Included in this category:

- Bang-command routing: Covers Bang-command routing across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Approval prompt: Covers Approval prompt across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Command output display: Covers Command output display across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Execution environment marker: Covers Execution environment marker across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.

## Features

- Bang-command routing: Covers Bang-command routing across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Approval prompt: Covers Approval prompt across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Command output display: Covers Command output display across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Execution environment marker: Covers Execution environment marker across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: submit routing and local shell approval/execution have focused unit tests, and docs are precise about local host behavior.
- Negative signals: no PTY/e2e scenario verifies the approval overlay, a real command, capped stdout/stderr, and decline behavior together.
- Integration gaps: add a PTY local shell smoke that declines once, retries, approves, runs a harmless command, verifies `OPENCLAW_SHELL=tui-local`, and checks output capping.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `gitcrawl search issues "TUI local shell" -R openclaw/openclaw --state all --json number,title,url,state --limit 8` returned no direct local-shell defect, but returned `#86632` where local embedded mode failed a live-data request that another shell/curl-capable agent handled. Broader `gitcrawl search issues "local shell" ...` returned shell-environment and local transport reports outside the TUI path.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "TUI local shell"` returned local TUI discussion without direct local-shell defect reports.
- Good qualities: local execution is explicit, gated, session-scoped, visibly labeled, and capped; leading whitespace and lone `!` do not accidentally execute.
- Bad qualities: the feature uses `shell: true` by design, so the approval copy and output handling carry most of the safety burden; richer command supervision is not present.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bang-command routing, Approval prompt, Command output display, Execution environment marker.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- There is no real terminal scenario proving the approval overlay and execution path together.
- Output is captured after command close rather than streamed as an interactive process.

## Evidence

### Docs

- `docs/web/tui.md:136` documents `!` local shell commands.
- `docs/web/tui.md:138` says the TUI prompts once per session and disabled sessions keep local exec disabled.
- `docs/web/tui.md:140` says commands run in a fresh non-interactive shell in the TUI working directory.
- `docs/web/tui.md:141` documents `OPENCLAW_SHELL=tui-local`.
- `docs/cli/tui.md:76` uses local shell commands in the config repair loop.

### Source

- `src/tui/tui-submit.ts:24` routes only raw leading `!` lines to local shell and treats a lone `!` as a normal message.
- `src/tui/tui-local-shell.ts:27` creates the local shell runner.
- `src/tui/tui-local-shell.ts:36` implements the once-per-session allow prompt.
- `src/tui/tui-local-shell.ts:81` executes a local shell line, caps output, labels output as `[local]`, and reports exit.
- `src/tui/tui-local-shell.ts:108` spawns with `shell: true`, the TUI cwd, and `OPENCLAW_SHELL=tui-local`.

### Integration tests

- No dedicated local shell PTY/e2e test found. `src/tui/tui-pty-harness.e2e.test.ts:368` covers typed input through the TUI loop, but not the approval overlay or shell execution.

### Unit tests

- `src/tui/tui.submit-handler.test.ts:13` routes `!` lines to the bang handler.
- `src/tui/tui.submit-handler.test.ts:24` treats a lone `!` as a normal message.
- `src/tui/tui.submit-handler.test.ts:34` keeps leading-whitespace `!` as a normal message.
- `src/tui/tui-local-shell.test.ts:64` logs denial without re-prompting.
- `src/tui/tui-local-shell.test.ts:81` sets `OPENCLAW_SHELL` when running local commands.

### Gitcrawl queries

Query:

`gitcrawl search issues "TUI local shell" -R openclaw/openclaw --state all --json number,title,url,state --limit 8`

Results:

- Returned open TUI/local-mode-adjacent reports including `#86632`, but no direct local-shell approval/exec defect.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "TUI local shell"`

Results:

- Returned local TUI discussion without direct local-shell approval/exec defect reports.
