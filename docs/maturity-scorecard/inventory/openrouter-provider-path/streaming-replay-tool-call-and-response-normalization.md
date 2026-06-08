---
title: "OpenRouter provider path - Streaming and Tool-call Replay Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Streaming and Tool-call Replay Maturity Note

## Summary

OpenRouter streaming/replay normalization has strong targeted coverage for `reasoning_details`, visible text extraction, repeated tool-call chunks, Mistral strict9 tool ids, DeepSeek reasoning replay, response model tracking, and cache/usage normalization. Coverage is Stable because source and regression tests directly cover the historically fragile paths.

Quality is Beta because the archive shows multiple recent regressions and review threads around empty turns, strict9 scoping, and provider-specific reasoning fields, even though current main appears to include the corresponding fixes.

## Category Scope

This category covers streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, DeepSeek reasoning replay fields, Gemini thought-signature sanitation, response-model capture, and usage/cache token normalization.

## Features

- Streamed content parsing: Covers Streamed content parsing across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- reasoning_details visible output: Covers reasoning_details visible output across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Tool-call delta preservation: Covers Tool-call delta preservation across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Family-specific replay policy: Covers Family-specific replay policy across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Response-model and usage normalization: Covers Response-model and usage normalization across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Regression tests cover OpenRouter/Qwen3 reasoning details, same-chunk tool calls, repeated reasoning chunks, visible response text, ambiguous reasoning text exclusions, replay field normalization, and Mistral strict9 policy.
- Negative signals: Always-on tests simulate provider payloads; live proof is gated and cannot cover the full matrix of OpenRouter upstream providers.
- Integration gaps: Add a periodic live matrix for OpenRouter Mistral tool calls, Qwen/GLM reasoning-details streaming, MiniMax visible reasoning text, and DeepSeek V4 replay.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Archive searches found #58012 and related PRs for strict9 tool-call-id regression, plus blank-response issue closures tied to OpenRouter `reasoning_details` fixes.
- Discrawl reports: Discord search found April 2026 reports of OpenRouter empty completed turns, `payloads=0`, stale base URLs, and visible output in `reasoning_details` fields on older releases.
- Good qualities: Current source contains explicit provider-scoped replay policies, verified-route checks, visible-response-text handling, and replay sanitation for OpenRouter reasoning fields.
- Bad qualities: The number of recent fixes shows this surface is brittle and coupled to upstream providers' changing response shapes.
- Excluded from quality: Regression-test breadth and live-gated test existence are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Current tests are broad but still model known payload shapes rather than unknown future OpenRouter upstream shapes.
- `openrouter/auto` can route to providers with response semantics OpenClaw has not explicitly seen before.
- Usage/cost and response-model transparency remain adjacent issues when OpenRouter routes through a different backend than requested.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents DeepSeek V4 reasoning replay, Anthropic prefill stripping, Gemini-backed route behavior, and proxy-style OpenAI-compatible handling.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` documents OpenRouter cache marker and Gemini thought-signature handling.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` builds the OpenRouter replay policy, including Mistral strict9 handling.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/stream.ts` patches OpenRouter Anthropic, DeepSeek V4, and routing payloads.
- `/Users/kevinlin/code/openclaw/src/agents/openai-transport-stream.ts` parses OpenRouter `reasoning_details`, sanitizes replay reasoning fields, preserves OpenRouter reasoning when valid, and maps usage.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-completions.ts` tracks response model, parses reasoning details, and maps OpenRouter cache-read/cache-write usage.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates OpenRouter completion and cache observations.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.e2e.test.ts` covers explicit OpenRouter model resolution through embedded runs.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.test.ts` covers Mistral strict9 policy, DeepSeek V4 reasoning, Anthropic prefill stripping, and custom-route exclusions.
- `/Users/kevinlin/code/openclaw/src/agents/openai-transport-stream.test.ts` covers OpenRouter `reasoning_details`, tool-call preservation, visible text extraction, replay sanitation, and response text ordering.
- `/Users/kevinlin/code/openclaw/src/llm/providers/stream-wrappers/proxy.test.ts` covers OpenRouter stream wrapper behavior and route-gated patches.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter Mistral strict9 tool_call invalid_function_call DeepSeek reasoning"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "reasoning_details OpenRouter payloads zero content null"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search prs -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #62100 on OpenRouter native slash model refs, #63062 on cache-control payload fixes, #79370 on OpenRouter Anthropic cache retention, and #87562 on streamed cost reconciliation.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter strict9"`

Results:

- Found #58012 and related PR discussion for Mistral-via-OpenRouter strict9 tool-call-id regression, including review comments about scoping strict9 only to Mistral-family OpenRouter routes.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter reasoning_details"`

Results:

- Found April 2026 reports and closure comments for blank OpenRouter replies, `payloads=0`, Qwen3 `reasoning_details`, and visible `response.output_text` / `response.text` fixes.
