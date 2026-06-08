---
title: "Security, auth, pairing, and secrets - Plugin Trust Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Plugin Trust Maturity Note

## Summary

OpenClaw has a meaningful plugin trust model: manifests are inspected before runtime load, config schemas and metadata are declarative, install security scans exist, plugin permissions use Gateway approval flows, and the security audit warns about plugin code and install state. Coverage is Beta because manifest/permission/install-scan tests are broad, but real third-party installation, update, rollback, permission, and compatibility scenarios remain less proven than bundled plugin behavior. Quality is Beta because the design is strong, but plugin allowlists, install integrity, auto-load concerns, and manifest conversation access are still active maturity areas.

## Category Scope

Included in this category:

- Plugin Installation Trust: Covers Plugin Installation Trust across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.
- Security Boundaries: Covers Security Boundaries across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.

## Features

- Plugin Installation Trust: Covers Plugin Installation Trust across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.
- Security Boundaries: Covers Security Boundaries across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Plugin manifest, contract eligibility, install-security scan, plugin approvals, runtime boundaries, and plugin state permissions all have focused tests; docs cover manifests and permission requests clearly.
- Negative signals: Coverage is stronger for static metadata and bundled/runtime contracts than for real external plugin install/update/rollback and malicious package-source scenarios.
- Integration gaps: Add recurring release scenarios for installing a third-party plugin, refusing unsafe package sources, enabling explicit plugin allowlists, requesting plugin approvals, exposing plugin tools, updating/rolling back, and proving secrets metadata remains redacted.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: The exact issue query returned no local issue rows. The PR query returned open #72690 for manifest conversation access and #81402 for runtime state storage, both adjacent to plugin trust and runtime-state maturity.
- Discrawl reports: The exact plugin query returned no visible rows, while broader security Discord evidence called out plugin auto-load disablement as a meaningful safety change and security-audit reports include plugin install and code-safety checks.
- Good qualities: Manifests are read before plugin code executes, invalid manifests block config validation, plugin permission prompts are separated from exec approvals, and install scans can block unsafe sources.
- Bad qualities: External plugin trust is still a fast-moving boundary, plugin allowlists are not always explicit, and install metadata/integrity/code-safety checks require operators to understand warnings.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Plugin Installation Trust, Security Boundaries.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Third-party plugin lifecycle proof is thinner than bundled plugin proof.
- Plugin allowlist and install-integrity checks need clearer operator scenario evidence.
- Manifest-level access semantics are still being expanded.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md` documents declarative manifests, config schemas, auth/setup metadata, and static contract metadata that can be inspected before runtime load.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-permission-requests.md` documents plugin approval prompts, decision behavior, routing, and separation from exec approvals.
- `/Users/kevinlin/code/openclaw/docs/plugins/manage-plugins.md`, `/Users/kevinlin/code/openclaw/docs/plugins/compatibility.md`, and `/Users/kevinlin/code/openclaw/docs/plugins/install-overrides.md` cover plugin lifecycle and compatibility.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md` documents plugin allowlist, install integrity, version drift, code safety, and plugin tool reachability audit checks.

### Source

- `/Users/kevinlin/code/openclaw/src/plugins/manifest.ts`, `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.ts`, and `/Users/kevinlin/code/openclaw/src/plugins/manifest-contract-eligibility.ts` implement manifest and static contract behavior.
- `/Users/kevinlin/code/openclaw/src/plugins/install-security-scan.ts` dispatches source, package, dependency-tree, file, and skill install scans.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/plugin-approval.ts` and `/Users/kevinlin/code/openclaw/src/infra/plugin-approvals.ts` implement Gateway plugin approval flows.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-plugin-boundary.ts` and `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-registry-loader.ts` implement runtime plugin boundary and loading behavior.
- `/Users/kevinlin/code/openclaw/src/plugin-state/plugin-state-store.permissions.test.ts` anchors plugin state permission behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/plugins/install-security-scan.runtime.ts` is covered by runtime scan tests and release tests for install safety behavior.
- `/Users/kevinlin/code/openclaw/src/plugins/npm-install-security-scan.release.test.ts` covers npm install security scan behavior.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime-plugin-boundary.whatsapp.test.ts` covers a runtime plugin boundary through a channel plugin.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-config-collectors-plugins.bundled.test.ts` and `/Users/kevinlin/code/openclaw/src/secrets/runtime.loadable-plugin-origins.test.ts` cover plugin secret metadata/runtime origin behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/manifest-contract-runtime.test.ts`, `/Users/kevinlin/code/openclaw/src/plugins/manifest-contract-eligibility.test.ts`, `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts`, and `/Users/kevinlin/code/openclaw/src/plugins/manifest-owner-policy.test.ts` cover manifest contracts.
- `/Users/kevinlin/code/openclaw/src/plugins/bundle-manifest.test.ts`, `/Users/kevinlin/code/openclaw/src/plugins/manifest-metadata-scan.test.ts`, and `/Users/kevinlin/code/openclaw/src/plugins/manifest.json5-tolerance.test.ts` cover manifest parsing and metadata.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/plugin-approval.test.ts`, `/Users/kevinlin/code/openclaw/src/infra/plugin-approval-forwarder.test.ts`, and `/Users/kevinlin/code/openclaw/src/plugin-sdk/approval-*.test.ts` cover plugin approval behavior.
- `/Users/kevinlin/code/openclaw/src/plugin-state/plugin-state-store.permissions.test.ts` covers plugin state permissions.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "plugin manifest permissions security install scan"`

Results:

- Returned `[]` in the current local issue archive.

Query: `gitcrawl --json search prs -R openclaw/openclaw "plugin approval manifest permissions security"`

Results:

- Returned open PR #72690, `Feature/issue: 71428 manifest conversation access`, and open PR #81402, `refactor: move runtime state to SQLite`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "plugin manifest permissions security install scan"`

Results:

- Returned no visible rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "plugin auto-load disabled manifest permissions"`

Results:

- Returned no visible rows for that exact query. Adjacent security discussion in the browser/control search summarized plugin auto-load disablement as a safety-relevant change.
