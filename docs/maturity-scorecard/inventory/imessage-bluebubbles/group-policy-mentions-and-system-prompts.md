---
title: "iMessage / BlueBubbles - Group Policy, Mentions, and System Prompts Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Group Policy, Mentions, and System Prompts Maturity Note

## Summary

Group policy, mentions, and system prompts are Beta. The docs and runtime both
model iMessage group admission as two gates: sender/chat allowlist and group
registry. The component has strong tests around mention handling, group
allowlist behavior, reply context, and warning logs. It remains Beta because the
operator model is subtle, especially for migrated BlueBubbles configs and for
iMessage's lack of reliable native mention metadata.

## Category Scope

This note covers `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry
entries, `requireMention`, mention patterns, per-group tools, per-group system
prompts, group sessions, and warnings for allowlist misconfiguration.

## Features

- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (75%)`
- Positive signals:
  - Docs spell out the two independent group gates and the migration footgun.
  - Source normalizes group allowlists, resolves group policy, applies mention
    policy, emits startup/per-chat warnings, and builds group context.
  - Unit tests cover dropped groups, allowlist fallback, explicit empty
    allowlists, group command auth, wildcard requirements, and warning behavior.
  - Discord archive has real support snippets for group setup patterns.
- Negative signals:
  - No live group iMessage scenario was found.
  - Mention detection depends on text patterns rather than native iMessage
    metadata.
  - Migrated configs can silently block groups if the wildcard `groups` entry is
    not copied.
- Integration gaps:
  - Add a live/fake-imsg group lane for allowed group, blocked group, mention
    required, no mention, and per-group prompt/tool settings.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  - `channels.imessage.groups groupPolicy` returned #58057 for dynamic identity
    resolution and #79281 for default ACP thread-binding preset mentioning
    iMessage/BlueBubbles grouping.
  - `iMessage groupPolicy groups groupAllowFrom requireMention` returned no
    direct gitcrawl hits in the latest pass.
- Discrawl reports:
  - `iMessage groupPolicy groups groupAllowFrom requireMention` returned
    multiple support snippets with `groupPolicy: "allowlist"`,
    `groupAllowFrom`, `groups`, and `requireMention` examples.
  - A 2026-02 support answer called out that iMessage groups need group gating
    and mention gating checks.
- Good qualities:
  - The docs and source agree on the two-gate model.
  - Warnings target the exact migration failure: `groupPolicy="allowlist"` with
    missing or empty `groups`.
  - The implementation distinguishes legacy conversation allowlist entries,
    explicit `groupAllowFrom`, and group control command authorization.
  - Per-group prompt/tool settings are tied to the group policy resolver rather
    than ad hoc branching.
- Bad qualities:
  - The configuration is powerful but easy to partially copy.
  - Mention behavior is inherently less reliable than Slack/Discord native
    mentions.
  - Group chat identifiers can be represented as chat id, chat guid, or chat
    identifier, which raises operator error risk.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (75%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Group Policy, Mentions, System Prompts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live group proof is missing.
- Mention gating relies on configured text patterns.
- Migration from BlueBubbles is vulnerable to missing wildcard `groups` entries.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:237`: `channels.imessage.groupPolicy` controls group handling.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:243`: `channels.imessage.groupAllowFrom` is the group sender allowlist.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:253`: sender/chat-target allowlist is the first group gate.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:254`: `channels.imessage.groups` is the group registry gate.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:258`: startup warning fires when allowlist mode has empty groups.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:126`: migration docs describe the sender/chat-target allowlist gate.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:127`: migration docs describe the group registry gate.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:138`: missing `groups` is called out as the common migration failure.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:644`: config reference warns to configure explicit chat ids or wildcard entries with group allowlist mode.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:52`: group policy path is `channels.imessage.groupPolicy`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:53`: group allowlist path is `channels.imessage.groupAllowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:208`: runtime resolves open-provider group policy.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:550`: runtime warns operators who set group allowlist mode without groups.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.ts:719`: inbound processing resolves group mention requirements.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.ts:758`: group messages can be skipped when mention is required and absent.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/commands-acp/context.test.ts:686`: ACP context resolves iMessage group conversation ids from explicit chat targets.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/commands-acp/context.test.ts:723`: ACP context resolves iMessage group conversation ids from `chat_id` targets.
- No live iMessage group monitor lane was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:137`: drops group messages without mention by default.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:155`: dispatches group messages with mention and builds a group envelope.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:433`: blocks group messages when `imessage.groups` is set without wildcard.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:465`: honors group allowlist and ignores pairing-store senders in groups.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:546`: explicit empty `groupAllowFrom` prevents legacy conversation allowlist fallback.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.gating.test.ts:613`: group control commands are not authorized from conversation allowlist entries.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/group-allowlist-warnings.test.ts:13`: warning fires when allowlist mode has undefined groups.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/group-allowlist-warnings.test.ts:52`: warning does not fire when wildcard group entry exists.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "channels.imessage.groups groupPolicy" --json --limit 6`

Results:

- #58057: dynamic identity resolution for allowlists.
- #79281: default ACP thread-binding preset references iMessage/BlueBubbles grouping behavior.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage groupPolicy groups groupAllowFrom requireMention" --json --limit 6`

Results:

- No direct hits in the latest pass.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage groupPolicy groups groupAllowFrom requireMention" --limit 6`

Results:

- Multiple support snippets from February and March 2026 showed `groupPolicy:
"allowlist"`, `groupAllowFrom`, `groups`, and `requireMention` setup examples.
- A 2026-02 support answer warned that iMessage groups need group policy,
  `groupAllowFrom`, and mention-gating checks.
