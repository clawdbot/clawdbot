---
title: "Anthropic provider path - Claude CLI Backend Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Claude CLI Backend Maturity Note

## Summary

The Claude CLI runtime is a supported bundled backend with docs, plugin
registration, MCP bridge config, live stdio session defaults, permission-mode
normalization, session resume, and `/think` effort mapping. Coverage is Stable
because the main runtime contract is documented and implemented. Quality is
Alpha because archive evidence shows active user-visible failures around
backend registration, systemd/root gateway execution, permissions, stream
buffering, and session resume.

## Category Scope

This category covers OpenClaw's host-local Claude CLI path after auth is
available: the `claude-cli` backend, its command/args/env defaults, MCP tool
bridge, native tool mode, live stdio JSONL sessions, permission-mode mapping,
thinking effort args, session id persistence, transcript validation, and
fallback prelude behavior.

## Features

- Runtime selection: Covers Runtime selection across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Session continuity: Covers Session continuity across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- MCP/tool bridge: Covers MCP/tool bridge across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Permission-mode mapping: Covers Permission-mode mapping across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Fallback prelude: Covers Fallback prelude across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover Claude CLI setup, config, sessions, permissions, thinking effort, and fallback prelude; source registers a full backend with live stdio defaults and MCP bridge; tests cover backend registration and config normalization.
- Negative signals: Live Claude CLI coverage is largely indirect through package-acceptance workflow definitions and plugin/unit tests rather than a single direct live runtime test in this audit.
- Integration gaps: Channel-session and daemon/root gateway paths have archived failures that are not obviously covered by the focused backend tests.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: #70279 reports the backend being skipped on a systemd-managed root gateway; #85408 reports hardcoded MCP flags blocking user-scope MCPs; #85601 reports a bundled MCP config tempDir race; #86050 reports Gateway buffering Claude CLI stream events; #78828 reports root gateway permission-mode stalls.
- Discrawl reports: Discord archive results include `MissingAgentHarnessError: claude-cli is not registered` in Discord group chats while DMs worked, plus guidance showing config path divergence across session routing.
- Good qualities: The backend has conservative default args, clears inherited Claude/Anthropic env that could steer child processes, serializes runs, validates project transcript resume, and maps OpenClaw exec policy into Claude permission mode.
- Bad qualities: The path depends on external CLI installation, local login, host PATH, local project transcript files, channel/session runtime lookup, and provider-owned CLI behavior.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Runtime selection, Session continuity, MCP/tool bridge, Permission-mode mapping, Fallback prelude.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The Claude CLI path is operationally sensitive to host setup and session
  routing.
- Group/channel session paths have shown runtime lookup divergence from DM/main
  session paths.
- Some fixes appear as active or recent PRs/issues, so the lived support record
  is still noisy.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/cli-backends.md` documents the `claude-cli` backend, MCP bridge behavior, session support, native permission mapping, thinking effort mapping, login prerequisites, session resume, and fallback prelude.
- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents Claude CLI as the host-local credential reuse path and warns about same-host expectations.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md` recommends canonical `anthropic/*` model refs plus model-scoped `agentRuntime.id: "claude-cli"`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/anthropic/cli-backend.ts` registers `claude-cli` with `bundleMcp`, Claude config-file bridge, native tool mode, stream-json args, live stdio sessions, workspace-scoped image args, session ids, raw transcript reseed, watchdog defaults, and serialization.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/cli-shared.ts` clears inherited Anthropic/Claude env vars, normalizes `--setting-sources`, maps OpenClaw exec policy to Claude permission mode, and maps OpenClaw thinking levels to `--effort`.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/config-defaults.ts` backfills `agentRuntime.id: "claude-cli"` for selected canonical Anthropic refs when Claude CLI auth is selected.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.ts` checks command resolution, credentials, workspace/project directory health, and active Claude CLI runtime agents.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies live Anthropic and Claude CLI workflow wiring, including `OPENCLAW_LIVE_CLI_BACKEND_MODEL=claude-cli/claude-sonnet-4-6` and package install of `@anthropic-ai/claude-code`.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker.sh` and `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts` cover MCP channel notification/permission framing adjacent to Claude channel mode.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` verifies `claude-cli` backend registration, config defaults, auth migration, and synthetic auth.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/cli-shared.test.ts` verifies permission args, safe setting sources, effort mapping, config normalization, and transcript reseed config.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.test.ts` covers doctor diagnostics for the Claude CLI path.
- `/Users/kevinlin/code/openclaw/src/plugins/bundle-claude-inspect.test.ts` covers bundled Claude inspection behavior.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "claude-cli live session resume transcript missing permission mode"`

Results:

- Returned no direct results for that exact combined query.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Claude CLI OpenClaw MCP allowedTools permission-mode"`

Results:

- #85408 `openclaw agent CLI spawn hardcodes --strict-mcp-config + --allowedTools mcp__openclaw__*, blocking user-scope MCPs`.
- #85601 `[regression] Bundled MCP config tempDir race still present`.
- #86050 `[Bug]: Gateway buffers claude-cli stream events; surfaces only see the final assembled message`.
- #78828 `Claude CLI on root gateway: inferred bypassPermissions breaks, acceptEdits partly works, blocked turns can stall until timeout`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "claude-cli"`

Results:

- Returned active/recent PRs including #73122 backend registration guardrails, #74990 subscription path in onboard wizard, #85505 host-only CLI auth epoch mode, #87702 env-var scrubbing when spawning Claude, #77148 session fork-on-resume, #86649 partial-message streaming deltas, and #86568 auth cooldown skip for CLI providers.

### Discrawl queries

Query: `discrawl search --limit 10 "Claude CLI OpenClaw auth login claude-cli"`

Results:

- Returned a May 26, 2026 support thread where Discord DMs worked but group chats failed with `MissingAgentHarnessError: Requested agent harness "claude-cli" is not registered`, plus older archive entries closing Claude CLI persistence issues and noting implemented CLI delegation.

Query: `discrawl search --limit 10 "Anthropic usage status Claude API key"`

Results:

- Returned April 2026 guidance recommending the CLI subprocess path for Claude subscription usage and warning about direct API-key/API billing configuration.
