---
title: "iMessage / BlueBubbles - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Media and Rich Content Maturity Note

## Summary

Media, attachments, remote fetch, and chunking are Beta. The feature has a real
implementation for inbound attachment allowlists, media staging, remote
attachment fetches, outbound media sends, text chunking, and reply/media
receipts. It is held at Beta because media behavior is still active field-churn:
direct-handle media sends, group media, attachment roots, and reply attachments
all show recent archive activity.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Rich Messages and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Media: Covers Media across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Attachments: Covers Attachments across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Remote Fetch: Covers Remote Fetch across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Chunking: Covers Chunking across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.

## Features

- Media: Covers Media across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Attachments: Covers Attachments across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Remote Fetch: Covers Remote Fetch across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Chunking: Covers Chunking across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs cover attachment opt-in, remote attachment fetch, media caps, and
    migration caveats.
  - Source resolves local and remote attachment roots, stages media with path
    and size checks, handles HEIC conversion, and has outbound send fallbacks.
  - Tests cover media staging, remote SCP path safety, image/media tool root
    access, direct media send routes, and reply attachment plumbing.
  - MCP channel e2e seed includes an iMessage attachment message and fetch path.
- Negative signals:
  - No live iMessage attachment send/receive lane was found.
  - GitHub and Discord archives show recent media-specific fixes and open
    issues.
  - Remote attachment behavior depends on SSH/SCP context and host file paths.
- Integration gaps:
  - Add live/fake-imsg media scenarios for inbound image, inbound voice/video,
    remote attachment fetch, outbound direct handle media, group media, and
    reply-with-attachment.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - `iMessage media attachments` returned open issue #87597 for direct-handle
    media sends using the legacy RPC path instead of `send.attachment`, open PR
    #87715 for direct media captions through attachments, and issue #47856
    around configurable media roots.
  - `iMessage send-rich` returned #84329, #87597, and #85954, reflecting rich
    send, media, and approval prompt formatting work.
- Discrawl reports:
  - `iMessage media attachments` returned a 2026-05 maintainer note listing
    iMessage media work: hydrated attachments on reply, image attachment roots,
    group media, DM history, duplicate replies, and AddressBook stderr noise.
  - The same query returned archive comments for attachment roots and media
    placeholder behavior.
- Good qualities:
  - Attachment ingestion is opt-in and root-constrained.
  - Remote fetches distinguish remote roots from local roots and sanitize SCP
    paths.
  - Outbound send code has explicit fallbacks and reports failed attachment
    sends instead of pretending success.
  - Media roots are integrated with image and media tools instead of being
    isolated inside the channel.
- Bad qualities:
  - Recent archive activity shows media behavior is still being repaired in
    important edge cases.
  - Remote media depends on operator-supplied `remoteHost` and matching Mac
    filesystem roots.
  - Inbound attachments are off by default, creating a common "silent drop"
    setup trap.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media, Attachments, Remote Fetch, Chunking, Native Actions, Private API, Message Tool.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live media proof is missing.
- Direct-handle and group media have current/open archive churn.
- Remote SCP fetches remain environment-sensitive.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:458`: inbound attachment ingestion is off by default.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:459`: remote attachment paths can be fetched by SCP when `remoteHost` is set.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:111`: migrated `includeAttachments` must be set explicitly on iMessage.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:113`: `remoteAttachmentRoots` is used when `remoteHost` enables SCP fetches.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:114`: iMessage media max defaults to 16 MB.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:642`: config reference says `includeAttachments` is off by default.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:227`: runtime defaults `includeAttachments` to false.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:228`: runtime defaults media max to 16 MB.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:452`: attachments are only read when attachment ingestion is enabled.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:621`: remote-host messages keep raw media attachments for remote fetch.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/media-contract.ts:25`: remote attachment roots merge account and channel config.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/send.ts:715`: outbound media can use `send-attachment`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/send.ts:797`: send path passes account `remoteHost`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/send.ts:808`: send path enforces configured media max.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-seed.ts:80`: seeded channel data includes an attachment message.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:203`: Docker MCP client calls `attachments_fetch`.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:212`: seeded attachment fetch returns one attachment.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply.stage-sandbox-media.scp-remote-path.test.ts:99`: remote attachment filenames with shell metacharacters are rejected before spawning SCP.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/media-staging.test.ts:24`: allowed iMessage attachments are copied into the inbound media store.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/media-staging.test.ts:49`: paths escaping allowed roots are dropped.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/media-staging.test.ts:80`: HEIC attachments convert to JPEG before staging.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/media-staging.test.ts:105`: oversized attachments are dropped.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/send.test.ts:94`: explicit chat media-only payloads route through `send-attachment` auto transport.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/send.test.ts:174`: send falls back to RPC when `send-attachment` is unavailable.
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-tool.test.ts:1782`: image paths from current iMessage account attachment roots are allowed.
- `/Users/kevinlin/code/openclaw/src/agents/tools/media-tool-shared.test.ts:87`: channel inbound attachment roots stay separate from local roots.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iMessage media attachments" --json --limit 6`

Results:

- Open issue #87597: direct-handle iMessage media sends use the legacy RPC path
  instead of `send.attachment`.
- Open PR #87715: route direct media captions through attachments.
- Open issue #47856: configurable media local roots.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage send-rich" --json --limit 6`

Results:

- Open issue #84329 for configurable IMCore/private API transport preference.
- Open issue #87597 for direct-handle media sends.
- Open issue #85954 for approval prompt formatting via attributed body.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage media attachments" --limit 6`

Results:

- 2026-05 maintainer thread listed iMessage media work around hydrated reply
  attachments, image attachment roots, group media, DM history, duplicate
  replies, and AddressBook stderr noise.
- Archive comments referenced attachment roots and visible media-placeholder
  behavior.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage send-rich" --limit 6`

Results:

- Maintainer snippets referenced merged work for iMessage reply attachments
  through `send-rich --file`.
