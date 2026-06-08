---
title: "OpenRouter provider path - Provider Recovery and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Provider Recovery and Diagnostics Maturity Note

## Summary

OpenRouter failure handling has explicit model-fallback classification, provider-scoped `Provider returned error` handling, budget/key-limit cases, context-overflow parsing, status/pricing warnings, and guarded fetch policy tests. Coverage is Beta because several important error classes have direct tests, but the complete operator journey across gateway, WebChat, cron, and model fallback is not uniformly exercised.

Quality is Alpha because live archives show active or recent OpenRouter-specific confusion around Retry-After stalls, context overflow, empty UI polling after 429/timeout, and generic provider errors.

## Category Scope

Included in this category:

- Timeout/retry classification: Covers Timeout/retry classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Auth/billing/key-limit classification: Covers Auth/billing/key-limit classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Context overflow: Covers Context overflow across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Model fallback notices: Covers Model fallback notices across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Guarded fetch/pricing warnings: Covers Guarded fetch/pricing warnings across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.

## Features

- Timeout/retry classification: Covers Timeout/retry classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Auth/billing/key-limit classification: Covers Auth/billing/key-limit classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Context overflow: Covers Context overflow across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Model fallback notices: Covers Model fallback notices across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Guarded fetch/pricing warnings: Covers Guarded fetch/pricing warnings across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Tests cover OpenRouter API-key budget limit fallback, legacy cooldown marker handling, provider-scoped error context, guarded OpenRouter fetch URLs, context-overflow regexes, and status/pricing warning output.
- Negative signals: Error behavior crosses agent fallback, gateway status, WebChat, cron, provider fetch, and upstream OpenRouter responses; release-level scenario proof is fragmented.
- Integration gaps: Add end-to-end failure smokes for OpenRouter `Retry-After`, context overflow, invalid key, billing/key-limit, and `Provider returned error` with a configured fallback chain.

## Quality Score

- Score: `Alpha (65%)`
- Gitcrawl reports: The broad OpenRouter query returned #83651 on Retry-After stalling fallback, #86880 on OpenRouter context overflow, #87170 on `Provider returned error` with `auto`, #79803 on WebChat polling after provider 429/idle timeout, and #68066 on usage/cost mismatch.
- Discrawl reports: Discord search found fallback and timeout discussions, including OpenRouter provider timeout in cron isolated sessions, provider-error classification review comments, and guidance to keep non-OpenRouter fallbacks for resilience.
- Good qualities: Current docs and tests show provider-scoped handling instead of generic matching, context overflow detection, and degraded pricing-source warnings.
- Bad qualities: Users still encounter generic error messages that require log inspection, session resets, provider-specific interpretation, or fallback-policy knowledge.
- Excluded from quality: Error-path test breadth and coverage of fallback permutations are Coverage inputs only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Timeout/retry classification, Auth/billing/key-limit classification, Context overflow, Model fallback notices, Guarded fetch/pricing warnings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Provider-side Retry-After and timeout behavior can still stall or confuse fallback chains.
- Generic OpenRouter upstream text must be classified without mislabeling auth and billing errors as retryable.
- Gateway/WebChat diagnostics can lag behind the actual provider failure, making UI behavior appear empty or stuck.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/model-failover.md` documents OpenRouter-specific `Provider returned error` timeout classification and scoped key-limit/billing handling.
- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents OpenRouter setup, base URL, auth, model selection, and routing details operators need during diagnosis.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md` documents status/probe behavior for configured providers.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/model-fallback.ts` implements model fallback behavior across providers.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-helpers/errors.ts` contains provider/error classification used by embedded runs.
- `/Users/kevinlin/code/openclaw/src/llm/utils/overflow.ts` recognizes OpenRouter maximum-context-length messages.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts` builds guarded fetch behavior for OpenRouter endpoints.
- `/Users/kevinlin/code/openclaw/src/gateway/model-pricing-cache.ts` records OpenRouter pricing-fetch failures as degraded status instead of hard failure.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/model-fallback.run-embedded.e2e.test.ts` exercises fallback behavior through embedded runs.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers model-list/status behavior through command surfaces.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates real OpenRouter completion and cache behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/model-fallback.test.ts` covers OpenRouter API-key budget limit errors, OpenRouter fallback attempts, and legacy cooldown marker behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/helpers.resolve-error-context.test.ts` verifies OpenRouter provider/model error context.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.test.ts` covers guarded OpenRouter fetch and endpoint policy.
- `/Users/kevinlin/code/openclaw/src/commands/gateway-status.test.ts` and `/Users/kevinlin/code/openclaw/src/commands/status-json-payload.test.ts` cover OpenRouter pricing-fetch degraded warnings.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter timeout Provider returned error context length key limit exceeded"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "provider returned error"`

Results:

- Returned #87170 on `Provider returned error` with auto model, #79803 on provider 429/idle timeout with WebChat polling, #83225 on model failover not working on billing error, and several adjacent provider-error/fallback issues.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #83651 on OpenRouter Retry-After fallback stall and #86880 on OpenRouter context overflow.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter Provider returned error timeout"`

Results:

- Found OpenRouter provider-timeout reports in cron isolated sessions, failover-classification PR review discussion, and support guidance that `Provider returned error` and transport drops should classify into retry/fallback behavior without swallowing auth or billing failures.
