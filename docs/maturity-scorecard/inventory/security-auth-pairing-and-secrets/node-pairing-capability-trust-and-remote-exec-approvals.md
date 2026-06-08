---
title: "Security, auth, pairing, and secrets - Node Pairing, Capability Trust, and Remote Exec Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Node Pairing, Capability Trust, and Remote Exec Approvals Maturity Note

## Summary

OpenClaw has a strong node trust model: node device pairing is separate from legacy `node.pair.*`, node command exposure is filtered until trust is established, and remote `system.run` relays are bound to approval context. Coverage is Stable because source and server-flow tests exercise node pairing, trusted-CIDR auto-approval, device-pair authorization, and `node.invoke` approval binding. Quality is Alpha because recent archive evidence includes critical remote-exec regressions and user confusion around node pairing, scope upgrades, and ineffective deny-command expectations.

## Category Scope

This category covers node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, `node.invoke` forwarding, `system.run` approval binding, and operator-facing recovery commands for node trust.

## Features

- Node Pairing: Covers Node Pairing across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Capability Trust: Covers Capability Trust across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Remote Exec Approvals: Covers Remote Exec Approvals across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`
- Positive signals: Gateway pairing docs, operator-scope docs, and node host docs describe pending requests, token issuance, pairing expiry, auto-approval limits, command gating, and admin requirements for exec-capable nodes. Server-flow tests cover node pairing authorization, auto-approval, device-pair approval, token rotation, and approval bypass regressions.
- Negative signals: Coverage is strongest around Gateway/server-flow tests. Real multi-host topology proof for Docker, userspace Tailscale, macOS/Linux node services, and node command upgrade UX is thinner than the local integration surface.
- Integration gaps: Add recurring release smoke for a real remote node through Tailscale/Docker, explicit scope-upgrade approval, node command deny/allow policy, and `system.run.prepare` plus `system.run` approval execution on the node host.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: The exact issue query below returned no direct rows, but the paired PR query found open hardening work for a deny-path gate. Older closed security PRs in the Discord archive show node command exposure before pairing approval and device-pair-only exec exposure.
- Discrawl reports: The feature-specific Discord search found user/operator confusion about node pairing through Docker/userspace Tailscale, `PAIRING_REQUIRED` recovery, `AUTH_TOKEN_MISMATCH`, scope upgrade details, and critical node.invoke hardening PR discussions.
- Good qualities: Node auto-approval is narrow, command exposure is bounded by pairing state and global node policy, operator scopes distinguish `operator.pairing` from `operator.admin`, and approval binding ties dangerous node runs to concrete execution context.
- Bad qualities: The lived incident record includes severe remote-exec bypasses, users still hit proxy/locality edge cases, and operator guidance around node pending requests versus device pending requests remains easy to confuse.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Node Pairing, Capability Trust, Remote Exec Approvals.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Real-network node pairing still has high operational variance around proxies, Docker bridge addresses, Tailscale userspace networking, and stale pending request IDs.
- Node command denial is exact command-name policy, not shell-payload filtering; users repeatedly misread this boundary.
- Additional hard-deny controls for dangerous paths are still tracked as active work.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/pairing.md` documents Gateway-owned node pairing, pending requests, token issuance, command gating, trusted-CIDR auto-approval, metadata-upgrade auto-approval, and storage under `~/.openclaw/nodes`.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md` documents WS node device pairing, setup-code bootstrap bounds, `devices approve`, node token scope limits, and trusted-CIDR auto-approval.
- `/Users/kevinlin/code/openclaw/docs/gateway/operator-scopes.md` documents node pairing approval-time scope checks and admin requirements for exec-capable command lists.
- `/Users/kevinlin/code/openclaw/docs/cli/approvals.md` and `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` document gateway/node exec approval management.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/node-pairing-auto-approve.ts` restricts trusted-CIDR auto-approval to fresh `role=node` requests with no scopes, no browser/Control UI/WebChat markers, and non-loopback trusted source evidence.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/devices.ts` owns device approval, revocation, rotation, and pending-request behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/nodes.ts` handles node listing and `node.invoke` forwarding.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts` validates approval binding for remote node `system.run`.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-plan.ts` binds canonical cwd, executable, and mutable script operands before approval-backed execution.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.node-pairing-authz.test.ts` covers node-pairing authorization behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.node-pairing-auto-approve.test.ts` covers trusted-CIDR node auto-approval through the server surface.
- `/Users/kevinlin/code/openclaw/src/gateway/server.node-invoke-approval-bypass.test.ts` covers historical `node.invoke` approval bypass behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.device-pair-approve-authz.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.device-token-rotate-authz.test.ts` cover device approval and token-rotation authorization.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/node-pairing-auto-approve.test.ts` covers the pure trusted-CIDR auto-approval predicate.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval-match.test.ts` cover approval matching and binding.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-plan.test.ts`, `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-allowlist.test.ts`, and `/Users/kevinlin/code/openclaw/src/node-host/exec-policy.test.ts` cover node-side execution planning and policy.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "node pairing node.invoke system.run approval bypass"`

Results:

- Returned `[]` in the current local issue archive.

Query: `gitcrawl --json search prs -R openclaw/openclaw "node.invoke approval bypass system.run"`

Results:

- Returned open PR #81827, `feat(security/exec): add tools.exec.denyPathPatterns hard-deny gate (#74379)`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "node pairing node.invoke system.run approval bypass"`

Results:

- Returned no visible rows in the current local Discord archive.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "node pairing approve system.run"`

Results:

- Found security-audit support output warning that `gateway.nodes.denyCommands` uses exact command names only.
- Found PR discussions for #65543 and #65169 describing critical fixes for device-pairing-only node command exposure and `node.invoke` reachability before node pairing approval.
- Found operator guidance that missing `system.run.prepare` in `nodes describe` usually means a pending node request or scope upgrade still needs approval.
