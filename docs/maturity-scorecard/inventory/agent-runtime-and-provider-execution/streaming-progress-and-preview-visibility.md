---
title: "Agent Runtime - Streaming and Progress Maturity Note"
version: 3
last_refreshed: 2026-05-31
last_refreshed_by: codex
---

# Agent Runtime - Streaming and Progress Maturity Note

## Summary

Streaming and progress visibility are well covered in docs and tests: OpenClaw separates provider/runtime streaming from channel delivery, documents block and preview streaming modes, and surfaces tool-progress and item lifecycle updates before final delivery. Coverage is Stable. Quality is Beta because runtime and channel differences still produce missing progress updates, suppressed previews, and occasional terminal-update confusion.

## Category Scope

This category covers operator-visible streaming and progress behavior before
final delivery: streaming replies, preview and block streaming modes, and
progress visibility through tool-progress or item lifecycle updates.

## Features

- Streaming replies: Streaming block updates and partial assistant output before final delivery.
- Progress visibility: Progress preview events and item lifecycle updates surfaced during execution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`

Coverage is strong across streaming docs, agent-loop docs, event plumbing, and focused tests for preview updates, item lifecycle events, duplicate progress suppression, and terminal delivery behavior.

## Quality Score

- Score: `Beta (70%)`

Streaming and progress behavior is broadly solid, but field reports still show runtime- and channel-specific differences around progress callbacks, terminal updates, and preview behavior.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Streaming replies, Progress visibility.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived combined category.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Some progress visibility behavior still differs by runtime and channel.
- Native progress callbacks can still be suppressed or delayed in some flows.
- Terminal updates after long-running tool activity still need more consistent operator-facing behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/streaming.md` documents the two streaming layers, block streaming, preview modes, channel mapping, runtime behavior, and tool-progress preview updates.
- `/Users/kevinlin/code/openclaw/docs/concepts/agent-loop.md` documents assistant and tool event streams, block streaming behavior, event-stream shapes, and session timeout semantics.

### Source

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` bridges assistant and tool events into previews, tracks item lifecycle events, suppresses duplicate progress, and handles terminal streaming text before final delivery.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` emits streaming assistant and tool events, including fine-grained tool streaming behavior.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.ts` emits assistant, thinking, and tool-call stream events that feed operator-visible progress and streaming behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers CLI assistant event previews, item lifecycle events, duplicate progress skipping, raw tool progress details, tool-start progress before slow typing, and Codex app-server telemetry.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.test.ts` covers streamed text, thinking, and tool event projection.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.test.ts` covers streaming behavior that affects signed thinking replay and provider event handling.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "tool call streaming truncated tool_call provider"` returned #60593 on recurring Anthropic streaming JSON parse errors, #70033 on tool calls emitting empty `{}` arguments for large content, and #87711 on empty assistant delivery.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "tool call streaming"` returned May 2026 discussions about `/verbose off` suppressing native progress callbacks, missing terminal updates, provider streaming/tool-call wrapping, and tool-call visibility modes.
