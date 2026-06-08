---
title: "OpenAI / Codex provider path - Responses and Tool Compatibility Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Responses and Tool Compatibility Maturity Note

## Summary

The Codex Responses transport has strong source and test evidence. It supports ChatGPT backend URLs, account-id headers, WebSocket-first with SSE fallback, request timeouts, prompt cache affinity, retries, service tier, reasoning/text fields, Responses message conversion, tool conversion, and stream normalization. Quality remains Beta because OpenAI/Codex payload semantics change frequently and archive evidence includes prior tool-call replay and transport-state issues.

## Category Scope

Included in this category:

- Codex Responses Transport: Covers Codex Responses Transport across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Payload Compatibility: Covers Payload Compatibility across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Tool Context: Covers Tool Context across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.
- Capability Compatibility: Covers Capability Compatibility across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.

## Features

- Codex Responses Transport: Covers Codex Responses Transport across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Payload Compatibility: Covers Payload Compatibility across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Tool Context: Covers Tool Context across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.
- Capability Compatibility: Covers Capability Compatibility across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Focused unit tests cover JWT account extraction, transport timeouts, WebSocket/SSE choices, retry headers, prompt-cache affinity, strict tool conversion, and reasoning replay.
- Negative signals: Integration proof is still split across model/runtime/gateway tests rather than a single Codex Responses compatibility lane.
- Integration gaps: More live proof is needed for WebSocket fallback, prompt cache, service tier, and tool-call replay against current ChatGPT backend behavior.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query for transport/prompt-cache returned no direct rows, but the reasoning replay query returned #76413 about `openai-codex` Telegram session replay after a tool call.
- Discrawl reports: Query for transport/prompt-cache returned no matching rows; provider-native tool discussion shows ongoing confusion between OpenAI Responses server-side tools and OpenClaw client-side tools.
- Good qualities: The code has explicit timeout, retry, account-header, prompt-cache, strict-tool, and stream-processing guards.
- Bad qualities: Transport behavior depends on a fast-moving upstream backend and the tool/reasoning item semantics are brittle enough to need focused regression tests.
- Excluded from quality: Unit and integration test coverage was not used as a Quality input.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Codex Responses Transport, Payload Compatibility, Tool Context, Capability Compatibility.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- There is no single public compatibility matrix for which OpenAI/Codex payload fields are accepted by each route.
- WebSocket degradation and SSE fallback need release-lane proof after upstream changes.
- Tool and reasoning replay remain high-risk because invalid item pairing can leak across turns.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents transport choices, fast mode, service tier, server-side compaction, and native/compatible endpoint behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/openresponses-http-api.md` documents OpenResponses-compatible request fields, files/images, tools, and session behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/openai-http-api.md` documents OpenAI-compatible Chat Completions tool and streaming behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.ts` implements Codex backend URL handling, account-id headers, WebSocket/SSE transport, retries, request timeouts, prompt-cache affinity, service tier/text/reasoning fields, and stream handling.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-responses-shared.ts` converts OpenClaw messages, images, tool calls, tool results, reasoning items, and streamed response events into/from OpenAI Responses shapes.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-responses-tools.ts` converts OpenClaw tools into Responses function tools.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-stream.ts` routes `openai-codex-responses` through the OpenClaw OpenAI Responses transport when transport-aware behavior is required.
- `/Users/kevinlin/code/openclaw/src/agents/openai-responses-payload-policy.ts` strips or preserves service tier, prompt cache, store, and compaction fields according to endpoint class.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/openresponses-http.test.ts` exercises OpenResponses request parsing, auth/routing, session behavior, SSE, and file/image handling.
- `/Users/kevinlin/code/openclaw/src/gateway/openai-http.test.ts` exercises OpenAI-compatible Chat Completions request validation, routing, SSE, images, and client tools.
- `/Users/kevinlin/code/openclaw/scripts/e2e/openai-chat-tools-docker.sh` runs an OpenAI Chat Completions tools Docker E2E.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.test.ts` covers account-id extraction, explicit WebSocket behavior, timeout handling, Retry-After parsing, and prompt-cache affinity.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-responses-shared.test.ts` covers strict tool conversion and schema normalization.
- `/Users/kevinlin/code/openclaw/src/agents/openai-responses.reasoning-replay.test.ts` covers reasoning replay around tool calls and assistant messages.
- `/Users/kevinlin/code/openclaw/src/agents/openai-strict-tool-setting.ts` and adjacent tests cover strict-tool decisions for native OpenAI and Codex routes.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "openai-codex responses websocket sse tool call prompt_cache service_tier"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenAI Responses reasoning replay function_call tool result"`

Results:

- Returned #76413 about an `openai-codex` Telegram session replaying a prior assistant reply after a tool call.

### Discrawl queries

Query: `discrawl search --limit 10 "openai-codex responses websocket sse tool call prompt cache service tier"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

Query: `discrawl search --limit 10 "strict tools OpenAI Responses schema tool_choice"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.
