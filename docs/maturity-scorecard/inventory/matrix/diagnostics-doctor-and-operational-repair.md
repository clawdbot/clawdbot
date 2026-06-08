---
title: "Matrix - Diagnostics, Doctor, and Operational Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Diagnostics, Doctor, and Operational Repair Maturity Note

## Summary

Matrix diagnostics and repair are practical and source-backed. The doctor path
detects stale plugin installs, legacy config aliases, legacy DM policy, legacy
state migration, legacy encrypted-state migration, and migration snapshots.
Runtime probes, directory lookup, startup migration integration, status
commands, and Matrix QA runtime diagnostics add more operational visibility.
Coverage and Quality are both Beta because the tool surface is broad and useful,
but archive evidence shows operators still reach repair flows from active
Matrix issues.

## Category Scope

- Matrix doctor warnings, config normalization, stale plugin config cleanup,
  doctor repair, legacy state migration, legacy encrypted-state migration, and
  backup snapshots.
- Matrix probe/status, live directory lookup, CLI diagnostics, QA runtime
  summaries, and startup migration integration wiring.
- Out of scope: setup wizard, normal message routing, outbound delivery, and
  E2EE internals except where repair/status surfaces them.

## Features

- Matrix doctor warnings: Matrix doctor warnings, config normalization, and stale plugin config cleanup.
- Matrix probe/status: Matrix probe/status, live directory lookup, CLI diagnostics, and QA runtime status.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs cover migration snapshots, migration warnings, recovery guidance,
    troubleshooting checks, target resolution, config references, and related
    docs.
  - Source implements doctor warnings/repair, stale plugin path cleanup, legacy
    config normalization, migration snapshots, probe, and live directory lookup.
  - Unit tests cover doctor previews, repair changes, stale plugin config,
    legacy config normalization, directory lookup, probe, startup maintenance,
    and channel directory behavior.
  - Integration evidence covers gateway startup Matrix migration wiring and QA
    runtime diagnostics.
- Negative signals:
  - Diagnostics are broad but reactive; they do not prove the underlying
    runtime paths are stable.
  - Discrawl and gitcrawl diagnostic-specific queries returned little direct
    signal, so archive evidence is mostly broad Matrix incidents.
- Integration gaps:
  - Add an operator repair scenario that runs doctor before and after a Matrix
    migration and captures exact warnings, changes, and status.
  - Add live diagnostics artifacts for Matrix readiness failures.
  - Add a QA lane for directory lookup and probe behavior against a real
    homeserver.

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

- Score: `Beta (74%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "Matrix doctor status migration repair"` returned open PR #87141, a broad plugin hardening PR whose snippet referenced doctor migration/doc changes.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned open Matrix runtime, routing, media, and E2EE issues that would likely rely on diagnostics and repair flows.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix doctor status migration repair"` returned no hits.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned release chatter and scorecard discussion.
- Good qualities:
  - Doctor repair creates or reuses a Matrix migration snapshot before applying
    Matrix upgrades.
  - Legacy config migration is explicit, path-aware, and preserves safer
    policies when possible.
  - Probe fails with concrete missing-auth and runtime errors.
  - Directory lookup uses hardened Matrix HTTP client paths and handles direct
    Matrix ids without unnecessary network calls.
- Bad qualities:
  - Diagnostics are spread across doctor, CLI, probe, directory, startup
    maintenance, QA runtime, and docs.
  - Some repairs require state mutation, so snapshot failure must block repair.
  - Active Matrix incidents show diagnostics must stay aligned with fast-moving
    runtime failure modes.
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
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Matrix doctor warnings, Matrix probe/status.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add one current repair transcript showing doctor warnings before repair,
  migration snapshot creation/reuse, post-repair config, and status result.
- Link active Matrix incident classes to specific diagnostics commands.
- Add live directory/probe evidence to complement source and unit tests.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix-migration.md:21`
  documents automatic migration snapshots.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix-migration.md:146`
  documents common messages and recovery guidance.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix-migration.md:340`
  documents troubleshooting checks and related docs.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:812` documents
  target resolution.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:831` documents config
  reference, access, reply behavior, reaction settings, tooling, and approvals.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.ts:50` formats
  Matrix legacy state previews.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.ts:62` formats
  legacy encrypted-state migration previews.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.ts:83`
  collects stale plugin install path warnings.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.ts:131`
  applies Matrix doctor repair and creates migration snapshots.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.ts:207` runs
  Matrix doctor config sequence.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor-contract.ts:121`
  declares legacy Matrix config rules.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor-contract.ts:166`
  normalizes compatibility config.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/probe.ts:25`
  probes Matrix auth and homeserver reachability.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/directory-live.ts:105`
  lists Matrix directory peers live.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/directory-live.ts:181`
  lists Matrix directory groups live.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.startup-matrix-migration.integration.test.ts:4`
  covers gateway startup channel maintenance wiring.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/runtime.test.ts:342`
  records default and per-scenario Matrix config snapshots in summaries.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/runtime.test.ts:449`
  preserves negative-scenario artifacts in the Matrix summary.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/runtime.test.ts:494`
  keeps failing Matrix scenario details and timings complete in summary and
  report output.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenario-runtime-cli.test.ts:24`
  redacts secret CLI arguments in diagnostic command text.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.test.ts:64`
  formats state and crypto previews.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.test.ts:98`
  warns on stale plugin paths and cleans them.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.test.ts:125`
  surfaces sequence warnings and repair changes.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.test.ts:166`
  normalizes legacy Matrix room allow aliases.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/doctor.test.ts:260`
  migrates legacy trusted DM policy with allowFrom to allowlist.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/directory-live.test.ts:72`
  passes dispatcher policy through to live directory client.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/directory-live.test.ts:156`
  resolves prefixed room aliases through the hardened Matrix HTTP client.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/probe.test.ts`
  covers Matrix probe behavior.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/startup-maintenance.test.ts`
  covers startup maintenance behavior.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "Matrix doctor status migration repair"`
  returned open PR #87141 with a snippet referencing doctor migration/doc
  changes.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned broad
  Matrix issues that diagnostics and repair flows must support.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix doctor status migration repair"`
  returned no hits.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned release chatter and scorecard discussion.
