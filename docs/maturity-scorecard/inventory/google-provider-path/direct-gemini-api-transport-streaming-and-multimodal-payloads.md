---
title: "Google provider path - Direct Gemini Runtime Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Direct Gemini Runtime Maturity Note

## Summary

The direct Gemini transport is deeply implemented: it builds Google
`generateContent` requests, handles API-key and OAuth headers, converts
multimodal message/tool-result payloads, parses SSE chunks, normalizes usage and
stop reasons, and scopes Gemini thought signatures to compatible replay routes.
Coverage and Quality are Stable, but not higher, because Gemini signature,
function-response, and first-response behavior remain active provider edges.

## Category Scope

Included in this category:

- Direct Gemini chat: Covers Direct Gemini chat across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Multimodal inputs: Covers Multimodal inputs across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Tool-call streaming: Covers Tool-call streaming across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thought-signature replay: Covers Thought-signature replay across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thinking-level mapping: Covers Thinking-level mapping across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Thought-signature replay: Covers Thought-signature replay across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Tool turn ordering: Covers Tool turn ordering across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Incomplete-turn recovery: Covers Incomplete-turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Planning-only turn recovery: Covers Planning-only turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.

## Features

- Direct Gemini chat: Covers Direct Gemini chat across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Multimodal inputs: Covers Multimodal inputs across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Tool-call streaming: Covers Tool-call streaming across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thought-signature replay: Covers Thought-signature replay across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thinking-level mapping: Covers Thinking-level mapping across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Thought-signature replay: Covers Thought-signature replay across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Tool turn ordering: Covers Tool turn ordering across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Incomplete-turn recovery: Covers Incomplete-turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Planning-only turn recovery: Covers Planning-only turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals: The transport covers request construction, guarded fetch,
  SSE parsing, thinking payloads, tool schemas, function calls, multimodal
  function responses, usage mapping, and stop reasons; unit tests are broad and
  live Google model-switching exists.
- Negative signals: Real-provider behavior for Gemini 3 first response,
  signature preservation, and multimodal tool loops is not proven across every
  current Gemini model.
- Integration gaps: Live evidence exists for direct Google model switching, but
  not a full always-on live matrix for every multimodal/tool/signature variant.

## Quality Score

- Score: `Stable (81%)`
- Gitcrawl reports: Exact issue search for `Gemini transport thought signature
tool call` returned no direct issue results, but broader archive searches
  found #84384 on Vertex/OpenAI-compatible Gemini thinking timeouts and #69220
  around Gemini empty post-tool behavior.
- Discrawl reports: `Gemini thought signature` and `functionResponse` searches
  found prior missing-signature, function-response name/format, and
  Google-route scoping reviews.
- Good qualities: The source rejects unsafe thought signatures, preserves only
  same-route signatures, isolates Google-native payload shaping, maps Google
  stop reasons, and keeps retry behavior provider-specific.
- Bad qualities: Gemini tool-loop correctness is sensitive to opaque provider
  signatures and function-response shape, and archive evidence shows repeated
  provider-specific fixes in this area.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Direct Gemini chat, Multimodal inputs, Tool-call streaming, Usage and stop reasons, Thought-signature replay, Thinking-level mapping, Thought-signature replay, Tool turn ordering, Incomplete-turn recovery, Planning-only turn recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Direct Gemini multi-turn thought-signature replay needs recurring live proof
  as model families change.
- Multimodal function responses are implemented, but the provider contract is
  brittle enough that regression risk remains.
- First-response retry is highly model-specific and should be revalidated as
  Gemini 3 variants move between preview and GA names.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:131` lists chat,
  thinking, media, and model capabilities for Google.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:177` documents Gemini
  3 thinking-level normalization.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:205`
  documents direct Gemini provider refs, env vars, and `cacheRead` usage
  reporting.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:44`
  defines direct Google transport options, including tool choice, cached
  content, and thinking inputs.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:206`
  sanitizes thought signatures and rejects unsafe JSON/truncated values.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:233`
  normalizes same-provider, same-API, same-model replay routes.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:316`
  builds the Gemini `generateContent` request URL.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:502`
  converts OpenClaw messages into Google user/model/function parts.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:678`
  converts OpenClaw tools and builds the Google request payload.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:810`
  implements guarded first-response retry for Gemini 3.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.ts:404`
  consumes Google streams and emits normalized text, thinking, tool-call, usage,
  done, and error events.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/google-gemini-switch.live.test.ts:12`
  live-tests switching from an unsigned Antigravity tool-call history into
  direct Gemini models.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:2541`
  forces a real gateway `read` tool call and nonce echo in a provider-profile
  live flow.
- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:121`
  live-tests Google web-search provider execution through Gemini.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:302`
  covers guarded fetch, Gemini SSE parsing, thinking signatures, tool calls, and
  usage.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:966`
  covers same-model thought-signature replay.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:1234`
  covers cross-provider thought-signature rejection.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:1745`
  covers thoughtSignature-only stream liveness.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.test.ts:84`
  covers Google usage normalization, including cache-read accounting.

### Gitcrawl queries

Query: `gitcrawl search issues "Gemini transport thought signature tool call" -R openclaw/openclaw --state all`

Results:

- Returned no direct issue results for that exact query.

Query: `gitcrawl search issues "thoughtSignature" -R openclaw/openclaw --state all`

Results:

- Returned Gemini thought-signature and empty-post-tool behavior reports,
  including #84384 and #69220.

Query: `gitcrawl search issues "functionResponse" -R openclaw/openclaw --state all`

Results:

- Returned closed #49783 on Gemini `functionCall` and `functionResponse`
  compatibility.

### Discrawl queries

Query: `discrawl search --mode fts "Gemini thought signature"`

Results:

- Returned maintainer and user threads for missing `thought_signature`,
  same-route scoping, and provider-specific replay failures.

Query: `discrawl search --mode fts "functionResponse"`

Results:

- Returned #49783, #47857, #46717, and PR #48748 around Gemini
  function-response name and format failures.

Query: `discrawl search --limit 5 "Gemini via Ollama Cloud thought_signature Error"`

Results:

- Returned guidance that Gemini 3 tool-loop replay needs opaque provider
  signatures and that OpenAI-compatible paths can drop those signatures.
