---
title: "Browser automation and exec/sandbox tools - Host Exec Approvals and Elevated Mode Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Host Exec Approvals and Elevated Mode Maturity Note

## Summary

Host exec approvals and elevated mode is Stable. The implementation has a
layered approval system, two-phase approval registration, command highlighting,
safe-bin and allowlist planning, strict inline-eval handling, node approval
binding, and clear elevated-mode docs. It remains below Lovable because the
policy is intentionally complex and user/operator configuration mistakes still
create real risk.

## Category Scope

This note covers exec approval policy, local approvals state, approval request
registration and waiting, allow-once consumption, safe bins, safe builtins,
strict inline eval, interpreter planning, command spans, node `system.run`
approval plan binding, follow-up delivery, and elevated mode.

## Features

- Host Exec Approvals: Covers Host Exec Approvals across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.
- Elevated Mode: Covers Elevated Mode across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - Docs cover basic and advanced exec approvals, safe bins, allowlists, strict
    inline eval, approval forwarding, same-chat approvals, and elevated mode.
  - Source implements two-phase registration before returning pending approval,
    pending lookup, expiry, allow-once atomic consumption, and follow-up resume.
  - Tests cover approval request parsing, command spans, manager timers,
    allowlist matching, safe-bin policy, strict inline eval, approval parity,
    native approval routing, and node binding.
  - Node `system.run` path strips user control fields and revalidates approvals
    against canonical command/cwd/session plans.
- Negative signals:
  - Archive reports still show operator confusion around `security=full`,
    `ask=off`, safe bins, inline eval, and node approval routing.
  - Elevated mode intentionally bypasses sandboxing for exec and must be reasoned
    about with tool policy and approvals together.
- Integration gaps:
  - Add an operator UX smoke that walks a user from blocked command to approval,
    allow-once, allow-always, and elevated mode across gateway and node hosts.
  - Add a scorecard-specific matrix for safe bins, safe builtins, interpreters,
    shell wrappers, and strict inline eval combinations.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports:
  - `exec approval safe bins` returned PR #79363 for opt-in safe builtins, issue
    #46056 about shell builtins and approval gates, PR #71154 around allowlisted
    command parsing, PR #80922 routing allow-always through the command planner,
    and PR #84172 revamping command authorization candidates.
  - `tools invoke system.run approval node invoke` returned issue #77096 on
    symlink cwd trust, PR #81827 adding denyPathPatterns, PR #78226 on node
    allowlist writeback restoring revoked approvals, and PR #81488 hardening
    node exec approval precheck env.
- Discrawl reports:
  - `exec approvals safe bins elevated` returned a 2026-03-06 support answer
    explaining that `security="full"` plus `ask="off"` is raw shell access on
    the selected host, subject only to tool policy and stricter approvals state.
- Good qualities:
  - Approval registration is two-phase to avoid orphaned `/approve` races.
  - Approval manager keeps resolved entries briefly for waiters and consumes
    allow-once decisions atomically.
  - Host approval params include command, argv, system run plan, cwd, env,
    host, node id, security, ask, command spans, requester, and turn source.
  - Node forwarding strips approval control fields from untrusted input and only
    restores trusted approval state from Gateway approval records.
  - Elevated docs explicitly say it does not override tool policy.
- Bad qualities:
  - Safe-bin and allowlist semantics are difficult to explain because shell
    wrappers, builtins, interpreters, inline eval, stdin trust, and path trust
    all interact.
  - `security`, `ask`, elevated state, and local approval defaults can produce a
    stricter-than-expected or looser-than-expected result if operators configure
    only one layer.
  - Native approval delivery is spread across channels and can fail in ways that
    look like exec policy failure.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Host Exec Approvals, Elevated Mode.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Approval policy needs clearer diagnostics when local approvals state and
  `tools.exec.*` disagree.
- Safe-bin, strict-inline-eval, and interpreter policy should remain under
  security review.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:11`: approvals are documented as part of a guardrail stack with tool policy and elevated mode.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:18`: docs state the stricter of `tools.exec.*` and local approvals state wins.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:48`: docs describe gateway/node hosts, trust model, file binding, and drift.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:115`: docs cover security, ask, fallback, strict inline eval, command highlighting, and safe bins.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals-advanced.md:14`: docs explain safe bins as stdin-only and not generic trust.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals-advanced.md:66`: docs cover trusted dirs, shell chaining, wrappers, and strict inline eval.
- `/Users/kevinlin/code/openclaw/docs/tools/elevated.md:9`: elevated mode is documented as sandbox-to-host exec escape.
- `/Users/kevinlin/code/openclaw/docs/tools/elevated.md:103`: elevated does not override tool policy or host selection.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.ts:116`: approval request registration happens before returning `approval-pending`.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.ts:137`: waitDecision handles timeout/missing approval as null decision.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.ts:269`: host approval params include system run plan, env, cwd, host, security, ask, command spans, requester, and turn source.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-manager.ts:54`: approval manager tracks pending approval records.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-manager.ts:118`: approval resolution records decision and schedules cleanup.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-manager.ts:175`: allow-once decisions are consumed atomically.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-manager.ts:200`: approval lookup supports exact, prefix, ambiguous, and none results.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts:190`: system.run forwarding allowlists fields understood by node host.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.ts:214`: approval control fields are gated behind a real exec approval record.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.ts:106`: node system.run policy phase carries security, allowlist, safe bins, strict inline eval, and approval decisions.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:1`: e2e coverage exists for Gateway exec approvals.
- `/Users/kevinlin/code/openclaw/src/gateway/operator-approvals-client.e2e.test.ts:1`: operator approval client e2e coverage exists.
- `/Users/kevinlin/code/openclaw/src/infra/approval-native-delivery.test.ts:1`: native approval delivery coverage exists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.test.ts:94`: verifies string approval decisions are returned.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.test.ts:183`: verifies registration response id is used when waiting for a decision.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-approval-request.test.ts:276`: verifies command spans are added to host approval registration payloads.
- `/Users/kevinlin/code/openclaw/src/gateway/exec-approval-manager.test.ts:9`: verifies approval manager behavior.
- `/Users/kevinlin/code/openclaw/src/infra/exec-approvals-safe-bins.test.ts:1`: safe-bin policy tests exist.
- `/Users/kevinlin/code/openclaw/src/infra/system-run-approval-binding.test.ts:1`: system.run approval binding tests exist.
- `/Users/kevinlin/code/openclaw/src/gateway/node-invoke-system-run-approval.test.ts:1`: Gateway node system.run approval tests exist.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "exec approval safe bins" --json`

Results:

- Open PR #79363: opt-in `tools.exec.safeBuiltins`.
- Open issue #46056: shell builtins always trigger approval gate with allowlist.
- Open PR #71154: accept POSIX backslash-newline in allowlisted commands.
- Open PR #80922: route allow-always through command authorization planner.
- Open PR #84172: revamp command authorization candidates.

Query:

`gitcrawl search openclaw/openclaw --query "tools invoke system.run approval node invoke" --json`

Results:

- Open issue #77096: opt-in symlink cwd for approval-bound `system.run`.
- Open PR #81827: add `tools.exec.denyPathPatterns` hard-deny gate.
- Open PR #78226: node allowlist writeback can restore revoked exec approvals.
- Open PR #81488: harden node exec approval precheck env.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "exec approvals safe bins elevated"`

Results:

- 2026-03-06 support archive explains that `security="full"` plus `ask="off"`
  means raw shell access on gateway/node host when tool policy and local
  approvals state allow it.
