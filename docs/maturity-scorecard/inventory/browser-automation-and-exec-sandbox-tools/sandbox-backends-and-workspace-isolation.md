---
title: "Browser automation and exec/sandbox tools - Sandbox and Tool Policy Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Sandbox and Tool Policy Maturity Note

## Summary

Sandbox backends and workspace isolation is Stable on Coverage and Beta on
Quality. Docker, SSH, and OpenShell backends are documented and represented in
source/tests; workspace access, bind mounts, filesystem bridge, registry, and
path guards are substantial. Quality remains Beta because Docker-in-Docker path
parity, remote backend bridge behavior, read/write path translation, and browser
backend limits remain operationally fragile.

## Category Scope

Included in this category:

- Sandbox Backends: Covers Sandbox Backends across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Workspace Isolation: Covers Workspace Isolation across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Sandboxed Browser: Covers Sandboxed Browser across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Codex Dynamic Tools: Covers Codex Dynamic Tools across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Tool Policy: Covers Tool Policy across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.
- Sandbox Tool Gates: Covers Sandbox Tool Gates across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.

## Features

- Sandbox Backends: Covers Sandbox Backends across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Workspace Isolation: Covers Workspace Isolation across sandbox modes, scopes, workspace roots, workspaceAccess, and related sandbox backends and workspace isolation behavior.
- Sandboxed Browser: Covers Sandboxed Browser across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Codex Dynamic Tools: Covers Codex Dynamic Tools across sandbox browser config, Docker browser container creation, CDP relay authentication, noVNC password/token flow, and related sandboxed browser and codex dynamic tools behavior.
- Tool Policy: Covers Tool Policy across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.
- Sandbox Tool Gates: Covers Sandbox Tool Gates across tool profiles, tool groups, allow/deny policy, provider policy, and related tool policy and sandbox tool gates behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (85%)`
- Positive signals:
  - Docs cover sandboxed tools, modes, scopes, Docker/SSH/OpenShell backend
    matrix, Docker-in-Docker path parity, workspace access, binds, and browser
    backend support.
  - Source has a backend registry, Docker and SSH backends, context resolution,
    workspace layout, filesystem bridge, path guard, and registry updates.
  - Tests cover backend registry, Docker backend manager, SSH backend, sandbox
    config merge, sandbox explain, workspace mounts, bind specs, fs bridge
    boundary checks, fs bridge backend e2e, remote fs bridge, and sandbox media
    paths.
  - Docs and source explicitly fail when a backend does not support browser
    sandboxes.
- Negative signals:
  - Archive reports include Docker gateway restart loops, missing python in
    sandbox FS bridge paths, and sandbox write/read path confusion.
  - SSH/OpenShell are more remote-canonical and do not support sandbox browser
    containers.
- Integration gaps:
  - Add one backend matrix that runs the same exec/read/write/edit/apply_patch
    flow across Docker, SSH, and OpenShell.
  - Add Docker-in-Docker deployment smoke for host-path parity and FS bridge
    heartbeat writes.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - `sandbox docker fs bridge` returned PR #56785 for python3 missing guidance,
    issue #86612 for Docker gateway restart loop with sandbox enabled, issue
    #7575 for Sysbox runtime, and PR #69824 for ACP runtime consolidation.
  - `sandbox backend workspaceAccess bind fs bridge openshell ssh docker`
    returned no focused hits; broader sandbox queries were needed.
- Discrawl reports:
  - `sandbox backend fs bridge` returned 2026-04-16 support threads explaining
    Docker image python requirements, SSH/OpenShell remote bridge risk, and that
    write/edit use a Python helper inside the active sandbox runtime rather than
    host Python.
  - The same archive also included a hook/sandbox workspace report where
    sandboxed writes were not visible on the expected host path, showing why
    path translation diagnostics matter.
- Good qualities:
  - Backend registration is explicit and fails when an unregistered backend is
    requested.
  - Sandbox context resolves effective runtime status, workspace layout,
    backend, browser support, fs bridge, and registry entry in one path.
  - Filesystem bridge uses path guards, pinned entries, access checks, and
    backend shell commands instead of direct host writes.
  - Docker backend reports config-label match and runtime removal errors.
- Bad qualities:
  - Docker socket, host path parity, bind mounts, and read-only overlays are
    powerful but easy to misconfigure.
  - Remote backends have weaker browser support and rely on remote shell
    environment assumptions.
  - WorkspaceAccess behavior can be surprising because agent workspace,
    sandbox workspace, and remote-canonical state may diverge.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (85%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Sandbox Backends, Workspace Isolation, Sandboxed Browser, Codex Dynamic Tools, Tool Policy, Sandbox Tool Gates.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- SSH and OpenShell backends need stronger parity proof against Docker for file
  mutation and process execution.
- Sandbox diagnostics should make path ownership and host-vs-container path
  parity errors obvious.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:9`: docs state OpenClaw can run tools inside sandbox backends while Gateway stays on host.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:15`: tool execution and optional sandboxed browser are covered by sandboxing.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:39`: sandbox modes include off, non-main, and all.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:58`: sandbox scope controls agent/session/shared container reuse.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:66`: backend docs list Docker, SSH, and OpenShell.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:78`: backend matrix shows Docker supports browser sandbox while SSH/OpenShell do not.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandboxing.md:94`: Docker-in-Docker warning documents host-path and FS bridge parity requirements.
- `/Users/kevinlin/code/openclaw/docs/gateway/sandbox-vs-tool-policy-vs-elevated.md:42`: bind mount security quick check warns about sandbox filesystem piercing.
- `/Users/kevinlin/code/openclaw/docs/tools/multi-agent-sandbox-tools.md:181`: per-agent sandbox settings override global defaults.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/backend.ts:43`: backend registry registers sandbox backends.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/backend.ts:70`: missing backend factory throws actionable configuration guidance.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/backend.ts:83`: Docker and SSH backends are registered.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker-backend.ts:32`: Docker backend ensures a container and returns an exec-capable handle.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker-backend.ts:63`: Docker backend advertises browser capability.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/context.ts:130`: sandbox context resolution starts from effective runtime status.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/context.ts:145`: workspace layout is ensured before backend creation.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/context.ts:159`: context requires the configured backend factory.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/context.ts:201`: backend without browser capability fails when browser sandbox is enabled.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.ts:34`: sandbox filesystem bridge is created for a sandbox context.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.ts:83`: writes require write access and path safety checks.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.ts:251`: planned commands recheck path guards before execution.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.backend.e2e.test.ts:72`: local backend e2e coverage exists for sandbox fs bridge behavior.
- `/Users/kevinlin/code/openclaw/test/scripts/sandbox-common-smoke-workflow.test.ts:1`: script smoke coverage exists for common sandbox workflow.
- `/Users/kevinlin/code/openclaw/scripts/test-live-cli-backend-docker.sh:346`: live Docker backend script exists for CLI backend validation.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/backend.test.ts:8`: verifies sandbox backend registry behavior.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker-backend.test.ts:46`: verifies Docker sandbox backend manager behavior.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/ssh-backend.test.ts:139`: verifies SSH sandbox backend behavior.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.boundary.test.ts:18`: verifies writes into read-only bind mounts are blocked.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/fs-bridge.boundary.test.ts:62`: verifies pre-existing symlink escapes are rejected.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/workspace-mounts.test.ts:1`: workspace mount tests exist.
- `/Users/kevinlin/code/openclaw/src/commands/sandbox-explain.test.ts:1`: sandbox explain tests exist.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "sandbox docker fs bridge" --json`

Results:

- Open PR #56785: sandbox guidance when python3 is missing.
- Open issue #86612: Docker gateway container restart loop when sandbox is enabled.
- Open issue #7575: Sysbox Docker runtime for secure container isolation.

Query:

`gitcrawl search openclaw/openclaw --query "sandbox backend workspaceAccess bind fs bridge openshell ssh docker" --json`

Results:

- No focused hits returned; broader `sandbox docker fs bridge` and `sandbox browser`
  queries supplied current archive evidence.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "sandbox backend fs bridge"`

Results:

- 2026-04-16 support archive explains Docker sandbox image python requirements,
  SSH/OpenShell remote FS bridge risk, and that write/edit run helper code
  inside the active sandbox runtime.
- 2026-04-08 hook/sandbox workspace report shows a sandboxed write path where
  visible host filesystem effects were unclear, reinforcing the path-diagnostic
  gap.
