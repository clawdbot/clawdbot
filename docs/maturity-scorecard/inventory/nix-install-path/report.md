---
title: "Nix install path Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (38%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (38%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `nix-install-path` maturity evidence from `/Users/kevinlin/tmp/maturity/nix-install-path` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                    | LTS | Coverage             | Quality              | Completeness         | Features to evaluate                                                                                                                                                                    |
| --------------------------------------------------------------------------- | --- | -------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Install Handoff](public-nix-docs-handoff.md)                               | ❌  | `Experimental (25%)` | `Experimental (45%)` | `Experimental (25%)` | Nix install overview, nix-openclaw source-of-truth, Install discoverability, Verification handoff                                                                                       |
| [Plugin Lifecycle](plugin-lifecycle-nix-store-loading.md)                   | ❌  | `Experimental (40%)` | `Experimental (35%)` | `Experimental (40%)` | Lifecycle command refusal, Declarative plugin selection, Nix-store plugin loading, Hardlink safety                                                                                      |
| [Activation and App UX](nix-mode-activation-runtime-detection.md)           | ❌  | `Experimental (42%)` | `Alpha (50%)`        | `Experimental (42%)` | Environment activation, macOS defaults activation, Runtime Nix-mode detection, Stable Nix defaults, Managed-by-Nix banner, Read-only config controls, Onboarding skip                   |
| [Config and State](state-config-path-immutable-store.md)                    | ❌  | `Experimental (45%)` | `Alpha (50%)`        | `Experimental (45%)` | Immutable config guard, Config writer refusal, Agent-first Nix edits, Explicit config path, Writable state directory, Immutable-store config support, State integrity checks            |
| [Service Runtime and Guards](gateway-service-path-nix-profile-discovery.md) | ❌  | `Experimental (38%)` | `Experimental (45%)` | `Experimental (38%)` | Nix profile PATH discovery, Profile precedence, Service PATH fallback, Trusted binary boundaries, Setup write refusal, Doctor repair refusal, Update handoff, Service lifecycle handoff |

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

### 1. Install Handoff

Search anchors: Nix install overview, nix-openclaw source-of-truth, Install discoverability, Verification handoff.

Category note: [Install Handoff](public-nix-docs-handoff.md)

Score decisions:

- Coverage: `Experimental (25%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (25%)`
- LTS: ❌

Features:

- Nix install overview: Covers Nix install overview across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- nix-openclaw source-of-truth: Covers nix-openclaw source-of-truth across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Install discoverability: Covers Install discoverability across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.
- Verification handoff: Covers Verification handoff across public Nix install page, install index discoverability, docs navigation, and the handoff to the first-party `nix-openclaw` Home Manager module. It excludes the actual external `openclaw/nix-openclaw` repository implementation, and related public nix docs and nix-openclaw handoff behavior.

Primary docs:

- `docs/install/nix.md`
- `docs/install/index.md`
- `docs/start/docs-directory.md`

### 2. Plugin Lifecycle

Search anchors: Lifecycle command refusal, Declarative plugin selection, Nix-store plugin loading, Hardlink safety.

Category note: [Plugin Lifecycle](plugin-lifecycle-nix-store-loading.md)

Score decisions:

- Coverage: `Experimental (40%)`
- Quality: `Experimental (35%)`
- Completeness: `Experimental (40%)`
- LTS: ❌

Features:

- Lifecycle command refusal: Covers Lifecycle command refusal across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Declarative plugin selection: Covers Declarative plugin selection across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Nix-store plugin loading: Covers Nix-store plugin loading across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.
- Hardlink safety: Covers Hardlink safety across plugin install/update/uninstall/enable/disable behavior in Nix mode, `/nix/store` hardlink handling, manifest registry safety, and user-facing guidance for declarative plugin selection.

Primary docs:

- `docs/plugins/manage-plugins.md`
- `docs/tools/plugin.md`
- `docs/install/nix.md`

### 3. Activation and App UX

Search anchors: Environment activation, macOS defaults activation, Runtime Nix-mode detection, Stable Nix defaults, Managed-by-Nix banner, Read-only config controls, Onboarding skip.

Category note: [Activation and App UX](nix-mode-activation-runtime-detection.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Alpha (50%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Environment activation: Covers Environment activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- macOS defaults activation: Covers macOS defaults activation across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Runtime Nix-mode detection: Covers Runtime Nix-mode detection across Nix mode activation, environment-variable detection, macOS default detection, and the operator docs that explain how Nix mode is enabled.
- Stable Nix defaults: Covers Stable Nix defaults across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Managed-by-Nix banner: Covers Managed-by-Nix banner across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Read-only config controls: Covers Read-only config controls across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.
- Onboarding skip: Covers Onboarding skip across macOS app's `openclaw.nixMode` default handling, config read-only UX, settings banner, onboarding behavior, and local config write prevention.

Primary docs:

- `docs/install/nix.md`

### 4. Config and State

Search anchors: Immutable config guard, Config writer refusal, Agent-first Nix edits, Explicit config path, Writable state directory, Immutable-store config support, State integrity checks.

Category note: [Config and State](state-config-path-immutable-store.md)

Score decisions:

- Coverage: `Experimental (45%)`
- Quality: `Alpha (50%)`
- Completeness: `Experimental (45%)`
- LTS: ❌

Features:

- Immutable config guard: Covers Immutable config guard across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Config writer refusal: Covers Config writer refusal across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Agent-first Nix edits: Covers Agent-first Nix edits across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Explicit config path: Covers Explicit config path across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Writable state directory: Covers Writable state directory across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Immutable-store config support: Covers Immutable-store config support across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- State integrity checks: Covers State integrity checks across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.

Primary docs:

- `docs/install/nix.md`
- `docs/cli/setup.md`
- `docs/help/environment.md`

### 5. Service Runtime and Guards

Search anchors: Nix profile PATH discovery, Profile precedence, Service PATH fallback, Trusted binary boundaries, Setup write refusal, Doctor repair refusal, Update handoff, Service lifecycle handoff.

Category note: [Service Runtime and Guards](gateway-service-path-nix-profile-discovery.md)

Score decisions:

- Coverage: `Experimental (38%)`
- Quality: `Experimental (45%)`
- Completeness: `Experimental (38%)`
- LTS: ❌

Features:

- Nix profile PATH discovery: Covers Nix profile PATH discovery across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Profile precedence: Covers Profile precedence across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Service PATH fallback: Covers Service PATH fallback across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Trusted binary boundaries: Covers Trusted binary boundaries across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Setup write refusal: Covers Setup write refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Doctor repair refusal: Covers Doctor repair refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Update handoff: Covers Update handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Service lifecycle handoff: Covers Service lifecycle handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.

Primary docs:

- `docs/install/nix.md`
- `docs/cli/setup.md`
- `docs/cli/doctor.md`
- `docs/cli/update.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/nix-install-path/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/nix-install-path`.
