---
version: 3
---

# Approvals and Remote Execution

## Summary

- Feature family: Approvals and remote execution.
- Slug: approval-and-execution-safety.
- Coverage: 88/100, Yes.
- Quality: 72/100, Medium.
- Bottom line: exec approval request/lookup/wait/resolve APIs, gateway and node-local approval policy snapshots, node-host `systemRunPlan` binding, mutation rejection, plugin approval primitives, and strict-vs-best-effort agent delivery behavior are implemented and documented. Coverage is Yes because real Gateway/WebSocket/server-flow tests prove exec approval resolution, node.invoke approval bypass protection, node/device replay rejection, and strict delivery fallback behavior.
- Quality stays Medium because open archive reports still show approval route and plugin-approval gaps, group-channel confidentiality concerns, channel-mediated consent gaps, and delivery fallback edge cases.

## Features

- Exec approvals: Exec approval request, lookup, wait, resolve, and policy snapshot APIs.
- Plugin approvals: Plugin approval request, wait, and resolution flows.
- Node exec approvals: Node-local exec approval policy relay through Gateway RPC.
- Approved node execution: Canonical `systemRunPlan` binding for node-host execution.
- Approval mutation safety: Rejection of mutated `command`, `cwd`, `agentId`, or `sessionKey` after approval preparation.
- Delivery fallback behavior: Agent delivery fallback between strict deliverable routes and session-only execution.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 88/100.

Label: Yes.

Positive signals:

- Protocol docs enumerate exec approval request/get/list/resolve/waitDecision APIs, gateway policy snapshot APIs, node-local policy relay APIs, and plugin approval request/list/waitDecision/resolve APIs (`docs/gateway/protocol.md:465`, `docs/gateway/protocol.md:470`).
- Protocol docs expose `exec.approval.requested` / `exec.approval.resolved` and `plugin.approval.requested` / `plugin.approval.resolved` lifecycle events (`docs/gateway/protocol.md:503`, `docs/gateway/protocol.md:506`).
- Protocol docs state `host=node` approvals require `systemRunPlan`, approved forwards reuse the canonical plan, and mutated `command`, `rawCommand`, `cwd`, `agentId`, or `sessionKey` are rejected (`docs/gateway/protocol.md:621`, `docs/gateway/protocol.md:630`).
- Protocol docs define strict delivery failure versus `bestEffortDeliver=true` session-only fallback (`docs/gateway/protocol.md:632`, `docs/gateway/protocol.md:636`).
- Security docs describe the Gateway/node trust boundary, clarify that `sessionKey` is routing context rather than auth, and document exact request-context binding for exec approvals (`docs/gateway/security/index.md:170`, `docs/gateway/security/index.md:183`).
- Security docs distinguish node pairing from per-command approval, route node-local `system.run` policy through the node exec approvals file, and document canonical `systemRunPlan` storage plus caller-edit rejection (`docs/gateway/security/index.md:498`, `docs/gateway/security/index.md:508`).
- Source registers approval method scopes and handlers for exec approvals, exec approval policy snapshots, node-local approval policy relays, and plugin approvals (`src/gateway/methods/core-descriptors.ts:51`, `src/gateway/server-aux-handlers.ts:268`).
- Exec approval handlers support lookup/list/request, two-phase request registration before response, host=node `nodeId` and `systemRunPlan` validation, canonical binding construction, and request event broadcast (`src/gateway/server-methods/exec-approval.ts:90`, `src/gateway/server-methods/exec-approval.ts:153`, `src/gateway/server-methods/exec-approval.ts:221`, `src/gateway/server-methods/exec-approval.ts:289`, `src/gateway/server-methods/exec-approval.ts:339`).
- Gateway and node-local exec approval policy APIs are separated: gateway snapshots read/write local approval config, while `exec.approvals.node.get/set` relays through node `system.execApprovals.*` commands (`src/gateway/server-methods/exec-approvals.ts:98`, `src/gateway/server-methods/exec-approvals.ts:131`).
- Plugin approvals server-generate `plugin:` IDs, carry plugin/tool/session/turn-source context, broadcast request events, wait for decisions, validate allowed decisions, and broadcast resolved events (`src/gateway/server-methods/plugin-approval.ts:28`, `src/gateway/server-methods/plugin-approval.ts:88`, `src/gateway/server-methods/plugin-approval.ts:110`, `src/gateway/server-methods/plugin-approval.ts:137`, `src/gateway/server-methods/plugin-approval.ts:160`, `src/gateway/server-methods/plugin-approval.ts:169`).
- Node-host approval forwarding strips caller-controlled approval fields, requires a real approval record and runId, binds approval use to node and device/client context, rewrites command/cwd/agent/session from stored `systemRunPlan`, rejects binding mismatches, and consumes allow-once approvals (`src/gateway/node-invoke-system-run-approval.ts:214`, `src/gateway/node-invoke-system-run-approval.ts:257`, `src/gateway/node-invoke-system-run-approval.ts:291`, `src/gateway/node-invoke-system-run-approval.ts:315`, `src/gateway/node-invoke-system-run-approval.ts:340`, `src/gateway/node-invoke-system-run-approval.ts:380`, `src/gateway/node-invoke-system-run-approval.ts:394`).
- Agent delivery planning keeps strict delivery failures when `bestEffortDeliver=false` and downgrades internal or missing deliverable routes to session-only only when best effort is enabled (`src/gateway/server-methods/agent.ts:1702`, `src/gateway/server-methods/agent.ts:1735`, `src/gateway/server-methods/agent.ts:1776`, `src/gateway/server-methods/agent.ts:1797`).
- Real Gateway/WebSocket tests cover local approval resolver behavior, remote loopback approval lookup rejection, and separate-connection operator approval resolution (`src/gateway/operator-approvals-client.e2e.test.ts:83`, `src/gateway/operator-approvals-client.e2e.test.ts:139`, `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:63`).
- Real Gateway/server-flow tests cover node.invoke payload rejection before forwarding, approval/device binding, cross-device replay rejection, backend reconnect replay only for the same turn source, and cross-node replay rejection (`src/gateway/server.node-invoke-approval-bypass.test.ts:409`, `src/gateway/server.node-invoke-approval-bypass.test.ts:503`, `src/gateway/server.node-invoke-approval-bypass.test.ts:581`, `src/gateway/server.node-invoke-approval-bypass.test.ts:681`).
- Gateway agent server tests cover strict delivery erroring and last-channel routing with `bestEffortDeliver` defaulting true for the active chat run path (`src/gateway/server.agent.gateway-server-agent-a.test.ts:516`, `src/gateway/server.agent.gateway-server-agent-a.test.ts:579`).

Negative signals:

- Plugin approval end-to-end coverage is weaker than exec approval coverage. The implementation has handler/unit tests for request, no-route expiry, ID generation, and allowed decisions, but no located full WebSocket/channel integration comparable to `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:63`.
- The safety path spans Gateway request handlers, shared approval routing, node.invoke sanitization, node-host prepare/execute, bash-tool approval follow-up, plugin SDK helpers, and channel approval UIs. Archive history shows this breadth has produced repeated regressions.
- `systemRunPlan` has strong source/unit/server-flow evidence, but live node-host proof across actual Mac/Linux/Windows node services was not found in this slice.
- Agent delivery fallback has server-flow evidence, but archive reports show delivery fallback and approval route behavior still produce channel-specific edge cases.

Integration gaps:

- Add a full WebSocket/Gateway plugin approval flow test that requests `plugin.approval.request`, delivers to an approval-capable client or channel runtime, resolves through `plugin.approval.resolve`, and verifies `plugin.approval.resolved`.
- Add live node-host proof for `host=node` approved execution that prepares `system.run.prepare`, stores `systemRunPlan`, mutates final command/cwd/session inputs, and verifies fail-closed behavior on an actual node service.
- Add multi-channel native approval proof for private/group approval routing because recent Discord/iMessage/Slack discussion shows route and duplication behavior remain fragile.
- Add server-flow proof for agent delivery fallback when approval follow-up routes are unavailable, not only the generic `agent` delivery path.

## Quality

Score: 72/100.

Label: Medium.

### Gitcrawl reports

- Query: `gitcrawl search issues '"exec approval" OR "exec approvals" OR "exec.approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 20 hits, all closed in the returned page. Notable reports include #15047 conflicting `approvals.exec` versus `exec-approvals.json`; #16184 exec approval forwarding to Telegram broken; #61600 command-too-long misleading approval error; #9063 security full/ask off still gates; #22988 Discord bot not receiving `exec.approval.requested`; #43989 exec approval socket not created/hang; #19919 configurable exec approval timeout; #59125 invalid `approvals.exec.mode` subagent behavior.
- Query: `gitcrawl search issues '"plugin approval" OR "plugin approvals" OR "plugin.approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 20 hits. Open reports include #75749 duplicate Telegram plugin approval messages when `turnSourceChannel` is null; #74003 plugin approval no approval route / `turnSourceChannel` not passed; #81901 long-form plugin approval context; #86777 document Codex app-server report-mode handling of plugin `requireApproval`; #79824 Feishu card V2 approval cards fail; #78308 channel-mediated approval for MCP tool calls. Closed reports include #59671 plugin approval blocking `waitDecision` deadlock, #48515 generic approval routing primitive, #75696 Computer Use approval denied via MCP elicitation, #82485 approval-handler runtime deliverTarget race, #79157 LLM-assisted exec approvals / policy reasoning, and #19072 first-class tool approvals pause/interrupt/resume.
- Query: `gitcrawl search issues '"systemRunPlan" OR "system.run.prepare" OR "system.run" "approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: no returned issues.
- Query: `gitcrawl search issues '"bestEffortDeliver" OR "session-only" OR "delivery fallback" OR "deliverable route"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: no returned issues.
- Query: `gitcrawl search issues 'node exec approval system.run node.invoke approval bypass' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 8 hits, all closed in the returned page. Notable reports include #8682 exec approval bypass via client-controlled flags in `system.run`; #10128 `node.invoke` lets `operator.write` bypass approvals with caller-controlled approved flag; #66136 host=node denies absolute-path binaries under full/off; #65542 device pairing exposes exec-capable nodes before admin node approval; #65168 node.invoke reachable before node pairing approval; #66524 binder fail-closed rejects all absolute-path commands.
- Query: `gitcrawl search issues 'node.invoke system.run approval runId approved approvalDecision' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: no returned issues.
- Query: `gitcrawl search issues 'agent delivery best effort session only deliver fallback' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 5 hits. Open report #84297 says per-agent identity overlay is dropped on cron announce/heartbeat Slack pushes. Closed reports include #21552 cron announce delivery fails when delivery target/channel is unset, #27131 first-class cron/session routing, #22298 isolated cron announce delivery fails with pairing required, and #67849 `sessions_send` lag.
- Query: `gitcrawl search issues 'approval route no approval route turnSourceChannel approvals plugin exec' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 2 hits: #74003 open for plugin approval no approval route / missing `turnSourceChannel`, and #85841 closed for heartbeat exec approvals waiting full timeout instead of failing fast on unsupported surface.

### Discrawl reports

- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "exec approval"`
  Result: recent maintainer and clawtributor results around moving approval reaction logic to `plugin-sdk`, duplicate iMessage native exec approval prompts, Discord exec approval DM/card token breakage, Discord approval route notice least-privilege discussion, group-originated exec approvals routing to DM to avoid leaking command/path details, and user support around native hook relay and exec policy.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "plugin approval"`
  Result: recent results around external plugin HITL approval resolution PRs (#82431/#82434/#82471), plugin SDK reaction approval helpers, proof-backed approval resolution, durable approval/status cards, Discord stale-click approval UX, and native approval route-notice/token split.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "systemRunPlan"`
  Result: results include issue #55258 closed as implemented for node-targeted exec approval executing on selected node, PR #59804 forwarding `systemRunPlan` in async approval path, PR/review comments warning that missing `systemRunPlan` breaks `host=node`, and user support explaining approval metadata with `systemRunPlan` / `systemRunBinding`.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "bestEffortDeliver"`
  Result: results include closed PR #53538 and #51948 around best-effort delivery downgrading to session-only, PR #70585 subagent announce best-effort delivery, strict Discord DM route guidance with `bestEffortDeliver=false`, delivery failure JSON-envelope review, and boot/startup delivery fallback fixes.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "no approval route"`
  Result: results include maintainer guidance that separate-process token reading should be CLI/Docker-only, contributor discussion of approval action/no-route model in #82431, closed issue #67285 where no-route approvals resolve as typed unavailable state, closed issue #43989 where no approval route expires immediately instead of hanging, and closed issue #66994 around prompts despite ask off.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "node.invoke approval"`
  Result: results include node/file-fetch policy discussion, issue #55258 implemented with `systemRunPlan`, node.invoke pre-pairing critical bug #65168/#65169, review comments on forwarding inline fallback approval to node invoke, preserving requester device metadata, and parsing environment overrides for system.run payloads.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "delivery fallback"`
  Result: recent results focused on broader delivery fallback work: generated-media fallback PRs, Feishu/Discord delivery origin fixes, and channel/session fallback behavior. No approval-specific hit dominated this query.

### Good qualities

- Exec and plugin approvals share common pending-approval mechanics while keeping method namespaces and ID prefixes distinct.
- The node-host approval path treats `systemRunPlan` as the authority, not caller-provided final `node.invoke` params, and checks node/device/session binding before forwarding.
- Approval decisions are scoped: plugin approvals validate allowed decisions, exec approvals consume allow-once, and direct `system.execApprovals.*` node commands are blocked through generic `node.invoke`.
- The protocol and security docs explicitly state the security model and fail-closed mutation behavior, which is important because archives show users and maintainers build custom operator clients around these RPCs.

### Bad qualities

- Approval routing remains split across core Gateway handlers, plugin approval handlers, native channel approval runtimes, plugin SDK reaction helpers, and delivery follow-up code.
- Open plugin approval reports show no-route, duplicate message, long-context, Feishu card rendering, and channel-mediated MCP approval gaps.
- Archive results show repeated confusion around `approvals.exec`, node approval defaults, route notices, shared socket tokens, and whether approval cards leak sensitive command details in group channels.
- Plugin HITL is becoming a broader external plugin/API surface, but no-route, long-context, duplicate-delivery, and channel-rendering behavior remains uneven in open archive reports.
- Channel-mediated MCP approvals, Codex app-server report-mode documentation for plugin `requireApproval`, LLM-assisted approval reasoning, and configurable approval timeouts remain expectation gaps in archive reports.

## Known gaps

### Implemented

- Exec approval request/get/list/resolve/waitDecision APIs and lifecycle events (`docs/gateway/protocol.md:465`, `src/gateway/server-methods/exec-approval.ts:90`, `src/gateway/server-methods/approval-shared.ts:223`, `src/gateway/server-methods/approval-shared.ts:374`).
- Gateway exec approval policy snapshot get/set and node-local exec approval policy relay through `exec.approvals.node.get/set` (`docs/gateway/protocol.md:468`, `src/gateway/server-methods/exec-approvals.ts:98`, `src/gateway/server-methods/exec-approvals.ts:131`).
- Plugin approval request/list/waitDecision/resolve APIs, server-generated plugin IDs, allowed-decision validation, and lifecycle events (`docs/gateway/protocol.md:470`, `src/gateway/server-methods/plugin-approval.ts:28`, `src/gateway/server-methods/plugin-approval.ts:88`, `src/gateway/server-methods/plugin-approval.ts:169`).
- Canonical node-host `systemRunPlan` requirement and binding for approval registration (`docs/gateway/protocol.md:625`, `src/gateway/server-methods/exec-approval.ts:199`, `src/gateway/server-methods/exec-approval.ts:221`, `src/gateway/server-methods/exec-approval.ts:289`).
- Rejection or neutralization of mutated command/cwd/agent/session state after approval preparation (`docs/gateway/protocol.md:626`, `src/gateway/node-invoke-system-run-approval.ts:340`, `src/gateway/node-invoke-system-run-approval.test.ts:284`).
- Node-host preparation and approved execution flow, including `system.run.prepare`, approval request with stored plan, and approved `node.invoke system.run` forwarding (`src/agents/bash-tools.exec-host-node-phases.ts:221`, `src/agents/bash-tools.exec-host-node.ts:85`, `src/agents/bash-tools.exec-host-node.ts:212`, `src/node-host/invoke.ts:442`).
- Node-host mutable file operand revalidation and fail-closed behavior for mutable/ambiguous shell payloads (`src/node-host/invoke-system-run.ts:562`, `src/node-host/invoke-system-run-plan.test.ts:686`, `src/node-host/invoke-system-run-plan.test.ts:1059`).
- Agent delivery fallback between strict deliverable routes and session-only execution (`docs/gateway/protocol.md:632`, `src/gateway/server-methods/agent.ts:1776`, `src/gateway/server-methods/agent.ts:1797`, `src/infra/outbound/best-effort-delivery.ts:42`).

### Missing

- Coverage gap: full Gateway/WebSocket/plugin/channel integration proof for plugin approvals.
- Coverage gap: live Gateway/node proof across actual node-host services for `systemRunPlan` mutation rejection and mutable operand revalidation.
- Coverage gap: multi-channel native approval proof for private/group approval routing.
- Coverage gap: server-flow proof for agent delivery fallback when approval follow-up routes are unavailable.
- Complete closure of plugin approval no-route, duplicate delivery, long approval context, and Feishu card rendering reports.
- First-class channel-mediated approval for MCP/tool-call consent is still open.
- Documentation for Codex app-server report-mode handling of plugin `requireApproval` remains open.
- Delivery fallback edge cases around cron/heartbeat/per-agent identity are not fully closed.

### User-maintainer feature requests

- #74003: fix plugin approval no-route behavior when `turnSourceChannel` is not passed.
- #75749: prevent duplicate Telegram plugin approval messages when `turnSourceChannel` is null.
- #81901: support long-form plugin approval context.
- #86777: document Codex app-server report-mode handling of plugin `requireApproval`.
- #79824: make Feishu card V2 approval cards render/action correctly.
- #78308: add channel-mediated approval for MCP tool calls / consent envelopes.
- #79157: add LLM-assisted exec approval or policy reasoning.
- #19919: configurable exec approval timeout.
- #84297: preserve per-agent identity overlay for cron announce/heartbeat Slack pushes.

## Evidence

### Docs

- `docs/gateway/protocol.md:465` lists exec approval request/get/list/resolve APIs.
- `docs/gateway/protocol.md:467` lists `exec.approval.waitDecision`.
- `docs/gateway/protocol.md:468` lists gateway exec approval policy snapshots.
- `docs/gateway/protocol.md:469` lists node-local exec approval policy relay APIs.
- `docs/gateway/protocol.md:470` lists plugin approval request/list/waitDecision/resolve APIs.
- `docs/gateway/protocol.md:503` documents exec approval lifecycle events.
- `docs/gateway/protocol.md:505` documents plugin approval lifecycle events.
- `docs/gateway/protocol.md:621` documents exec approval behavior.
- `docs/gateway/protocol.md:625` documents required `systemRunPlan` for `host=node`.
- `docs/gateway/protocol.md:626` documents canonical post-approval forwarding.
- `docs/gateway/protocol.md:628` documents caller mutation rejection.
- `docs/gateway/protocol.md:632` documents agent delivery fallback.
- `docs/gateway/security/index.md:170` documents Gateway/node trust.
- `docs/gateway/security/index.md:180` states `sessionKey` is routing/context, not auth.
- `docs/gateway/security/index.md:181` defines exec approvals as operator intent guardrails.
- `docs/gateway/security/index.md:183` documents exact request-context binding limits.
- `docs/gateway/security/index.md:498` documents node pairing versus per-command approval.
- `docs/gateway/security/index.md:502` documents node-local exec approvals.
- `docs/gateway/security/index.md:505` documents canonical `systemRunPlan` storage and caller-edit rejection.

### Source

- `src/gateway/methods/core-descriptors.ts:51` maps approval methods to scopes.
- `src/gateway/server-aux-handlers.ts:268` installs lazy exec/plugin approval handlers.
- `src/gateway/server-methods/exec-approval.ts:90` creates exec approval get/list/request handlers.
- `src/gateway/server-methods/exec-approval.ts:153` handles `exec.approval.request`.
- `src/gateway/server-methods/exec-approval.ts:199` resolves canonical request context from `systemRunPlan`.
- `src/gateway/server-methods/exec-approval.ts:221` requires `systemRunPlan` for `host=node`.
- `src/gateway/server-methods/exec-approval.ts:289` builds system run approval binding.
- `src/gateway/server-methods/exec-approval.ts:307` stores approval request payload fields.
- `src/gateway/server-methods/exec-approval.ts:339` registers pending approvals before responding.
- `src/gateway/server-methods/exec-approvals.ts:98` implements gateway exec approval policy get/set.
- `src/gateway/server-methods/exec-approvals.ts:131` implements node-local exec approval policy relay.
- `src/gateway/server-methods/plugin-approval.ts:28` creates plugin approval handlers.
- `src/gateway/server-methods/plugin-approval.ts:48` handles `plugin.approval.request`.
- `src/gateway/server-methods/plugin-approval.ts:88` builds plugin approval payload.
- `src/gateway/server-methods/plugin-approval.ts:110` server-generates `plugin:` approval IDs.
- `src/gateway/server-methods/plugin-approval.ts:137` broadcasts plugin approval requests.
- `src/gateway/server-methods/plugin-approval.ts:160` implements plugin `waitDecision`.
- `src/gateway/server-methods/plugin-approval.ts:169` implements plugin approval resolution.
- `src/gateway/node-invoke-sanitize.ts:5` routes `system.run` node.invoke params through the approval sanitizer.
- `src/gateway/server-methods/nodes.ts:1072` blocks direct `system.execApprovals.*` use through generic `node.invoke`.
- `src/gateway/server-methods/nodes.ts:1201` sanitizes node.invoke params before forwarding.
- `src/gateway/node-invoke-system-run-approval.ts:214` documents the node.invoke approval bypass guard.
- `src/gateway/node-invoke-system-run-approval.ts:257` requires runId and approval manager.
- `src/gateway/node-invoke-system-run-approval.ts:291` binds approval to the target node.
- `src/gateway/node-invoke-system-run-approval.ts:315` binds approval to device/client context.
- `src/gateway/node-invoke-system-run-approval.ts:340` resolves runtime context from stored `systemRunPlan`.
- `src/gateway/node-invoke-system-run-approval.ts:380` evaluates approval binding match.
- `src/gateway/node-invoke-system-run-approval.ts:394` consumes allow-once decisions.
- `src/gateway/server-methods/agent.ts:1702` resolves delivery plan state.
- `src/gateway/server-methods/agent.ts:1735` handles internal channel selection fallback.
- `src/gateway/server-methods/agent.ts:1776` keeps strict target errors when best effort is off.
- `src/gateway/server-methods/agent.ts:1797` downgrades internal delivery to session-only when best effort is on.
- `src/infra/outbound/best-effort-delivery.ts:42` defines session-only downgrade eligibility.
- `src/agents/bash-tools.exec-host-node.ts:85` registers node-host exec approval with `systemRunPlan`.
- `src/agents/bash-tools.exec-host-node.ts:212` invokes node `system.run` after approval.
- `src/node-host/invoke.ts:442` handles `system.run.prepare`.
- `src/node-host/invoke-system-run.ts:287` validates incoming `systemRunPlan`.
- `src/node-host/invoke-system-run.ts:562` revalidates mutable file operands.

### Integration tests

- `src/gateway/operator-approvals-client.e2e.test.ts:83` starts a real Gateway server and connects admin/requester clients for approval resolution.
- `src/gateway/operator-approvals-client.e2e.test.ts:139` proves remote loopback config cannot resolve local-source approval.
- `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:63` proves OpenClaw-style gateway exec tool requests and waits for approval over separate connections.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:409` proves malformed/forbidden node.invoke payloads are rejected before forwarding.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:503` proves approvals bind to decision/device and block cross-device replay.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:581` proves no-device backend approvals bridge only for the same turn source.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:681` proves cross-node replay is blocked.
- `src/gateway/server.agent.gateway-server-agent-a.test.ts:516` proves strict delivery fails when no last channel exists.
- `src/gateway/server.agent.gateway-server-agent-a.test.ts:579` proves last-channel routing defaults `bestEffortDeliver` true for active chat runs.

### Unit tests

- `src/gateway/server-methods/plugin-approval.test.ts:151` verifies handlers for all plugin approval methods.
- `src/gateway/server-methods/plugin-approval.test.ts:172` verifies two-phase plugin approval request registration and broadcast.
- `src/gateway/server-methods/plugin-approval.test.ts:218` verifies no-route plugin approvals expire immediately with null decision.
- `src/gateway/server-methods/plugin-approval.test.ts:345` verifies server-generated plugin approval IDs and rejects plugin-provided IDs.
- `src/gateway/server-methods/plugin-approval.test.ts:399` verifies allowed decision scoping.
- `src/gateway/node-invoke-system-run-approval.test.ts:248` verifies commandArgv identity enforcement.
- `src/gateway/node-invoke-system-run-approval.test.ts:284` verifies `systemRunPlan` controls forwarded command/cwd/agent/session context and ignores caller tampering.
- `src/gateway/node-invoke-system-run-approval.test.ts:341` verifies env binding absence rejects overrides.
- `src/gateway/node-invoke-system-run-approval.test.ts:359` verifies env hash mismatch rejection.
- `src/gateway/node-invoke-system-run-approval.test.ts:385` verifies allow-once consumption and replay blocking.
- `src/gateway/node-invoke-system-run-approval.test.ts:443` verifies node/device mismatch rejection.
- `src/gateway/node-invoke-system-run-approval.test.ts:585` verifies trusted backend chat replay stripping and same-context behavior.
- `src/gateway/node-invoke-system-run-approval.test.ts:738` verifies backend replay rejection on session/agent/channel target changes.
- `src/node-host/invoke-system-run-plan.test.ts:686` verifies fail-closed behavior for mutable/ambiguous shell payloads.
- `src/node-host/invoke-system-run-plan.test.ts:1059` verifies mutable file operand revalidation fails after script mutation.
- `src/agents/bash-tools.exec.approval-id.test.ts:500` verifies node allowlist satisfied skips `exec.approval.request`.
- `src/agents/bash-tools.exec.approval-id.test.ts:980` verifies exec approval follow-up uses `bestEffortDeliver`.
- `src/agents/bash-tools.exec.approval-id.test.ts:1528` verifies cron inline node approval sends approved `systemRunPlan` and runId.

### Gitcrawl queries

- `gitcrawl search issues '"exec approval" OR "exec approvals" OR "exec.approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues '"plugin approval" OR "plugin approvals" OR "plugin.approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues '"systemRunPlan" OR "system.run.prepare" OR "system.run" "approval"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues '"bestEffortDeliver" OR "session-only" OR "delivery fallback" OR "deliverable route"' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues 'node exec approval system.run node.invoke approval bypass' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues 'node.invoke system.run approval runId approved approvalDecision' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues 'agent delivery best effort session only deliver fallback' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
- `gitcrawl search issues 'approval route no approval route turnSourceChannel approvals plugin exec' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`

### Discrawl queries

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "exec approval"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "plugin approval"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "systemRunPlan"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "bestEffortDeliver"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "no approval route"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "node.invoke approval"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "delivery fallback"`
