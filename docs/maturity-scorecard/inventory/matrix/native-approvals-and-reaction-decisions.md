---
title: "Matrix - Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Approvals Maturity Note

## Summary

Matrix native approvals have a strong implementation surface: exec and plugin
approval capability registration, approver restrictions, same-channel
suppression, origin target matching, approver DM targets, native delivery
adapter, Matrix metadata events, reaction anchors, persistent reaction target
state, and gateway resolution. Coverage is Alpha because direct Matrix approval
live proof is thinner than the rest of Matrix. Quality is Beta because the
source is robust, but discrawl has a review comment about reaction hints on
chunked approval messages.

## Category Scope

Included in this category:

- Matrix native exec: Matrix native exec and plugin approval capability
- Origin target resolution from Matrix turn: Origin target resolution from Matrix turn source, session fallback, and approval routing.
- Approver DM target resolution: Approver DM target resolution, forwarding fallback suppression, and native approval delivery.
- Matrix approval metadata: Matrix approval metadata, reaction hints, reaction anchor persistence, and decision state.

## Features

- Matrix native exec: Matrix native exec and plugin approval capability
- Origin target resolution from Matrix turn: Origin target resolution from Matrix turn source, session fallback, and approval routing.
- Approver DM target resolution: Approver DM target resolution, forwarding fallback suppression, and native approval delivery.
- Matrix approval metadata: Matrix approval metadata, reaction hints, reaction anchor persistence, and decision state.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals:
  - Docs document exec approvals and Matrix approval config keys.
  - Source has capability registration, origin matching, approver DM targets,
    DM repair, approval metadata, retries, chunk fallback, reaction target
    persistence, and gateway resolution.
  - Unit tests cover setup descriptions, origin target matching, approver
    targets, same-channel suppression, plugin vs exec approvers, runtime
    delivery, reaction anchors, persistent reaction state, and gateway
    resolution.
  - Matrix QA covers approval reaction echo and observed approval reuse.
- Negative signals:
  - Direct Matrix approval integration evidence is much narrower than routing,
    media, or E2EE evidence.
  - Long/chunked approval text and reaction anchor placement have review
    history.
- Integration gaps:
  - Add live approval scenarios for exec approval, plugin approval, DM-only
    target, origin-channel target, target=both, chunked approval text, and
    gateway restart.
  - Add release evidence that reaction anchors survive process restart via
    persistent target state.
  - Add docs showing approval reaction behavior for chunked approval messages.

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
  - Query `gitcrawl --json search openclaw/openclaw --query "Matrix exec approvals reactions"` returned no hits.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` did not surface a top Matrix approval outage, but broader Matrix send/routing issues still affect approval delivery paths.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix exec approvals approval reactions"` returned a GitHub review comment on PR #60931: "matrix: add exec approval reaction shortcuts"; the comment warned that long approvals could put the `React here` hint in a later chunk while reactions were anchored to the first chunk.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned general release and scorecard discussion.
- Good qualities:
  - Native approval capability restricts approvers and separates plugin approval
    auth from exec approval config.
  - Origin target matching normalizes Matrix user and room targets while
    preserving thread ids.
  - Runtime delivery retries transient send failures and direct-room repair
    failures.
  - Approval metadata is versioned and reactions have persistent target state.
- Bad qualities:
  - Coverage is narrow and the best archive signal is a review-time chunking
    concern rather than repeated live success evidence.
  - Approval delivery depends on send, room repair, reaction, and gateway
    resolution surfaces all working together.
  - Reaction anchors can be subtle when approval content is chunked.
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

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Matrix native exec, Origin target resolution from Matrix turn, Approver DM target resolution, Matrix approval metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add Matrix-native approval scenarios to the release-critical Matrix profile.
- Revalidate chunked approval text with reaction hints and anchors.
- Add one operator doc section showing how Matrix approval targets, approvers,
  and origin suppression interact.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:678` documents exec
  approvals.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:895` documents
  approval config references.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:658`
  documents Matrix plugin-backed channel configuration.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.ts:61`
  resolves Matrix origin targets from turn source.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.ts:152`
  creates the Matrix native origin target resolver.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.ts:182`
  resolves Matrix approver DM targets.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.ts:199`
  creates the approver-restricted Matrix native approval capability.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.ts:46`
  defines versioned Matrix approval metadata.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.ts:182`
  retries Matrix approval delivery.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.ts:201`
  prepares approval targets and repairs direct rooms for user targets.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-reactions.ts:25`
  defines persistent reaction target state.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-reactions.ts:164`
  lists approval reaction bindings and hints.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/exec-approval-resolver.ts:8`
  resolves Matrix approval decisions through the shared gateway resolver.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:581`
  waits for Matrix approval reaction echo before awaiting the decision.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:676`
  reuses observed Matrix approval events across channel and DM target waits.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.test.ts:48`
  describes native Matrix approval delivery capabilities.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.test.ts:76`
  resolves origin targets from Matrix turn source.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.test.ts:102`
  resolves approver DM targets.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.test.ts:180`
  keeps plugin approval auth independent from exec approvers.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.test.ts:179`
  sends versioned Matrix approval content for pending exec approvals.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.test.ts:297`
  binds Matrix approval reactions before publishing option reactions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-handler.runtime.test.ts:430`
  falls back to chunked Matrix delivery.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-reactions.test.ts:33`
  resolves registered approval anchor events to approval decisions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-reactions.test.ts:111`
  persists approval reaction targets when runtime state is available.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/exec-approval-resolver.test.ts:17`
  submits approval resolutions through the shared gateway resolver.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "Matrix exec approvals reactions"`
  returned no hits.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned no
  top approval-specific outage in the returned set, but did return broader
  Matrix send/routing issues.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix exec approvals approval reactions"`
  returned a GitHub review comment on PR #60931 warning about reaction hints and
  anchors for long chunked approval text.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned general release and scorecard discussion.
