---
title: "watchOS companion surfaces - Source History and Release Evidence Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Source History and Release Evidence Maturity Note

## Summary

The changelog shows multiple watchOS-focused improvements across the iOS/Watch timeline: Watch companion MVP, quick actions, bridged notification actions, quick-action normalization, reply reliability, icons, App Store Connect prep, and exec approval recovery. Coverage is Experimental because these are historical change records and not current release-smoke artifacts. Quality is Alpha because the history shows real iteration on important failure modes, but the current public docs still do not present watchOS as a user feature.

## Category Scope

- Changelog and repo-history evidence for watchOS companion maturity.
- Release metadata and app-store/TestFlight preparation evidence.
- Historical bug/regression themes relevant to scoring current source quality.
- Out of scope: treating old changelog entries as proof of current live support.

## Features

- Changelog: Changelog and repo-history evidence for watchOS companion maturity
- Release metadata: Release metadata and app-store/TestFlight preparation evidence
- Historical bug/regression themes relevant to scoring: Historical bug/regression themes relevant to scoring current source quality

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (48%)`
- Positive signals: The root changelog includes several watch-specific entries, and the iOS changelog records recent build hygiene for the Watch app. This gives a source-history trail for what changed and why.
- Negative signals: Changelog entries do not prove the current build, release, APNs relay, real watch install, or user scenario passes today.
- Integration gaps: Convert the historical changes into a current watch release checklist with proof links for build, install, pairing, notify, quick reply, approval, and background recovery.

## Quality Score

- Score: `Alpha (56%)`
- Gitcrawl reports: PR-number searches for older watch changelog entries returned no hits from the current gitcrawl store, so current quality cannot be raised from issue/PR detail. `gitcrawl search openclaw/openclaw --query "watch app" --json` found iOS signing friction and future mobile/watch ideas rather than current watchOS release evidence.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS / WatchOS"` showed recent active work, release-date questions, and "better ipad and watch support" follow-up. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` showed source-build/TestFlight access friction and an open support boundary.
- Good qualities: The history shows the watch path has received follow-up hardening rather than a one-off prototype. It includes reliability, actor-safety, payload normalization, icon/release prep, and recovery work.
- Bad qualities: The evidence is fragmented across changelog, source, and Discord rather than a maintained watchOS release scorecard. Public documentation still treats the parent iOS app as internal preview.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (48%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Changelog, Release metadata, Historical bug/regression themes relevant to scoring.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a current watchOS release checklist that ties changelog claims to present-day proof.
- Keep a watch-specific known-issues section for push privacy, background recovery, and pairing/distribution state.
- Do not promote public maturity until watch support has an announced distribution path and repeatable user scenarios.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/apps/ios/CHANGELOG.md` includes a recent entry for build hygiene across the iOS app, Share extension, Activity widget, Watch app, and shared Swift sources.
- `/Users/kevinlin/code/openclaw/CHANGELOG.md` includes watch-specific entries for companion MVP (#20054), actionable watch approval/reject and quick replies (#21996), bridged watch prompt notification actions (#22123), quick-action payload normalization (#23636), reply reliability (#33306), App Store Connect/watch icon prep (#38936), and locked/backgrounded watch approval recovery (#61757).
- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` remains internal-preview and does not promote watchOS as public support.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/` contains the current watch extension implementation.
- `/Users/kevinlin/code/openclaw/apps/ios/project.yml` includes current Watch app and WatchKit extension targets.
- `/Users/kevinlin/code/openclaw/apps/ios/fastlane/` and `/Users/kevinlin/code/openclaw/apps/ios/VERSIONING.md` contain iOS release automation that carries the embedded watch app.

### Integration tests

- No current release checklist or live scenario proof was found for the historical watch changelog items.

### Unit tests

- Current iOS tests cover watch command handling and approval recovery pieces, but no watch target tests directly map to the historical changelog entries.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "20054" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "33306" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "61757" --json`

Results:

- No hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS / WatchOS"`

Results:

- Recent channel discussion includes release-date questions, landing status, and follow-up work for better iPad/watch support.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- Public access discussion still points to source-build/internal-preview status rather than a public TestFlight path.
