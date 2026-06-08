---
title: "ClawHub Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (72%)`
- Quality: `Beta (73%)`
- Completeness: `Beta (72%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `clawhub-and-external-plugin-distribution` maturity evidence from `/Users/kevinlin/tmp/maturity/clawhub-and-external-plugin-distribution` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                        | LTS | Coverage      | Quality      | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --- | ------------- | ------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Publishing](clawhub-and-npm-publishing-release-validation.md)                  | ❌  | `Beta (72%)`  | `Beta (76%)` | `Beta (72%)`  | ClawHub package publishing owner, OpenClaw-owned package release validation for ClawHub, Version bump gates, npm trusted publishing provenance, External code plugin package contract required, Skill package metadata, Skill publishing flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [Catalog Discovery](clawhub-discovery-catalog-metadata-and-package-lookup.md)   | ❌  | `Alpha (66%)` | `Beta (72%)` | `Alpha (66%)` | openclaw plugins search as the ClawHub, Search result metadata, Distinction between plugin search, Catalog lookup failure, Skill catalog search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [Compatibility and Trust](compatibility-gates-and-official-external-catalog.md) | ❌  | `Beta (76%)`  | `Beta (74%)` | `Beta (76%)`  | openclaw.compat.pluginApi, ClawHub package compatibility validation, npm compatibility fallback to the newest, Official external plugin catalog behavior, Compatibility docs, Operator trust model for installing, ClawHub archive, npm integrity drift, Built-in dangerous-code scanner, ClawHub publishing review/hidden-release behavior as upstream, Skill archive safety, Skill audit signals                                                                                                                                                                                                                                                                                                                                                        |
| [Plugin Lifecycle and Health](plugin-lifecycle-and-health.md)                   | ❌  | `Beta (76%)`  | `Beta (71%)` | `Beta (76%)`  | Source prefixes, Bare package behavior during the launch, Explicit pinned versions, Managed install records that preserve source, Codex, Local, Marketplace list, Supported mapped features, Remote marketplace path safety, Update by plugin id, Reinstall vs update semantics, Downgrade, Uninstall config/index/policy/file cleanup, Gateway restart/reload requirements after, Per-plugin managed npm project, npm-pack local release-candidate installs, Dependency ownership between plugin packages, Peer dependency relinking, Legacy dependency root cleanup, plugins list, Local plugin index, Troubleshooting stale config, Runtime verification after Gateway, ClawHub skill installs, Skill upload install path, Skill dependency installers |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Publishing

Search anchors: clawhub publishing release validation, clawhub and npm publishing release validation, SKILL.md format, Runtime metadata, Release Flow, Skill content.

Category note: [Publishing](clawhub-and-npm-publishing-release-validation.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- ClawHub package publishing owner: ClawHub package publishing owner and scope rules
- OpenClaw-owned package release validation for ClawHub: OpenClaw-owned package release validation for ClawHub and npm
- Version bump gates: Version bump gates for changed publishable plugins
- npm trusted publishing provenance: npm trusted publishing provenance metadata
- External code plugin package contract required: External code plugin package contract required before publish
- Skill package metadata: Publish-ready skill metadata, file limits, versions, and tags.
- Skill publishing flow: Owner-scoped ClawHub skill publishing, validation, release, and review.

Primary docs:

- `docs/clawhub/publishing.md`
- `docs/clawhub/skill-format.md`
- `docs/tools/creating-skills.md`
- `docs/plugins/community.md`

### 2. Catalog Discovery

Search anchors: clawhub discovery, catalog metadata, and package lookup, openclaw skills, ClawHub install and sync.

Category note: [Catalog Discovery](clawhub-discovery-catalog-metadata-and-package-lookup.md)

Score decisions:

- Coverage: `Alpha (66%)`
- Quality: `Beta (72%)`
- Completeness: `Alpha (66%)`
- LTS: ❌

Features:

- openclaw plugins search as the ClawHub: openclaw plugins search as the ClawHub plugin lookup command
- Search result metadata: package name, family, channel, version, summary, and
- Distinction between plugin search: Distinction between plugin search and skill search
- Catalog lookup failure: Catalog lookup failure and empty-result behavior
- Skill catalog search: Search, list, inspect, and install ClawHub-tracked skills from the CLI.

Primary docs:

- `docs/tools/plugin.md`
- `docs/cli/plugins.md`
- `docs/cli/skills.md`
- `docs/tools/skills.md`
- `docs/plugins/community.md`

### 3. Compatibility and Trust

Search anchors: clawhub compatibility gates and official external catalog, compatibility gates and official external catalog, clawhub external plugin trust, integrity, and install approvals, external plugin trust, integrity, and install approvals, Treat third-party skills as untrusted code, skills.install.allowUploadedArchives, ClawHub security audits, Dynamic skills.

Category note: [Compatibility and Trust](compatibility-gates-and-official-external-catalog.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- openclaw.compat.pluginApi: openclaw.compat.pluginApi, build metadata, and host/gateway minimums
- ClawHub package compatibility validation: Evidence scope for ClawHub package compatibility validation.
- npm compatibility fallback to the newest: npm compatibility fallback to the newest compatible stable version
- Official external plugin catalog behavior: Official external plugin catalog behavior and bundled-to-external migration
- Compatibility docs: Compatibility docs and deprecation registry
- Operator trust model for installing: Operator trust model for installing and enabling external code
- ClawHub archive: ClawHub archive and ClawPack digest verification
- npm integrity drift: npm integrity drift and managed install checks
- Built-in dangerous-code scanner: Built-in dangerous-code scanner and break-glass override semantics
- ClawHub publishing review/hidden-release behavior as upstream: ClawHub publishing review/hidden-release behavior as upstream trust signal
- Skill archive safety: Uploaded skill archives are gated and reuse extraction protections.
- Skill audit signals: ClawHub audit status, risk, findings, and trust metadata apply to skill packages.

Primary docs:

- `docs/tools/plugin.md`
- `docs/cli/plugins.md`
- `docs/plugins/compatibility.md`
- `docs/plugins/plugin-inventory.md`
- `docs/clawhub/publishing.md`
- `docs/clawhub/security-audits.md`
- `docs/tools/skills.md`
- `docs/tools/skills-config.md`

### 4. Plugin Lifecycle and Health

Search anchors: clawhub plugin source selection and install spec resolution, plugin source selection and install spec resolution, clawhub marketplace and compatible bundle import support, marketplace and compatible bundle import support, clawhub update, rollback, uninstall, and gateway reload lifecycle, update, rollback, uninstall, and gateway reload lifecycle, clawhub dependency resolution, managed install roots, and package metadata, dependency resolution, managed install roots, and package metadata, clawhub operator inventory, inspect, doctor, and troubleshooting, operator inventory, inspect, doctor, and troubleshooting, skills.upload.begin, skills.install, skills.update, Skill content.

Category note: [Plugin Lifecycle and Health](plugin-lifecycle-and-health.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Source prefixes: Source prefixes and shorthand resolution for clawhub:, npm:,
- Bare package behavior during the launch: Bare package behavior during the launch cutover
- Explicit pinned versions: Explicit pinned versions, prerelease tags, and stable fallback behavior
- Managed install records that preserve source: Managed install records that preserve source metadata for update/uninstall
- Codex: Codex, Claude, and Cursor-compatible bundle detection
- Local: Local, archive, and marketplace install paths
- Marketplace list: Marketplace list, shortcut, and install flows
- Supported mapped features: Supported mapped features and detected-but-not-executed capabilities
- Remote marketplace path safety: Remote marketplace path safety and archive download guards
- Update by plugin id: Update by plugin id, npm spec, ClawHub spec, beta channel, and marketplace
- Reinstall vs update semantics: Evidence scope for Reinstall vs update semantics.
- Downgrade: Downgrade and pinned selectors
- Uninstall config/index/policy/file cleanup: Evidence scope for Uninstall config/index/policy/file cleanup.
- Gateway restart/reload requirements after: Gateway restart/reload requirements after install/update/uninstall
- Per-plugin managed npm project: Per-plugin managed npm project roots
- npm-pack local release-candidate installs: npm-pack local release-candidate installs through npm semantics
- Dependency ownership between plugin packages: Dependency ownership between plugin packages and OpenClaw
- Peer dependency relinking: Peer dependency relinking for openclaw/plugin-sdk/\*
- Legacy dependency root cleanup: Legacy dependency root cleanup and doctor repair
- plugins list: plugins list, plugins inspect, runtime inspect, plugins doctor, and
- Local plugin index: Local plugin index and persisted cold registry state
- Troubleshooting stale config: Troubleshooting stale config, blocked paths, dependencies, missing plugins,
- Runtime verification after Gateway: Runtime verification after Gateway restart
- ClawHub skill installs: Install and update ClawHub-tracked workspace or global skills.
- Skill upload install path: Trusted private archive upload and install through skills upload APIs.
- Skill dependency installers: Declared Brew, Node, Go, uv, or download installers for skill packages.

Primary docs:

- `docs/tools/plugin.md`
- `docs/cli/plugins.md`
- `docs/cli/skills.md`
- `docs/tools/skills.md`
- `docs/gateway/protocol.md`
- `docs/plugins/bundles.md`
- `docs/plugins/dependency-resolution.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/clawhub-and-external-plugin-distribution/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/clawhub-and-external-plugin-distribution`.
