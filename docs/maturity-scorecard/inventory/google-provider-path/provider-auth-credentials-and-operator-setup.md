---
title: "Google provider path - Provider Setup and Credentials Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Provider Setup and Credentials Maturity Note

## Summary

Google provider auth is broad: direct API keys, Gemini CLI OAuth, Vertex ADC,
provider setup metadata, web-search fallback, realtime fallback, and daemon env
guidance are all documented or implemented. Coverage is Beta because docs and
source are strong, but full setup-path proof across all credential types is
thin. Quality is Beta because auth handling is explicit, yet archive evidence
shows users still confuse env files, stale custom-provider config, provider
profiles, billing/quota projects, and runtime selection.

## Category Scope

Included in this category:

- API key onboarding: Covers API key onboarding across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Auth choice metadata: Covers Auth choice metadata across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Gemini CLI OAuth setup: Covers Gemini CLI OAuth setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Vertex ADC setup: Covers Vertex ADC setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Daemon and fallback credentials: Covers Daemon and fallback credentials across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- CLI runtime selection: Covers CLI runtime selection across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth login and refresh: Covers OAuth login and refresh across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- Canonical Google model refs: Covers Canonical Google model refs across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- CLI usage normalization: Covers CLI usage normalization across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth diagnostics: Covers OAuth diagnostics across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.

## Features

- API key onboarding: Covers API key onboarding across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Auth choice metadata: Covers Auth choice metadata across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Gemini CLI OAuth setup: Covers Gemini CLI OAuth setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Vertex ADC setup: Covers Vertex ADC setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Daemon and fallback credentials: Covers Daemon and fallback credentials across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- CLI runtime selection: Covers CLI runtime selection across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth login and refresh: Covers OAuth login and refresh across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- Canonical Google model refs: Covers Canonical Google model refs across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- CLI usage normalization: Covers CLI usage normalization across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth diagnostics: Covers OAuth diagnostics across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docs cover direct API key, Gemini CLI OAuth, realtime, web
  search, and daemon env setup; source declares setup providers, config fields,
  auth choices, env vars, ADC fallback paths, and per-adapter fallback.
- Negative signals: Setup proof is distributed across docs, unit tests, and
  live profile flows rather than a single full setup matrix.
- Integration gaps: No dedicated end-to-end setup suite was found that verifies
  all Google auth choices from onboarding through Gateway restart and model
  dispatch.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: #79585 reports Gemini CLI OAuth profile ignored when a
  direct Gemini key is present; #84804 reports Vertex 404s despite direct curl
  success; #64129 reports paid Google Gemini key configuration implicitly
  turning existing heartbeat traffic into paid background usage.
- Discrawl reports: `Google provider auth setup GEMINI_API_KEY` found setup
  threads where `Missing auth - google`, stale `google/models/...` entries,
  shell-env status, env-file placement, and quota project identification were
  all mixed together.
- Good qualities: Auth env vars, setup metadata, credential precedence, OAuth
  formatting, ADC handling, and daemon-env guidance are explicit and mostly
  provider-owned.
- Bad qualities: Operators must choose among API keys, auth profiles, CLI OAuth,
  Vertex ADC, and adapter-specific config, and the product still surfaces
  confusing partial states.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for API key onboarding, Auth choice metadata, Gemini CLI OAuth setup, Vertex ADC setup, Daemon and fallback credentials, CLI runtime selection, OAuth login and refresh, Canonical Google model refs, CLI usage normalization, OAuth diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Setup UX still needs clearer separation between direct Gemini API keys,
  Gemini CLI OAuth, and Vertex ADC.
- Stale custom-provider config can present as Google auth/model failures.
- Daemon environment setup is documented but easy to misconfigure.
- Billing/quota project identity remains a support issue for Google keys.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:14` documents
  `GEMINI_API_KEY` and `GOOGLE_API_KEY`.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:19` documents
  getting-started setup for API key and Gemini CLI OAuth.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:70` warns about
  Gemini CLI OAuth restrictions.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:151` documents web
  search credential fallback.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:353` documents
  realtime credential fallback.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:451` documents daemon
  environment setup for `GEMINI_API_KEY`.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:61` documents
  provider key rotation and Google fallback env vars.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/openclaw.plugin.json:587`
  declares Google provider setup metadata, env vars, ADC fallback paths, and CLI
  backends.
- `/Users/kevinlin/code/openclaw/extensions/google/openclaw.plugin.json:620`
  declares provider auth choices and Google config fields.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-contract-api.ts:5`
  defines direct Google provider setup shape.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-contract-api.ts:31`
  defines Google Vertex provider setup shape and env vars.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-contract-api.ts:47`
  defines Gemini CLI provider setup shape.
- `/Users/kevinlin/code/openclaw/extensions/google/gemini-auth.ts:3` parses
  OAuth JSON and API-key credentials into Google headers.
- `/Users/kevinlin/code/openclaw/extensions/google/vertex-adc.ts:50` resolves
  ADC credential paths.
- `/Users/kevinlin/code/openclaw/extensions/google/index.ts:196` falls back to
  `GEMINI_API_KEY` and `GOOGLE_API_KEY` for realtime provider config.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:3063`
  loads provider-scoped refs, auth profiles, and model registry for live
  resolution.
- `/Users/kevinlin/code/openclaw/src/agents/models.profiles.live.test.ts:1323`
  runs live model-profile paths with Google/Gemini CLI handling.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:622`
  verifies presence of `OPENAI_API_KEY` and `GEMINI_API_KEY` before realtime
  live smoke.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/setup-api.test.ts:21` covers
  Gemini CLI backend setup metadata.
- `/Users/kevinlin/code/openclaw/extensions/google/web-search-provider.test.ts:88`
  covers missing API-key diagnostics.
- `/Users/kevinlin/code/openclaw/extensions/google/web-search-provider.test.ts:104`
  covers `GEMINI_API_KEY` fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:139`
  covers realtime config fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:718`
  covers Vertex ADC source detection.
- `/Users/kevinlin/code/openclaw/src/llm/env-api-keys.test.ts:52` covers
  Vertex ADC detection.

### Gitcrawl queries

Query: `gitcrawl search issues "Google provider auth setup GEMINI_API_KEY" -R openclaw/openclaw --state all`

Results:

- #79585 `google-gemini-cli OAuth profile is ignored for canonical google/* models when GEMINI_API_KEY is present`.
- #84804 `google-vertex provider returns 404 from Google when models are accessed via openclaw agent`.
- #64129 `Configuring a paid Google Gemini key implicitly turned existing heartbeat traffic into paid background usage`.

Query: `gitcrawl search issues "Gemini CLI OAuth google-gemini-cli" -R openclaw/openclaw --state all`

Results:

- Returned additional OAuth proxy, provider-profile, security, and setup
  reports for the Gemini CLI route.

### Discrawl queries

Query: `discrawl search --limit 5 "Google provider auth setup GEMINI_API_KEY"`

Results:

- Returned setup guidance for `openclaw onboard --auth-choice gemini-api-key`,
  `openclaw gateway restart`, `openclaw models status`, and
  `openclaw models list --provider google`.
- Returned support threads where `Missing auth - google`, `Shell env: off`,
  stale `google/models/...` rows, and `GEMINI_API_KEY` env-file placement were
  mixed together.
- Returned quota/billing guidance to inspect the Google AI Studio project tied
  to the active key source.
