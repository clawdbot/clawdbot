---
title: "OpenAI / Codex provider path - Codex Oauth Profiles and Subscription Usage Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Codex Oauth Profiles and Subscription Usage Maturity Note

## Summary

Codex OAuth and subscription usage have substantial implementation support: browser OAuth, device-code login, API-key backup, profile id repair, account-id extraction, external CLI discovery, profile cooldowns, and WHAM usage probing are all represented in source and docs. Coverage is Beta rather than Stable because many flows are hard to exercise without live accounts and quota states. Quality is Alpha because archived support traffic shows recurring confusion around multiple accounts, cooldowns, provider names, and whether a request is billed against ChatGPT/Codex subscription or OpenAI Platform credits.

## Category Scope

This category covers `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.

## Features

- Codex OAuth Profiles: Covers Codex OAuth Profiles across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Subscription Usage: Covers Subscription Usage across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (79%)`
- Positive signals: Docs provide direct commands for OAuth login, device-code login, auth order, status/probe, and recovery; source covers auth store repair, token refresh, WHAM usage probes, and env isolation.
- Negative signals: Live proof for usage limits, multiple ChatGPT accounts, and account-context mismatch is inherently account-specific and not part of a single standard release lane.
- Integration gaps: More live/probe evidence is needed for profile rotation through subscription limits and for browser/device-code parity on headless hosts.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: The first auth-specific query returned no rows, but the route/doctor query returned multiple auth-adjacent issues including #83223 and #84252.
- Discrawl reports: Threads from 2026-04-18, 2026-03-12, 2026-02-25, and 2026-02-20 discuss multiple `openai-codex` accounts, usage/rate-limit windows, account-id mismatch, cooldown/disabled states, and provider/model mismatch.
- Good qualities: Cooldown and usage handling are explicit and source-owned; docs give status and auth-order commands instead of hiding the state.
- Bad qualities: Users still need to understand profile ids, account ids, subscription windows, Platform billing, and runtime selection to debug failures.
- Excluded from quality: Test quantity and test type were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (79%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Codex OAuth Profiles, Subscription Usage.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- `models status --probe` output needs to keep distinguishing auth provider, runtime, account id, and billing bucket.
- Multiple-account fallback needs clearer operator proof and fewer manual interpretation steps.
- OAuth profile repair has a visible archive history of partial sidecar and stale-profile failures.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents Codex OAuth, device-code login, profile id use, auth-order examples, status/probe commands, and account/billing caveats.
- `/Users/kevinlin/code/openclaw/docs/concepts/oauth.md` documents OAuth profile semantics for providers.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness-reference.md` documents auth precedence and environment isolation for local stdio app-server launches.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-provider.ts` registers OAuth, device-code, and API-key backup auth methods, profile id repair metadata, usage fetching, and token refresh.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-openai-codex-oauth.ts` bridges the OpenAI plugin auth hook to legacy OAuth callers.
- `/Users/kevinlin/code/openclaw/src/llm/utils/oauth/openai-codex.ts` implements legacy OAuth login and refresh bridging.
- `/Users/kevinlin/code/openclaw/src/llm/utils/oauth/openai-codex-jwt.ts` extracts the `chatgpt_account_id` from Codex JWTs.
- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/usage.ts` probes WHAM usage and applies cooldown/blocked state for `openai-codex` failures.
- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/repair.ts` repairs legacy `openai-codex:default` OAuth profile ids.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.run-embedded-agent.auth-profile-rotation.e2e.test.ts` covers auth-profile rotation and cooldown behavior in embedded runs.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers auth-aware model-list behavior.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-auth-profiles-oauth-policy.test.ts` covers runtime OAuth policy boundaries.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-oauth-flow.runtime.test.ts` covers OpenAI Codex OAuth flow behavior.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-device-code.test.ts` covers device-code login behavior.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-auth-identity.test.ts` covers identity extraction from Codex auth.
- `/Users/kevinlin/code/openclaw/src/llm/utils/oauth/openai-codex.test.ts` covers OAuth helper behavior.
- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/usage.test.ts` covers usage and cooldown state.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "openai-codex oauth auth.order usage limit wham profile"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks, not positive Quality evidence.

Query: `gitcrawl --json search issues -R openclaw/openclaw "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned auth-adjacent open issues #83223 and #84252 about migrated `openai/gpt-5.5` still looking up `openai-codex` auth before fallback and OAuth sidecar auth remaining partially repaired.

### Discrawl queries

Query: `discrawl search --limit 10 "openai-codex oauth auth order usage limit profile"`

Results:

- Returned discussions on multiple `openai-codex` accounts, profile order, session-stickiness, `weekly/monthly limit reached`, account-id mismatch, and cooldown/disabled profile states.

Query: `discrawl search --limit 10 "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned a 2026-05-17 discussion where `openai/gpt-5.5` could reach direct OpenAI Responses when stale runtime/auth pins were present, plus notes that doctor should repair `openai-codex/*`, stale runtime pins, and provider/model/auth pins.
