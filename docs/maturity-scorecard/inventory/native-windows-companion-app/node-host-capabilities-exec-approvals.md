---
title: "Native Windows companion app - Desktop Tools and Permissions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Desktop Tools and Permissions Maturity Note

## Summary

Current main contains Gateway policy for Windows nodes and safe Windows
companion commands, but the native Windows companion app that would advertise
and execute those commands is not present. This component gets modest coverage
credit for runtime policy and tests around Windows node defaults, not for a
supported app implementation.

## Category Scope

Included in this category:

- Windows node identity: Windows node identity and capability advertisement.
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop command policy: Desktop command allow/deny policy for native Windows tools.
- App approval prompts: App UI prompts for approval-sensitive desktop commands.
- Screen and media capture: Screen snapshot, recording, and native media capture affordances.
- Canvas host behavior: Canvas and A2UI host behavior in a native Windows companion app.
- Windows shell integrations: Windows shell and PowerToys-style desktop integrations.
- App secrets: App secrets, token persistence, secure local IPC, app signing identity, AppContainer or desktop permission posture
- Windows ACL: Windows ACL and filesystem hygiene for app-owned state
- Command approval: Command approval and dangerous capability gating as surfaced to users

## Features

- Windows node identity: Windows node identity and capability advertisement.
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop command policy: Desktop command allow/deny policy for native Windows tools.
- App approval prompts: App UI prompts for approval-sensitive desktop commands.
- Screen and media capture: Screen snapshot, recording, and native media capture affordances.
- Canvas host behavior: Canvas and A2UI host behavior in a native Windows companion app.
- Windows shell integrations: Windows shell and PowerToys-style desktop integrations.
- App secrets: App secrets, token persistence, secure local IPC, app signing identity, AppContainer or desktop permission posture
- Windows ACL: Windows ACL and filesystem hygiene for app-owned state
- Command approval: Command approval and dangerous capability gating as surfaced to users

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (12%)`
- Positive signals: Gateway node command policy has explicit Windows defaults for safe companion commands and dangerous media gates.
- Negative signals: no Windows companion node runtime, command broker, prompt UI, app socket, or app-hosted exec approval path is present in current main.
- Integration gaps: no app-mediated `system.run`, approval prompt, command allow/deny, or command-result flow can be exercised through a supported Windows app.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (40%)`
- Gitcrawl reports: `#74163` tracks Windows node/process issues; `#81673` references companion suite/system tray/node packaging work.
- Discrawl reports: `#71876` GitHub mirror says Windows nodes were treated like Linux/headless exec hosts and safe companion-app commands were filtered until policy work addressed the default allowlist; `#71884` opened to allow safe Windows companion node commands.
- Good qualities: Gateway policy distinguishes safe Windows commands from dangerous media commands and fails closed for high-risk commands.
- Bad qualities: the actual app execution, prompts, IPC, and operator UX are outside current supported source.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (12%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Windows node identity, Host command execution, Desktop command policy, App approval prompts, Screen and media capture, Canvas host behavior, Windows shell integrations, App secrets, Windows ACL, Command approval.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Windows companion node runtime source or app IPC exists in current main.
- No Windows app exec approval UI, local socket/broker, or prompt persistence.
- No supported app guidance explains how declared Windows node commands should be reviewed or re-paired.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/index.md` documents general node behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md` and `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md` document exec and approval concepts, but not a Windows companion app implementation.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md` does not document Windows app node-host behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/node-command-policy.ts:64-73` defines high-risk node commands.
- `/Users/kevinlin/code/openclaw/src/gateway/node-command-policy.ts:75-105` includes Windows in platform defaults with camera list, location, device, system, and screen snapshot commands.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-misc.test.ts:879-902` asserts safe Windows companion commands are allowed while dangerous media commands stay gated.
- No Windows companion node runtime was found.

### Integration tests

- No supported Windows companion node integration tests were found.
- Adjacent Gateway node and exec tests exist outside the app surface.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-misc.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/node-command-policy.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/exec-approvals.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/system-run-approval-binding.test.ts`

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows node default allowlist companion commands" --json`
- `gitcrawl search openclaw/openclaw --query "safe Windows companion commands" --json`

Results:

- `#74163` open tracking PR includes Windows node/process issues.
- `#81673` mentions Windows companion suite/system tray/node packaging scope through related query results.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows node default allowlist companion commands"`
- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows tray app companion node"`

Results:

- `2026-04-26` GitHub mirror for `#71876` says Windows nodes were filtering safe companion commands such as `canvas.*`, `camera.list`, `location.get`, and `screen.snapshot`.
- `2026-04-26` GitHub mirror for `#71884` opened a PR to allow safe Windows companion node commands.
- `2026-03-13` GitHub mirror describes `openclaw/openclaw-windows-node` as a Windows companion suite with System Tray app, shared library, node, and PowerToys extension.
