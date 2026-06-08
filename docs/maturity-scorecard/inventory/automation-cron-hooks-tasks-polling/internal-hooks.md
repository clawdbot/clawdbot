---
title: "Automation: cron, hooks, tasks, polling - Automation Hooks Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Automation Hooks Maturity Note

## Summary

Internal hooks are a usable operator automation surface with docs, CLI management, metadata-based discovery, bundled hooks, hook packs, workspace/managed precedence, and lifecycle events. The main maturity issues are scope clarity and operational overhead: users still ask for plugin-style pre-tool hooks in the internal hook system, and archive reports show bootstrap-extra-files behavior and hook overhead remain sources of confusion.

## Category Scope

Included in this category:

- HOOK.md authoring: Covers HOOK.md authoring across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook discovery: Covers Hook discovery across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook CLI management: Covers Hook CLI management across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook packs: Covers Hook packs across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Lifecycle event dispatch: Covers Lifecycle event dispatch across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- api.on registration: Covers api.on registration across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Tool-call policy hooks: Covers Tool-call policy hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Message hooks: Covers Message hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Session/lifecycle hooks: Covers Session/lifecycle hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Plugin approval requests: Covers Plugin approval requests across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- cron_changed: Covers cron_changed across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.

## Features

- HOOK.md authoring: Covers HOOK.md authoring across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook discovery: Covers Hook discovery across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook CLI management: Covers Hook CLI management across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Hook packs: Covers Hook packs across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- Lifecycle event dispatch: Covers Lifecycle event dispatch across `HOOK.md` metadata, handler loading, bundled/managed/workspace/plugin hook discovery, eligibility policy, and related internal hooks behavior.
- api.on registration: Covers api.on registration across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Tool-call policy hooks: Covers Tool-call policy hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Message hooks: Covers Message hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Session/lifecycle hooks: Covers Session/lifecycle hooks across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- Plugin approval requests: Covers Plugin approval requests across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.
- cron_changed: Covers cron_changed across `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, and related plugin hooks behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Source and tests cover frontmatter parsing, workspace loading, import URLs, module loading, config eligibility, hook installation/update, fire-and-forget behavior, bundled hook handlers, message mappers, and plugin-managed hook listing.
- Negative signals: Coverage is broad at module level but limited for real Gateway lifecycle order across startup, shutdown, message flow, compaction, and command events under multiple configured hook directories.
- Integration gaps: A single Gateway scenario should load bundled, managed, workspace, and plugin-managed hooks, verify precedence, exercise a replyable event and a non-replyable lifecycle event, and prove CLI status reflects execution eligibility.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Issue #84744 reports `bootstrap-extra-files.paths` silently dropped by the recognized bootstrap basename whitelist; PR #74735 adds session-scoped extra files; issue #43454 requests broader Gateway lifecycle hooks; issue #53600 calls out hook overhead on constrained VPS setups.
- Discrawl reports: Discord logs show bundled hook loading in real gateway startup, user confusion around repeated `BOOT.md` reads, and an issue opened for a `before_tool` internal hook even though that belongs to plugin hooks today.
- Good qualities: Discovery has clear precedence, workspace hooks cannot override managed hooks with the same name, handler path boundary checks exist, mutable hooks get cache-busted import URLs, and bundled hooks are documented.
- Bad qualities: Internal hooks and typed plugin hooks remain easy to conflate. Some hook behavior silently filters user intent, and hook overhead can matter on small hosts.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for HOOK.md authoring, Hook discovery, Hook CLI management, Hook packs, Lifecycle event dispatch, api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Docs and CLI output should more aggressively distinguish internal hooks from typed plugin hooks.
- `bootstrap-extra-files` should report filtered paths clearly instead of making whitelist behavior feel silent.
- Startup/status output should make per-hook cost and loaded event scope more visible for constrained deployments.

## Evidence

### Docs

- `docs/automation/hooks.md` documents internal hook purpose, event types, `HOOK.md` structure, discovery precedence, bundled hooks, config, CLI reference, and best practices.
- `docs/cli/hooks.md` documents CLI operations for hook management.
- `docs/plugins/hooks.md` distinguishes typed plugin hooks from internal hooks.

### Source

- `src/hooks/frontmatter.ts`, `src/hooks/workspace.ts`, `src/hooks/loader.ts`, `src/hooks/config.ts`, `src/hooks/policy.ts`, `src/hooks/internal-hooks.ts`, `src/hooks/install.ts`, and `src/hooks/update.ts` implement the core internal hook system.
- `src/hooks/bundled/session-memory/`, `src/hooks/bundled/bootstrap-extra-files/`, `src/hooks/bundled/command-logger/`, `src/hooks/bundled/compaction-notifier/`, and `src/hooks/bundled/boot-md/` implement bundled hooks.
- `src/cli/hooks-cli.ts`, `src/gateway/session-patch-hooks.ts`, `src/agents/bootstrap-hooks.ts`, and `src/auto-reply/reply/message-preprocess-hooks.ts` connect hooks to CLI and runtime events.

### Integration tests

- `src/hooks/bundled/boot-md/handler.gateway-startup.integration.test.ts` exercises boot-md at gateway startup.
- `src/gateway/server.sessions.reset-hooks.test.ts` and `src/gateway/server.sessions.permissions-hooks.test.ts` exercise session hook integration.
- `src/auto-reply/reply/get-reply.message-hooks.test.ts` and `src/auto-reply/reply/message-preprocess-hooks.test.ts` exercise message-flow hook integration.

### Unit tests

- `src/hooks/frontmatter.test.ts`, `src/hooks/workspace.test.ts`, `src/hooks/loader.test.ts`, `src/hooks/module-loader.test.ts`, `src/hooks/configured.ts`, `src/hooks/policy.test.ts`, `src/hooks/fire-and-forget.test.ts`, and `src/hooks/internal-hooks.test.ts` cover core behavior.
- `src/hooks/bundled/session-memory/handler.test.ts`, `src/hooks/bundled/bootstrap-extra-files/handler.test.ts`, and `src/hooks/bundled/boot-md/handler.test.ts` cover bundled hooks.
- `src/cli/hooks-cli.test.ts`, `src/hooks/hooks-install.test.ts`, and `src/hooks/update.test.ts` cover CLI/install/update behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "internal hooks HOOK.md session-memory bootstrap-extra-files" --json --limit 5`

Results:

- Issue #84744 reports `bootstrap-extra-files` user-configured paths silently dropped by the whitelist.
- PR #74735 adds session-scoped extra files.
- Issue #43454 requests broader Gateway lifecycle hooks.
- Issue #53600 mentions hook overhead per turn on constrained VPS setups.

Fallback query:

`gitcrawl search openclaw/openclaw --query "session-memory hook bootstrap-extra-files" --json --limit 5`

Results:

- Same cluster plus issue #22438 on tiered bootstrap file loading, reinforcing bootstrap context-size pressure.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "internal hooks HOOK.md session-memory bootstrap-extra-files"`

Results:

- No matching Discord messages returned for this exact query.

Fallback query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "session-memory hook bootstrap-extra-files"`

Results:

- Real gateway logs show bundled hooks loaded at startup: `boot-md`, `bootstrap-extra-files`, `command-logger`, and `session-memory`.
- User thread asks why agents repeatedly read `BOOT.md` and shows `openclaw hooks list` with bundled hooks and a plugin-managed memory-core hook.
- Issue #60065 discussion requests pre-tool hook capability in the internal hook surface, showing confusion between internal hooks and plugin hooks.
