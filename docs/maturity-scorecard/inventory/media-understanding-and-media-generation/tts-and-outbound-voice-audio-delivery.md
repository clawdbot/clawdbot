---
title: "Media understanding and media generation - Text-to-Speech Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Text-to-Speech Delivery Maturity Note

## Summary

Text-to-speech has one of the broader documented provider surfaces in the media area: many speech providers, per-channel voice-note behavior, `/tts` commands, directives, auto modes, personas, Talk integration, and Gateway methods. Quality is below stable because archived issues show channel-specific voice-note routing, final-mode churn, and audio compatibility problems.

## Category Scope

Included in this category:

- TTS: Covers TTS across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.
- Outbound Voice Audio Delivery: Covers Outbound Voice Audio Delivery across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.

## Features

- TTS: Covers TTS across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.
- Outbound Voice Audio Delivery: Covers Outbound Voice Audio Delivery across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Docs cover provider setup, auto modes, explicit tool use, directives, per-channel voice-note behavior, Talk interaction, and provider matrices. Source has TTS config/status, directives, provider registry, speech providers, outbound message integration, Gateway RPC methods, and channel capability declarations.
- Negative signals: Native voice-note behavior differs per channel and provider output format, so one generic path does not prove every user scenario.
- Integration gaps: Cross-channel voice-note delivery needs recurring scenario proof because Feishu, Telegram, WhatsApp, Matrix, Discord voice, Talk, and webchat display all differ.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: #85632 shows cron isolated agent delivery sending raw audio instead of voice note; #80317/#83227 cover OpenAI MP3 voice compatibility for Telegram; #84791 covers Telegram voice-note routing; #83511/#83988 cover final-mode text/audio churn; #42539 and #73210 request voice-only/separate delivery modes; #68770 covers missing success logs for Telegram media.
- Discrawl reports: Freshbits and OpenClaw archive records mention Google Opus voice-note fixes, WhatsApp voice-note doc clarification, Feishu runtime delivery fix, and user confusion between TTS voice and realtime voice models.
- Good qualities: TTS is explicit-intent by default, supports auto/tagged modes, normalizes provider/channel voice delivery capabilities, and has Gateway status/convert/provider/persona methods.
- Bad qualities: Voice-note delivery is sensitive to channel-specific payload shape, provider output format, final-mode display semantics, and whether the path is command, model final, message tool, cron, Talk, or channel voice.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for TTS, Outbound Voice Audio Delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Voice-note routing still has channel-specific edge cases.
- Final-mode visible text plus delayed audio behavior has required recent fixes.
- Operator observability for media-bearing TTS replies is uneven by channel.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/tts.md` documents providers, setup, auto modes, tool usage, directives, personas, provider fallback, and Talk relationship.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` documents TTS as synchronous media output and distinguishes Talk/realtime modes.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md`, `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md`, `/Users/kevinlin/code/openclaw/docs/channels/telegram.md`, `/Users/kevinlin/code/openclaw/docs/channels/feishu.md`, and `/Users/kevinlin/code/openclaw/docs/channels/qqbot.md` document channel-specific TTS/voice-note behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/tts/tts.ts`
- `/Users/kevinlin/code/openclaw/src/tts/tts-config.ts`
- `/Users/kevinlin/code/openclaw/src/tts/status-config.ts`
- `/Users/kevinlin/code/openclaw/src/tts/directives.ts`
- `/Users/kevinlin/code/openclaw/src/tts/openai-compatible-speech-provider.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/tts-tool.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/tts.ts`
- `/Users/kevinlin/code/openclaw/src/infra/outbound/message-action-tts.ts`
- `/Users/kevinlin/code/openclaw/src/channels/plugins/tts-capabilities.ts`
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/tts-runtime.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/dispatch-acp-tts.runtime.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat.directive-tags.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/outbound/message-action-runner.core-send.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/tts-tool.test.ts`
- `/Users/kevinlin/code/openclaw/src/tts/status-config.test.ts`
- `/Users/kevinlin/code/openclaw/src/tts/directives.test.ts`
- `/Users/kevinlin/code/openclaw/src/tts/tts-config.test.ts`
- `/Users/kevinlin/code/openclaw/src/tts/openai-compatible-speech-provider.test.ts`
- `/Users/kevinlin/code/openclaw/src/channels/plugins/tts-capabilities.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/tts.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "tts voice note" --json
```

Results:

- Returned #85632 cron isolated agent voice-note propagation, #80317/#83227 OpenAI MP3 voice compatibility, #83988/#83511 final-mode churn, #84791 Telegram voice-note routing, #42539 separate text/voice mode, #74722 language-aware voice replies, #68770 media success logging, and #73210 voice-only delivery mode.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "tts voice note" --limit 5
```

Results:

- Returned Freshbits entries mentioning Google Opus voice-note TTS fix, per-agent voice overrides, and WhatsApp voice-note docs.
- Returned OpenClaw archive comment for #71920 saying Feishu TTS voice-note delivery was fixed after block-streaming TTS skipped safe media normalization before dispatch.
- Returned user question distinguishing TTS voice from realtime voice models, showing operator/user confusion across speech surfaces.
