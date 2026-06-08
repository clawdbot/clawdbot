---
title: "Google provider path - Model Routing and Endpoints Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Model Routing and Endpoints Maturity Note

## Summary

Google model catalog and provider-routing support is mature in source and docs:
the bundled plugin declares direct Google, Gemini CLI, and Vertex providers;
normalizes Gemini model aliases; resolves forward-compatible Gemini and Gemma
families; and routes canonical `google/*` model refs through provider-owned
transport policy. Coverage is Stable because runtime-flow and live-provider
evidence exists. Quality remains Beta because archive evidence shows active
confusion around Gemini CLI auth precedence, Vertex/baseUrl routing, preview
alias churn, and OpenAI-compatible Google config.

## Category Scope

Included in this category:

- Catalog rows and aliases: Covers Catalog rows and aliases across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Dynamic model resolution: Covers Dynamic model resolution across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Provider routing: Covers Provider routing across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Google-native config normalization: Covers Google-native config normalization across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Model picker availability: Covers Model picker availability across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Vertex provider selection: Covers Vertex provider selection across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- ADC/service-account auth: Covers ADC/service-account auth across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Project/location endpoints: Covers Project/location endpoints across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Custom base URL policy: Covers Custom base URL policy across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Compatibility boundaries: Covers Compatibility boundaries across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.

## Features

- Catalog rows and aliases: Covers Catalog rows and aliases across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Dynamic model resolution: Covers Dynamic model resolution across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Provider routing: Covers Provider routing across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Google-native config normalization: Covers Google-native config normalization across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Model picker availability: Covers Model picker availability across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Vertex provider selection: Covers Vertex provider selection across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- ADC/service-account auth: Covers ADC/service-account auth across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Project/location endpoints: Covers Project/location endpoints across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Custom base URL policy: Covers Custom base URL policy across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Compatibility boundaries: Covers Compatibility boundaries across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Provider metadata, docs, catalog normalization, model
  forward-compatibility, runtime policy, and gateway model resolution all have
  source evidence; live/runtime-flow tests cover Google model switching,
  provider-scoped refs, and model-profile resolution.
- Negative signals: Gemini CLI OAuth precedence, Vertex location/baseUrl
  variants, and the full operator config matrix are mostly unit- or
  archive-backed rather than proven by dedicated live flows.
- Integration gaps: No single end-to-end test was found that exercises
  `openclaw models list --provider google`, credential/profile selection,
  runtime selection, and dispatch across all three Google provider variants.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: #79585 reports `google-gemini-cli` OAuth ignored for
  canonical `google/*` models when `GEMINI_API_KEY` is present; #81831
  canonicalizes Gemini 3.1 Flash-Lite bare IDs; #84804 reports Vertex 404s from
  `openclaw agent`; #77345 covers SSRF/baseUrl edge behavior.
- Discrawl reports: Archives show current main routes Gemini CLI OAuth through
  canonical `google/*` refs plus `google-gemini-cli` runtime, but also show
  stale custom-provider residue, preview alias confusion, double `/v1beta`
  fixes, and operator failures with `models.providers.google.api =
"openai-completions"`.
- Good qualities: Provider-owned hooks keep Google normalization out of generic
  OpenAI-style paths; base URL handling restricts trusted native Google origins;
  dynamic model resolution centralizes Gemini/Gemma churn.
- Bad qualities: The catalog surface is highly sensitive to upstream model
  churn, auth-profile precedence, and custom endpoint semantics, so regressions
  continue to appear in archives.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Catalog rows and aliases, Dynamic model resolution, Provider routing, Google-native config normalization, Model picker availability, Vertex provider selection, ADC/service-account auth, Project/location endpoints, Custom base URL policy, Compatibility boundaries.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Model catalog aliases need recurring release proof as Gemini preview names
  change.
- Provider/runtime selection is still confusing when `google/*`, legacy
  `google-gemini-cli/*`, Vertex, and custom OpenAI-compatible Google endpoints
  are discussed together.
- The built-in Google provider is not the safest place for arbitrary
  OpenAI-compatible Google-like endpoints; archives point users toward custom
  providers for that path.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:9` documents provider
  id `google`, Gemini API auth, and the `google-gemini-cli` runtime option.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:53` documents
  `openclaw models list --provider google`.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:124` documents
  legacy `google-gemini-cli/*` refs as compatibility aliases.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:51`
  describes provider-owned catalogs, auth mapping, transport/config
  normalization, OAuth refresh, usage reporting, and thinking profiles.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:205`
  documents direct Gemini model refs and Google env-var fallback.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/openclaw.plugin.json:1`
  declares the Google plugin providers and default enablement.
- `/Users/kevinlin/code/openclaw/extensions/google/openclaw.plugin.json:10`
  declares Google, Gemini CLI, and Vertex model ID normalization aliases.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-registration.ts:18`
  registers Google provider hooks, catalog, default model, transport config, and
  stream creation.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-models.ts:137`
  implements forward-compatible Gemini/Gemma model resolution.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-policy.ts:18`
  normalizes Google base URLs and request origins.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/model.ts:1115`
  resolves provider/model refs and plugin dynamic models during agent routing.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.set.e2e.test.ts:124`
  covers retired Google Gemini preview ref normalization.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:906`
  normalizes retired Google Gemini refs before targeted lookup.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:3063`
  loads provider-scoped refs, auth profiles, and model registry for live
  resolution.
- `/Users/kevinlin/code/openclaw/src/agents/google-gemini-switch.live.test.ts:12`
  exercises live Gemini model switching and Google transport shape.
- `/Users/kevinlin/code/openclaw/test/image-generation.infer-cli.live.test.ts:24`
  runs live Google image generation through a Google model ref.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/api.test.ts:14` covers
  Google transport ID, base URL normalization, and provider config detection.
- `/Users/kevinlin/code/openclaw/extensions/google/api.test.ts:175` covers
  request config hardening and HTTP/non-Google base URL rejection.
- `/Users/kevinlin/code/openclaw/extensions/google/manifest.test.ts:64` covers
  retired-model suppression and Google alias normalization.
- `/Users/kevinlin/code/openclaw/extensions/google/provider-models.test.ts:41`
  covers Gemini CLI, direct Google, and Vertex forward compatibility.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-runtime.test.ts:1312`
  covers provider hook model/config normalization.

### Gitcrawl queries

Query: `gitcrawl search issues "google-gemini-cli model ref gemini 3.1 pro" -R openclaw/openclaw --state all`

Results:

- #79585 `google-gemini-cli OAuth profile is ignored for canonical google/* models when GEMINI_API_KEY is present`.
- #84527 `Add Antigravity CLI as google-antigravity provider and replace deprecated google-gemini-cli usage`.

Query: `gitcrawl search prs "google provider model catalog normalization" -R openclaw/openclaw --state all`

Results:

- #81831 `fix(google): canonicalize Gemini 3.1 Flash-Lite bare id`.

Query: `gitcrawl search issues "Google provider baseUrl" -R openclaw/openclaw --state all`

Results:

- #77345 covers Google provider SSRF/baseUrl edge behavior.
- #84804 reports Vertex 404s despite direct curl success.

### Discrawl queries

Query: `discrawl search --limit 5 "google-gemini-cli canonical google model"`

Results:

- Returned maintainer guidance that current main routes Gemini CLI OAuth through
  canonical `google/*` refs plus the `google-gemini-cli` runtime, while legacy
  refs remain aliases.

Query: `discrawl search --limit 5 "gemini 3 pro preview model normalization"`

Results:

- Returned archive notes about `gemini-3.1-pro-preview` normalization, Vertex
  normalization, stale conflicting alias proposals, and user 404 confusion
  around bundled catalog allowlists.

Query: `discrawl search --limit 5 "models.providers.google api openai-completions"`

Results:

- Returned operator confusion and failures when using an OpenAI-compatible
  endpoint under the built-in `google` provider instead of a custom provider.
