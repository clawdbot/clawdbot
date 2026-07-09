---
summary: "Run agent tasks in isolated git checkouts with automatic snapshots and cleanup"
read_when:
  - You want an isolated branch and checkout for an agent task
  - You are configuring Workboard cards with worktree workspaces
  - You need to restore or clean up an OpenClaw-managed worktree
title: "Managed worktrees"
---

Managed worktrees give an agent task its own git branch and checkout without placing temporary directories inside the source repository. OpenClaw creates them under its state directory, records them in the shared state database, and snapshots their tracked and non-ignored untracked contents before removal.

## Layout and names

Each worktree lives at:

```text
<openclaw-state-dir>/worktrees/<repo-fingerprint>/<name>
```

The repository fingerprint is the first 16 hexadecimal characters of a SHA-256 hash over the canonical git common directory and origin URL. A supplied name must match `[a-z0-9][a-z0-9-]{0,63}`. Without a name, OpenClaw generates `wt-` followed by eight random hexadecimal characters.

OpenClaw creates branch `openclaw/<name>` at the requested base ref. Without a base ref, it fetches `origin`, uses the remote default branch when available, and falls back to local `HEAD` when the repository is offline or has no usable remote.

## Provision ignored files

Add `.worktreeinclude` at the source repository root to copy selected ignored, untracked files into a new worktree. The file uses gitignore-pattern syntax, one pattern per line, with `#` comments:

```gitignore
.env.local
fixtures/generated/**
```

Only files reported by git as both ignored and untracked are eligible. Tracked files are already present through git and are never copied by this step. OpenClaw does not overwrite destination files or follow symlinked directories, and it preserves copied file modes.

## Run repository setup

If `.openclaw/worktree-setup.sh` exists in the source repository and is executable, OpenClaw runs it with the new worktree as its current directory. The script receives:

```text
OPENCLAW_SOURCE_TREE_PATH=<source checkout>
OPENCLAW_WORKTREE_PATH=<managed worktree>
```

A nonzero exit aborts creation and removes the new worktree and branch. This is a repository-local contract; there is no OpenClaw config key for it.

## Session worktrees

Start an isolated chat from the active agent's git workspace with **New chat in worktree**: use the secondary New Chat action in the Control UI sidebar, the Chat actions menu on iOS, or the overflow action beside New Chat on Android. The action is available only for a git-backed agent where the client has that capability; clients that cannot preflight it surface the gateway error instead.

Coding agents can also call `spawn_task` when they discover confirmed follow-up work outside the current task. The Control UI shows a suggestion chip without starting anything, while a Gateway-backed TUI shows an interactive prompt with the same actions. Selecting **Start in worktree** creates a fresh session-owned worktree from the suggested project and sends the self-contained prompt as its first turn; dismissing the suggestion leaves the repository untouched. Suggestions and their IDs are ephemeral and do not survive a Gateway restart.

OpenClaw exposes these tools only to operator sessions with an actionable Gateway UI. Channel sessions and local/embedded TUI sessions do not receive them until those surfaces have a portable typed task-action contract.

The resulting managed worktree is owned by the session, and every agent run in that session uses its checkout. When the workspace is a repository subdirectory, the worktree is anchored at the repository root and the session runs from the matching subdirectory inside it. Session worktree creation uses the method's `operator.write` scope, but the `.openclaw/worktree-setup.sh` step runs only for `operator.admin` callers because it executes repository code; `.worktreeinclude` provisioning still applies to every caller. Deleting the session removes the worktree only when doing so is lossless. Dirty worktrees or branches with unpushed commits stay available; hourly cleanup snapshots session worktrees after 7 idle days, treating recent session activity as worktree activity. Removed worktrees remain restorable from their snapshots as described below.

`sessions.create` may include an absolute `cwd` together with `worktree: true` when a task targets a project other than the configured agent workspace. That explicit host path requires `operator.admin`; ordinary worktree chat creation remains `operator.write` and stays anchored to the configured workspace.

## Snapshots, cleanup, and restore

Removal first creates a synthetic commit containing tracked and non-ignored untracked files, and pins it at `refs/openclaw/snapshots/<id>`. Gitignored files are excluded from the repository object database; files selected by `.worktreeinclude` are copied again during restore. If snapshot creation fails, removal stops. An explicit force delete can continue without a snapshot.

OpenClaw applies these cleanup rules:

- At run end, it removes a worktree only when `git status --porcelain` is empty and `git log HEAD --not --remotes --oneline` finds no unpushed commits. Otherwise it only releases the activity lock.
- Hourly cleanup snapshots and removes unlocked Workboard- and session-owned worktrees idle for more than 7 days, even when dirty. Manual worktrees are never automatically removed.
- Snapshot records remain restorable for 30 days. Cleanup then deletes the snapshot ref and registry row.
- A live OpenClaw process lock and any foreign or unrecognized git worktree lock protect a worktree from garbage collection.

Restore recreates `openclaw/<name>` at the original pre-snapshot commit, then rebuilds the snapshot differences as unstaged modifications and untracked files. This keeps the synthetic snapshot commit out of branch history. The snapshot ref remains recorded as provenance.

## CLI

```bash
openclaw worktrees list [--json]
openclaw worktrees create <repo-root> [--name <name>] [--base-ref <ref>] [--json]
openclaw worktrees remove <id> [--force] [--json]
openclaw worktrees restore <id> [--json]
openclaw worktrees gc [--json]
```

The Control UI **Worktrees** page under Settings provides the same list, delete, restore, and cleanup actions.

## Gateway methods

| Method              | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `worktrees.list`    | List active and restorable worktree records.  |
| `worktrees.create`  | Create or reuse a named managed worktree.     |
| `worktrees.remove`  | Snapshot and remove a worktree.               |
| `worktrees.restore` | Restore a removed worktree from its snapshot. |
| `worktrees.gc`      | Run idle, orphan, and retention cleanup now.  |

`worktrees.list` requires `operator.read`. Mutating methods require `operator.admin`.

## Workboard workspaces

The bundled [Workboard plugin](/plugins/workboard) can materialize a card workspace as a managed worktree:

```json
{
  "kind": "worktree",
  "path": "/absolute/path/to/source-checkout",
  "branch": "main"
}
```

`path` identifies the source git checkout. `branch` is optional and becomes the base ref. When dispatch starts the card's worker, Workboard creates or reuses `wb-<card-id>`, runs the subagent with the managed checkout as its working directory, and writes the resolved path and branch back to the card. Gateway-triggered materialization requires `operator.admin`. On run end, Workboard removes the checkout only when it is provably lossless; dirty work or unpushed commits remain available.

Sandboxed embedded agents currently reject a task working directory outside their configured agent workspace. Use an unsandboxed target agent for Workboard managed-worktree cards until the sandbox runtime supports an additive checkout mount.
