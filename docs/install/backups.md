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
- Regular protection: schedule either command and sync the output offsite.
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

Use your platform scheduler. A nightly cron example that snapshots the
control-plane database and the `main` agent database:

```bash
0 3 * * * openclaw backup sqlite create --global --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
5 3 * * * openclaw backup sqlite create --agent main --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
```

On macOS, a `launchd` job works the same way; on servers provisioned from the
[hosting guides](/install), a systemd timer is the natural fit. `--json`
emits one machine-readable result per run, so the log doubles as a backup
audit trail. Prune old snapshot directories on your own retention schedule.

## Copy backups offsite

Archives and snapshot repositories are plain files, so any sync tool works.
An `rclone` example targeting an S3-compatible bucket:

```bash
rclone sync ~/Backups/openclaw-sqlite remote:openclaw-backups/sqlite
```

Because every archive and snapshot is a full copy, offsite syncs re-upload
each new backup in full. Deduplicating backup tools such as `restic` reduce
storage at the destination but still read full snapshots as input. When
upload size per backup matters, use continuous replication instead.

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
up](/cli/backup#what-gets-backed-up). Archives intentionally omit volatile
files, plugin dependency trees, and installer-managed runtime roots such as
state-local `tmp/`. Recreate those artifacts after restore.

Verify before extracting, then stage the archive in a private temporary
directory:

```bash
set -euo pipefail

ARCHIVE=./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz

openclaw backup verify "$ARCHIVE"

restore_dir="$(mktemp -d -t openclaw-restore.XXXXXX)"
trap 'rm -rf "$restore_dir"' EXIT

tar -xzf "$ARCHIVE" -C "$restore_dir"
manifest_path="$(find "$restore_dir" -mindepth 2 -maxdepth 2 -name manifest.json -print -quit)"
test -n "$manifest_path"
cat "$manifest_path"
```

Treat the staging directory as sensitive. It can contain credentials, auth
profiles, sessions, and workspace data. The `trap` removes it when the shell
exits.

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

Before copying files back, stop the Gateway and any node hosts that use them.
Make a fresh backup of the current state or move the current directories
aside. Restore the smallest set of assets needed.

For example, this restores the state asset to the current user's default
state directory. The target stays absent until `cp -a` creates it, preserving
the staged directory's mode and metadata:

```bash
set -euo pipefail

state_archive_path="$(
  node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(manifest.assets.find((asset) => asset.kind === "state")?.archivePath ?? "");' "$manifest_path"
)"
test -n "$state_archive_path"

state_source="$restore_dir/$state_archive_path"
state_target="$HOME/.openclaw"
state_backup="$HOME/.openclaw.pre-restore.$(date +%s)"

test -d "$state_source"
openclaw gateway stop

if [ -e "$state_target" ] || [ -L "$state_target" ]; then
  mv "$state_target" "$state_backup"
fi
test ! -e "$state_target"
test ! -L "$state_target"
cp -a "$state_source" "$state_target"

openclaw doctor
openclaw gateway start
openclaw health
openclaw status
```

For a same-machine restore, the manifest `sourcePath` values are usually the
intended targets. On a new machine or under a different home directory,
choose the new targets first, then copy only the matching asset payloads.
Typical full-restore targets are the state directory, active config file,
credentials directory, and workspace directories. See
[Updating](/install/updating#rollback) for the rollback workflow.

### Restore a database

For a snapshot, `openclaw backup sqlite restore <snapshot-directory> --target
<new-database-path>` writes a re-verified database to a fresh target. For
Litestream, `litestream restore` writes a fresh database file. Move either
result into place while the Gateway is stopped, then start the Gateway and
check `openclaw health` and `openclaw doctor`.

After restoring onto a different OpenClaw version, preflight the database
first with `openclaw database preflight`; see
[Database schemas](/reference/database-schemas#preflight-a-target-release).

## Related

- [Agent workspace](/concepts/agent-workspace#git-backup-recommended-private) for keeping workspace files in a private git repository
- [Backup CLI reference](/cli/backup)
- [Database schemas](/reference/database-schemas)
- [Migrating between machines](/install/migrating)
- [Updating](/install/updating)
