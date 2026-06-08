---
title: "ClawHub - Marketplace and Compatible Bundle Import Support Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Marketplace and Compatible Bundle Import Support Maturity Note

## Summary

Compatible bundle and marketplace import support is relatively strong for the
documented subset. OpenClaw can detect Codex, Claude, and Cursor bundle formats,
list marketplace entries, install marketplace plugins, map skills/commands/hooks
and MCP/LSP/settings defaults, and reject unsafe remote marketplace paths.
Coverage is Stable due to a package-installed marketplace e2e and broad source
tests. Quality is Beta because several bundle capabilities are intentionally
detected but not executed and archive evidence shows active schema/metadata
hardening.

## Category Scope

- Codex, Claude, and Cursor-compatible bundle detection.
- Local, archive, and marketplace install paths.
- Marketplace list, shortcut, and install flows.
- Supported mapped features and detected-but-not-executed capabilities.
- Remote marketplace path safety and archive download guards.

## Features

- Codex: Codex, Claude, and Cursor-compatible bundle detection
- Local: Local, archive, and marketplace install paths
- Marketplace list: Marketplace list, shortcut, and install flows
- Supported mapped features: Supported mapped features and detected-but-not-executed capabilities
- Remote marketplace path safety: Remote marketplace path safety and archive download guards

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: docs cover bundle support clearly, source validates
  marketplace manifests and installs entries, and package-installed e2e proves
  list, install, command execution, update, and uninstall.
- Negative signals: not every detected bundle capability executes, and remote
  marketplace behavior has active hardening evidence.
- Integration gaps: no live third-party marketplace compatibility matrix was
  found across Codex, Claude, and Cursor real-world bundles.

## Quality Score

- Score: `Beta (78%)`
- Good qualities: remote marketplace entries are constrained to relative paths,
  archive downloads are guarded, shortcut resolution is explicit, and unsupported
  bundle capabilities are reported instead of silently run.
- Bad qualities: the compatibility boundary is necessarily partial, and users
  may expect detected Claude/Cursor automation capabilities to execute when they
  currently do not.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Codex, Local, Marketplace list, Supported mapped features, Remote marketplace path safety.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a compatibility matrix for real Codex, Claude, and Cursor bundles with
  expected mapped features and intentionally unsupported features.
- Add documentation/examples for remote marketplace trust and update behavior.

## Evidence

### Docs

- `docs/plugins/bundles.md:10`: OpenClaw can install Codex, Claude, and Cursor bundles.
- `docs/plugins/bundles.md:28`: bundles install from directory, archive, or marketplace.
- `docs/plugins/bundles.md:66`: supported mapped features include skills, commands, hooks, MCP tools, LSP servers, and settings.
- `docs/plugins/bundles.md:199`: Claude agents/hooks/output styles, Cursor agents/hooks/rules, and Codex inline/app metadata are detected but not executed.
- `docs/cli/plugins.md:446`: marketplace list accepts local paths, marketplace JSON, GitHub shorthand, repo URLs, and git URLs.

### Source

- `src/plugins/bundle-manifest.ts:20`: defines Codex, Claude, and Cursor manifest locations.
- `src/plugins/marketplace.ts:878`: rejects unsafe remote marketplace entries such as HTTP paths, absolute paths, and non-path sources.
- `src/plugins/marketplace.ts:1035`: lists marketplace plugins.
- `src/plugins/marketplace.ts:1059`: resolves `plugin@marketplace` shortcuts.
- `src/plugins/marketplace.ts:1105`: installs marketplace entries via the normal path installer.

### Integration tests

- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:76`: lists marketplace plugins as JSON.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:79`: installs a marketplace plugin.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:80`: verifies the plugin-owned CLI command after install.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:91`: dry-runs and performs marketplace update.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:96`: uninstalls the marketplace plugin and verifies command removal.

### Unit tests

- `src/plugins/marketplace.test.ts:269`: lists plugins from a local marketplace root.
- `src/plugins/marketplace.test.ts:435`: installs remote marketplace plugins from relative paths inside the cloned repo.
- `src/plugins/marketplace.test.ts:691`: downloads archive plugin sources through the SSRF guard.
- `src/plugins/marketplace.test.ts:1066`: reports missing remote marketplace paths as not found instead of escapes.
- `src/plugins/bundle-manifest.test.ts:157`: bundle manifest parsing coverage.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "release-plugin-marketplace marketplace plugin" --limit 5 --json`

Results:

- Returned #82216, about Codex bundled plugins not enabling from `openclaw.json`.
- Returned #75186, noting missing plugin marketplace browsing RPCs and plugin dependency repair RPCs in management APIs.
- Returned #87141, a hardening thread for schema/metadata fuzz boundaries and fail-closed behavior on unreadable Codex plugin list marketplace fields.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "marketplace plugin bundle Codex Claude install"`

Results:

- Returned a 2026-03-23 release summary saying the release shipped ClawHub plugin marketplace and Claude/Codex/Cursor bundle install discovery.
