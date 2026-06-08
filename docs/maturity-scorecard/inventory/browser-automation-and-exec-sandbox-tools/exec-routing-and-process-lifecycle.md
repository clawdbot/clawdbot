---
title: "Browser automation and exec/sandbox tools - Tool Invocation and Execution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Tool Invocation and Execution Maturity Note

## Summary

Exec routing and process lifecycle is Stable. The surface has broad docs, source
centralization, detailed timeout/output behavior, PTY and stdin handling,
background process tracking, process follow-up actions, and host routing across
auto, sandbox, gateway, and node. Remaining risk comes from long-running command
survivability, background process state after restart/compaction, and the
inherent complexity of routing shell execution across multiple hosts.

## Category Scope

Included in this category:

- Exec Routing: Covers Exec Routing across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Process Lifecycle: Covers Process Lifecycle across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Direct Tool Invoke API: Covers Direct Tool Invoke API across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Node System.run: Covers Node System.run across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Host Exec Approvals: Covers Host Exec Approvals across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.
- Elevated Mode: Covers Elevated Mode across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.

## Features

- Exec Routing: Covers Exec Routing across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Process Lifecycle: Covers Process Lifecycle across `exec` foreground and background execution, `yieldMs`, timeouts, PTY, and related exec routing and process lifecycle behavior.
- Direct Tool Invoke API: Covers Direct Tool Invoke API across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Node System.run: Covers Node System.run across HTTP `POST /tools/invoke`, Gateway RPC `tools.invoke`, request body and auth semantics, shared-secret operator scope restoration, and related direct tool invoke api and node system.run behavior.
- Host Exec Approvals: Covers Host Exec Approvals across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.
- Elevated Mode: Covers Elevated Mode across exec approval policy, local approvals state, approval request registration and waiting, allow-once consumption, and related host exec approvals and elevated mode behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (88%)`
- Positive signals:
  - Exec docs cover host routing, sandbox fallback, node routing, PATH behavior,
    approvals, session overrides, and background process follow-up.
  - Source centralizes target resolution, env/path sanitization, process
    lifecycle, output aggregation, background registration, and failure
    classification.
  - Tests cover target resolution, PTY, background aborts, timeout guidance,
    node/gateway/sandbox host routing, path behavior, script preflight, and
    process event routing.
  - Runtime evidence includes Gateway background process documentation and
    source diagnostics emitted on exec completion.
- Negative signals:
  - Archive issues remain around finite backgrounding, orphaned process trees,
    payload leakage, and repeated relaunch instead of `process` polling.
  - The same command can behave differently depending on target host,
    sandbox availability, PTY mode, and approvals state.
- Integration gaps:
  - Add a restart/compaction process-survivability matrix for background exec.
  - Add a cross-host exec lane that runs the same command on sandbox, gateway,
    and node with explicit routing and verifies process follow-up state.

## Quality Score

- Score: `Stable (84%)`
- Gitcrawl reports:
  - `exec process background` returned issue #82178 on finite backgrounding,
    issue #65983 on orphan process trees after restart/session loss, PR #59719
    tracking background exec liveness with CLI tasks, issue #70797 on payload
    leakage, and issue #62432 on relaunching exec instead of process polling.
  - `exec process background pty timeout host auto` returned issue #75811 about
    model-controllable `security`/`elevated`/`ask` schema fields.
- Discrawl reports:
  - `exec process background` returned 2026-05-17 guidance that `exec` starts
    work and `process` tracks/polls it; cron timeout is the outer guardrail, not
    process supervision.
- Good qualities:
  - `exec` target resolution is explicit and fails closed when a requested host
    override is not allowed.
  - Host env and PATH handling are centralized, with dangerous inherited env
    variables blocked for host execution.
  - Process follow-up exposes list/poll/log/write/send-keys/submit/paste/kill/
    clear/remove and reports waiting-for-input state.
  - Failure messages direct long-running work toward registered background exec
    instead of shell-backgrounding with `&`.
- Bad qualities:
  - Background process tracking still has real-world reliability and UX edge
    cases after restart, compaction, and provider retries.
  - `exec` remains a shell surface; even with strong process tooling, user intent
    and command side effects are difficult to model.
  - Routing across sandbox/gateway/node is powerful but increases the cognitive
    load for operators and agents.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (88%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Exec Routing, Process Lifecycle, Direct Tool Invoke API, Node System.run, Host Exec Approvals, Elevated Mode.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Background process state should become more durable across Gateway restarts
  and session loss.
- Process follow-up guidance should be consistently visible to all provider
  harnesses to avoid relaunch loops.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:9`: exec is documented as a mutating shell surface with process support.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:44`: docs cover `host=auto`, sandbox, gateway, node, ask, and elevated params.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:68`: docs describe host routing behavior and fail-closed sandbox/node behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:130`: docs describe PATH handling across host, sandbox, and node.
- `/Users/kevinlin/code/openclaw/docs/gateway/background-process.md:13`: background process docs define exec params and behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/background-process.md:59`: background process docs enumerate process actions.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec.ts:71`: foreground results carry status, exit code, duration, output, timeout, and cwd details.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.ts:78`: host base env sanitization removes dangerous inherited variables.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.ts:117`: default output, pending output, and approval timeout constants are centralized.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.ts:186`: exec completion emits diagnostic events with target, mode, duration, outcome, and failure metadata.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.ts:241`: host target resolution gates requested target overrides and maps auto to sandbox or gateway.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.ts:504`: timeout/failure guidance points long-running work at registered background exec and process polling.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.process.ts:176`: process tool exposes list/poll/log/write/send-keys/submit/paste/kill/clear/remove.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.process.ts:193`: process runtime reports stdin writability, waiting-for-input state, idle time, and last output time.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.process.ts:223`: process kill falls back to process-tree termination.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-gateway-approval.e2e.test.ts:1`: e2e coverage exists for Gateway exec approval execution.
- `/Users/kevinlin/code/openclaw/src/agents/sessions/exec.test.ts:1`: session-level exec coverage exists.
- `/Users/kevinlin/code/openclaw/src/agents/sessions/bash-executor.test.ts:1`: bash executor session coverage exists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.test.ts:110`: verifies exec target resolution.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.test.ts:177`: verifies gateway/node override rejection while sandbox is active.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.test.ts:383`: verifies notify-on-exit suppression and timeout behavior for background exec.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-runtime.test.ts:611`: verifies timeout guidance and failure classification.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec.pty.test.ts:87`: PTY behavior is covered.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec.background-abort.test.ts:1`: background abort behavior is covered.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "exec process background" --json`

Results:

- Open issue #82178: finite exec backgrounding when process is hidden.
- Open issue #65983: background PTY exec can survive restart/session loss and become untracked.
- Open PR #59719: track background exec liveness with CLI tasks.
- Open issue #70797: tool-call payload leakage during background exec/process flows.
- Open issue #62432: sessions can relaunch exec after "Command still running" instead of switching to process poll.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "exec process background"`

Results:

- 2026-05-17 archive guidance distinguishes `exec` as the command starter and
  `process` as the tracking/polling handle; it recommends background/trackable
  exec with process polling for long-running work.
