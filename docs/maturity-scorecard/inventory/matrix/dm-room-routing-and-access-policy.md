---
title: "Matrix - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Access and Identity Maturity Note

## Summary

Matrix DM and room routing is feature-rich: it supports allowlists, group
sender restrictions, pairing, direct-room classification, recent invite
promotion, bot-loop policy, mention gates, access state, live allowlist reload,
and session route selection. Coverage is Beta because there are many unit and
QA routes, but this is a broad stateful policy surface. Quality is Beta because
gitcrawl has open reports for mention parsing and message delivery to sessions.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Conversation Routing and Access`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM policy: DM policy, pairing, allowFrom, groupAllowFrom, room allowlists, and live access checks.
- Direct-room classification: Direct-room classification and repair-adjacent routing decisions
- Inbound route selection across sender-bound DMs: Inbound route selection across sender-bound DMs, room bindings, and account-scoped routes.
- Mention gates: Mention gates, slash command access checks, bot-loop suppression, and context admission.
- Matrix thread reply routing: Matrix thread reply routing, thread root/context extraction, and thread-aware session placement.
- Persisted Matrix thread routing managers: Persisted Matrix thread binding managers, child session binding, and activity tracking.
- ACP/subagent spawn hooks: ACP/subagent spawn hooks and Matrix delivery targets for child sessions

## Features

- DM policy: DM policy, pairing, allowFrom, groupAllowFrom, room allowlists, and live access checks.
- Direct-room classification: Direct-room classification and repair-adjacent routing decisions
- Inbound route selection across sender-bound DMs: Inbound route selection across sender-bound DMs, room bindings, and account-scoped routes.
- Mention gates: Mention gates, slash command access checks, bot-loop suppression, and context admission.
- Matrix thread reply routing: Matrix thread reply routing, thread root/context extraction, and thread-aware session placement.
- Persisted Matrix thread routing managers: Persisted Matrix thread binding managers, child session binding, and activity tracking.
- ACP/subagent spawn hooks: ACP/subagent spawn hooks and Matrix delivery targets for child sessions

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs cover DM policy, pairing, room repair, group settings, command access,
    context visibility, and target grammar.
  - Source has explicit inbound route resolution, allowlist normalization,
    direct-room classification, mention resolution, access state, room history,
    and handler gates.
  - Unit tests cover allowlists, direct-room classification, route precedence,
    per-room DM sessions, live allowlist reload, mention gates, pairing, bot
    loops, cold-start backlog, durable dedupe, and access state.
  - QA scenarios cover DM rooms, secondary rooms, allowBots behavior, hot
    allowlist reload, stale replies, control command blocking, and shared DM
    notices.
- Negative signals:
  - The policy matrix has many combinations across accounts, rooms, senders,
    mentions, threads, and direct-room heuristics.
  - Archive reports show real user-facing routing failures still occur.
- Integration gaps:
  - Add a live routing matrix that enumerates room type, account id, allowlist
    mode, mention state, direct-room metadata, and route target.
  - Add release evidence for Matrix group and DM access policy after hot config
    reload.
  - Add a direct mapping from documented DM policy values to QA scenario ids.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "matrix dm room allowlist pairing mention"` returned no hits.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned open issue #83142 for display-name mention parsing, open issue #68188 for messages not delivered to an agent session, open PR #85172 for `is_direct: false` handling, and open PR #73455 for participation/freshness controls.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix DM room allowlist pairing mention"` returned no hits.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned release chatter mentioning Matrix mention behavior.
- Good qualities:
  - Handler logic has explicit gates before dispatch, including event kind,
    sender identity, bot-loop policy, room/DM policy, mentions, command access,
    pairing, and route resolution.
  - Route selection preserves account scoping and can prioritize runtime
    conversation bindings, configured room bindings, DM sender routes, and
    per-room DM session scope.
  - Direct-room classification has multiple vetoes and cache invalidation
    paths, reducing accidental trust of stale Matrix room metadata.
  - Live allowlist reload is modeled directly instead of requiring gateway
    restart for every sender update.
- Bad qualities:
  - Mention parsing and route delivery have active open reports.
  - The number of policy dimensions makes operator mental models difficult,
    especially when `m.direct`, room config, recent invite promotion, and
    allowlists disagree.
  - Some Matrix homeserver metadata can be stale or incomplete, which pushes
    correctness into fallback logic.
- Excluded from quality:
  - I did not raise or lower Quality because of unit, integration, e2e, live, or
    runtime test coverage.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM policy, Direct-room classification, Inbound route selection across sender-bound DMs, Mention gates, Matrix thread reply routing, Persisted Matrix thread routing managers, ACP/subagent spawn hooks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Build an operator-facing decision table for DM policy, room policy, mention
  policy, and bot-loop policy.
- Close or retest active mention and route delivery reports before moving
  Quality above Beta.
- Add a scorecard appendix mapping every documented access policy option to at
  least one Matrix QA scenario.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:608` documents DM and
  room policy plus pairing.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:656` documents direct
  room repair.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:704` documents slash
  commands in DMs and rooms.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:812` documents target
  resolution.
- `/Users/kevinlin/code/openclaw/docs/channels/groups.md:296` documents Matrix
  group allowlist behavior and stable room targets.
- `/Users/kevinlin/code/openclaw/docs/channels/bot-loop-protection.md:123`
  documents Matrix bot-loop protection keyed by account, room, and bot pair.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:569`
  filters events, dedupes inbound messages, and classifies direct rooms.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:682`
  applies room policy and allowlist gates.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:803`
  handles DM policy and pairing behavior.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:909`
  resolves mentions, routes, command access, and pending room history.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.ts:2136`
  dispatches inbound messages through the channel runtime.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/route.ts:42`
  resolves Matrix inbound routes and session keys.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/allowlist.ts:33`
  normalizes and resolves Matrix user allowlist entries.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/direct.ts:45`
  implements direct-room tracking and cache refresh.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/mentions.ts:114`
  strips mention prefixes and validates Matrix mention labels.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1378`
  allows observer messages when sender allowlist overrides include them.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1444`
  runs mentioned `allowBots=mentions` room traffic through an observer bot.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1491`
  blocks unmentioned bot traffic even when the room is open.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1561`
  blocks MXID-prefixed control commands from non-allowlisted observers.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1661`
  hot-reloads group allowlist removals inside one running gateway.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2565`
  runs the DM scenario against the provisioned DM room without a mention.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4586`
  surfaces the shared DM session notice in a secondary DM room.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/allowlist.test.ts:4`
  covers Matrix allowlist matching.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/route.test.ts:72`
  prefers sender-bound DM routing over fallback bindings.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/route.test.ts:121`
  lets configured ACP room bindings override DM parent-peer routing.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/direct.test.ts:86`
  treats `m.direct` rooms as DMs.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/direct.test.ts:286`
  treats self `is_direct: false` member state as a non-DM signal.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.test.ts:706`
  blocks room control commands from DM-only paired senders.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.test.ts:811`
  processes room messages mentioned via display name.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.test.ts:2053`
  covers live allowlist reload behavior.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/session-route.test.ts:189`
  covers outbound session route reuse for Matrix DMs.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "matrix dm room allowlist pairing mention"`
  returned no hits.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned #83142,
  #68188, #85172, #73455, and other Matrix routing-adjacent issues/PRs.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix DM room allowlist pairing mention"`
  returned no hits.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned release chatter mentioning Matrix channel validation and mention
  behavior.
