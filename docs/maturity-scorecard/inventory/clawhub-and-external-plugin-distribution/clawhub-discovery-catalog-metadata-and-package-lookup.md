---
title: "ClawHub - Catalog Discovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Catalog Discovery Maturity Note

## Summary

ClawHub discovery is present in the user-facing CLI and docs, but the maturity
is Alpha/Beta-edge because OpenClaw mostly consumes the remote catalog rather
than owning or proving the full catalog service. The command searches installable
`code-plugin` and `bundle-plugin` families, prints install hints, and documents
ClawHub as the primary discovery surface. Missing evidence is live catalog QA,
catalog-service release proof, and coverage for display metadata regressions.

## Category Scope

Included in this category:

- openclaw plugins search as the ClawHub: openclaw plugins search as the ClawHub plugin lookup command
- Search result metadata: package name, family, channel, version, summary, and
- Distinction between plugin search: Distinction between plugin search and skill search
- Catalog lookup failure: Catalog lookup failure and empty-result behavior

## Features

- openclaw plugins search as the ClawHub: openclaw plugins search as the ClawHub plugin lookup command
- Search result metadata: package name, family, channel, version, summary, and
- Distinction between plugin search: Distinction between plugin search and skill search
- Catalog lookup failure: Catalog lookup failure and empty-result behavior
- Skill catalog search: Search, list, inspect, and install ClawHub-tracked skills from the CLI.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: docs describe ClawHub search and source-selection behavior;
  the CLI command filters to installable plugin package families and has unit
  tests for search formatting and error paths.
- Negative signals: no live ClawHub search integration proof or catalog-service
  end-to-end release gate was found in the OpenClaw repo audit.
- Integration gaps: display metadata, package readiness, scan state, and install
  hints are consumed from ClawHub but not proven by a release matrix here.

## Quality Score

- Score: `Beta (72%)`
- Good qualities: the CLI has a narrow, readable contract, clamps limits,
  deduplicates family results, separates plugin and skill search, and prints
  concrete install hints.
- Bad qualities: the user-visible catalog depends on remote ClawHub metadata
  quality, and archive evidence shows display metadata was still receiving beta
  feedback.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw plugins search as the ClawHub, Search result metadata, Distinction between plugin search, Catalog lookup failure, Skill catalog search.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add package-installed live proof for `openclaw plugins search` against the
  production or staging ClawHub package search route.
- Add a catalog metadata fixture that proves summary, display name, channel,
  latest version, scan/readiness status, and install hint rendering together.

## Evidence

### Docs

- `docs/tools/plugin.md:35`: quick start tells users to search ClawHub for public plugin packages.
- `docs/tools/plugin.md:42`: ClawHub is documented as the primary discovery surface.
- `docs/cli/plugins.md:129`: `plugins search` queries ClawHub and searches plugin packages, not skills.
- `docs/cli/plugins.md:306`: search is documented as a remote catalog lookup that does not mutate local state.
- `docs/plugins/community.md:10`: community plugins use ClawHub as the primary public discovery surface.

### Source

- `src/cli/plugins-cli.ts:75`: registers `openclaw plugins search`.
- `src/cli/plugins-search-command.ts:16`: limits plugin search to `code-plugin` and `bundle-plugin` families.
- `src/cli/plugins-search-command.ts:57`: formats family, channel, version, summary, and install hint.
- `src/cli/plugins-search-command.ts:82`: clamps search limits before querying.
- `src/infra/clawhub.ts:940`: calls `/api/v1/packages/search` with query, family, and limit parameters.

### Integration tests

- No package-installed live ClawHub search integration test was found for this
  component.

### Unit tests

- `src/cli/plugins-search-command.test.ts:41`: command-level search coverage.
- `src/infra/clawhub.test.ts:745`: malformed ClawHub search JSON is rejected for search APIs.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "ClawHub catalog metadata display package lookup install hints" --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "ClawHub plugin display metadata" --limit 10 --json`

Results:

- The first query returned no hits.
- The second query found #87486, a beta feedback thread mentioning ClawHub display names, and #86612, a runtime issue that included official external plugin install context.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "ClawHub plugin display metadata catalog"`

Results:

- Returned no hits, so Discord archive evidence did not add live catalog-display proof.
