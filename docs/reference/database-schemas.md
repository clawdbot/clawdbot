---
summary: "OpenClaw SQLite database locations, schema versions, integrity checks, and downgrade recovery"
read_when:
  - Diagnosing a newer database schema error
  - Checking database compatibility before an update or downgrade
  - Recovering a database for an older OpenClaw release
title: "Database schemas"
---

OpenClaw stores control-plane state in a global SQLite database and agent data in one SQLite database per agent. Schema migrations run forward when a database opens. Older OpenClaw builds refuse databases written by a newer schema.

## Database layout

| Scope                | Default path                                               | Contents                                                                                              |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global control plane | `~/.openclaw/state/openclaw.sqlite`                        | Shared configuration state, registries, approvals, plugin state, and shared runtime state             |
| Per-agent data plane | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | Sessions, transcripts, memory indexes, auth state, conversation state, and agent-scoped runtime state |

A few high-volume or lifecycle-specific features use dedicated SQLite stores, including the task registry and trajectory data.

## Versioning contract

Each database records its schema in two places:

- `PRAGMA user_version` is the SQLite schema version.
- The primary `schema_meta` row records `role`, `agent_id`, `schema_version`, and `app_version`. `app_version` is the OpenClaw build that last wrote the schema metadata.

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. `openclaw update` also refuses a package or source target whose declared schema support is older than an on-disk database. Target packages published before schema metadata was added cannot be preflighted.

Changes may stay at the same schema version only when downgraded readers remain safe. New tables qualify because older builds ignore them. An explicitly compatible column on an existing table qualifies only when its declaration is exactly one bare nullable SQLite `STRICT` datatype: `ANY`, `BLOB`, `INT`, `INTEGER`, `REAL`, or `TEXT`. The declaration cannot have a default, `NOT NULL`, a primary or unique key, a check, a reference, a collation, a generated expression, or another suffix. Constrained existing-table additions require a schema-version bump or a companion table instead.

Matching numeric versions are necessary but not sufficient. A release can add a lazy or startup-repairable table, column, index, or trigger without advancing `user_version`, so two databases at the same version can still have different shapes. OpenClaw validates the canonical table definitions, constraints, indexes, triggers, virtual tables, and table options owned by the running release.

Installing OpenClaw manually through npm bypasses the updater guard. Database open checks still refuse an incompatible build.

## Preflight a target release

Before activating or rolling back a release, run that target release's CLI against one explicit copied state database:

```bash
openclaw database preflight <copied-state.sqlite> --json
```

The command does not read the default state directory or mutate the supplied file. It opens the supplied consolidated file as immutable/read-only, compares the target release's own schema contract, and reports one status:

- `exact`: the copied database matches the target release's runtime schema. Feature-local tables that are intentionally absent until first use do not require repair.
- `startup-repairable`: the numeric version matches and a runtime-owned additive difference remains; startup needs a write to converge the shape.
- `migration-required`: the database is older than the target release.
- `incompatible`: the database is newer, or its same-version shape has blocking drift such as an unexpected column.
- `indeterminate`: the file, integrity metadata, or ownership metadata could not be verified.

JSON output is identified by `schema: "openclaw.state-schema-preflight.v1"`.

Use a SQLite online backup or another WAL-aware snapshot produced while the source is safely coordinated. The resulting preflight input must be one consolidated file with no sibling `-wal`, `-shm`, or `-journal`; sidecars make the result `indeterminate`. Do not copy only the main `.sqlite` file from an active WAL database. Preflight the exact runtime that will be activated; a package version or numeric schema version alone does not prove same-version shape compatibility.

## Agent schema history

| Version | Change                                                                                                                                                                                                                                                 | First release                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1       | Initial per-agent store ([#88349](https://github.com/openclaw/openclaw/pull/88349))                                                                                                                                                                    | `v2026.5.30-beta.1`, stable through `v2026.7.1` |
| 2       | Memory index identity ([#104449](https://github.com/openclaw/openclaw/pull/104449))                                                                                                                                                                    | `v2026.7.2-beta.1`                              |
| 4       | Sessions and transcripts moved into SQLite ([#98236](https://github.com/openclaw/openclaw/pull/98236))                                                                                                                                                 | `v2026.7.2-beta.1`                              |
| 5-6     | Terminal freshness and state lifecycle ([#104859](https://github.com/openclaw/openclaw/pull/104859))                                                                                                                                                   | `v2026.7.2-beta.1`                              |
| 7       | Per-entry lifecycle status projection ([#106151](https://github.com/openclaw/openclaw/pull/106151))                                                                                                                                                    | `v2026.7.2-beta.1`                              |
| 8       | Per-transcript session provenance ([#106766](https://github.com/openclaw/openclaw/pull/106766))                                                                                                                                                        | `v2026.7.2-beta.2`                              |
| 9       | `STRICT` tables ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                          | `v2026.7.2-beta.2`                              |
| 10      | Materialized active transcript paths ([#108851](https://github.com/openclaw/openclaw/pull/108851))                                                                                                                                                     | Unreleased                                      |
| 11      | Durable delivery, conversation addresses, and heartbeat outcomes ([#109636](https://github.com/openclaw/openclaw/pull/109636), [#95838](https://github.com/openclaw/openclaw/pull/95838), [#109999](https://github.com/openclaw/openclaw/pull/109999)) | Unreleased                                      |
| 12      | Session-owned ACP parent-stream events                                                                                                                                                                                                                 | Unreleased                                      |
| 13      | Durable transcript rewrite watermarks                                                                                                                                                                                                                  | Unreleased                                      |
| 14      | Logical session nodes, generation windows, and node-owned artifact foreign keys                                                                                                                                                                        | Unreleased                                      |
| 15      | Board and session-sharing tables                                                                                                                                                                                                                       | Unreleased                                      |
| 16      | Legacy top-level transcript media fields retired                                                                                                                                                                                                       | Unreleased                                      |
| 17      | Tenant-free per-agent lease table retired after the last writer and routing arm were removed ([#121113](https://github.com/openclaw/openclaw/pull/121113), [#121615](https://github.com/openclaw/openclaw/pull/121615))                                | Unreleased                                      |

Version 3 was an unshipped development step folded into version 4.

## State schema history

| Version | Change                                                                                                   | First release       |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| 1       | Initial shared state database                                                                            | `v2026.5.30-beta.1` |
| 2       | Metadata-only message audit events ([#103903](https://github.com/openclaw/openclaw/pull/103903))         | `v2026.7.2-beta.1`  |
| 3       | `STRICT` tables and schema-drift hardening ([#108663](https://github.com/openclaw/openclaw/pull/108663)) | `v2026.7.2-beta.2`  |
| 4       | Session watch provenance replaces encoded sentinel rows                                                  | Unreleased          |

## Integrity checks

| When                                        | Check                                                           |
| ------------------------------------------- | --------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row       |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan |
| Gateway background verifier                 | Run the full scan about once daily and log results              |
| Doctor, backup verification, and compaction | Run the full scan before accepting or rewriting the database    |

The Gateway startup preflight reads schema headers only. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier owns the slower recurring full scan for live databases that do not need migration.
Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

## Troubleshooting

### Why you cannot go back after updating to 2026.7.2

Every release through `v2026.7.1` used agent schema 1 and state schema 1. The 2026.7.2 release train (starting with `v2026.7.2-beta.1`) migrates your databases forward on first start. That migration is one-way: the data is rewritten into the newer schema, and installing an older OpenClaw afterwards does not undo it. The older build refuses to start with a `newer schema version` error that names the build that owns the database.

Downgrading the binary never downgrades the data. If you must run a release older than 2026.7.2 after updating, you have three options:

1. Restore a backup taken before the update. [Create and verify backups](/cli/backup) before major updates.
2. Run the older build against a separate state directory (`OPENCLAW_STATE_DIR`). It starts fresh; your migrated data stays untouched for when you return to the newer build.
3. Follow the manual downgrade procedure below. It is unsupported and risks data loss without a verified backup.

Since 2026.7.2, `openclaw update` refuses to install a release that cannot open your current databases, so the updater will not put you in this situation. Installing an older version manually through npm bypasses that guard; the databases still refuse the old binary, but only after it is installed.

### The Gateway refuses to start with a newer schema version error

A newer OpenClaw build wrote your databases, and the running build is older. The error names the refusing install — release version, commit, and install root — plus the schema it supports and the schema it found.

Act on the install root, not the version. One release version string spans many `main` commits, schema levels, and same-version schema shapes, so two installs can both call themselves `2026.7.2` and still disagree about a database. A prerelease version may not exist on the `latest` npm tag at all: check `npm view openclaw dist-tags` before reinstalling, because the tag carrying the schema you need may be `beta`, and reinstalling from `latest` can move you further away.

A linked source checkout is the case where the commit misleads: `openclaw --version` reports the checkout's git HEAD, but the code actually executing is whatever `dist/` was last built. If the install root is a checkout, rebuild it (`pnpm build`) before concluding the version is wrong.

Open the database with a build that supports its schema, or point the older build at a separate `OPENCLAW_STATE_DIR`. Do not edit the database to silence the error.

### A database is quarantined after integrity verification failed

The background verifier proved the file is corrupt, and every open now fails fast instead of rescanning. Restore the database from a backup or repair it, then run `openclaw doctor --fix` to clear the quarantine record. Doctor reports an explicit error if the quarantine record itself cannot be cleared; rerun it until it reports clean.

## Downgrades are unsupported

Manual schema downgrades are for agents and operators who accept the risk. [Create and verify a backup](/cli/backup) before editing any database. Stop the Gateway and every process that can open the database.

The general procedure is:

1. Read the target release's schema and migrations.
2. In one transaction, drop every table, index, trigger, and column introduced after the target version.
3. Set `PRAGMA user_version` and `schema_meta.schema_version` to the target version.
4. Run the target release's full database verification before starting the Gateway.

### Example: agent schema 17 to 16

Schema 17 removed the tenant-free per-agent lease table. A schema 16 build still requires that canonical table, so a manual downgrade must recreate its exact schema before lowering the version.

Run equivalent SQL against each affected per-agent database after inspecting the exact schema that wrote it:

```sql
BEGIN IMMEDIATE;

CREATE TABLE state_leases (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;

CREATE INDEX idx_agent_state_leases_expiry
  ON state_leases(expires_at, scope, lease_key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX idx_agent_state_leases_owner
  ON state_leases(owner, updated_at DESC);

PRAGMA user_version = 16;
UPDATE schema_meta
SET schema_version = 16,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

The recreated table starts empty because schema 17 has no agent-DB lease tenants to preserve. A botched downgrade means restore from the verified backup.
