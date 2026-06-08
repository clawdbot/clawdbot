---
title: "Slack - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Access and Identity Maturity Note

## Summary

Slack DM access is implemented with pairing, allowlists, open mode guarded by `allowFrom: ["*"]`, group-DM controls, account inheritance, and command authorization. The component is Beta because implementation and docs are broad, while operator confusion persists around pairing in managed hosting, account-scope overrides, group DMs, owner allowlists, and missing outbound DM allowlist controls.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Conversation Access and Routing`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Channel allowlists: Covers channel allowlists, `groupPolicy`, channel/user gates, mention gates, and subteam mention behavior.
- Thread routing: Covers Slack thread routing, thread-aware reply targeting, and session binding for channel threads.
- Session Isolation: Covers Session Isolation across channel allowlists, `groupPolicy`, channel/user gates, mention and subteam mention behavior, and related channel/thread routing and session isolation behavior.
- DM Pairing: Covers DM Pairing across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.
- Sender Authorization: Covers Sender Authorization across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.

## Features

- Access and Identity: Evidence scope for Access and Identity.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Source and tests cover allowlist precedence, open-mode guardrails, pairing messages, DM auth, named-account inheritance, group-DM flags, command authorization, and Slack live allowlist-block behavior.
- Negative signals: The Slack live lane is channel-centric and does not yet run a full DM pairing/open/allowlist/group-DM scenario set.
- Integration gaps: Need live coverage for first-time Slack DM pairing, hosted/RPC-managed allowlist onboarding, account override conflicts, MPIM enablement, and blocked-sender operator copy.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `#86983` requests an outbound DM allowlist, and broader Slack `dmPolicy allowFrom` results include thread/routing and config-rewrite confusion.
- Discrawl reports: Support threads show managed-hosting users asking how to avoid CLI pairing, why `dmPolicy: "open"` still asks for pairing, and how top-level versus account-level `allowFrom` affects behavior.
- Good qualities: Config schema rejects `dmPolicy="open"` without wildcard allowlist, docs state DM policies and multi-account precedence, and source fails unauthorized senders closed.
- Bad qualities: Pairing is still awkward for no-terminal installs, account-scoped config is easy to misapply, group-DM behavior is opt-in, and outbound DM sends have less policy control than inbound DM admission.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Access and Identity.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live DM pairing, DM allowlist, DM open, and MPIM scenarios.
- Add RPC/dashboard pairing-management guidance for hosted Slack deployments.
- Add outbound DM target authorization so inbound `allowFrom` does not imply unrestricted agent-initiated DMs.

## Evidence

### Docs

- `docs/channels/slack.md` documents `dmPolicy`, canonical `allowFrom`, group-DM flags, multi-account precedence, legacy migration, and `openclaw pairing approve slack <code>`.
- `docs/channels/pairing.md` is linked from Slack docs as the shared pairing model.

### Source

- `extensions/slack/src/config-schema.ts` validates DM policy and rejects open DM policy without wildcard allowlist.
- `extensions/slack/src/accounts.ts` resolves default/named account `allowFrom` and legacy `dm.allowFrom`.
- `extensions/slack/src/monitor/dm-auth.ts`, `extensions/slack/src/monitor/auth.ts`, and `extensions/slack/src/monitor/message-handler/prepare.ts` enforce Slack sender authorization before dispatch.
- `extensions/slack/src/monitor/slash.ts` applies command authorization and blocked-sender responses for Slack commands.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` includes `slack-allowlist-block`, which verifies blocked channel senders in a live workspace.
- No full live Slack DM pairing or MPIM scenario was found.

### Unit tests

- `extensions/slack/src/config-schema.test.ts` covers `dmPolicy="open"` and legacy policy behavior.
- `extensions/slack/src/accounts.test.ts` covers allowlist precedence, named-account inheritance, legacy alias handling, and mixed-case account keys.
- `extensions/slack/src/monitor/dm-auth.test.ts`, `extensions/slack/src/monitor/allow-list.test.ts`, `extensions/slack/src/resolve-allowlist-common.test.ts`, and `src/pairing/pairing-messages.test.ts` cover DM auth and pairing copy.

### Gitcrawl queries

Query:

- `gitcrawl search issues "Slack dmPolicy allowFrom pairing group DM authorization" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "slack dmPolicy allowFrom" --json`

Results:

- The focused issue search returned `[]`.
- The broader query returned `#86983`, "Feature request: Outbound DM allowlist (dmAllowTo)", plus adjacent config/routing results involving Slack `dmPolicy` and `allowFrom`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack dmPolicy allowFrom pairing"`

Results:

- Returned hosted setup and Slack DM pairing discussions, including CLI-less pairing friction, `dmPolicy="open"` requiring `allowFrom: ["*"]`, account-level override advice, MPIM/session-scope notes, and runtime confusion when pairing still appears.
