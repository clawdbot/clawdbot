---
title: "macOS companion app - Native Capabilities Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Native Capabilities Maturity Note

## Summary

The macOS app node runtime is broad: it advertises Canvas, A2UI, screen, system, notification, camera, browser, and location commands, connects to Gateway as a node, and routes `system.run` through app-owned approval policy and local IPC. Coverage is Alpha because the command/runtime path is implemented with targeted proof, but the current source still lacks `system.run.prepare` in the macOS node command list while core node-host paths expect it for prepared exec flows. Quality is Alpha due to active archive evidence around missing prepare support, node flapping, allowlist mismatches, and exec approval UX.

## Category Scope

Included in this category:

- Mac node session connection: Mac node session connection, capability and command advertisement
- system.run: system.run, system.which, system.notify, exec approvals get/set
- Exec approval policy: Exec approval policy, app exec host, local socket, and event emission
- Permission requests: Permission requests, status polling, settings UI, and node permission advertisement
- TCC persistence: TCC persistence, signing requirements, and safe app-owned permission guidance

## Features

- Mac node session connection: Mac node session connection, capability and command advertisement
- system.run: system.run, system.which, system.notify, exec approvals get/set
- Exec approval policy: Exec approval policy, app exec host, local socket, and event emission
- Permission requests: Permission requests, status polling, settings UI, and node permission advertisement
- TCC persistence: TCC persistence, signing requirements, and safe app-owned permission guidance

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: Swift tests cover command advertisement, `system.run` denial/event paths, env override rejection, `system.which`, screen/camera gating, exec approvals socket auth/path guards, and approval prompt behavior. TypeScript tests cover node-host `system.run` planning and app exec-host fallback behavior.
- Negative signals: The native command list includes `system.run` but not `system.run.prepare`, while core source has explicit `system.run.prepare` handling for prepared node exec phases. No live scenario proves a real agent invoking `system.run` through the macOS app path end to end.
- Integration gaps: Need a live app-node `system.run` scenario that exercises prepare, approval prompt, allow-once, allow-always, denial, event emission, output truncation, and failure fallback.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: Results include issue #83958 for macOS app node flapping and Gateway invokes timing out, issue #9876 requesting more context in exec approval popups, issue #44749 for allow-always last-write-wins race, and several exec approval PRs. Broader search/source inspection found open `system.run.prepare` trackers (#37591/#38781) mirrored in discrawl.
- Discrawl reports: Discord archive includes #49031 closeout saying the old missing `system.run.prepare` report was superseded but the remaining gap is tracked by #37591/#38781; it also includes #37591 comment saying current main still lacks macOS `system.run.prepare`.
- Good qualities: The implementation validates command shapes, filters risky environment overrides, stores per-agent policy, supports ask/allowlist/full modes, protects socket IPC with token/HMAC/TTL concepts, and emits exec events.
- Bad qualities: Prepared exec contract mismatch is a serious product risk. Exec approvals also have known UX/context and allowlist consistency issues, and app-node flapping can make correct policy unreachable.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Mac node session connection, system.run, Exec approval policy, Permission requests, TCC persistence.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add and prove macOS node support for `system.run.prepare` or update the core exec-host contract so the app node is not expected to implement it.
- Prove live `system.run` through a packaged signed app with approval prompt and output return.
- Improve prompt context for session/requester and reconcile allow-always concurrency behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents node capabilities, `system.run`, permission map, and exec approvals stored under `~/.openclaw/exec-approvals.json`.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/xpc.md` documents the Gateway/node/app IPC model for exec approvals and `system.run`.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/permissions.md` explains why app-owned TCC context matters for privileged work.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift` builds node caps/commands and starts the Gateway node session.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift` dispatches node invokes, including `system.run`, `system.which`, `system.notify`, and exec approvals get/set.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ExecApprovals.swift` defines local approval file, defaults, allowlist entries, socket path, and policy storage.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ExecApprovalEvaluation.swift` resolves security, ask mode, env sanitization, allowlist matches, and skill-auto-allow.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.ts` prefers the mac app exec host when configured and denies with `COMPANION_APP_UNAVAILABLE` if required but unreachable.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke.ts` and `/Users/kevinlin/code/openclaw/src/infra/node-commands.ts` include `system.run.prepare`, but the macOS Swift command enum/advertisement does not.

### Integration tests

- No live macOS app-node `system.run` integration scenario was found.
- `/Users/kevinlin/code/openclaw/test/fixtures/system-run-approval-binding-contract.json` and node-host TS tests exercise core `system.run` planning, not the packaged app.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MacNodeRuntimeTests.swift` covers node invoke command behavior, `system.run` denial events, env override rejection, screen/camera gating, and A2UI host refresh.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MacNodeModeCoordinatorTests.swift` covers command advertisement and remote/local capability differences.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ExecApprovalsSocketAuthTests.swift`, `ExecApprovalsSocketPathGuardTests.swift`, `ExecHostRequestEvaluatorTests.swift`, `ExecAllowlistTests.swift`, and `ExecApprovalPromptLayoutTests.swift` cover approval infrastructure.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.test.ts` covers core prepared exec and app exec-host fallback semantics.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS system.run exec approval node host" --json`

Results:

- Issue #83958 `macOS app node regresses in 2026.5.18: flaps online/offline and gateway invokes time out`.
- Issue #9876 `Show session and requester context in macOS exec approval popup`.
- Issue #44749 `Concurrent allow-always approvals silently lose allowlist entries`.
- PRs #84645, #84172, #80922, #78793, and #82596 show active churn in exec approval planning and UX.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS system.run"`

Results:

- 2026-04-26 GitHub mirror for #49031 says the old macOS companion missing `system.run.prepare` report was superseded, but remaining gap is tracked by #37591/#38781.
- 2026-04-26 GitHub mirror for #37591 says current main still lacks macOS `system.run.prepare` support while the node exec path requires it.
- 2026-04-26 GitHub mirror for #71877 notes remote macOS skill bin eligibility fixed after `system.which` object-map response handling.
