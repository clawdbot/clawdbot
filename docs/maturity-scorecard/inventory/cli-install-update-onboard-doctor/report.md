---
title: CLI Maturity Report
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (83%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (80%)`
- LTS Features: `6/7`

## Summary

This report expands the scorecard surface named "CLI" into the concrete
operator-facing capabilities that make OpenClaw setup, repair, and lifecycle
management work in practice.

The CLI surface has broad documentation and a large implementation/test
footprint. Coverage is generally strong across install, onboarding, doctor, and
update flows. The main quality drag comes from the service-management and update
paths, where restart behavior, platform-specific supervisors, and service
fallbacks still produce recurring operator pain.

## Matrix

| Category                                                                  | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CLI Setup](package-install-and-cli-entrypoints.md)                       | ✅  | `Beta (78%)`   | `Beta (75%)`  | `Stable (84%)` | Installer scripts, Local prefix install, Package-manager installs, Supported Node runtime, Source checkout install, CLI entrypoint                                                                                                         |
| [Onboarding and Auth Setup](first-run-onboarding-and-auth-selection.md)   | ✅  | `Stable (86%)` | `Beta (78%)`  | `Stable (80%)` | Guided onboarding, Targeted reconfiguration, Auth choices, Gateway auth storage, Remote onboarding                                                                                                                                         |
| [Plugin and Channel Setup](plugin-and-channel-setup-during-onboarding.md) | ❌  | `Stable (82%)` | `Beta (72%)`  | `Beta (76%)`   | Channel picker, Plugin install sources, Channel account setup, Post-setup probes, Remote gateway caveat                                                                                                                                    |
| [Gateway Service Management](gateway-service-install-and-lifecycle.md)    | ✅  | `Stable (88%)` | `Alpha (66%)` | `Stable (84%)` | Foreground gateway runs, Service install and control, Service auth wiring, Drift and reinstall recovery, Service health checks                                                                                                             |
| [CLI Observability](status-health-logs-and-diagnostics-support-path.md)   | ✅  | `Stable (84%)` | `Beta (74%)`  | `Stable (84%)` | Status snapshots, Health snapshots, Remote log tailing, Diagnostics export, Support-safe redaction                                                                                                                                         |
| [Doctor](doctor-config-auth-plugin-and-lint.md)                           | ✅  | `Stable (80%)` | `Alpha (68%)` | `Beta (77%)`   | Interactive repair, Config migration, Auth and SecretRef checks, Plugin validation and repair, Lint and JSON findings, Extra gateway discovery, Supervisor drift repair, Port and startup diagnosis, Runtime path checks, Restart guidance |
| [Updates and Upgrades](update-channel-and-core-upgrade-flow.md)           | ✅  | `Stable (82%)` | `Alpha (68%)` | `Beta (78%)`   | Update channels, Install-kind switching, Managed gateway restart, Update status and RPC, Plugin convergence                                                                                                                                |

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

### 1. CLI Setup

Search anchors: cli install, update, onboard, doctor cli installation and launch, cli installation and launch, cli install, update, onboard, doctor runtime prerequisites, runtime prerequisites.

Category note: [CLI Setup](package-install-and-cli-entrypoints.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (75%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Installer scripts: Hosted installer scripts set up Node, install OpenClaw, and optionally start onboarding.
- Local prefix install: The local-prefix installer keeps Node and OpenClaw under a dedicated OpenClaw directory instead of relying on a system-wide runtime.
- Package-manager installs: npm, pnpm, and bun global installs are supported when the operator manages Node directly, including PATH wiring expectations.
- Supported Node runtime: OpenClaw documents the supported Node versions and recommended runtime before normal CLI workflows continue.
- Source checkout install: Operators can run OpenClaw from a source checkout for development or recovery workflows, and update flows distinguish this path from package installs.
- CLI entrypoint: The packaged openclaw launcher, openclaw --help, openclaw --version, runtime preflight, and basic recovery expectations are documented.

Primary docs:

- `docs/install/index.md`
- `docs/install/installer.md`
- `docs/install/node.md`
- `docs/install/updating.md`

Major quality/completeness gaps:

- Hosted installer scripts still lack repo-local e2e proof.

### 2. Onboarding and Auth Setup

Search anchors: cli install, update, onboard, doctor onboarding and auth setup, onboarding and auth setup.

Category note: [Onboarding and Auth Setup](first-run-onboarding-and-auth-selection.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Guided onboarding: openclaw onboard walks through workspace, gateway, model auth, channels, skills, and health setup.
- Targeted reconfiguration: openclaw configure lets operators revisit only the sections they want to change after the initial setup.
- Auth choices: Onboarding and configure support API-key, OAuth, and other provider-specific auth choices.
- Gateway auth storage: Gateway token and password setup are documented, including SecretRef-managed storage behavior.
- Remote onboarding: Remote-gateway onboarding documents what is configured locally versus what must already exist on the remote host.

Primary docs:

- `docs/cli/onboard.md`
- `docs/cli/configure.md`
- `docs/start/onboarding-overview.md`

### 3. Plugin and Channel Setup

Search anchors: cli install, update, onboard, doctor plugin and channel setup, plugin and channel setup.

Category note: [Plugin and Channel Setup](plugin-and-channel-setup-during-onboarding.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Channel picker: Onboarding can guide the operator through choosing which channels to configure.
- Plugin install sources: Plugin setup supports bundled, npm, ClawHub, marketplace, git, and local install sources.
- Channel account setup: Channel commands support interactive and flag-driven account configuration for supported chat transports.
- Post-setup probes: Operators can probe channel status and capabilities after setup to verify that the configured account works.
- Remote gateway caveat: Remote onboarding documents that plugin installation does not happen locally when the gateway runs elsewhere.

Primary docs:

- `docs/cli/onboard.md`
- `docs/cli/plugins.md`
- `docs/cli/channels.md`

### 4. Gateway Service Management

Search anchors: cli install, update, onboard, doctor gateway service management, gateway service management.

Category note: [Gateway Service Management](gateway-service-install-and-lifecycle.md)

Score decisions:

- Coverage: `Stable (88%)`
- Quality: `Alpha (66%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Foreground gateway runs: Operators can run the gateway directly from the CLI for local development or ad hoc recovery.
- Service install and control: The CLI documents install, status, start, stop, restart, and run flows for managed gateway services.
- Service auth wiring: Gateway service installation documents how auth tokens and other sensitive values are handled.
- Drift and reinstall recovery: Operators are given explicit guidance for repairing or reinstalling a broken managed gateway service.
- Service health checks: Gateway service flows point operators at runtime health and troubleshooting checks after install or restart.

Primary docs:

- `docs/cli/gateway.md`
- `docs/install/updating.md`
- `docs/gateway/troubleshooting.md`

### 5. CLI Observability

Search anchors: cli install, update, onboard, doctor status health logs and diagnostics, status health logs and diagnostics.

Category note: [CLI Observability](status-health-logs-and-diagnostics-support-path.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Status snapshots: openclaw status and related flags summarize runtime state, config health, and update context.
- Health snapshots: openclaw health gives a fast gateway health read and supports verbose or JSON output.
- Remote log tailing: openclaw logs tails gateway logs over RPC, including follow mode and JSON output.
- Diagnostics export: Gateway diagnostics bundles can be exported locally for bug reports and support workflows.
- Support-safe redaction: Diagnostics and status paths document privacy and redaction expectations before sharing results.

Primary docs:

- `docs/cli/status.md`
- `docs/cli/health.md`
- `docs/cli/logs.md`
- `docs/gateway/diagnostics.md`

### 6. Doctor

Search anchors: cli install, update, onboard, doctor doctor config and policy repair, doctor config and policy repair, cli install, update, onboard, doctor doctor platform and service repair, doctor platform and service repair.

Category note: [Doctor](doctor-config-auth-plugin-and-lint.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (77%)`
- LTS: ✅

Features:

- Interactive repair: openclaw doctor supports inspect, repair, non-interactive, and forceful repair postures.
- Config migration: Doctor rewrites legacy or damaged config and state into supported current formats.
- Auth and SecretRef checks: Doctor audits auth shape, token generation, and supported SecretRef-backed config paths.
- Plugin validation and repair: Doctor surfaces plugin-config issues and extension schema drift that block normal runtime operation.
- Lint and JSON findings: openclaw doctor --lint --json provides stable machine-readable findings for automation.
- Extra gateway discovery: Doctor can scan for unexpected gateway services and conflicting installs.
- Supervisor drift repair: Doctor checks managed service definitions and can repair launchd, systemd, or Scheduled Task drift.
- Port and startup diagnosis: Doctor points operators at port conflicts, restart failures, and recent gateway errors.
- Runtime path checks: Doctor checks runtime-path best practices and common path misconfigurations.
- Restart guidance: Doctor explains when a health issue needs a restart or a deeper service repair path.

Primary docs:

- `docs/cli/doctor.md`
- `docs/gateway/doctor.md`
- `docs/gateway/secrets.md`
- `docs/gateway/troubleshooting.md`

### 7. Updates and Upgrades

Search anchors: cli install, update, onboard, doctor updates and upgrades, updates and upgrades.

Category note: [Updates and Upgrades](update-channel-and-core-upgrade-flow.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Update channels: openclaw update supports stable, beta, and dev channel selection.
- Install-kind switching: Update flows can switch between package installs and git/source installs when supported.
- Managed gateway restart: Update flows document when the managed gateway is stopped, restarted, or intentionally left alone.
- Update status and RPC: Operators can inspect update status and related gateway control-plane state.
- Plugin convergence: Core updates document how plugin versions and plugin repair warnings are handled afterward.

Primary docs:

- `docs/install/updating.md`
- `docs/cli/update.md`
- `docs/gateway/troubleshooting.md`

## Recommended scorecard interpretation

Use the CLI row as a weighted operator-readiness signal rather than assuming
every sub-path is equally solid. Local install, onboarding, and read-oriented
diagnostics are in better shape than cross-platform service repair and
update-managed restart paths.

## Out of scope for this surface

- Gateway runtime protocol semantics beyond the operator-facing CLI hooks.
- Plugin SDK authoring and plugin architecture details outside CLI setup and
  repair flows.
- Channel runtime behavior after setup has succeeded.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/cli-install-update-onboard-doctor/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
