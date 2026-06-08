---
title: "Google provider path - Vertex AI and Custom Endpoints Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Vertex AI and Custom Endpoints Maturity Note

## Summary

Vertex AI and custom Google-compatible endpoint support is implemented, but it
is the weakest part of the Google provider path. Source code handles
`google-vertex` registration, ADC/service-account auth, Vertex URL
construction, bearer headers, and custom base URL policy. Coverage is Alpha
because live proof is mostly adjacent native Google behavior rather than real
Vertex ADC/service-account calls. Quality is Alpha because archive evidence has
active Vertex routing, ADC setup, 404, and OpenAI-compatible Gemini failures.

## Category Scope

This category covers `google-vertex`, Vertex ADC/service-account auth,
project/location endpoint construction, custom Google-compatible base URL
handling, and Gemini/OpenAI-compatible endpoint boundaries. It excludes Gemini
CLI OAuth and direct Google API-key behavior except where shared transport
logic is reused by Vertex.

## Features

- Vertex provider selection: Covers Vertex provider selection across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- ADC/service-account auth: Covers ADC/service-account auth across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Project/location endpoints: Covers Project/location endpoints across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Custom base URL policy: Covers Custom base URL policy across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Compatibility boundaries: Covers Compatibility boundaries across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Unit/runtime-flow coverage exists for ADC detection, bearer
  auth, Vertex SSE request construction, Windows ADC fallback, and custom
  baseUrl normalization; broader live provider tests include Google model-ref
  parsing.
- Negative signals: No dedicated live/e2e proof was found for real
  `google-vertex` ADC/service-account calls against Vertex AI.
- Integration gaps: Custom Google-compatible endpoints have config and unit
  evidence, but no uniform live compatibility matrix.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: #58775 reports `google-vertex` merging into the Google
  transport path; #84804 reports Vertex returning 404 through `openclaw agent`
  while direct curl works; #84384 reports Vertex OpenAI-compatible streaming
  timeout around thinking tokens.
- Discrawl reports: `google-vertex Vertex AI` and `Vertex AI ADC google-vertex`
  searches found setup failures around `No API key found for provider
"google-vertex"`, ADC marker regressions, and repeated clarification that
  Vertex uses ADC/service-account auth rather than Gemini API keys.
- Good qualities: Source separates Vertex URL construction, ADC path
  resolution, token caching, base URL normalization, and request header
  generation.
- Bad qualities: The product path still has active routing and auth confusion,
  and custom endpoint support depends on careful boundary classification.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Vertex provider selection, ADC/service-account auth, Project/location endpoints, Custom base URL policy, Compatibility boundaries.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Real Vertex ADC/service-account dispatch needs dedicated live proof.
- Vertex docs are sparse compared with direct Google and Gemini CLI docs.
- Per-model location, project, and custom endpoint examples are thin.
- Archive evidence shows users still confuse `google` API-key auth with
  `google-vertex` ADC/service-account auth.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/reference/google.md:10` says the
  Google plugin includes Google, Gemini CLI, and Google Vertex model providers.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:217`
  identifies `google-vertex` and says Vertex uses gcloud ADC.
- `/Users/kevinlin/code/openclaw/docs/tools/gemini-search.md:101` documents
  Gemini web-search base URL overrides for custom Gemini-compatible endpoints.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:686`
  documents OpenAI-compatible proxy shaping and exact-origin trust rules.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/provider-registration.ts:60`
  routes `google-vertex` models to `createGoogleVertexTransportStreamFn`.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-contract-api.ts:31`
  declares `google-vertex` provider and required env vars.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:332`
  resolves Vertex project/location and request origin.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:384`
  builds the Vertex `streamGenerateContent?alt=sse` URL.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.ts:764`
  builds Vertex auth headers from ADC marker or API key.
- `/Users/kevinlin/code/openclaw/extensions/google/vertex-adc.ts:118`
  supports `authorized_user`, `external_account`, and `service_account` ADC.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-policy.ts:40`
  normalizes Google base URLs and strips `/openai` only for native Gemini paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:121`
  live-tests native Gemini web-search provider execution.
- `/Users/kevinlin/code/openclaw/src/agents/google-gemini-switch.live.test.ts:12`
  live-tests native Google model runs with tool-call history.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:2019`
  includes live model-ref parser coverage for `google`, `google-gemini-cli`,
  and `google-vertex`.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:718`
  covers ADC source detection.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:758`
  covers Google Auth bearer headers and Vertex SSE request flow.
- `/Users/kevinlin/code/openclaw/extensions/google/transport-stream.test.ts:871`
  covers Windows APPDATA ADC fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/api.test.ts:109` preserves
  OpenAI-compatible Vertex `baseUrl`.
- `/Users/kevinlin/code/openclaw/src/llm/env-api-keys.test.ts:52` detects
  Vertex ADC and avoids caching misses.

### Gitcrawl queries

Query: `gitcrawl search issues "Google Vertex ADC google-vertex" -R openclaw/openclaw --state all`

Results:

- #58775 `google-vertex provider merged into google transport path`.
- #84804 `google-vertex provider returns 404 from Google when models are accessed via openclaw agent`.
- #84384 `Gemini 2.5 Flash via vertex-ai streaming times out`.

Query: `gitcrawl search issues "OpenAI-compatible Gemini" -R openclaw/openclaw --state all`

Results:

- Returned #84384 on Vertex AI OpenAI-compatible streaming timeout and thinking
  token handling.

### Discrawl queries

Query: `discrawl search --limit 10 "google-vertex Vertex AI"`

Results:

- Found setup failures with `No API key found for provider "google-vertex"` and
  archive comments around ADC sentinel regressions.

Query: `discrawl search --limit 10 "Vertex AI ADC google-vertex"`

Results:

- Found repeated ADC-marker/auth regression reports and guidance that
  `google-vertex/*` uses ADC/service account rather than Gemini API keys.

Query: `discrawl search --limit 10 "Gemini compatible endpoint baseUrl"`

Results:

- Found OpenAI-compatible Gemini endpoint schema/limit failures, zero-token
  reports, and baseUrl-related fixes and requests.
