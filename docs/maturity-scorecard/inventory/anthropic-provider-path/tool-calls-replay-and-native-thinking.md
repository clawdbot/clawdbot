---
title: "Anthropic provider path - Tools and Thinking Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Tools and Thinking Maturity Note

## Summary

Anthropic tool-call and native-thinking handling is broad: OpenClaw converts
tools to Anthropic schemas, maps Claude Code tool names under OAuth, preserves
signed/redacted thinking, sanitizes malformed replay, handles tool result media,
and maps thinking levels to provider effort. Coverage is Stable because source
and tests cover the key transformations and live replay. Quality is Beta
because archived incidents show tool-call streaming and thinking replay have
been frequent regression points.

## Category Scope

This category covers Anthropic-specific turn semantics inside agent runs:
tool declarations, tool-use block conversion, tool-result conversion,
tool-call id normalization, partial JSON handling, Claude Code tool-name
mapping, native thinking blocks, redacted thinking, signed thinking replay,
thinking effort/defaults, and turn validation for replay.

## Features

- Tool-use blocks: Covers Tool-use blocks across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Tool-result replay: Covers Tool-result replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Partial JSON recovery: Covers Partial JSON recovery across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Native thinking: Covers Native thinking across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Signed/redacted thinking replay: Covers Signed/redacted thinking replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Source handles native Anthropic thinking, signed/redacted thinking replay, tool schema conversion, tool-result grouping, image tool results, Claude Code tool aliases, partial-json scratch cleanup, and replay validation; tests cover signed thinking, tool-use replay, malformed tool args, and live tool replay.
- Negative signals: Several cases are covered by focused tests and env-gated live tests rather than always-on end-to-end Anthropic tool scenarios.
- Integration gaps: Full live tool-call scenario proof is limited by `ANTHROPIC_LIVE_TEST` and provider credentials.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: #60593 tracks recurring Anthropic streaming JSON parse errors; PR #68565 preserves signed/redacted thinking blocks; PR #70372 suppresses thinking narration leakage; PR #87346 merges consecutive assistant turns in validation; PR #61151 drops `partialJson` streaming artifacts from session history repair.
- Discrawl reports: Discord archive results include session corruption from truncated streaming tool calls, raw parse errors from Anthropic tool-call deltas, and downstream fixes for partial JSON recovery.
- Good qualities: The implementation preserves provider-signed thinking, strips synthetic reasoning from native Anthropic replay, coalesces consecutive tool results, coerces malformed tool-call args, and avoids persisting streaming scratch buffers.
- Bad qualities: Tool-call streaming is one of the highest-churn Anthropic edges because partial JSON, thinking signatures, provider-compatible endpoints, and replay validation interact.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tool-use blocks, Tool-result replay, Partial JSON recovery, Native thinking, Signed/redacted thinking replay.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live proof is strongest for synthetic replay acceptance, not every real tool
  invocation type.
- Tool-call and thinking behavior differs across direct Anthropic and
  Anthropic-compatible providers, increasing maintenance pressure.
- Historical incidents show partial JSON and thinking display can corrupt
  session history or leak confusing text when not carefully normalized.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents Claude 4.6 thinking defaults, `/think` overrides, cache behavior, and media/document handling.
- `/Users/kevinlin/code/openclaw/docs/gateway/cli-backends.md` documents Claude CLI permission mode, `/think` effort mapping, MCP bridge tools, and session behavior.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` covers model/provider behavior that feeds tool and thinking transport choices.

### Source

- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` implements `convertTools`, `convertMessages`, `normalizeToolCallId`, signed/redacted thinking replay, `input_json_delta` accumulation, tool-use blocks, tool-result grouping, and thinking effort request construction.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.ts` implements transport-side tool argument coercion, unsafe integer preservation, reasoning content handling for compatible streams, and native Anthropic thinking replay behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/thinking.ts` wraps Anthropic streams with thinking recovery and blocks duplicate streaming retries after output begins.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/replay-policy.ts` defines Anthropic replay policy including strict tool ids, signature preservation, turn validation, and synthetic tool result allowance.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.anthropic-tool-replay.live.test.ts` env-gates live Anthropic replay acceptance for regular text, omitted reasoning placeholder, and tool-call replay history.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.live.test.ts` covers live stream abort behavior adjacent to tool/thinking streaming.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.test.ts` covers unsafe integer tool-use deltas, OAuth tool-name remapping, signed thinking ingest, multiple signature deltas, reasoning_content compatible replay, malformed tool schemas, malformed tool-call args, empty tool results, image tool results, and thinking effort mapping.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.test.ts` covers signed thinking replay payload preservation.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers replay policy and native reasoning output mode.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/cli-shared.test.ts` covers Claude CLI thinking effort mapping.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "anthropic thinking signature replay cache_control"`

Results:

- Returned no direct results for that exact issue query.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Anthropic thinking"`

Results:

- #70372 suppresses thinking narration leaking into channel messages for Anthropic/Bedrock.
- #68565 preserves signed/redacted thinking blocks.
- #87346 merges consecutive assistant turns in turn validation.
- #85381 emits thinking_delta events and handles redacted single-block shape.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic tool call streaming JSON parse error"`

Results:

- #60593 reports recurring Anthropic streaming JSON parse errors.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic tool call streaming parse JSON"`

Results:

- Returned archived user reports and PR notifications for truncated streaming tool-call corruption, raw parse errors, control-character sanitization, and tool-call argument recovery.

Query: `discrawl search --limit 10 "Anthropic thinking signature cache control"`

Results:

- Returned no direct results for that exact query.
