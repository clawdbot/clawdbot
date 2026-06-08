---
title: "OpenRouter provider path - Media Generation and Speech Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Media Generation and Speech Maturity Note

## Summary

OpenRouter media support is broad: image generation, video generation, music generation, text-to-speech, speech-to-text/media understanding, and provider contract metadata are all registered in the bundled plugin and documented. Coverage is Beta because provider tests exercise request shaping, polling, headers, auth, model catalogs, and runtime registration, but live proof is uneven and tool behavior varies by model.

Quality is Alpha because the archive has active/recent reports that OpenRouter video generation silently failed, music had not shipped in a report window, and speech/provider transport reviews found guardrail and SecretRef issues.

## Category Scope

Included in this category:

- image_generate OpenRouter route: Covers image_generate OpenRouter route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- video_generate async jobs/polling/download: Covers video_generate async jobs/polling/download across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- music_generate audio route: Covers music_generate audio route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Text-to-speech: Covers Text-to-speech across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Speech-to-text transcription: Covers Speech-to-text transcription across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Inbound media understanding: Covers Inbound media understanding across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Generated artifact delivery: Covers Generated artifact delivery across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.

## Features

- image_generate OpenRouter route: Covers image_generate OpenRouter route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- video_generate async jobs/polling/download: Covers video_generate async jobs/polling/download across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- music_generate audio route: Covers music_generate audio route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Text-to-speech: Covers Text-to-speech across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Speech-to-text transcription: Covers Speech-to-text transcription across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Inbound media understanding: Covers Inbound media understanding across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Generated artifact delivery: Covers Generated artifact delivery across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: OpenRouter media provider tests cover image generation, video model discovery, video jobs and downloads, music generation, speech, STT/media understanding, headers, auth, and plugin registration.
- Negative signals: This is a wide surface with model-specific behavior and fewer live/release smokes than text inference; video/music paths are newer and more upstream-dependent.
- Integration gaps: Add live-gated media smokes for one image, one video, one music, one TTS, and one STT model, plus a gateway/channel delivery check for each generated artifact type.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: The broad OpenRouter query returned #79535, "OpenRouter video generation silently fails; music generation never shipped", and #83030 requesting ReCraft image model family support through OpenRouter.
- Discrawl reports: Discord search found PR review comments for OpenRouter image/video/music provider additions, including speech transport guardrail and SecretRef issues.
- Good qualities: The plugin manifest declares OpenRouter media contracts and provider metadata; docs cover image, video, music, TTS, and STT configuration in one provider page.
- Bad qualities: Media endpoints differ significantly from text inference, with async video polling, chat-completions image/audio payloads, speech endpoints, and model-specific parameter support.
- Excluded from quality: Provider test breadth and media provider contract tests are Coverage inputs only.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for image_generate OpenRouter route, video_generate async jobs/polling/download, music_generate audio route, Text-to-speech, Speech-to-text transcription, Inbound media understanding, Generated artifact delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Media feature breadth outpaces stable live proof across all media modes.
- Video generation is asynchronous and depends on OpenRouter job status/content semantics.
- Speech and media-understanding auth/transport behavior has more security-sensitive network-policy requirements than plain chat completions.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents OpenRouter image generation, video generation, music generation, text-to-speech, and speech-to-text/media understanding.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md` documents OpenRouter image model selection, API key, input-image support, timeouts, editing, and Gemini image hints.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md` documents OpenRouter Lyria music generation and edit support.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` lists OpenRouter media capability coverage.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` registers OpenRouter media understanding, image generation, music generation, video generation, video model catalog, and speech providers.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/image-generation-provider.ts` implements OpenRouter chat-completions image generation.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/video-generation-provider.ts` and `/Users/kevinlin/code/openclaw/extensions/openrouter/video-http.ts` implement OpenRouter video job submission, polling, and download behavior.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/music-generation-provider.ts` implements OpenRouter chat-completions audio generation.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/speech-provider.ts` and `/Users/kevinlin/code/openclaw/extensions/openrouter/media-understanding-provider.ts` implement speech and STT/media-understanding paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.test.ts` covers runtime use of OpenRouter video generation providers.
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.vision-skip.test.ts` covers OpenRouter media understanding runner behavior.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates the text/catalog side of the provider; media live coverage is less visible.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/image-generation-provider.test.ts` covers OpenRouter image request shaping, headers, auth, and model behavior.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/video-generation-provider.test.ts` covers video model discovery, custom base URLs, job submission, polling, download, callback URL, and auth headers.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/music-generation-provider.test.ts` covers music request shaping and audio output handling.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/speech-provider.test.ts` covers speech config, base URL normalization, auth, headers, and request URL.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/media-understanding-provider.test.ts` covers STT/media-understanding provider metadata, auth, headers, payloads, and URL selection.
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts` covers provider capability declarations including OpenRouter.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter image video music speech provider openrouter"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #79535 on OpenRouter video generation silently failing and music generation not shipping in that report, plus #83030 for OpenRouter ReCraft image model family support.

Query: `gitcrawl --json search prs -R openclaw/openclaw "openrouter add image video music generation providers"`

Results:

- Returned no direct hits for the exact phrase, while Discord archive references PR #64513 for the media-provider addition.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter image generation music video speech"`

Results:

- Found April 2026 PR review comments for `openrouter: add image, video, and music generation providers`, including findings to normalize speech API keys as secret input, use guarded transport for speech streaming, and fix a speech test mock failure.
