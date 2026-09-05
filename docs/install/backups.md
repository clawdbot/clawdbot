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
database under the state directory (usually `~/.openclaw`), plus one database
per configured agent at `<agentDir>/openclaw-agent.sqlite`. Agent directories
default to locations under the state directory but can be configured outside
it. See [Database schemas](/reference/database-schemas) for the exact layout.
This guide covers protecting that state: one-off archives, per-database
snapshots, scheduling, offsite copies, and continuous replication for installs
that should not re-upload whole databases on every backup.

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
- Periodic incremental pull to another machine, no object storage:
  `sqlite3_rsync`.

## Full archives

```bash
openclaw backup create --output ~/Backups/openclaw --verify
```

This writes a timestamped `.tar.gz` covering state, config, credentials, every
configured agent directory, and (by default) workspaces, then validates the
archive manifest and payload. Agent directories remain included when
`--no-include-workspace` is set, even if their configured locations are outside
the state directory. OpenClaw-owned SQLite databases, including agent databases
inside workspace or managed-state assets, are captured with SQLite's online
backup API, owner-verified, sanitized, and compacted. Other SQLite files in
workspaces remain ordinary workspace files. [Backup CLI](/cli/backup)
documents every flag, owner-declared regenerable resources, volatile files,
and verification details.

If the configuration is malformed, `--no-include-workspace` can still produce a
partial recovery archive for state, config, and credentials. Its skipped
diagnostics identify agent and plugin ownership that could not be resolved;
repair the configuration before relying on an archive as complete.

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

`--agent <id>` resolves the database from that agent's configured `agentDir`,
including roots outside the state directory. The same owner-derived lookup
applies to explicit Git agent backups, `--all`, and scheduled Git backups.
Verifying or restoring a historical artifact by agent id does not require that
agent to exist in the current configuration.

Snapshot repositories are local directories. Scheduling, upload, retention,
and restore-on-boot are intentionally left to the operator; the sections
below cover them.

## Schedule backups

The recommended schedule is one Gateway-owned automation. This example backs
up the shared database and every configured agent database daily, including
custom agent roots, and pushes the current branch to `origin`.
Pushing requires the repository to have an `origin` remote first, so
initialize it once before enabling a pushed schedule:

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote git@github.com:you/openclaw-backups.git
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h --push
```

`backup enable --push` refuses to schedule when no `origin` remote is
configured, so a fresh install cannot silently create a schedule whose pushes
always fail.

Pushed schedules redact credential-bearing tables and secret-prefixed
machine-state rows by default: an unattended recurring push would otherwise
retain credentials durably in remote Git history. Pass `--include-secrets` to
schedule full-fidelity remote backups when you accept that tradeoff and the
remote is private; restores from redacted history require re-pairing devices
and re-authenticating providers afterward. Local (non-push) schedules keep full
fidelity so restores are complete.

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
tables and machine-state key prefixes when a redacted history is more useful
than a credential-complete backup; see
[Backup CLI](/cli/backup#versioned-git-backups) for the exact list.

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

Litestream's one hard requirement is WAL mode, which OpenClaw uses on local
filesystems; on network-backed storage such as NFS or SMB, OpenClaw falls
back to rollback journaling, so verify with `PRAGMA journal_mode;` first.
A minimal `litestream.yml` replicating the control-plane
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

For an agent with a custom `agentDir`, replace the example's default agent
database path with its configured `<agentDir>/openclaw-agent.sqlite`.

Litestream replicates database bytes only. Config, credentials files, and
workspaces still need one of the file-based paths above, and the replicated
data is as sensitive as the archives, so apply the same bucket access and
encryption rules.

## Pull replication with sqlite3_rsync

[`sqlite3_rsync`](https://sqlite.org/rsync.html) is the SQLite project's
official replication tool, modeled on `rsync`: it compares page hashes
between an origin and a replica database and ships only changed pages,
typically over SSH with the same binary installed on both ends. Unlike a raw
file copy, it takes a read transaction on the origin, so pulling from a live
database while the Gateway runs produces a consistent replica. WAL mode is
required on the origin. OpenClaw uses WAL on local filesystems but
deliberately falls back to rollback journaling on network-backed storage
such as NFS or SMB, so check the origin before relying on this path:

```bash
sqlite3 ~/.openclaw/state/openclaw.sqlite "PRAGMA journal_mode;"
```

If this prints anything other than `wal`, use one of the file-based paths
above instead.

The tool ships in the `sqlite-tools` binary bundles on the
[SQLite download page](https://sqlite.org/download.html) and in the full
source tree; package-manager SQLite builds often omit it. Pull a database to
another machine you control:

```bash
sqlite3_rsync 'user@gateway-host:~/.openclaw/state/openclaw.sqlite' ./replica/openclaw.sqlite
```

Re-running the command is incremental: an unchanged database exchanges only
a few kilobytes of hashes, and appended data transfers at roughly its own
size. Treat the replica as read-only and as sensitive as the origin.

Two caveats. First, deltas are page-based, and OpenClaw's databases run
incremental auto-vacuum on a periodic maintenance timer; a vacuum pass
relocates pages, so a sync shortly after one (or after large deletions such
as transcript-archive eviction) can transfer far more than the actual data
change. Second, this replicates database bytes only, like Litestream:
config, credentials files, and workspaces still need a file-based path
above. For continuous replication with predictable upload size, prefer
Litestream; use `sqlite3_rsync` for scheduled or ad-hoc pulls between
machines without object storage. To recover, treat the replica like any
restored database: copy it into place while the Gateway is stopped, then
follow [Restore a database](#restore-a-database).

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

The target must not exist or must be empty, and it must not be inside the live
state directory or any configured live agent directory. OpenClaw verifies
archive structure, the manifest, hardlinks, symbolic-link containment, and
SQLite databases before it writes the target. A non-empty target is refused,
and a failed extraction cleans its incomplete output. The command never writes
into live state or agent roots and has no force or in-place mode. Treat the
restored directory as sensitive: it can contain credentials, auth profiles,
sessions, and workspace data.

<Warning>
  Restoring an archive is time travel. Messaging-channel credentials with
  ratchet state, especially WhatsApp, may desynchronize after rollback and need
  relinking. Approvals and delivery/dedupe state also roll back, so review
  pending approvals before resuming the Gateway. Plugin `node_modules` trees
  are not archived; after activation, run `openclaw plugins update <id>` or
  reinstall with `openclaw plugins install <spec> --force`. Run `openclaw
  skills list` or start an agent session to regenerate the omitted
  `plugin-skills/` symlink index from current plugin metadata.
</Warning>

The schema-version-1 manifest records `archiveRoot`, the original paths under
`paths`, an `assets[]` list, and additive configured-agent ownership metadata.
Each asset includes its `kind`, original `sourcePath`, and `archivePath` inside
the tarball. An external custom agent root has kind `agent` when it needs its
own source; roots already covered by a state or workspace asset appear in
ownership metadata without duplicating archive entries. Use the asset and
ownership fields as the source of truth; do not derive the archive root from
the archive filename or reconstruct agent paths from the default layout. Older
archives without additive ownership metadata remain verifiable.

The archive layout is:

```text
<archive-root>/manifest.json
<archive-root>/payload/posix/<absolute-source-path-without-leading-slash>/...
<archive-root>/payload/windows/<DRIVE>/<rest>/...
<archive-root>/payload/relative/<relative-source-path>/...
```

To activate, stop the Gateway and any node hosts that use the restored files.
Make a fresh backup of current state or move it aside. Then move the extracted
state asset into place, or point `OPENCLAW_STATE_DIR` at that asset. Restore
every custom agent root using its recorded agent id and original source path;
either preserve its configured `agentDir` or update that setting to its new
location. On a new machine or under a different home directory, also use the
manifest to map config, credentials, and workspace assets to their new paths.
Run `openclaw doctor` before restarting the Gateway. See
[Updating](/install/updating#rollback) for the rollback workflow.

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
