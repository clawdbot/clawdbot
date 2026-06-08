---
title: "Google provider path - Media, Search, and Realtime Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Media, Search, and Realtime Maturity Note

## Summary

The Google plugin is broadly distributed and registers more than the text model
path: image generation, media understanding, memory embedding, music generation,
realtime voice, speech/TTS, video generation, and web search. Coverage is Stable
because docs, manifest, provider registration, live tests, and many adapter unit
tests cover the surface. Quality is Stable at the shared boundary because the
adapter code is explicit and provider-owned, but the surface is fragmented
across many capabilities and archive searches did not produce one consolidated
adapter quality thread.

## Category Scope

Included in this category:

- Bundled plugin distribution: Covers Bundled plugin distribution across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Provider auto-enable metadata: Covers Provider auto-enable metadata across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Image and media adapters: Covers Image and media adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Speech and realtime adapters: Covers Speech and realtime adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Search and generation tools: Covers Search and generation tools across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Realtime voice sessions: Covers Realtime voice sessions across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Constrained browser tokens: Covers Constrained browser tokens across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Audio and transcript events: Covers Audio and transcript events across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Live tool calls: Covers Live tool calls across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Session reconnects: Covers Session reconnects across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.

## Features

- Bundled plugin distribution: Covers Bundled plugin distribution across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Provider auto-enable metadata: Covers Provider auto-enable metadata across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Image and media adapters: Covers Image and media adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Speech and realtime adapters: Covers Speech and realtime adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Search and generation tools: Covers Search and generation tools across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Realtime voice sessions: Covers Realtime voice sessions across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Constrained browser tokens: Covers Constrained browser tokens across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Audio and transcript events: Covers Audio and transcript events across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Live tool calls: Covers Live tool calls across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Session reconnects: Covers Session reconnects across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`
- Positive signals: The plugin package, manifest, docs reference, capability
  registration, live Google tests, and adapter-specific unit tests cover a wide
  set of Google surfaces.
- Negative signals: Capability proof is fragmented across many adapters rather
  than a single release matrix.
- Integration gaps: Archive and test evidence is stronger per adapter than for
  the bundled plugin as a cross-surface product.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: Exact issue and PR searches for `google plugin provider
image generation web search speech` returned no direct results.
- Discrawl reports: `@openclaw/google-plugin capability adapters` returned no
  results; `Google Gemini web search image generation provider` returned an
  adjacent custom-provider/openrouter support thread but no direct bundled
  Google adapter defect.
- Good qualities: The plugin uses a manifest, provider-owned lazy registration,
  explicit capability contracts, fallback credential handling, and adapter-local
  source files instead of a monolithic Google implementation.
- Bad qualities: The product surface is spread across many capability adapters,
  so release validation and operator debugging can become fragmented.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bundled plugin distribution, Provider auto-enable metadata, Image and media adapters, Speech and realtime adapters, Search and generation tools, Realtime voice sessions, Constrained browser tokens, Audio and transcript events, Live tool calls, Session reconnects.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No single Google plugin adapter matrix was found that proves all bundled
  capabilities together.
- Google adapter docs are split between the provider page and plugin reference.
- Capability-specific credentials and model defaults can drift independently of
  the direct text provider path.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/reference/google.md:8` documents
  the Google plugin summary and package.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference/google.md:19` lists
  provider IDs and capability contracts for the Google plugin.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:131` lists supported
  Google capabilities, including chat, image, music, TTS, realtime voice, media
  understanding, web search, thinking, and Gemma.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:194` documents image
  generation.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:222` documents video
  generation.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:250` documents music
  generation.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:280` documents TTS.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/package.json:2` declares the
  package `@openclaw/google-plugin`.
- `/Users/kevinlin/code/openclaw/extensions/google/package.json:14` declares the
  OpenClaw extension entrypoint.
- `/Users/kevinlin/code/openclaw/extensions/google/openclaw.plugin.json:1`
  declares plugin id `google`, default enablement, providers, catalog entry, and
  auto-enable metadata.
- `/Users/kevinlin/code/openclaw/extensions/google/index.ts:38` defines lazy
  imports for image, media, music, realtime, speech, video, and web-search
  providers.
- `/Users/kevinlin/code/openclaw/extensions/google/index.ts:337` registers the
  Google plugin capabilities with the plugin registry.
- `/Users/kevinlin/code/openclaw/extensions/google/src/gemini-web-search-provider.ts:129`
  defines Google web-search env vars.
- `/Users/kevinlin/code/openclaw/extensions/google/embedding-provider.ts`
  implements Google memory embedding support.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:58`
  live-tests Google TTS/audio transcription/web search paths when live tests are
  enabled.
- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:152`
  live-tests web-search model-provider config fallback.
- `/Users/kevinlin/code/openclaw/test/image-generation.infer-cli.live.test.ts:24`
  runs live Google image generation via a Google model ref.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:340`
  smokes Google Live browser websocket setup.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/image-generation-provider.test.ts:126`
  covers Google image generation request behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/media-understanding-provider.video.test.ts`
  covers Google media understanding video behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/speech-provider.test.ts`
  covers Google speech/TTS behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/music-generation-provider.test.ts:53`
  covers Google music generation provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/video-generation-provider.test.ts`
  covers Google video generation provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/web-search-provider.test.ts:88`
  covers Google web-search diagnostics and credential fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/embedding-provider.test.ts:126`
  covers Gemini embedding model normalization.

### Gitcrawl queries

Query: `gitcrawl search issues "google plugin provider image generation web search speech" -R openclaw/openclaw --state all`

Results:

- Returned no direct issue results.

Query: `gitcrawl search prs "google plugin provider image generation web search speech" -R openclaw/openclaw --state all`

Results:

- Returned no direct PR results.

### Discrawl queries

Query: `discrawl search --limit 5 "@openclaw/google-plugin capability adapters"`

Results:

- Returned no results.

Query: `discrawl search --limit 5 "Google Gemini web search image generation provider"`

Results:

- Returned an adjacent custom-provider/openrouter support thread, but no direct
  bundled Google adapter defect.
