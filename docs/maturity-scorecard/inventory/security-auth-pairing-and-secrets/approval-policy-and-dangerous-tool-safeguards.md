---
title: "Security, auth, pairing, and secrets - Approval Policy and Tool Safeguards Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Approval Policy and Tool Safeguards Maturity Note

## Summary

OpenClaw has a well-developed approval stack for host exec, plugin approvals, channel-native approvals, node-host approvals, allowlists, ask policy, and approval binding. Coverage is Stable because approval behavior is exercised across Gateway, node host, infra helpers, SDK/plugin flows, and many channel plugins. Quality is Beta because the architecture is robust but the lived record still includes open hardening work, requests for stronger authentication such as TOTP, and recurring operator confusion around YOLO, exact allowlists, safe bins, and what approvals do or do not protect.

## Category Scope

Included in this category:

- Approval Policy: Covers Approval Policy across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.
- Dangerous Tool Safeguards: Covers Dangerous Tool Safeguards across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.

## Features

- Approval Policy: Covers Approval Policy across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.
- Dangerous Tool Safeguards: Covers Dangerous Tool Safeguards across exec approval policy, host-local approval stores, allowlist and ask modes, dangerous tool safeguards, native/chat approval routing, plugin approval routing, approval decisions, approval binding, and operator-facing CLI management.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals: Exec approval docs are detailed; Gateway and node-host source enforce policy and approval binding; tests span approval classifiers, display, request filters, forwarders, channel approvals, plugin approvals, node-host planning, and SDK e2e approval calls.
- Negative signals: Some safeguards, such as hard-deny path patterns and stronger approver authentication, remain active work rather than settled release behavior.
- Integration gaps: Add recurring scenario proof for gateway-host exec, node-host exec, no-UI fallback, native approval routing across top channels, plugin approval forwarding, and deny/allow policy transitions.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: The exact issue query returned open #67440 for optional TOTP on exec approvals. The PR query returned open #81827 for `tools.exec.denyPathPatterns` hard-deny gating.
- Discrawl reports: The exact search returned no visible rows, but broader security-audit Discord results show users confusing `gateway.nodes.denyCommands` with shell filtering and seeing critical/warn output about open groups, unsandboxed small models, and exec-enabled surfaces.
- Good qualities: Approval decisions bind concrete command context, ask fallback fails closed by default, plugin approvals are separate from exec approvals, and docs warn that approvals are not per-user isolation or read-only filesystem policy.
- Bad qualities: The policy surface is complex, YOLO defaults can surprise operators, exact command allowlists are easy to overestimate, and additional hard-deny and approver-auth improvements are still open.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Approval Policy, Dangerous Tool Safeguards.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No built-in TOTP or second-factor approver check exists for exec approvals yet.
- Deny-path hardening is still active PR work.
- Operators still need careful education that approval policy, sandbox policy, tool visibility, and channel access are separate layers.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` documents exec approval trust model, policy knobs, allowlist behavior, ask fallback, strict inline eval, YOLO mode, and approval binding.
- `/Users/kevinlin/code/openclaw/docs/cli/approvals.md` documents `openclaw approvals` and `openclaw exec-policy`.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-permission-requests.md` documents plugin approvals, decision behavior, routing, and how plugin approvals differ from exec approvals.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md` documents dangerous exec, safe-bin, open-channel, sandbox, plugin, and tool-surface audit checks.

### Source

- `/Users/kevinlin/code/openclaw/src/infra/exec-approvals.ts` implements exec approval policy and storage helpers.
- `/Users/kevinlin/code/openclaw/src/node-host/exec-policy.ts`, `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.ts`, and `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-plan.ts` enforce node-host execution policy.
- `/Users/kevinlin/code/openclaw/src/infra/system-run-approval-binding.ts` and `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts` bind approval context to dangerous commands.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/plugin-approval.ts` and `/Users/kevinlin/code/openclaw/src/infra/plugin-approvals.ts` implement plugin approval flows.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts` covers gateway-host exec approval.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts` covers operator approval client behavior.
- `/Users/kevinlin/code/openclaw/packages/sdk/src/index.e2e.test.ts` covers SDK approval list/respond methods.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/exec-approvals.test.ts`, `/Users/kevinlin/code/openclaw/extensions/discord/src/exec-approvals.test.ts`, `/Users/kevinlin/code/openclaw/extensions/slack/src/exec-approvals.test.ts`, and `/Users/kevinlin/code/openclaw/extensions/matrix/src/exec-approvals.test.ts` cover channel approval handling.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/exec-approvals-policy.test.ts`, `/Users/kevinlin/code/openclaw/src/infra/exec-approvals-safe-bins.test.ts`, `/Users/kevinlin/code/openclaw/src/infra/exec-approval-request-filters.test.ts`, and `/Users/kevinlin/code/openclaw/src/infra/system-run-approval-context.test.ts` cover approval policy internals.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-plan.test.ts`, `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run-allowlist.test.ts`, and `/Users/kevinlin/code/openclaw/src/node-host/exec-policy.test.ts` cover node-host planning and allowlist behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/plugin-approval.test.ts` and `/Users/kevinlin/code/openclaw/src/plugin-sdk/approval-auth-helpers.test.ts` cover plugin approval behavior.
- `/Users/kevinlin/code/openclaw/src/acp/approval-classifier.test.ts` covers approval classification.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "exec approvals system.run allowlist ask policy sandbox"`

Results:

- Returned open issue #67440, `[Feature][Security]: Add optional TOTP (authenticator app code) to exec approvals`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "node.invoke approval bypass system.run"`

Results:

- Returned open PR #81827, `feat(security/exec): add tools.exec.denyPathPatterns hard-deny gate (#74379)`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "exec approvals system.run allowlist ask policy sandbox"`

Results:

- Returned no visible rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "node pairing approve system.run"`

Results:

- Found security-audit outputs warning that `gateway.nodes.denyCommands` entries are exact command names, not shell-text filters.
- Found guidance that node exec requires `system.run.prepare` in the node command list and pending node approval/scope upgrades when absent.
