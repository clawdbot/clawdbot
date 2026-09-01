---
summary: "Run agent tasks in isolated git checkouts with automatic snapshots and cleanup"
read_when:
  - You want an isolated branch and checkout for an agent task
  - You are configuring Workboard cards with worktree workspaces
  - You want to store managed worktrees on another disk or in a custom folder
  - You need to restore or clean up an OpenClaw-managed worktree
title: "Managed worktrees"
---

Managed worktrees give an agent task its own git branch and checkout without placing temporary directories inside the source repository. OpenClaw records them in the shared state database and snapshots their tracked and non-ignored untracked contents before removal.

## Choose where worktrees are stored

By default, OpenClaw stores managed checkouts under `<openclaw-state-dir>/worktrees`. Set the global `worktreeRoot` option in `openclaw.json` to use another folder or disk:

```json5
{
  worktreeRoot: "/mnt/workspaces/openclaw-worktrees",
}
```

Use an absolute path on the Gateway host, `~` for the Gateway user's home directory, or a path beginning with `~/` for a folder inside it. Relative paths are rejected. The Gateway user must be able to create and write to the directory.

This setting applies to all managed worktrees, including session, manual, and Workboard worktrees; there is no per-agent override. It changes checkout storage only. The shared state database, snapshots of provisioned ignored files, allocation limits, and cleanup lifecycle remain associated with the same OpenClaw state directory.

Changing `worktreeRoot` affects new allocations. Existing registered worktrees keep their recorded paths for reuse and cleanup, and removed worktrees restore to their original paths. OpenClaw does not move existing checkouts or snapshots when this setting changes. Keep their original storage available until those worktrees are no longer needed.

Outside the default state-owned worktree directory, cleanup acts only on registered worktrees. It leaves unrelated, unregistered folders in your custom location alone.

See [Configuration reference](/gateway/configuration-reference#worktreeroot) for the option's default and scope.

## Layout and names

Each worktree lives at:

```text
<worktreeRoot>/<repo-fingerprint>/<name>
```

The repository fingerprint is the first 16 hexadecimal characters of a SHA-256 hash over the canonical git common directory and origin URL. A supplied name must match `[a-z0-9][a-z0-9-]{0,63}`. Without a name, OpenClaw generates a readable crustacean-themed name such as `brisk-lobster`. Inferred names already occupied by any registered worktree (including the caller's own removed checkout), local branch, or unmanaged path get a numeric suffix such as `brisk-lobster-2`; only a supplied name reuses or restores the caller's existing record.

OpenClaw creates branch `openclaw/<name>` at the requested base ref. Without a base ref, it fetches `origin`, uses the remote default branch when available, and falls back to local `HEAD` when the repository is offline or has no usable remote.

Each `git worktree add` checkout during creation or snapshot restore has a five-minute timeout, including a creation retry from local `HEAD`. Other managed-worktree Git commands keep their two-minute timeout. The separate `.openclaw/worktree-setup.sh` step also keeps its own two-minute timeout.

## Capacity and disk space

OpenClaw allows up to 30 live managed worktrees per state directory. Manual and protected worktrees count toward this limit. Creating or restoring a checkout at the limit reports how to free a slot; it never evicts another session as part of creation. Reusing an existing valid checkout does not require a new slot.

Before allocating a checkout, OpenClaw checks its destination, Git metadata, source checkout, and state volumes. It keeps 10% of each volume free, with a minimum reserve of 4 GiB and a maximum of 16 GiB, plus twice the estimated Git checkout and provisioned-file size. An executable setup script requires additional room equal to the larger of 4 GiB or the current source checkout footprint excluding Git metadata. Space is checked again before provisioning/setup and after setup. An unavailable capacity reading stops allocation with an actionable error.

Creation, restore, and snapshot removal share one allocation lease across repositories and processes using the same state directory. Costs on the same volume are added together. These checks are conservative estimates, not a disk quota: other OpenClaw state directories, shell commands, deployment tools, and arbitrary setup/build output can still consume space. Worktrees created directly through Git are outside the managed count and cleanup lifecycle.

Snapshot removal uses a smaller reserve of 128 MiB plus estimated snapshot writes, so safe cleanup remains possible below the operational reserve. If a snapshot cannot fit, removal preserves the checkout and asks you to free space first.

## Provision ignored files

Add `.worktreeinclude` at the source repository root to copy selected ignored, untracked files into a new worktree. The file uses gitignore-pattern syntax, one pattern per line, with `#` comments:

```gitignore
.env.local
fixtures/generated/**
```

Only files reported by git as both ignored and untracked are eligible. Tracked files are already present through git and are never copied by this step. OpenClaw does not overwrite or change destination files that already exist, does not follow symlinked directories, and preserves copied file modes. It records only paths it actually creates, so later manifest edits cannot make those files disappear from cleanup protection.

## Run repository setup

If `.openclaw/worktree-setup.sh` exists in the source repository and is executable, OpenClaw runs it with the new worktree as its current directory. The script receives:

```text
OPENCLAW_SOURCE_TREE_PATH=<source checkout>
OPENCLAW_WORKTREE_PATH=<managed worktree>
```

A nonzero exit aborts creation and removes the new worktree and branch. This is a repository-local contract; there is no OpenClaw config key for it.

Setup failures report the exit code or termination signal, or an actual timeout after 120 seconds, with a bounded excerpt of recent output rather than the full setup log. If setup times out, inspect `.openclaw/worktree-setup.sh` and its dependencies for slow downloads, unavailable services, or commands waiting for interactive input.

## Session worktrees

Start an isolated chat from a Git-backed folder with a worktree session: on the Control UI's New session page, use the **Place** picker to choose a Gateway source folder, then select **Worktree** (with an optional base branch and worktree name). Choosing a paired device or cloud profile forces this managed-worktree path from the selected Gateway source; remote placement never browses or binds a node working directory. When the name is omitted, OpenClaw derives it from the explicit session label or the concise title generated from the first message, then falls back to a crustacean-themed name. iOS exposes the same choice from Chat actions, and Android exposes it beside New Chat, when the active agent workspace is Git-backed.

The Control UI offers **Worktree** only after confirming a usable Git checkout with at least one commit, or when a selected remote Git repository is awaiting cloning. Plain folders and newly initialized repositories without commits can run directly on the Gateway. A failed Git check also leaves direct execution available if the folder is accessible; a `.git` entry or saved project alone does not enable isolation. If you already selected **Worktree** and a later check fails, that selection stays visible and starting is blocked. Clear **Worktree** to run directly, or reselect the folder to check it again.

Group **New session defaults** checks the agent workspace the same way as a custom folder. If verification fails, retry before saving the group defaults. A remembered cloud destination cannot block a new local draft in a plain folder; a transient Git-check failure leaves the saved destination intact for the next visit.

The Place picker's **Projects** section can start the same worktree flow from a registered project ID. The Gateway resolves the recorded checkout path, so this path remains available at `operator.write`; selecting an arbitrary host folder still requires `operator.admin`.

Coding agents can also call `suggest_task` when they discover confirmed follow-up work outside the current task. The Control UI shows a suggestion chip without starting anything, while a Gateway-backed TUI shows an interactive prompt with the same actions. Selecting **Start in worktree** creates a fresh session-owned worktree from the suggested project and sends the self-contained prompt as its first turn; dismissing the suggestion leaves the repository untouched. Suggestions and their IDs are ephemeral and do not survive a Gateway restart.

OpenClaw exposes these tools only to operator sessions with an actionable Gateway UI. Channel sessions and local/embedded TUI sessions do not receive them until those surfaces have a portable typed task-action contract.

The resulting managed worktree is owned by the session, and every agent run in that session uses its checkout. When the workspace is a repository subdirectory, the worktree is anchored at the repository root and the session runs from the matching subdirectory inside it. Session worktree creation uses the method's `operator.write` scope. Repository checkout/ref hooks and filesystem monitors are always disabled. The `.openclaw/worktree-setup.sh` step runs only for an `operator.admin` caller; retries evaluate the current caller's scope rather than retaining the original caller's permission. `.worktreeinclude` provisioning still applies to every caller. Deleting the session attempts to snapshot and remove its managed worktree, including dirty worktrees and branches with unpushed commits. Hourly cleanup also snapshots session worktrees after 7 idle days, treating recent session activity as worktree activity. Removed worktrees remain restorable from their snapshots as described below.

Archiving a session commits its archive state, then snapshots and removes its managed checkout while preserving the conversation and worktree binding. A failed metadata write leaves the checkout untouched. If cleanup cannot finish safely, the session remains archived, its files stay preserved, and the error explains that cleanup is pending. Repeating archive retries cleanup; startup and hourly garbage collection also retry any checkout that remains. Automatic session archival uses the same metadata-first ordering.

Unarchiving, or an authorized human message that reopens the archived session, restores the original branch HEAD plus saved dirty and untracked files before admitting work. A restore failure leaves the session archived. If the original repository or its snapshot is missing, or the 30-day snapshot retention has expired, recover the original repository/snapshot or start a new task; OpenClaw does not substitute an empty checkout for the saved work.

`sessions.create` may include an absolute `cwd` to run directly in another Gateway folder or to choose the source checkout together with `worktree: true`. Connections with `operator.write` may use a Gateway `cwd` contained in any configured agent workspace; realpath containment prevents symlinks from escaping that boundary. Gateway paths outside those workspaces require `operator.admin`. Ordinary worktree chat creation remains `operator.write` and stays anchored to the configured workspace. New Session dispatches a completed worktree session to paired devices or cloud profiles instead of passing a paired-node working directory to creation.

`sessions.create` also accepts `worktreeBaseRef` and `worktreeName` alongside `worktree: true` to pick the base ref and the worktree name (the branch becomes `openclaw/<name>`); both stay at `operator.write`. If `worktreeName` is omitted, the session label or generated first-message title supplies the readable branch name, with a crustacean-themed fallback. For a new session with an initial message or task, creation returns the admitted session and run before worktree preparation finishes. The chat shows the submitted message and naming, checkout, and setup progress; failures remain visible and retryable in the same session. The agent starts only after the finalized worktree is bound. Creation without an initial turn still waits for preparation and returns the worktree in the create result. The bound checkout is persisted on the session row as `worktree: { id, branch, repoRoot }`, so session lists can show its checkout and branch. When session deletion cannot finish that cleanup, `worktreePreserved` identifies the active worktree record that needs attention and reports one bounded reason: owner mismatch, active use or competing cleanup, a foreign Git lock, snapshot failure, or another cleanup failure. These reasons describe cleanup and ownership, not whether the checkout is dirty or has unpushed commits.

Accepted child sessions retain their saved repository choice across parent archive, replacement, or worktree changes. A retry must still be authorized for the current child session and uses the current caller's setup permissions.

## Troubleshoot creation

If **New session** reports `git worktree add failed`, read the termination reason and the final Git error lines. `Preparing worktree` and `Updating files` are progress, not the cause of failure. Error messages collapse carriage-return progress redraws and bound the diagnostic tail so it cannot flood the banner.

`timed out after 300 seconds` means a worktree checkout reached its five-minute limit. Other Git commands report `timed out after 120 seconds` at their two-minute limit. Check repository access and available disk space on the Gateway host. A signal or nonzero exit status alone does not establish a timeout; use any accompanying `fatal:` or `error:` detail to investigate. An output-limit error means the command exceeded its output capture limit.

Before another creation attempt, inspect `git -C <repo-root> worktree list` and `git -C <repo-root> branch --list 'openclaw/*'` for partial state. A failed creation does not guarantee that its checkout and branch were removed. Do not delete a checkout or branch without checking whether it contains work you need.

If a checkout's `.git` link points to missing administrative files, OpenClaw preserves its files and refuses to reuse it. Restore the original repository metadata before using `git worktree repair` from that repository. A different clone with the same remote URL does not recover the missing index or unpushed history; do not replace the link or rebuild the index without verifying the original metadata.

## Snapshots, cleanup, and restore

Removal first creates a synthetic commit containing tracked and non-ignored untracked files, then pins it at `refs/openclaw/snapshots/<id>`. Ignored files never enter the repository object database. OpenClaw stores only the ignored files it actually provisioned in chunked shared-state database rows; the recorded path set remains authoritative even if `.worktreeinclude` later changes or disappears. Restore reads those bytes from the immutable snapshot and reapplies their complete modes. Automatic cleanup preserves a live worktree when a recorded path can no longer be snapshotted safely. If snapshot creation fails, removal stops unless an explicit force delete discards snapshot safety.

Nested Git repositories and linked worktrees are separate ownership boundaries. Automatic cleanup preserves the outer worktree even when a nested linked worktree shares its Git common directory. A nested OpenClaw-managed worktree is cleaned only through its own managed-worktree record.

OpenClaw applies these cleanup rules:

- At run end, it removes a worktree only when `git status --porcelain` is empty and `git log HEAD --not --remotes --oneline` finds no unpushed commits. Otherwise it only releases the activity lock.
- Startup and hourly cleanup snapshot and remove unlocked Workboard- and session-owned worktrees idle for more than 7 days, even when dirty. Session worktrees whose owner is archived or absent are eligible immediately. Failed owner lookups preserve the checkout.
- Cleanup also removes the least recently active eligible run-owned worktrees above the default limit of 30. Manual worktrees are never automatically removed, and protected worktrees can keep the total above the limit until they are released or explicitly cleaned up.
- Snapshot records remain restorable for 30 days. Cleanup then deletes the snapshot ref and registry row.
- A live OpenClaw process lock and any foreign or unrecognized git worktree lock protect a worktree from garbage collection.

Run-end cleanup records its outcome on the worktree record: lossless removal, retention because the checkout is busy, dirty, unpushed, or has provisioned-file drift, or failure with an error reason. Inspect the recorded outcome with `openclaw worktrees list --json` or `worktrees.list`.

Restore recreates `openclaw/<name>` at the original pre-snapshot commit, then rebuilds the snapshot differences as unstaged modifications and untracked files. This keeps the synthetic snapshot commit out of branch history. The snapshot ref remains recorded as provenance.

## CLI

```bash
openclaw worktrees list [--json]
openclaw worktrees create <repo-root> [--name <name>] [--base-ref <ref>] [--json]
openclaw worktrees remove <id> [--force] [--json]
openclaw worktrees restore <id> [--json]
openclaw worktrees gc [--json]
```

The Control UI **Worktrees** page under Settings provides the same actions plus creation with a base-branch picker, shows each worktree's owner (manual, Workboard, or the owning session with a link into its chat), and offers a force retry when a removal reports a failed snapshot.

## Gateway methods

| Method               | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `worktrees.list`     | List active and restorable worktree records.                            |
| `worktrees.branches` | List local and remote branches of a repository for base-ref pickers.    |
| `worktrees.create`   | Create or reuse a named managed worktree.                               |
| `worktrees.remove`   | Snapshot and remove a worktree. Forced removals report `snapshotError`. |
| `worktrees.restore`  | Restore a removed worktree from its snapshot.                           |
| `worktrees.gc`       | Run idle, orphan, and retention cleanup now.                            |

`worktrees.list` requires `operator.read`. `worktrees.create` and `worktrees.branches` require `operator.write` for configured agent workspaces and registered projects; arbitrary host paths still require `operator.admin`. All creation disables repository Git hooks; write-scoped creation also skips `.openclaw/worktree-setup.sh`. Removing, restoring, and garbage-collecting worktrees remain admin-only. Branch listing reads existing refs only and never fetches, and remote-only branches come back remote-qualified (`origin/feature-a`) so every returned name resolves as a base ref. New Session can also request a typed repository status from this method; a plain directory or unavailable checkout returns no branches instead of forcing the UI to infer Git capability from an error string.

## Workboard workspaces

The bundled [Workboard plugin](/plugins/workboard) can materialize a card workspace as a managed worktree:

```json
{
  "kind": "worktree",
  "path": "/absolute/path/to/source-checkout",
  "branch": "main"
}
```

`path` identifies the source git checkout. `branch` is optional and becomes the base ref. For a full-host caller, Workboard creates or reuses `wb-<card-id>`, runs the subagent with the managed checkout as its working directory, and writes the resolved path and branch back to the card. Gateway clients need `operator.admin` for full-host materialization. On run end, Workboard removes the checkout only when it is provably lossless; dirty work or unpushed commits remain available.

For a workspace-bound caller, `path` and the repository root must exactly match the target agent workspace. Workboard then runs directly in that directory and records a directory workspace instead of host-materializing a managed worktree. The target must use a writable, non-shared Docker sandbox for the same workspace, its live container hash must match the requested mounts and policy, and it must not expose elevated execution, host control, host-wide sessions, persisted host/node execution, or unclassified plugin and MCP tools. If the target policy or live container is broader, dispatch leaves the card unclaimed and reports the incompatible state.
