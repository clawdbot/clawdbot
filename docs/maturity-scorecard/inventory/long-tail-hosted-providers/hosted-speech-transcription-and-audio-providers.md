---
title: "Long-tail hosted providers - Hosted Speech, Transcription, and Audio Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Hosted Speech, Transcription, and Audio Providers Maturity Note

## Summary

Hosted speech, transcription, and audio providers are Beta for Coverage and
Alpha for Quality. ElevenLabs, Deepgram, Azure Speech, Gradium, Inworld,
Volcengine, Vydra, MiniMax, Mistral, SenseAudio, and xAI have meaningful docs,
manifests, and selected live paths, but audio format, realtime protocol,
telephony, and region/account variance keep the operational quality score lower.

## Category Scope

This note covers text-to-speech, speech-to-text, realtime transcription,
telephony audio, voice-note output, and provider media-understanding paths for
hosted audio providers.

Out of scope: first-party OpenAI audio scoring when scored separately, local
audio processing, and channel-specific audio delivery.

## Features

- Text-to-speech providers: Covers Text-to-speech providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Speech-to-text providers: Covers Speech-to-text providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Realtime transcription providers: Covers Realtime transcription providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Audio format diagnostics: Covers Audio format diagnostics across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals:
  - Provider directory lists Azure Speech, Deepgram, ElevenLabs, Mistral, SenseAudio, and xAI audio/transcription paths.
  - Manifest contracts include speech providers and realtime transcription providers.
  - ElevenLabs live tests cover TTS, STT, and realtime STT.
  - Deepgram live tests cover sample audio transcription and realtime STT.
  - Azure Speech, Inworld, Gradium, MiniMax, Volcengine, Vydra, Mistral, and xAI have live or source evidence for hosted audio paths.
  - Unit tests cover many provider-specific speech/audio contracts.
- Negative signals:
  - Live proof is stronger for ElevenLabs, Deepgram, Azure Speech, Inworld, Gradium, MiniMax, Volcengine, and Vydra than for every listed provider.
  - Audio behavior varies across formats, sample rates, telephony constraints, streaming protocols, and provider regions.
  - Exact archive searches for the audio-provider phrase returned no direct hits.

## Quality Score

- Score: `Alpha (66%)`
- Good qualities:
  - Provider contracts separate speech providers, realtime transcription providers, media-understanding providers, and generation-provider metadata.
  - Provider implementations expose concrete output formats, file extensions, voice-note compatibility, telephony audio, and transcript text.
  - Several providers reuse shared contracts for realtime STT and synthesized audio inputs.
- Bad qualities:
  - Audio integrations have high external variance in voice catalog availability, region, stream lifecycle, codec support, and sample-rate requirements.
  - Some providers require multiple credentials to synthesize realtime test input or probe a dependent path.
  - Archive-backed support signal is thin for the exact hosted-audio provider phrase.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Text-to-speech providers, Speech-to-text providers, Realtime transcription providers, Audio format diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an audio provider/mode coverage table covering TTS, STT, realtime STT,
  voice notes, telephony, sample rate, and output format per provider.
- Add recurring low-cost smoke for one audio mode per hosted audio provider.
- Add clearer user-facing diagnostics for format and region failures.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/index.md:32`: provider directory links Azure Speech.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:40`: provider directory links ElevenLabs.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:65`: provider directory links SenseAudio.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:87`: transcription provider list includes Deepgram, ElevenLabs, Mistral, OpenAI, SenseAudio, and xAI.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:630`: contracts include `speechProviders` and `realtimeTranscriptionProviders`.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:658`: contract reference defines `speechProviders`.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:659`: contract reference defines `realtimeTranscriptionProviders`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/openclaw.plugin.json:2`: ElevenLabs provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/deepgram/openclaw.plugin.json:2`: Deepgram provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/azure-speech/openclaw.plugin.json:2`: Azure Speech provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/senseaudio/openclaw.plugin.json:2`: SenseAudio provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/inworld/openclaw.plugin.json:2`: Inworld provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/gradium/openclaw.plugin.json:2`: Gradium provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/volcengine/openclaw.plugin.json:2`: Volcengine provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/vydra/openclaw.plugin.json:2`: Vydra provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/mistral/openclaw.plugin.json:2`: Mistral provider manifest includes audio-related provider metadata.
- `/Users/kevinlin/code/openclaw/extensions/xai/openclaw.plugin.json:2`: xAI provider manifest includes speech/transcription paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/elevenlabs.live.test.ts:27`: ElevenLabs live test synthesizes speech through the registered provider.
- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/elevenlabs.live.test.ts:45`: ElevenLabs live test transcribes synthesized speech through the media provider.
- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/elevenlabs.live.test.ts:67`: ElevenLabs live test streams realtime STT through the registered transcription provider.
- `/Users/kevinlin/code/openclaw/extensions/deepgram/audio.live.test.ts:36`: Deepgram live test transcribes sample audio.
- `/Users/kevinlin/code/openclaw/extensions/deepgram/audio.live.test.ts:51`: Deepgram live test streams realtime STT.
- `/Users/kevinlin/code/openclaw/extensions/azure-speech/azure-speech.live.test.ts:26`: Azure Speech live test lists voices through the registered provider.
- `/Users/kevinlin/code/openclaw/extensions/azure-speech/azure-speech.live.test.ts:42`: Azure Speech live test synthesizes MP3, voice-note Ogg/Opus, and telephony audio.
- `/Users/kevinlin/code/openclaw/extensions/inworld/inworld.live.test.ts:20`: Inworld live test lists voices.
- `/Users/kevinlin/code/openclaw/extensions/inworld/inworld.live.test.ts:33`: Inworld live test synthesizes MP3, voice-note Ogg/Opus, and telephony PCM.
- `/Users/kevinlin/code/openclaw/extensions/gradium/gradium.live.test.ts:22`: Gradium live test synthesizes speech through the registered provider.
- `/Users/kevinlin/code/openclaw/extensions/minimax/minimax.live.test.ts:53`: MiniMax live test synthesizes TTS.
- `/Users/kevinlin/code/openclaw/extensions/vydra/vydra.live.test.ts:59`: Vydra live test covers speech.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/speech-provider.test.ts`: unit coverage for ElevenLabs speech provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/deepgram/audio.test.ts`: unit coverage for Deepgram audio transcription.
- `/Users/kevinlin/code/openclaw/extensions/azure-speech/speech-provider.test.ts`: unit coverage for Azure Speech provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/senseaudio/media-understanding-provider.test.ts`: unit coverage for SenseAudio media-understanding provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/inworld/speech-provider.test.ts`: unit coverage for Inworld speech provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/gradium/speech-provider.test.ts`: unit coverage for Gradium speech provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/volcengine/tts.test.ts`: unit coverage for Volcengine TTS behavior.
- `/Users/kevinlin/code/openclaw/extensions/vydra/speech-provider.test.ts`: unit coverage for Vydra speech provider behavior.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "ElevenLabs Deepgram Azure Speech provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "ElevenLabs Deepgram Azure Speech provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "provider fallback error timeout auth missing model"` returned adjacent provider/runtime changes including #81834, which added SenseAudio TTS provider support.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "ElevenLabs Deepgram Azure Speech provider" --limit 5` returned `null`.
- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "Qwen ZAI Moonshot MiniMax provider" --limit 5` returned a voice/STT issue report with provider registry keys including Deepgram and MiniMax, plus an STT model-parameter failure.
- This low direct archive hit rate is treated as weak archive signal rather than as evidence of no problems.
