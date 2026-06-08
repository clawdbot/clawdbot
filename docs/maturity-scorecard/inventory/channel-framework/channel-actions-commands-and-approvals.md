---
title: "Channel framework - Channel Actions Commands and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Channel Actions Commands and Approvals Maturity Note

## Summary

Channel actions, commands, and approvals are implemented but still maturing. The framework has shared command authorization, native command session targeting, approval plugin capabilities, message action dispatch, message tool API discovery, channel-native approval prompts, and provider docs for reactions, slash commands, action buttons, and native approval clients.

The maturity limit is provider capability variance and security-sensitive UX. Archive evidence shows active work around channel-mediated approvals, native approval prompts, Discord components, Telegram inline buttons, Feishu cards, and long-form approval context.

## Category Scope

Included in this category:

- Channel-native commands: Channel-native commands and command authorization gates
- Native command session target: Native command session target resolution
- Message actions: Message actions, action dispatch, and trusted requester checks
- Message tool API discovery: Message tool API discovery for channel actions
- Channel-native approval prompts: Channel-native approval prompts and plugin/exec approval routing

## Features

- Channel-native commands: Channel-native commands and command authorization gates
- Native command session target: Native command session target resolution
- Message actions: Message actions, action dispatch, and trusted requester checks
- Message tool API discovery: Message tool API discovery for channel actions
- Channel-native approval prompts: Channel-native approval prompts and plugin/exec approval routing

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals:
  - Docs cover native slash command behavior, Discord message components, reaction actions, Google Chat upload actions, Signal/Matrix approvals, and provider-specific command/action settings (`docs/channels/groups.md:106`, `docs/channels/discord.md:353`, `docs/channels/discord.md:1079`, `docs/channels/discord.md:1117`, `docs/channels/googlechat.md:216`, `docs/channels/signal.md:309`, `docs/channels/matrix.md:237`, `docs/channels/matrix.md:678`).
  - Source has shared command gates, native command session targets, approval capability plumbing, message action dispatch, message tool API discovery, and native approval prompt capability detection.
  - Unit coverage exists for command gates, native command session targets, approvals, message actions, message action security, and message tool API behavior.
- Negative signals:
  - Provider capability support varies widely: not every channel has native commands, buttons, cards, reactions, or native approval prompt affordances.
  - Approval UX is security-sensitive and active archive work shows ongoing refinements.
  - Live coverage evidence is thinner than source/unit evidence for native channel components and approval flows.
- Integration gaps:
  - No all-channel live action/approval conformance matrix was found.
  - Provider-native UI paths such as Discord components, Telegram buttons, Feishu cards, Matrix approval events, and Signal reactions need stronger cross-channel live proof.

## Quality Score

- Score: `Beta (72%)`
- Quality rationale:
  - Command authorization is explicitly gated and can use access groups.
  - Native command target resolution avoids accidental session drift by resolving bound and routed targets.
  - Message action dispatch includes trusted requester checks, which is important for interactive channel UI security.
  - Native approval prompt detection is capability-based rather than assumed for every channel.
- Main quality risks:
  - Provider-native affordances have different expiry, permission, interaction, and identity models.
  - Archive results show active work on approval context, metadata, and channel-specific action support.
  - Operators need clearer docs for which channels support which native action/approval features.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channel-native commands, Native command session target, Message actions, Message tool API discovery, Channel-native approval prompts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a support matrix for native commands, reactions, buttons/components/cards, upload actions, native approvals, approval reactions, and fallback slash commands by channel.
- Add live conformance for approval allow/deny, stale action callbacks, unauthorized action attempts, and fallback command approval.
- Expose action/approval capability status through `channels status`.

## Evidence

### Docs

- `docs/channels/groups.md:106` documents that native slash commands bypass message-tool-only visible replies and always reply visibly.
- `docs/channels/discord.md:353` through `docs/channels/discord.md:355` documents Discord button allowed users and component callback TTL.
- `docs/channels/discord.md:1079` through `docs/channels/discord.md:1101` documents Discord native exec approvals.
- `docs/channels/discord.md:1117` through `docs/channels/discord.md:1143` documents Discord message action capabilities and components.
- `docs/channels/googlechat.md:216` through `docs/channels/googlechat.md:218` documents reactions, `send`, `upload-file`, and typing indicators.
- `docs/channels/signal.md:286` through `docs/channels/signal.md:322` documents Signal reactions and approval reactions.
- `docs/channels/matrix.md:237` through `docs/channels/matrix.md:239` documents Matrix native approval prompt content; `docs/channels/matrix.md:678` through `docs/channels/matrix.md:700` documents Matrix exec approval routing, approvers, reaction shortcuts, and fallback slash commands.
- `docs/channels/discord.md:1713` through `docs/channels/discord.md:1720` lists command, streaming, media, retry, and action config feature groups.

### Source

- `src/channels/command-gating.ts:8` through `src/channels/command-gating.ts:66` implements command and control-command gates.
- `src/channels/native-command-session-targets.ts:12` through `src/channels/native-command-session-targets.ts:22` resolves native command session targets.
- `src/channels/plugins/approvals.ts:4` through `src/channels/plugins/approvals.ts:31` defines approval capability and adapter shapes.
- `src/channels/plugins/message-action-dispatch.ts:5` through `src/channels/plugins/message-action-dispatch.ts:31` implements trusted requester checks and dispatch.
- `src/channels/plugins/message-tool-api.ts:16` through `src/channels/plugins/message-tool-api.ts:52` loads and describes bundled message tool discovery.
- `src/channels/plugins/native-approval-prompt.ts:5` through `src/channels/plugins/native-approval-prompt.ts:43` checks known native approval channels and runtime capabilities.
- `src/channels/message/capabilities.ts:29` through `src/channels/message/capabilities.ts:56` derives final delivery requirements from channel-native extras.

### Integration tests

- `scripts/e2e/mcp-channels-docker-client.ts:254` through `scripts/e2e/mcp-channels-docker-client.ts:311` exercises channel conversation and action-shaped channel behavior through the Docker harness.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:184` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` verifies basic agent turns after channel setup for common channels.
- No all-channel live native action/approval conformance suite was found.

### Unit tests

- `src/channels/command-gating.test.ts:8` through `src/channels/command-gating.test.ts:99` covers command authorization and control-command gates.
- `src/channels/native-command-session-targets.test.ts:4` through `src/channels/native-command-session-targets.test.ts:34` covers bound targets, routed targets, and lowercase session keys.
- `src/channels/plugins/approvals.test.ts` covers approval capability/adapter behavior.
- `src/channels/plugins/message-actions.test.ts` covers message action dispatch behavior.
- `src/channels/plugins/message-actions.security.test.ts` covers message action requester security.
- `src/channels/plugins/message-tool-api.test.ts` covers message tool discovery and description behavior.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel command approval native action" --json --limit 8`

Results:

- Returned issue #85954 for iMessage attributed-body approval prompts.
- Returned issue #87486 for approval action metadata feedback.
- Returned issue #81864 for plain-language plugin approvals.
- Returned issue #81901 for long-form context in Telegram/Slack/Discord plugin approvals.
- Returned issue #78308 for channel-mediated MCP approvals.
- Returned issue #79832 for unsupported Feishu card actions.
- Returned issue #81135 for Telegram inline buttons in group prompts.
- Returned PR #78813 for Discord `SendParams` components.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel command approval native action" --limit 8`

Results:

- Found a release note mentioning unsafe runtime-input hardening and channel delivery cleanup.
- Found maintainer discussion listing a strong contract-test set, including a WeCom channel case with group/DM policy, command allowlists, media/file delivery, and a Codex app server bridge case for Discord/Telegram interactive bridge behavior.
