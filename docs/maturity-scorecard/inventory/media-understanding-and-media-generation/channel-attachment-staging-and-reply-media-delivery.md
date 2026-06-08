---
title: "Media understanding and media generation - Channel Media Handling Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Channel Media Handling Maturity Note

## Summary

Channel media staging and reply delivery have broad source coverage: inbound media is normalized, staged into sandbox-visible paths, represented as `MediaPaths`/`MediaUrls`, and outbound media can be delivered through message tools, direct fallbacks, and channel-native routes. Quality remains below stable because archive evidence shows visible delivery bugs after generation succeeds and channel-specific media behavior still varies.

## Category Scope

Included in this category:

- Inbound attachment staging: Covers Inbound attachment staging across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Sandbox media rewrites: Covers Sandbox media rewrites across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Reply media templating: Covers Reply media templating across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Message-tool attachment delivery: Covers Message-tool attachment delivery across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Duplicate delivery suppression: Covers Duplicate delivery suppression across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.

## Features

- Inbound attachment staging: Covers Inbound attachment staging across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Sandbox media rewrites: Covers Sandbox media rewrites across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Reply media templating: Covers Reply media templating across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Message-tool attachment delivery: Covers Message-tool attachment delivery across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Duplicate delivery suppression: Covers Duplicate delivery suppression across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Inbound staging, sandbox path rewriting, media notes, payload normalization, dedupe, follow-up delivery, and channel outbound payloads are represented in source and targeted tests. Channel docs cover multiple media-specific caveats.
- Negative signals: Coverage is broad but distributed across auto-reply, Gateway, channel plugins, and agent tool delivery rather than a single bounded subsystem.
- Integration gaps: The generated-media completion-to-message-tool path has recurring live/Discord friction that is only partly captured by local tests.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: #86034 and #86279 show media generation succeeded while completion delivery failure was reported like generation failure; #87741 covers generated media handoff lock fallback; #86447 shows Slack completion wake/source delivery mismatch; #77265 covers `agent --deliver` returning media URL without Telegram delivery; #68770 covers missing Telegram media success logs.
- Discrawl reports: Maintainers and clawtributors archives describe successful media generation followed by broken attachment handoff, private final replies containing `MEDIA:` paths, and the need to enforce or perform message-tool delivery for channel contexts.
- Good qualities: The source distinguishes generated-task success from delivery, tracks media sent by message tools, normalizes outbound media payloads, dedupes already-sent media, and stages sandbox media with explicit source checks.
- Bad qualities: Media delivery is highly channel- and session-context-sensitive; async completion wakes can succeed while visible attachment delivery fails.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound attachment staging, Sandbox media rewrites, Reply media templating, Message-tool attachment delivery, Duplicate delivery suppression.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Async generated-media delivery remains the most visible operational weak spot.
- Channel-native media features have uneven captions, voice-note handling, file size limits, and success logging.
- Operator diagnostics often require correlating task state, agent wake, message-tool use, and channel delivery logs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/images.md` documents inbound media to commands, sandbox `MediaPath` rewrites, `MediaPaths`, media understanding, and channel caps.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md` explains async media generation delivery and direct fallback.
- Channel docs such as `/Users/kevinlin/code/openclaw/docs/channels/discord.md`, `/Users/kevinlin/code/openclaw/docs/channels/line.md`, `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`, `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md`, and `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` document channel-specific media handling.

### Source

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/stage-sandbox-media.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/media-note.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/reply-delivery.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-payloads.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/reply-payloads-dedupe.ts`
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.handlers.tools.ts`
- `/Users/kevinlin/code/openclaw/src/channels/inbound-event/media.ts`
- `/Users/kevinlin/code/openclaw/src/channels/plugins/outbound/direct-text-media.ts`
- `/Users/kevinlin/code/openclaw/src/media/store.ts`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/stage-sandbox-media.runtime.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner.final-media-runreplyagent.test.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner.media-paths.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.tools.media.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-reply-media.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-webchat-media.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/media-note.test.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-payloads.test.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/reply-delivery.test.ts`
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/reply-payloads-dedupe.test.ts`
- `/Users/kevinlin/code/openclaw/src/channels/inbound-event/media.test.ts`
- `/Users/kevinlin/code/openclaw/src/channels/plugins/outbound/direct-text-media.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "media generation completion delivery" --json
```

Results:

- Returned #86034 media generation succeeds but completion delivery fails, #86279 keep generation success on delivery failure, #87741 generated media handoff lock fallback, #86447 Slack completion wake mismatch, and #87466 Telegram voice delivery instability tied to model-generated media tags.

Query:

```bash
gitcrawl search openclaw/openclaw --query "inbound media staging sandbox MediaPaths" --json
```

Results:

- Returned no keyword hits, so the note also used the broader gitcrawl/discrawl media-delivery queries plus local source/test evidence for staging.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media generation completion delivery" --limit 5
```

Results:

- Returned 2026-05-23 and 2026-05-15 clawtributors reports that generation worked but attachment handoff failed because the completion session did not expose/use message-send attachment delivery.
- Returned 2026-05-05 maintainer report with exact failure `completion agent did not deliver through the message tool`; provider and wake injection succeeded, visible Discord delivery failed.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media store MediaPaths media://inbound" --limit 5
```

Results:

- Returned an OpenClaw archive comment for #63285 saying inbound media formerly staged to global `~/.openclaw/media/inbound/` and became unreachable to sandboxed agents; current main stages allowed managed inbound media into sandbox workspace and rewrites `MediaPath`/`MediaPaths`.
