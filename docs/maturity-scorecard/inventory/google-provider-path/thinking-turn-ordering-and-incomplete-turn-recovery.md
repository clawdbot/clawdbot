---
title: "Google provider path - Thinking and Turn Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Thinking and Turn Recovery Maturity Note

## Summary

Gemini thinking, turn ordering, thought-signature replay, and incomplete-turn
recovery are implemented with strong provider-specific safeguards. Coverage is
Stable because source and runtime-flow evidence cover the main replay and
recovery paths. Quality is Stable at the shared boundary because the source is
robust and provider-scoped, but archives still show active pressure around
thought signatures, function-response formatting, and incomplete Gemini turns.

## Category Scope

This category covers Gemini thinking-level mapping, adaptive thinking request
shape, `thoughtSignature` capture/replay/sanitization, Google replay policy,
assistant-first turn repair, Gemini turn validation, and retry/recovery for
empty, reasoning-only, and planning-only Gemini turns. It excludes non-Gemini
media/TTS/search features except where they prove provider registration or live
Google execution.

## Features

- Thinking-level mapping: Covers Thinking-level mapping across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Thought-signature replay: Covers Thought-signature replay across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Tool turn ordering: Covers Tool turn ordering across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Incomplete-turn recovery: Covers Incomplete-turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Planning-only turn recovery: Covers Planning-only turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Provider-owned replay hooks, turn-order repair,
  thought-signature sanitization, Gemini turn validation, and incomplete-turn
  retry gates are all present in source; runtime-flow tests cover replay-safe
  recovery, and live Google switching exists.
- Negative signals: No always-on dedicated live test was found for direct
  Gemini multi-turn thought-signature replay or Gemini-specific recovery against
  the real API.
- Integration gaps: Some QA scenarios use mock-provider runtime flows rather
  than direct Gemini live calls.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: #84384 and #69220 cover Gemini thought signatures/thinking
  and empty post-tool behavior; #49783 covered Gemini function-response
  compatibility; #73153, #85422, and #63188 clustered around
  incomplete/reasoning-only/empty response retry behavior.
- Discrawl reports: Searches for `Gemini thought signature`, `Gemini incomplete
turn`, `functionResponse`, and `Gemini turn ordering` found missing-signature
  threads, PR #71362, function-response format failures, and turn-order repair
  logs.
- Good qualities: The provider code scopes replay to same-route Google models,
  filters unsafe signatures, validates Gemini turns before generic Anthropic
  validation, and makes Gemini recovery explicit instead of generic.
- Bad qualities: Opaque provider signatures and incomplete-turn semantics are
  still high-churn behavior in archives, so the implementation needs recurring
  validation.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Thinking-level mapping, Thought-signature replay, Tool turn ordering, Incomplete-turn recovery, Planning-only turn recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Direct Gemini live proof for multi-turn `thoughtSignature` replay was not
  found as an always-on gate.
- Docs mention Google thinking and signature failures but do not fully explain
  turn-order repair or direct Gemini replay diagnostics.
- Incomplete-turn recovery has strong source guardrails, but live proof is still
  thinner than mock runtime coverage.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:139` lists Google
  thinking/reasoning support.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:178` documents Gemini
  3 thinking-level mapping.
- `/Users/kevinlin/code/openclaw/docs/help/faq-models.md:459` documents the
  thinking-signature-required failure and operator recovery.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:355` documents
  Google-focused live smoke commands and route distinctions.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/provider-hooks.ts:10` wires
  Google Gemini replay-family hooks.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-model-shared.ts:217`
  provides Google replay policy and tagged reasoning mode.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-replay-helpers.ts:174`
  defines Google replay sanitization, strict tool-call ids, signature filtering,
  assistant-first ordering fix, and synthetic tool results.
- `/Users/kevinlin/code/openclaw/src/shared/google-turn-ordering.ts:5`
  prepends a user bootstrap when replay history starts with an assistant turn.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-helpers/turns.ts:339`
  validates Gemini turn sequences.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/replay-history.ts:879`
  applies Gemini validation before Anthropic validation.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/incomplete-turn.ts:129`
  enables incomplete-turn recovery for Gemini models across Google providers.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/incomplete-turn.ts:596`
  defines reasoning-only and empty-response retry gates.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:98`
  includes Gemini live model keys.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:2541`
  forces a real gateway read tool call and nonce echo.
- `/Users/kevinlin/code/openclaw/src/agents/google-gemini-switch.live.test.ts:12`
  live-tests switching from unsigned Antigravity tool-call history into direct
  Gemini models.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/empty-response-recovery-replay-safe-read.md:12`
  covers runtime empty-response recovery with replay-safe reads.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/reasoning-only-recovery-replay-safe-read.md:12`
  covers runtime reasoning-only recovery with replay-safe reads.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:966`
  covers same-model thought-signature replay.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:1234`
  covers cross-provider signature rejection.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-helpers.validate-turns.test.ts:74`
  covers `validateGeminiTurns`.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run.incomplete-turn.test.ts:1536`
  covers reasoning-only Gemini retry.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run.incomplete-turn.test.ts:2551`
  covers empty Gemini turns.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run.incomplete-turn.test.ts:2642`
  covers Gemini planning-only recovery gating.
- `/Users/kevinlin/code/openclaw/src/agents/openai-transport-stream.test.ts:5636`
  covers Gemini thought-signature round trip on OpenAI-compatible completions.

### Gitcrawl queries

Query: `gitcrawl search issues "thoughtSignature" -R openclaw/openclaw --state all`

Results:

- Returned open #84384 and #69220 around Gemini thought signatures/thinking and
  empty post-tool behavior.

Query: `gitcrawl search issues "functionResponse" -R openclaw/openclaw --state all`

Results:

- Returned closed #49783 on Gemini function-call/function-response
  compatibility.

Query: `gitcrawl search issues "Gemini incomplete turn reasoning-only empty response" -R openclaw/openclaw --state all`

Results:

- Returned #73153, #85422, and #63188 around incomplete, reasoning-only, and
  empty response retry behavior.

### Discrawl queries

Query: `discrawl search --mode fts "Gemini thought signature"`

Results:

- Found April and May maintainer/user threads for missing signatures, PR #79827,
  PR #84855, and issue #71725.

Query: `discrawl search --mode fts "Gemini incomplete turn"`

Results:

- Found #69220, #71126, PR #71362, #71074 closure, and commit references for
  Gemini incomplete-turn recovery.

Query: `discrawl search --mode fts "Gemini turn ordering"`

Results:

- Found user logs showing `google turn ordering fixup: prepended user
bootstrap` and #27862 linking missing thought signatures to ordering
  conflicts.
