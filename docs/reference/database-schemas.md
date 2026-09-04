---
summary: "OpenClaw SQLite database locations, schema versions, integrity checks, and downgrade recovery"
read_when:
  - Diagnosing a newer database schema error
  - Checking database compatibility before an update or downgrade
  - Proposing a SQLite or persistent-store change
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

### Meeting transcript tables

Meeting captures use three `STRICT` tables in the shared
`state/openclaw.sqlite` database, separate from per-agent conversation transcripts.
The transcript store (`src/transcripts/store.ts`) owns their reads and writes;
`src/transcripts/sqlite-schema.ts` ensures the tables on first use. Markdown and
JSON files under the transcripts directory are explicit exports, not runtime
storage. See [Transcripts CLI](/cli/transcripts).

#### `meeting_transcript_sessions`

One row per capture identity. The primary key is `(session_id, started_at)`;
`selector` is unique. Indexes support start-time, session-ID, slug, and export-key
lookups.

| Columns                                  | Type                                        | Purpose                                                                 |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `session_id`, `started_at`               | `TEXT NOT NULL`                             | Capture ID and original start time.                                     |
| `selector`, `export_key`, `session_slug` | `TEXT NOT NULL`                             | Canonical selector and derived export identity.                         |
| `provider_id`, `source_json`             | `TEXT NOT NULL`                             | Source provider and locator.                                            |
| `title`, `stopped_at`, `metadata_json`   | Nullable `TEXT`                             | Display title, terminal time, and session metadata including ownership. |
| `export_manifest_json`                   | `TEXT NOT NULL`, default `{}`               | Export artifact ownership manifest.                                     |
| `export_pending_json`                    | `TEXT NOT NULL`, default `[]`               | Pending export artifacts.                                               |
| `next_utterance_seq`                     | Nonnegative `INTEGER NOT NULL`, default `0` | Next append sequence.                                                   |
| `created_at_ms`, `updated_at_ms`         | Nonnegative `INTEGER NOT NULL`              | Store timestamps.                                                       |

Reopening an occupancy-driven capture clears `stopped_at` without changing the
primary key, so the same meeting retains its utterances.

#### `meeting_transcript_utterances`

Append-ordered speech records. The primary key is
`(session_id, session_started_at, sequence)`; the session pair references
`meeting_transcript_sessions(session_id, started_at)` with `ON DELETE CASCADE`.

| Columns                                  | Type                           | Purpose                                          |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `session_id`, `session_started_at`       | `TEXT NOT NULL`                | Owning capture identity.                         |
| `sequence`                               | Nonnegative `INTEGER NOT NULL` | Stable append order within the capture.          |
| `utterance_id`, `started_at`, `ended_at` | Nullable `TEXT`                | Provider utterance identity and timing.          |
| `speaker_id`, `speaker_label`            | Nullable `TEXT`                | Provider speaker identity and display label.     |
| `text`                                   | `TEXT NOT NULL`                | Captured transcript text.                        |
| `final`                                  | Nullable `INTEGER`, `0` or `1` | Whether the provider marked the utterance final. |
| `metadata_json`                          | Nullable `TEXT`                | Provider utterance metadata.                     |

#### `meeting_transcript_summaries`

One current summary per capture. The primary key is
`(session_id, session_started_at)` and references the session primary key with
`ON DELETE CASCADE`. At least one of `summary_json` or `markdown` must be non-null.

| Columns                            | Type                           | Purpose                                                                                                     |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `session_id`, `session_started_at` | `TEXT NOT NULL`                | Owning capture identity.                                                                                    |
| `generated_at`                     | Nullable `TEXT`                | Summary generation time.                                                                                    |
| `summary_json`                     | Nullable `TEXT`                | Free-form summary, including participants, `source` (`model` or `heuristic`), and optional model reference. |
| `markdown`                         | Nullable `TEXT`                | Rendered meeting notes.                                                                                     |
| `utterance_count`                  | Nonnegative `INTEGER NOT NULL` | Number of utterances covered by the stored summary.                                                         |

These are existing feature-local tables. Occupancy episodes and model-backed
notes do not change their schema or database version.

## Versioning contract

Each database records its schema in two places:

- `PRAGMA user_version` is the SQLite schema version.
- The primary `schema_meta` row records `role`, `agent_id`, `schema_version`, and `app_version`. `app_version` is the OpenClaw build that last wrote the schema metadata.

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. `openclaw update` also refuses a package or source target whose declared schema support is older than an on-disk database. Target packages published before schema metadata was added cannot be preflighted.

When Gateway startup encounters a newer database schema, it exits with status 78 so the generated systemd service does not restart it repeatedly. On macOS, it also parks its managed LaunchAgent to stop `KeepAlive` retries. This applies to failures during CLI bootstrap as well as server startup and does not depend on the database-backed crash counter. Start the Gateway with a build that supports the existing schemas. The older install cannot repair them with `doctor --fix`; run Doctor from the compatible install if further migration is required, then restart through the service or deployment owner.

Changes may stay at the same schema version only when downgraded readers remain safe. New tables qualify because older builds ignore them. An explicitly compatible column on an existing table qualifies only when its declaration is exactly one bare nullable SQLite `STRICT` datatype: `ANY`, `BLOB`, `INT`, `INTEGER`, `REAL`, or `TEXT`. The declaration cannot have a default, `NOT NULL`, a primary or unique key, a check, a reference, a collation, a generated expression, or another suffix. Constrained existing-table additions require a schema-version bump or a companion table instead.

Matching numeric versions are necessary but not sufficient. A release can add a lazy or startup-repairable table, column, index, or trigger without advancing `user_version`, so two databases at the same version can still have different shapes. OpenClaw validates the canonical table definitions, constraints, indexes, triggers, virtual tables, and table options owned by the running release.

Agent schema 19 records collected input consumption in the nullable
`session_pending_inputs.consumed_event_id TEXT` column. Doctor and the feature's
first-use ensure add it when needed; the schema version stays 19. The supported
beta upgrade runs Doctor from the upcoming release. Intermediate builds that
already validate the optional pending-input table may reject the added column
despite sharing version 19. Consumed source receipts remain until their session
window is deleted, so rewriting a transcript cannot make an old input runnable again.

The placement-move table uses this same-version rule for its nullable bare
`abandon_source INTEGER` column. The feature lazily ensures the column on first
move use. `NULL` means ordinary reconcile-first movement; `1` records the
operator's explicit offline-device abandonment decision so restart recovery
cannot accidentally resume remote reconciliation. Older readers ignore the
column and can reopen the same database safely.

Conversation associations use the same rule for the nullable bare
`route_context_json TEXT` column. The database-open repair ensures the column
for updated binaries. Older readers ignore it and can reopen and update the
same database safely; their association update invalidates context captured by
a newer writer so it cannot be replayed after re-upgrade.

Transcript context eligibility uses a bare nullable
`session_transcript_active_events.context_eligible INTEGER` column without
changing agent schema 18. Database open installs the column and a non-unique
partial index of unclassified rows. `1` includes an entry in bounded context
acquisition, `0` excludes display-only activity, and `NULL` means the projection
still needs reconciliation. Bootstrap control markers remain eligible; history
counts, positions, and cursors do not change. Raw transcript JSON stays canonical.

Older same-version writers can append or rebuild without supplying eligibility.
The existing transcript reconciler detects their `NULL` rows even when its
sequence watermark is current, then rebuilds from raw events before publishing
readiness. Readers return a retryable projection-unavailable result while this
work is pending; they do not parse every payload or guess eligibility. Initial
index creation scans projection metadata once, and startup awaits reconciliation
with off-thread parsing and bounded write chunks. Total rebuild cost remains
proportional to history. Rewrites invalidate or rebuild the projection in their
own transaction, and transcript deletion removes its eligibility rows. Downgrade
leaves the additive column and index intact; re-upgrade reconciles unknown rows.

User profiles use the same rule for the nullable bare `user_profiles.role TEXT`
column in state schema 9. Operator-role assignment lazily ensures the column on
first use. Older readers ignore the column and can reopen the same database
safely.

Web Push subscription ownership uses the same rule for nullable bare
`web_push_subscriptions.device_id TEXT`, `user_profile_id TEXT`, and
`preferences_json TEXT` columns. Web Push lazily ensures all three columns on
first use. Existing rows remain unbound and test-only until the browser
reconnects; older readers ignore the columns and continue reading or updating
the endpoint and key fields safely.

Approval-notification cleanup uses the same-version additive
`web_push_approval_deliveries` table. It records the approval/subscription
identifiers plus the request-time device/profile binding for notifications that
may have reached a browser. A terminal or restarted Gateway sends only when the
current subscription still has that binding. The table is lazily created on
first use, rows cascade away with their approval or subscription, and older
readers ignore it safely.

Installing OpenClaw manually through npm bypasses the updater guard. Database open checks still refuse an incompatible build.

Structured [Goal controls](/tools/goal#gateway-requests-and-retries) use a lazy
per-agent `session_goal_operations` table without changing the schema version.
Goal start/resume commits the Goal transition, input turn, run lifecycle, and
operation receipt in one transaction. Management operations commit the Goal
transition and receipt together. Older readers ignore the added table.
Receipts survive Goal clear and session reset/deletion until their 24-hour
validity expires; later Goal writes prune expired rows. They retain the
original result and a keyed request fingerprint, not a second raw request.
There is no backfill or configuration switch. Downgrading preserves the table
but disables the new structured controls; upgrading can read retained receipts.

### Profile-owned skill library

[Personal and team skills](/tools/skills#personal-skills-on-a-shared-gateway) use four first-use tables in the shared state database without changing its schema version: `skill_library_entries`, `skill_library_revisions`, `skill_library_events`, and `skill_library_uploads`. Ordinary workspace skills and unused-library discovery do not create these tables. Ownership, sharing, the current revision pointer, portable file manifests, and publication events are canonical SQLite data. Session selections remain in the existing per-agent session store; inherited cron selections remain in the existing private job record.

Complete skill bundles are product artifacts under `<state-dir>/skill-library/<skill-id>/revisions/<revision-hash>/`. Publication writes and verifies an immutable bundle before committing its current pointer and event in one synchronous database transaction. Concurrent edits require the expected revision. A crash before that commit can leave an unreferenced complete bundle, but not a pointer to partially written content. Sharing and transfer change metadata without moving revision files.

Removing a skill excludes it from future selections; existing sessions retain their selected revisions. Published history and complete orphan revisions are retained conservatively. Expired upload records are pruned when another upload begins; clearly abandoned staging directories are cleaned during later publication. Back up both the state databases and the skill-library directory, not just the current revision pointers.

Older same-schema readers ignore the new tables but cannot provide managed-library selection or authoring. Keep the tables and bundle directory intact when changing builds; do not lower schema markers or delete revisions to disable the feature. The accepted storage and ownership decision is recorded in [the profile-owned skills design issue](https://github.com/openclaw/openclaw/issues/133602).

## Personal GitHub connections and publication

Personal GitHub connection state uses the existing `secret_store_entries` identity scope, with the canonical authenticated profile as `scope_id` and the fixed private name `github-connection`. It is not a generic identity-secret API or a profile preference. One bounded record owns selection, pending device authorization, and refresh recovery. Personal managed CLI credentials use a separate `credentials/github/personal/<opaque-profile-id>` directory, outside older system/agent cleanup roots.

Personal publication uses the lazy, same-version `github_personal_publication_requests` table. It records the requesting profile, selected connection generation and account, immutable target/workspace snapshot, idempotency, and outcome; it contains no tokens. Reading status does not create the table. Existing system and agent requests remain in their original table and retain their existing lifecycle.

Older builds ignore both the personal request table and identity-scoped credential rows instead of executing a personal request as System. Re-upgrade still enforces original authorization expiry. Unfinished personal publication requires fresh confirmation by the same authenticated owner after a Gateway restart; remote-result reconciliation reuses the original request markers.

Disconnect removes usable local credentials and retains a secret-free disconnected selection to fence stale work. Profile merges preserve target state, including an explicit disconnection; a source connection transfers only when the target has no state, with new selection authority. Credentials stranded by a profile merge performed on an older build require reconnect, not runtime adoption through aliases.

Personal publication receipts remain for the logical session's lifetime. Archive/reset preserves receipts and invalidates incompatible unfinished work. Permanent session deletion fences execution and removes its personal receipts. There is no timed idempotency expiry, and deleting local state does not undo an already-created GitHub commit or pull request.

See the accepted [personal GitHub ownership and publication design](https://github.com/openclaw/openclaw/issues/133590) and the operator-facing [GitHub connections guide](/concepts/user-model#github-connections).

## Personal model accounts

Personal model accounts use the existing `secret_store_entries` identity scope, keyed by the canonical Gateway profile. A versioned `model-accounts` record owns provider selections, while each `model-account:<profile-id>` record owns one inline OAuth or token credential and its usage state. Each record retains the existing 64 KiB secret-store limit; connecting more accounts or merging profiles does not combine credentials under one size limit. This adds no table, column, index, or schema version. Generic secret-list/read methods and profile preferences do not expose these records.

The credential and its selected link commit in one synchronous transaction after the Gateway revalidates the initiating authorization. Runtime loads only an explicitly selected credential and routes refresh and usage updates to that same owner. Shared and agent-local auth saves exclude the reserved personal-profile namespace, including runtime snapshots and CLI mirrors.

Unlink records an explicit disconnected selection and retains credentials used by existing session pins. A verified identity merge transfers only the live source's records, preserving the target's selections and disconnections while retaining old credential IDs for pinned sessions. Credentials stranded on an alias by an older build are not adopted at runtime. A compatible downgrade leaves private records outside the older shared-account pool; re-upgrade can use retained records, while accounts stranded by older identity merges need reconnecting.

See [Per-person model accounts](/concepts/multi-user#per-person-model-accounts) for connection, cancellation, session billing, and unlink behavior.

## Apple companion delivery journals

Companion Watch chat has separate app-local storage. It does not change the
Gateway control-plane or per-agent database schema, and `openclaw doctor`
does not migrate it. Open the updated iPhone and Watch apps to use the new
delivery protocol. See [Watch voice and chat](/platforms/ios#apple-watch-voice-and-chat)
for delivery statuses and recovery.

The iPhone's existing `client-state.sqlite` owns `watch_message_journal`.
The named GRDB migration `client-state-watch-message-journal-v9` adds that table
and a nullable `watch_route_generation TEXT` column to
`gateway_routing_identity`. The generation changes after Forget and re-pairing;
a late callback or queued command from the old pairing cannot become new work.
Admission, accepted run identity and terminal receipt state share one journal
owner, separate from the general chat outbox.
The journal's nullable `command_fingerprint BLOB` stores SHA-256 of each
admitted command's canonical bytes. Dismiss preserves this hash, so reusing an
ID with changed content or submission time cannot return the original result
after its command text is cleared. The hash expires with the row or is removed
by Forget; legacy imports have no command fingerprint.
The migration is registered by shared Apple client storage, so the Mac client
also sees the additive schema; it does not process companion Watch delivery.

The additive `client-state-watch-message-legacy-receipts-v1` migration creates
`watch_message_legacy_imports`. It stores SHA-256 hashes of exact legacy command
IDs and imported content, never the text or Gateway ID. A nullable content hash
records the older app's ID-only recent-message suppression policy; it is not
proof of a matching body or successful execution.

Old Watch UserDefaults are decoded and reconciled in one SQLite transaction
whenever the phone prepares its journal. Imported rows and their hash receipts
commit together before cleanup checks that both source blobs are unchanged.
This also recovers messages written by an older app after downgrade. Unprovable
queued text becomes **Needs review**, never an automatic send. Conflicting IDs
or unseen messages associated with a previously forgotten Gateway preserve the
source and surface a recovery error instead of discarding or retargeting text.

Imported text remains until explicit discard or Gateway Forget. Its hash-only
receipt has no timed expiry and survives both actions, so an identical old
snapshot cannot resurrect deleted text. This storage grows per legacy ID and is
removed only by a full onboarding reset, which clears the old UserDefaults
before deleting client state. New commands and their reply replay instead have
an immutable 48-hour deadline. Dismiss hides a completed card without changing
its receipt, acknowledgment state or deadline; active deliveries cannot be
discarded or dismissed.
Expired copies are pruned when delivery state is next used, including opening
the phone's delivery list. An idle or suspended app does not promise immediate
wall-clock erasure.

The Watch owns its outbound commands and received results in its own SQLite
journal. A 90-second speech timeout does not remove this delivery state or
cancel the remote run. Both apps commit before issuing their application-level
admission or terminal receipt. A permanent rejection is explicitly not an
admission and creates no phone journal row. If dispatch became ambiguous before an accepted run was recorded,
recovery reports uncertainty rather than automatically executing the message
again. The phone retains its current WAL policy: this is app-termination
recovery, not a claim of power-loss durability.

Forget removes phone journal rows in the existing irreversible removal
transaction, including rows imported without a routing parent. The phone first
accounts for retained legacy source and refuses removal if that cannot be done
safely. The additive
schema leaves the old reader's explicit routing updates intact, and a deletion
trigger keeps its Forget path effective after downgrade. An older app cannot
offer the new receipt protocol. Do not remove migration markers or reset
`client-state.sqlite` to downgrade: that file also contains other user-owned
client state.

The [accepted design](https://github.com/openclaw/openclaw/issues/136617) records
the schema, migration, ownership, retention and validation boundaries.

## Review checkpoint for material changes

Before implementing a material SQLite or persistent-store change, open or link a maintainer discussion and record acceptance of the design. A schema-version bump is always material, but a change can be material even when the numeric version stays the same.

Treat a change as material when it introduces or materially changes any of these:

- a table, dedicated database, durable projection, cache, index, or other persisted representation
- which data is canonical, derived, reconstructible, retained, deleted, exported, or visible after restart
- user-visible persistence semantics, including a second interpretation of existing durable data
- migration, backfill, repair, downgrade, rollback, retention, compaction, or corruption recovery
- transaction boundaries, writer ownership, concurrency, locking, publication fencing, or reader consistency
- read, write, disk, startup, or maintenance cost enough to affect the store's operating model

The discussion should identify the owning store and lifecycle, the problem being solved, alternatives that avoid new persistence, canonical versus derived data, schema and upgrade/downgrade behavior, retention and deletion behavior, concurrency and recovery invariants, performance/storage impact, rollback plan, and validation limits. The implementing PR must link the accepted decision.

The checkpoint normally does not apply to a read-only query that preserves existing semantics, a bounded query-plan improvement with no material write/disk tradeoff, routine maintenance of an existing approved schema, or tests, generated baselines, and documentation that only follow an already accepted design. A mechanical migration or repair still links the decision that approved its persistent contract.

For an urgent data-loss, security, or recovery fix, a maintainer may authorize a narrowly scoped exception before implementation. The appropriate public or private review record must capture the reason, temporary scope, rollback and validation plan, and any follow-up needed for the full design decision. The exception accelerates the design record; it does not waive review before merge.

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
| 18      | Canonical participant identity namespaces and explicit unknown historical input times in the existing session-owned aggregate ([#130661](https://github.com/openclaw/openclaw/issues/130661))                                                          | Unreleased                                      |
| 19      | Source-qualified immutable session creators; historical ambiguity remains unknown                                                                                                                                                                      | Unreleased                                      |

Version 3 was an unshipped development step folded into version 4.

### Creator namespace migration

Agent schema **19** and shared-state schema **14** add a source discriminator to human creator actors in the existing session and cron JSON records. No table, sidecar, or separate identity ledger is added. The session node remains the immutable creator owner; mutable owner assignments and explicit sharing grants are unchanged.

Historical human creators stamped directly by `operator` or `run` creation become `profile`; channel creation becomes `channel`. Origin-losing cron, inherited spawn or Talk, legacy `createdBy`, and missing-source history remain `unknown`. The migration preserves IDs, attribution, creation times, content, and existing sandbox restrictions. A UUID, profile lookup, participant, current route, or required sandbox never supplies missing creator authority. Recovery from incomplete physical projections also produces unknown human attribution.

Before upgrading, stop the Gateway and all other writers, then [create and verify a WAL-aware backup](/cli/backup). Run `openclaw doctor --fix` with the new build. The agent migration retains the stopped-writer maintenance gate and runs after the schema-18 participant migration, without rebuilding already migrated participant rows. Canonical data and both schema markers commit in the owning database transaction. Shared-state and agent databases are separate transactions; if one fails, keep writers stopped and rerun Doctor before starting the Gateway.

Older builds refuse the new versions. For rollback, stop all writers and restore the verified pre-upgrade backups with their matching older build. Do not decrement either schema marker: an older writer cannot maintain the creator-source contract. Unknown historical provenance is irrecoverable from the stored ID alone. Administrators retain sharing management access; assigning responsibility does not restore an implicit creator grant.

Required sandbox resources keep their existing keys for proven profile creators. Channel and unknown creators instead use canonical-session isolation, with no new persisted principal field. Their old ambiguous resources are left untouched by migration, not automatically adopted or copied; operators must recover needed files explicitly before ordinary retention or cleanup. See [sandbox scope and recovery](/gateway/sandboxing#modes-scope-and-backend).

### Participant identity migration

Agent schema 18 rebuilds `session_participants` with the unique key `(session_key, identity_namespace, actor_id)`. The raw actor ID remains separate from its namespace. This replaces the old `(session_key, actor_type, actor_id)` key; it is not a same-version additive change. Both schema markers advance together. No companion table or per-input ledger is added.

Before upgrading existing data, take a verified, WAL-aware backup and stop the Gateway and other agent-database writers. Run `openclaw doctor --fix` with the new build. The migration uses the existing maintenance lease to reject active writers and fence new claims. Ordinary runtime opens refuse the old participant schema rather than migrating it behind active readers. Earlier structural and media migrations run in their historical order before participant convergence. Explicit Doctor repair exits nonzero if an existing configured, default-layout, or registered database still fails runtime schema readiness, including when a live writer or an unknown table dependency blocks this migration. Readiness uses the same target discovery as migration without registering, pruning, or creating stores. Archive migration warnings remain advisory when required database schemas are ready.

Membership and recorded contribution aggregates survive. Historical profile timestamps are unknown because earlier source promotion could contaminate them even when a contribution count was present. Supported agent and channel-only observation times remain; an unresolved historical channel domain stays unresolved. Migration does not invent missing channel rows or inspect transcripts to reconstruct identities. New observations do not turn an unknown first input time into a claimed first-ever time.

The rebuild, data copy, version markers, and foreign-key validation commit atomically. Unknown table shapes or database-local dependents are refused. A failed migration rolls back rather than leaving a partial replacement table. Older builds refuse schema 18; do not decrement either version marker or restore the old unique key. Downgrade recovery requires the verified pre-migration backup.

Normal admission remains bounded at 32 identities. Same-store alias repair sums aggregates; retryable cross-store copies retain the larger recorded aggregate. Repairs preserve already-retained histories above the admission bound. Reset retains logical-session participation, while deletion removes it with the session node.

## State schema history

| Version | Change                                                                                                                                                                                                                                                                                                                          | First release       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1       | Initial shared state database                                                                                                                                                                                                                                                                                                   | `v2026.5.30-beta.1` |
| 2       | Metadata-only message audit events ([#103903](https://github.com/openclaw/openclaw/pull/103903))                                                                                                                                                                                                                                | `v2026.7.2-beta.1`  |
| 3       | `STRICT` tables and schema-drift hardening ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                                                                        | `v2026.7.2-beta.2`  |
| 4       | Session watch provenance replaces encoded sentinel rows                                                                                                                                                                                                                                                                         | Unreleased          |
| 5       | Durable cloud-worker result references on pending workspace fences ([`7a7d6bb`](https://github.com/openclaw/openclaw/commit/7a7d6bb51f42bd896de2b8a4df2ee66f3dce0a21), [#110952](https://github.com/openclaw/openclaw/pull/110952))                                                                                             | `v2026.7.2-beta.4`  |
| 6       | Every committed shared-state table becomes part of the canonical runtime schema ([`509a5f0`](https://github.com/openclaw/openclaw/commit/509a5f03737642fec4a940e6d605887f7957ddc8), [#113473](https://github.com/openclaw/openclaw/pull/113473))                                                                                | `v2026.7.2-beta.5`  |
| 7       | Retired inferred-commitment storage removed                                                                                                                                                                                                                                                                                     | Unreleased          |
| 8       | Cloud-worker placement execution modes and mode-aware turn claims                                                                                                                                                                                                                                                               | Unreleased          |
| 9       | In-root agent database registry paths stored relative to the state directory                                                                                                                                                                                                                                                    | Unreleased          |
| 10      | Six dead tables retired (agent_model_catalogs, android_notification_recent_packages, command_log_entries, diagnostic_stability_bundles, media_blobs, model_capability_cache)                                                                                                                                                    | Unreleased          |
| 11      | Legacy skill curator lifecycle table and never-read proposal origin-run projection retired                                                                                                                                                                                                                                      | Unreleased          |
| 12      | Thirteen singleton/cache tables retired; durable state folded into config_machine_state                                                                                                                                                                                                                                         | Unreleased          |
| 13      | State consolidation: cron jobs and subagent runs become JSON-canonical (113 projection columns, five unused indexes removed); installed_plugin_index and shared auth-profile singletons fold into config_machine_state; workspace_attestations merges into workspace_setup_state; gateway origin device tokens become canonical | Unreleased          |
| 14      | Source-qualified cron creator capture; historical human job creators remain unknown                                                                                                                                                                                                                                             | Unreleased          |
| 15      | Conversation bindings use exact target keys; redundant agent/session projections removed                                                                                                                                                                                                                                        | Unreleased          |

### State schema 15

Schema 15 removes `target_agent_id` and `target_session_id` from `current_conversation_bindings`. The target index uses the complete `target_session_key` and remains non-unique: several conversations may point at the same destination. This lets plugin-owned targets persist without inventing an OpenClaw agent owner. Channel/account isolation, plugin approvals, binding identifiers, target keys, JSON metadata, expiry, and detach behavior are unchanged.

Startup and `openclaw doctor --fix` run the migration in the existing exclusive write transaction. They remove only the two projections and replace the target index, preserving all other row values. A dependent trigger, index, or failed schema check rolls the transaction back; migration does not discard an unknown dependency to force the upgrade. Column removal rewrites the binding table, so upgrade cost scales with its size.

Stop older writers and create a verified, WAL-aware backup before upgrading. Builds supporting shared-state schema 14 or earlier refuse the migrated database. To return to an older build, restore that pre-upgrade backup into a separate state directory; do not lower the version markers or reconstruct an agent projection. See [downgrade limitations](#downgrades-are-unsupported) for the general recovery contract.

### State schema 13

Schema 13 makes `cron_jobs.job_json`, `cron_jobs.state_json`, and `subagent_runs.payload_json` the canonical records. Physical columns remain only where production queries, ordering, or runtime-only updates require them. Cron jobs shrink from 75 columns to 15, and subagent runs shrink from 59 columns to six. Migration preserves failure-destination fields explicitly configured as undefined by encoding them as JSON `null`; it also normalizes legacy run-status aliases into `state_json` before removing the redundant projections.

The shared-state `auth_profile_stores` and `auth_profile_state` singletons move into `config_machine_state` under `authProfiles.store` and `authProfiles.state`; per-agent auth tables remain unchanged. Because these rows contain credentials, secret-redacted Git backups omit the `authProfiles.` machine-state prefix.

### State schema 11

Schema 11 removes the `skill_lifecycle` and `skill_workshop_proposal_origin_runs` tables. Archived-skill lifecycle state is discarded during the upgrade: previously archived Workshop skills return to the active collection, where weekly collection review judges them by content. The origin-run rows were a never-read projection; canonical proposal provenance stays in `skill_workshop_proposals.record_json`. Recorded skill usage and collection-review state are preserved.

### State schema 9

Schema 9 stores an `agent_databases.path` value relative to the state directory when the registered agent database is inside that directory. During migration, a foreign default-layout row is re-anchored to the in-root counterpart when that file exists. It is deleted only when the same agent already holds its in-root registration, because dual default-layout registrations cannot produce a valid combined session list. Otherwise, the absolute row is preserved, so genuine external registrations are never deleted. This keeps a copied state directory self-contained without dropping supported external database paths.

## Integrity checks

| When                                        | Check                                                           |
| ------------------------------------------- | --------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row       |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan |
| Gateway background verifier                 | Run the full scan about once daily and log results              |
| Doctor, backup verification, and compaction | Run the full scan before accepting or rewriting the database    |

The Gateway startup preflight reads schema headers only. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier owns the slower recurring full scan for live databases that do not need migration.
Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

Background verification errors retain the original name and message and append bounded Node `code` and SQLite `errcode` values from up to eight cause-chain nodes. These diagnostics do not change the verdict: I/O failures remain inconclusive, while proven corruption is reconfirmed by the database owner before quarantine. A generic `disk I/O error` (`errcode=10`) does not establish disk exhaustion.

Agent database maintenance fences other writers with a 60-second lease in the shared state database. A dedicated worker renews that lease during synchronous integrity scans and migration phases. Maintenance still checks the exact persisted owner before mutations and commit, and stops if the heartbeat fails or ownership expires or changes. Finishing or cancelling maintenance stops renewal before releasing the lease; process death leaves at most the remaining lease duration.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## Troubleshooting

`SQLite read-only worker` failures append `code` and numeric SQLite `errcode` diagnostics when the underlying error supplies valid values, including through a bounded cause chain. Report the full code suffix when investigating a failure. A generic `disk I/O error` or `SQLITE_IOERR` alone does not prove the disk is full.

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

When a Gateway runs from a linked source checkout, its status and schema-refusal diagnostics report the commit captured when `dist/` was built, not the checkout's current Git HEAD. If that build identity is unknown, rebuild the checkout (`pnpm build`) before concluding the version is wrong.

Open the database with a build that supports its schema, or point the older build at a separate `OPENCLAW_STATE_DIR`. Do not edit the database to silence the error.

Config reads also save health fingerprints to this database. If that write fails,
`Config health-state write failed` reports the first failure for that database
in the current process. Repeated identical failures are suppressed while writes
continue to be attempted. A different error, or a failure after a successful
health-state write, is reported again. Suppressing duplicates does not resolve
the underlying database error.

### A database is quarantined after integrity verification failed

The background verifier proved the file is corrupt, and every open now fails fast instead of rescanning. Restore the database from a backup or repair it, then run `openclaw doctor --fix` to clear the quarantine record. Doctor reports an explicit error if the quarantine record itself cannot be cleared; rerun it until it reports clean.

## Downgrades are unsupported

Manual schema downgrades are for agents and operators who accept the risk. [Create and verify a backup](/cli/backup) before editing any database. Stop the Gateway and every process that can open the database.

The general procedure is:

1. Read the target release's schema and migrations.
2. In one transaction, restore the target release's exact table, column, index, and trigger definitions; remove newer objects and recreate objects retired by subsequent upgrades.
3. Set `PRAGMA user_version` and `schema_meta.schema_version` to the target version.
4. Run the target release's full database verification before starting the Gateway.

### Example: state schema 13 to 12

Schema 13 removed 60 cron-job projection columns, 53 subagent-run projection columns, and five unused indexes. A schema 12 build still expects the exact original column definitions, ordering, and indexes. Adding the removed required columns with defaults produces a different schema that older builds reject, so rebuild both tables instead. Reproject every v12 cron field from canonical `job_json` and `state_json`; abort before rebuilding when either record is malformed.

Disable foreign-key enforcement before starting the transaction. The cron-runtime authority table references `cron_jobs` with `ON DELETE CASCADE`, so dropping the original table while enforcement is active would silently delete its authority rows. Re-enable enforcement after the rebuild commits, and verify that `PRAGMA foreign_key_check;` returns no rows before starting the older build.

Run equivalent SQL against the global state database after inspecting the exact schema that wrote it:

```sql
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TEMP TABLE openclaw_v13_cron_downgrade_preflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO openclaw_v13_cron_downgrade_preflight (valid)
SELECT json_valid(job_json)
       AND json_type(job_json) = 'object'
       AND json_valid(state_json)
       AND json_type(state_json) = 'object'
  FROM cron_jobs;
DROP TABLE openclaw_v13_cron_downgrade_preflight;

CREATE TABLE cron_jobs_migration_v12 (
  store_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  declaration_key TEXT,
  display_name TEXT,
  owner_agent_id TEXT,
  owner_session_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL,
  delete_after_run INTEGER,
  created_at_ms INTEGER NOT NULL,
  agent_id TEXT,
  session_key TEXT,
  schedule_kind TEXT NOT NULL,
  schedule_expr TEXT,
  schedule_tz TEXT,
  every_ms INTEGER,
  anchor_ms INTEGER,
  at TEXT,
  stagger_ms INTEGER,
  session_target TEXT NOT NULL,
  wake_mode TEXT NOT NULL,
  trigger_script TEXT,
  trigger_once INTEGER,
  payload_kind TEXT NOT NULL,
  payload_message TEXT,
  payload_model TEXT,
  payload_fallbacks_json TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER,
  payload_allow_unsafe_external_content INTEGER,
  payload_external_content_source_json TEXT,
  payload_light_context INTEGER,
  payload_tools_allow_json TEXT,
  payload_tools_allow_is_default INTEGER,
  delivery_mode TEXT,
  delivery_channel TEXT,
  delivery_to TEXT,
  delivery_thread_id TEXT,
  delivery_thread_id_type TEXT,
  delivery_account_id TEXT,
  delivery_best_effort INTEGER,
  delivery_completion_mode TEXT,
  delivery_completion_to TEXT,
  failure_delivery_mode TEXT,
  failure_delivery_channel TEXT,
  failure_delivery_to TEXT,
  failure_delivery_account_id TEXT,
  failure_alert_disabled INTEGER,
  failure_alert_after INTEGER,
  failure_alert_channel TEXT,
  failure_alert_to TEXT,
  failure_alert_cooldown_ms INTEGER,
  failure_alert_include_skipped INTEGER,
  failure_alert_mode TEXT,
  failure_alert_account_id TEXT,
  next_run_at_ms INTEGER,
  running_at_ms INTEGER,
  last_run_at_ms INTEGER,
  last_run_status TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_errors INTEGER,
  consecutive_skipped INTEGER,
  schedule_error_count INTEGER,
  last_delivery_status TEXT,
  last_delivery_error TEXT,
  last_delivered INTEGER,
  last_failure_alert_at_ms INTEGER,
  job_json TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  runtime_updated_at_ms INTEGER,
  schedule_identity TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_key, job_id)
) STRICT;

INSERT INTO cron_jobs_migration_v12 (
  store_key, job_id, declaration_key, display_name, owner_agent_id,
  owner_session_key, name, description, enabled, delete_after_run, created_at_ms,
  agent_id, session_key, schedule_kind, schedule_expr, schedule_tz, every_ms,
  anchor_ms, at, stagger_ms, session_target, wake_mode, trigger_script, trigger_once,
  payload_kind, payload_message, payload_model, payload_fallbacks_json,
  payload_thinking, payload_timeout_seconds, payload_allow_unsafe_external_content,
  payload_external_content_source_json, payload_light_context, payload_tools_allow_json,
  payload_tools_allow_is_default, delivery_mode, delivery_channel, delivery_to,
  delivery_thread_id, delivery_thread_id_type, delivery_account_id, delivery_best_effort,
  delivery_completion_mode, delivery_completion_to, failure_delivery_mode,
  failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
  failure_alert_disabled, failure_alert_after, failure_alert_channel, failure_alert_to,
  failure_alert_cooldown_ms, failure_alert_include_skipped, failure_alert_mode,
  failure_alert_account_id, next_run_at_ms, running_at_ms, last_run_at_ms,
  last_run_status, last_error, last_duration_ms, consecutive_errors,
  consecutive_skipped, schedule_error_count, last_delivery_status, last_delivery_error,
  last_delivered, last_failure_alert_at_ms, job_json, state_json, runtime_updated_at_ms,
  schedule_identity, sort_order, updated_at
)
SELECT
  store_key,
  job_id,
  json_extract(job_json, '$.declarationKey'),
  json_extract(job_json, '$.displayName'),
  json_extract(job_json, '$.owner.agentId'),
  json_extract(job_json, '$.owner.sessionKey'),
  json_extract(job_json, '$.name'),
  json_extract(job_json, '$.description'),
  json_extract(job_json, '$.enabled'),
  json_extract(job_json, '$.deleteAfterRun'),
  json_extract(job_json, '$.createdAtMs'),
  json_extract(job_json, '$.agentId'),
  json_extract(job_json, '$.sessionKey'),
  json_extract(job_json, '$.schedule.kind'),
  CASE json_extract(job_json, '$.schedule.kind')
    WHEN 'cron' THEN json_extract(job_json, '$.schedule.expr')
    WHEN 'on-exit' THEN json_extract(job_json, '$.schedule.command')
  END,
  CASE json_extract(job_json, '$.schedule.kind')
    WHEN 'cron' THEN json_extract(job_json, '$.schedule.tz')
    WHEN 'on-exit' THEN json_extract(job_json, '$.schedule.cwd')
  END,
  json_extract(job_json, '$.schedule.everyMs'),
  json_extract(job_json, '$.schedule.anchorMs'),
  json_extract(job_json, '$.schedule.at'),
  json_extract(job_json, '$.schedule.staggerMs'),
  json_extract(job_json, '$.sessionTarget'),
  json_extract(job_json, '$.wakeMode'),
  json_extract(job_json, '$.trigger.script'),
  json_extract(job_json, '$.trigger.once'),
  json_extract(job_json, '$.payload.kind'),
  CASE json_extract(job_json, '$.payload.kind')
    WHEN 'systemEvent' THEN json_extract(job_json, '$.payload.text')
    WHEN 'agentTurn' THEN json_extract(job_json, '$.payload.message')
    WHEN 'command' THEN json_remove(
      json_extract(job_json, '$.payload'),
      '$.kind', '$.timeoutSeconds', '$.toolsAllow', '$.toolsAllowIsDefault'
    )
    WHEN 'script' THEN json_remove(
      json_extract(job_json, '$.payload'),
      '$.kind', '$.timeoutSeconds', '$.toolsAllow', '$.toolsAllowIsDefault'
    )
  END,
  json_extract(job_json, '$.payload.model'),
  CASE WHEN json_type(job_json, '$.payload.fallbacks') = 'array'
    THEN json_extract(job_json, '$.payload.fallbacks')
  END,
  json_extract(job_json, '$.payload.thinking'),
  json_extract(job_json, '$.payload.timeoutSeconds'),
  json_extract(job_json, '$.payload.allowUnsafeExternalContent'),
  CASE WHEN json_type(job_json, '$.payload.externalContentSource') IS NOT NULL
    THEN json_quote(json_extract(job_json, '$.payload.externalContentSource'))
  END,
  json_extract(job_json, '$.payload.lightContext'),
  CASE WHEN json_type(job_json, '$.payload.toolsAllow') = 'array'
    THEN json_extract(job_json, '$.payload.toolsAllow')
  END,
  CASE WHEN json_type(job_json, '$.payload.toolsAllow') = 'array'
    THEN json_extract(job_json, '$.payload.toolsAllowIsDefault')
  END,
  json_extract(job_json, '$.delivery.mode'),
  json_extract(job_json, '$.delivery.channel'),
  json_extract(job_json, '$.delivery.to'),
  CASE WHEN json_type(job_json, '$.delivery.threadId') IN ('integer', 'real', 'text')
    THEN CAST(json_extract(job_json, '$.delivery.threadId') AS TEXT)
  END,
  CASE json_type(job_json, '$.delivery.threadId')
    WHEN 'integer' THEN 'number'
    WHEN 'real' THEN 'number'
    WHEN 'text' THEN 'string'
  END,
  json_extract(job_json, '$.delivery.accountId'),
  json_extract(job_json, '$.delivery.bestEffort'),
  json_extract(job_json, '$.delivery.completionDestination.mode'),
  json_extract(job_json, '$.delivery.completionDestination.to'),
  CASE json_type(job_json, '$.delivery.failureDestination.mode')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.mode')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.channel')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.channel')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.to')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.to')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.accountId')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.accountId')
  END,
  CASE json_type(job_json, '$.failureAlert')
    WHEN 'false' THEN 1
    WHEN 'object' THEN 0
  END,
  json_extract(job_json, '$.failureAlert.after'),
  json_extract(job_json, '$.failureAlert.channel'),
  json_extract(job_json, '$.failureAlert.to'),
  json_extract(job_json, '$.failureAlert.cooldownMs'),
  json_extract(job_json, '$.failureAlert.includeSkipped'),
  json_extract(job_json, '$.failureAlert.mode'),
  json_extract(job_json, '$.failureAlert.accountId'),
  json_extract(state_json, '$.nextRunAtMs'),
  json_extract(state_json, '$.runningAtMs'),
  json_extract(state_json, '$.lastRunAtMs'),
  COALESCE(
    json_extract(state_json, '$.lastRunStatus'),
    json_extract(state_json, '$.lastStatus')
  ),
  json_extract(state_json, '$.lastError'),
  json_extract(state_json, '$.lastDurationMs'),
  json_extract(state_json, '$.consecutiveErrors'),
  json_extract(state_json, '$.consecutiveSkipped'),
  json_extract(state_json, '$.scheduleErrorCount'),
  json_extract(state_json, '$.lastDeliveryStatus'),
  json_extract(state_json, '$.lastDeliveryError'),
  json_extract(state_json, '$.lastDelivered'),
  json_extract(state_json, '$.lastFailureAlertAtMs'),
  job_json,
  state_json,
  runtime_updated_at_ms,
  schedule_identity,
  sort_order,
  updated_at
FROM cron_jobs;

DROP TABLE cron_jobs;
ALTER TABLE cron_jobs_migration_v12 RENAME TO cron_jobs;

CREATE INDEX idx_cron_jobs_store_updated
  ON cron_jobs(store_key, sort_order ASC, updated_at DESC, job_id);
CREATE INDEX idx_cron_jobs_store_order
  ON cron_jobs(store_key, sort_order ASC, updated_at ASC, job_id);
CREATE INDEX idx_cron_jobs_enabled_next_run
  ON cron_jobs(store_key, enabled, next_run_at_ms, job_id)
  WHERE next_run_at_ms IS NOT NULL;
CREATE INDEX idx_cron_jobs_agent_session
  ON cron_jobs(agent_id, session_key, updated_at DESC, job_id)
  WHERE agent_id IS NOT NULL OR session_key IS NOT NULL;

CREATE TABLE subagent_runs_migration_v12 (
  run_id TEXT NOT NULL PRIMARY KEY,
  child_session_key TEXT NOT NULL,
  controller_session_key TEXT,
  requester_session_key TEXT NOT NULL,
  requester_display_key TEXT NOT NULL,
  requester_origin_json TEXT,
  task TEXT NOT NULL,
  task_name TEXT,
  cleanup TEXT NOT NULL,
  label TEXT,
  model TEXT,
  agent_dir TEXT,
  workspace_dir TEXT,
  run_timeout_seconds INTEGER,
  spawn_mode TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  session_started_at INTEGER,
  accumulated_runtime_ms INTEGER,
  ended_at INTEGER,
  outcome_json TEXT,
  archive_at_ms INTEGER,
  cleanup_completed_at INTEGER,
  cleanup_handled INTEGER,
  suppress_announce_reason TEXT,
  expects_completion_message INTEGER,
  announce_retry_count INTEGER,
  last_announce_retry_at INTEGER,
  last_announce_delivery_error TEXT,
  ended_reason TEXT,
  pause_reason TEXT,
  wake_on_descendant_settle INTEGER,
  requester_settle_wake_status TEXT,
  requester_settle_wake_attempt_count INTEGER,
  requester_settle_wake_replay_count INTEGER,
  requester_settle_wake_next_attempt_at INTEGER,
  requester_settle_wake_batch_run_ids_json TEXT,
  requester_settle_wake_last_error TEXT,
  requester_settle_wake_retire_after INTEGER,
  frozen_result_text TEXT,
  frozen_result_captured_at INTEGER,
  fallback_frozen_result_text TEXT,
  fallback_frozen_result_captured_at INTEGER,
  ended_hook_emitted_at INTEGER,
  pending_final_delivery INTEGER,
  pending_final_delivery_created_at INTEGER,
  pending_final_delivery_last_attempt_at INTEGER,
  pending_final_delivery_attempt_count INTEGER,
  pending_final_delivery_last_error TEXT,
  pending_final_delivery_payload_json TEXT,
  completion_announced_at INTEGER,
  swarm_group_id TEXT,
  swarm_collector INTEGER,
  swarm_output_schema_json TEXT,
  swarm_completion_status TEXT,
  swarm_structured_json TEXT,
  swarm_schema_error TEXT,
  swarm_usage_json TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

INSERT INTO subagent_runs_migration_v12 (
  run_id, child_session_key, controller_session_key, requester_session_key,
  requester_display_key, task, cleanup, created_at, payload_json
)
SELECT run_id, child_session_key, controller_session_key, requester_session_key,
  '', '', '', created_at, payload_json
FROM subagent_runs;

DROP TABLE subagent_runs;
ALTER TABLE subagent_runs_migration_v12 RENAME TO subagent_runs;

CREATE INDEX idx_subagent_runs_child_session_key
  ON subagent_runs(child_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_requester_session_key
  ON subagent_runs(requester_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_controller_session_key
  ON subagent_runs(controller_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_archive_at
  ON subagent_runs(archive_at_ms, cleanup_handled, run_id);
CREATE INDEX idx_subagent_runs_ended_cleanup
  ON subagent_runs(ended_at, cleanup_handled, run_id);

CREATE TABLE workspace_attestations (
  workspace_key TEXT NOT NULL PRIMARY KEY,
  attested_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO workspace_attestations (workspace_key, attested_at_ms, updated_at_ms)
SELECT workspace_key, attested_at_ms, attestation_updated_at_ms
FROM workspace_setup_state
WHERE attested_at_ms IS NOT NULL;

CREATE INDEX idx_workspace_attestations_attested
  ON workspace_attestations(attested_at_ms DESC, workspace_key);

-- Data note: v12 requires version/updated_at NOT NULL in the setup table, so
-- merged attestation-only rows (NULL version) survive the downgrade only as
-- workspace_attestations rows, which also own the generated hashes in v12.
DELETE FROM workspace_generated_bootstrap_hashes
WHERE workspace_key NOT IN (SELECT workspace_key FROM workspace_attestations);
DELETE FROM workspace_setup_state WHERE version IS NULL;

CREATE TABLE workspace_setup_state_migration_v12 (
  workspace_key TEXT NOT NULL PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  version INTEGER NOT NULL,
  bootstrap_seeded_at TEXT,
  setup_completed_at TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO workspace_setup_state_migration_v12 (
  workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
)
SELECT workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
FROM workspace_setup_state;

DROP TABLE workspace_setup_state;
ALTER TABLE workspace_setup_state_migration_v12 RENAME TO workspace_setup_state;

CREATE INDEX idx_workspace_setup_state_path
  ON workspace_setup_state(workspace_path);

CREATE TABLE workspace_generated_bootstrap_hashes_migration_v12 (
  workspace_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (workspace_key, filename),
  FOREIGN KEY (workspace_key) REFERENCES workspace_attestations(workspace_key) ON DELETE CASCADE
) STRICT;

INSERT INTO workspace_generated_bootstrap_hashes_migration_v12 (workspace_key, filename, sha256)
SELECT workspace_key, filename, sha256 FROM workspace_generated_bootstrap_hashes;

DROP TABLE workspace_generated_bootstrap_hashes;
ALTER TABLE workspace_generated_bootstrap_hashes_migration_v12
  RENAME TO workspace_generated_bootstrap_hashes;

-- v12 carried installed_plugin_index; repopulate it from the folded KV row.
CREATE TABLE IF NOT EXISTS installed_plugin_index (
  index_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  host_contract_version TEXT NOT NULL,
  compat_registry_version TEXT NOT NULL,
  migration_version INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  workspace_dir TEXT,
  refresh_reason TEXT,
  install_records_json TEXT NOT NULL,
  plugins_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  warning TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_installed_plugin_index_generated
  ON installed_plugin_index(generated_at_ms DESC, index_key);
INSERT INTO installed_plugin_index (
  index_key, version, host_contract_version, compat_registry_version,
  migration_version, policy_hash, generated_at_ms, workspace_dir, refresh_reason,
  install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
)
SELECT 'installed-plugin-index',
       json_extract(value_json, '$.index.version'),
       json_extract(value_json, '$.index.hostContractVersion'),
       json_extract(value_json, '$.index.compatRegistryVersion'),
       json_extract(value_json, '$.index.migrationVersion'),
       json_extract(value_json, '$.index.policyHash'),
       json_extract(value_json, '$.index.generatedAtMs'),
       json_extract(value_json, '$.index.workspaceDir'),
       json_extract(value_json, '$.index.refreshReason'),
       json_extract(value_json, '$.index.installRecords'),
       json_extract(value_json, '$.index.plugins'),
       json_extract(value_json, '$.index.diagnostics'),
       json_extract(value_json, '$.index.warning'),
       json_extract(value_json, '$.revision')
  FROM config_machine_state
 WHERE state_key = 'plugins.installedIndex';
DELETE FROM config_machine_state WHERE state_key = 'plugins.installedIndex';

-- v12 carried the shared auth singleton tables; repopulate the 'shared' rows
-- from the folded KV cells (value_json is the payload verbatim).
CREATE TABLE IF NOT EXISTS auth_profile_stores (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO auth_profile_stores (store_key, store_json, updated_at)
SELECT 'shared', value_json, updated_at_ms
  FROM config_machine_state
 WHERE state_key = 'authProfiles.store';
CREATE TABLE IF NOT EXISTS auth_profile_state (
  store_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO auth_profile_state (store_key, state_json, updated_at)
SELECT 'shared', value_json, updated_at_ms
  FROM config_machine_state
 WHERE state_key = 'authProfiles.state';
DELETE FROM config_machine_state
 WHERE state_key IN ('authProfiles.store', 'authProfiles.state');

PRAGMA user_version = 12;
UPDATE schema_meta SET schema_version = 12 WHERE meta_key = 'primary';
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
```

The recreated cron columns are recovered from canonical JSON, including schedule and payload variants, explicit failure-destination clears, boolean `false`, numeric thread IDs, and runtime state. Canonical JSON bytes remain unchanged. Subagent-run state remains in `payload_json`; its retired projections are not runtime scheduling inputs. A botched downgrade means restore from the verified backup.

### Example: state schema 12 to 11

Schema 12 folded durable state snapshots into `config_machine_state` and retired rebuildable caches plus the write-only cron store epoch table. A schema 11 build still expects the thirteen former tables, so a manual downgrade must recreate their exact schemas and indexes before lowering the version.

Run equivalent SQL against the global state database after inspecting the exact schema that wrote it:

```sql
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS skill_curator_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  last_attempt_at_ms INTEGER NOT NULL,
  last_success_at_ms INTEGER,
  last_error TEXT,
  last_result_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS onboarding_recommendations (
  config_key TEXT NOT NULL PRIMARY KEY,
  inventory_hash TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  offered_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS voicewake_triggers (
  config_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (config_key, position)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_voicewake_triggers_trigger
  ON voicewake_triggers(config_key, trigger);

CREATE TABLE IF NOT EXISTS voicewake_routing_config (
  config_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  default_target_mode TEXT NOT NULL,
  default_target_agent_id TEXT,
  default_target_session_key TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS voicewake_routing_routes (
  config_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  target_mode TEXT NOT NULL,
  target_agent_id TEXT,
  target_session_key TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (config_key, position),
  FOREIGN KEY (config_key) REFERENCES voicewake_routing_config(config_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_voicewake_routing_routes_trigger
  ON voicewake_routing_routes(config_key, trigger);

CREATE TABLE IF NOT EXISTS update_check_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  last_checked_at TEXT,
  last_notified_version TEXT,
  last_notified_tag TEXT,
  last_available_version TEXT,
  last_available_tag TEXT,
  auto_install_id TEXT,
  auto_first_seen_version TEXT,
  auto_first_seen_tag TEXT,
  auto_first_seen_at TEXT,
  auto_last_attempt_version TEXT,
  auto_last_attempt_at TEXT,
  auto_last_success_version TEXT,
  auto_last_success_at TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS clawhub_promotions_feed_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  etag TEXT,
  payload_json TEXT,
  feed_sequence INTEGER,
  last_checked_at_ms INTEGER,
  notified_slugs_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cron_store_epochs (
  store_key TEXT PRIMARY KEY,
  store_epoch INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS model_catalog_remote (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bundle_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  min_version TEXT,
  source_url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tui_last_sessions (
  scope_key TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tui_last_sessions_session_key
  ON tui_last_sessions(session_key, updated_at DESC, scope_key);

CREATE TABLE IF NOT EXISTS sidebar_sections (
  section_id TEXT NOT NULL PRIMARY KEY,
  position INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS node_host_config (
  config_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  token TEXT,
  display_name TEXT,
  gateway_host TEXT,
  gateway_port INTEGER,
  gateway_tls INTEGER,
  gateway_tls_fingerprint TEXT,
  gateway_context_path TEXT,
  gateway_cloudflare_access_json TEXT,
  installed_apps_sharing INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS web_push_vapid_keys (
  key_id TEXT NOT NULL PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

PRAGMA user_version = 11;
UPDATE schema_meta
SET schema_version = 11,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

The recreated tables start empty. Migrated voice wake settings, onboarding recommendations, update-check state, sidebar layout, node-host identity, and Web Push signing keys remain readable in `config_machine_state` under `voicewake.triggers`, `voicewake.routing`, `onboarding.recommendations.<workspaceKey>`, `update.checkState`, `sidebar.sectionOrder`, `nodeHost.config`, and `webPush.vapidKeys`; manually repopulate their former tables if the older build must retain those settings. Node-host identity and Web Push signing keys are sensitive: avoid copying their values into shell history or logs. Skill-curator, promotions-feed, remote-catalog, and TUI last-session caches can be rebuilt. A botched downgrade means restore from the verified backup.

### Example: state schema 11 to 10

Schema 11 removed the retired skill lifecycle table and the never-read proposal
origin-run projection. A schema 10 build still requires both canonical tables, so
a manual downgrade must recreate their exact empty schemas and lifecycle indexes
before lowering the version.

Run equivalent SQL against the global state database after inspecting the exact
schema that wrote it:

```sql
BEGIN IMMEDIATE;

CREATE TABLE skill_lifecycle (
  skill_file TEXT NOT NULL PRIMARY KEY,
  skill_key TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  state_changed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  archived_reason TEXT
) STRICT;

CREATE INDEX idx_skill_lifecycle_key
  ON skill_lifecycle(skill_key, skill_file);

CREATE INDEX idx_skill_lifecycle_state
  ON skill_lifecycle(state, skill_file);

CREATE TABLE skill_workshop_proposal_origin_runs (
  proposal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  mutation_count INTEGER NOT NULL CHECK (mutation_count > 0),
  PRIMARY KEY (proposal_id, run_id),
  FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
) STRICT;

PRAGMA user_version = 10;
UPDATE schema_meta
SET schema_version = 10,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

Both recreated tables start empty. The upgrade discarded archived-skill
lifecycle state, so those skills returned to the active collection and a manual
downgrade cannot recover their previous archived state. Proposal origin-run
rows were never read; authoritative provenance remains in each proposal's
`record_json`. A botched downgrade means restore from the verified backup.

### Example: state schema 10 to 9

Schema 10 removed six dead shared-state tables. A schema 9 build still requires those canonical tables and indexes, so a manual downgrade must recreate their exact empty schemas before lowering the version.

Run equivalent SQL against the global state database after inspecting the exact schema that wrote it:

```sql
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS agent_model_catalogs (
  catalog_key TEXT NOT NULL PRIMARY KEY,
  agent_dir TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_model_catalogs_agent_dir
  ON agent_model_catalogs(agent_dir, updated_at DESC);

CREATE TABLE IF NOT EXISTS android_notification_recent_packages (
  package_name TEXT NOT NULL PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_android_notification_recent_packages_order
  ON android_notification_recent_packages(sort_order, package_name);

CREATE TABLE IF NOT EXISTS command_log_entries (
  id TEXT NOT NULL PRIMARY KEY,
  timestamp_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  session_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  source TEXT NOT NULL,
  entry_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_command_log_entries_timestamp
  ON command_log_entries(timestamp_ms DESC, id);

CREATE INDEX IF NOT EXISTS idx_command_log_entries_session
  ON command_log_entries(session_key, timestamp_ms DESC, id);

CREATE TABLE IF NOT EXISTS diagnostic_stability_bundles (
  bundle_key TEXT NOT NULL PRIMARY KEY,
  reason TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_diagnostic_stability_bundles_created
  ON diagnostic_stability_bundles(created_at DESC, bundle_key);

CREATE TABLE IF NOT EXISTS media_blobs (
  subdir TEXT NOT NULL,
  id TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subdir, id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_media_blobs_created
  ON media_blobs(created_at);

CREATE TABLE IF NOT EXISTS model_capability_cache (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input_text INTEGER NOT NULL,
  input_image INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  supports_tools INTEGER,
  context_window INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_model_capability_cache_provider_updated
  ON model_capability_cache(provider_id, updated_at_ms DESC, model_id);

PRAGMA user_version = 9;
UPDATE schema_meta
SET schema_version = 9,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

The recreated tables start empty because schema 10 discarded only dead or rebuildable cache rows. A botched downgrade means restore from the verified backup.

### Example: state schema 9 to 8

Schema 8 expects every `agent_databases.path` value to be absolute. Before lowering `user_version`, inspect each registry row on the same platform that wrote it. Leave absolute external paths unchanged; replace every relative path with its platform-native absolute form by resolving it against the state directory that owns `state/openclaw.sqlite`. Then set both `PRAGMA user_version` and `schema_meta.schema_version` to 8 in the same transaction.

Do not lower the version while relative registry rows remain. A schema 8 build interprets them relative to its process working directory rather than the copied state directory.

### Example: state schema 7 to 6

Schema 7 irreversibly discarded every row in the retired shared commitments table, then removed the table and its indexes. A schema 6 build still requires that canonical table, so a manual downgrade can recreate only its exact empty schema before lowering the version. Restore a verified pre-upgrade backup if the discarded rows are required.

Run equivalent SQL against the global state database after inspecting the exact schema that wrote it:

```sql
BEGIN IMMEDIATE;

CREATE TABLE commitments (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT,
  recipient_id TEXT,
  thread_id TEXT,
  sender_id TEXT,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_text TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  confidence REAL NOT NULL,
  due_earliest_ms INTEGER NOT NULL,
  due_latest_ms INTEGER NOT NULL,
  due_timezone TEXT NOT NULL,
  source_message_id TEXT,
  source_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_attempt_at_ms INTEGER,
  sent_at_ms INTEGER,
  dismissed_at_ms INTEGER,
  snoozed_until_ms INTEGER,
  expired_at_ms INTEGER,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_commitments_scope_due
  ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);

CREATE INDEX idx_commitments_status_due
  ON commitments(status, due_earliest_ms, due_latest_ms);

CREATE INDEX idx_commitments_scope_dedupe
  ON commitments(agent_id, session_key, channel, dedupe_key, status);

CREATE INDEX idx_commitments_agent_due
  ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);

CREATE INDEX idx_commitments_agent_sent
  ON commitments(agent_id, status, sent_at_ms, session_key);

PRAGMA user_version = 6;
UPDATE schema_meta
SET schema_version = 6,
    updated_at = unixepoch('now') * 1000
WHERE meta_key = 'primary';

COMMIT;
```

The recreated table starts empty. The downgrade cannot recover discarded commitment rows.

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
