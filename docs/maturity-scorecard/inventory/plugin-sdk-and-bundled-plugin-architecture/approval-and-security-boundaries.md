---
title: Plugins - Plugin Approvals Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Plugin Approvals Maturity Note

## Summary

This category remains `Stable` on both coverage and quality. OpenClaw now has a clearer shared approval boundary model than the previous note captured: plugin approvals, exec approvals, Codex-native permission relays, same-chat fallback authorization, channel-native delivery, and security helper exports are all documented and implemented through shared SDK/runtime seams instead of per-channel one-offs. The main remaining weakness is proof breadth rather than boundary design: current repo evidence is strong for gateway/runtime and adapter behavior, but live multi-channel validation is still thinner than the docs and the taxonomy-owned validation commands are locally blocked by registry-auth failures before they can validate the packaged surface.

## Category Scope

This category covers approval and security boundaries inside the Plugins surface:

- Plugin-owned approval requests through `plugin.approval.*`, including ID generation, allowed-decision enforcement, routing metadata, and resolution.
- The separation between plugin approvals, exec approvals, Codex-native permission relays, MCP approval elicitations, and optional tool exposure.
- The `approvalCapability`/`nativeRuntime` seams that let bundled channel plugins express approval auth, availability, native delivery, fallback suppression, and exec-vs-plugin behavior without channel-specific core forks.
- Runtime protections around approval replay, decision scoping, device/node binding, and forwarded-target suppression.
- Public security/runtime helpers exposed to plugins and bundled extensions, including fs-safe wrappers, SSRF guards, path guards, redaction, access-group expansion, private file storage, and timing-safe secret comparison.

Out of scope: generic gateway authentication, non-approval channel behavior, provider-specific auth, and distribution/release compatibility outside the approval/security boundary surface.

## Features

- Approval requests: Plugin-initiated actions can request and resolve approvals through the standard flow.
- Native approval delivery: Privileged plugin actions can route approvals through channel-native prompts and responses.
- Same-chat fallbacks: Approval delivery can fall back to same-chat authorization notices when native routing is unavailable.
- Exec and plugin separation: Exec approvals remain distinct from plugin approval paths and native permission relays.
- Approval replay protection: Approval decisions remain scoped to the originating request, target, and device or node binding.
- Security helpers: Security helper exports provide approved primitives without widening trust boundaries.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded; `last_sync_at` `2026-05-28T19:09:52.784704Z`; `thread_count` `29810`; `open_thread_count` `11181`; `db_path` `/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`; `version` `0.2.1`.
- discrawl: `discrawl status --json` succeeded; live rerun `generated_at` `2026-05-30T00:38:20Z`; `state` `current`; `summary` `1487536 messages across 25831 channels`; `last_sync_at` `2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Real runtime evidence covers the core approval path end to end: gateway-hosted exec approvals over separate connections, operator approval runtime-token scoping, node-invoke anti-bypass and replay binding, system-run binding fixtures, shared native delivery planning, and channel-native adapter behavior across Slack, Discord, Matrix, Telegram, WhatsApp, Signal, and iMessage.
- Negative signals: Cross-channel evidence is still uneven. The strongest proof is gateway/runtime plus adapter-level tests, while checked-in live or release-smoke evidence for native plugin and exec approvals across multiple real chat providers remains sparse.
- Integration gaps: Add recurring, runnable release-smoke or CI coverage for native approval delivery and resolution across at least Slack, Matrix, Telegram, Discord, and one reaction-driven client, including plugin approvals, exec approvals, approver-DM routing, same-chat fallback notices, expiry, and mis-scoped approver attempts.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the category. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Stable (86%)`
- Gitcrawl reports: Current archive queries surface active approval UX and hardening work rather than a concrete boundary break: open work on resume-behind-plugin-approval (`#82906`), plain-language plugin approvals (`#81864`), MCP consent-envelope routing (`#78303`), long-form plugin approval context (`#81901`), and iMessage approval prompt formatting (`#85954`). These indicate ongoing polish and expansion pressure, not evidence that the shared approval/security boundary model is failing.
- Discrawl reports: Current Discord archive hits include release/maintainer evidence that approval-boundary hardening shipped recently (`non-admin device-role approvals` hardening, iMessage duplicate native approval prompt fix) plus operator questions about enforcing non-LLM approval layers. That supports real operator use, but it also shows the approval mental model still needs clear communication.
- Good qualities: The surface has crisp gate separation in docs, server-generated plugin approval IDs, decision validation against the request's allowed decisions, shared approval-auth seams, shared native delivery/runtime helpers, and a broad security helper export set that bundled plugins already consume for fs-safe, SSRF, secret, and path-boundary work.
- Bad qualities: The mental model is still distributed across several docs and channel pages; plugin `allow-always` durability is intentionally delegated to the caller/plugin runtime; and the deprecated broad `security-runtime` barrel remains public, which keeps legacy convenience but increases drift and over-import risk.
- Excluded from quality: Test coverage depth is excluded by policy, and the blocked taxonomy validation commands are treated as a local environment problem rather than as product-quality evidence.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Known Gaps

- The strongest evidence is still gateway/runtime plus adapter/unit coverage; there is not yet enough recurring live cross-channel validation to treat native approval delivery as broadly proven across every documented provider.
- Plugin authors still have to understand and implement what `allow-always` means for their own runtime; the shared plugin approval flow intentionally does not persist trust automatically.
- The approval/security story spans multiple docs (`plugin-permission-requests`, `exec-approvals`, `sdk-channel-plugins`, and channel-specific pages), so operator and plugin-author drift is still plausible.
- The taxonomy-owned validation commands could not run locally because dependency installation failed before validation with 403 registry auth errors for `@microsoft/teams.cards` / `@microsoft/teams.api` and `No authorization header was set for the request`.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-permission-requests.md:11` defines plugin permission requests as the `plugin.approval.*` flow; lines 16-30 separate them from exec approvals, optional tools, Codex-native permission review, and MCP elicitations; lines 90-109 document decision semantics and the plugin-owned nature of `allow-always` persistence; lines 118-165 document `approvals.plugin` routing and Codex-native permission relays.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:11` defines exec approvals as host guardrails layered on top of tool policy; lines 18-23 describe stricter effective-policy merging; lines 42-45 document native client affordances; lines 57-63 document canonical cwd/argv/env/file binding and deny-on-drift behavior.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-plugins.md:142` makes `approvalCapability` the canonical approval seam; lines 146-168 assign same-chat auth, native delivery, route suppression, target normalization, reroute notices, and exec-vs-plugin kind preservation to the shared SDK helpers rather than per-channel ad hoc logic.
- `/Users/kevinlin/code/openclaw/docs/channels/slack.md:1340` documents Slack-native exec and plugin approval delivery, separate plugin approvers vs exec approvers, and native suppression of shared fallback only when Slack can handle the approval natively.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:680`, `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:576`, and `/Users/kevinlin/code/openclaw/docs/channels/telegram.md:915` document channel-native approval semantics, explicit approver requirements, trusted-room caveats, and approval-kind-specific routing behavior across multiple bundled channels.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/plugin-approval.ts:28` implements the gateway `plugin.approval.*` handlers; lines 110-117 server-generate `plugin:` IDs and bind requester metadata; lines 197-205 enforce request-specific allowed decisions during resolve.
- `/Users/kevinlin/code/openclaw/src/infra/channel-approval-auth.ts:12` makes `approvalCapability.authorizeActorAction` and `getActionAvailabilityState` the canonical approval-authorization path, while preserving implicit same-chat fallback separately from explicit approver authorization.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/approval-native-helpers.ts:123` centralizes target matching across `{ to, accountId, threadId }`; lines 144-218 gate local native exec prompt suppression on approval kind, active native route, config mode, and request filters; lines 244-280 build the shared forwarding-fallback suppressor that preserves `approvalKind` and account scoping.
- `/Users/kevinlin/code/openclaw/src/infra/approval-native-runtime.ts:37` delivers approval requests through a planned native route with dedupe and per-target error handling; lines 173-260 thread `approvalKind`, route reporting, pending content, and gateway lifecycle through the shared native runtime.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/security-runtime.ts:1` keeps the deprecated broad security barrel public while still exporting fs-safe wrappers, SSRF guards, path guards, private-file helpers, sibling-temp writes, redaction, access-group expansion, and `safeEqualSecret`.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:51` exercises gateway-hosted exec approvals over separate operator/requester connections and waits for approval before command completion.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts:50` proves operator approval runtime authority works only for generated local gateway URLs and not for a remote-loopback configuration.
- `/Users/kevinlin/code/openclaw/src/gateway/server.node-invoke-approval-bypass.test.ts:432` rejects malformed approval flags before forwarding; lines 503-572 bind approvals to decision/device and block cross-device replay; lines 581-673 bridge chat approvals only for the same turn source; lines 681-727 block cross-node replay.
- `/Users/kevinlin/code/openclaw/src/gateway/system-run-approval-binding.contract.test.ts:72` evaluates checked-in fixture cases for argv/cwd/agent/session/env binding agreement and mismatch rejection.
- `/Users/kevinlin/code/openclaw/src/infra/approval-native-runtime.test.ts:35` covers native delivery dedupe and per-target failure handling; lines 123-226 verify that plugin approval kind, pending content, DM target resolution, and resolved updates all flow through the shared native runtime.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugin-sdk/approval-native-helpers.test.ts:18` covers shared origin-target resolution and target matching; lines 277-359 cover fallback suppression rules; lines 362-420 cover local native exec prompt suppression gates.
- `/Users/kevinlin/code/openclaw/src/infra/channel-approval-auth.test.ts:18` covers default authorization, explicit channel approval overrides, and the distinction between explicit approver auth and implicit same-chat fallback.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:573` keeps the approval-auth runtime helper subpath exported with the expected helper set.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/approval-native.test.ts:34`, `/Users/kevinlin/code/openclaw/extensions/slack/src/approval-native.test.ts:924`, and `/Users/kevinlin/code/openclaw/extensions/matrix/src/approval-native.test.ts:180` cover native approval availability, setup guidance, and the invariant that plugin approval auth stays independent from exec approvers.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.test.ts:82`, `/Users/kevinlin/code/openclaw/extensions/signal/src/approval-native.test.ts:107`, `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:107`, and `/Users/kevinlin/code/openclaw/extensions/telegram/src/approval-native.test.ts:34` cover reaction/button-driven native approvals, origin-target handling, and plugin-vs-exec routing behavior across the reaction-heavy bundled channels.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but dependency installation failed before meaningful validation with 403 registry auth errors for `@microsoft/teams.cards` / `@microsoft/teams.api` and `No authorization header was set for the request`; if it had run, it would verify that generated public SDK exports for approval/security subpaths still match the checked-in entrypoint inventory.
- `pnpm plugin-sdk:api:check`: `blocked` - same local registry-auth blocker; this would validate packaged public API drift in approval/runtime/security exports.
- `pnpm plugin-sdk:surface:check`: `blocked` - same local registry-auth blocker; this would validate surface-size and deprecated-export budgets, which is directly relevant to the still-public broad `security-runtime` barrel.
- `pnpm plugins:boundary-report:ci`: `blocked` - same local registry-auth blocker; this would validate reserved-import and compatibility boundaries across plugin SDK/bundled plugin seams.
- `pnpm release:plugins:npm:check`: `blocked` - same local registry-auth blocker; this would validate publishable npm metadata and release readiness for the plugin surface that carries these approval/security boundaries.
- `pnpm release:plugins:clawhub:check`: `blocked` - same local registry-auth blocker; this would validate publishable ClawHub metadata and release readiness for bundled plugin distribution paths that depend on the same packaged SDK surface.

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "plugin approval native security" --json
```

Results:

- Keyword search returned approval-boundary work rather than a direct boundary-failure incident.
- Open issue `#81901` ("Allow plugin approvals to carry long-form context (Telegram, Slack, Discord)") shows current UX pressure on plugin approval payload limits.
- Open PR `#81864` ("feat(approvals): add plain-language plugin approvals") and open PR `#78303` ("feat(mcp): channel-mediated approval for MCP tool calls (consent envelope)") show continued investment in approval rendering and routing.
- Open PR `#86079` ("fix(codex): verify plugin elicitation source") and open PR `#87141` ("fix(plugin): harden schema and metadata fuzz boundaries") are adjacent hardening evidence rather than proof of a broken shared approval model.

Query:

```bash
gitcrawl search openclaw/openclaw --query "plugin approval allow-always" --json
```

Results:

- Keyword search returned active approval UX refinement work around `allow-always`, fallback text, and rendering.
- Open PR `#82906` ("fix(codex): gate CLI session resume behind plugin approval") shows approval boundaries being extended to additional high-trust flows.
- Open PR `#80141` ("fix(approvals): summarize long approval prompts") and open PR `#78793` ("fix(approvals): interpolate request id into \"Reply with:\" line") show concrete polish work on approval messaging.
- Open issue `#85954` (iMessage approval formatting) and open issue `#78308` (consent-envelope follow-up) indicate remaining product polish gaps, not a collapse of the approval/security boundary itself.

### Discrawl queries

Query:

```bash
discrawl --json search "plugin approval" --limit 5
```

Results:

- Top hits were release/announcement messages rather than user-confusion threads.
- The `releases` and `general` posts for `OpenClaw 2026.5.27` explicitly call out approval-boundary hardening (`non-admin device-role approvals`) and ask users to test channel/runtime regressions.
- Treated as mildly positive operational evidence that approval/security changes are shipping and being exercised, but not as proof of broad cross-channel validation depth.

Query:

```bash
discrawl --json search "native approval" --limit 5
```

Results:

- A maintainer message in `maintainers` references porting a fix for duplicate iMessage native exec approval prompts and shared reaction-based approval helpers.
- A user message in `general` asks whether OpenClaw has a native non-LLM approval layer, which is evidence of operator demand for this boundary and for clearer messaging around it.
- Recent `clawtributors`/`releases` messages describe native hook relay stability and approval-boundary improvements, which is useful operational context but still not a substitute for runnable multi-channel validation.
