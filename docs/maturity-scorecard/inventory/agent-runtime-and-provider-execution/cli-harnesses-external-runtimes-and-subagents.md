---
title: "Agent Runtime - External Runtimes and Subagents Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - External Runtimes and Subagents Maturity Note

## Summary

OpenClaw treats external runtimes as a first-class execution mode: docs separate providers from runtimes, explain Codex/OpenClaw/ACP/external harness ownership, document Claude CLI and Gemini CLI aliases, and describe subagent auth, delivery, cleanup, and recovery. Source bridges CLI transcripts and events through `runCliAgent`, and tests cover CLI previews, subagent sessions, lifecycle cleanup, and runtime override boundaries. Quality is Alpha because archives show recurring issues around `claude-cli`, ACP/subagent delivery, unsupported backend settings, trajectory artifacts, and auth propagation from main sessions.

## Category Scope

This category covers operator-visible execution outside the default embedded
provider path: choosing external harnesses, using CLI runtime aliases, running
subagent turns, and recovering from cleanup, timeout, or liveness issues in
those external runtimes.

## Features

- External harness selection: Choosing Codex app-server, ACP, and other external runtime harnesses.
- CLI runtime aliases: Runtime aliases and CLI-based execution paths such as Claude CLI and Gemini CLI.
- Subagent turns: Spawning, delivering, and announcing subagent work outside the default embedded path.
- Runtime recovery: Cleanup, timeout, and liveness behavior for external runtimes and subagents.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`

Coverage is good for Codex/CLI/subagent workflows, but external harnesses and ACP have less uniform proof than the embedded runtime.

## Quality Score

- Score: `Alpha (66%)`

CLI/subagent execution is functional but operationally fragile where backend-specific auth, tool permission boundaries, unsupported settings, and result delivery vary by runtime.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for External harness selection, CLI runtime aliases, Subagent turns, Runtime recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- External runtime behavior shifts with upstream CLI tools and needs more release-by-release proof.
- Subagent UX and lifecycle semantics are well tested but still produce field reports around delivery, account routing, and parity.
- Some CLI artifacts and diagnostics, such as pure `claude-cli` trajectories, have active gap reports.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/agent-runtimes.md` documents runtimes versus providers/model/channel, embedded harnesses versus CLI backends, Codex surfaces, runtime decision tree, ownership split, runtime selection, fail-closed explicit runtimes, CLI backend aliases, Claude CLI, OpenAI default to Codex harness, and compatibility contract.
- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents Claude CLI setup, same-host requirement, canonical Anthropic refs with `agentRuntime.id: "claude-cli"`, legacy refs, and thinking defaults.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md` documents Gemini CLI OAuth setup, plugin capabilities, legacy aliases, and capability expectations.
- `/Users/kevinlin/code/openclaw/docs/tools/subagents.md` documents subagent auth, announce behavior, delivery routing, sessions_history sanitation, subagent tool policy, concurrency, liveness, and recovery.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/cli-runner.ts` persists approved CLI user turn transcripts, finalizes CLI context engine turns, invokes `before_agent_reply`, and runs CLI agent turns.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` resolves CLI runtime execution providers, handles runtime overrides, bridges CLI assistant events into previews, forwards runtime plan/approval/command/patch events, and enforces live switch retry caps.
- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.ts` applies subagent/inherited tool policy and configures tool execution boundaries used by spawned runtime sessions.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts` covers `sessions_spawn` lifecycle behavior, cleanup, enough gateway request time, MCP cleanup, delete via `agent.wait`, timeout handling, account routing, and announce behavior.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers forwarding static extra prompts to CLI backends, prepared CLI user turns at the persistence boundary, no CLI session reuse for room-event turns, CLI assistant event previews, reasoning previews, CLI runtime override boundaries, and Codex app-server telemetry.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` includes focused tests for runtime override resolution, CLI preview bridging, external error formatting, gateway restart recovery copy, and live model switch retry caps.
- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.message-provider-policy.test.ts` covers provider-policy behavior that affects external runtime tool surfaces.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "claude-cli codex cli harness subagent sessions_spawn"` returned #73097 on PI harness ignoring `cliBackends` configuration and splitting subagent execution from chat path.
- `gitcrawl --json search issues -R openclaw/openclaw "openai-codex Anthropic Google provider tool call"` returned #80667 on `trajectory.jsonl` never being written for pure `claude-cli` sessions and #78196 on extension plugin loader behavior.
- `gitcrawl --json search issues -R openclaw/openclaw "local model provider context timeout Ollama"` returned #81214 on an OpenClaw subagent regression and #87642 on exposing subagent-control `waitForRun` timeout for slow local LLMs.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "sessions_spawn claude-cli"` returned Apr-May 2026 discussions about ACP runtime failures with Claude Opus settings, Claude CLI tool availability, tool permission boundaries/sandboxing, ACP/sub-agent relay UX, and subagent/ACP result delivery regressions.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "tool call streaming"` returned Claude CLI/WebChat tool visibility concerns and app-server watchdog discussions that affect external runtime delivery.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "No API key found provider openai-codex"` returned related Codex OAuth profile propagation and rebuild-recognition reports that affect external runtime/subagent sessions.
