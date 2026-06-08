---
title: "Microsoft Teams - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Media and Rich Content Maturity Note

## Summary

Teams media and file handling is broad but still fragile. Docs and source cover
DM attachments, channel/group Graph downloads, file consent, Bot Framework
fallbacks, SharePoint uploads, OneDrive fallback, and host/auth allowlists.
Coverage and Quality remain Alpha because current archive evidence includes
silent attachment failures and a fresh DNS-rebinding security fix for Teams
attachment fetches.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Media and Files`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Inbound attachments: Covers Inbound attachments across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Graph-hosted media: Covers Graph-hosted media across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- File consent: Covers File consent across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- SharePoint and OneDrive sharing: Covers SharePoint and OneDrive sharing across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Media fetch safety: Covers Media fetch safety across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.

## Features

- Inbound attachments: Covers Inbound attachments across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Graph-hosted media: Covers Graph-hosted media across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- File consent: Covers File consent across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- SharePoint and OneDrive sharing: Covers SharePoint and OneDrive sharing across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.
- Media fetch safety: Covers Media fetch safety across inbound attachments, inline images, `msteams://media` placeholders, Graph hosted content, and related media and file sharing behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals: Source and tests cover direct download, Graph fallback,
  Bot Framework fallback, file consent, pending uploads, SharePoint/OneDrive
  send paths, host allowlists, redirects, and error logging.
- Negative signals: No live Teams media/file upload/download scenario was
  found; docs say channel/group media requires Graph admin consent and
  SharePoint setup.
- Integration gaps: Missing real tenant proof for DM inline images, DM file
  attachments, channel hosted content, SharePoint upload/share links, file
  consent callbacks, and denied permission states.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: `msteams attachment DM file.download.info Graph shares`
  returned open issue `#67177` and PR `#85845` for `file.download.info` Graph
  shares routing; broad search returned `#87567` Teams attachment fetch DNS
  pinning.
- Discrawl reports: `Teams attachment` returned `#87567` DNS-rebinding security
  discussion, `#67177` silent DM file attachment failures, `#65329` DM inline
  image/file drops, and comments on stricter auth-forwarding and redirect
  behavior.
- Good qualities: The implementation has multiple fallback paths, host/auth
  allowlists, SSRF-guarded fetches, pending upload persistence, and explicit
  docs for Graph/SharePoint requirements.
- Bad qualities: Real Teams media depends on Graph permissions, SharePoint
  configuration, Bot Framework quirks, and security-sensitive URL handling, and
  the archive has active regressions.
- Excluded from quality: Attachment unit-test count, integration breadth, and
  lack of live media tests.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound attachments, Graph-hosted media, File consent, SharePoint and OneDrive sharing, Media fetch safety.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live scenarios for DM inline images, DM files, channel images, channel
  files, Graph-disabled behavior, SharePoint upload, file consent accept/decline,
  redirect blocks, and auth-forwarding behavior.
- Add operator-visible errors when Teams media placeholders cannot be resolved.
- Add a security regression scenario for private/internal redirect attempts.

## Evidence

### Docs

- `docs/channels/msteams.md` documents current media status, RSC-only versus
  Graph capability split, Graph-enabled media/history requirements, attachment
  limitations, host allowlists, DM file consent, group/channel SharePoint
  upload setup, sharing behavior, fallback behavior, and troubleshooting.

### Source

- `extensions/msteams/src/attachments/download.ts` downloads Teams attachments
  with host/auth policy and Graph shares handling.
- `extensions/msteams/src/attachments/graph.ts` downloads Graph-hosted media.
- `extensions/msteams/src/attachments/bot-framework.ts` handles Bot Framework
  DM attachment fetches.
- `extensions/msteams/src/monitor-handler/inbound-media.ts` decides direct,
  Graph, and Bot Framework fallback behavior.
- `extensions/msteams/src/file-consent.ts`,
  `extensions/msteams/src/file-consent-invoke.ts`, and
  `extensions/msteams/src/file-consent-helpers.ts` implement file consent and
  pending upload handling.
- `extensions/msteams/src/graph-upload.ts` handles OneDrive/SharePoint upload
  and share-link behavior.
- `extensions/msteams/src/send.ts` selects base64 image, file consent,
  SharePoint, or OneDrive outbound file paths.

### Integration tests

- No Teams live media or file e2e lane was found by `rg`.
- Archive evidence includes real-user issue reports but not a checked-in live
  scenario artifact.

### Unit tests

- `extensions/msteams/src/attachments.test.ts`,
  `attachments.graph.test.ts`, `attachments/bot-framework.test.ts`,
  `attachments/remote-media.test.ts`, and `attachments/shared.test.ts` cover
  media download paths, redirects, allowlists, auth forwarding, and Graph shares.
- `extensions/msteams/src/monitor-handler/inbound-media.test.ts` covers fallback
  triggers and routing.
- `extensions/msteams/src/file-consent-helpers.test.ts`,
  `file-consent.test.ts`, `pending-uploads.test.ts`, and
  `pending-uploads-fs.test.ts` cover consent and pending upload state.
- `extensions/msteams/src/send.test.ts` covers outbound media send behavior.

### Gitcrawl queries

Query:

- `gitcrawl search issues "msteams Teams file consent attachment media Graph upload download" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams attachment DM file.download.info Graph shares" --json --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams Microsoft Teams" --json --limit 10`

Results:

- The focused issue search returned `[]`.
- The Graph shares query returned `#85845` and issue `#67177` for Teams
  `file.download.info` links.
- The broad search returned `#87567`, "Pin Microsoft Teams attachment fetch
  DNS".

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Teams attachment"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams Teams file consent attachment media Graph"`

Results:

- `Teams attachment` returned `#87567` DNS-rebinding security discussion,
  `#67177` silent DM attachment failure, `#65329` inline image/file drop, and
  notes about stricter redirect and Authorization forwarding.
- The focused `msteams Teams file consent attachment media Graph` query returned
  no lines.
