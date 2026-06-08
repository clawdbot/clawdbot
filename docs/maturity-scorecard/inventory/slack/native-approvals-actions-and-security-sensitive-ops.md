---
title: "Slack - Native Approvals, Actions, and Security-sensitive Ops Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Native Approvals, Actions, and Security-sensitive Ops Maturity Note

## Summary

Slack has a substantial native approval and action surface: exec/plugin approval buttons, approver routing, origin/DM/channel delivery, same-chat `/approve`, read/edit/delete/pin/reaction/member/emoji actions, token selection for reads/writes, and action gates. Coverage is Beta because native approval live scenarios exist, but many Slack action groups are not live-gated. Quality remains Beta because archive evidence shows approval callback confusion, fallback `/approve` gotchas, and unresolved target-authorization risks for outbound DMs.

## Category Scope

This category covers Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, approval fallback behavior, Slack message actions, read/download/edit/delete/pin/reaction/member-info/emoji-list operations, action gates, and token/user-token policy.

## Features

- Native Approvals: Covers Native Approvals across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Actions: Covers Actions across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Security-sensitive Ops: Covers Security-sensitive Ops across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (75%)`
- Positive signals: Native exec and plugin approval live scenarios exist; source and tests cover approval subscriptions, rendering, auth, origin targets, account filters, plugin fallback suppression, and many action-runtime gates.
- Negative signals: Live proof is thinner for destructive actions, read/download scope boundaries, reaction/pin operations, member/emoji actions, and cross-account approval routing.
- Integration gaps: Add live action scenarios for read/edit/delete/pin/reaction/download-file, unauthorized action attempts, cross-account approval targets, and Slack button-click failure handling.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `#81901`, `#76185`, `#82240`, `#78793`, `#86983`, and `#7234` indicate approval context, interaction threading, plugin approval payload, fallback text, outbound DM authorization, and action-gate granularity concerns.
- Discrawl reports: A Slack approvals support thread shows users confusing `capabilities.interactiveReplies` with `execApprovals`, expecting bare `/approve` to work in single-command mode, and needing callback plumbing checks.
- Good qualities: Approval code distinguishes exec versus plugin approvers, suppresses generic fallback only when native delivery can handle it, and documents manual fallback behavior.
- Bad qualities: Approval UX has several similarly named switches, Slack manual fallback differs between `/openclaw /approve` and native `/approve`, and action groups still mix safe reads with destructive operations behind coarse enablement.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (75%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Approvals, Actions, Security-sensitive Ops.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add operator diagnostics that explain why an approval button click did not reach the gateway.
- Split action gates more granularly for destructive versus read-only Slack operations.
- Add outbound DM allowlist or target authorization before agents can initiate arbitrary Slack user DMs.

## Evidence

### Docs

- `docs/channels/slack.md` documents Actions and gates, native approvals, exec/plugin approval routing, same-chat `/approve`, approver config paths, native-client auto behavior, and Slack approval fallback caveats.
- `docs/tools/exec-approvals.md` and `docs/tools/exec-approvals-advanced.md` are linked shared approval references.

### Source

- `extensions/slack/src/approval-native.ts`, `approval-auth.ts`, `approval-handler.runtime.ts`, `exec-approvals.ts`, and `approval-native-gates.ts` implement Slack native approvals and auth.
- `extensions/slack/src/action-runtime.ts`, `actions.ts`, `channel-actions.ts`, `message-actions.ts`, and `message-action-dispatch.ts` implement Slack actions and action dispatch.
- `extensions/slack/src/channel.ts` exposes action capabilities and token selection to the shared channel plugin surface.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` includes `slack-approval-exec-native` and `slack-approval-plugin-native`.
- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.test.ts` verifies native approval scenario selection, approval config, button-value extraction, checkpoint evidence, and redaction.

### Unit tests

- `extensions/slack/src/approval-native.test.ts`, `approval-auth.test.ts`, `approval-handler.runtime.test.ts`, and `exec-approvals.test.ts` cover native approval routing and rendering.
- `extensions/slack/src/action-runtime.test.ts` covers reactions, download-file, upload-file, edit, read, pin, token selection, and allowlist rejection.
- `extensions/slack/src/actions.read.test.ts`, `actions.reactions.test.ts`, `actions.download-file.test.ts`, `message-tools.test.ts`, and `message-action-dispatch.test.ts` cover action details.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack approval" --json`
- `gitcrawl search openclaw/openclaw --query "slack actions reactions pins read delete" --json`

Results:

- Approval search returned `#81901`, `#76185`, `#82240`, `#78793`, and related channel-mediated approval issues.
- Action search returned `#7234`, noting Slack already has separate toggles for reactions, pins, member info, and emoji list while Discord action gates remain less granular.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack approvals execApprovals approve buttons"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack actions reactions pins read delete"`

Results:

- Approval query returned a support thread where Slack approval buttons rendered but did not propagate, with guidance about `execApprovals`, `/openclaw /approve`, native commands, and callback plumbing.
- Action query returned capability output listing Slack support for direct/channel/thread, reactions, media, native commands, send/broadcast/react/read/edit/delete/download-file/pin/member-info/emoji-list.
