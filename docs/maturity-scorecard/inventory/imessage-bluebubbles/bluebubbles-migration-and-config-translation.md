---
title: "iMessage / BlueBubbles - BlueBubbles Migration and Config Translation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - BlueBubbles Migration and Config Translation Maturity Note

## Summary

BlueBubbles migration and config translation is Alpha for Coverage and Beta for
Quality. The docs are explicit that BlueBubbles support was removed and that old
operators must migrate to `channels.imessage`. The migration guide covers the
major key translations and cutover traps. The lower Coverage score reflects
that this is mostly documentation/source evidence: no live old-BlueBubbles to
new-imsg migration lane was found.

## Category Scope

This note covers the removal announcement, migration guide, config reference,
old `channels.bluebubbles` key translation, group registry footgun, session
caveats, attachment/action parity notes, and operator cutover checklist.

## Features

- Translate legacy config: Covers Translate legacy config across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Cut over safely: Covers Cut over safely across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.
- Handle migration caveats: Covers Handle migration caveats across removal announcement, migration guide, config reference, old `channels.bluebubbles` key translation, group registry footgun, session caveats, attachment/action parity notes, and operator cutover checklist.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals:
  - There is a dedicated removal announcement and a full migration guide.
  - Config docs clearly say `channels.bluebubbles` is no longer supported.
  - The guide covers transport key deletion, behavior key copying, group
    registry warnings, private API action verification, and session caveats.
  - Legacy config migration tests cover one adjacent route from old group-chat
    settings into `channels.imessage.groups`.
- Negative signals:
  - No automated migration smoke starts with old `channels.bluebubbles` config
    and verifies a working `channels.imessage` runtime.
  - No live BlueBubbles server teardown/cutover evidence was found.
  - Archive evidence shows older user guidance pointed people toward
    BlueBubbles, which creates a documentation-drift burden for migration.
- Integration gaps:
  - Add a fixture that translates representative `channels.bluebubbles` configs
    into `channels.imessage`, including group wildcard, attachments, media caps,
    actions, and session caveats.
  - Add a docs/config linter that prevents current docs from linking to a
    supported BlueBubbles runtime page.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - `BlueBubbles removed imessage` returned #83160, noting BlueBubbles was
    intentionally excluded because it was removed upstream in `07bf572`
    on 2026-05-07.
  - `iMessage BlueBubbles migration channels.bluebubbles channels.imessage`
    returned adjacent config/security hits such as #73822, #87023, #62387, and
    #64322.
- Discrawl reports:
  - `BlueBubbles removed imessage` returned older Discord/GitHub archive
    snippets about BlueBubbles behavior and user guidance, including a 2026-03
    support answer that still described BlueBubbles as the future path at that
    time.
  - `iMessage BlueBubbles migration channels.bluebubbles channels.imessage`
    returned no snippets in the latest pass.
- Good qualities:
  - The docs do not leave the operator guessing: there is no BlueBubbles server,
    password, webhook, or runtime in the supported path.
  - The translation table calls out behavior keys that carry over and transport
    keys that must be dropped.
  - The guide calls out high-risk traps: `includeAttachments` is off by default,
    group registry entries are load-bearing, old session keys do not carry over,
    and both channels should not run unintentionally during cutover.
- Bad qualities:
  - The migration relies on operator copy/edit discipline rather than a guided
    migration command.
  - Old archive guidance and previous docs can conflict with the new removal
    state.
  - Session continuity is not preserved for old BlueBubbles session keys.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Translate legacy config, Cut over safely, Handle migration caveats.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No migration command or automated translation proof was found.
- Old BlueBubbles sessions remain a manual caveat.
- Old docs/support answers can mislead users unless current docs are followed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/announcements/bluebubbles-imessage.md:12`: OpenClaw no longer ships BlueBubbles; iMessage now runs through bundled `imessage` and `imsg`.
- `/Users/kevinlin/code/openclaw/docs/announcements/bluebubbles-imessage.md:14`: `channels.bluebubbles` configs should migrate to `channels.imessage`.
- `/Users/kevinlin/code/openclaw/docs/announcements/bluebubbles-imessage.md:18`: no BlueBubbles HTTP server, webhook route, REST password, or plugin runtime remains in the supported path.
- `/Users/kevinlin/code/openclaw/docs/announcements/bluebubbles-imessage.md:69`: old behavior keys have iMessage equivalents.
- `/Users/kevinlin/code/openclaw/docs/announcements/bluebubbles-imessage.md:73`: old BlueBubbles session keys do not become iMessage session keys.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:10`: bundled iMessage reaches the same private API surface through `imsg`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:20`: migration checklist verifies `imsg`, copies behavior keys, drops transport keys, probes, tests DMs/groups/attachments/actions, then deletes BlueBubbles.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:95`: config translation table begins.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:109`: group wildcard entries must be copied because they are part of the registry gate.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:596`: `channels.bluebubbles` is not a supported runtime config surface.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/openclaw.plugin.json:6`: bundled plugin declares the `imessage` channel id.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:52`: plugin config adapter points group policy to `channels.imessage.groupPolicy`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:53`: plugin config adapter points group allowlist to `channels.imessage.groupAllowFrom`.
- `/Users/kevinlin/code/openclaw/src/config/types.imessage.ts:77`: iMessage config owns include-attachments behavior.
- `/Users/kevinlin/code/openclaw/src/config/types.imessage.ts:83`: iMessage config owns media size limits.
- `/Users/kevinlin/code/openclaw/src/config/types.imessage.ts:122`: iMessage config owns group wildcard policy shape.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-config-migrate.test.ts:896`: old group-chat mention settings are moved to `channels.imessage.groups`.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-config-migrate.test.ts:907`: migration message names the destination path `channels.imessage.groups."*".requireMention`.
- No old-BlueBubbles-to-new-iMessage live cutover lane was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/config-schema.test.ts:119`: accepts safe `remoteHost` during new config validation.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/config-schema.test.ts:138`: accepts attachment root patterns that migration docs tell users to copy.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:433`: blocks group messages when `imessage.groups` is set without a wildcard.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/group-allowlist-warnings.test.ts:13`: warning fires when `groupPolicy=allowlist` and `groups` is undefined.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "BlueBubbles removed imessage" --json --limit 6`

Results:

- Open PR #83160 snippet says BlueBubbles was intentionally excluded because it
  was removed upstream in `07bf572` on 2026-05-07.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage BlueBubbles migration channels.bluebubbles channels.imessage" --json --limit 6`

Results:

- Adjacent hits included #73822, #87023, #62387, #39065, #83160, and #64322,
  reflecting config/security/session work that mentions iMessage or
  BlueBubbles but not a direct migration proof.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "BlueBubbles removed imessage" --limit 6`

Results:

- Archive snippets included older BlueBubbles PR comments and a 2026-03 support
  answer that still recommended BlueBubbles as the future path, which is now
  stale against the current removal docs.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage BlueBubbles migration channels.bluebubbles channels.imessage" --limit 6`

Results:

- No snippets returned in the latest pass.
