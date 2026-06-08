---
version: 3
---

# Roles and Permissions

## Summary

- Feature family: Roles and permissions.
- Slug: roles-scopes-and-operator-policy.
- Coverage: 85/100, Yes.
- Quality: 62/100, Medium.
- Bottom line: the protocol and server authorization path cover the central role/scope model, including operator/node role negotiation, core operator scopes, pairing approvals, node-declared command claims, and server-side allowlists. Coverage is limited by missing real server proof for broadcast event scoping and fail-closed unknown event families. Quality remains Medium because of recurring scope-repair and approval-deadlock reports, open operator-scope regressions, and operational confusion around scope grants.

## Features

- Role negotiation: `operator` versus `node` role negotiation.
- Operator permissions: Core operator scopes such as `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`, `operator.pairing`, and `operator.talk.secrets`.
- Approval-gated actions: Extra approval-time scope requirements for pairing and dangerous node commands.
- Untrusted node declarations: Node-declared `caps`, `commands`, and `permissions` as claims rather than trusted truth.
- Event scoping: Broadcast event scoping, including fail-closed behavior for unknown event families.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 85/100.

Label: Yes.

Positive signals:

- Protocol docs define the WebSocket role/scope handshake and expose role/scope echo in `hello-ok` (`docs/gateway/protocol.md:10`, `docs/gateway/protocol.md:55`, `docs/gateway/protocol.md:87`).
- Protocol docs specify operator/node roles, common operator scopes, method-scope examples, node pairing approval layering, and node-declared caps/commands/permissions as untrusted claims enforced by Gateway allowlists (`docs/gateway/protocol.md:223`, `docs/gateway/protocol.md:245`, `docs/gateway/protocol.md:263`).
- Operator scope docs state the local trusted-domain threat model, role requirements, exact/admin fallback for future scopes, pairing approval semantics, and shared-token identity behavior (`docs/gateway/operator-scopes.md:10`, `docs/gateway/operator-scopes.md:19`, `docs/gateway/operator-scopes.md:31`, `docs/gateway/operator-scopes.md:93`, `docs/gateway/operator-scopes.md:110`).
- Source centralizes known scopes and method policy through `src/gateway/operator-scopes.ts:1`, `src/gateway/method-scopes.ts:31`, `src/gateway/method-scopes.ts:132`, `src/gateway/method-scopes.ts:147`, and `src/gateway/methods/core-descriptors.ts:18`.
- Real Gateway/server tests cover role enforcement, node command allowlist behavior, pending node request filtering, approval-time command exposure, bounded QR/setup-code operator tokens, and scope omission on shared-token auth (`src/gateway/server.roles-allowlist-update.test.ts:231`, `src/gateway/server.roles-allowlist-update.test.ts:339`, `src/gateway/server.roles-allowlist-update.test.ts:518`, `src/gateway/server.auth.control-ui.suite.ts:1060`, `src/gateway/server.auth.default-token.suite.ts:235`).
- Broadcast event scope enforcement is implemented and unit-tested for approval/pairing events, chat-class read gating, plugin write/admin gating, unknown-event fail-closed behavior, and contiguous per-client sequence after filtering (`src/gateway/server-broadcast.ts:21`, `src/gateway/server-broadcast.ts:62`, `src/gateway/gateway-misc.test.ts:356`, `src/gateway/gateway-misc.test.ts:405`, `src/gateway/gateway-misc.test.ts:437`, `src/gateway/gateway-misc.test.ts:461`, `src/gateway/gateway-misc.test.ts:534`).

Negative signals:

- The scope model has repeated historical breakage around `operator.admin`, `operator.talk.secrets`, low-scope repair, and device/node approval flows. Closed reports include #56390, #76349, #77195, #79775, and #84144.
- Open gitcrawl reports still describe operator-scope regressions or deadlocks: #74484, #77807, and #85966.
- Discord archive evidence shows maintainers and users repeatedly needed clarification or workarounds for scope grants, CLI approval identity, Docker pairing, and Talk secret scope bootstrap.
- Broadcast scoping has good unit evidence, but no located integration/e2e/live Gateway or server-flow test for unknown event families or plugin event filtering across actual WebSocket clients.

Integration gaps:

- Add a real Gateway/WebSocket broadcast test that proves unknown event families fail closed, scoped clients do not receive filtered events, and per-client sequence remains contiguous in the actual server send path.
- Add a recovery-path integration test for a low-scope paired operator token that cannot approve/reject a broader scope repair request, matching open #74484.
- Add an internal Gateway client or session-spawn integration test for `operator.write` propagation, matching open #77807.
- Add mobile/operator or trusted-proxy WebSocket regression proof for role/scope handling after node pairing, matching open #85966.

## Quality

Score: 62/100.

Label: Medium.

### Gitcrawl reports

- Query: `gitcrawl search issues "AUTH_SCOPE_MISMATCH" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- Query: `gitcrawl search issues "node.pair.approve operator.pairing" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: #85966 open, "Android UI/operator WebSocket closes silently after node pair approval"; #62765 open, Teams pairing/dmPolicy report with related unpaired-sender behavior.
- Query: `gitcrawl search issues "broadcast scoping unknown event families" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- Query: `gitcrawl search issues "operator.talk.secrets" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- Query: `gitcrawl search issues "missing scope operator.admin devices approve" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: #74484 open, "Gateway pairing scope deadlock: CLI cannot approve/reject auto-reissued over-scoped repair requests"; #77807 open, "`sessions_spawn` fails with missing scope `operator.write` despite full-scope operator token".
- Query: `gitcrawl search issues "device approve missing scope operator.talk.secrets" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #56390 closed, "CLI cannot approve device pairing: missing `operator.talk.secrets` scope"; #77195 closed, "[2026.5.2 Regression] CLI device lacks operator.admin, creating approval deadlock"; #52749 closed, "cli can't connect to gateway".
- Query: `gitcrawl search issues "device approve missing scope operator.admin" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: sixteen hits, including #76349, #77195, #79775, #56173, #55995, #76956, #84144, #21593, #50514, and #46689.
- Query: `gitcrawl search issues "browser.request operator.admin scope upgrade" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #50640 closed for silent auto-approval of scope-upgrade pairing requests; #76956 closed and #79775 closed for device approval scope failures; #80589 closed for trusted-proxy `operator.read`; #78508 closed for missing `operator.read` chat history.
- Query: `gitcrawl search issues "operator scope mismatch gateway" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: twenty hits, including #79292 closed for silent operator scope mismatch rejection, #52085 closed for TUI/gateway-client missing `operator.read`, #17523 closed for authentication loops and scope validation failures, #85966 open, and #78727 closed for scope-upgrade request loops.
- Query: `gitcrawl search issues "node pairing operator.pairing operator.admin" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: twenty hits, including #21470, #55995/#56173, #56390, #65542, #72006, #77195, #79775, and #84144.
- Query: `gitcrawl search issues "broadcast scoping operator.read" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #57756 closed, "session-key-based session access is not scoped to the calling operator client/device".
- Query: `gitcrawl threads openclaw/openclaw --numbers 74484,77807,85966 --include-closed --json`
  Result: #74484 remains open for a low-scope repair approval deadlock; #77807 remains open for missing `operator.write` in `sessions_spawn`; #85966 remains open for Android UI/operator WebSocket close after node pairing and asks whether `operator.pairing` should be auto-granted.
- Query: `gitcrawl threads openclaw/openclaw --numbers 56390,76349,77195,79775,84144 --include-closed --json`
  Result: all five are closed but document prior regressions in default CLI scopes, device ownership/admin approval, and node approval scope requirements.

### Discrawl reports

- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "operator scopes gateway"`
  Result: maintainer-security-ops and clawtributors results around Gateway backend loopback auth and scoped shared-secret behavior; PR #81563 on `browser.request` requiring `operator.admin`; a May 3 maintainer note that `docs/gateway/operator-scopes.md` was written because of confusion; user support reports for `devices approve` missing `operator.admin` and Docker CLI pairing limits.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "node.pair.approve operator.pairing"`
  Result: PR #60461 requiring `operator.pairing` for node approvals; review discussion around pairing/write/admin scope alignment; maintainer-security-ops notes on device token rotation.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "operator.talk.secrets"`
  Result: mobile/Talk support and PR #85690 references restoring `operator.talk.secrets` to QR bootstrap for iOS/Android; user-facing guidance to include `operator.talk.secrets` in pairing config; closed issue #60076 on CLI device approval missing that scope.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "broadcast scoping operator.read"`
  Result: no results.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "AUTH_SCOPE_MISMATCH"`
  Result: support threads for Control UI, browser profiles, VPS cron jobs, UmbrelOS, and Tailscale setup with missing-scope or scope-mismatch symptoms.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "missing scope operator.admin devices approve"`
  Result: May 2 user report that `devices approve` failed despite visible `operator.admin`; Docker CLI approval failure; related closed issue #60076 and support threads for `operator.admin`/`operator.read`.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "operator.pairing operator.admin"`
  Result: user/maintainer discussion of broad dashboard scopes, scope-upgrade logs, and Docker CLI pairing failures.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "operator scopes confusion"`
  Result: maintainer note that the operator-scopes doc was created because of confusion; release-relevant scope-cache concerns; Android explanation distinguishing requested permissions from granted Gateway scopes.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "broadcast scoping unknown future event"`
  Result: no results.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "node commands claims allowlist"`
  Result: macOS node exec/automation discussion that `gateway.nodes.allowCommands`, node-declared commands, and exec approvals must all align; allowCommands alone does not make a command supported.

### Good qualities

- Authorization is split into small, named policy modules instead of being scattered across handlers: known scope definitions, method scope lookup, reserved-prefix handling, role policy, and broadcast scope guards are separate files.
- The server defaults to deny unclassified methods for non-admin operators and treats unknown future event families as not deliverable unless an explicit rule allows them (`src/gateway/method-scopes.ts:132`, `src/gateway/server-broadcast.ts:62`).
- Core role/scope semantics are represented consistently across protocol docs, operator-scope docs, default CLI scopes, method descriptors, and runtime authorization policy (`docs/gateway/protocol.md:223`, `docs/gateway/operator-scopes.md:31`, `src/gateway/operator-scopes.ts:1`, `src/gateway/method-scopes.ts:31`, `src/gateway/methods/core-descriptors.ts:18`).
- Pairing approval policy passes caller scopes through device and node approval paths, including command-derived node scope requirements (`src/gateway/server-methods/devices.ts:209`, `src/gateway/server-methods/nodes.ts:742`, `docs/gateway/operator-scopes.md:63`, `docs/gateway/operator-scopes.md:93`).
- QR/setup-code bootstrap deliberately grants a bounded first-run operator token and excludes admin/pairing scope, which keeps the first-run UI handoff narrower than a full operator credential (`docs/gateway/protocol.md:150`, `src/gateway/server/ws-connection/message-handler.ts:1168`).
- Node-declared caps/commands/permissions are reconciled through server-side policy and pending approval state before becoming effective live node surface (`src/gateway/server/ws-connection/message-handler.ts:1545`, `src/gateway/server-methods/nodes.ts:772`).
- Protocol and security docs now explain that scopes are local guardrails for a trusted operator domain, not hostile multi-tenant authorization (`docs/gateway/operator-scopes.md:10`, `docs/gateway/security/index.md:8`, `docs/gateway/security/index.md:128`).

### Bad qualities

- Open reports show the model still creates recovery deadlocks when an existing paired operator identity has fewer scopes than a repair or upgrade request needs.
- There is visible historical churn in default CLI/token scopes, especially `operator.admin`, `operator.read`, `operator.write`, and `operator.talk.secrets`.
- Mobile/trusted-proxy and internal Gateway client flows still have open or recently closed scope propagation issues.
- Scope diagnostics are split across error codes, connection close behavior, pairing UX, and docs; archive support history shows the model remains hard for users and maintainers to reason about.

## Known gaps

- #74484 requests a downgrade/minimal repair or bootstrap path so the CLI can escape a low-scope repair deadlock without manual identity deletion.
- #77807 requests reliable scope propagation for internal `sessions_spawn`/Gateway client paths when a full-scope operator token is available.
- #85966 requests Android UI/operator WebSocket behavior that does not silently close after node pair approval and clarifies whether `operator.pairing` should be part of Android's granted operator scope set.
- Discord support threads request clearer operational guidance for Docker/CLI pairing, device approval with `operator.admin`, and Talk clients needing `operator.talk.secrets`.
- Coverage gap: broadcast scoping lacks located real Gateway/WebSocket server-flow proof for unknown events and plugin event families.

## Evidence

### Docs

- `docs/gateway/protocol.md:10` says Gateway WebSocket is both control plane and node transport, with clients declaring role and scope at handshake.
- `docs/gateway/protocol.md:55` shows the connect params carrying `role`, `scopes`, `caps`, `commands`, and `permissions`.
- `docs/gateway/protocol.md:87` shows `hello-ok` returning authenticated role/scopes.
- `docs/gateway/protocol.md:150` documents QR/setup-code bootstrap and bounded first-run operator token scopes.
- `docs/gateway/protocol.md:223` defines roles and common scopes.
- `docs/gateway/protocol.md:245` documents method-level and command-level scope checks.
- `docs/gateway/protocol.md:263` documents node-declared capabilities as claims, not trusted truth.
- `docs/gateway/protocol.md:314` documents broadcast event scoping and fail-closed unknown families.
- `docs/gateway/operator-scopes.md:10` defines the trusted local-operator security boundary.
- `docs/gateway/operator-scopes.md:31` lists scope semantics and unknown future scope behavior.
- `docs/gateway/operator-scopes.md:45` explains method scope as the first authorization gate.
- `docs/gateway/operator-scopes.md:93` documents node pairing approval and command-derived extra scopes.
- `docs/gateway/security/index.md:166` summarizes operator scope guardrails and the trusted Gateway/node model.
- `docs/gateway/security/index.md:201` documents common findings that are intentionally not treated as vulnerabilities.

### Source

- `src/gateway/operator-scopes.ts:1` defines known operator scopes.
- `src/gateway/method-scopes.ts:31` defines default CLI operator scopes.
- `src/gateway/method-scopes.ts:132` defaults unclassified methods to deny for non-admin operators.
- `src/gateway/method-scopes.ts:147` authorizes method calls against operator scopes.
- `src/gateway/methods/core-descriptors.ts:18` maps core Gateway methods to roles/scopes.
- `src/shared/gateway-method-policy.ts:1` reserves admin prefixes and normalizes plugin method scopes.
- `src/gateway/role-policy.ts:3` parses and authorizes roles.
- `src/gateway/server-methods.ts:215` applies role and scope authorization before dispatch.
- `src/gateway/server-methods.ts:592` applies request handling, startup availability checks, method lookup, and plugin runtime scope policy.
- `src/gateway/server/ws-connection/message-handler.ts:645` parses handshake role/scope state.
- `src/gateway/server/ws-connection/message-handler.ts:781` clears unbound scopes when shared-token auth has no device identity.
- `src/gateway/server/ws-connection/message-handler.ts:1095` checks pairing state access with role and scope.
- `src/gateway/server/ws-connection/message-handler.ts:1168` documents bounded setup-code operator token behavior.
- `src/gateway/server/ws-connection/message-handler.ts:1388` validates paired role/scope upgrades.
- `src/gateway/server/ws-connection/message-handler.ts:1545` reconciles node caps/commands/permissions claims into effective allowed surface.
- `src/gateway/server-broadcast.ts:21` defines event-scope guards.
- `src/gateway/server-broadcast.ts:62` implements event-scope authorization and unknown-event fail-closed behavior.
- `src/gateway/server-methods/nodes.ts:742` applies caller scopes during node pair approval.
- `src/gateway/server-methods/devices.ts:209` applies caller role/scope checks during device pair approval.

### Integration tests

- `src/gateway/server.roles-allowlist-update.test.ts:89` installs the connected Control UI server suite.
- `src/gateway/server.roles-allowlist-update.test.ts:231` proves Gateway role enforcement over WebSocket.
- `src/gateway/server.roles-allowlist-update.test.ts:339` proves node command allowlist behavior through node invocation/result flow.
- `src/gateway/server.roles-allowlist-update.test.ts:479` proves allowlisted declared commands are hidden before node pairing approval.
- `src/gateway/server.roles-allowlist-update.test.ts:518` proves live commands refresh after pending node pairing approval.
- `src/gateway/server.roles-allowlist-update.test.ts:587` proves current allowlists are rechecked before exposing approved live commands.
- `src/gateway/server.roles-allowlist-update.test.ts:654` proves only allowlisted commands are recorded in pending node requests.
- `src/gateway/server.node-pairing-authz.test.ts:234` proves node approval rejects missing command-derived `operator.admin` and missing `operator.pairing` through server RPC.
- `src/gateway/server.node-pairing-authz.test.ts:315` proves paired reconnects request re-pairing when upgraded commands appear.
- `src/gateway/server.auth.control-ui.suite.ts:906` proves loopback Control UI scope upgrades require approval.
- `src/gateway/server.auth.control-ui.suite.ts:1060` proves QR/setup-code bounded operator handoff includes approvals/read/talk.secrets/write and excludes admin/pairing.
- `src/gateway/server.auth.control-ui.suite.ts:1190` proves issued bounded operator token rejects admin/pairing requests.
- `src/gateway/server.auth.default-token.suite.ts:235` proves health remains available but admin status is restricted when scopes are empty.
- `src/gateway/server.auth.default-token.suite.ts:246` proves `hello-ok` clears scopes for device-less shared token auth.
- `src/gateway/server.auth.default-token.suite.ts:268` proves `hello-ok` reports persisted token scopes when reusing a device token.

### Unit tests

- `src/gateway/gateway-misc.test.ts:356` tests approval/pairing broadcast filtering and targeted broadcasts by scope.
- `src/gateway/gateway-misc.test.ts:405` tests read scope for chat-class events.
- `src/gateway/gateway-misc.test.ts:437` tests plugin broadcast events are limited to write/admin.
- `src/gateway/gateway-misc.test.ts:461` tests unknown events deny and Gateway events are classified.
- `src/gateway/gateway-misc.test.ts:534` tests per-receiving-client event sequence remains contiguous after filtering.
- `src/gateway/server.node-pairing-authz.test.ts:157` tests command-derived required scopes in direct node pairing approval helpers.

### Gitcrawl queries

- `gitcrawl doctor --json`
  Result: `last_sync_at=2026-05-28T05:29:12.208862Z`, `thread_count=87334`, `open_thread_count=7657`, `cluster_count=18605`.
- `gitcrawl search issues "AUTH_SCOPE_MISMATCH" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- `gitcrawl search issues "node.pair.approve operator.pairing" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: #85966 open; #62765 open.
- `gitcrawl search issues "broadcast scoping unknown event families" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- `gitcrawl search issues "operator.talk.secrets" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: no open issues.
- `gitcrawl search issues "missing scope operator.admin devices approve" -R openclaw/openclaw --state open --json number,title,url,state`
  Result: #74484 open; #77807 open.
- `gitcrawl search issues "device approve missing scope operator.talk.secrets" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #56390 closed; #77195 closed; #52749 closed.
- `gitcrawl search issues "device approve missing scope operator.admin" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: sixteen hits, including #76349, #77195, #79775, #56173, #55995, #76956, #84144, #21593, #50514, and #46689.
- `gitcrawl search issues "browser.request operator.admin scope upgrade" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #50640 closed, #76956 closed, #79775 closed, #80589 closed, #78508 closed, and related scope reports.
- `gitcrawl search issues "operator scope mismatch gateway" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: twenty hits, including #79292 closed, #52085 closed, #17523 closed, #85966 open, and #78727 closed.
- `gitcrawl search issues "node pairing operator.pairing operator.admin" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: twenty hits, including #21470, #55995/#56173, #56390, #65542, #72006, #77195, #79775, and #84144.
- `gitcrawl search issues "broadcast scoping operator.read" -R openclaw/openclaw --state all --json number,title,url,state`
  Result: #57756 closed.
- `gitcrawl threads openclaw/openclaw --numbers 74484,77807,85966 --include-closed --json`
  Result: #74484 open low-scope repair approval deadlock; #77807 open missing `operator.write`; #85966 open Android operator WebSocket close after node pairing.
- `gitcrawl threads openclaw/openclaw --numbers 56390,76349,77195,79775,84144 --include-closed --json`
  Result: all five closed, documenting prior scope default, approval, and node approval regressions.

### Discrawl queries

- `discrawl status --json`
  Result: `generated_at=2026-05-28T05:38:34Z`, `state=current`, `last_sync_at=2026-05-28T00:14:43Z`, `messages=1483985`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "operator scopes gateway"`
  Result: Gateway loopback/shared-secret auth, `browser.request` `operator.admin`, operator-scopes docs confusion, device approval and Docker CLI pairing reports.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "node.pair.approve operator.pairing"`
  Result: PR #60461, pairing/write/admin alignment discussions, and device token rotation notes.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "operator.talk.secrets"`
  Result: mobile/Talk bootstrap discussions, PR #85690, user guidance to include `operator.talk.secrets`, and closed issue #60076.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "broadcast scoping operator.read"`
  Result: no results.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "AUTH_SCOPE_MISMATCH"`
  Result: Control UI, browser profile, VPS cron, UmbrelOS, and Tailscale support threads with scope symptoms.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "missing scope operator.admin devices approve"`
  Result: May 2 user report, Docker CLI approval failure, issue #60076, and `operator.admin`/`operator.read` support threads.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "operator.pairing operator.admin"`
  Result: dashboard scope concerns, scope-upgrade logs, and Docker CLI pairing failures.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "operator scopes confusion"`
  Result: maintainer-created scope docs, release-relevant scope-cache concerns, and Android role/scope explanation.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "broadcast scoping unknown future event"`
  Result: no results.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "node commands claims allowlist"`
  Result: macOS node exec/automation discussions showing allowCommands, declared commands, and approvals must align.
