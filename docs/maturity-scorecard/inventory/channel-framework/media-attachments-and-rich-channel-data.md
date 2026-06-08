---
title: "Channel framework - Media Attachments and Rich Channel Data Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Media Attachments and Rich Channel Data Maturity Note

## Summary

Media, attachments, and rich channel data have a shared framework, but maturity is uneven across providers. Core code normalizes inbound media, builds media payloads, resolves inbound media roots, supports direct text/media outbound adapters, and exposes location context; provider docs document media caps, file downloads, rich payloads, reactions, polls, location, and voice notes.

The maturity limit is provider variance and failure modes. Some channels have rich support, while archive evidence shows recent issues around outbound media directives, LINE media download timeouts, Matrix voice notes before mention gates, and channel-specific file upload compatibility.

## Category Scope

Included in this category:

- Inbound media normalization: Inbound media normalization, attachment persistence, and history media context
- Outbound direct text/media sends: Outbound direct text/media sends and rich payload adapter support
- Provider-specific channelData: Provider-specific channelData, quick replies, locations, polls, reactions, and voice-note handling
- Media roots: Media roots and file-path safety for channel inbound storage

## Features

- Inbound media normalization: Inbound media normalization, attachment persistence, and history media context
- Outbound direct text/media sends: Outbound direct text/media sends and rich payload adapter support
- Provider-specific channelData: Provider-specific channelData, quick replies, locations, polls, reactions, and voice-note handling
- Media roots: Media roots and file-path safety for channel inbound storage

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals:
  - Provider docs cover media and rich data for LINE, Signal, Google Chat, Matrix, Discord, and other channels (`docs/channels/line.md:160`, `docs/channels/line.md:165`, `docs/channels/line.md:216`, `docs/channels/signal.md:233`, `docs/channels/signal.md:275`, `docs/channels/googlechat.md:217`, `docs/channels/matrix.md:10`, `docs/channels/discord.md:1503`).
  - Shared source covers inbound media normalization, media payload building, inbound roots, direct text/media outbound, location formatting, and delivery capability derivation.
  - Unit coverage exists for inbound media, direct text/media outbound adapters, message capabilities, outbound bridge receipts, and location helpers.
- Negative signals:
  - There is no single cross-channel media contract doc that tells operators which channels support inbound downloads, outbound uploads, rich cards, reactions, polls, and locations.
  - Archive evidence shows provider-specific regressions and timeouts.
  - Integration evidence is present but not broad enough to prove media behavior across all rich channels.
- Integration gaps:
  - No full cross-provider media matrix was found for inbound file download, outbound upload, location, reaction, poll, and voice-note cases.
  - Media security constraints are implemented in source/provider docs, but live evidence is not uniform.

## Quality Score

- Score: `Beta (70%)`
- Quality rationale:
  - Core abstractions are appropriately conservative: media is normalized before agent context, local/remote roots are resolved centrally, and direct media adapters enforce byte limits and result handling.
  - Provider docs call out safety constraints such as public HTTPS requirements and loopback/private-network rejection for LINE outbound media.
  - Rich payload support is explicit through channel-specific `channelData`, which avoids forcing all providers into a lowest-common-denominator shape.
- Main quality risks:
  - The user-facing contract is fragmented by provider.
  - Rich data features depend heavily on adapter-specific implementation and provider API limits.
  - Media failures can be late and provider-specific, making them harder to diagnose from common channel status.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound media normalization, Outbound direct text/media sends, Provider-specific channelData, Media roots.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a generated support matrix for inbound media, outbound media, attachments, reactions, polls, locations, and rich cards per channel.
- Add live/media conformance for representative inbound download, outbound upload, oversized file rejection, and rich payload send paths.
- Surface media failure reasons in a common diagnostic form across adapters.

## Evidence

### Docs

- `docs/channels/line.md:14` through `docs/channels/line.md:15` documents LINE direct messages, group chats, media, locations, Flex messages, template messages, quick replies, reactions, and threads.
- `docs/channels/line.md:160` through `docs/channels/line.md:167` documents media download caps, shared media store persistence, and `channelData.line` rich messages.
- `docs/channels/line.md:216` through `docs/channels/line.md:226` documents outbound images, videos, audio, URL validation, and fallback behavior.
- `docs/channels/signal.md:233` through `docs/channels/signal.md:240` documents Signal sends, receives, attachments, typing indicators, read/viewed receipts, reactions, groups, styled text, and media byte limits.
- `docs/channels/signal.md:275` through `docs/channels/signal.md:307` documents voice-note attachments, media caps, typing/read receipts, and reaction tooling.
- `docs/channels/googlechat.md:217` through `docs/channels/googlechat.md:219` documents message actions for send/upload-file and attachment downloads through the Chat API.
- `docs/channels/matrix.md:10` documents Matrix support for DMs, rooms, threads, media, reactions, polls, location, and E2EE.
- `docs/channels/matrix.md:231` through `docs/channels/matrix.md:277` documents media replies, approval payloads, and encrypted image thumbnail behavior.
- `docs/channels/discord.md:1503` through `docs/channels/discord.md:1510` documents Discord voice-message file requirements and outbound message tool example.

### Source

- `src/channels/inbound-event/media.ts:39` through `src/channels/inbound-event/media.ts:92` normalizes inbound media, history media, and media payloads.
- `src/channels/plugins/media-payload.ts:15` through `src/channels/plugins/media-payload.ts:33` builds shared media payloads for plugins.
- `src/channels/plugins/outbound/direct-text-media.ts:36` through `src/channels/plugins/outbound/direct-text-media.ts:157` implements direct text/media outbound adapters with byte-limit resolution and send handling.
- `src/channels/location.ts:1` through `src/channels/location.ts:71` defines location types, text formatting, and context extraction.
- `src/media/channel-inbound-roots.ts:20` through `src/media/channel-inbound-roots.ts:109` resolves media contract API, local inbound roots, and remote roots.
- `src/channels/message/capabilities.ts:29` through `src/channels/message/capabilities.ts:56` derives durable final delivery requirements from payloads and channel-native extras.
- `src/channels/message/outbound-bridge.ts:108` through `src/channels/message/outbound-bridge.ts:195` wraps rich payload, poll, and receipt behavior from outbound handlers.

### Integration tests

- `scripts/e2e/mcp-channels-docker-client.ts:311` exercises attachment-shaped behavior in the MCP channel harness.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:184` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` proves channel agent turns after setup for common channels, but not a rich media matrix.
- No all-channel media live matrix was found in this audit pass.

### Unit tests

- `src/channels/inbound-event/media.test.ts` covers inbound media normalization and history/media payload behavior.
- `src/channels/plugins/outbound/direct-text-media.test.ts` covers direct text/media outbound adapter behavior.
- `src/channels/location.test.ts` covers location formatting and context helpers.
- `src/media/channel-inbound-roots.fast-path.test.ts` covers media inbound root resolution fast paths.
- `src/channels/message/outbound-bridge.test.ts:108` through `src/channels/message/outbound-bridge.test.ts:195` covers rich payload and poll receipt wrapping.
- `src/channels/message/capabilities.test.ts:12` through `src/channels/message/capabilities.test.ts:43` covers payload-dependent delivery requirements and channel-native extras.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel media attachments rich channelData location" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks for the exact cross-channel query.

Query: `gitcrawl search openclaw/openclaw --query "WhatsApp media attachment download channel" --json --limit 8`

Results:

- Returned PR/issue results including Matrix voice notes before mention gate (#78069), outbound MEDIA directive raw text instead of a content block (#83584), and LINE inbound media download timeout (#86873).

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel media attachments rich channelData location" --limit 8`

Results:

- Returned null, which is neutral after freshness checks for that exact query.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "WhatsApp media attachment download channel" --limit 8`

Results:

- Found discussion of Microsoft TTS output format for voice message compatibility.
- Found PR #52801 discussion around view-once media preflight downloads consuming URLs.
- Found user discussion that `/hooks/agent` could not upload a file directly while channel adapters handle inbound media, supporting the need for adapter-owned media contracts.
