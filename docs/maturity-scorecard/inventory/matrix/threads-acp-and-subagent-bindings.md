---
title: "Matrix - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Conversation Routing and Delivery Maturity Note

## Summary

Matrix threads and subagent binding support is substantial but still risky.
Source implements thread route keys, thread starter context, persisted binding
managers, child session binding, sweeper cleanup, ACP spawn hooks, and delivery
target resolution. Coverage is Beta because Matrix QA covers thread overrides
and subagent spawn paths, but Quality is Alpha because gitcrawl has an open
report that Matrix thread replies were sent as normal replies and slash
commands went silent.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Conversation Routing and Access`, `Messaging and Room Tools`
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
- Channel action discovery: Channel action discovery, account-scoped action gates, and tool schemas
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools.
- Profile media loading: Profile media loading from URL or local path.
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior.
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior.
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies.
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools
- Profile media loading: Profile media loading from URL or local path
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies

## Features

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals:
  - Docs cover Matrix threads, `sessionScope`, `threadReplies`, `/focus`,
    `/acp spawn`, and thread binding config.
  - Source has case-sensitive thread route keys, thread root extraction,
    binding state persistence, child binding adapters, unbind/sweeper logic,
    subagent spawn hooks, and outbound session-route recovery.
  - Unit tests cover thread routing, thread starter context, public thread
    binding API, persisted bindings, subagent spawn, delivery target
    resolution, and session route recovery.
  - Matrix QA covers room and DM thread overrides plus subagent thread spawn
    scenarios.
- Negative signals:
  - Thread behavior is complex because it crosses Matrix event ids, OpenClaw
    session keys, ACP child session lifecycle, and outbound reply placement.
  - Active archive evidence shows user-visible thread regressions.
- Integration gaps:
  - Add a release-critical Matrix thread lane that covers top-level room
    threads, DM thread overrides, child subagent spawn, final delivery, and
    restart.
  - Add live evidence for slash command handling inside Matrix threads.
  - Add artifact links from QA failures to Matrix root/reply event ids.

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

- Score: `Alpha (66%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "matrix thread replies acp subagent binding"` returned open PR #69824 for ACP runtime consolidation.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned open issue #87307 for Matrix thread replies sent as normal replies and `/status` plus `/model` silent, open PR #71738 for Matrix thread history and reply placement, open PR #85112 for mention bypass in bound threads, and open issue #78249 for Matrix missing skills injection/path/shell behavior compared to WebChat.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix thread replies ACP subagent binding"` returned no hits.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned general Matrix release and scorecard discussion.
- Good qualities:
  - Thread ids preserve Matrix event-id case in route keys.
  - Binding persistence is account-scoped and state-dir sensitive.
  - Child binding code distinguishes top-level room placement from existing
    thread placement.
  - Subagent hooks fail closed when Matrix thread bindings or spawn sessions are
    unavailable.
- Bad qualities:
  - Active open thread reply and silent command report keeps this at Alpha.
  - Thread correctness depends on current session metadata, Matrix relation
    metadata, room root event availability, and child session lifecycle.
  - ACP/subagent behavior is still tied to broader runtime consolidation.
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

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Conversation Routing and Delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Close or retest #87307 before raising Quality above Alpha.
- Add live command tests inside bound Matrix threads.
- Preserve Matrix event-id case and root event diagnostics in thread failure
  artifacts.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:502` documents
  Matrix threads.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:541` documents
  `/focus` behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:555` documents
  `/acp spawn` and thread binding config.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.ts:44`
  defines binding state paths and load/persist behavior.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.ts:198`
  manages binding load and persistence queueing.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.ts:410`
  creates current/child Matrix thread bindings.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.ts:497`
  handles unbind and sweeper cleanup.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/threads.ts:11`
  preserves Matrix case-sensitive thread session keys.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/thread-context.ts:50`
  resolves and caches thread root context.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/thread-binding-api.ts:4`
  exposes Matrix thread binding placement and conversation resolution.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/subagent-hooks.ts:105`
  binds spawned subagents to Matrix threads.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/session-route.ts:74`
  resolves outbound routes from Matrix session metadata.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2643`
  runs room thread override scenarios against the main room.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2690`
  runs subagent thread spawn against a child thread.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2807`
  fails subagent thread spawn when Matrix lacks subagent hooks.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2841`
  fails subagent thread spawn on surfaced tool errors.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4510`
  uses DM thread override scenarios against the provisioned DM room.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/threads.test.ts:5`
  covers flat sessions when thread replies are off.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/threads.test.ts:18`
  covers inbound thread root routing.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/thread-context.test.ts:40`
  resolves and caches thread starter context.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/thread-binding-api.test.ts:7`
  covers public Matrix thread binding API behavior.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.test.ts:189`
  creates child Matrix thread bindings from top-level room context.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/thread-bindings.test.ts:691`
  flushes pending touch persistence on stop.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/subagent-hooks.test.ts:208`
  allows thread-bound subagent spawn by default.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/subagent-hooks.test.ts:631`
  resolves child delivery target with thread id.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/session-route.test.ts:277`
  recovers Matrix thread routes and preserves event-id case.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "matrix thread replies acp subagent binding"`
  returned open PR #69824.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned #87307,
  #71738, #85112, #78249, and other Matrix thread-adjacent hits.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix thread replies ACP subagent binding"`
  returned no hits.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned general Matrix release and scorecard discussion.
