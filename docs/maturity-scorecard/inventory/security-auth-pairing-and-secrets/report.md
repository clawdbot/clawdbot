---
title: "Security, auth, pairing, and secrets Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (80%)`
- Quality: `Alpha (67%)`
- Completeness: `Stable (80%)`
- LTS Features: `5/6`

## Summary

This report promotes the archived `security-auth-pairing-and-secrets` maturity evidence from `/Users/kevinlin/tmp/maturity/security-auth-pairing-and-secrets` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Approval Policy and Tool Safeguards](approval-policy-and-dangerous-tool-safeguards.md) | ✅  | `Stable (86%)` | `Beta (72%)`  | `Stable (86%)` | Approval Policy, Dangerous Tool Safeguards                                                                                                                                                                                                            |
| [Gateway Auth and Remote Access](gateway-auth-and-network-exposure.md)                  | ✅  | `Stable (82%)` | `Alpha (68%)` | `Stable (82%)` | Shared Gateway token/password auth, Gateway auth mode, Trusted-proxy identity, Tailscale Serve/Funnel, Bind and origin restrictions, WebSocket handshake auth, Operator-facing docs, Browser Control UI, Remote Client Trust                          |
| [Channel Access Control](channel-identity-allowlists-and-sender-pairing.md)             | ✅  | `Beta (78%)`   | `Alpha (66%)` | `Beta (78%)`   | Channel Identity, Allowlists, Sender Pairing                                                                                                                                                                                                          |
| [Device and Node Pairing](device-identity-and-operator-pairing.md)                      | ✅  | `Stable (83%)` | `Alpha (66%)` | `Stable (83%)` | Setup codes, Device identity creation, Device-token issuance, Device pairing approvals for operator, Operator scopes that gate pairing, Local Control UI, Auth migration, Operator-facing docs, Node Pairing, Capability Trust, Remote Exec Approvals |
| [Plugin Trust](plugin-installation-trust-and-security-boundaries.md)                    | ❌  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Plugin Installation Trust, Security Boundaries                                                                                                                                                                                                        |
| [Credential and Secret Hygiene](secrets-storage-redaction-and-configuration-hygiene.md) | ✅  | `Beta (78%)`   | `Alpha (62%)` | `Beta (78%)`   | Provider Auth Profiles, API Key Health, Secrets Storage, Redaction, Configuration Hygiene                                                                                                                                                             |

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

### 1. Approval Policy and Tool Safeguards

Search anchors: approval policy, dangerous tool safeguards, exec approvals.

Category note: [Approval Policy and Tool Safeguards](approval-policy-and-dangerous-tool-safeguards.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (86%)`
- LTS: ✅

Features:

- Approval Policy: Covers Approval Policy across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.
- Dangerous Tool Safeguards: Covers Dangerous Tool Safeguards across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.

Primary docs:

- `docs/tools/exec-approvals.md`
- `docs/cli/approvals.md`
- `docs/plugins/plugin-permission-requests.md`
- `docs/gateway/security/audit-checks.md`

### 2. Gateway Auth and Remote Access

Search anchors: gateway.auth.mode, trusted proxy auth, Tailscale Serve/Funnel, WebSocket handshake auth, Control UI auth, remote client trust, allowed origins.

Category note: [Gateway Auth and Remote Access](gateway-auth-and-network-exposure.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Alpha (68%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Shared Gateway token/password auth: Token and password auth for Gateway HTTP and WebSocket clients, including runtime auth resolution, startup validation, shared-secret comparison, and operator guidance.
- Gateway auth mode: Gateway auth mode selection, including private ingress behavior and operator warnings for unsafe exposure.
- Trusted-proxy identity: Trusted-proxy identity, gateway.trustedProxies, trustedProxy.userHeader, requiredHeaders, allowUsers, allowLoopback, reverse-proxy source validation, and scope behavior
- Tailscale Serve/Funnel: Tailscale Serve/Funnel and reverse-proxy exposure rules, including Tailscale identity headers, tailscale whois, Funnel password requirements, and separation between Control UI/WS identity and HTTP API auth
- Bind and origin restrictions: loopback/LAN/tailnet/custom bind modes, non-loopback exposure checks, browser Origin checks, controlUi.allowedOrigins, Host-header fallback risk, and forwarded-header handling
- WebSocket handshake auth: WebSocket handshake auth, including challenge/connect ordering, nonce-bound device auth, shared auth, browser origin checks, pre-auth limits, unauthenticated socket timeout, and stale shared-auth rotation
- Operator-facing docs: Operator-facing docs and runbooks for security audit, remote access, exposure rollback, Tailscale, trusted proxy, credential rotation, and explicit credential probing
- Browser Control UI: Covers Browser Control UI across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.
- Remote Client Trust: Covers Remote Client Trust across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.

Primary docs:

- `docs/gateway/security/index.md`
- `docs/gateway/security/exposure-runbook.md`
- `docs/gateway/trusted-proxy-auth.md`
- `docs/gateway/tailscale.md`
- `docs/gateway/remote.md`
- `docs/gateway/configuration-reference.md`
- `docs/cli/gateway.md`
- `docs/cli/doctor.md`
- `docs/web/control-ui.md`
- `docs/tools/browser-control.md`
- `docs/gateway/security/audit-checks.md`

### 3. Channel Access Control

Search anchors: DM pairing, allowFrom, sender allowlists.

Category note: [Channel Access Control](channel-identity-allowlists-and-sender-pairing.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Channel Identity: Covers Channel Identity across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Allowlists: Covers Allowlists across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.
- Sender Pairing: Covers Sender Pairing across who can talk to OpenClaw through message channels: DM pairing codes, pairing stores, `dmPolicy`, `allowFrom`, and related channel identity, allowlists, and sender pairing behavior.

Primary docs:

- `docs/channels/pairing.md`
- `docs/channels/telegram.md`
- `docs/channels/access-groups.md`
- `docs/gateway/security/audit-checks.md`

### 4. Device and Node Pairing

Search anchors: setup codes, device challenge signing, operator scopes, node pairing, node-declared capabilities, remote exec approvals.

Category note: [Device and Node Pairing](device-identity-and-operator-pairing.md)

Score decisions:

- Coverage: `Stable (83%)`
- Quality: `Alpha (66%)`
- Completeness: `Stable (83%)`
- LTS: ✅

Features:

- Setup codes: Setup codes and QR pairing UX for mobile/node onboarding through the device-pair plugin
- Device identity creation: Device identity creation, storage, public-key-derived device IDs, challenge signing, and server verification
- Device-token issuance: Device-token issuance, reconnect reuse, token mismatch recovery, token rotation, token revocation, and stale-token cleanup
- Device pairing approvals for operator: Device pairing approvals for operator and node roles, including pending requests, role/scope upgrades, and repair requests
- Operator scopes that gate pairing: Operator scopes that gate pairing, device token management, node pairing, and higher-risk role/scope approvals
- Local Control UI: Local Control UI, WebChat, trusted-proxy, and backend auto-pairing or device-less exception behavior where it affects operator pairing
- Auth migration: Auth migration and recovery errors for pre-challenge device signing, token drift, scope mismatch, and mixed gateway auth configuration
- Operator-facing docs: Operator-facing docs for devices, pairing, WebChat, Control UI, protocol auth, and troubleshooting
- Node Pairing: Covers Node Pairing across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Capability Trust: Covers Capability Trust across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Remote Exec Approvals: Covers Remote Exec Approvals across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/cli/devices.md`
- `docs/channels/pairing.md`
- `docs/gateway/pairing.md`
- `docs/gateway/operator-scopes.md`
- `docs/web/control-ui.md`
- `docs/web/webchat.md`
- `docs/cli/approvals.md`

### 5. Plugin Trust

Search anchors: plugin manifest trust, plugin install safety scans, plugin allowlists.

Category note: [Plugin Trust](plugin-installation-trust-and-security-boundaries.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Plugin Installation Trust: Covers Plugin Installation Trust across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.
- Security Boundaries: Covers Security Boundaries across plugin manifest trust, plugin install/update safety scans, plugin allowlists, manifest-owned auth/secret metadata, and related plugin installation trust and security boundaries behavior.

Primary docs:

- `docs/plugins/manifest.md`
- `docs/plugins/plugin-permission-requests.md`
- `docs/plugins/manage-plugins.md`
- `docs/gateway/security/audit-checks.md`

### 6. Credential and Secret Hygiene

Search anchors: auth-profiles.json, provider API keys, OAuth profiles, SecretRef, runtime secret snapshots, redaction patterns.

Category note: [Credential and Secret Hygiene](secrets-storage-redaction-and-configuration-hygiene.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Provider Auth Profiles: Covers Provider Auth Profiles across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- API Key Health: Covers API Key Health across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- Secrets Storage: Covers Secrets Storage across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Redaction: Covers Redaction across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Configuration Hygiene: Covers Configuration Hygiene across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.

Primary docs:

- `docs/gateway/authentication.md`
- `docs/cli/models.md`
- `docs/providers/openai.md`
- `docs/concepts/oauth.md`
- `docs/gateway/secrets.md`
- `docs/cli/secrets.md`
- `docs/reference/secretref-credential-surface.md`
- `docs/gateway/security/audit-checks.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/security-auth-pairing-and-secrets/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/security-auth-pairing-and-secrets`.
