---
title: "Agent Runtime - Agent Turn Execution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Agent Turn Execution Maturity Note

## Summary

Agent turns have a first-class runtime lifecycle: docs explain gateway/embedded starts, queueing, session locks, event streams, timeouts, and early termination; source centralizes turn execution in `runAgentTurnWithFallback`; tests exercise fallback orchestration, aborts, lifecycle backstops, event delivery, and runtime telemetry. Quality is Beta because archive evidence still shows recent empty/failed replies and timeout edge cases around long-running or restarted embedded turns.

## Category Scope

This category covers user/operator-visible turn execution: starting an agent turn, choosing gateway versus embedded runtime, establishing session/run ids, applying queue locks, bridging events, honoring aborts, timing provider/model work, and emitting terminal outcomes.

## Features

- Turn startup and runtime choice: Starting an agent turn and choosing gateway versus embedded runtime execution.
- Session and run coordination: Establishing session and run ids, queue locks, and related execution coordination.
- Abort and terminal outcomes: Honoring aborts, timing provider/model work, and emitting terminal outcomes.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`

Coverage is broad across concepts, CLI docs, source, and tests. The remaining coverage gap is direct scenario proof for every runtime restart/timeout path per provider release.

## Quality Score

- Score: `Beta (74%)`

The lifecycle has strong guardrails and diagnostics, but recent operational reports still show terminal-empty replies, restart recovery cases, and timeout-sensitive local/embedded runs that need clearer operator recovery behavior.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Turn startup and runtime choice, Session and run coordination, Abort and terminal outcomes.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Some runtime failure modes are documented through tests and archived issues rather than a single operator-facing troubleshooting guide.
- Long-running local or external runtime turns still appear sensitive to timeout configuration.
- Archive searches found little direct GitHub issue coverage for the narrow `agent.wait` and embedded fallback terms, so Discord evidence carries more of the field-signal burden.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/agent-loop.md` documents the agent RPC shape, `agentCommand`, `runEmbeddedAgent`, event bridge, `agent.wait`, queueing/session locks, streaming/tool/final payload behavior, event streams, timeouts, and early termination reasons.
- `/Users/kevinlin/code/openclaw/docs/cli/agent.md` documents running an agent turn via Gateway, model/thinking/local/deliver/timeout options, local preload behavior, gateway timeout fallback session/run ids, and SIGTERM/SIGINT `chat.abort`.
- `/Users/kevinlin/code/openclaw/docs/concepts/agent-runtimes.md` explains runtimes versus providers/model/channel, embedded harnesses, CLI backends, Codex surfaces, runtime ownership, runtime selection, and fail-closed explicit runtimes.

### Source

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` imports `runEmbeddedAgent`, `runWithModelFallback`, runtime provider resolution, and outcome planning; it implements turn timing, context window resolution, `runAgentTurnWithFallback`, fallback candidate auth/profile setup, live model switches, run diagnostics, reply media, and compaction notices.
- `/Users/kevinlin/code/openclaw/src/agents/cli-runner.ts` finalizes CLI context engine turns, persists approved CLI transcripts, and runs CLI agent turns through the same hook path.
- `/Users/kevinlin/code/openclaw/packages/agent-core/src/agent-loop.test.ts` anchors EventStream failure handling in the lower-level agent loop package.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers `runAgentTurnWithFallback`, abort signal propagation, queued fallback rechecks, fallback auth availability, CLI assistant event previews, lifecycle terminal backstops, gateway restart copy, external error formatting, live model switch restart/retry caps, and auth profile state on retries.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts` covers spawned-session lifecycle cleanup, enough gateway request time, MCP cleanup, delete via `agent.wait`, timeout handling, account routing, and announce behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/packages/agent-core/src/agent-loop.test.ts` covers EventStream error paths.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` includes focused unit coverage for fallback orchestration, terminal result classification, empty result handling, and turn-level diagnostics.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "agent loop gateway_timeout chat.abort embedded fallback"` returned no matching issues, suggesting the exact lifecycle query is not where field reports are clustered.
- `gitcrawl --json search issues -R openclaw/openclaw "runAgentTurnWithFallback agent runner timeout"` returned no matching issues.
- `gitcrawl --json search issues -R openclaw/openclaw "local model provider context timeout Ollama"` returned issues including #87642 on exposing `waitForRun` timeout for slow local LLMs, #86599 on local provider calls blocking the gateway event loop on Windows, and #74204 on memory embed timeout for local GGUF.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "runEmbeddedAgent agent.wait"` returned no matches.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "agent.wait gateway_timeout embedded fallback"` returned no matches.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "model fallback decision"` returned recent discussions around openai-codex timeouts, fallback decisions, No API key fallback decisions, OpenRouter timeout decisions, missing bearer logs, and repeated fallback errors in session repair loops.
