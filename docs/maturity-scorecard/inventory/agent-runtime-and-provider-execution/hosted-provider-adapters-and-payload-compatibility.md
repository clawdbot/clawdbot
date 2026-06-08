---
title: "Agent Runtime - Hosted Provider Execution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Hosted Provider Execution Maturity Note

## Summary

Hosted provider adapter coverage is solid for OpenAI/Codex, Anthropic, Google, and OpenAI-compatible routes. Docs explain provider-specific setup, thinking controls, OAuth/API-key distinctions, CLI runtime alternatives, and capability expectations. Source includes provider-specific message/tool/thinking conversion, timeout handling, websocket/SSE behavior, prompt-cache affinity, and tool-call normalization. Quality is Beta because hosted provider payload semantics still change quickly, especially for Codex OAuth routing, Anthropic streaming JSON, Google tool-call ids, and OpenAI-compatible tool behavior.

## Category Scope

This category covers operator-visible hosted provider execution: running turns
against hosted providers, using provider-specific model options, exercising
hosted tool use, applying reasoning or cache controls, and receiving streamed
or final replies despite provider payload differences.

## Features

- Hosted provider turns: Running agent turns against hosted providers such as OpenAI, Anthropic, and Google.
- Provider-specific model options: Provider-specific model parameters and runtime request settings exposed to users or operators.
- Hosted tool use: Tool use behavior when the active runtime is a hosted provider.
- Reasoning and cache controls: Provider-specific reasoning, thinking, and cache-related controls during hosted execution.
- Hosted streaming and replies: Operator-visible streaming and reply behavior while hosted adapters normalize payload differences.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`

Coverage is good for the major providers, but OpenAI-compatible and fast-moving hosted provider variants still rely on scattered tests, docs, and archive evidence rather than a uniform compatibility table.

## Quality Score

- Score: `Beta (70%)`

Adapters include many compatibility guards, but provider payload drift and streaming/tool-call quirks remain visible in archived issues and Discord reports.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Hosted provider turns, Provider-specific model options, Hosted tool use, Reasoning and cache controls, Hosted streaming and replies.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Provider-specific tool-call and thinking semantics still need recurring live proof.
- OpenAI-compatible hosted providers and route aliases have less systematic evidence than first-party routes.
- Some adapter failures surface as generic fallback or missing-key errors, making operator diagnosis harder.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents OpenAI/Codex route distinctions, naming maps, capability tables, GPT-5.5/Codex app-server notes, Codex OAuth setup, and default agent routes.
- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents Anthropic API key versus Claude CLI, canonical refs, legacy refs, thinking defaults, and prompt caching.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md` documents Google plugin capabilities, Gemini CLI OAuth, model refs, capabilities, and thinking/reasoning controls.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents model ref/runtime separation and fallback selection that provider adapters consume.

### Source

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.ts` implements Codex Responses transport setup, account id handling, body/header construction, timeout signals, websocket path, retryable error classification, and prompt-cache affinity.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` implements Anthropic stream setup, request parameter construction, event handling, OAuth system prompt handling, thinking modes, tool id normalization, message transforms, fine-grained tool streaming beta, and tool conversion.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.ts` implements Google thinking-part semantics, thought signature retention, tool-call id requirements, assistant text/thinking/tool-call conversion, and tool-result conversion.
- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.ts` provides cross-provider transport stream sanitization, tool-call argument coercion, metadata merge, finalization, and error stream handling.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers OpenAI session runtime overrides, Codex app-server telemetry, external error formatting, missing custom tool output guidance, and Bedrock tool mismatch reset hints.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers provider catalog rows, auth/local/provider behavior, and catalog responsiveness.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.test.ts` covers account id decoding, transport timeouts, websocket/SSE behavior, timeout behavior, and prompt-cache affinity.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.test.ts` covers Anthropic provider auth and signed thinking replay.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.test.ts` covers projecting text, thinking, tool calls, response ids, and usage.
- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.test.ts` covers sanitization, non-empty tool payload text, headers, success streams, and failure cleanup.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "openai-codex Anthropic Google provider tool call"` returned #80667 on pure `claude-cli` sessions missing `trajectory.jsonl` and #78196 on extension plugin loader behavior.
- `gitcrawl --json search issues -R openclaw/openclaw "tool call streaming truncated tool_call provider"` returned #60593 on recurring Anthropic streaming JSON parse errors, #70033 on tool calls emitting empty `{}` arguments for large content, and #87711 on empty assistant delivery.
- `gitcrawl --json search prs -R openclaw/openclaw "provider error descriptors fallback rate limit"` returned PR #86642 adding structured provider error descriptors.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "tool call streaming"` returned discussions about native progress callbacks, provider streaming/tool-call wrapping, visible tool-call blocks, app-server idle watchdog behavior, Claude CLI/WebChat tool visibility, and Telegram progress modes.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "openai-codex provider routing"` returned reports about OpenAI OAuth/Codex routing, direct OpenAI Responses path drift, stale persisted route state, and old config/runtime pins.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "model fallback decision"` returned hosted-provider timeout and fallback discussions, including OpenRouter timeouts and missing bearer failures.
