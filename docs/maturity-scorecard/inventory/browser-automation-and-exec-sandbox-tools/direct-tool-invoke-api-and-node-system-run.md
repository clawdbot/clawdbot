---
title: "Browser automation and exec/sandbox tools - Direct Tool Invoke API and Node System.run Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Direct Tool Invoke API and Node System.run Maturity Note

## Summary

Direct tool invoke API and node `system.run` is Stable on Coverage and Beta on
Quality. The HTTP and RPC direct-invoke path is documented, auth-scoped, policy
filtered, hook-aware, and covered by tests. Node `system.run` has explicit
pairing/admin requirements, node-local approval policy, approval plan binding,
and drift rejection. Quality remains Beta because the endpoint is intentionally
full operator access, the hard-deny list is security-critical, and node
`system.run` is remote command execution on a paired machine.

## Category Scope

This note covers HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request
body and auth semantics, shared-secret operator scope restoration, policy
filtering, before-tool-call hooks, HTTP deny list, response shapes, node pairing
scopes, node command relay, `system.run`, `system.run.prepare`, `system.which`,
approval plan binding, and node-host exec policy.

## Features

- Direct Tool Invoke API: Covers Direct Tool Invoke API across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Node System.run: Covers Node System.run across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - Docs cover `/tools/invoke` auth, request shape, policy/routing behavior,
    security boundary, hard deny list, response shape, and customization.
  - Protocol docs cover `tools.invoke`, node scopes, node pairing approvals, and
    exec approval binding for `system.run`.
  - Source shares direct HTTP/RPC invocation through `invokeGatewayTool`, applies
    Gateway-scoped tool resolution, runs before-tool-call hooks, and maps errors.
  - Tests cover HTTP auth, policy denial, hard deny entries, plugin tool fallback,
    RPC envelope, approval-needed payloads, node approval binding, and node-host
    system.run policy.
- Negative signals:
  - `/tools/invoke` is intentionally not a narrow per-user delegated auth model.
  - Node `system.run` approval and allowlist drift have current issue/PR history.
- Integration gaps:
  - Add a direct-invoke smoke that proves each default hard-deny tool stays
    denied while a low-risk plugin/core tool remains callable.
  - Add a node-host integration lane that proves approval plan binding rejects
    command, cwd, agent, and session drift after approval.

## Quality Score

- Score: `Beta (79%)`
- Gitcrawl reports:
  - `tools invoke system.run approval node invoke` returned issue #77096 on
    symlink cwd trust, PR #80532 for `allowSymlinkPath`, PR #81827 for
    `tools.exec.denyPathPatterns`, PR #78226 for node allowlist writeback
    restoring revoked exec approvals, PR #85543 for node shell fallback, PR
    #70543 for normalized auto mode, and PR #81488 for node exec approval env
    hardening.
- Discrawl reports:
  - `tools invoke system run` returned 2026-04-27 guidance recommending
    `/tools/invoke` for n8n fanout to multiple Feishu threads, plus archive
    comments saying direct `nodes invoke system.run` is superseded by
    `exec host=node` and that `system.run`/`exec` output/approval behavior is
    security-sensitive.
- Good qualities:
  - HTTP direct invoke uses Gateway auth and rate-limit path, and shared-secret
    auth restores full operator defaults intentionally.
  - HTTP hard deny defaults block exec, shell, file mutation, session spawning,
    session send, cron, gateway, and node relay.
  - RPC `tools.invoke` returns a typed envelope rather than throwing through
    policy/approval refusals.
  - Node pairing requires admin for system.run/system.which requests.
  - Approved node `system.run` forwards only allowed fields and revalidates
    approval plan details.
- Bad qualities:
  - A valid Gateway bearer credential is owner/operator access for this endpoint.
  - The hard-deny list is a critical control; custom `gateway.tools.allow` can
    intentionally remove entries.
  - Node execution depends on paired-device trust plus node-local approval
    policy, making drift and writeback bugs high impact.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Direct Tool Invoke API, Node System.run.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Direct tool invocation should remain documented as operator-only unless
  OpenClaw adds a narrower delegated auth model.
- Node `system.run` approval binding and node-local allowlist state should stay
  under active security audit.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/tools-invoke-http-api.md:9`: docs state `/tools/invoke` is always enabled and uses Gateway auth plus tool policy.
- `/Users/kevinlin/code/openclaw/docs/gateway/tools-invoke-http-api.md:43`: docs identify the endpoint as full operator-access surface.
- `/Users/kevinlin/code/openclaw/docs/gateway/tools-invoke-http-api.md:89`: docs describe policy and routing behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/tools-invoke-http-api.md:101`: docs state exec approvals are not a separate authorization boundary for direct HTTP invoke.
- `/Users/kevinlin/code/openclaw/docs/gateway/tools-invoke-http-api.md:107`: docs list default hard-deny tools, including exec, shell, file mutation, sessions, cron, gateway, and nodes.
- `/Users/kevinlin/code/openclaw/docs/gateway/operator-scopes.md:99`: node pairing approval derives extra required scopes from command list.
- `/Users/kevinlin/code/openclaw/docs/gateway/operator-scopes.md:104`: `system.run`, `system.run.prepare`, and `system.which` require pairing plus admin.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md:573`: `tools.invoke` invokes one available tool through the same policy path as `/tools/invoke`.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md:627`: exec approvals for node use canonical `systemRunPlan` and reject mutation after approval.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.ts:17`: HTTP handler routes `/tools/invoke`.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.ts:45`: comments document shared-secret full operator trust model.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.ts:63`: body parsing enforces max body size.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.ts:77`: HTTP direct invoke calls shared `invokeGatewayTool`.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/tools-invoke.ts:32`: RPC `tools.invoke` handler validates params and calls the shared invocation path.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-shared.ts:146`: shared invocation resolves tool name, args, session, policy-scoped tools, hooks, and error mapping.
- `/Users/kevinlin/code/openclaw/src/gateway/tool-resolution.ts:105`: HTTP direct invoke applies default Gateway HTTP hard deny list.
- `/Users/kevinlin/code/openclaw/src/security/dangerous-tools.ts:9`: default HTTP deny list includes exec, shell, file mutation, session orchestration, cron, gateway, and nodes.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts:190`: node `system.run` forwarding uses an allowlist of supported fields.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts:214`: approval override fields are accepted only with a real approval record.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.ts:212`: node-host sends denied exec events and results on policy failure.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:440`: HTTP direct invoke test suite exercises real HTTP behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts:1`: operator approval e2e coverage exists.
- `/Users/kevinlin/code/openclaw/src/gateway/server.node-invoke-approval-bypass.test.ts:1`: node invoke approval bypass regression coverage exists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:610`: verifies denied/profile-blocked tools return 404.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:638`: verifies HTTP denies `sessions_spawn` even when agent policy allows it.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:853`: verifies shared-secret bearer auth is full operator access on `/tools/invoke`.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:924`: verifies HTTP deny list extends to high-risk execution and file tools.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:966`: verifies RPC `tools.invoke` envelope.
- `/Users/kevinlin/code/openclaw/src/gateway/tools-invoke-http.test.ts:996`: verifies typed approval-needed refusal when the policy hook blocks.
- `/Users/kevinlin/code/openclaw/src/gateway/system-run-approval-binding.test.ts:1`: system.run approval binding tests exist.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.test.ts:1`: node invoke system.run approval tests exist.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.test.ts:1`: node-host system.run tests exist.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "tools invoke system.run approval node invoke" --json`

Results:

- Open issue #77096: opt-in symlink cwd for approval-bound `system.run`.
- Open PR #80532: add `allowSymlinkPath` config.
- Open PR #81827: add `tools.exec.denyPathPatterns`.
- Open PR #78226: node allowlist writeback can restore revoked exec approvals.
- Open PR #85543: retry node shell fallback on ENOENT.
- Open PR #70543: add normalized auto mode.
- Open PR #81488: harden node exec approval precheck env.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "tools invoke system run"`

Results:

- 2026-04-27 support archive recommends `/tools/invoke` for n8n fanout after
  analysis-only webhook runs.
- 2026-04-25 OpenClaw archive comments state direct `nodes invoke system.run`
  paths were superseded by `exec host=node` and that node shell execution routes
  through approval-aware exec.
