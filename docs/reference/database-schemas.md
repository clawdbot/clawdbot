---
summary: "OpenClaw SQLite database locations, schema versions, integrity checks, and downgrade recovery"
read_when:
  - Diagnosing a newer database schema error
  - Checking database compatibility before an update or downgrade
  - Proposing a SQLite or persistent-store change
  - Preparing storage operations for another database backend
  - Recovering a database for an older OpenClaw release
title: "Database schemas"
---

OpenClaw stores control-plane state in a global SQLite database and agent data in one SQLite database per agent. Schema migrations run forward when a database opens. Older OpenClaw builds refuse databases written by a newer schema.

## Database layout

| Scope                | Default path                                               | Contents                                                                                              |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global control plane | `~/.openclaw/state/openclaw.sqlite`                        | Shared configuration state, registries, approvals, plugin state, and shared runtime state             |
| Per-agent data plane | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | Sessions, transcripts, memory indexes, auth state, conversation state, and agent-scoped runtime state |

The task registry uses the global control-plane database. Runtime trajectory events live with their sessions in the per-agent database or a configured shared session SQLite store.

### Mentions Inbox

The [mentions Inbox](/concepts/multi-user#temporary-mentions-inbox) uses existing
`config_machine_state` rows in `state/openclaw.sqlite`.
`notifications.mentions.source.*` records retain typed source identities,
recipients, mention identifiers, expiry times, and dismissal bookkeeping;
`notifications.mentions.head` records the revision and sequence. Writes use the
existing table and primary key, with no new tables, columns, indexes, or schema
version change.

Retention remains seven days from creation, capped at 100 entries per profile,
10,000 entries globally, and 10,000 source identities for duplicate suppression.
Restarts preserve retained entries, dismissals, and their original expiry times.
Loading stored state does not replay browser notifications or scan transcripts
to reconstruct old mentions.

### ACP replay accounting

The shared `acp_replay_sessions` and `acp_replay_events` tables retain bridge
replay history. Their `estimated_bytes` columns count the UTF-8 bytes of each
persisted text field, plus 32 bytes per row. Session totals include their events.
This is a retained-content estimate, not a limit on SQLite file, page, or WAL size.

Older releases counted characters inconsistently, undercounting Unicode and
allowing unchanged metadata writes to drift. The existing app-version upgrade
repair and explicit shared-state schema repair rebuild all derived totals
atomically, preserving event JSON text, identifiers, timestamps, and sequence.
Repair does not prune history. The next ordinary session write applies the
existing caps and eviction order, so corrected Unicode history may trim sooner
and use transcript fallback when loaded.

A current-app-version reopen skips this repair. Replacing code without changing
the app version does not repair an already-open or current-version database;
explicit schema repair remains the repair owner for that case. Accounting repair
cannot recover history already evicted by an older writer. See [ACP CLI](/cli/acp).

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
New transcript admissions record `sessionIdOrigin` (`generated` or `supplied`)
in `metadata_json`. The store preserves that value, including its absence or
invalidity in legacy rows, on later writes to the same primary key. Occupancy
reopening requires an explicitly generated origin; an unknown origin starts a
fresh capture and leaves the old record intact. The existing newest-candidate
query and ten-minute window are unchanged.

This adds no schema, index, version, or backfill. Doctor metadata restoration
preserves an explicitly recorded origin and leaves unknown origins unknown.
Older runtimes do not enforce this rule, so downgrading also removes the fixed-ID
history protection. See the [accepted ID-origin decision](https://github.com/openclaw/openclaw/pull/130860).

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

### Update run ledger

`update_runs` stores one durable record per update in the shared
`state/openclaw.sqlite` database. `src/infra/update-run-ledger.ts` owns writes
from the admitting Gateway, orchestrator CLI, and restarted Gateway. The table
is additive at shared schema version 15: the canonical schema declares it and
first use ensures it inside the same write transaction. Existing tables and the
schema version stay unchanged; older readers ignore the new table.

`run_id` is the UUID primary key. Rows retain creation/update timestamps,
trigger, phase, status, reason, origin, target, before/after versions, steps,
verification facts, repair attempts, confirmation/finish timestamps, and known
downtime. Each JSON column has a 16 KiB hard limit with deterministic truncation
and redaction. The ledger stores bounded diagnostic summaries, not raw logs or
credentials. There is no automatic history deletion.

New drivers store optional `origin.driver` fields `host` (the hostname), `pid`,
and `startIdentity` (the operating system's process-start identity as a decimal
string) in the existing `origin_json` column. Each adopter becomes the current
driver and retains distinct earlier identities in `origin.previousDrivers`.
There are at most eight identities in total. Only positively dead identities
are pruned; adoption is refused rather than dropping a live or uninspectable
driver at capacity. If local process identity cannot be captured, adoption
continues with one warning and a retained `driver:identity-unavailable` step.
That marker permanently excludes the run from automatic reconciliation, even
if known parents later exit; existing recorded identities remain protected.
A fresh run without identity follows the legacy explicit repair/supersession
rules below.
This is additive JSON metadata;
there are no new columns, tables, or schema versions. The separate
`verification.pid` still identifies the Gateway service, not the updater.
Adoption records a retained `driver:adopted` step. Detached children can outlive
their parent, so either lifetime can prevent reconciliation. Adopting a terminal
run is refused. Long command and finalization phases renew `updated_at_ms`
every 30 seconds; only current or retained identities may renew a row. Heartbeat
write failures warn once per driver run and do not abort commands or finalization;
step and outcome writes retain their existing failure behavior. Encoding
reserves space for exact identity bytes before bounding and redacting other
origin diagnostics.

The ledger owns abandonment classification and terminalization. Automatic
recovery requires more than 30 minutes since both `updated_at_ms` and the latest
step timestamp, plus positive evidence that every recorded driver is dead on the
same host: its PID is gone or its process-start identity differs. Unreadable and
foreign-host identities are inconclusive. The Gateway performs reconciliation
at startup and on active-run polls, rechecking the current row and process
identity in the terminal write transaction. The shared 30-minute constant also
owns the older-updater schema-publication bound below.

Reconciliation writes status `failed`, reason `abandoned`, and a retained
`reconcile:abandoned` step whose detail names `inactive-driver-dead` or
`operator-reconciled-inactive-run`. All unfinished steps become terminal, and
history is retained. Explicit `update repair` can reconcile inactive identityless
rows when the current Gateway generation is healthy and no post-core repair is
pending. It cannot override a live or inconclusive recorded driver. The
[2026.9.2 updater](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command.ts#L465)
does not record adoption: package-manager and registry preflight can
leave a live updater at its single `requested/in_progress` step. Older writers
may drop unknown driver JSON fields; identityless rows require explicit recovery.
`update status` only reports classification and never commits reconciliation.

Explicit new CLI update admission can supersede a legacy row only when it is
the sole running row, has no current or previous driver identity, and exceeds
the same inactivity bound. The transaction finishes it as `failed` with reason
`superseded` and a retained `reconcile:superseded` step whose detail is
`operator-started-update-supersedes-inactive-identityless-run`, then creates the
new row. This includes dry-run admission, but excludes inherited continuations
and campaigns. `abandoned` and `superseded` are additive values in the existing
free-text reason contract. Neither recovery path deletes history.

Successful ledger-only repair records a retained `reconcile:acknowledged` step.
A terminal abandoned row can substitute for full repair only once, within
30 minutes of its finish time; later repair invocations keep normal plugin
convergence behavior.
Repair also inspects newer failed/abandoned history for unacknowledged post-core
work, regardless of its age. An older active row cannot hide that work. If the
bounded history prefix does not reach the selected recovery rows, repair uses
full finalization rather than claiming that no post-core work remains.
When full finalization is required, the selected inactive rows are rechecked
and reconciled only after successful convergence, before success output.
Explicit recovery validates and commits its selected rows in one transaction;
renewed activity in any selected run preserves the entire selection. Ledger-only
repair also refuses the write if another active run falls outside that selection.
Finalization (`finalize:*`) and post-update verification markers survive step-count
and diagnostic-byte eviction because repair relies on that history. If retained
metadata alone exceeds a hard limit, the write fails without changing the row.

The CLI and Gateway share WAL-backed transactions, including while the Gateway
is stopped. The first terminal outcome wins; subsequent verification can enrich
its observed facts without rewriting success, failure, skip, or rollback status.
The restart sentinel carries `stats.runId` and remains the continuation owner;
consuming it does not delete the run row. Chat, CLI, and status reports read that
row. See [Run history and reports](/cli/update#run-history-and-reports).

### Cloud repository workspaces

Repository-only [cloud sessions](/gateway/cloud-workers#dispatching-a-session) use the first-use `session_repository_workspaces` table in the shared state database. The existing session entry carries only `repositoryWorkspaceId`; the shared row owns the canonical agent/session key, repository URL, requested ref, session branch, setup intent, pinned base commit and manifest, accepted checkpoint pointer, and revision. Session reset preserves this owner; a fork receives a distinct owner.

`github_repository_publication_requests` records shared and personal publication against an immutable accepted checkpoint and the session's admitted lifecycle revision. Reset preserves the session ID and repository checkpoint but invalidates publication authorized before that reset. Personal requests also retain the selected profile and connection generation and require same-owner confirmation after an interrupted publication. Pending publication keeps its original source even after an explicit move materializes a Gateway worktree.

Both tables are additive, lazily ensured on first use, and leave the numeric database schema version unchanged. That is not a compatibility promise for older cloud-session implementations: run a build that understands repository-only sessions when using this state. Existing local managed-worktree sessions keep their existing representation.

Checkpoint Git artifacts live under `state/repository-workspaces/<workspace-id>.git`, next to the shared database. These are bare repositories containing complete file manifests, cumulative changed-file blobs, and publication snapshots; they are not working checkouts or a backup of upstream Git history. Restoring an entire checkout still requires access to the pinned upstream commit. Back up these artifacts together with the shared and per-agent databases.

Accepted checkpoint history and publication source artifacts remain until explicit session deletion, including after Stop, archive, reset, or Gateway restart. There is no timed checkpoint expiry. Deletion retires publication requests and source ownership before removing their artifact repository; failed cleanup is reported. The managed-worktree idle cleanup and snapshot retention rules do not apply to these checkpoints.

## Versioning contract

Each database records its published schema in two places:

- `PRAGMA user_version` is the SQLite schema version.
- The primary `schema_meta` row records `role`, `agent_id`, `schema_version`, and `app_version`. `app_version` is the OpenClaw build that last wrote the schema metadata.

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. `openclaw update` also refuses a package or source target whose declared schema support is older than an on-disk database. Target packages published before schema metadata was added cannot be preflighted. Updates driven by the 2026.9.2 release line can temporarily defer publication of a shared-state schema version while the old updater finishes; see [Schema bumps and older updaters](#schema-bumps-and-older-updaters).

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

### Schema bumps and older updaters

OpenClaw 2026.9.2 introduced the update ledger but reopens it with old code after
running the target's Doctor, including a final read after recording its terminal
outcome. The shared-state database runner lets this updater finish by applying
migration content first and publishing the new schema version later. This rule
applies to every writable open, including Doctor, the restarted Gateway, and
other CLI processes.

The runner records the applied content version in the existing
`config_machine_state` key `state.schema.contentVersion`. While publication is
deferred, new code uses that content version, and both `PRAGMA user_version` and
`schema_meta.schema_version` retain the previous published version. Content and
its marker commit together. Reopening skips migration steps already covered by
the marker, including the schema-16 Skill Workshop rebuild; it does not infer
completion from table shape or repeat the rebuild. This requires no new table,
configuration option, or environment override.

Current content is ready for readers even while its version is unpublished.
Ordinary CLI commands can run alongside the Gateway throughout this window;
publication alone does not trigger schema repair or require stopping the Gateway.

A subsequent update can run during this window. Its migration verification and
rollback checks compare applied content versions from private database snapshots.
Publishing already-applied content is not another migration; applying new content
still blocks rollback even when the published number has not changed. Managed
service stop, activation, and Doctor maintenance keep their normal ownership rules.

Publication waits until **every** update row whose `before.version` identifies
the 2026.9.2 release line meets its applicable condition:

- A terminal row's `finished_at_ms` is at least five minutes old.
- A running row's `updated_at_ms` is more than 30 minutes old. The runner treats
  that driver as abandoned for publication purposes; it does not rewrite the
  run's outcome.

A missing ledger or no affected rows permits immediate publication. Deadlines
come from the rows' timestamps, never the observing process's start time. The
new Gateway's ledger watcher schedules publication at the applicable deadline
without jitter. Publication holds the Gateway lifecycle fence: the owning Gateway
can publish, and a later writable open can publish when no Gateway owns the state
directory. Other processes silently leave publication to that owner.
Publication rereads the content marker and all affected rows inside one
synchronous write transaction before advancing both published schema markers.
A new or refreshed running row blocks publication again. Restarting the Gateway
does not shorten or restart the grace period.

The five-minute grace accommodates 2026.9.2's trailing ledger reads; that release
records no driver process identity that would prove those reads have finished.
An old CLI blocked for more than five minutes after committing its terminal row,
for example on a stalled stdout pipe, can still fail its final render after
publication. By then the package swap, any requested service restart, and terminal ledger
outcome are complete. Downgrade protection for the 2026.9.2 line is delayed by the
same grace, or by the 30-minute abandoned-driver bound. The retained version is
not permission to run older code against migrated feature tables. Do not
manually lower either version marker or delete the content marker.

Update-time Doctor checks shared and registered agent databases before other
repairs. A state-only migration proceeds with deferred publication and reports
`schema content applied; version publication deferred until update run <id> finishes`.
Publication still observes the five-minute grace after that run finishes.
Doctor keeps the typed `update-schema-bump-unfenced` refusal when deferral cannot
cover a pending agent-database migration, the required `config_machine_state`
table is missing, or the state-content migration fails. A failed content
transaction rolls back. The refusal includes the database versions, driving
updater version, and [manual update commands](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
Package rollback cannot reverse a migration that already happened.

The driver check requires a valid semantic version and includes 2026.9.2
rebuilds. Earlier updaters, including 2026.9.1, have no ledger and keep normal
publication behavior. Builds from 2026.9.3 onward, including prereleases, use
transactional updates that fence old-process ledger access and let candidate
code finish after migration; they also keep normal publication behavior.
Same-schema repairs and ordinary Doctor runs remain available.

### Profile-owned skill library

[Personal and team skills](/tools/skills#personal-skills-on-a-shared-gateway) use four first-use tables in the shared state database without changing its schema version: `skill_library_entries`, `skill_library_revisions`, `skill_library_events`, and `skill_library_uploads`. Ordinary workspace skills and unused-library discovery do not create these tables. Ownership, sharing, the current revision pointer, portable file manifests, and publication events are canonical SQLite data. Session selections remain in the existing per-agent session store; inherited cron selections remain in the existing private job record.

Complete skill bundles are product artifacts under `<state-dir>/skill-library/<skill-id>/revisions/<revision-hash>/`. Publication writes and verifies an immutable bundle before committing its current pointer and event in one synchronous database transaction. Concurrent edits require the expected revision. A crash before that commit can leave an unreferenced complete bundle, but not a pointer to partially written content. Sharing and transfer change metadata without moving revision files.

Removing a skill excludes it from future selections; existing sessions retain their selected revisions. Published history and complete orphan revisions are retained conservatively. Expired upload records are pruned when another upload begins; clearly abandoned staging directories are cleaned during later publication. Back up both the state databases and the skill-library directory, not just the current revision pointers.

Older same-schema readers ignore the new tables but cannot provide managed-library selection or authoring. Keep the tables and bundle directory intact when changing builds; do not lower schema markers or delete revisions to disable the feature. The accepted storage and ownership decision is recorded in [the profile-owned skills design issue](https://github.com/openclaw/openclaw/issues/133602).

## Personal GitHub connections and publication

Personal GitHub connection state uses the existing `secret_store_entries` identity scope, with the canonical authenticated profile as `scope_id` and the fixed private name `github-connection`. It is not a generic identity-secret API or a profile preference. One bounded record owns selection, pending device authorization, and refresh recovery. Personal managed CLI credentials use a separate `credentials/github/personal/<opaque-profile-id>` directory, outside older system/agent cleanup roots.

Personal publication uses the lazy, same-version `github_personal_publication_requests` table. It records the requesting profile, selected connection generation and account, immutable target/workspace snapshot, idempotency, and outcome; it contains no tokens. Reading status does not create the table. Existing system and agent requests remain in their original table.

Local shared and personal publication records use the first-use `github_publication_session_lifecycles` companion table to bind each request to its admitted session lifecycle revision. The key is the publication kind and request ID; the binding commits in the same transaction as the request. An explicit `NULL` records that the session had no revision at admission. A missing binding cannot authorize unfinished publication and is never filled from the current session. Terminal receipt history remains readable.

The companion table leaves the numeric shared schema version, both existing local request-table definitions, and their receipt digests unchanged. Older schema validators treat those request tables as optional and reject additional columns even when nullable, so the lifecycle binding uses a separate table that older readers ignore.

Older builds ignore both the personal request table and identity-scoped credential rows instead of executing a personal request as System. Re-upgrade still enforces original authorization expiry. Unfinished personal publication requires fresh confirmation by the same authenticated owner after a Gateway restart; remote-result reconciliation reuses the original request markers.

Disconnect removes usable local credentials and retains a secret-free disconnected selection to fence stale work. Profile merges preserve target state, including an explicit disconnection; a source connection transfers only when the target has no state, with new selection authority. Credentials stranded by a profile merge performed on an older build require reconnect, not runtime adoption through aliases.

Personal publication receipts remain for the logical session's lifetime. Archive/reset preserves receipts and invalidates incompatible unfinished work. An already-dispatched GitHub operation can still record its observed result, without gaining authority for another operation. Permanent session deletion fences execution and removes its personal receipts and lifecycle bindings. There is no timed idempotency expiry, and deleting local state does not undo an already-created GitHub commit or pull request.

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

## Preparing for another database backend

SQLite remains the supported runtime store. Preparation for PostgreSQL should
improve the existing store owners and their tests before adding a driver or
configuration option. The initial target is remote persistence for one Gateway;
multiple active Gateways would require a separate ownership and coordination
design. A shared database alone does not make process-local writer queues,
session lifecycles, or host-owned leases safe across Gateway instances.

### Keep operations at the owning store

Callers should request domain operations, such as claiming a cron run or
appending a transcript report, from the store that owns the invariant. That
owner selects and decodes rows, validates current authority, commits changes,
and publishes the result. Avoid exposing a generic SQL callback to application
code or adding an asynchronous wrapper around an existing asynchronous facade.
The plugin KV API already has asynchronous methods over its SQLite owner.

Use Kysely for ordinary queries and mutations. The current
`getNodeSqliteKysely` facade compiles queries; `executeSqliteQuerySync` runs them
on the supplied `node:sqlite` connection. Calling Kysely's asynchronous
`execute` method on that facade is an error. Query compilation with another
dialect can identify syntax coupling, but does not prove driver behavior,
isolation, or database compatibility.

Acquire a connection once for an operation and pass that exact connection
through its transactional helpers. SQLite write callbacks remain synchronous:
finish asynchronous planning first, then reread authoritative rows after write
admission. Publish live session changes and other dependent effects only after
the durable write succeeds. A future network-backed owner must preserve that
ordering while awaiting its driver.

Session reclamation keeps its deletion transaction on a worker connection.
The worker opens its database under the session writer, then releases that writer
while full integrity and foreign-key checks run on the same connection. Unrelated
session writes can continue during those checks. It reacquires the writer and
revalidates current authority before index repair, schema work, or deletion.
The connection and lease remain owned throughout admission; refusal unwinds that
owner, and final writer admission remains held until the worker exits.
Archive publication and cascading deletion remain atomic. Before COMMIT, the
worker publishes its authorization request in shared memory and waits for the
parent's current owner check. Synchronous writers service that request at the shared
SQLite transaction boundary between short lock-admission attempts, in the reclamation
owner's captured async context. This includes session entries, delivery records, and
first-use board and Goal schema transactions. Registration uses the open connection's
native database location, so other connections and reopened handles share admission.
Only admission is retried; transaction callbacks and mutations are never replayed.
The original lock-admission deadline is retained. After granting approval,
the parent synchronously joins transaction settlement before allowing owner retirement;
that mandatory join cannot be abandoned at the append deadline.

Periodic incremental vacuum uses the same write-admission boundary, so it can
service reclamation approval before taking the writer lock. Its 512-page limit
is unchanged; passive checkpoints remain outside the write transaction.

Reclamation page maintenance uses a PASSIVE checkpoint and at most 512 pages of
incremental vacuum per pass. PASSIVE does not wait for readers, but does not cap
the number of WAL frames copied. Before pruning retained archives, disk-budget
enforcement drains the initially observed free pages in units of at most 512,
yields between units, and reacquires the database owner after each yield. It
preserves physical checkpointing before measuring pressure, so unreclaimed pages
do not cause unnecessary archive deletion. Full logical deletion with resumable
physical cleanup remains a separate design; existing deletion visibility and rollback
semantics are unchanged.

### Preserve the data and concurrency contracts

An adapter must make these contracts explicit and verify them against a real
database:

| Contract           | Required behavior                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store identity     | Keep global and per-agent ownership, incognito lifetime, quarantine, and disposal explicit. Filesystem paths currently participate in admission and registry identity; replacing a path with a connection string is not sufficient. |
| Read consistency   | Define whether each operation needs one snapshot or a fresh authoritative reread. Keep ordered, bounded queries and batch enrichment inside that consistency boundary.                                                              |
| Conditional writes | Preserve exact revision, session generation, writer claim, and lease-owner predicates. A stale or refused mutation must not publish a success result or alter live state.                                                           |
| Canonical payloads | Preserve serialized transcript and record text where byte identity, replay, or exact JSON comparison is part of the contract. Keep derived query projections separate.                                                              |
| Scalar decoding    | Decode driver values at the store boundary, including counts, integer ranges, nullable booleans, timestamps, JSON, and binary bytes. Match TypeScript declarations to observed driver values.                                       |
| Failure and retry  | Define which failures permit retry of the whole operation. Keep external effects outside a retried transaction, and revalidate authority after awaited work.                                                                        |

Kysely's TypeScript types do not convert driver results; the driver determines
runtime values. See [Kysely data types](https://kysely.dev/docs/recipes/data-types).
PostgreSQL transactions must use one acquired client, and its default Read
Committed isolation can give successive statements different snapshots. An
adapter therefore needs operation-specific isolation and retry decisions, not
a mechanical replacement of `BEGIN IMMEDIATE`. See
[node-postgres transactions](https://node-postgres.com/features/transactions)
and [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Do not automatically convert canonical JSON text to `jsonb`: PostgreSQL's
`jsonb` representation changes whitespace, object-key order, and duplicate-key
handling. A searchable `jsonb` projection would need an explicit design and
migration decision. See [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html).

### Keep engine-specific capabilities owned

SQLite FTS5/BM25, vector tables, JSON table-valued queries, attached shadow
databases, WAL maintenance, integrity checks, and backup operations remain
SQLite capabilities. Keep their implementation behind the memory or database
lifecycle owner. A future backend must supply equivalent product behavior or
an explicit capability boundary; a second SQL dialect alone cannot replace
these features. Schema, retention, migration, and multi-host changes still use
the review checkpoint below.

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
| 16      | Skill Workshop ownership moves from workspace/provenance columns to per-agent directory containment                                                                                                                                                                                                                             | Unreleased          |

### State schema 16

Schema 16 removes `workspace_dir` and `claim_released_time` from
`skill_workshop_proposals`. It also removes `workspace_dir` and
`idx_skill_workshop_collection_reviews_workspace_time` from collection review
history and adds `owner_agent_id` plus its owner/time index. Proposal rows remain intact. A proposal whose claim a
collection review had released becomes `stale` with a status reason, so the
skill path it once created stays user-owned and Doctor never relocates it.

Skill Workshop ownership is now the physical
`<state-dir>/agents/<agentId>/agent/workshop-skills` directory. Startup and `openclaw doctor --fix`
drop the retired columns and index in the shared schema transaction. Both then
run the same migration to relocate applied legacy Workshop creates to the
inferred owner agent and retarget eligible pending creates. Conflicts and ambiguous ownership become
stale proposals and leave the legacy directories unchanged. Review history rows
map to a unique owner agent when possible; otherwise the schema migration discards them as
cache-class state.

Skill-only workspace relocation uses the existing `migration_runs` and
`migration_sources` tables to save pre-move directory identity, file hashes,
and the workspace attestation timestamp. After relocation, only matching
attestation-only state is retired; setup state, path aliases, and newer
attestations remain intact. Interrupted migrations reuse the saved pre-move
facts rather than inferring them from an empty directory. Workspace reset
removes pending workspace-scoped receipts. No additional schema version or
table is required.

### State schema 15

Schema 15 removes `target_agent_id` and `target_session_id` from `current_conversation_bindings`. The target index uses the complete `target_session_key` and remains non-unique: several conversations may point at the same destination. This lets plugin-owned targets persist without inventing an OpenClaw agent owner. Channel/account isolation, plugin approvals, binding identifiers, target keys, JSON metadata, expiry, and detach behavior are unchanged.

Startup and `openclaw doctor --fix` run the migration in the existing exclusive write transaction. They remove only the two projections and replace the target index, preserving all other row values. A dependent trigger, index, or failed schema check rolls the transaction back; migration does not discard an unknown dependency to force the upgrade. Column removal rewrites the binding table, so upgrade cost scales with its size.

Stop older writers and create a verified, WAL-aware backup before upgrading. Builds supporting shared-state schema 14 or earlier refuse the migrated database. To return to an older build, restore that pre-upgrade backup into a separate state directory; do not lower the version markers or reconstruct an agent projection. See [Downgrade](/install/updating#downgrade) for the general recovery contract.

### State schema 13

Schema 13 makes `cron_jobs.job_json`, `cron_jobs.state_json`, and `subagent_runs.payload_json` the canonical records. Physical columns remain only where production queries, ordering, or runtime-only updates require them. Cron jobs shrink from 75 columns to 15, and subagent runs shrink from 59 columns to six. Migration preserves failure-destination fields explicitly configured as undefined by encoding them as JSON `null`; it also normalizes legacy run-status aliases into `state_json` before removing the redundant projections.

The shared-state `auth_profile_stores` and `auth_profile_state` singletons move into `config_machine_state` under `authProfiles.store` and `authProfiles.state`; per-agent auth tables remain unchanged. Because these rows contain credentials, secret-redacted Git backups omit the `authProfiles.` machine-state prefix.

### State schema 11

Schema 11 removes the `skill_lifecycle` and `skill_workshop_proposal_origin_runs` tables. Archived-skill lifecycle state is discarded during the upgrade: previously archived Workshop skills return to the active collection, where weekly collection review judges them by content. The origin-run rows were a never-read projection; canonical proposal provenance stays in `skill_workshop_proposals.record_json`. Recorded skill usage and collection-review state are preserved.

### State schema 9

Schema 9 stores an `agent_databases.path` value relative to the state directory when the registered agent database is inside that directory. During migration, a foreign default-layout row is re-anchored to the in-root counterpart when that file exists. It is deleted only when the same agent already holds its in-root registration, because dual default-layout registrations cannot produce a valid combined session list. Otherwise, the absolute row is preserved, so genuine external registrations are never deleted. This keeps a copied state directory self-contained without dropping supported external database paths.

## Integrity checks

| When                                        | Check                                                               |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row           |
| Every physical writable agent-database open | Run full integrity, foreign-key, schema, and canonical-index checks |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan     |
| Gateway background verifier                 | Run the full scan about once daily and log results                  |
| Doctor, backup verification, and compaction | Run the full scan before accepting or rewriting the database        |

The Gateway startup preflight reads schema headers only. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier also scans already-open databases about once daily.

Memory search and maintenance managers borrow the verified per-agent connection. Acquisition does not reopen or rescan a healthy shared handle. Native and transformed plugin modules share the same process-owned connection lifecycle, query cache, and commit observers. Nested synchronous writes use SQLite savepoints on that connection. A manager retains that exact connection against cache eviction until its work drains, then releases its borrow without closing the database. Explicit quarantine and disposal still revoke it. Full memory rebuilds use separate temporary shadow databases and publish their derived tables in one synchronous transaction. Read-only memory status keeps its separate diagnostic connection and does not create or migrate a missing database.

If nested rollback or savepoint cleanup fails, the transaction owner preserves the original failure, discards staged state and post-commit observers, and closes the connection. Catching that failure cannot resume writes on the abandoned handle. A later operation must acquire a fresh connection through its database owner. Doctor plugin-state imports retain earlier committed batches; an aborted batch cannot commit its prefix. Ordinary row refusals that successfully roll back their savepoint still commit the successful prefix for resumable imports.

The shared cache targets 64 handles, but live borrows, synchronous transactions, and incognito state are not evicted. After owners release them, the next new connection trims idle handles back to that target.

Concurrent runs normally share the cached writer for an agent database on the main thread. Workers and diagnostics can open additional connections to the same file; the connection count is operation-dependent. Canonical agent connections set SQLite's busy timeout before use. A timeout cannot resolve a worker holding a write transaction while waiting for a blocked main thread: synchronous transcript appends do not join the asynchronous session write queue. Transaction callbacks must finish synchronously, and a competing writer must not depend on the main event loop to release its lock.

Periodic agent maintenance uses passive WAL checkpoints and bounded incremental vacuum. Session reclamation keeps deletion on a separate worker write connection and uses a passive checkpoint and bounded vacuum after commit; long deletion transactions can still contend with other writers. Full compaction belongs to offline Doctor maintenance. Run errors naming the Gateway state database retain a safe SQLite diagnosis; see [storage failure troubleshooting](/gateway/troubleshooting#agent-run-failed-with-a-storage-error).

Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

Background verification errors retain the original name and message and append bounded Node `code` and SQLite `errcode` values from up to eight cause-chain nodes. These diagnostics do not change the verdict: I/O failures remain inconclusive, while proven corruption is reconfirmed by the database owner before quarantine. A generic `disk I/O error` (`errcode=10`) does not establish disk exhaustion.

Agent database maintenance fences other writers with a 60-second lease in the shared state database. A dedicated worker renews that lease during synchronous integrity scans and migration phases. Maintenance still checks the exact persisted owner before mutations and commit, and stops if the heartbeat fails or ownership expires or changes. Finishing or cancelling maintenance stops renewal before releasing the lease; process death leaves at most the remaining lease duration.

Asynchronous agent-database admission and maintenance run their initial full-file integrity check in a read-only child process when that check is outside a write transaction. The child has a 30-second lifetime limit, including startup and shutdown. The connection and owning scope remain held until the child closes, including on cancellation or timeout. Schema changes, index repairs, and compaction retain their synchronous phases.

Integrity-child timeout and incomplete-exit errors include `lastObservedPhase`:

| Value             | Last observation                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `starting`        | The parent has not received a child phase.                                                |
| `opening`         | The child announced file-identity checks and opening a read-only connection.              |
| `checking`        | The connection opened, and the child announced the full integrity and foreign-key checks. |
| `closing`         | The child announced connection cleanup after checking or an error.                        |
| `result-received` | The parent received a final result and is waiting for child closure.                      |

These phases describe messages the parent received, not the child's exact current location or native CPU time. `checking` does not distinguish the integrity check from the foreign-key check. A final result can report failure; phase messages never establish successful validation or release ownership.

Startup errors containing `state lease heartbeat did not become ready` include `phase=startup`, the settlement trigger (`timeout` or `message`), and the status observed before the parent marks failure. `status=starting` distinguishes readiness still pending from `status=lost`, where loss was already recorded. `elapsedMs` measures monotonic time since heartbeat startup began; `timeoutMs` is the startup wait budget, capped at five seconds or the remaining initial lease lifetime. These fields do not establish why startup stalled or ownership was lost.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## Troubleshooting

`SQLite read-only worker` failures append `code` and numeric SQLite `errcode` diagnostics when the underlying error supplies valid values, including through a bounded cause chain. Report the full code suffix when investigating a failure. A generic `disk I/O error` or `SQLITE_IOERR` alone does not prove the disk is full.

### Why you cannot go back after updating to 2026.7.2

Every release through `v2026.7.1` used agent schema 1 and state schema 1. The 2026.7.2 release train (starting with `v2026.7.2-beta.1`) migrates your databases forward on first start. That migration is one-way: the data is rewritten into the newer schema, and installing an older OpenClaw afterwards does not undo it. The older build refuses to start with a `newer schema version` error that names the build that owns the database.

Downgrading the binary never downgrades the data. Use the managed recovery path
or restore the verified pre-update backup with its matching release. Retain
migration recovery originals until you have verified the upgrade; they do not
replace a complete backup. See [Downgrade](/install/updating#downgrade).

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

<a id="downgrades-are-unsupported" />

<a id="example-state-schema-13-to-12" />
<a id="example-state-schema-12-to-11" />
<a id="example-state-schema-11-to-10" />
<a id="example-state-schema-10-to-9" />
<a id="example-state-schema-9-to-8" />
<a id="example-state-schema-7-to-6" />
<a id="example-agent-schema-17-to-16" />

## Downgrade recovery

Do not reverse migrations with SQL or lower `PRAGMA user_version`,
`schema_meta.schema_version`, or the config writer stamp. Those markers describe
persistent formats; editing them does not restore the older data contract.

Follow [Downgrade](/install/updating#downgrade) for the managed rollback path,
retained-originals limits, and restoring a verified pre-update backup. A complete
recovery point includes the matching package, config, shared state, and every
agent database. Keep writers stopped while activating restored state.
