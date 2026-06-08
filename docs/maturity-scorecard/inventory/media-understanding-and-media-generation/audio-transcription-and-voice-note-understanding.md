---
title: "Media understanding and media generation - Audio Transcription and Voice Note Understanding Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Audio Transcription and Voice Note Understanding Maturity Note

## Summary

Audio understanding is a documented and heavily implemented feature: inbound voice notes can be transcribed, command parsing can use transcripts, provider and CLI fallbacks exist, and mention-gated groups can preflight voice notes. Quality is held below stable by recurring auth, progress-output, provider-listing, and edge-case transcript behavior in the archives.

## Category Scope

This category covers batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, transcript insertion into `Body`/`Transcript`, echo-transcript behavior, proxy support, and audio attachment selection. Live Talk/realtime voice is out of scope except where docs explicitly say it does not use this batch path.

## Features

- Audio attachment selection: Covers Audio attachment selection across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Batch STT provider and CLI fallback: Covers Batch STT provider and CLI fallback across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Voice-note mention preflight: Covers Voice-note mention preflight across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Transcript insertion and echo: Covers Transcript insertion and echo across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Audio proxy and limit handling: Covers Audio proxy and limit handling across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover setup, defaults, provider order, CLI fallbacks, preflight mention behavior, echo transcript options, size limits, proxy handling, and failure behavior. Source has a dedicated runner, audio preflight, provider-compatible audio path, and command parsing integration.
- Negative signals: Integration proof is strong for reply and channel paths but not uniform across every provider and channel combination.
- Integration gaps: Provider-specific live sweeps exist through helper files, but recurring release scorecards for all STT providers and all voice-note channels are not obvious from the checked-in docs.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Open archive records include native audio/video understanding support (#78797), private OpenAI-compatible audio endpoint fixes (#73817), diarized transcript segment support (#81721), local Whisper progress transcript suppression (#87393/#87384), eager audio provider startup during listing (#85368), and no-auth/local STT API-key failures (#74644).
- Discrawl reports: Archive comments record tiny/silent voice-note placeholder gaps, direct-delivery transcription fixes, and media-understanding failures becoming warn/status-visible rather than swallowed.
- Good qualities: The design is explicitly best-effort, keeps original attachments, has deterministic size/tiny-audio handling, uses standard auth resolution, and can preflight group voice notes before mention gates.
- Bad qualities: Audio path behavior remains sensitive to provider auth shape, CLI stdout conventions, local binary availability, and whether transcription runs as preflight, direct delivery, ACP, or normal reply processing.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Audio attachment selection, Batch STT provider and CLI fallback, Voice-note mention preflight, Transcript insertion and echo, Audio proxy and limit handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- CLI transcription output parsing still appears fragile enough to produce recent fixes.
- No-auth/local providers and explicit private endpoints required follow-up fixes.
- Operator-facing docs are broad, but a concise health/runbook story for failed audio understanding is distributed across docs and status output rather than centralized.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/audio.md` documents audio media understanding, provider and CLI fallback order, command parsing, echo transcript, proxy support, mention detection, and limits.
- `/Users/kevinlin/code/openclaw/docs/nodes/media-understanding.md` documents shared `tools.media.audio` config, provider entries, CLI entries, attachment policy, size caps, concurrency, scope, and status output.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` maps STT providers and explains reuse of preflight transcripts by shared media understanding.
- Channel docs including `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md`, `/Users/kevinlin/code/openclaw/docs/channels/telegram.md`, and `/Users/kevinlin/code/openclaw/docs/channels/discord.md` describe voice-note transcription behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/media-understanding/audio-transcription-runner.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/openai-compatible-audio.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/audio-preflight.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.entries.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/apply.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/echo-transcript.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/audio-tags.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/dispatch-acp-tts.runtime.ts` and `/Users/kevinlin/code/openclaw/src/auto-reply/reply/dispatch-acp-media.runtime.ts` cover runtime dispatch surfaces around media and speech.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner.media-paths.test.ts` and `/Users/kevinlin/code/openclaw/src/auto-reply/reply/get-reply-run.media-only.test.ts` cover reply-run media path behavior.
- `/Users/kevinlin/code/openclaw/src/scripts/test-live-media.test.ts` provides live-media test entrypoint coverage.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-understanding/openai-compatible-audio.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.auto-audio.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.cli-audio.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.deepgram.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.skip-tiny-audio.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/audio-preflight.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/apply.echo-transcript.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "audio transcription media understanding" --json
```

Results:

- Returned relevant threads: #78797 native audio/video understanding, #73817 private OpenAI-compatible audio transcription endpoints, #81721 diarized JSON transcript segments, #87393/#87384 Whisper progress transcript suppression, #85368 provider-listing startup avoidance, #74644 local/no-auth STT API-key failure, #78069 voice notes before mention gate.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "audio transcription media understanding" --limit 5
```

Results:

- Returned archive comments on #49131 noting silent voice note placeholder gaps, #71740 adding AssemblyAI as a bundled plugin, #65978 confirming direct-delivery audio transcription, #60421 confirming media-understanding failure reasons surfaced in warn/status output, and #56541 preserving image/video paths while suppressing only transcribed audio attachments.
