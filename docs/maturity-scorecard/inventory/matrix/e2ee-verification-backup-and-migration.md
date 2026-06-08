---
title: "Matrix - Encryption and Verification Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Encryption and Verification Maturity Note

## Summary

Matrix E2EE is extensively implemented: setup guidance, startup verification,
recovery keys, secret storage, cross-signing bootstrap, SAS verification,
device hygiene, room-key backup, encrypted media, legacy crypto migration, and
migration snapshots all have source and QA evidence. Coverage is Beta because
the test and QA footprint is broad. Quality is Alpha because gitcrawl has
multiple open E2EE recovery, cross-signing, forced-reset, and persistence
reports.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Encryption and Verification`
- Merged from: `Encryption and Verification`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Encryption setup: Encryption setup, crypto availability, recovery-key storage, and secret storage.
- Encrypted media upload/download: Encrypted media upload/download and startup verification notices
- Legacy state: Legacy state and crypto migration, migration snapshots, and gateway startup repair.

## Features

- Encryption setup: Encryption setup, crypto availability, recovery-key storage, and secret storage.
- Encrypted media upload/download: Encrypted media upload/download and startup verification notices
- Legacy state: Legacy state and crypto migration, migration snapshots, and gateway startup repair.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs cover encryption setup, trust signals, verification commands, backup
    status/restore/reset, verification notices, device hygiene, crypto store
    paths, and migration flow.
  - Source implements recovery-key storage, secret-storage bootstrap,
    cross-signing, SAS verification actions, startup verification, encrypted
    media upload, legacy crypto migration, and migration snapshots.
  - Unit tests cover verification actions, crypto bootstrap, recovery-key
    store, verification manager, legacy crypto migration, IndexedDB
    persistence, and CLI verification commands.
  - Matrix QA covers E2EE isolated rooms, recovery-key setup, invalid
    recovery-key setup, self-verification, backup restore, destructive E2EE
    recovery, and faulted homeserver bootstrap failure.
- Negative signals:
  - E2EE correctness depends on homeserver behavior, Matrix SDK crypto state,
    local persistence, identity trust, and backup availability.
  - Active E2EE reports show destructive and recovery paths remain fragile.
- Integration gaps:
  - Add recurring live E2EE runs across MAS-fronted and non-MAS homeservers.
  - Add release artifacts that prove recovery-key restore, backup restore, and
    self-verification after gateway restart.
  - Add explicit pass/fail mapping for destructive crypto-state loss scenarios.

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

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "Matrix recovery key cross-signing backup"` returned open issues #78396 for forced reset cross-signing corrupting E2EE state, #73480 for recovery-key failure, #74504 for MAS-fronted Synapse bootstrap failure, #76611 for crypto-store persistence, plus open PR #74509 for MSC3967 handling.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` also returned open PR #74529 for `/keys/upload` OTK ID-collision handling.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix E2EE verification backup recovery key"` returned a GitHub mirror entry for PR #71311 adding destructive E2EE backup recovery coverage.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned Matrix release chatter and beta validation notes.
- Good qualities:
  - E2EE docs distinguish recovery-key access, backup health, cross-signing
    publication, full identity trust, and device hygiene.
  - Bootstrap code delays secret-storage mutation for forced cross-signing
    repair and supports password UIA fallback.
  - Verification actions keep self-verification in one started Matrix client
    session and wait for full identity trust.
  - Migration creates backup snapshots and separates legacy state migration
    from encrypted-state preparation.
- Bad qualities:
  - Active archive reports cover exactly the riskiest E2EE paths: recovery,
    cross-signing bootstrap, forced reset, OTK upload, and persistence.
  - Some repairs can be destructive or require operator intent, so defaults
    must remain conservative.
  - Matrix SDK and homeserver variance make this surface harder to guarantee
    than unencrypted messaging.
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

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Encryption setup, Encrypted media upload/download, Legacy state.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Retest or close #78396, #73480, #74504, #74509, #74529, and #76611 before
  raising Quality above Alpha.
- Add current live proof for MAS-fronted homeservers.
- Keep destructive E2EE recovery scenarios isolated and clearly labeled in QA
  reports.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:275` documents
  encryption setup, status, trust signals, and verification commands.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:360` documents
  backup status/restore/reset and verification lifecycle commands.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:429` documents startup
  verification, notices, deleted/invalid device handling, device hygiene, and
  crypto store paths.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix-migration.md:21`
  documents migration snapshots and covered state moves.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix-migration.md:135`
  documents encrypted migration flow.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.ts:25`
  requires crypto before verification actions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.ts:171`
  waits for full self-verification trust status.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.ts:238`
  lists and requests Matrix verifications.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/crypto-bootstrap.ts:48`
  bootstraps secret storage and cross-signing.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/crypto-bootstrap.ts:199`
  handles forced cross-signing reset and repair.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send/media.ts:203`
  uploads encrypted media.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/startup.ts:113`
  runs E2EE startup verification.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/legacy-crypto.ts:121`
  detects legacy Matrix encrypted state.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/migration-snapshot-backup.ts:65`
  creates or reuses pre-migration backup snapshots.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.startup-matrix-migration.integration.test.ts:4`
  covers gateway startup channel maintenance wiring for Matrix migration.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1012`
  provisions isolated encrypted rooms for E2EE scenarios.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:1049`
  runs an E2EE `state_after` regression through the fault proxy.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4983`
  ignores stale E2EE replies when checking a verification notice.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:5093`
  applies a recovery key before restoring backed-up room keys.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:5226`
  keeps recovery-key backup access distinct from Matrix identity trust.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:5415`
  runs Matrix self-verification through the interactive CLI command.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:7031`
  runs Matrix E2EE bootstrap failure through a real faulted homeserver endpoint.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.test.ts:218`
  prepares local crypto before verification status.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.test.ts:429`
  keeps self-verification in one started client session.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.test.ts:500`
  waits for full Matrix identity trust.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/verification.test.ts:627`
  waits for cross-signing keys to publish.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/crypto-bootstrap.test.ts:180`
  bootstraps cross-signing and secret storage.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/crypto-bootstrap.test.ts:367`
  avoids mutating secret storage before forced repair fails without password
  UIA.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/recovery-key-store.test.ts:118`
  loads stored recovery keys.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/legacy-crypto.test.ts:90`
  extracts saved backup keys into the new recovery-key path.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/sdk/idb-persistence.test.ts:116`
  serializes concurrent persist operations.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "Matrix recovery key cross-signing backup"`
  returned #78396, #73480, #74504, #74509, and #76611.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned #74529
  and broader Matrix E2EE hits.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix E2EE verification backup recovery key"`
  returned a GitHub mirror entry for PR #71311 destructive E2EE backup recovery
  coverage.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned Matrix release and beta validation discussion.
