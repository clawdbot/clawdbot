---
title: "Anthropic provider path - Request Transport and Turn Semantics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Request Transport and Turn Semantics Maturity Note

## Summary

The direct Anthropic Messages transport is deeply implemented: it builds
Anthropic request payloads, handles API-key and OAuth/token headers, decodes
SSE events, tracks usage, maps stop reasons, handles aborts, and supports
Anthropic-compatible endpoints. Coverage is Stable because source and tests
exercise the main payload and stream behavior. Quality is Beta because archive
evidence shows recurring malformed/truncated stream and tool-call failures that
have required repeated fixes.

## Category Scope

Included in this category:

- API-key/OAuth transport: Covers API-key/OAuth transport across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Messages payloads: Covers Messages payloads across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Streaming decode: Covers Streaming decode across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Abort/error handling: Covers Abort/error handling across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Tool-use blocks: Covers Tool-use blocks across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Tool-result replay: Covers Tool-result replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Partial JSON recovery: Covers Partial JSON recovery across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Native thinking: Covers Native thinking across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Signed/redacted thinking replay: Covers Signed/redacted thinking replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.

## Features

- API-key/OAuth transport: Covers API-key/OAuth transport across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Messages payloads: Covers Messages payloads across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Streaming decode: Covers Streaming decode across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Abort/error handling: Covers Abort/error handling across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Tool-use blocks: Covers Tool-use blocks across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Tool-result replay: Covers Tool-result replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Partial JSON recovery: Covers Partial JSON recovery across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Native thinking: Covers Native thinking across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Signed/redacted thinking replay: Covers Signed/redacted thinking replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Transport source covers client construction, headers, payloads, SSE event iteration, usage accounting, abort handling, and compatible endpoint behavior; unit tests cover direct Anthropic, OAuth, custom endpoints, malformed SSE, unsafe integer tool-use input, and abort behavior; a live transport test covers real HTTP stream abort.
- Negative signals: Some live provider behaviors are env-gated and provider-specific stream drift cannot be fully proven from local tests.
- Integration gaps: The audit found live abort proof and extensive unit coverage, but not repeated live proof for every Anthropic model/auth combination.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: #60593 reports recurring Anthropic streaming JSON parse errors where failover often failed; PR #62429 sanitized control characters in Anthropic streaming JSON; PR #61349 suppressed raw JSON parse errors from truncated tool-call streams; PR #86959 finalized abandoned managed-response streams to release sockets.
- Discrawl reports: Discord archive results include session corruption from truncated streaming tool calls, raw parse errors sent to users, and Anthropic stream parse fixes.
- Good qualities: The transport classifies malformed SSE as a stable transport error, preserves provider usage fields, avoids direct-Anthropic beta headers on custom hosts, cancels stalled reads on abort, and separates API-key from OAuth header behavior.
- Bad qualities: Anthropic and Anthropic-compatible stream shapes have produced recurring operational incidents around malformed JSON, partial tool deltas, control characters, and aborted streams.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for API-key/OAuth transport, Messages payloads, Streaming decode, Usage and stop reasons, Abort/error handling, Tool-use blocks, Tool-result replay, Partial JSON recovery, Native thinking, Signed/redacted thinking replay.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Provider stream drift remains a recurring source of defects.
- Some compatible providers need custom handling for endpoint classification,
  cache markers, reasoning content, and stream sanitization.
- Direct Anthropic model/auth combinations need recurring live proof beyond
  local mock transport tests.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents API-key and Claude CLI routes, thinking defaults, prompt caching, fast mode, media, and 1M context behavior.
- `/Users/kevinlin/code/openclaw/docs/reference/prompt-caching.md` documents Anthropic usage counters and cache behavior that the transport reports.
- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md` documents Anthropic long-context 429 errors and fallback guidance.

### Source

- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` implements Anthropic SDK client construction, OAuth/API-key header handling, cache retention, SSE decoding, content/tool/thinking events, usage accounting, stop reason mapping, message conversion, image conversion, and tool conversion.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.ts` implements guarded fetch transport, direct Anthropic model-id stripping, endpoint classification, beta headers, OAuth identity headers, usage/cost accounting, malformed stream classification, and abort-safe streaming.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/stream-wrappers.ts` composes beta-header, fast-mode, service-tier, and thinking-prefill wrappers around Anthropic streams.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts` provides guarded model fetch plumbing used by the transport.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.live.test.ts` starts a loopback HTTP SSE server and proves Anthropic transport aborts a real in-flight stream.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies live Anthropic gateway smoke profile wiring.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.test.ts` covers guarded fetch usage, model-id stripping, custom endpoint header behavior, malformed stream classification, unsafe integer preservation, OAuth identity/tool remapping, text/thinking blocks, aborts, and adaptive thinking request shape.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.test.ts` covers SDK client construction behavior and signed thinking replay payloads.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/stream-wrappers.test.ts` covers beta stripping, OAuth/default beta headers, service-tier injection/skips, and thinking prefill stripping.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-payload-policy.test.ts` covers Anthropic cache and service-tier policy shaping.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic tool call streaming JSON parse error"`

Results:

- #60593 `Recurring Anthropic streaming JSON parse errors (Sonnet 4.5 / Opus) - failover often fails to recover`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "anthropic streaming"`

Results:

- #62112 preserves Anthropic refusal handling.
- #74432 honors `ANTHROPIC_BASE_URL`.
- #86649 relays Claude CLI assistant partial messages as streaming deltas.
- #75136 preserves Anthropic stream usage.
- #62429 and #61349 appeared in archive results as stream/tool-call parse fixes.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic tool call streaming parse JSON"`

Results:

- Returned April 2026 reports for session corruption from truncated Anthropic streaming tool calls, issue #69846, PR #62429 for control-character sanitization, PR #61349 for raw parse error suppression, and PR #44237 for recovering tool-call args from `partialJson`.

Query: `discrawl search --limit 10 "Anthropic thinking signature cache control"`

Results:

- Returned no direct results for that exact query.
