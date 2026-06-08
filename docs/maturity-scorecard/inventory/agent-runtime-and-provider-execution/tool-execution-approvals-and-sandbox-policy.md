---
title: "Agent Runtime - Tool Execution Controls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Tool Execution Controls Maturity Note

## Summary

Tool execution policy is the strongest component in this surface. Docs distinguish sandboxing, tool policy, and elevated approvals; source centralizes tool registration, workspace/sandbox roots, inherited/subagent policy, exec config, schema normalization, and before-tool-call hooks; tests cover approval gates, policy hooks, subagent tool restrictions, and progress behavior. Quality is Beta because archive evidence still shows edge cases around exec approval forwarding, per-agent deny rules, sandbox backend expectations, and plugin/service boundary assumptions.

## Category Scope

This category covers operator-visible control over tools during agent turns:
tool availability rules, sandboxed exec behavior, approval flow, elevated
execution, tool safety controls, and delegated tool access for subagents.

## Features

- Tool availability rules: Which tools are available during a turn after policy resolution and provider-based suppression.
- Sandboxed exec behavior: Exec behavior, sandbox roots, and workspace constraints visible to operators.
- Approval flow: Operator approval gates for tool execution.
- Elevated execution: Elevated host execution rules and related controls.
- Tool safety controls: Before-tool-call hooks and related guardrails that shape operator-visible tool behavior.
- Delegated tool access: Inherited or narrowed tool policy for subagents and delegated execution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`

Coverage is strong across docs, source, e2e tests, unit tests, and archive evidence for policy and approval behavior.

## Quality Score

- Score: `Beta (74%)`

The design is mature, but policy semantics remain subtle for users and operators when CLI backends, subagents, plugin services, and elevated execution overlap.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tool availability rules, Sandboxed exec behavior, Approval flow, Elevated execution, Tool safety controls, Delegated tool access.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operator docs explain the policy layers, but field reports still show confusion about what sandboxing does and does not constrain.
- CLI backend approval forwarding is not as settled as the main embedded runtime path.
- Per-agent and inherited policy behavior needs continued regression proof as subagents expand.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/sandbox-vs-tool-policy-vs-elevated.md` distinguishes sandbox, tool policy, and elevated exec; documents tool policy layers/rules, tool groups, sandboxed MCP server allow gates, elevated exec-only gates, and sandbox jail fixes.
- `/Users/kevinlin/code/openclaw/docs/concepts/agent-loop.md` documents plugin hooks including `before_tool_call`, tool-call handling, and runtime event streams.
- `/Users/kevinlin/code/openclaw/docs/tools/subagents.md` documents subagent tool policy, tool restriction, auth resolution, announce behavior, delivery routing, concurrency, liveness, and recovery.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.ts` implements model-provider tool policy, local model tool suppression, exec config merging, tool policy setup, group/sender/sandbox/subagent/inherited policy, workspace/sandbox roots, `apply_patch` restrictions, exec tool setup, the tool policy pipeline, schema normalization, and `before_tool_call` hook wrapping.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` forwards plan, approval, command output, and patch events through runtime delivery.
- `/Users/kevinlin/code/openclaw/src/agents/cli-runner.ts` persists approved CLI user turn transcripts and runs CLI hooks around backend execution.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts` covers gateway-hosted exec approvals on separate connections.
- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.before-tool-call.integration.e2e.test.ts` covers normal `before_tool_call` behavior, parameter modification, blocking, deduplication, and context.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts` covers subagent lifecycle, cleanup, timeout handling, account routing, announce behavior, and policy-adjacent session behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.message-provider-policy.test.ts` covers provider-based message/tool policy behavior.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers approval, command output, patch event forwarding, tool progress details, and streamed tool result delivery.
- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.test.ts` covers safe transport behavior for tool payloads.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "exec approvals tool policy sandbox agent tool"` returned #44253 on per-agent `tools.selfDeny`, #69512 on forwarding `exec-approvals.json` allowlists to `claude-cli` backend sessions, #78965 on local user sandbox backend, #48532 on security by intent, #67440 on optional TOTP for exec approvals, #48503 on enriching `before_tool_call` events with action classification/input provenance, and #82548 on safety/quality observability events.
- `gitcrawl --json search issues -R openclaw/openclaw "claude-cli codex cli harness subagent sessions_spawn"` returned #73097 on PI harness ignoring `cliBackends` configuration and splitting subagent execution from chat path.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "exec approvals tool policy"` returned May 2026 release testing notes covering auth/profile, sandbox policy, and exec approvals; discussions of node file fetch policy; explanations that denying `exec` at agent tool policy level does not sandbox plugins/services; comments that sandbox/tool-policy/exec-approval controls are useful but not solved defaults; and issue-closing comments for related controls.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "sessions_spawn claude-cli"` returned Claude CLI and ACP runtime discussions that affect tool permissions, sandbox boundaries, and subagent UX.
