---
title: "Automation: cron, hooks, tasks, polling - Plugin Hooks Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Plugin Hooks Maturity Note

## Summary

Typed plugin hooks are one of the more capable automation surfaces: they cover model resolution, prompt construction, tool policy, message dispatch, sessions, compaction, subagents, lifecycle, installation, and cron-change observation. Coverage is broad, but quality is limited by uneven path coverage and live reports where expected hook events do not fire on specific execution paths.

## Category Scope

This category covers `api.on(...)` typed hooks, priority/timeout behavior, decision hooks such as `before_tool_call`, message and dispatch hooks, session and lifecycle hooks, subagent hooks, `cron_changed`, plugin approval requests, trusted tool policies, hook contexts, and SDK/runtime wiring.

## Features

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

- Score: `Stable (80%)`
- Positive signals: There is focused coverage for before/after tool hooks, before-agent hooks, reply/finalize hooks, lifecycle gates, security, correlation, wired gateway/session/subagent/reply-dispatch paths, and host-hook contracts.
- Negative signals: Archive evidence and source shape indicate not every tool execution path consistently goes through both pre and post hook wrappers, especially direct gateway tool invocation and MCP loopback.
- Integration gaps: A cross-runtime hook conformance suite should prove the same hook lifecycle for embedded OpenClaw tools, native Codex hooks, direct Gateway `tools.invoke`, MCP loopback, and channel-triggered runs.

## Quality Score

- Score: `Beta (75%)`
- Gitcrawl reports: PR #62701 adds context to `before_tool_call`; issue #76201 reports plugin `before_tool_call` not firing for native exec on the Anthropic harness; issue #86777 asks to document Codex app-server report-mode handling of plugin `requireApproval`; issue #23451 keeps a built-in tool confirmation gate open even though plugin approvals exist.
- Discrawl reports: Maintainer discussion says `before_tool_call` and `after_tool_call` exist, and Codex native relay maps `PreToolUse`/`PostToolUse`, but direct gateway `tools.invoke` and MCP loopback appear to run `before_tool_call` without consistently running `after_tool_call`.
- Good qualities: The hook catalog is explicit, decision semantics are typed, priorities and timeouts are configurable, plugin config is injected per handler, and approval requests have a documented resolution contract.
- Bad qualities: Runtime coverage is uneven enough that plugin authors cannot assume every execution path fires the same hook sequence. This is a quality issue because policy and observability plugins depend on uniform hook boundaries.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Centralize tool execution through a lifecycle wrapper so pre/post hooks and diagnostics cannot drift by execution path.
- Document native Codex and report-mode behavior for plugin approvals.
- Make hook-path coverage visible in SDK docs so plugin authors know which hooks are guaranteed for each runtime.

## Evidence

### Docs

- `docs/plugins/hooks.md` documents the hook catalog, priority and timeout behavior, decision result semantics, contexts, `cron_changed`, and tool-call policy.
- `docs/plugins/plugin-permission-requests.md` documents plugin approvals and how `before_tool_call.requireApproval` interacts with `/approve`.
- `docs/plugins/sdk-subpaths.md` lists `plugin-sdk/hook-runtime` and related runtime subpaths.

### Source

- `src/plugins/hooks.ts`, `src/plugins/host-hooks.ts`, `src/plugins/host-hook-runtime.ts`, `src/plugins/hook-runner-global.ts`, `src/plugins/hook-decision-types.ts`, and `src/plugins/hook-agent-context.ts` implement typed hook registration and execution.
- `src/gateway/server-methods/plugin-host-hooks.ts` wires plugin hooks into Gateway methods.
- `src/plugin-sdk/hook-runtime.ts` exposes hook helpers through the SDK.
- `extensions/codex/src/app-server/native-hook-relay.ts` maps Codex native hooks into OpenClaw hook behavior.

### Integration tests

- `src/plugins/wired-hooks-after-tool-call.e2e.test.ts`, `src/plugins/wired-hooks-gateway.test.ts`, `src/plugins/wired-hooks-session.test.ts`, `src/plugins/wired-hooks-subagent.test.ts`, and `src/plugins/wired-hooks-reply-dispatch.test.ts` exercise integrated hook wiring.
- `src/plugins/contracts/host-hooks.contract.test.ts` covers host-hook contract behavior.
- `extensions/codex/src/app-server/run-attempt.hooks.test.ts` and `extensions/codex/src/app-server/native-hook-relay.test.ts` cover Codex app-server hook relay paths.

### Unit tests

- `src/plugins/hooks.before-tool-call.test.ts`, `src/plugins/hooks.before-agent-start.test.ts`, `src/plugins/hooks.before-agent-reply.test.ts`, `src/plugins/hooks.before-agent-finalize.test.ts`, `src/plugins/hooks.before-install.test.ts`, `src/plugins/hooks.security.test.ts`, and `src/plugins/hook-runner-global.test.ts` cover hook semantics.
- `src/plugins/hook-decision-types.test.ts`, `src/plugins/hook-agent-context.test.ts`, and `src/plugins/host-hook-cleanup-timeout.test.ts` cover decisions, context, and cleanup.
- `src/agents/agent-tools.before-tool-call.integration.e2e.test.ts` exercises before-tool behavior from the agent tools side.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "plugin hooks before_tool_call cron_changed before_agent_finalize" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "before_tool_call hook" --json --limit 5`

Results:

- PR #62701 adds optional precedingText and messageId to `before_tool_call` context.
- Issue #76201 reports `before_tool_call` not firing for native exec on a specific harness.
- Issue #79168 references content-based prompt injection scanning on tool output.
- Issue #48509 requests a durable-state `before_persistence_write` hook.
- Issue #86777 asks to document plugin `requireApproval` in Codex app-server report mode.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "before_tool_call hook"`

Results:

- Maintainer discussion says pre/post tool hooks exist and Codex native relay maps them, but post-hook coverage is uneven across direct Gateway `tools.invoke` and MCP loopback paths.
- GitHub issue comments kept open #23451, #13364, and #13225, clarifying that plugin `before_tool_call` exists but does not satisfy every requested internal-hook or model-delegation use case.
