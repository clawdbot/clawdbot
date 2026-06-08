---
title: "Microsoft Teams - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Access and Identity Maturity Note

## Summary

Teams DM and sender authorization are source-strong: the plugin uses shared
ingress policy, stable AAD object IDs by default, pairing-store allowlists, and
explicit invoke gates. Coverage remains Alpha because the audit did not find a
live Teams pairing scenario or enterprise admin flow proof for Graph-resolved
allowlists and config writes.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Identity and Authorization`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM pairing: Covers DM pairing across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Stable sender identity: Covers Stable sender identity across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Allowlists and access groups: Covers Allowlists and access groups across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Invoke and command authorization: Covers Invoke and command authorization across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Teams-originated config writes: Covers Teams-originated config writes across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Bot Framework SSO invokes: Covers Bot Framework SSO invoke handling and OAuth token exchange for Microsoft Teams users.
- Delegated token storage: Covers delegated token storage, token refresh, and recovery for Microsoft Teams user auth.
- Graph directory lookup: Covers Graph app token resolution and directory lookup behavior for Teams routing and user metadata.
- Member profile lookup: Covers member info lookup and user metadata retrieval for Microsoft Teams conversations.
- Bot Framework SSO invokes: Covers Bot Framework SSO invoke handling and OAuth token exchange for Microsoft Teams users
- Delegated token storage: Covers delegated token storage, token refresh, and recovery for Microsoft Teams user auth
- Graph directory lookup: Covers Graph app token resolution and directory lookup behavior for Teams routing and user metadata
- Member profile lookup: Covers member info lookup and user metadata retrieval for Microsoft Teams conversations

## Features

- DM pairing: Covers DM pairing across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Stable sender identity: Covers Stable sender identity across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Allowlists and access groups: Covers Allowlists and access groups across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Invoke and command authorization: Covers Invoke and command authorization across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Teams-originated config writes: Covers Teams-originated config writes across DM pairing, `dmPolicy`, `allowFrom`, AAD ID matching, and related dm pairing and sender access behavior.
- Bot Framework SSO invokes: Covers Bot Framework SSO invoke handling and OAuth token exchange for Microsoft Teams users.
- Delegated token storage: Covers delegated token storage, token refresh, and recovery for Microsoft Teams user auth.
- Graph directory lookup: Covers Graph app token resolution and directory lookup behavior for Teams routing and user metadata.
- Member profile lookup: Covers member info lookup and user metadata retrieval for Microsoft Teams conversations.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Runtime source handles pairing request creation, stable ID
  matching, command access, group fallback, and invoke auth; unit tests exercise
  these policy seams.
- Negative signals: No Teams-specific live pairing, unauthorized sender,
  authorized sender, or config-write scenario report was found.
- Integration gaps: Missing tenant-backed pairing proof with AAD object IDs,
  Graph-resolved names, access groups, unknown senders, and config-write
  toggles.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Focused searches for Teams `dmPolicy`, `allowFrom`,
  `groupPolicy`, and pairing returned no direct hits.
- Discrawl reports: Focused pairing/authorization searches returned no lines;
  broad channel-ingress archive context discusses moving shared message-channel
  ingress policy into core while keeping platform facts plugin-owned.
- Good qualities: Sender access is fail-closed, ID-first, shared-policy based,
  pairing-aware, and reused for card/signin/feedback invokes and approval auth.
- Bad qualities: Name/UPN resolution is Graph-dependent and intentionally
  dangerous unless opted in; config writes are enabled by default when command
  config is enabled; live admin proof is missing.
- Excluded from quality: Unit-test count, authz test depth, and lack of live
  pairing tests.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM pairing, Stable sender identity, Allowlists and access groups, Invoke and command authorization, Teams-originated config writes, Bot Framework SSO invokes, Delegated token storage, Graph directory lookup, Member profile lookup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live Teams DM pairing scenarios for unknown sender, approved sender,
  disabled DM, allowlist, open DM, and config-write disabled states.
- Add operator proof for Graph-resolved user names and failure behavior when
  Graph permissions are missing.
- Add a Teams-specific approval-auth scenario with AAD GUID approvers.

## Evidence

### Docs

- `docs/channels/msteams.md` documents `dmPolicy="pairing"`, stable AAD object
  IDs, access groups, disabled direct name matching, Graph name resolution, and
  config writes.
- `docs/channels/pairing.md` documents supported pairing channels and states
  that DM pairing does not grant group authorization.
- `docs/channels/access-groups.md` documents channel support for static sender
  access groups.

### Source

- `extensions/msteams/src/monitor-handler/access.ts` resolves sender access
  through shared stable channel ingress, pairing store, `allowFrom`,
  `groupAllowFrom`, access groups, route gates, and mutable identifier policy.
- `extensions/msteams/src/monitor-handler/message-handler.ts` drops unapproved
  DMs, creates pairing requests, logs allowlist decisions, blocks unauthorized
  control commands, and records allowed conversation references.
- `extensions/msteams/src/monitor-handler.ts` gates card, sign-in, and feedback
  invokes through sender policy.
- `extensions/msteams/src/approval-auth.ts` normalizes approvers to stable
  `user:<aad-guid>` identities.

### Integration tests

- No Teams live or e2e pairing scenario was found by `rg`.
- Runtime-flow coverage is represented by handler and lifecycle tests, not by a
  tenant-backed DM flow.

### Unit tests

- `extensions/msteams/src/monitor-handler/message-handler.authz.test.ts` covers
  DM pairing separation, unauthorized controls, access groups, quote/thread
  filtering, and policy behavior.
- `extensions/msteams/src/monitor.lifecycle.test.ts` covers card, poll, and SSO
  auth gates.
- `extensions/msteams/src/channel.test.ts` covers approval auth exposure and
  stable Teams ID authorization behavior.

### Gitcrawl queries

Query:

- `gitcrawl search issues "msteams Teams pairing allowFrom dmPolicy groupPolicy teams channels mention" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams dmPolicy allowFrom groupPolicy pairing" --json --limit 10`

Results:

- Both focused searches returned `[]`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams pairing dmPolicy allowFrom sender authorization"`

Results:

- The focused query returned no lines.
