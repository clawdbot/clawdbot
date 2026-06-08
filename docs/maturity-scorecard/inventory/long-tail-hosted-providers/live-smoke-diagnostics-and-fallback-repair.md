---
title: "Long-tail hosted providers - Provider Diagnostics and Fallback Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Provider Diagnostics and Fallback Repair Maturity Note

## Summary

Live smoke, diagnostics, and fallback repair is Alpha. OpenClaw has useful live
test layers, auth probes, provider status buckets, and fallback behavior, but
the proof is opt-in, credential-dependent, and scattered across direct model,
Gateway, media, and provider-specific suites.

## Category Scope

This note covers direct live provider/model smoke, Gateway live profile smoke,
`models status --probe`, auth/status buckets, provider fallback behavior,
model-not-found handling, timeout diagnosis, and operational repair clues for
long-tail hosted providers.

Out of scope: non-provider channel diagnostics, plugin install lifecycle repair,
and local-only model runtimes.

## Features

- Direct provider smoke: Covers Direct provider smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Gateway live smoke: Covers Gateway live smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Models status probes: Covers Models status probes across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Fallback trace and repair: Covers Fallback trace and repair across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals:
  - Live docs split direct model completion from full Gateway+agent smoke.
  - Gateway live smoke supports provider filters, smoke mode, profile-key mode, tool probes, image probes, and timeout controls.
  - `models status --probe` documents real provider probes and status buckets.
  - Media live harness runs shared image, music, and video live suites.
  - Provider-specific live tests exist for selected hosted text, media, and audio providers.
- Negative signals:
  - Live tests are opt-in and depend on keys, accounts, and provider availability.
  - Docs explicitly avoid a fixed CI model list.
  - Fallback and diagnostic evidence is distributed across many suites and user reports rather than one long-tail provider release lane.

## Quality Score

- Score: `Alpha (60%)`
- Good qualities:
  - Diagnostics distinguish direct provider/model failure from Gateway+agent pipeline failure.
  - Probe buckets separate auth, rate limit, billing, timeout, format, unknown, and no-model cases.
  - Gateway smoke configuration can force profile-key mode and narrow providers/models for focused debugging.
  - Archive history shows fallback, timeout, and auth failures are visible enough to diagnose.
- Bad qualities:
  - Operator experience still requires knowing which diagnostic lane maps to which provider family.
  - Fallback-chain behavior can surprise users when a selected model fails and a fallback provider takes over.
  - Provider readiness can fail for account-specific model availability, bad base URLs, missing auth, quotas, and upstream timeouts.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Direct provider smoke, Gateway live smoke, Models status probes, Fallback trace and repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a single hosted-provider release smoke manifest with one curated model or
  capability per provider family.
- Add fallback trace UX that shows selected model, first failure, fallback model,
  and whether fallback was user-configured or automatic.
- Add provider diagnostics that link auth bucket, model bucket, and last live
  smoke evidence.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:58`: live model smoke has two layers, direct model and Gateway smoke.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:62`: direct model tells whether the provider/model can answer with the given key.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:63`: Gateway smoke proves the full gateway+agent pipeline.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:94`: Gateway smoke spins up an in-process Gateway.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:98`: Gateway smoke iterates models-with-keys and asserts meaningful responses, tool invocation, extra tool probes, and OpenAI regression paths.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:374`: docs state there is no fixed CI model list.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:573`: media live harness runs shared image, music, and video suites.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:37`: `models status --probe` runs real provider requests.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:138`: probe buckets include `ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, and `no_model`.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:66`: Gateway live test supports ZAI fallback and profile-key precedence.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:69`: Gateway live test supports provider filtering through `OPENCLAW_LIVE_GATEWAY_PROVIDERS`.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:70`: Gateway live smoke mode is controlled by `OPENCLAW_LIVE_GATEWAY_SMOKE`.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:75`: extra tool and image probes are disabled in smoke mode.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:120`: Gateway live suite is gated by `OPENCLAW_LIVE_GATEWAY`.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:3034`: Gateway live suite runs meaningful prompts across models with available keys.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:3039`: Gateway live suite logs provider selection and loads config before preparing models.

### Integration tests

- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:67`: direct model live test is `src/agents/models.profiles.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:94`: Gateway live test is `src/gateway/gateway-models.profiles.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:467`: image live test is `test/image-generation.runtime.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:514`: music live test is `extensions/music-generation-providers.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:538`: video live test is `extensions/video-generation-providers.live.test.ts`.
- `/Users/kevinlin/code/openclaw/extensions/deepseek/deepseek.live.test.ts:80`: provider-specific live test covers DeepSeek assistant text.
- `/Users/kevinlin/code/openclaw/extensions/together/together.live.test.ts:47`: provider-specific live test covers Together catalog models.
- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/elevenlabs.live.test.ts:27`: provider-specific live test covers ElevenLabs speech.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/model-selection.test.ts:933`: unit coverage overlays configured provider metadata and aliases onto catalog entries.
- `/Users/kevinlin/code/openclaw/src/agents/model-selection.test.ts:1289`: unit coverage applies provider metadata and aliases to synthetic allowlist entries.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:1751`: unit coverage preserves media-understanding and generation provider metadata.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:2142`: unit coverage avoids promoting legacy top-level capability fields into contracts.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "provider fallback error timeout auth missing model"` returned #84384, #81213, #87744, #79380, and #86567.
- #81213 reports OpenAI primary timeouts and inconsistent fallback trace behavior, an adjacent fallback diagnostic concern.
- `gitcrawl --json search prs -R openclaw/openclaw "provider fallback error timeout auth missing model"` returned PRs including #84867, #62682, #44167, #81834, #86670, and #87141.
- #84867 is relevant because it allows a user-switched model to use the agent fallback chain.
- #62682 is relevant because it distinguishes terminal aborts from retryable failures.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "provider fallback error timeout auth missing model" --limit 5` returned model-not-found logs with primary quota exceeded, missing auth, unreachable local provider, context truncation, timeout, retries exhausted, and fallback to OpenAI Codex.
- The same Discrawl search returned a bot error where all models failed, including timeouts and 401 auth on `minimax-portal`.
- The same Discrawl search returned guidance for a user whose selected Kimi model immediately failed over to Cerebras/ZAI, including checking `/model status` and logs for 401/429/timeout/bad base URL.
