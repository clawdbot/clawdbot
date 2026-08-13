---
summary: "Back up OpenClaw state: archives, per-database snapshots, scheduling, offsite copies, and continuous replication"
read_when:
  - You want a backup routine for an OpenClaw install instead of a one-off archive
  - You want scheduled, offsite, or continuous backups without copying the whole database every time
  - You need to restore OpenClaw state from a backup
title: "Backups"
---

# Backups

OpenClaw keeps its authoritative state in SQLite: one global control-plane
database plus one database per agent, all under the state directory (usually
`~/.openclaw`). See [Database schemas](/reference/database-schemas) for the
exact layout. This guide covers protecting that state: one-off archives,
per-database snapshots, scheduling, offsite copies, and continuous
replication for installs that should not re-upload whole databases on every
backup.

Never copy live `.sqlite`, `-wal`, `-shm`, or `-journal` files as a backup.
The databases are written while the Gateway runs, and raw file copies of a
live database can be torn or corrupt. Every supported path below captures
committed state safely.

<Warning>
  Backups contain auth profiles, channel and provider credentials, session
  history, and other sensitive records. Store them encrypted, restrict the
  destination like you restrict the live state directory, and rotate
  credentials if you suspect a backup leaked. See
  [Migrating between machines](/install/migrating) for the same rules applied
  to machine moves.
</Warning>

## Choose a path

- One-off, everything, portable: `openclaw backup create` archive.
- One database, compact and verified: `openclaw backup sqlite create`.
- Versioned and incremental by content: `openclaw backup git create`.
- Regular protection: provision the Gateway-owned backup automation.
- Continuous, incremental, seconds of data loss: replicate the databases with
  Litestream.

## Full archives

```bash
openclaw backup create --output ~/Backups/openclaw --verify
```

This writes a timestamped `.tar.gz` covering state, config, credentials,
sessions, and (by default) workspaces, then validates the archive manifest
and payload. SQLite databases inside the archive are captured with SQLite's
online backup API and compacted, so the archive is safe to create while the
Gateway runs. [Backup CLI](/cli/backup) documents every flag, the volatile
files that are intentionally skipped, and verification details.

Archives are full copies: each run re-uploads everything. They are the right
tool before an update, reset, uninstall, or machine move, and a reasonable
daily routine for small installs. For large workspaces or frequent backups,
prefer snapshots or continuous replication below.

On ephemeral container hosts, keep the archive outside the container and use
`openclaw backup restore` as the disaster-recovery primitive for rebuilding a
fresh persistent state tree. Restore stages files only; activation remains an
explicit offline deployment step.

## Per-database snapshots

```bash
openclaw backup sqlite create --global --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite create --agent main --repository ~/Backups/openclaw-sqlite
```

Each run publishes one verified snapshot directory (`manifest.json` plus
`database.sqlite`) into the repository directory. Snapshots are vacuumed, so
deleted-page remnants do not inflate them, and every snapshot records a
SHA-256 that `openclaw backup sqlite verify` rechecks later.

Snapshot repositories are local directories. Scheduling, upload, retention,
and restore-on-boot are intentionally left to the operator; the sections
below cover them.

## Schedule backups

The recommended schedule is one Gateway-owned automation. This example backs
up every registered database daily and pushes the current branch to `origin`.
Pushing requires the repository to have an `origin` remote first, so
initialize it once before enabling a pushed schedule:

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote git@github.com:you/openclaw-backups.git
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h --push
```

`backup enable --push` refuses to schedule when no `origin` remote is
configured, so a fresh install cannot silently create a schedule whose pushes
always fail.

Pushed schedules redact credential-bearing tables by default: an unattended
recurring push would otherwise retain credentials durably in remote Git
history. Pass `--include-secrets` to schedule full-fidelity remote backups
when you accept that tradeoff and the remote is private; restores from
redacted history require re-pairing devices and re-authenticating providers
afterward. Local (non-push) schedules keep full fidelity so restores are
complete.

Use `--global-only` or `--agent <id>` to narrow the scope. Add
`--exclude-secrets` for a redacted Git history. Re-running the command updates
the fixed scheduled job instead of creating another one. Disable it with:

```bash
openclaw backup disable
```

The Gateway must be reachable while enabling or disabling the schedule. There
is no local fallback scheduler.

As an alternative, use your platform scheduler directly. A nightly cron
example that snapshots the control-plane database and the `main` agent
database:

```bash
0 3 * * * openclaw backup sqlite create --global --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
5 3 * * * openclaw backup sqlite create --agent main --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
```

On macOS, a `launchd` job works the same way; on servers provisioned from the
[hosting guides](/install), a systemd timer is the natural fit. `--json`
emits one machine-readable result per run, so the log doubles as a backup
audit trail. Prune old snapshot directories on your own retention schedule.

Every non-dry-run archive, local SQLite snapshot, and Git backup attempt is
also recorded in the shared state database. `openclaw status` shows the newest
attempt, and `openclaw doctor` suggests a one-off or scheduled backup when no
successful run is recorded or the newest success is more than 14 days old.

## Copy backups offsite

Archives and snapshot repositories are plain files, so any sync tool works.
An `rclone` example targeting an S3-compatible bucket:

```bash
rclone sync ~/Backups/openclaw-sqlite remote:openclaw-backups/sqlite
```

Because every archive and local snapshot is a full copy, offsite syncs re-upload
each new backup in full. Deduplicating backup tools such as `restic` reduce
storage at the destination but still read full snapshots as input. When
upload size per backup matters, use Git-backed snapshots or continuous
replication.

## Versioned backups to a Git repository

Git-backed backups dump each selected database into deterministic `schema.sql`,
`manifest.json`, and per-table JSONL files, then create one commit for the
whole run. Unchanged database content produces no commit, so Git stores and
pushes only content changes by construction. OpenClaw stages only the
backup-owned `global` and `agents` paths, not unrelated files elsewhere in the
repository.

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote <private-git-url>
openclaw backup git create --repository ~/Backups/openclaw-git --all --push
openclaw backup git log --repository ~/Backups/openclaw-git
```

Use a repository dedicated to OpenClaw backups. Existing `global/` and
`agents/<agentId>/` scopes must be empty or contain a valid schema-version-1
OpenClaw backup manifest. OpenClaw refuses to replace any other scope, and an
`--all` run validates every existing agent scope before deleting stale
backup-owned entries.

The repository root must be owned by the current user and must not be group- or
world-writable. This is checked during init and every create. On POSIX systems,
confirm ownership and run `chmod 700 <repository>` to repair unsafe permissions.

The repository is ordinary Git and can use any remote, including GitHub. Keep
the remote private: the default dump includes auth profiles, tokens, and other
credential-bearing state. `--exclude-secrets` omits the documented secret
tables when a redacted history is more useful than a credential-complete
backup; see [Backup CLI](/cli/backup#versioned-git-backups) for the exact list.

Verify or restore one database at any commit without overwriting a live file:

```bash
openclaw backup git verify --repository ~/Backups/openclaw-git --ref <commit> --global
openclaw backup git restore --repository ~/Backups/openclaw-git --ref <commit> --agent main --target ./restored-agent.sqlite
```

Git restore converges derived search state: it rebuilds content-backed FTS5
indexes, leaves transcript projection state for Gateway startup reconciliation,
and leaves vector tables for memory indexing to recreate. It then verifies
table hashes, SQLite integrity, and foreign keys.

## Continuous replication with Litestream

[Litestream](https://litestream.io) is an open-source replication daemon for
SQLite. It runs alongside the Gateway with no OpenClaw changes: it watches
each database's write-ahead log and streams incremental changes to object
storage, with periodic snapshots so restores stay fast. Only changed pages
leave the machine, which makes it the right tool when backups must not
re-upload whole databases.

OpenClaw's databases run in WAL mode, which is Litestream's one hard
requirement. A minimal `litestream.yml` replicating the control-plane
database and one agent database to an S3-compatible bucket:

```yaml
dbs:
  - path: /home/user/.openclaw/state/openclaw.sqlite
    replicas:
      - url: s3://openclaw-backups/state
  - path: /home/user/.openclaw/agents/main/agent/openclaw-agent.sqlite
    replicas:
      - url: s3://openclaw-backups/agents/main
```

Run `litestream replicate` under your process supervisor, one entry per
database you care about. To recover, restore to a fresh path and activate it
offline:

```bash
litestream restore -o ./restored-openclaw.sqlite s3://openclaw-backups/state
```

Litestream replicates database bytes only. Config, credentials files, and
workspaces still need one of the file-based paths above, and the replicated
data is as sensitive as the archives, so apply the same bucket access and
encryption rules.

## Restore

Restore is deliberately explicit; nothing overwrites live state in place.

### Restore a full archive

Start only from an archive you created or otherwise trust. `openclaw backup
verify` checks archive structure and payload layout, but it does not
authenticate the archive or make untrusted content safe.

Before a full restore, review [What gets backed
up](/cli/backup#what-gets-backed-up). Then verify and extract into a fresh
staging directory with one command:

```bash
ARCHIVE=./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
openclaw backup restore "$ARCHIVE" --target ./restored-openclaw
```

The target must not exist or must be empty. OpenClaw verifies archive structure,
the manifest, hardlinks, and SQLite databases before it writes the target. A
non-empty target is refused, and a failed extraction cleans its incomplete
output. The command never touches the live state directory and has no force or
in-place mode. Treat the restored directory as sensitive: it can contain
credentials, auth profiles, sessions, and workspace data.

<Warning>
  Restoring an archive is time travel. Messaging-channel credentials with
  ratchet state, especially WhatsApp, may desynchronize after rollback and need
  relinking. Approvals and delivery/dedupe state also roll back, so review
  pending approvals before resuming the Gateway. Plugin `node_modules` trees
  are not archived; after activation, run `openclaw plugins update <id>` or
  reinstall with `openclaw plugins install <spec> --force`.
</Warning>

The manifest records `archiveRoot`, the original paths under `paths`, and an
`assets[]` list. Each asset includes its `kind`, original `sourcePath`, and
`archivePath` inside the tarball. Use those fields as the source of truth; do
not derive the archive root from the archive filename.

The archive layout is:

```text
<archive-root>/manifest.json
<archive-root>/payload/posix/<absolute-source-path-without-leading-slash>/...
<archive-root>/payload/windows/<DRIVE>/<rest>/...
<archive-root>/payload/relative/<relative-source-path>/...
```

To activate, stop the Gateway and any node hosts that use the restored files.
Make a fresh backup of current state or move it aside. Then move the extracted
state asset into place, or point `OPENCLAW_STATE_DIR` at that asset, and run
`openclaw doctor` before restarting the Gateway. On a new machine or under a
different home directory, use the manifest to map config, credentials, and
workspace assets to their new paths. See [Updating](/install/updating#rollback)
for the rollback workflow.

### Restore a database

For a snapshot, `openclaw backup sqlite restore <snapshot-directory> --target
<new-database-path>` writes a re-verified database to a fresh target. For Git
history, `openclaw backup git restore --repository <dir> --ref <commit>
(--global | --agent <id>) --target <new-database-path>` materializes and
verifies a fresh database. For Litestream, `litestream restore` writes a fresh
database file. Move the result into place while the Gateway is stopped, then
start the Gateway and check `openclaw health` and `openclaw doctor`.

After restoring onto a different OpenClaw version, preflight the database
first with `openclaw database preflight`; see
[Database schemas](/reference/database-schemas#preflight-a-target-release).

## Related

- [Agent workspace](/concepts/agent-workspace#git-backup-recommended-private) for keeping workspace files in a private git repository
- [Backup CLI reference](/cli/backup)
- [Database schemas](/reference/database-schemas)
- [Migrating between machines](/install/migrating)
- [Updating](/install/updating)
