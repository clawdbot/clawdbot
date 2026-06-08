---
title: "Agent Runtime - Provider Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Provider Auth Maturity Note

## Summary

Provider auth is broad enough to cover setup, selection, health checks, fallback, and operator-facing diagnostics in one category. Docs explain API keys, OAuth, provider/auth-profile fallbacks, status and probe output, stale-route repair, and restart guidance. Source validates provider/profile compatibility, carries fallback candidate state, classifies structured provider failures, and formats missing-key, OAuth-refresh, capacity, and restart recovery guidance. Quality remains Alpha because archive evidence still shows repeated operator failures around Codex OAuth route repair, profile propagation, quota fallback semantics, sticky fallback state, and provider key discovery.

## Category Scope

This category covers provider credentials, auth profile health, and operator-visible provider recovery behavior: login and paste-key flows, provider auth profile selection, doctor and status repair, auth failover, provider fallback chains, quota and capacity recovery, missing-key and OAuth guidance, restart and stale-route hints, structured diagnostics, subagent credential propagation, and credential-related runtime errors.

## Features

- Login and API-key setup: Login, OAuth, and paste-key flows for provider access.
- Auth profile selection: Selecting and validating provider auth profiles.
- Credential health checks: Doctor, status, and related credential health checks and repair signals.
- Auth failover: Same-provider and cross-profile auth fallback behavior.
- Provider fallback recovery: Provider and auth-profile fallback behavior when execution fails.
- Rate-limit and capacity recovery: Recovery paths for quota, capacity, and rate-limit failures.
- Missing-key and OAuth guidance: Operator guidance for missing keys, expired OAuth state, and related auth failures.
- Restart and stale-route recovery: Recovery from stale route state, restart requirements, and related provider drift.
- Structured provider diagnostics: Structured provider errors and diagnostics delivered into logs or agent replies.
- Subagent credential propagation: Propagating provider credentials into subagent and delegated runtime flows.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`

Coverage is strong for OpenAI/Codex, Anthropic, Google, model commands, fallback state, and operator-facing recovery copy, but provider auth and diagnostics still span many flows and are not yet represented by a single end-to-end operator proof matrix.

## Quality Score

- Score: `Alpha (66%)`

Auth/profile behavior remains a frequent operational pain point, especially where Codex OAuth, direct OpenAI API routes, compaction, subagents, doctor repair, and quota fallback behavior overlap.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Login and API-key setup, Auth profile selection, Credential health checks, Auth failover, Provider fallback recovery, Rate-limit and capacity recovery, Missing-key and OAuth guidance, Restart and stale-route recovery, Structured provider diagnostics, Subagent credential propagation.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Codex OAuth route repair still produces recent open GitHub and Discord reports.
- Subagent and compaction flows can lose or reinterpret auth profile state.
- Quota-wide and account-specific provider failures need clearer fallback semantics.
- Recovery from stale `openai-codex` route state still depends on doctor repair and explicit guidance.
- Some missing-key and fallback diagnostics are strong in tests but still too hard for operators to map to root cause.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/cli/models.md` documents model status/auth overview, Codex OAuth troubleshooting, auth profile listing, login, paste-api-key, OpenAI API versus ChatGPT/OAuth, and Claude CLI notes.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents primary model selection, fallbacks, provider auth failover, auto fallback selections, strict user selections, and live model switching.
- `/Users/kevinlin/code/openclaw/docs/cli/agent.md` documents gateway fallback behavior, embedded fallback metadata, gateway timeout fallback session/run id, and SIGTERM/SIGINT `chat.abort`.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents `openai`, `openai-codex`, Codex plugin and `agentRuntime` naming, OpenAI/Codex route selection, Codex OAuth setup, and doctor repair behavior.
- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents API key versus Claude CLI authentication and canonical Anthropic refs with `agentRuntime.id: "claude-cli"`.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md` documents Google plugin auth, Gemini CLI OAuth setup, and warning/alias behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/subagents.md` documents subagent auth resolution by agent id and fallback to main profiles.

### Source

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/model-selection.ts` validates auth profile overrides against accepted auth providers, clears invalid overrides, and handles stale legacy `openai-codex` state.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` carries fallback candidate auth profile state, applies live model switch auth changes, preserves same-provider auth fallback, and drops auth profile ids when switching providers.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.ts` classifies retryable errors and configures timeout/retry behavior for Codex Responses transport.
- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.ts` builds structured failure streams with error details.
- `/Users/kevinlin/code/openclaw/src/commands/auth-choice.apply.api-providers.test.ts` maps API key/token provider choices for auth flows.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers catalog auth/status presentation for providers.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers OAuth refresh failure guidance, missing API key guidance, stale `openai-codex` missing-key failures pointing at doctor repair, auth profile state on retries, provider-switch auth profile dropping, and same-provider auth fallback.
- `/Users/kevinlin/code/openclaw/src/commands/models.set.e2e.test.ts` covers fallback normalization in model command behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/auth-choice.apply.api-providers.test.ts` covers auth choice mapping for API key/token providers.
- `/Users/kevinlin/code/openclaw/src/commands/models.auth.provider-resolution.test.ts` covers provider auth resolution for model commands.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` includes focused auth-profile regression coverage.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-codex-responses.test.ts` covers transport timeouts and websocket/SSE behavior feeding retry decisions.
- `/Users/kevinlin/code/openclaw/src/agents/transport-stream-shared.test.ts` covers failure cleanup and non-empty failure streams.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "No API key found provider openai-codex auth profile"` returned many active issues, including #84252 on doctor/status leaving `openai-codex` OAuth sidecar auth partially repaired, #87677 on memory embeddings through Codex OAuth runtime, #86470 on doctor rewriting `openai-codex/*` to `openai/*`, #85797 on image generation requiring an API key despite OAuth, #86820 on compaction falling back to direct OpenAI API, #87051 on OAuth profile not propagating to subagent sessions, #83223 on migrated routes still looking up `openai-codex` auth before fallback, and #80171 on runtime parity QA.
- `gitcrawl --json search issues -R openclaw/openclaw "openai-codex Anthropic Google provider tool call"` returned #80667 on missing `trajectory.jsonl` for pure `claude-cli` sessions and #78196 on extension plugin loader behavior.
- `gitcrawl --json search issues -R openclaw/openclaw "provider error guidance reauth fallback"` returned no direct matches.
- `gitcrawl --json search issues -R openclaw/openclaw "rate limit fallback usage limit openai-codex"` returned #85103 on model fallback chain not triggering for provider-wide quota exhaustion, #87467 on auto rate-limit fallback staying pinned to fallback after primary recovery, #79604 on rotating auth profiles within a candidate before next provider, and #79611 on active-memory plugin provider failover and timeout.
- `gitcrawl --json search prs -R openclaw/openclaw "provider error descriptors fallback rate limit"` returned #86642 adding structured provider error descriptors.
- `gitcrawl --json search prs -R openclaw/openclaw "agent runner fallback model switch"` returned PRs including #85235 on message-tool-only diagnostics, #80482 on cooldown inline API key billing failures, #62682 on terminal abort versus retryable failures, and #86089 on restart recovery replies.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "No API key found provider openai-codex"` returned May 2026 reports around OpenAI OAuth/Codex routing, plugin errors with `No API key found for provider "openai-codex"`, existing Codex auth no longer recognized after rebuild, direct API routing failures, and users seeing missing OpenAI keys despite Codex OAuth.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "reauth provider auth profile"` returned Codex auth refresh/persistence reports, scope issues, stale auth order, token rotation failures, and older reauth command confusion.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "openai-codex provider routing"` returned maintainer/user notes about auth profile resolution, compaction routing, context config, auth order, stale route state, and doctor repair guidance.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "usage limit fallback openai-codex"` returned discussions about Claude CLI usage/billing fallback losing context, multi-account Codex OAuth failover, OpenAI rate limit auth/provider guidance, Codex backend challenge/limit paths, rate-limit/account-id errors, fallback configs, and model failover being blocked or sticky.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "model fallback decision"` returned recent fallback decision logs for openai-codex timeouts, No API key cases, OpenRouter timeouts, missing bearer errors, Anthropic empty responses, and session repair loops.
