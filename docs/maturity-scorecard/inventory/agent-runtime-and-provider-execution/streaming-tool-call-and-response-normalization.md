---
title: "Agent Runtime - Tool Calls and Response Handling Maturity Note"
version: 3
last_refreshed: 2026-05-31
last_refreshed_by: codex
---

# Agent Runtime - Tool Calls and Response Handling Maturity Note

## Summary

Tool-call handling and response normalization are well covered in docs and tests: OpenClaw normalizes malformed tool-call arguments, provider-specific payload differences, usage accounting, and terminal failure streams across adapters and shared transport code. Coverage is Stable. Quality is Alpha because recent archive evidence still shows empty tool arguments, raw tool JSON or visible tool-call blocks, and terminal-empty assistant delivery that still leaks surprising states to users.

## Category Scope

This category covers operator-visible tool-call and response-handling behavior:
reliable tool-call payload handling across providers, usage and response
reporting, and recovery when provider output is malformed, empty, or
incomplete.

## Features

- Tool-call handling: Reliable tool-call behavior across providers, including malformed or provider-specific payload differences.
- Usage and response reporting: Response ids and usage accounting normalized into operator-visible runtime behavior.
- Failure recovery: Failure-stream finalization and cleanup when provider output is malformed or incomplete.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`

Coverage is strong across provider adapters, shared transport code, and focused tests for tool payload coercion, response ids and usage, malformed provider output, and failure finalization.

## Quality Score

- Score: `Alpha (66%)`

Normalization is robust in source, but field reports show provider tool-call output and malformed responses still leak surprising states to users.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tool-call handling, Usage and response reporting, Failure recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Empty or malformed tool-call arguments still emerge in provider-specific edge cases.
- Raw tool JSON or visible tool-call blocks still appear in some local or compatibility modes.
- Terminal-empty and tool-only responses still need more consistent operator-facing explanation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/agent-loop.md` documents tool-event streams, final payload behavior, and timeout behavior around the agent loop.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md` documents native tool-calling, OpenAI-compatible mode reliability warnings, raw tool JSON as text, garbled output handling, and tool-calling compatibility caveats.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.ts` coerces transport tool-call arguments, merges headers and metadata, finalizes failure streams, and normalizes transport error details.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` normalizes streamed tool ids and partial JSON tool arguments for Anthropic responses.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.ts` normalizes tool call ids, tool arguments, response ids, and usage accounting for Google-family providers.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` formats terminal empty/tool-only outcomes and bridges normalized tool results into operator-visible replies.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers media-only tool results, plan-only terminal result fallback, terminal-empty result classification, stripping glued leading `NO_REPLY` tokens, streamed tool results delivery, and tool-only outcome handling.
- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.before-tool-call.integration.e2e.test.ts` covers hook-driven tool parameter modification, blocking, deduplication, and context around tool-call execution.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.test.ts` covers surrogate sanitization, non-empty tool payload text, header propagation, successful stream finalization, and failure cleanup.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.test.ts` covers tool call projection, response ids, and usage.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.test.ts` covers signed thinking replay and provider behavior that affects tool payload normalization.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "tool call streaming truncated tool_call provider"` returned #60593 on recurring Anthropic streaming JSON parse errors, #70033 on tool calls emitting empty `{}` arguments for large content, and #87711 on empty assistant delivery.
- `gitcrawl --json search issues -R openclaw/openclaw "openai-codex Anthropic Google provider tool call"` returned adapter-adjacent issues for `claude-cli` session artifacts and extension plugin loading.
- `gitcrawl --json search prs -R openclaw/openclaw "provider error descriptors fallback rate limit"` returned #86642, which improves structured provider error descriptors feeding normalized runtime errors.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "tool call streaming"` returned May 2026 discussions about provider streaming/tool-call wrapping, visible tool-call blocks, Claude CLI/WebChat tool visibility, and missing terminal updates.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "Ollama tool calling OpenClaw"` returned reports and guidance on raw tools printed as text and model/tool-calling compatibility.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "model fallback decision"` returned fallback logs where missing or empty provider output contributed to operator-visible failure paths.
