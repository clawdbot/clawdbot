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

Installing OpenClaw manually through npm bypasses the updater guard. Database open checks still refuse an incompatible build.

## Agent schema history

| Version | Change                                                                                                                                                                                                                                                         | First release                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1       | Initial per-agent store ([#88349](https://github.com/openclaw/openclaw/pull/88349))                                                                                                                                                                            | `v2026.5.30-beta.1`, stable through `v2026.7.1` |
| 2       | Memory index identity ([#104449](https://github.com/openclaw/openclaw/pull/104449))                                                                                                                                                                            | `v2026.7.2-beta.1`                              |
| 4       | Sessions and transcripts moved into SQLite ([#98236](https://github.com/openclaw/openclaw/pull/98236))                                                                                                                                                         | `v2026.7.2-beta.1`                              |
| 5-6     | Terminal freshness and state lifecycle ([#104859](https://github.com/openclaw/openclaw/pull/104859))                                                                                                                                                           | `v2026.7.2-beta.1`                              |
| 7       | Per-entry lifecycle status projection ([#106151](https://github.com/openclaw/openclaw/pull/106151))                                                                                                                                                            | `v2026.7.2-beta.1`                              |
| 8       | Per-transcript session provenance ([#106766](https://github.com/openclaw/openclaw/pull/106766))                                                                                                                                                                | `v2026.7.2-beta.2`                              |
| 9       | `STRICT` tables ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                                  | `v2026.7.2-beta.2`                              |
| 10      | Materialized active transcript paths ([#108851](https://github.com/openclaw/openclaw/pull/108851))                                                                                                                                                             | Unreleased                                      |
| 11      | Leases, durable delivery, conversation addresses, and heartbeat outcomes ([#109636](https://github.com/openclaw/openclaw/pull/109636), [#95838](https://github.com/openclaw/openclaw/pull/95838), [#109999](https://github.com/openclaw/openclaw/pull/109999)) | Unreleased                                      |

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

The Gateway preflight reads schema headers only. The background verifier owns the slower full scan for databases that do not need migration.
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

A newer OpenClaw build wrote your databases, and the running build is older. The error and the Gateway startup log name the build that owns the database (`app_version`). Install that version or newer, or use one of the options above. Do not edit the database to silence the error.

### A database is quarantined after integrity verification failed

The background verifier proved the file is corrupt, and every open now fails fast instead of rescanning. Restore the database from a backup or repair it, then run `openclaw doctor --fix` to clear the quarantine record. Doctor reports an explicit error if the quarantine record itself cannot be cleared; rerun it until it reports clean.

## Downgrades are unsupported

Manual schema downgrades are for agents and operators who accept the risk. [Create and verify a backup](/cli/backup) before editing any database. Stop the Gateway and every process that can open the database.

The general procedure is:

1. Read the target release's schema and migrations.
2. In one transaction, drop every table, index, trigger, and column introduced after the target version.
3. Set `PRAGMA user_version` and `schema_meta.schema_version` to the target version.
4. Run the target release's full database verification before starting the Gateway.

### Example: agent schema 11 to 9

Schema 10 added the active transcript projection. Schema 11 added leases, durable delivery, conversation-address state, and heartbeat outcomes. QMD coordination uses rows in `state_leases`; there is no separate QMD table to preserve.

Run equivalent SQL against each affected per-agent database after inspecting the exact schema that wrote it:

```sql
BEGIN IMMEDIATE;

DROP TABLE IF EXISTS heartbeat_outcomes;
DROP TABLE IF EXISTS conversation_deliveries;
DROP TABLE IF EXISTS state_leases;
DROP TABLE IF EXISTS session_transcript_active_events;

ALTER TABLE session_transcript_index_state DROP COLUMN active_event_count;
ALTER TABLE session_transcript_index_state DROP COLUMN active_message_count;
ALTER TABLE conversations DROP COLUMN delivery_target;

PRAGMA user_version = 9;
UPDATE schema_meta
SET schema_version = 9,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

This discards version 10-11 state, including in-flight delivery operations, leases, heartbeat outcomes, and the derived active transcript projection. A botched downgrade means restore from the verified backup.
