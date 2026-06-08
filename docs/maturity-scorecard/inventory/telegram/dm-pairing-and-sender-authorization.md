---
title: "Telegram - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Access and Identity Maturity Note

## Summary

Telegram DM pairing and sender authorization are mature enough for regular use.
The docs explicitly separate DM pairing from group authorization, numeric sender
IDs are emphasized, and runtime code uses shared access helpers plus
Telegram-specific normalization. This remains Beta on Quality because operator
confusion around owner IDs, group pairing expectations, and allowlist defaults
is still visible.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Access and Conversation Routing`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- dmPolicy modes: pairing, allowlist, open, and disabled
- Pairing-code approval: Pairing-code approval, first-owner bootstrap, and commands.ownerAllowFrom
- Numeric Telegram user ID normalization with telegram: and tg: prefixes
- allowFrom: allowFrom, groupAllowFrom, access groups, and DM-versus-group boundaries
- Unauthorized DM: Unauthorized DM, group, command, callback, and reaction handling
- Group allowlists: Group allowlists, groupPolicy, groupAllowFrom, and mention gating
- Supergroup negative chat IDs: Supergroup negative chat IDs and group/topic config inheritance
- Forum topic session keys: Forum topic session keys, message_thread_id, General topic behavior, and topic routing.
- ACP topic routing: ACP topic binding and /acp spawn --thread
- Session key construction: Session key construction, conversation route matching, and reply target

## Features

- dmPolicy modes: pairing, allowlist, open, and disabled
- Pairing-code approval: Pairing-code approval, first-owner bootstrap, and commands.ownerAllowFrom
- Numeric Telegram user ID normalization with telegram: and tg: prefixes
- allowFrom: allowFrom, groupAllowFrom, access groups, and DM-versus-group boundaries
- Unauthorized DM: Unauthorized DM, group, command, callback, and reaction handling
- Group allowlists: Group allowlists, groupPolicy, groupAllowFrom, and mention gating
- Supergroup negative chat IDs: Supergroup negative chat IDs and group/topic config inheritance
- Forum topic session keys: Forum topic session keys, message_thread_id, General topic behavior, and topic routing.
- ACP topic routing: ACP topic binding and /acp spawn --thread
- Session key construction: Session key construction, conversation route matching, and reply target

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals:
  DM access, group access, command authorization, sender normalization, and
  first-owner setup have focused source and tests.
- Negative signals:
  live proof is centered on group mention and command scenarios; it does not
  repeatedly prove every pairing, owner bootstrap, access-group, and open-bot
  branch.
- Integration gaps:
  add release proof for first DM pairing, first-owner bootstrap, allowlist-only
  DM, public-bot open mode, and failed unauthorized sender flows.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  #7679, #84447, #81876, #11489, #41058, and #79111 show ongoing demand for
  safer defaults, rate limits, group-pairing UX, and clearer pairing messages.
- Discrawl reports:
  maintainer discussion points to a broader channel-ingress refactor, and
  Discord mirror comments still call out Telegram group pairing as an open
  request.
- Good qualities:
  the docs call out the exact DM versus group authorization boundary, runtime
  normalizes sender IDs, and group sender auth intentionally does not inherit DM
  pairing-store approvals.
- Bad qualities:
  pairing remains easy to overgeneralize as "authorized everywhere", and group
  onboarding lacks an owner-notification approval flow.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for dmPolicy modes, Pairing-code approval, Numeric Telegram user ID normalization with telegram, allowFrom, Unauthorized DM, Group allowlists, Supergroup negative chat IDs, Forum topic session keys, ACP topic routing, Session key construction.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a group pairing or owner-notification workflow if product direction wants
  group onboarding without manual config edits.
- Add clearer diagnostics when a user is paired for DM but blocked in a group.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents DM policy,
  numeric user IDs, owner-only bootstrap, and the DM/group authorization split.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md` is the linked
  pairing reference.
- `/Users/kevinlin/code/openclaw/docs/channels/access-groups.md` documents
  reusable access-group behavior.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.ts`
  evaluates DM access, group access, command authorization, and access facts
  before dispatch.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/dm-access.ts`
  enforces Telegram DM policy.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-access.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/allow-from.ts` handle
  group sender access and ID normalization.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/access-groups.ts`
  expands access-group entries.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/setup-core.ts`
  provides setup help and Telegram ID parsing.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  includes mention-gating, command authorization, and other-bot command-gating
  live scenarios.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-config.mjs`
  writes `groupPolicy`, `groupAllowFrom`, group IDs, and mention-gated group
  config for the live RTT harness.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/dm-access.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-access.base-access.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-policy.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-native-commands.group-auth.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.session-meta.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.reactions.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Telegram pairing allowlist" --json`

Results:

- #7679 issue open: Telegram should default to allowlist mode with owner ID.
- #84447 issue open: per-sender inbound DM rate limit for channel
  pairing/allowlist policies.
- #81876 issue open: auto-flip channel DM defaults to allowlist owner after
  first-owner bootstrap.
- #11489 issue open: group pairing flow with owner notification and read-only
  mode for unconfigured groups.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram allowlist pairing"`

Results:

- `maintainers`, 2026-05-07: channel ingress refactor note listed DM policy,
  group policy, `allowFrom`, `groupAllowFrom`, access groups, and pairing as
  duplicated policy to consolidate.
- `[openclaw] openclaw`, 2026-04-26: issue #41753 was closed after Telegram DMs
  using `dmPolicy: "pairing"` and `allowFrom` were covered by numeric sender ID
  authorization.
- `[openclaw] openclaw`, 2026-04-26: issue #11489 stayed open because group
  pairing remains absent.
