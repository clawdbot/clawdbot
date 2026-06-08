---
title: "Browser automation and exec/sandbox tools Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (79%)`
- Quality: `Beta (75%)`
- Completeness: `Beta (79%)`
- LTS Features: `2/3`

## Summary

This report promotes the archived `browser-automation-and-exec-sandbox-tools` maturity evidence from `/Users/kevinlin/tmp/maturity/browser-automation-and-exec-sandbox-tools` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                               | LTS | Coverage       | Quality      | Completeness   | Features to evaluate                                                                                            |
| ---------------------------------------------------------------------- | --- | -------------- | ------------ | -------------- | --------------------------------------------------------------------------------------------------------------- |
| [Browser Automation](browser-actions-snapshots-and-artifacts.md)       | ❌  | `Beta (78%)`   | `Beta (74%)` | `Beta (78%)`   | Browser Actions, Snapshots, Artifacts, Browser Plugin Service, Profiles, Browser Security, SSRF, Remote Control |
| [Tool Invocation and Execution](exec-routing-and-process-lifecycle.md) | ✅  | `Stable (82%)` | `Beta (79%)` | `Stable (82%)` | Exec Routing, Process Lifecycle, Direct Tool Invoke API, Node System.run, Host Exec Approvals, Elevated Mode    |
| [Sandbox and Tool Policy](sandbox-backends-and-workspace-isolation.md) | ✅  | `Beta (76%)`   | `Beta (72%)` | `Beta (76%)`   | Sandbox Backends, Workspace Isolation, Sandboxed Browser, Codex Dynamic Tools, Tool Policy, Sandbox Tool Gates  |

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

### 1. Browser Automation

Search anchors: Browser Actions, Snapshots, Artifacts, browser automation and exec/sandbox tools browser actions, snapshots, and artifacts, browser actions, snapshots, and artifacts, Browser Plugin Service, Profiles, browser automation and exec/sandbox tools browser plugin service and profiles, browser plugin service and profiles, Browser Security, SSRF, Remote Control, browser automation and exec/sandbox tools browser security, ssrf, and remote control, browser security, ssrf, and remote control.

Category note: [Browser Automation](browser-actions-snapshots-and-artifacts.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Browser Actions: Covers Browser Actions across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Snapshots: Covers Snapshots across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Artifacts: Covers Artifacts across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Browser Plugin Service: Covers Browser Plugin Service across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Profiles: Covers Profiles across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Browser Security: Covers Browser Security across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- SSRF: Covers SSRF across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- Remote Control: Covers Remote Control across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.

Primary docs:

- `docs/tools/browser-control.md`
- `docs/help/testing.md`
- `docs/tools/browser.md`
- `docs/gateway/security/index.md`
- `docs/gateway/security/audit-checks.md`

### 2. Tool Invocation and Execution

Search anchors: Exec Routing, Process Lifecycle, browser automation and exec/sandbox tools exec routing and process lifecycle, exec routing and process lifecycle, Direct Tool Invoke API, Node System.run, browser automation and exec/sandbox tools direct tool invoke api and node system.run, direct tool invoke api and node system.run, Host Exec Approvals, Elevated Mode, browser automation and exec/sandbox tools host exec approvals and elevated mode, host exec approvals and elevated mode.

Category note: [Tool Invocation and Execution](exec-routing-and-process-lifecycle.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (79%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Exec Routing: Covers Exec Routing across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Process Lifecycle: Covers Process Lifecycle across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Direct Tool Invoke API: Covers Direct Tool Invoke API across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Node System.run: Covers Node System.run across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Host Exec Approvals: Covers Host Exec Approvals across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.
- Elevated Mode: Covers Elevated Mode across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.

Primary docs:

- `docs/tools/exec.md`
- `docs/gateway/background-process.md`
- `docs/gateway/tools-invoke-http-api.md`
- `docs/gateway/operator-scopes.md`
- `docs/gateway/protocol.md`
- `docs/tools/exec-approvals.md`
- `docs/tools/exec-approvals-advanced.md`
- `docs/tools/elevated.md`

### 3. Sandbox and Tool Policy

Search anchors: Sandbox Backends, Workspace Isolation, browser automation and exec/sandbox tools sandbox backends and workspace isolation, sandbox backends and workspace isolation, Sandboxed Browser, Codex Dynamic Tools, browser automation and exec/sandbox tools sandboxed browser and codex dynamic tools, sandboxed browser and codex dynamic tools, Tool Policy, Sandbox Tool Gates, browser automation and exec/sandbox tools tool policy and sandbox tool gates, tool policy and sandbox tool gates.

Category note: [Sandbox and Tool Policy](sandbox-backends-and-workspace-isolation.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- Sandbox Backends: Covers Sandbox Backends across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Workspace Isolation: Covers Workspace Isolation across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Sandboxed Browser: Covers Sandboxed Browser across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Codex Dynamic Tools: Covers Codex Dynamic Tools across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Tool Policy: Covers Tool Policy across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.
- Sandbox Tool Gates: Covers Sandbox Tool Gates across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.

Primary docs:

- `docs/gateway/sandboxing.md`
- `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`
- `docs/tools/multi-agent-sandbox-tools.md`
- `docs/plugins/codex-harness-reference.md`
- `docs/gateway/config-tools.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/browser-automation-and-exec-sandbox-tools/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/browser-automation-and-exec-sandbox-tools`.
