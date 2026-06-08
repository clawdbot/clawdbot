---
title: "ClawHub - Publishing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Publishing Maturity Note

## Summary

Publishing validation has serious guardrails: ClawHub owner scope, package
scope, version gates, existing package ownership checks, npm provenance, release
version format, publishable metadata, and external plugin compatibility fields.
Coverage is Beta because script and unit evidence is strong but live publish
proof is sparse in this repo. Quality is Beta because the validation model is
defensible, but archive evidence flags release/publish flows as a known gap in
supply-chain hardening and earlier CI wiring.

## Category Scope

Included in this category:

- ClawHub package publishing owner: ClawHub package publishing owner and scope rules
- OpenClaw-owned package release validation for ClawHub: OpenClaw-owned package release validation for ClawHub and npm
- Version bump gates: Version bump gates for changed publishable plugins
- npm trusted publishing provenance: npm trusted publishing provenance metadata
- External code plugin package contract required: External code plugin package contract required before publish

## Features

- ClawHub package publishing owner: ClawHub package publishing owner and scope rules
- OpenClaw-owned package release validation for ClawHub: OpenClaw-owned package release validation for ClawHub and npm
- Version bump gates: Version bump gates for changed publishable plugins
- npm trusted publishing provenance: npm trusted publishing provenance metadata
- External code plugin package contract required: External code plugin package contract required before publish
- Skill package metadata: Publish-ready skill metadata, file limits, versions, and tags.
- Skill publishing flow: Owner-scoped ClawHub skill publishing, validation, release, and review.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: docs define owner/scope/review behavior, release scripts
  validate package metadata and changed versions, and tests cover important
  release-plan and publish-preflight cases.
- Negative signals: GitHub archive evidence explicitly notes missing live npm,
  dist-tag, ClawHub publish, release publish, and production Gateway proof in a
  supply-chain hardening context.
- Integration gaps: the OpenClaw repo does not prove the end-to-end publish,
  ClawHub review, scan, install, update, and rollback loop as one gate.

## Quality Score

- Score: `Beta (76%)`
- Good qualities: validation blocks package metadata mistakes before publish,
  requires owner alignment, requires compatibility metadata, and requires npm
  provenance-friendly repository metadata.
- Bad qualities: publishing is split across ClawHub server behavior, CLI/docs,
  GitHub workflow scripts, npm registry behavior, and release branch state.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for ClawHub package publishing owner, OpenClaw-owned package release validation for ClawHub, Version bump gates, npm trusted publishing provenance, External code plugin package contract required, Skill package metadata, Skill publishing flow.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live release proof from package change through ClawHub hidden release,
  review/verification, install, update, and npm fallback.
- Keep ClawHub checkout/ref mutability and token/credential ownership in the
  release checklist until the flow is fully deterministic.

## Evidence

### Docs

- `docs/clawhub/publishing.md:11`: ClawHub publishing is owner-scoped.
- `docs/clawhub/publishing.md:40`: plugin package scope must match selected owner.
- `docs/clawhub/publishing.md:56`: release flow validates metadata and hides releases until review and verification finish.
- `docs/plugins/community.md:40`: ClawHub owns live listing, release history, scan status, and install hints.
- `docs/plugins/community.md:50`: community plugin publish checklist requires metadata, manifest, setup docs, and owner.

### Source

- `scripts/lib/plugin-clawhub-release.ts:101`: collects packages with `publishToClawHub`.
- `scripts/lib/plugin-clawhub-release.ts:282`: requires version bumps when changed publishable plugins keep the same version.
- `scripts/lib/plugin-clawhub-release.ts:353`: verifies OpenClaw-scoped candidates belong to the OpenClaw publisher.
- `scripts/lib/plugin-clawhub-release.ts:406`: builds the ClawHub release plan.
- `scripts/lib/plugin-npm-release.ts:225`: validates npm publishable plugin metadata, provenance URL, package scope, install spec, and compatibility contract.

### Integration tests

- No live publish, ClawHub review, scan, install, and update integration gate was found.

### Unit tests

- `test/plugin-clawhub-release.test.ts:58`: requires the ClawHub external plugin contract.
- `test/plugin-clawhub-release.test.ts:164`: requires a version bump when a publishable plugin changes.
- `test/plugin-clawhub-release.test.ts:373`: requires OpenClaw-scoped release candidates to belong to the OpenClaw publisher.
- `test/plugin-clawhub-release.test.ts:417`: previews the publish command through the ClawHub CLI dry-run preflight.
- `test/plugin-npm-release.test.ts:158`: requires the npm provenance GitHub repository URL.
- `test/plugin-npm-release.test.ts:183`: requires npm install metadata for publishable plugins.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "clawhub release plugin publish" --limit 5 --json`

Results:

- Returned #81957, a supply-chain hardening thread that removed ClawHub token fallback and stated no live npm publish, npm dist-tag mutation, ClawHub publish, release publish, or production Gateway run was performed.
- Returned #71116, a credential-governance issue mentioning plugin ClawHub and npm release workflows.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "ClawHub publish npm plugin release"`

Results:

- Returned a 2026-04-01 PR note about adding a ClawHub plugin release workflow, with a caveat about mutable ClawHub checkout refs, and a 2026-03-23 maintainer note that the full ClawHub publish/update e2e flow worked during CI churn.
