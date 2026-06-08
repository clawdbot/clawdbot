---
title: "Discord - Approvals and Sensitive Actions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Approvals and Sensitive Actions Maturity Note

## Summary

Discord has a strong source-level safety model for native exec/plugin approvals and privileged channel actions, but the external proof is uneven. The implementation documents and enforces approver-only approval buttons, DM-first owner privacy, per-account action gates, Discord permission checks for sender-driven admin/moderation changes, and read-target allowlists. Coverage stays Alpha because the located live Discord QA covers adjacent channel flows, not native approval delivery across `dm`/`channel`/`both` or real privileged action execution. Quality is Beta because the design is defensible, but open and recent archive evidence still shows approval delivery regressions, local TLS approval-client failures, route-notice/token-boundary churn, a coarse destructive message-action gate, and prior admin-action authorization gaps.

## Category Scope

Included in this category:

- Native Discord exec/plugin approvals: Native Discord exec/plugin approvals, including approver resolution, dm/channel/both target routing, approval button authorization, stale/expired click handling, gateway resolution, and route-notice/privacy behavior
- Sensitive owner-only command routing for prompts: Sensitive owner-only command routing for prompts and final results, especially /diagnostics and /export-trajectory
- Discord message actions: Discord message actions for messages, reactions, pins, reads/search, permissions, channel/guild administration, role changes, moderation, scheduled events, voice status, and presence
- Action gates under channels.discord.actions._: Action gates under channels.discord.actions._, per-account overrides, requester trust, senderUserId-based Discord permission checks, role hierarchy checks, and read target allowlisting

## Features

- Native Discord exec/plugin approvals: Native Discord exec/plugin approvals, including approver resolution, dm/channel/both target routing, approval button authorization, stale/expired click handling, gateway resolution, and route-notice/privacy behavior
- Sensitive owner-only command routing for prompts: Sensitive owner-only command routing for prompts and final results, especially /diagnostics and /export-trajectory
- Discord message actions: Discord message actions for messages, reactions, pins, reads/search, permissions, channel/guild administration, role changes, moderation, scheduled events, voice status, and presence
- Action gates under channels.discord.actions._: Action gates under channels.discord.actions._, per-account overrides, requester trust, senderUserId-based Discord permission checks, role hierarchy checks, and read target allowlisting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals:
  - Discord has a live QA runtime with real Discord scenario inventory for canary, mention gating, native help command registration, status reactions, voice auto-join, and thread attachment flows.
  - Shared Gateway approval e2e tests prove a real Gateway approval can be requested and resolved across separate WebSocket connections, and operator-approval client e2e tests cover generated-local versus remote-loopback approval-runtime authority.
  - Local runtime tests exercise Discord approval target normalization, thread targeting, DM-session origin suppression, account binding, button authorization, stale click handling, action gate behavior, read-target allowlists, sender permission checks, role hierarchy checks, moderation, reactions, permissions, and presence.
- Negative signals:
  - No located live/e2e proof covers Discord native approval cards/buttons end to end for `target: "dm"`, `target: "channel"`, and `target: "both"`, including non-approver clicks, stale clicks, cleanup-after-resolve, and same-chat fallback notices.
  - No located live/e2e proof covers sensitive owner-only `/diagnostics` or `/export-trajectory` approval/result privacy through a Discord group origin.
  - No located live/e2e proof covers real Discord role/channel/moderation/presence mutations under actual Discord permissions and OpenClaw action gates.
  - The live Discord QA baseline itself records missing standard transport scenarios: allowlist block, top-level reply shape, and restart resume.
- Integration gaps:
  - Add live Discord QA for exec approvals with `dm`, `channel`, and `both`, including non-approver denial, approved/denied decisions, expiry, cleanup, route notices, self-signed local TLS, and remote Gateway mode.
  - Add live Discord QA for owner-private `/diagnostics` and `/export-trajectory` from a group channel, verifying prompt/result privacy and fallback owner routes.
  - Add live Discord QA for role add/remove, channel create/edit/delete, permission overwrite, timeout/kick/ban, and presence mutation with both authorized and unauthorized requester identities.
  - Add a live or e2e scenario that proves action gates prevent destructive message edits/deletes while preserving allowed read/send behavior once granular gates exist.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - Open #73802 reports Discord exec approval card/buttons not delivered while manual `/approve` works.
  - Open #41740 reports Discord exec approvals fail against local self-signed TLS Gateway.
  - Open #78738 reports approval dispatch failures silently dropping commands; open PR #82506 proposes surfacing delivery failures.
  - Open #53250 requests clearer approval-timeout guidance and Control UI setup hints.
  - Open #7234 requests granular Discord message gates because the current `actions.messages` boolean gates read, send, edit, and delete together.
  - Open #34004 requests a separate, safe, bot-self-only profile action; current implementation only covers presence/status.
- Discrawl reports:
  - Maintainer discussion on 2026-05-27 favored group-originated exec routed to DM by default because channel-visible approval cards can leak command details even when button authorization is enforced.
  - Maintainer discussion around PRs #86771, #87104, and #87105 split stale Discord button UX, route notice least-privilege gateway auth, and shared socket-token behavior into separate security-boundary concerns.
  - Discord support history shows repeated operator confusion around native approvals not configured, action gates, Discord permissions, and bot admin capabilities.
  - Archive posts record prior high-severity Discord guild-admin and moderation authorization gaps, followed by fixes requiring trusted requester identity and Discord permission checks.
- Good qualities:
  - Approval approvers are explicit: Discord accepts `execApprovals.approvers` or `commands.ownerAllowFrom`, and source does not infer approvers from `allowFrom`, legacy `dm.allowFrom`, or `defaultTo`.
  - The approval target default is DM, channel/both delivery is opt-in, docs warn that channel prompts expose command text, and non-approvers receive ephemeral denial.
  - Native approval routing separates origin targets from approver DM targets, suppresses origin delivery for Discord DM sessions, preserves thread targets, and rejects requests bound to another Discord account.
  - Discord approval buttons encode approval IDs, restrict decisions to resolved approvers, acknowledge valid clicks, and classify stale/expired Gateway responses.
  - Privileged action groups are gated, with roles/moderation/presence disabled by default; channel/guild/admin paths check Discord permissions when a trusted sender identity is present and apply role hierarchy checks for role mutations.
  - Read-like message actions authorize configured guild/channel/thread targets before reading messages, pins, permissions, reactions, or search results.
- Bad qualities:
  - Open approval-delivery issues are directly on the security-sensitive approval path and include regressions where the manual command works but native cards do not, local TLS breaks approval clients, or failed delivery leaves the agent without a visible error.
  - Recent maintainer discussion shows the route-notice and shared-token behavior is still under active security-boundary review rather than a settled channel contract.
  - The admin/moderation path has had serious prior authz defects where bot-privileged guild mutations could run without requester permission checks; current source is stronger, but the history lowers certainty for this component.
  - `actions.messages` is too coarse for least privilege because deployments cannot allow send/read while separately denying edit/delete.
  - Permission enforcement depends on trusted requester identity being attached for sender-driven actions; source intentionally skips the Discord permission check for CLI/manual flows without `senderUserId`, so caller identity plumbing remains a critical boundary.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test presence or absence were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Discord exec/plugin approvals, Sensitive owner-only command routing for prompts, Discord message actions, Action gates under channels.discord.actions.\*.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live approval proof is missing for Discord native cards/buttons across all delivery targets and failure modes.
- Sensitive owner-only command privacy needs live Discord group-origin proof.
- Real Discord privileged action proof is missing for authorized and unauthorized requester identities.
- Discord message action gates need finer-grained least-privilege controls for read/send/edit/delete.
- Self-profile/profile mutation remains outside current source despite open demand for a bot-self-only, explicitly gated action.
- Approval route notices and shared approval-runtime token behavior need a settled security-boundary decision and merged proof.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:429` documents `dmPolicy` and the canonical `allowFrom` DM allowlist.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:457` documents dynamic access groups for Discord DM and text command authorization.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:482` defines `discord.channelAudience` membership through current `ViewChannel` permission.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1003` documents presence updates through status/activity config.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1078` documents button-based approvals in DMs and optional origin-channel prompts.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1083` lists `channels.discord.execApprovals.enabled`, `approvers`, and `target`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1088` says Discord auto-enables only when approvers resolve and does not infer approvers from channel `allowFrom`, legacy `dm.allowFrom`, or `defaultTo`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1090` documents private routing for sensitive owner-only group commands.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1092` warns that channel/both approval prompts are visible and only resolved approvers can use buttons.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1104` documents Gateway approval resolution and 30-minute default expiry.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1113` lists messaging, channel admin, moderation, presence, and metadata actions.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1124` documents action gates under `channels.discord.actions.*`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1130` shows reactions/messages/threads/pins/search/metadata/permissions enabled by default and roles/moderation/presence disabled by default.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/exec-approvals.ts:41` resolves explicit approvers, account-level approvers, or `commands.ownerAllowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/exec-approvals.ts:71` checks whether a sender is a configured Discord exec approver.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:72` resolves origin-channel targets for native approval delivery.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:99` suppresses origin delivery when the initiating session is a Discord DM.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:148` resolves approver DM targets.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:163` creates the approver-restricted native approval capability.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:183` resolves native delivery mode from `execApprovals.target`, defaulting to `dm`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.ts:190` registers lazy native approval runtime handling for exec and plugin approval events.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.ts:189` builds exec approval request containers with command preview, metadata, buttons, expiry, and ID.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.ts:351` builds encoded Discord approval custom IDs.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.ts:414` configures the native runtime for exec and plugin events.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.ts:510` prepares origin versus approver-DM targets and creates user DM channels.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.ts:550` sends pending approval cards to the prepared Discord channel/DM target.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/accounts.ts:95` builds per-account Discord action gates.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.ts:9` dispatches messaging, guild, moderation, and presence action families.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.guild.ts:113` defines admin action guards and disabled defaults for role changes.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.guild.ts:253` verifies sender permissions for guild-admin actions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.guild.ts:297` checks role hierarchy and member role manageability for role mutations.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.guild.ts:313` checks role-overwrite manageability for channel permission changes.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.guild.ts:668` applies channel permission set/remove actions behind the channel gate.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.moderation.ts:29` verifies sender moderation permissions when requester identity is present.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.moderation.ts:60` keeps moderation disabled unless the gate is enabled.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.messaging.shared.ts:313` authorizes read targets against guild/channel/thread allowlists.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.messaging.messages.ts:52` gates permission reads and authorizes the target channel.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.messaging.messages.ts:117` gates message edits behind `actions.messages`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.messaging.messages.ts:136` gates message deletes behind `actions.messages`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.messaging.reactions.ts:10` gates reaction add/remove/list actions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.presence.ts:23` implements gated presence updates through the active Gateway.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:288` lists live Discord scenarios: canary, mention gating, native help command registration, status reactions, voice auto-join, and thread attachment.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:403` waits for the Discord account to become connected before live scenarios proceed.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:472` records that standard live coverage is still missing allowlist-block, top-level reply shape, and restart-resume.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:63` proves a Gateway-hosted exec approval can be requested and resolved over separate connections.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts:62` proves approval-runtime authority is limited to generated local Gateway URLs and rejects remote-loopback approval resolution without that authority.
- No located live/e2e test proves Discord native approval card delivery and button resolution through real Discord for `dm`, `channel`, and `both`.
- No located live/e2e test proves Discord role/channel/moderation/presence mutations against real Discord permissions and requester identities.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/exec-approvals.test.ts:24` covers enablement, explicit approvers, no approver inference from `allowFrom`/default routes, and `commands.ownerAllowFrom` fallback.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:35` covers availability state and delivery capability reporting.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:76` covers `ownerAllowFrom` fallback for gating approval requests.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:124` covers origin target normalization.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:148` and `:173` cover DM-session origin suppression.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:258` covers explicit thread IDs on origin targets.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:306` covers rejecting origin delivery for another Discord account.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-handler.runtime.test.ts:5` covers origin approval updates routed to thread channels.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/exec-approvals.test.ts:86` covers invalid approval button payload denial.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/exec-approvals.test.ts:101` covers non-approver denial.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/exec-approvals.test.ts:116` covers valid click acknowledgement and resolution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/exec-approvals.test.ts:147` covers already-resolved/stale approval follow-up.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/exec-approvals.test.ts:164` covers Gateway resolution routing from button context.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:438` covers read target denial for non-allowlisted permission reads.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1455` covers disabled channel management.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1466` covers sender permission denial for channel actions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1659` covers trusted owner/manual role actions without sender IDs.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1670` covers role hierarchy denial.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1920` covers channel-scoped `ManageRoles` for permission edits.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1999` covers moderation gating and execution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.presence.test.ts:132` covers presence gating.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.moderation.authz.test.ts:34` covers `BAN_MEMBERS` enforcement.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.moderation.authz.test.ts:54` covers `KICK_MEMBERS` enforcement.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.moderation.authz.test.ts:74` covers `MODERATE_MEMBERS` enforcement.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.permissions.authz.test.ts:122` covers role hierarchy rejection.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel-actions.contract.test.ts:6` covers action/capability contract reporting for configured Discord gates.

### Gitcrawl queries

- `gitcrawl doctor --json`
  Result: `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`.
- `gitcrawl search issues "discord exec approvals" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #53250 open, #41740 open, #9987 open, #73802 open, #78738 open, #41152 open, #67440 open, #72545 open, #81901 open, and related exec/plugin approval items.
- `gitcrawl search issues "channels.discord.execApprovals" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #53250 open, #78738 open, #41152 open.
- `gitcrawl search issues "discord approval buttons" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #73802 open, #82218 open, #8959 open, #85954 open, #46656 open, #77278 open, #86777 open.
- `gitcrawl search issues "discord moderation actions permissions" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: no results.
- `gitcrawl search issues "Discord channel actions gates" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: no results.
- `gitcrawl search issues "discord owner privacy diagnostics export trajectory" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: no results.
- `gitcrawl search issues "discord role add permissions" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #69629 open and #68955 open.
- `gitcrawl search issues "discord permissions action" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #79445 open, #81232 open, #83164 open, #14785 open, #87486 open, #84724 open, #78196 open, #61368 open.
- `gitcrawl search issues "discord setPresence" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: no results.
- `gitcrawl search prs "discord exec approval" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #82506 open, #87105 open, #80922 open, #78813 open, #81864 open, #84485 open, and related approval/runtime PRs.
- `gitcrawl threads openclaw/openclaw --numbers 73802,41740,78738,53250 --include-closed --json`
  Result: #73802, #41740, #78738, and #53250 are open with detailed Discord approval delivery, TLS, silent failure, and timeout guidance reports.
- `gitcrawl threads openclaw/openclaw --numbers 68716,68705,19008,70215 --include-closed --json`
  Result: #68716 open records Discord guild-admin actions executing without requester context.
- `gitcrawl threads openclaw/openclaw --numbers 7234,33270,34004,64402 --include-closed --json`
  Result: #7234 open granular action gates, #34004 open self-profile action, #33270 closed auto-presence/self-profile split, #64402 closed action-invocation path issue.
- `gitcrawl threads openclaw/openclaw --numbers 86771,87104,87105,82506 --include-closed --json`
  Result: #87105 open shared approval runtime socket token; #82506 open surfacing exec approval delivery failures.

### Discrawl queries

- `discrawl status --json`
  Result: `generated_at=2026-05-28T20:13:14Z`, `state=current`, `last_sync_at=2026-05-28T19:15:50Z`, `messages=1485267`, `channels=25766`, `threads=25539`, `members=173089`, `embedding_backlog=0`, `share remote git@github.com-personal:openclaw/discord-store.git`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord exec approvals"`
  Result: maintainer discussion on 2026-05-27 favored group-originated exec approval routed to DM, split route notices from broad `operator.write`, and separated stale-click UX from shared token/Docker CLI topology.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "channels.discord.execApprovals"`
  Result: repeated support messages where native chat exec approvals were not configured and users were told to configure `channels.discord.execApprovals.approvers` or `commands.ownerAllowFrom`; also #49825 timeout configurability closure.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord approval buttons"`
  Result: maintainer discussion warned channel-visible approval cards can leak args, paths, env-like strings, or tool descriptions; notes also split route notice and shared socket-token concerns.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord moderation actions"`
  Result: May 2026 examples of operators enabling all action gates; March 2026 support and PR-review history for admin/moderation tool routing and trusted-sender permission checks.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "channels.discord.actions"`
  Result: operator support threads checking action gates, channel management failures, and open #7234 granular gate review.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord role permissions"`
  Result: live maintainer/server support around Discord permission visibility, disabled role-change gate, prior guild-admin authorization PRs #68705/#68716, and safe mutation concerns.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord channel management is disabled"`
  Result: support guidance that Discord admin operations depend on both tool exposure and `channels.discord.actions.*` gates.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord sender channel actions"`
  Result: maintainer-security-ops hardening note plus archived #19008 closure citing fixes for moderation action authorization.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "approval.routeNotice.send"`
  Result: maintainer thread split #86771 stale-click UX, #87104 least-privilege route notice method, and #87105 shared approval-runtime socket token behavior.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord self-profile"`
  Result: open #34004/#33270 commentary that current main implements autoPresence/runtime health but not the requested self-profile action and gate.
