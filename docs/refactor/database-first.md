---
summary: "Migration plan for making SQLite the primary durable state and cache layer while keeping config file-backed"
title: "Database-first state refactor"
read_when:
  - Moving OpenClaw runtime data, cache, transcripts, task state, or scratch files into SQLite
  - Designing doctor migrations from legacy JSON or JSONL files
  - Changing backup, restore, VFS, or worker storage behavior
  - Removing session locks, pruning, truncation, or JSON compatibility paths
---

# Database-First State Refactor

## Decision

Use a two-level SQLite layout:

- Global database: `~/.openclaw/state/openclaw.sqlite`
- Agent database: one SQLite database per agent for agent-owned workspace,
  transcript, VFS, artifact, and large per-agent runtime state
- Configuration stays file-backed: `openclaw.json` remains outside the
  database. Runtime auth profiles move to SQLite; external provider or CLI
  credential files remain owner-managed outside OpenClaw's database.

The global database is the control-plane database. It owns agent discovery,
shared gateway state, pairing, device/node state, task and flow ledgers, plugin
state, scheduler runtime state, backup metadata, and migration state.

The agent database is the data-plane database. It owns the agent's session
metadata, transcript event stream, VFS workspace or scratch namespace, tool
artifacts, run artifacts, and searchable/indexable agent-local cache data.

This gives one durable global view without forcing large agent workspaces,
transcripts, and binary scratch data into the shared gateway write lane.

## Hard Contract

This migration has one canonical runtime shape:

- Session rows persist session metadata only. They must not persist
  `transcriptLocator`, transcript file paths, sibling JSONL paths, lock paths,
  pruning metadata, or file-era compatibility pointers.
- Transcript identity is always SQLite identity: `{agentId, sessionId}` plus
  optional topic metadata where the protocol needs it.
- `sqlite-transcript://...` is not a runtime or protocol identity. New code must
  not derive, persist, pass, parse, or migrate transcript locators. Runtime and
  tests should not contain pseudo-locators at all; docs may mention the string
  only to ban it.
- Legacy `sessions.json`, transcript JSONL, `.jsonl.lock`, pruning, truncation,
  and old session-path logic belong only to the doctor migration/import path.
- Legacy session config aliases belong only to doctor migration. Runtime does
  not interpret `session.idleMinutes`, `session.resetByType.dm`, or
  cross-agent `agent:main:*` main-session aliases for another configured agent.
- Session routing identity is typed relational state. Hot runtime and UI paths
  should read `sessions.session_scope`, `sessions.account_id`,
  `sessions.primary_conversation_id`, `conversations`, and
  `session_conversations`; they must not parse `session_key` or mine
  `session_entries.entry_json` for provider identity except as a compatibility
  shadow while old call sites are being deleted.
- Channel-level direct-message markers such as `dm` versus `direct` are routing
  vocabulary, not transcript locators or file-store compatibility handles.
- Legacy hook handler config belongs only to doctor warning/migration surfaces.
  Runtime must not load `hooks.internal.handlers`; hooks run through discovered
  hook directories and `HOOK.md` metadata only.
- Runtime startup, hot reply paths, compaction, reset, recovery, diagnostics,
  TTS, memory hooks, subagents, plugin command routing, protocol boundaries, and
  hooks must pass `{agentId, sessionId}` through the runtime.
- Tests should seed and assert SQLite transcript rows through
  `{agentId, sessionId}`. Tests that only prove JSONL path forwarding,
  caller-supplied locator preservation, or transcript-file compatibility should
  be deleted unless they cover doctor import, non-session support/debug
  materialization, or protocol shape.
- `runEmbeddedPiAgent(...)`, prepared worker runs, and the inner embedded
  attempt must not accept transcript locators. They open the SQLite transcript
  manager by `{agentId, sessionId}` and pass that manager to the internalized
  PI-compatible agent session, so stale callers cannot make the runner write
  JSON/JSONL transcripts.
- Runner diagnostics must store runtime/cache/payload trace records in SQLite.
  Runtime diagnostics must not expose JSONL file override knobs or generic
  transcript JSONL export helpers; user-facing exports can materialize explicit
  artifacts from database rows without feeding file names back into runtime.
- Raw stream logging uses `OPENCLAW_RAW_STREAM=1` plus SQLite diagnostics rows.
  The old pi-mono `PI_RAW_STREAM`, `PI_RAW_STREAM_PATH`, and
  `raw-openai-completions.jsonl` file logger contract is not part of OpenClaw
  runtime or tests.
- QMD memory indexing must not export SQLite transcripts to markdown files.
  QMD indexes configured memory files only; session transcript search stays
  SQLite-backed.
- The QMD SDK subpath is QMD-only for new code. SQLite session transcript
  indexing helpers live on `memory-core-host-engine-session-transcripts`; any
  QMD re-export is compatibility only and must not be used by runtime code.
- Built-in memory indexes live in the owning agent database. Runtime config and
  resolved runtime contracts must not expose `memorySearch.store.path`; doctor
  deletes that legacy config key and current code passes the agent
  `databasePath` internally.

Implementation work should keep deleting code until these statements are true
without exceptions outside doctor/import/export/debug boundaries.

## Goal state and progress

### Hard goal

- One global SQLite database owns control-plane state:
  `state/openclaw.sqlite`.
- One per-agent SQLite database owns data-plane state:
  `agents/<agentId>/agent/openclaw-agent.sqlite`.
- Config remains file-backed. `openclaw.json` is not part of this database
  refactor.
- Legacy files are doctor migration inputs only.
- Runtime never writes or reads session or transcript JSONL as active state.

### Goal states

- `not-started`: file-era runtime code still writes active state.
- `migrating`: doctor/import code can move file data into SQLite.
- `dual-read`: temporary bridge reads both SQLite and legacy files. This state
  is forbidden for this refactor unless it is explicitly documented as
  doctor-only.
- `sqlite-runtime`: runtime reads and writes SQLite only.
- `clean`: legacy runtime APIs and tests are removed, and the guard prevents
  regressions.
- `done`: docs, tests, backup, doctor migration, and changed checks prove the
  clean state.

### Current state

- Sessions: `clean` for runtime. Session rows live in the per-agent database,
  runtime APIs use `{agentId, sessionId}` or `{agentId, sessionKey}`, and
  `sessions.json` is doctor-only legacy input.
- Transcripts: `clean` for runtime. Transcript events, identities, snapshots,
  and trajectory runtime events live in the per-agent database. Runtime no
  longer accepts transcript locators or JSONL transcript paths.
- PI embedded runner: `clean`. Embedded PI runs, prepared workers, compaction,
  and retry loops use SQLite session scope and reject stale transcript handles.
- Cron: `clean` for runtime. Runtime uses `cron_jobs` and `cron_run_logs`;
  runtime tests use SQLite `storeKey` naming, and file-era cron paths remain in
  doctor legacy migration tests only.
- Task registry: `clean`. Task and Task Flow runtime rows live in
  `state/openclaw.sqlite`; unshipped sidecar SQLite importers are deleted.
- Plugin state: `clean`. Plugin state/blob rows live in the shared global
  database; old plugin-state sidecar SQLite helpers are guarded against.
- Memory: `sqlite-runtime` for built-in memory and session transcript indexing.
  Memory index tables live in the per-agent database, plugin memory state uses
  shared plugin-state rows, and legacy memory files are doctor migration inputs
  or user workspace content.
- Backup: `sqlite-runtime`. Backup stages compact SQLite snapshots, omits live
  WAL/SHM sidecars, verifies SQLite integrity, and records backup runs in the
  global database.
- Doctor migration: `migrating`, intentionally. Doctor imports legacy JSON,
  JSONL, and retired sidecar stores into SQLite, records migration runs/sources,
  and removes successful sources.
- E2E scripts: `clean` for runtime coverage. Docker MCP seeding writes SQLite
  rows. The runtime-context Docker script creates legacy JSONL only inside the
  doctor migration seed and names the legacy session index path explicitly.

### Remaining work

- [x] Rename cron runtime-test store variables away from `storePath` unless
      they are doctor legacy inputs.
      Files: `src/cron/service.test-harness.ts`,
      `src/cron/service.runs-one-shot-main-job-disables-it.test.ts`,
      `src/cron/service/timer.regression.test.ts`,
      `src/cron/service/ops.test.ts`, `src/cron/service/store.test.ts`,
      `src/cron/service.heartbeat-ok-summary-suppressed.test.ts`,
      `src/cron/service.main-job-passes-heartbeat-target-last.test.ts`,
      `src/cron/store.test.ts`.
      Proof: `pnpm check:database-first-legacy-stores`; `rg -n 'storePath' src/cron --glob '!**/commands/doctor/**'`.
- [x] Remove or rename obsolete file-era export test mocks.
      File: `src/auto-reply/reply/commands-export-test-mocks.ts`.
      Proof: `rg -n 'resolveSessionFilePath|sessionFile|storePath|transcriptLocator' src/auto-reply/reply`.
- [x] Make the Docker runtime-context legacy JSONL seed obviously doctor-only.
      File: `scripts/e2e/session-runtime-context-docker-client.ts`.
      Proof: `rg -n 'sessions\\.json|sessionFile|\\.jsonl' scripts/e2e/session-runtime-context-docker-client.ts` shows only
      `seedBrokenLegacySessionForDoctorMigration`.
- [x] Keep Kysely generated types aligned after any schema change.
      Files: `src/state/openclaw-state-schema.sql`,
      `src/state/openclaw-agent-schema.sql`,
      `src/state/*generated*`.
      Proof: no schema change in this pass; `pnpm db:kysely:check`;
      `pnpm lint:kysely`.
- [x] Re-run focused tests for touched stores, commands, and scripts.
      Proof: `pnpm test src/cron/service/store.test.ts src/cron/store.test.ts src/cron/service.heartbeat-ok-summary-suppressed.test.ts src/cron/service.main-job-passes-heartbeat-target-last.test.ts src/cron/service.every-jobs-fire.test.ts src/cron/service.persists-delivered-status.test.ts src/cron/service.runs-one-shot-main-job-disables-it.test.ts src/cron/service/ops.test.ts src/cron/service/timer.regression.test.ts src/auto-reply/reply/commands-export-trajectory.test.ts extensions/telegram/src/thread-bindings.test.ts extensions/slack/src/monitor/message-handler/prepare.test.ts src/acp/translator.session-lineage-meta.test.ts`; `git diff --check`.
- [x] Before declaring `done`, run the changed gate or remote broad proof.
      Proof: `pnpm check:changed --timed -- <changed extension paths>` passed on
      Hetzner Crabbox run `run_3f1cabf6b25c` after temporary Node 24/pnpm setup and
      explicit path routing for the synced no-`.git` workspace.

### Do not regress

- No transcript locators.
- No active session files.
- No fake JSONL test fixtures except doctor legacy migration tests.
- No raw SQLite access where Kysely is expected.
- No new legacy DB migrations. This layout has not shipped; keep schema version
  at `1` unless there is a strong reason.

## Code-Read Assumptions

No follow-up product decisions are blocking this plan. The implementation should
proceed with these assumptions:

- Use `node:sqlite` directly and require the Node 22+ runtime for this storage
  path.
- Keep exactly one normal configuration file. Do not move config, plugin
  manifests, or Git workspaces into SQLite in this refactor.
- Runtime compatibility files are not required. Legacy JSON and JSONL files are
  migration inputs only. The branch-local SQLite sidecars never shipped and are
  deleted instead of imported.
- `openclaw doctor --fix` owns the legacy file-to-database migration step.
  Runtime startup and `openclaw migrate` should not carry legacy OpenClaw
  database-upgrade paths.
- Credential compatibility follows the same rule: runtime credentials live in
  SQLite. Old `auth-profiles.json`, per-agent `auth.json`, and shared
  `credentials/oauth.json` files are doctor migration inputs, then removed
  after import.
- Generated model catalog state is database-backed. Runtime code must not write
  `agents/<agentId>/agent/models.json`; existing `models.json` files are legacy
  doctor inputs and are removed after import into `agent_model_catalogs`.
- Runtime must not migrate, normalize, or bridge transcript locators. Active
  transcript identity is `{agentId, sessionId}` in SQLite. File paths are
  legacy doctor inputs only, and `sqlite-transcript://...` must disappear from
  runtime, protocol, hook, and plugin surfaces instead of being treated as a
  boundary handle.
- Runtime SQLite transcript reads do not run old JSONL entry-shape migrations or
  rewrite whole transcripts for compatibility. Legacy entry normalization stays in
  explicit doctor/import utilities. Doctor normalizes legacy JSONL transcript
  files before inserting SQLite rows; current runtime rows are
  already written in the current transcript schema. Trajectory/session export
  reads those rows as-is and must not perform export-time legacy migrations.
- Legacy transcript JSONL parse/migration helpers are doctor-only. Runtime
  transcript format code builds current SQLite transcript context only; doctor
  owns old JSONL entry upgrades before inserting rows.
- The old runtime-owned JSONL transcript streaming helper was deleted. Doctor
  import code owns explicit legacy file reads; runtime session history reads
  SQLite rows.
- Codex app-server bindings use the OpenClaw `sessionId` as the canonical
  key in the Codex plugin-state namespace. `sessionKey` is metadata for
  routing/display and must not replace the durable session id or resurrect
  transcript-file identity.
- Context engines receive the current runtime contract directly. The registry
  must not wrap engines with retry shims that delete `sessionKey`,
  `transcriptScope`, or `prompt`; engines that cannot accept the current
  database-first params should fail loudly instead of being bridged.
- Backup output should remain one archive file. Database contents should enter
  that archive as compact SQLite snapshots, not raw live WAL sidecars.
- Transcript search is useful but not required for the first database-first
  cut. Design the schema so FTS can be added later.
- Worker execution should stay experimental behind settings while the database
  boundary settles.

## Code-Read Findings

The current branch is already past the proof-of-concept stage. The shared
database exists, Node `node:sqlite` is wired through a small runtime helper, and
former stores now write to `state/openclaw.sqlite` or the owning
`openclaw-agent.sqlite` database.

The remaining work is not choosing SQLite; it is keeping the new boundary clean
and deleting any compatibility-shaped interfaces that still look like the old
file world:

- Session `storePath` is no longer a runtime identity, test fixture shape, or
  status payload field. Runtime and bridge tests no longer contain the
  `storePath` contract name; doctor/migration code owns that legacy vocabulary.
- Session writes no longer pass through the old in-process `store-writer.ts`
  queue. SQLite patch writes use conflict detection and bounded retry instead.
- Legacy path discovery still has valid migration uses, but runtime code should
  stop treating `sessions.json` and transcript JSONL files as possible write
  targets.
- Agent-owned tables live in per-agent SQLite databases. The global DB keeps
  registry/control-plane rows; transcript identity is `{agentId, sessionId}` in
  the per-agent transcript rows. Runtime code must not persist transcript file
  paths or migrate transcript locators.
- Doctor already imports several legacy files. The cleanup is to make that a
  single explicit migration implementation that doctor calls, with a durable
  migration report.

No additional product questions are blocking implementation.

## Current Code Shape

The branch already has a real shared SQLite base:

- The runtime floor is now Node 22+: `package.json`, the CLI runtime guard,
  installer defaults, macOS runtime locator, CI, and public install docs all
  agree. The old Node 22 compatibility lane is removed.
- `src/state/openclaw-state-db.ts` opens `openclaw.sqlite`, sets WAL,
  `synchronous=NORMAL`, `busy_timeout=30000`, `foreign_keys=ON`, and applies
  the generated schema module derived from
  `src/state/openclaw-state-schema.sql`.
- Kysely table types and runtime schema modules are generated from disposable
  SQLite databases created from the committed `.sql` files; runtime code no
  longer keeps copy-pasted schema strings for global, per-agent, or proxy
  capture databases.
- Runtime stores derive selected and inserted row types from those generated
  Kysely `DB` interfaces instead of shadowing SQLite row shapes by hand. Raw SQL
  remains limited to schema application, pragmas, and migration-only DDL.
- The SQLite schemas are collapsed to `user_version = 1` because this database
  layout has not shipped yet. Runtime openers create the current schema only;
  file-to-database import remains in doctor code, and branch-local
  database upgrade helpers have been deleted.
- Relational ownership is enforced where the ownership boundary is canonical:
  source migration rows cascade from `migration_runs`, task delivery state
  cascades from `task_runs`, and transcript identity rows cascade from
  transcript events.
- Current shared tables include `agent_databases`,
  `auth_profile_stores`, `auth_profile_state`,
  `plugin_state_entries`, `plugin_blob_entries`, `media_blobs`,
  `skill_uploads`, `capture_sessions`, `capture_events`, `capture_blobs`,
  `sandbox_registry_entries`, `cron_run_logs`, `cron_jobs`, `commitments`,
  `delivery_queue_entries`, `model_capability_cache`,
  `workspace_setup_state`, `native_hook_relay_bridges`,
  `current_conversation_bindings`, `plugin_binding_approvals`,
  `tui_last_sessions`, `acp_sessions`, `acp_replay_sessions`,
  `acp_replay_events`, `task_runs`, `task_delivery_state`, `flow_runs`,
  `subagent_runs`, `migration_runs`, and `backup_runs`.
- Arbitrary plugin-owned state does not get host-owned typed tables. Installed
  plugins use `plugin_state_entries` for versioned JSON payloads and
  `plugin_blob_entries` for bytes, with namespace/key ownership, TTL cleanup,
  backup, and plugin migration records. Host-owned plugin orchestration state can
  still have typed tables when the host owns the query contract, such as
  `plugin_binding_approvals`.
- Plugin migrations are data migrations over plugin-owned namespaces, not host
  schema migrations. A plugin can migrate its own versioned state/blob entries
  through a migration provider, and the host records source/run status in the
  normal migration ledger. New plugin installs do not require changing
  `openclaw-state-schema.sql` unless the host itself is taking ownership of a
  new cross-plugin contract.
- `src/state/openclaw-agent-db.ts` opens
  `agents/<agentId>/agent/openclaw-agent.sqlite`, registers the database in the
  global DB, and owns agent-local session, transcript, VFS, artifact, cache,
  and memory-index tables. Shared runtime discovery now reads the generated-typed
  `agent_databases` registry instead of reimplementing that query at each call
  site.
- Global and per-agent databases record a `schema_meta` row with database role,
  schema version, timestamps, and agent id for agent databases. The layout still
  stays at `user_version = 1` because this SQLite schema has not shipped yet.
- Per-agent session identity now has a canonical `sessions` root table keyed by
  `session_id`, with `session_key`, `session_scope`, `account_id`,
  `primary_conversation_id`, timestamps, display fields, model metadata,
  harness id, and parent/spawn linkage as queryable columns. `session_routes`
  is the unique active route index from `session_key` to the current
  `session_id`, so a route key can move to a fresh durable session without
  making hot reads pick between duplicate `sessions.session_key` rows. The old
  `session_entries.entry_json` compatibility-shaped payload hangs off the
  durable `session_id` root by foreign key; it is no longer the only
  schema-level representation of a session.
- Per-agent external conversation identity is relational too:
  `conversations` stores normalized provider/account/conversation identity, and
  `session_conversations` links one OpenClaw session to one or more external
  conversations. This covers shared-main DM sessions where multiple peers can
  intentionally map to one session without lying in `session_key`. SQLite also
  enforces uniqueness for the natural provider identity so the same
  channel/account/kind/peer/thread tuple cannot fork across conversation ids.
  Shared-main direct peers are linked with a `participant` role, so one
  OpenClaw session can represent multiple external DM peers without demoting
  older peers into vague related rows. `sessions.primary_conversation_id` still
  points at the current typed delivery target. Closed routing/status columns
  are enforced with SQLite `CHECK` constraints instead of relying only on
  TypeScript unions.
  Runtime session projection clears compatibility routing shadows from
  `session_entries.entry_json` before applying typed session/conversation
  columns, so stale JSON payloads cannot resurrect delivery targets.
  Subagent announce routing likewise requires the typed SQLite delivery context;
  it no longer falls back to compatibility `SessionEntry` route fields.
  Gateway `chat.send` explicit delivery inheritance reads the typed SQLite
  delivery context instead of `origin`/`last*` compatibility fields.
  `tools.effective` likewise derives provider/account/thread context from typed
  SQLite delivery/routing rows, not stale `last*` session-entry shadows.
  System-event prompt context rebuilds channel/to/account/thread fields from
  typed delivery fields instead of `origin` shadows.
  The shared `deliveryContextFromSession` helper and session-to-conversation
  mapper now ignore `SessionEntry.origin` entirely; only typed delivery fields
  and relational conversation rows can create hot route identity.
  Runtime session entry normalization strips `origin` before persisting or
  projecting `entry_json`, and inbound metadata writes typed channel/chat
  fields plus relational conversation rows instead of creating new origin
  shadows.
- Transcript events, transcript snapshots, and trajectory runtime events now
  reference the canonical per-agent `sessions` root and cascade on session
  deletion. Transcript identity/idempotency rows continue to cascade from the
  exact transcript event row.
- Memory-core indexes now use explicit agent-database tables
  `memory_index_meta`, `memory_index_sources`, `memory_index_chunks`, and
  `memory_embedding_cache`, with `memory_index_state` tracking revision changes.
  Optional FTS/vector side indexes are named `memory_index_chunks_fts` and
  `memory_index_chunks_vec` instead of generic `meta`, `files`, `chunks`,
  `chunks_fts`, or `chunks_vec` tables. The canonical names retain the current
  path/source row shape and serialized embedding compatibility. These tables
  are derived/search cache, not canonical transcript storage; they can be
  deleted and rebuilt from memory workspace files and configured sources.
  Opening a shipped generic-name memory index migrates its metadata, sources,
  chunks, and embedding cache into the canonical tables; derived FTS/vector
  tables are rebuilt under their canonical names.
- Subagent run recovery state now lives in typed shared `subagent_runs` rows
  with indexed child, requester, and controller session keys. The old
  `subagents/runs.json` file is doctor migration input only.
- Current conversation bindings now live in typed shared
  `current_conversation_bindings` rows keyed by normalized conversation id, with
  target agent/session columns, conversation kind, status, expiry, and metadata
  stored as relational columns instead of a duplicated opaque binding record.
  The durable binding key includes the normalized conversation kind so
  direct/group/channel refs cannot collide, and SQLite rejects invalid binding
  kind/status values. The old
  `bindings/current-conversations.json` file is doctor migration input only.
- Delivery queue recovery now overlays typed queue columns for channel, target,
  account, session, retry, error, platform-send, and recovery state onto the
  replay JSON. `entry_json` keeps the replay payloads, hooks, and formatting
  payload, but typed columns are authoritative for hot queue routing/state.
- TUI last-session restore pointers now live in typed shared
  `tui_last_sessions` rows keyed by the hashed TUI connection/session scope.
  The old TUI JSON file is doctor migration input only.
- Default TTS prefs now live in shared plugin-state SQLite rows keyed under the
  `speech-core` plugin. The old `settings/tts.json` file is doctor migration
  input only; runtime no longer reads or writes TTS prefs JSON files, and the
  legacy path resolver lives in the doctor migration module.
- Secret target metadata now talks about stores instead of pretending every
  credential target is a config file. `openclaw.json` remains the config store;
  auth-profile targets use typed SQLite `auth_profile_stores` rows with
  provider-shaped credentials kept as JSON payloads.
- Secret audit no longer scans retired per-agent `auth.json` files. Doctor owns
  warning about, importing, and removing that legacy file.
- Legacy auth profile path helpers now live in doctor legacy code. Core auth
  profile path helpers expose SQLite auth-store identity and display locations,
  not `auth-profiles.json` or `auth-state.json` runtime paths.
- Subagent run recovery and OpenRouter model capability cache runtime modules
  now keep SQLite snapshot readers/writers separate from doctor-only legacy JSON
  import helpers. OpenRouter capabilities use the typed generic
  `model_capability_cache` rows under `provider_id = "openrouter"` instead of
  one opaque cache blob or a provider-specific host table. Subagent run
  `taskName` is stored in the typed `subagent_runs.task_name` column; the
  `payload_json` copy is replay/debug data, not the source for hot display or
  lookup fields.
- `src/agents/filesystem/virtual-agent-fs.sqlite.ts` implements a SQLite VFS
  over the agent database `vfs_entries` table. Directory reads, recursive
  exports, deletes, and renames use indexed `(namespace, path)` prefix ranges
  instead of scanning a whole namespace or relying on `LIKE` path matching.
- `src/agents/runtime-worker.entry.ts` creates per-run SQLite VFS, tool artifact,
  run artifact, and scoped cache stores for workers.
- Workspace bootstrap completion markers now live in typed shared
  `workspace_setup_state` rows keyed by resolved workspace path instead of
  `.openclaw/workspace-state.json`; runtime no longer reads or rewrites the
  legacy workspace marker, and helper APIs no longer pass around a fake
  `.openclaw/setup-state` path just to derive storage identity.
- Exec approvals now live in the typed shared SQLite `exec_approvals_config`
  singleton row. Doctor imports legacy `~/.openclaw/exec-approvals.json`;
  runtime writes no longer create, rewrite, or report that file as its active
  store location. The macOS companion reads and writes the same
  `state/openclaw.sqlite` table row; it keeps only the Unix prompt socket on disk
  because that is IPC, not durable runtime state.
- Device identity, device auth, and bootstrap runtime modules now keep their
  SQLite snapshot readers/writers separate from doctor-only legacy JSON import
  helpers. Device identity uses typed `device_identities` rows and device auth
  tokens use typed `device_auth_tokens` rows. Device auth writes reconcile rows
  by device/role instead of truncating the token table, and runtime no longer
  routes single-token updates through the old whole-store adapter. The legacy
  version-1 JSON payloads exist only as doctor import/export shapes.
- GitHub Copilot token exchange cache uses the shared SQLite plugin-state table
  under `github-copilot/token-cache/default`. It is provider-owned cache state,
  so it intentionally does not add a host schema table.
- GitHub Copilot compaction no longer writes `openclaw-compaction-*.json`
  workspace sidecars. The harness calls the SDK history compaction RPC for the
  tracked SDK session, and OpenClaw keeps durable session/transcript state in
  SQLite instead of compatibility marker files.
- The shared Swift runtime (`OpenClawKit`) uses the same
  `state/openclaw.sqlite` rows for device identity and device auth. macOS app
  helpers import the shared SQLite helpers instead of owning a second JSON or
  SQLite path. A leftover legacy `identity/device.json` blocks identity creation
  until doctor imports it into SQLite, matching the TypeScript and Android
  startup gate.
- Android device identity uses the same TypeScript-compatible key material
  stored in typed `state/openclaw.sqlite#table/device_identities` rows. It never
  reads or writes `openclaw/identity/device.json`; a leftover legacy file blocks
  startup until doctor imports it into SQLite.
- Android cached device auth tokens also use typed
  `state/openclaw.sqlite#table/device_auth_tokens` rows and share the same
  version-1 token semantics as TypeScript and Swift. Runtime no longer reads `SecurePrefs`
  `gateway.deviceToken*` compatibility keys; those belong to migration/doctor
  logic only.
- Android notification recent-package history uses typed
  `android_notification_recent_packages` rows. Runtime no longer migrates or
  reads the old SharedPreferences CSV keys.
- Device identity creation fails closed when legacy `identity/device.json`
  exists, when the SQLite identity row is invalid, or when the SQLite identity
  store cannot be opened. Doctor imports and removes that file first, so runtime
  startup cannot silently rotate pairing identity before migration.
- Device identity selection is a SQLite row key, not a JSON file locator. Tests
  and gateway helpers pass explicit identity keys; only doctor migration and the
  fail-closed startup gate know the retired `identity/device.json` filename.
- Session reset compatibility now lives in doctor config migration:
  `session.idleMinutes` is moved into `session.reset.idleMinutes`,
  `session.resetByType.dm` is moved into `session.resetByType.direct`, and the
  runtime reset policy only reads canonical reset keys.
- Legacy config compatibility now lives under `src/commands/doctor/`. Normal
  `readConfigFileSnapshot()` validation does not import doctor legacy detectors
  or annotate legacy issues; `runDoctorConfigPreflight()` adds those issues for
  doctor repair/reporting. The doctor config flow imports
  `src/commands/doctor/legacy-config.ts`, and old OAuth profile-id repair lives
  under
  `src/commands/doctor/legacy/oauth-profile-ids.ts`.
- Non-doctor commands do not auto-run legacy config repair. For example,
  `openclaw update --channel` now fails on invalid legacy config and asks the
  user to run doctor, rather than silently importing doctor migration code.
- Web push, APNs, Voice Wake, update checks, and config health now use typed shared SQLite
  tables for subscriptions, VAPID keys, node registrations, trigger rows,
  routing rows, update-notification state, and config health entries instead of
  whole opaque JSON blobs. Web push and APNs snapshot writes now reconcile
  subscriptions/registrations by primary key instead of clearing their tables;
  config health does the same by config path.
  Their runtime modules keep SQLite snapshot readers/writers separate from
  doctor-only legacy JSON import helpers.
- Node-host config now uses a typed singleton row in the shared SQLite database;
  doctor imports the old `node.json` file before normal runtime use.
- Device/node pairing, channel pairing, channel allowlists, and bootstrap state
  now use typed SQLite rows instead of whole opaque JSON blobs. Plugin binding
  approvals and cron job state follow the same split: runtime modules expose
  SQLite-backed operations and neutral snapshot helpers, and pairing/bootstrap
  plus plugin binding approval snapshot writes reconcile rows by primary key
  instead of truncating tables, while doctor imports/removes the old JSON files through
  `src/commands/doctor/legacy/*` modules.
- Installed plugin records now live in the SQLite installed-plugin index.
  Runtime config read/write no longer migrates or preserves old
  `plugins.installs` authored-config data; doctor imports that legacy config
  shape into SQLite before normal runtime use.
- QQBot credential recovery snapshots now live in SQLite plugin state under
  `qqbot/credential-backups`. Runtime no longer writes
  `qqbot/data/credential-backup*.json`; the QQBot doctor contract imports and
  archives those legacy backup files from the active state directory.
- Gateway reload planning compares SQLite installed-plugin index snapshots under
  an internal `installedPluginIndex.installRecords.*` diff namespace. Runtime
  reload decisions no longer wrap those rows in fake `plugins.installs` config
  objects.
- Matrix named-account credential upgrade no longer happens during runtime
  reads. Doctor owns the old top-level `credentials/matrix/credentials.json`
  rename when a single/default Matrix account can be resolved.
- Core pairing and cron runtime modules no longer export legacy JSON path
  builders. Doctor-owned legacy modules construct `pending.json`, `paired.json`,
  `bootstrap.json`, and `cron/jobs.json` source paths for import tests and
  migration only. Legacy cron job-shape normalization and cron run-log import
  live under `src/commands/doctor/legacy/cron*.ts`.
- `src/commands/doctor/legacy/runtime-state.ts` imports legacy JSON state
  files, including node host config, into SQLite from doctor. New legacy file
  importers stay under `src/commands/doctor/legacy/`.
- `src/commands/doctor/state-migrations.ts` imports legacy `sessions.json` and
  `*.jsonl` transcripts directly into SQLite and removes successful sources. It
  no longer stages root legacy transcripts through
  `agents/<agentId>/sessions/*.jsonl` or creates a canonical JSONL target before
  import.
- State integrity doctor checks no longer scan legacy session directories or
  offer orphan JSONL deletion. Legacy transcript files are migration inputs
  only, and the migration step owns import plus source removal.
- Legacy sandbox registry import lives under
  `src/commands/doctor/legacy/sandbox-registry.ts`; active sandbox registry
  reads and writes remain SQLite-only.
- The legacy session transcript health/import repair lives under
  `src/commands/doctor/legacy/session-transcript-health.ts`; runtime command
  modules no longer carry JSONL transcript parsing or active-branch repair code.

Completed consolidation/deletion highlights:

- Plugin state now uses the shared `state/openclaw.sqlite` database. The old
  branch-local `plugin-state/state.sqlite` sidecar importer is removed because
  that SQLite layout never shipped. Probe/test helpers report the shared
  `databasePath` instead of exposing a plugin-state-specific SQLite path.
- Task and Task Flow runtime tables now live in the shared
  `state/openclaw.sqlite` database instead of `tasks/runs.sqlite` and
  `tasks/flows/registry.sqlite`; the old sidecar importers are removed for the
  same unshipped-layout reason.
- `src/config/sessions/store.ts` no longer needs `storePath` for inbound
  metadata, route updates, or updated-at reads. Command persistence, CLI
  session cleanup, subagent depth, auth overrides, and transcript session
  identity use agent/session row APIs. Writes are applied as SQLite row patches
  with optimistic conflict retry.
- Session target resolution now exposes per-agent database targets, not legacy
  `sessions.json` paths. Shared gateway, ACP metadata, doctor route repair, and
  `openclaw sessions` enumerate `agent_databases` plus configured agents.
- Gateway session routing now uses `resolveGatewaySessionDatabaseTarget`; the
  returned target carries `databasePath` and candidate SQLite row keys instead
  of a legacy session-store file path.
- Channel session runtime types now expose `{agentId, sessionKey}` for
  updated-at reads, inbound metadata, and last-route updates. The old
  `saveSessionStore(storePath, store)` compatibility type is gone.
- Plugin runtime, extension API, and `config/sessions` barrel surfaces now steer
  plugin code to SQLite-backed session row helpers. Root library compatibility
  exports (`loadSessionStore`, `saveSessionStore`, `resolveStorePath`) remain as
  deprecated shims for existing consumers. The old
  `resolveLegacySessionStorePath` helper is gone; legacy `sessions.json` path
  construction is now local to migration and test fixtures.
- `src/config/sessions/session-entries.sqlite.ts` now stores canonical session
  entries in the per-agent database and has row-level read/upsert/delete patch
  support. Runtime upsert/patch/delete no longer scans for case variants or
  prunes legacy alias keys; doctor owns canonicalization. The
  standalone JSON import helper is gone, and migration merges upsert newer rows
  instead of replacing the whole session table. Public read/list/load helpers
  project hot session metadata from typed `sessions` and `conversations` rows;
  `entry_json` is a compatibility/debug shadow and can be stale or invalid
  without losing typed session identity or delivery context.
- `src/config/sessions/delivery-info.ts` now resolves delivery context from the
  typed per-agent `sessions` + `conversations` + `session_conversations` rows.
  It no longer reconstructs runtime delivery identity from
  `session_entries.entry_json`; a missing typed conversation row is a doctor
  migration/repair problem, not a runtime fallback.
- Stored-session reset decisions now prefer typed `sessions.session_scope`,
  `sessions.chat_type`, and `sessions.channel` metadata. `sessionKey` parsing
  remains only for explicit thread/topic suffixes on command targets; group vs
  direct reset classification no longer comes from key shape.
- Session list/status display classification now uses typed chat metadata and
  gateway session kind. It no longer treats `:group:` or `:channel:` substrings
  inside `session_key` as durable group/direct truth.
- Silent-reply policy selection now uses explicit conversation type or surface
  metadata only. It no longer guesses direct/group policy from
  `session_key` substrings.
- Session display model resolution now receives the agent id from the SQLite
  session database target instead of splitting it out of `session_key`.
- Agent-to-agent announce target hydration now uses typed `sessions.list`
  `deliveryContext` only. It no longer recovers channel/account/thread routing
  from legacy `origin`, mirrored `last*` fields, or `session_key` shape.
- `sessions_send` thread-target rejection now reads typed SQLite routing
  metadata. It no longer rejects or accepts targets by parsing thread suffixes
  out of the target key.
- Group-scoped tool policy validation now reads typed SQLite conversation
  routing for the current or spawned session. It no longer trusts group/channel
  identity by decoding `sessionKey`; caller-provided group ids are dropped when
  no typed session row vouches for them.
- Channel model override matching now uses explicit group and parent
  conversation metadata. It no longer decodes parent conversation ids from
  `parentSessionKey`.
- Stored model override inheritance now requires an explicit parent session key
  from typed session context. It no longer derives parent overrides from
  `:thread:` or `:topic:` suffixes in `sessionKey`.
- The old session thread-info wrapper and loaded-plugin thread parser are gone;
  no runtime code imports `config/sessions/thread-info`.
- The channel conversation helper no longer exposes full-session-key parsing
  bridges. Core still normalizes provider-owned raw conversation ids through
  `resolveSessionConversation(...)`, but it does not reconstruct route facts
  from `sessionKey`.
- Completion delivery, send policy, and task maintenance no longer derive chat
  type from `session_key` shape. The old chat-type key parser has been deleted;
  these paths require typed session metadata, typed delivery context, or
  explicit delivery target vocabulary.
- Session list/status, diagnostics, approval account binding, TUI heartbeat
  filtering, and usage summaries no longer mine `SessionEntry.origin` for
  provider/account/thread/display routing. The only remaining runtime
  `origin` reads are non-session concepts or current-turn delivery objects.
- Approval-request native conversation lookup now reads typed per-agent session
  routing rows. It no longer parses channel/group/thread conversation identity
  from `sessionKey`; missing typed metadata is a migration/repair issue.
- Gateway session changed/chat/session event payloads no longer echo
  `SessionEntry.origin` or `last*` route shadows; clients receive typed
  `channel`, `chatType`, and `deliveryContext`.
- Heartbeat delivery resolution can now receive the typed SQLite
  `deliveryContext` directly, and heartbeat runtime passes the per-agent
  session delivery row instead of relying on compatibility `session_entries`
  shadows for current routing.
- Cron isolated-agent delivery target resolution also hydrates its current
  route from the typed per-agent session delivery row before falling back to the
  compatibility entry payload.
- Subagent announce origin resolution now threads the typed requester-session
  delivery context through `loadRequesterSessionEntry` and prefers that row over
  compatibility `last*`/`deliveryContext` shadows.
- Inbound session metadata updates now merge against the typed per-agent
  delivery row first; old `SessionEntry` delivery fields are only the fallback
  when no typed conversation row exists.
- Restart/update delivery extraction now lets the typed SQLite delivery
  `threadId` win over topic/thread fragments parsed from `sessionKey`; parsing
  is only a fallback for legacy thread-shaped keys.
- Hook agent context channel ids now prefer typed SQLite conversation identity,
  then explicit message metadata. They no longer parse provider/group/channel
  fragments from `sessionKey`.
- Gateway `chat.send` external-route inheritance now reads typed SQLite session
  routing metadata instead of inferring channel/direct/group scope from
  `sessionKey` pieces. Channel-scoped sessions inherit only when the typed
  session channel and chat type match the stored delivery context; shared-main
  sessions keep their stricter CLI/no-client-metadata rule.
- Restart-sentinel wake and continuation routing now reads typed SQLite
  delivery/routing rows before queueing heartbeat wakes or routed agent-turn
  continuations. It no longer reconstructs delivery context from the
  session-entry JSON shadow.
- Gateway `tools.effective` context resolution now reads typed SQLite
  delivery/routing rows for provider, account, target, thread, and reply-mode
  inputs. It no longer recovers those hot routing fields from stale
  `session_entries.entry_json` origin shadows.
- Realtime voice consult routing now resolves parent/call delivery from typed
  per-agent SQLite session rows. It no longer falls back to compatibility
  `SessionEntry.deliveryContext` shadows when choosing the embedded agent
  message route.
- ACP spawn heartbeat relay and parent-stream routing now read parent delivery
  from typed SQLite session rows. They no longer reconstruct parent delivery
  context from compatibility session-entry shadows.
- Session delivery route preservation now follows typed chat metadata and
  persisted delivery columns. It no longer extracts channel hints, direct/main
  markers, or thread shape from `sessionKey`; internal webchat routes only
  inherit an external target when SQLite already has typed/persisted delivery
  identity for the session.
- Generic session delivery extraction now reads only the exact typed SQLite
  session delivery row. It no longer parses thread/topic suffixes or falls back
  from a thread-shaped key to a base session key.
- Reply dispatch, restart sentinel recovery, and realtime voice consult routing
  now use exact typed SQLite session/conversation rows for thread routing. They
  no longer recover thread ids or base-session delivery context by parsing
  thread-shaped session keys.
- Embedded PI history limiting now uses the typed SQLite session routing
  projection (`sessions` + primary `conversations`) for provider, chat type,
  and peer identity. It no longer parses provider, DM, group, or thread shape
  out of `sessionKey`.
- Cron tool delivery inference now uses explicit delivery or the current typed
  delivery context only. It no longer decodes channel, peer, account, or thread
  targets from `agentSessionKey`.
- Runtime session rows no longer carry the old `lastProvider` route alias.
  Helpers and tests use typed `lastChannel` and `deliveryContext` fields;
  doctor migration is the only place that should translate older route aliases
  or persisted `origin` shadows.
- Transcript events, VFS rows, and tool artifact rows now write to the per-agent
  database. The unshipped global transcript-file mapping table is gone; doctor
  records legacy source paths in durable migration rows instead.
- Runtime transcript lookup no longer scans JSONL byte offsets or probes legacy
  transcript files. Gateway chat/media/history paths read transcript rows from
  SQLite; session JSONL is now only a legacy doctor input, not a runtime state
  or export format.
- Transcript parent and branch relationships use structured
  `parentTranscriptScope: {agentId, sessionId}` metadata in SQLite transcript
  headers, not path-like `agent-db:...transcript_events...` locator strings.
- The transcript manager contract no longer exposes implicit persisted
  `create(cwd)` or `continueRecent(cwd)` constructors. Persisted transcript
  managers are opened with an explicit `{agentId, sessionId}` scope; only
  in-memory managers remain scope-free for tests and pure transcript transforms.
- Runtime transcript store APIs resolve SQLite scope, not filesystem paths. The
  old `resolve...ForPath` helper and unused `transcriptPath` write options are
  gone from runtime callers.
- Runtime session resolution now uses `{agentId, sessionId}` and must not derive
  `sqlite-transcript://<agent>/<session>` strings for external boundaries.
  Legacy absolute JSONL paths are doctor migration inputs only.
- Native hook relay direct-bridge records now live in typed shared
  `native_hook_relay_bridges` rows keyed by relay id. Runtime no longer writes a
  `/tmp` JSON registry or opaque generic records for those short-lived bridge
  records.
- `runEmbeddedPiAgent(...)` no longer has a transcript-locator parameter.
  Prepared worker descriptors also omit transcript locators. Runtime session
  state and queued follow-up runs carry `{agentId, sessionId}` instead of
  derived transcript handles.
- Embedded compaction now takes SQLite scope from `agentId` and `sessionId`.
  Compaction hooks, context-engine calls, CLI delegation, and protocol replies
  must not receive derived `sqlite-transcript://...` handles. Export/debug code
  can materialize explicit user artifacts from rows, but it does not provide a
  generic session JSONL export path or feed file names back into runtime
  identity.
- `/export-session` reads transcript rows from SQLite and writes the requested
  standalone HTML view only. The embedded viewer no longer reconstructs or
  downloads session JSONL from those rows.
- Context-engine delegation no longer parses a transcript locator to recover
  agent identity. The prepared runtime context carries the resolved `agentId`
  into the built-in compaction adapter.
- Transcript rewrite and live tool-result truncation now read and persist
  transcript state by `{agentId, sessionId}` and do not derive temporary
  locators for transcript-update event payloads.
- The transcript-state helper surface no longer has locator-based
  `readTranscriptState`, `replaceTranscriptStateEvents`, or
  `persistTranscriptStateMutation` variants. Runtime callers must use the
  `{agentId, sessionId}` APIs. Doctor import reads legacy files by explicit file
  path and writes SQLite rows; it does not migrate locator strings.
- The runtime session-manager contract no longer exposes `open(locator)`,
  `forkFrom(locator)`, or `setTranscriptLocator(...)`. Persisted session
  managers open by `{agentId, sessionId}` only; list/fork helpers live on
  row-oriented session and checkpoint APIs instead of the transcript manager
  facade.
- Gateway transcript reader APIs are scope-first. They take
  `{agentId, sessionId}` and do not accept a positional transcript locator that
  could accidentally become runtime identity. Active transcript locator parsing
  is gone; legacy source paths are read only by doctor import code.
- Transcript update events are also scope-first. `emitSessionTranscriptUpdate`
  no longer accepts a bare locator string, and listeners route by
  `{agentId, sessionId}` without parsing a handle.
- Gateway session-message broadcast resolves session keys from agent/session
  scope, not from a transcript locator. The old transcript-locator-to-session
  key resolver/cache is gone.
- Gateway session-history SSE filters live updates by agent/session scope. It no
  longer canonicalizes transcript locator candidates, realpaths, or file-shaped
  transcript identities to decide whether a stream should receive an update.
- Session lifecycle hooks no longer derive or expose transcript locators on
  `session_end`. Hook consumers get `sessionId`, `sessionKey`, next-session
  ids, and agent context; transcript files are not part of the lifecycle
  contract.
- Reset hooks no longer derive or expose transcript locators either. The
  `before_reset` payload carries recovered SQLite messages plus the reset
  reason, while session identity stays in hook context.
- Agent harness reset no longer accepts a transcript locator. Reset dispatch is
  scoped by `sessionId`/`sessionKey` plus reason.
- Agent extension session types no longer expose `transcriptLocator`; extensions
  should use session context and runtime APIs rather than reaching for a
  file-shaped transcript identity.
- Plugin compaction hooks no longer expose transcript locators. Hook context
  already carries session identity, and transcript reads must go through SQLite
  scope-aware APIs instead of file-shaped handles.
- `before_agent_finalize` hooks no longer expose `transcriptPath`, including
  native hook relay payloads. Finalization hooks use session context only.
- Gateway reset responses no longer synthesize a transcript locator on the
  returned entry. The reset creates SQLite transcript rows, returns the clean
  session entry, and leaves transcript access to scope-aware readers.
- Embedded run and compaction results no longer surface transcript locators for
  session accounting. Automatic compaction updates only the active `sessionId`,
  compaction counters, and token metadata.
- Embedded attempt results no longer return `transcriptLocatorUsed`, and
  context-engine `compact()` results no longer return transcript locators.
  Runtime retry loops only accept a successor `sessionId`.
- Delivery-mirror transcript append results no longer return transcript
  locators. Callers get the appended `messageId`; transcript update signals use
  SQLite scope.
- Parent-session fork helpers return only the forked `sessionId`. Subagent
  preparation passes the child agent/session scope to engines.
- CLI runner params and history reseeding no longer accept transcript locators.
  CLI history reads resolve the SQLite transcript scope from `{agentId,
sessionId}` and session key context.
- CLI and embedded-runner test fixtures now seed and read SQLite transcript rows
  by session id instead of pretending active sessions are `*.jsonl` files or
  passing a `sqlite-transcript://...` string through runtime params.
- Session tool-result guard events emit from known session scope even when an
  in-memory manager has no derived locator. Its tests no longer fake active
  `/tmp/*.jsonl` transcript files.
- BTW and compaction-checkpoint helpers now read and fork transcript rows by
  SQLite scope. Checkpoint metadata now stores session ids and leaf/entry ids
  only; derived locators are no longer written into checkpoint payloads.
- Gateway transcript-key lookup uses SQLite transcript scope at protocol
  boundaries and no longer realpaths or stats transcript filenames.
- Automatic compaction transcript rotation writes successor transcript rows
  directly through the SQLite transcript store. Session rows keep only the
  successor session identity, not a durable JSONL path or persisted locator.
- Embedded context-engine compaction uses SQLite-named transcript rotation
  helpers. The rotation tests no longer construct JSONL successor paths or
  model active sessions as files.
- Managed outgoing image retention keys its transcript-message cache from
  SQLite transcript stats instead of filesystem stat calls.
- Runtime session locks and the standalone legacy `.jsonl.lock` doctor
  lane have been removed.
- The Microsoft Teams runtime barrel and public plugin SDK no longer re-export
  the old file-lock helper; durable plugin state paths are SQLite-backed.
- Session age/count pruning and explicit session cleanup have been removed.
  Doctor owns legacy import; stale sessions are reset or deleted explicitly.
- Doctor integrity checks no longer count a legacy JSONL file as a valid active
  transcript for a SQLite session row. Active transcript health is SQLite-only;
  legacy JSONL files are reported as migration/orphan-cleanup inputs.
- Doctor no longer treats `agents/<agent>/sessions/` as required runtime
  state. It only scans that directory when it already exists, as legacy import
  or orphan-cleanup input.
- Gateway `sessions.resolve`, session patch/reset/compact paths, subagent
  spawning, fast abort, ACP metadata, heartbeat-isolated sessions, and TUI
  patching no longer migrate or prune legacy session keys as a side effect of
  normal runtime work.
- CLI command session resolution now returns the owning `agentId` instead of a
  `storePath`, and it no longer copies legacy main-session rows during normal
  `--to` or `--session-id` resolution. Legacy main-row canonicalization belongs
  to doctor only.
- Runtime subagent depth resolution no longer reads `sessions.json` or JSON5
  session stores. It reads SQLite `session_entries` by agent id, and legacy
  depth/session metadata can only enter through the doctor import path.
- Auth profile session overrides persist through direct `{agentId, sessionKey}`
  row upserts instead of lazy-loading a file-shaped session-store runtime.
- Auto-reply verbose gating and session update helpers now read/upsert SQLite
  session rows by session identity and no longer require a legacy store path
  before touching persisted row state.
- Command-run session metadata helpers now use entry-oriented names and module
  paths; the old `session-store` command helper surface has been removed.
- Bootstrap header seeding and manual compaction boundary hardening now mutate
  SQLite transcript rows directly. Runtime callers pass session identity, not
  writable `.jsonl` paths.
- Silent session-rotation replay copies recent user/assistant turns by
  `{agentId, sessionId}` from SQLite transcript rows. It no longer accepts
  source or target transcript locators.
- Fresh runtime session rows no longer store transcript locators. Callers use
  `{agentId, sessionId}` directly; export/debug commands can choose output file
  names when they materialize rows.
- Starting a new persisted transcript session now always opens SQLite rows by
  scope. The session manager no longer reuses a previous file-era transcript
  path or locator as the identity for the new session.
- Persisted transcript sessions use the explicit
  `openTranscriptSessionManagerForSession({agentId, sessionId})` API. The old
  static `SessionManager.create/openForSession/list/forkFromSession` facades are
  gone so tests and runtime code cannot accidentally recreate file-era session
  discovery.
- Plugin runtime no longer exposes `api.runtime.agent.session.resolveTranscriptLocatorPath`;
  plugin code uses SQLite row helpers and scope values.
- The public `session-store-runtime` SDK surface now only exports session row
  and transcript row helpers. Focused SQLite schema/path/transaction helpers
  live in `sqlite-runtime`; raw open/close/reset helpers remain local-only for
  first-party tests.
- Legacy `.jsonl` trajectory/checkpoint filename classifiers now live in the
  doctor legacy session-file module. Core session validation no longer imports
  file-artifact helpers to decide normal SQLite session ids.
- Active-memory blocking subagent runs use SQLite transcript rows instead of
  creating temporary or persisted `session.jsonl` files under plugin state. The
  old `transcriptDir` option is removed.
- One-off slug generation and Crestodian planner runs use SQLite transcript rows
  instead of creating temporary `session.jsonl` files.
- `llm-task` helper runs and hidden commitment extraction also use SQLite
  transcript rows, so these model-only helper sessions no longer create
  temporary JSON/JSONL transcript files.
- `TranscriptSessionManager` is only an opened SQLite transcript scope now.
  Runtime code opens it with `openTranscriptSessionManagerForSession({agentId,
sessionId})`; create, branch, continue, list, and fork flows live in their
  owning SQLite row helpers rather than static manager facades.
  Doctor/import/debug code handles explicit legacy source files outside the
  runtime session manager.
- The stale `SessionManager.newSession()` and
  `SessionManager.createBranchedSession()` facade methods were removed. New
  sessions and transcript descendants are created by their owning SQLite
  workflow instead of mutating an already-open manager into a different
  persisted session.
- Parent transcript fork decisions and fork creation no longer accept
  `storePath` or `sessionsDir`; they use `{agentId, sessionId}` SQLite
  transcript scope instead of retained filesystem path metadata.
- Memory-host no longer exports no-op session-directory transcript
  classification helpers; transcript filtering now derives from SQLite row
  metadata during entry construction.
- Memory-host and QMD session-export tests use SQLite transcript scopes. Old
  `agents/<agentId>/sessions/*.jsonl` paths stay covered only where a test is
  intentionally proving doctor/import/export compatibility.
- QA-lab raw session inspection now uses `sessions.list` through the gateway
  instead of reading `agents/qa/sessions/sessions.json`; MSteams feedback
  appends directly to SQLite transcripts without fabricating a JSONL path.
- Shared inbound channel turns now carry `{agentId, sessionKey}` rather than a
  legacy `storePath`. LINE, WhatsApp, Slack, Discord, Telegram, Matrix, Signal,
  iMessage, BlueBubbles, Feishu, Google Chat, IRC, Nextcloud Talk, Zalo,
  Zalo Personal, QA Channel, Microsoft Teams, Mattermost, Synology Chat, Tlon,
  Twitch, and QQBot recording paths now read updated-at metadata and record
  inbound session rows through SQLite identity.
- Transcript locator persistence is removed from active session rows.
  `resolveSessionTranscriptTarget` returns `agentId`, `sessionId`, and optional
  topic metadata; doctor is the only code that imports legacy transcript file
  names.
- Runtime transcript headers start at SQLite version `1`. Old JSONL V1/V2/V3
  shape upgrades live only in doctor import and normalize imported headers to
  the current SQLite transcript version before rows are stored.
- The database-first guard now bans `SessionManager.listAll` and
  `SessionManager.forkFromSession`; session listing and fork/restore workflows
  must stay on row/scoped SQLite APIs.
- The guard also bans legacy transcript JSONL parse/active-branch repair helper
  names outside doctor/import code, so runtime cannot grow a second legacy
  transcript migration path.
- Embedded PI runs reject incoming transcript handles. They use the SQLite
  `{agentId, sessionId}` identity before worker launch and again before the
  attempt touches transcript state. A stale `/tmp/*.jsonl` input cannot select a
  runtime write target.
- Cache trace, Anthropic payload, raw stream, and diagnostics timeline records
  now write to typed SQLite `diagnostic_events` rows. Gateway stability bundles
  now write to typed SQLite `diagnostic_stability_bundles` rows. The old
  `diagnostics.cacheTrace.filePath`, `OPENCLAW_CACHE_TRACE_FILE`,
  `OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE`, and
  `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH` JSONL override paths are removed, and
  normal stability capture no longer writes `logs/stability/*.json` files.
- Cron persistence now reconciles SQLite `cron_jobs` rows instead of
  deleting/reinserting the whole job table on each save. Plugin target
  writebacks update matching cron rows directly and keep runtime cron state in
  the same state-database transaction.
- Cron runtime callers now use a stable SQLite cron store key. Legacy
  `cron.store` paths are doctor import inputs only; production gateway, task
  maintenance, status, run-log, and Telegram target writeback paths use
  `resolveCronStoreKey` and no longer path-normalize the key. Cron status now
  reports `storeKey` rather than the old file-shaped `storePath` field.
- Cron runtime load and scheduling no longer normalize legacy persisted job
  shapes such as `jobId`, `schedule.cron`, numeric `atMs`, string booleans, or
  missing `sessionTarget`. Doctor legacy import owns those repairs before rows
  are inserted into SQLite.
- ACP spawn no longer resolves or persists transcript JSONL file paths. Spawn
  and thread-bind setup persist the SQLite session row directly and keep the
  session id as the retained transcript identity.
- ACP session metadata APIs now read/list/upsert SQLite rows by `agentId` and
  no longer expose `storePath` as part of the ACP session entry contract.
- Session usage accounting and gateway usage aggregation now resolve transcripts
  by `{agentId, sessionId}` only. The cost/usage cache and discovered-session
  summaries no longer synthesize or return transcript locator strings.
- Gateway chat append, abort-partial persistence, `/sessions.send`, and
  webchat media transcript writes append directly through SQLite transcript
  scope. The gateway transcript-injection helper no longer accepts a
  `transcriptLocator` parameter.
- SQLite transcript discovery now lists transcript scopes and stats only:
  `{agentId, sessionId, updatedAt, eventCount}`. The dead
  `listSqliteSessionTranscriptLocators` compatibility helper and per-row
  `locator` field are gone.
- Transcript repair runtime now exposes only
  `repairTranscriptSessionStateIfNeeded({agentId, sessionId})`. The old
  locator-based repair helper is deleted; doctor/debug code reads explicit
  source file paths and never migrates locator strings.
- ACP replay ledger runtime now stores per-session replay rows in the shared
  SQLite state database instead of `acp/event-ledger.json`; doctor imports and
  removes the legacy file.
- Gateway transcript reader helpers now live in
  `src/gateway/session-transcript-readers.ts` instead of the old
  `session-utils.fs` module name. The fallback retry history check is named for
  SQLite transcript content instead of the old file-helper surface.
- Gateway injected-chat and compaction helpers now pass SQLite transcript scope
  through internal helper APIs instead of naming values transcript paths or
  source files.
- Bootstrap continuation detection now checks SQLite transcript rows through
  `hasCompletedBootstrapTranscriptTurn`; it no longer exposes a file-shaped
  helper name.
- Embedded-runner tests now use SQLite transcript identity, and opening a new
  transcript manager always requires an explicit `sessionId`.
- Memory indexing helpers now use SQLite transcript terminology end to end:
  host exports `listSessionTranscriptScopesForAgent` and
  `sessionTranscriptKeyForScope`, targeted sync queues `sessionTranscripts`,
  public session-search hits expose opaque `transcript:<agent>:<session>` paths,
  and the internal DB source key is `session:<session>` under
  `source_kind='sessions'` instead of a fake file path.
- The generic plugin SDK persistent-dedupe helper no longer exposes file-shaped
  options. Callers provide SQLite scope keys and durable dedupe rows live in
  shared plugin state.
- Microsoft Teams SSO tokens moved from locked JSON files to SQLite plugin
  state. Doctor imports `msteams-sso-tokens.json`, rebuilds canonical SSO token
  keys from payloads, and removes the source file. Delegated OAuth tokens stay
  on their existing private credential-file boundary.
- Matrix sync cache state moved from `bot-storage.json` to SQLite plugin
  state. Doctor imports legacy raw or wrapped sync payloads and removes the
  source file. Active Matrix and QA Matrix clients pass a SQLite sync-store root
  directory, not a fake `sync-store.json` or `bot-storage.json` path.
- Matrix legacy crypto migration status moved from
  `legacy-crypto-migration.json` to SQLite plugin state. Doctor imports the
  old status file; Matrix SDK IndexedDB snapshots moved from
  `crypto-idb-snapshot.json` to SQLite plugin blobs. Matrix recovery keys and
  credentials are SQLite plugin-state rows; their old JSON files are doctor
  migration inputs only.
- Memory Wiki activity logs now use SQLite plugin state instead of
  `.openclaw-wiki/log.jsonl`. The Memory Wiki migration provider imports old
  JSONL logs; wiki markdown and user vault content stay file-backed as
  workspace content.
- Memory Wiki no longer creates `.openclaw-wiki/state.json` or the unused
  `.openclaw-wiki/locks` directory. The migration provider removes those retired
  plugin metadata files if an older vault still has them.
- Crestodian audit entries now use core SQLite plugin state instead of
  `audit/crestodian.jsonl`. Doctor imports the legacy JSONL audit log and
  removes it after successful import.
- Config write/observe audit entries now use core SQLite plugin state instead
  of `logs/config-audit.jsonl`. Doctor imports the legacy JSONL audit log and
  removes it after successful import.
- The macOS companion no longer writes app-local `logs/config-audit.jsonl` or
  `logs/config-health.json` sidecars while editing `openclaw.json`. The config
  file remains file-backed, recovery snapshots stay next to the config file,
  and durable config audit/health state belongs to the Gateway SQLite store.
- Crestodian rescue pending approvals now use core SQLite plugin state instead
  of `crestodian/rescue-pending/*.json`. Doctor imports legacy pending approval
  files and removes them after successful import.
- Phone Control temporary arm state now uses SQLite plugin state instead of
  `plugins/phone-control/armed.json`. Doctor imports the legacy armed-state
  file into the `phone-control/arm-state` namespace and removes the file.
- Doctor no longer repairs JSONL transcripts in place or creates backup JSONL
  files. It imports the active branch into SQLite and removes the legacy source.
- Session-memory hook transcript lookup uses `{agentId, sessionId}` scope-only
  SQLite reads. Its helper no longer accepts or derives transcript locators,
  legacy file reads, or file-rewrite options.
- Codex app-server conversation bindings now key SQLite plugin state by
  OpenClaw session key or explicit `{agentId, sessionId}` scope. They must not
  preserve transcript-path fallback bindings.
- Codex app-server mirrored-history reads use the SQLite transcript scope only;
  they must not recover identity from transcript file paths.
- Role-ordering and compaction reset paths no longer unlink old transcript
  files; reset only rotates the SQLite session row and transcript identity.
- Gateway reset and checkpoint responses return clean session rows plus session
  ids. They no longer synthesize SQLite transcript locators for clients.
- Memory-core dreaming no longer prunes session rows by probing for missing
  JSONL files. Subagent cleanup goes through the session runtime API instead of
  filesystem existence checks. Its transcript-ingestion tests seed SQLite rows
  directly instead of creating `agents/<id>/sessions` fixtures or locator
  placeholders.
- Memory transcript indexing may expose `transcript:<agentId>:<sessionId>` as a
  virtual search-hit path for citation/read helpers. The durable index source is
  relational (`source_kind='sessions'`, `source_key='session:<sessionId>'`,
  `session_id=<sessionId>`), so the value is not a runtime transcript locator,
  not a filesystem path, and must never be passed back into session runtime APIs.
- Gateway doctor memory status reads short-term recall and phase-signal counts
  from SQLite plugin-state rows instead of `memory/.dreams/*.json`; CLI and
  doctor output now label that storage as a SQLite store, not a path.
- Memory-core runtime, CLI status, Gateway doctor methods, and plugin SDK
  facades no longer audit or archive legacy `.dreams/session-corpus` files.
  Those files are migration inputs only; doctor imports them into SQLite and
  deletes the source after verification. Active session-ingestion evidence rows
  now use the virtual SQLite path `memory/session-ingestion/<day>.txt`; runtime
  never writes or derives state from `.dreams/session-corpus`.
- Memory-core public artifacts expose SQLite host events as the virtual JSON
  artifact `memory/events/memory-host-events.json`; they no longer reuse the
  legacy `.dreams/events.jsonl` source path.
- Sandbox container/browser registries now use the shared
  `sandbox_registry_entries` SQLite table with typed session, image, timestamp,
  backend/config, and browser port columns. Doctor imports legacy monolithic and
  sharded JSON registry files and removes successful sources. Runtime reads use
  the typed row columns as source of truth; `entry_json` is only a replay/debug
  copy.
- Commitments now use a typed shared `commitments` table instead of a
  whole-store JSON blob. Snapshot saves upsert by commitment id and delete only
  missing rows instead of clearing and reinserting the table. Runtime loads
  commitments from typed scope, delivery-window, status, attempt, and text
  columns; `record_json` is only a replay/debug copy. Doctor imports legacy
  `commitments.json` and removes it after a successful import.
- Cron job definitions, schedule state, and run history no longer have runtime
  JSON writers or readers. Runtime uses `cron_jobs` rows with typed schedule,
  payload, delivery, failure-alert, session, status, and runtime-state columns plus typed
  `cron_run_logs` metadata for status, diagnostics summary, delivery status/error,
  session/run, model, and token totals. `job_json` is only a replay/debug copy; `state_json` keeps nested
  runtime diagnostics that do not yet have hot query fields, while runtime
  rehydrates hot state fields from typed columns. Doctor imports
  legacy `jobs.json`, `jobs-state.json`, and `runs/*.jsonl` files and removes
  the imported sources. Plugin target writebacks update matching `cron_jobs`
  rows instead of loading and replacing the whole cron store.
- Gateway startup ignores legacy `notify: true` markers in the runtime
  projection. Doctor translates them into explicit SQLite delivery when
  `cron.webhook` is valid, removes inert markers when it is unset, and preserves
  them with a warning when the configured webhook is invalid.
- Outbound and session delivery queues now store queue status, entry kind,
  session key, channel, target, account id, retry count, last attempt/error,
  recovery state, and platform-send markers as typed columns in the shared
  `delivery_queue_entries` table. Runtime recovery reads those hot fields from
  the typed columns, and retry/recovery mutations update those columns directly
  without rewriting replay JSON. The full JSON payload remains only as the
  replay/debug blob for message bodies and other cold replay data.
- Managed outgoing image records now use typed shared
  `managed_outgoing_image_records` rows with media bytes still stored in
  `media_blobs`. The JSON record remains only as a replay/debug copy.
- Discord model-picker preferences, command-deploy hashes, and thread bindings
  now use shared SQLite plugin state. Their legacy JSON import plans live in the
  Discord plugin setup/doctor migration surface, not in core migration code.
- Plugin legacy import detectors use doctor-named modules such as
  `doctor-legacy-state.ts` or `doctor-state-imports.ts`; normal channel runtime
  modules must not import legacy JSON detectors.
- BlueBubbles catchup cursors and inbound dedupe markers now use shared SQLite
  plugin state. Their legacy JSON import plans live in the BlueBubbles plugin
  setup/doctor migration surface, not in core migration code.
- Telegram update offsets, sticker cache rows, sent-message cache rows,
  topic-name cache rows, and thread bindings now use shared SQLite plugin
  state. Their legacy JSON import plans live in the Telegram plugin
  setup/doctor migration surface, not in core migration code.
- iMessage catchup cursors, reply short-id mappings, and sent-echo dedupe rows
  now use shared SQLite plugin state. The old `imessage/catchup/*.json`,
  `imessage/reply-cache.jsonl`, and `imessage/sent-echoes.jsonl` files are
  doctor inputs only.
- Feishu message dedupe rows now ride the core claimable dedupe
  (`feishu.dedup.*` namespaces in shared SQLite plugin state) instead of
  `feishu/dedup/*.json` files or the retired hand-rolled `dedup.*` store, with
  no legacy import because replay-protection cache rebuilds after upgrade.
- Microsoft Teams conversations, polls, pending upload buffers, and feedback
  learnings now use shared SQLite plugin state/blob tables. The pending upload
  path uses `plugin_blob_entries` so media buffers are stored as SQLite BLOBs
  instead of base64 JSON. The runtime helper names now use SQLite/state naming
  rather than `*-fs` file-store naming, and the old `storePath` shim is gone
  from these stores. Its legacy JSON import plan lives in the Microsoft Teams
  plugin setup/doctor migration surface.
- Zalo hosted outbound media now uses shared SQLite `plugin_blob_entries`
  instead of `openclaw-zalo-outbound-media` JSON/bin temp sidecars.
- Diffs viewer HTML and metadata now use shared SQLite `plugin_blob_entries`
  instead of `meta.json`/`viewer.html` temp files. Rendered PNG/PDF outputs stay
  temp materializations because channel delivery still needs a file path.
- Canvas managed documents now use shared SQLite `plugin_blob_entries` instead
  of a default `state/canvas/documents` directory. The Canvas host serves those
  blobs directly; local files are created only for explicit `host.root`
  operator content or temporary materialization when a downstream media reader
  requires a path.
- File Transfer audit decisions now use shared SQLite `plugin_state_entries`
  instead of the unbounded `audit/file-transfer.jsonl` runtime log. Doctor
  imports the legacy JSONL audit file into plugin state and removes the source
  after a clean import.
- ACPX process leases and gateway instance identity now use shared SQLite plugin
  state. Doctor imports the legacy `gateway-instance-id` file into plugin state
  and removes the source.
- ACPX generated wrapper scripts and the isolated Codex home are temporary
  materialization under the OpenClaw temp root, not durable OpenClaw state. The
  durable ACPX runtime records are the SQLite lease and gateway-instance rows;
  the old ACPX `stateDir` config surface is removed because no runtime state is
  written there anymore.
- Gateway media attachments now use the shared `media_blobs` SQLite table as
  the canonical byte store. Local paths returned to channel and sandbox
  compatibility surfaces are temp materializations of the database row, not the
  durable media store. Runtime media allowlists no longer include legacy
  `$OPENCLAW_STATE_DIR/media` or config-dir `media` roots; those directories are
  doctor import sources only.
- Shell completion no longer writes `$OPENCLAW_STATE_DIR/completions/*` cache
  files. Install, doctor, update, and release smoke paths use generated
  completion output or profile sourcing instead of durable completion cache
  files.
- Gateway skill-upload staging now uses shared `skill_uploads` rows. Upload
  metadata, idempotency keys, and archive bytes live in SQLite; the installer
  only receives a temporary materialized archive path while an install is
  running.
- Subagent inline attachments no longer materialize under workspace
  `.openclaw/attachments/*`. The spawn path prepares SQLite VFS seed entries,
  inline runs seed those entries into the per-agent runtime scratch namespace,
  and disk-backed tools overlay that SQLite scratch for attachment paths. The
  old subagent-run attachment-dir registry columns and cleanup hooks are gone.
- CLI image hydration no longer maintains stable `openclaw-cli-images` cache
  files. External CLI backends still receive file paths, but those paths are
  per-run temp materializations with cleanup.
- Cache-trace diagnostics, Anthropic payload diagnostics, raw model stream
  diagnostics, diagnostics timeline events, and Gateway stability bundles now
  write SQLite rows instead of `logs/*.jsonl` or
  `logs/stability/*.json` files.
  Runtime path override flags and env vars have been removed; export/debug
  commands can materialize files explicitly from database rows.
- The macOS companion no longer has a rolling `diagnostics.jsonl` writer. App
  logs go to unified logging, and durable Gateway diagnostics stay SQLite-backed.
- The macOS port-guardian record list now uses typed shared SQLite
  `macos_port_guardian_records` rows instead of an Application Support JSON file
  or opaque singleton blob.
- Gateway singleton locks now use typed shared SQLite `state_leases` rows under
  the `gateway_locks` scope instead of temp-dir lock files. Fly and OAuth
  troubleshooting docs now point at the SQLite lease/auth refresh lock instead
  of stale file-lock cleanup.
- Gateway restart sentinel state now uses typed shared SQLite
  `gateway_restart_sentinel` rows instead of `restart-sentinel.json`; runtime
  reads sentinel kind, status, routing, message, continuation, and stats from
  typed columns. `payload_json` is only a replay/debug copy. Runtime code clears
  the SQLite row directly and no longer carries file cleanup plumbing.
- Gateway restart intent and supervisor handoff state now use typed shared
  SQLite `gateway_restart_intent` and `gateway_restart_handoff` rows instead of
  `gateway-restart-intent.json` and
  `gateway-supervisor-restart-handoff.json` sidecars.
- Gateway singleton coordination now uses typed `state_leases` rows under
  `gateway_locks` instead of writing `gateway.<hash>.lock` files. The lease row
  owns the lock owner, expiry, heartbeat, and debug payload; SQLite owns the
  atomic acquire/release boundary. The retired file-lock directory option is
  gone; tests use the SQLite row identity directly.
- The old unreferenced cron usage-report helper that scanned `cron/runs/*.jsonl`
  files was deleted. Cron run history reports should read the typed
  `cron_run_logs` SQLite rows.
- Main-session restart recovery now discovers candidate agents through the
  SQLite `agent_databases` registry instead of scanning `agents/*/sessions`
  directories.
- Gemini session-corruption recovery now deletes only the SQLite session row;
  it no longer needs a legacy `storePath` gate or tries to unlink a derived
  transcript JSONL path.
- Path override handling now treats literal `undefined`/`null` environment
  values as unset, preventing accidental repo-root `undefined/state/*.sqlite`
  databases during tests or shell handoffs.
- Config health fingerprints now use typed shared SQLite `config_health_entries`
  rows instead of `logs/config-health.json`, keeping the normal config file as
  the only non-credential configuration document. The macOS companion keeps only
  process-local health state and does not recreate the old JSON sidecar.
- Auth profile runtime no longer imports or writes credential JSON files. The
  canonical credential store is SQLite; `auth-profiles.json`, per-agent
  `auth.json`, and shared `credentials/oauth.json` are doctor migration inputs
  that are removed after import.
- Auth profile save/state tests now assert typed SQLite auth tables directly
  and only use legacy auth-profile filenames for doctor migration inputs.
- `openclaw secrets apply` scrubs the config file, env file, and SQLite
  auth-profile store only. It no longer carries compatibility logic that edits
  retired per-agent `auth.json`; doctor owns importing and deleting that file.
- Hermes secret migration plans and applies imported API-key profiles directly
  into the SQLite auth-profile store. It no longer writes or verifies
  `auth-profiles.json` as an intermediate target.
- User-facing auth docs now describe
  `state/openclaw.sqlite#table/auth_profile_stores/<agentDir>` instead of
  telling users to inspect or copy `auth-profiles.json`; legacy OAuth/auth JSON
  names remain documented only as doctor-import inputs.
- Core state-path helpers no longer expose the retired `credentials/oauth.json`
  file. The legacy filename is local to the doctor auth import path.
- Install, security, onboarding, model-auth, and SecretRef docs now describe
  SQLite auth-profile rows and whole-state backup/migration instead of
  per-agent auth-profile JSON files.
- PI model discovery now passes canonical credentials into in-memory
  `pi-coding-agent` auth storage. It no longer creates, scrubs, or writes
  per-agent `auth.json` during discovery.
- Voice Wake trigger and routing settings now use typed shared SQLite tables
  instead of `settings/voicewake.json`, `settings/voicewake-routing.json`, or
  opaque generic rows; doctor imports the legacy JSON files and removes them after a
  successful migration.
- Update-check state now uses a typed shared `update_check_state` row instead of
  `update-check.json` or an opaque generic blob; doctor imports
  the legacy JSON file and removes it after a successful migration.
- Config health state now uses typed shared `config_health_entries` rows instead
  of `logs/config-health.json` or an opaque generic blob; doctor
  imports the legacy JSON file and removes it after a successful migration.
- Plugin conversation binding approvals now use typed
  `plugin_binding_approvals` rows instead of opaque shared SQLite state or
  `plugin-binding-approvals.json`; the legacy file is a doctor migration input.
- Generic current-conversation bindings now store typed
  `current_conversation_bindings` rows instead of rewriting
  `bindings/current-conversations.json`; doctor imports the legacy JSON file and
  removes it after a successful migration.
- Memory Wiki imported-source sync ledgers now store one SQLite plugin-state row
  per vault/source key instead of rewriting `.openclaw-wiki/source-sync.json`;
  the migration provider imports and removes the legacy JSON ledger.
- Memory Wiki ChatGPT import-run records now store one SQLite plugin-state row
  per vault/run id instead of writing `.openclaw-wiki/import-runs/*.json`.
  Rollback snapshots remain explicit vault files until import-run snapshot
  archival is moved into blob storage.
- Memory Wiki compiled digests now store SQLite plugin blob rows instead of
  writing `.openclaw-wiki/cache/agent-digest.json` and
  `.openclaw-wiki/cache/claims.jsonl`. The migration provider imports old cache
  files and removes the cache directory when it becomes empty.
- ClawHub skill install tracking now stores one SQLite plugin-state row per
  workspace/skill instead of writing or reading `.clawhub/lock.json` and
  `.clawhub/origin.json` sidecars at runtime. Runtime code uses tracked-install
  state objects rather than file-shaped lockfile/origin abstractions. Doctor
  imports the legacy sidecars from configured agent workspaces and removes them
  after a clean import.
- The installed plugin index now reads and writes the typed shared SQLite
  `installed_plugin_index` singleton row instead of `plugins/installs.json`; the
  legacy JSON file is only a doctor migration input and is removed after import.
- The legacy `plugins/installs.json` path helper now lives in doctor legacy
  code. Runtime plugin-index modules expose only SQLite-backed persistence
  options, not a JSON file path.
- Gateway restart sentinel, restart intent, and supervisor handoff state now use
  typed shared SQLite rows (`gateway_restart_sentinel`,
  `gateway_restart_intent`, and `gateway_restart_handoff`) instead of generic
  opaque blobs. Runtime restart code has no file-shaped sentinel/intent/handoff
  contract.
- Matrix sync cache, storage metadata, thread bindings, inbound dedupe markers,
  startup verification cooldown state, SDK IndexedDB crypto snapshots,
  credentials, and recovery keys now use shared SQLite plugin state/blob
  tables. Runtime path structs no longer expose a `storage-meta.json` metadata
  path; that filename is a legacy migration input only. Their legacy JSON import
  plan lives in the Matrix plugin setup/doctor migration surface. Inbound
  dedupe markers ride the core claimable dedupe (`matrix.inbound-dedupe.*`
  namespaces in the shared state DB); the Matrix doctor state migration imports
  the retired per-root `inbound-dedupe` rows and `inbound-dedupe.json` once,
  then the runtime reads only the claimable-dedupe store.
- Matrix startup no longer scans, reports, or completes legacy Matrix file
  state. Matrix file detection, legacy crypto snapshot creation, room-key
  restore migration state, import, and source removal are all doctor-owned.
- Matrix runtime migration barrels were removed. Legacy state/crypto detection
  and mutation helpers are imported by Matrix doctor directly instead of being
  part of runtime API surface.
- Matrix migration snapshot reuse markers now live in SQLite plugin state
  instead of `matrix/migration-snapshot.json`; doctor can still reuse the same
  verified pre-migration archive without writing a sidecar state file.
- Nostr bus cursors and profile publish state now use shared SQLite plugin
  state. Their legacy JSON import plan lives in the Nostr plugin setup/doctor
  migration surface.
- Active Memory session toggles now use shared SQLite plugin state instead of
  `session-toggles.json`; toggling memory back on deletes the row instead of
  rewriting a JSON object.
- Skill Workshop proposals and review counters now use shared SQLite plugin
  state instead of per-workspace `skill-workshop/<workspace>.json` stores. Each
  proposal is a separate row under `skill-workshop/proposals`, and the review
  counter is a separate row under `skill-workshop/reviews`.
- Skill Workshop reviewer subagent runs now use the runtime session transcript
  resolver instead of creating `skill-workshop/<sessionId>.json` sidecar session
  paths.
- ACPX process leases now use shared SQLite plugin state under
  `acpx/process-leases` instead of a whole-file `process-leases.json` registry.
  Each lease is stored as its own row, preserving startup stale-process reaping
  without a runtime JSON rewrite path.
- ACPX wrapper scripts and the isolated Codex home are generated in the
  OpenClaw temp root. They are recreated as needed and are not backup or
  migration inputs.
- Subagent run registry persistence uses typed shared `subagent_runs` rows. The
  old `subagents/runs.json` path is now only a doctor migration input, and
  runtime helper names no longer describe the state layer as disk-backed.
  Runtime tests no longer create invalid or empty `runs.json` fixtures to prove
  registry behavior; they seed/read SQLite rows directly.
- Backup stages the state directory before archiving, copies non-database files,
  snapshots `*.sqlite` databases with `VACUUM INTO`, omits live WAL/SHM
  sidecars, records snapshot metadata in the archive manifest, and records
  completed backup runs in SQLite with the archive manifest. `openclaw backup
create` validates the written archive by default; `--no-verify` is the
  explicit fast path.
- `openclaw backup restore` validates the archive before extraction, reuses the
  verifier's normalized manifest, and restores verified manifest assets to their
  recorded source paths. It requires `--yes` for writes and supports `--dry-run`
  for a restore plan.
- The old backup volatile-path filter is deleted. Backup no longer needs a
  live-tar skip list for legacy session or cron JSON/JSONL files because SQLite
  snapshots are staged before archive creation.
- Plain setup and onboarding workspace preparation no longer create
  `agents/<agentId>/sessions/` directories. They create config/workspace only;
  SQLite session rows and transcript rows are created on demand in the
  per-agent database.
- Security permission repair now targets the global and per-agent SQLite
  databases plus WAL/SHM sidecars instead of `sessions.json` and transcript
  JSONL files.
- Sandbox registry runtime names now describe SQLite registry kinds directly
  instead of carrying legacy JSON registry terminology through the active store.
- `openclaw reset --scope config+creds+sessions` removes per-agent
  `openclaw-agent.sqlite` databases plus WAL/SHM sidecars, not only legacy
  `sessions/` directories.
- Gateway aggregate session helpers now use entry-oriented names:
  `loadCombinedSessionEntriesForGateway` returns `{ databasePath, entries }`.
  The old combined-store naming has been removed from runtime callers.
- Docker MCP channel seeding now writes the main session row and transcript
  events into the per-agent SQLite database instead of creating
  `sessions.json` and a JSONL transcript.
- The bundled session-memory hook now resolves previous-session context from
  SQLite by `{agentId, sessionId}`. It no longer scans, stores, or synthesizes
  transcript paths or `workspace/sessions` directories.
- The bundled command-logger hook now writes command audit rows to the shared
  SQLite `command_log_entries` table instead of appending
  `logs/commands.log`.
- Channel pairing allowlists now expose only SQLite-backed read/write helpers at
  runtime and in the plugin SDK. The old `*-allowFrom.json` path resolver and
  file reader live only under doctor legacy import code.
- `migration_runs` records legacy-state migration executions with status,
  timestamps, and JSON reports.
- `migration_sources` records each imported legacy file source with hash, size,
  record count, target table, run id, status, and source-removal state.
- `backup_runs` records backup archive paths, status, and JSON manifests.
- The global schema does not keep an unused `agents` registry table. Agent
  database discovery is the canonical `agent_databases` registry until runtime
  has a real agent-record owner.
- Generated model catalog config is stored in typed global SQLite
  `agent_model_catalogs` rows keyed by agent directory. Runtime callers use
  `ensureOpenClawModelCatalog`; there is no `models.json` compatibility API in
  runtime code. The implementation writes SQLite and the embedded PI registry is
  hydrated from that stored payload without creating a `models.json` file.
- QMD session transcript markdown export and `memory.qmd.sessions` config were
  removed. There is no QMD transcript collection, no `qmd/sessions*` runtime
  path, and no file-backed session memory bridge.
- Memory-core runtime imports SQLite transcript indexing helpers from
  `openclaw/plugin-sdk/memory-core-host-engine-session-transcripts`, not the
  QMD SDK subpath. The QMD subpath keeps a compatibility re-export only for
  external callers until a major SDK cleanup can remove it.
- QMD's own `index.sqlite` is now a temp runtime materialization backed by the
  main SQLite `plugin_blob_entries` table. Runtime no longer creates a durable
  `~/.openclaw/agents/<agentId>/qmd` sidecar.
- The optional `memory-lancedb` plugin no longer creates
  `~/.openclaw/memory/lancedb` as an implicit OpenClaw-managed store. It is an
  external LanceDB backend and stays disabled until the operator configures an
  explicit `dbPath`.
- `check:database-first-legacy-stores` fails new runtime source that pairs
  legacy store names with write-style filesystem APIs. It also fails runtime
  source that reintroduces the retired transcript bridge markers
  `transcriptLocator` or `sqlite-transcript://...`. Migration, doctor, import,
  and explicit non-session export code remain allowed. Broader legacy contract
  names such as `sessionFile`, `storePath`, and old `SessionManager` file-era
  facades still have current owners and need separate migration guard work
  before they can become a required preflight check. The guard now also covers
  runtime `cache/*.json` stores, generic
  `thread-bindings.json` sidecars, cron state/run-log JSON, config health JSON,
  restart and lock sidecars, Voice Wake settings, plugin binding approvals,
  installed plugin index JSON, File Transfer audit JSONL, Memory Wiki activity
  logs, the old bundled `command-logger` text log, and pi-mono raw-stream JSONL
  diagnostics knobs. It also bans old root-level doctor legacy module names so
  compatibility code stays under `src/commands/doctor/`. Android debug handlers
  also use logcat/in-memory output instead of staging `camera_debug.log` or
  `debug_logs.txt` cache files.

## Target Schema Shape

Keep schemas explicit. Host-owned runtime state uses typed tables. Plugin-owned
opaque state uses `plugin_state_entries` / `plugin_blob_entries`; there is no
generic host `kv` table.

Global database:

```text
state_leases(scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
exec_approvals_config(config_key, raw_json, socket_path, has_socket_token, default_security, default_ask, default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms)
schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
agent_databases(agent_id, path, schema_version, last_seen_at, size_bytes)
task_runs(...)
task_delivery_state(...)
flow_runs(...)
subagent_runs(run_id, child_session_key, requester_session_key, controller_session_key, created_at, ended_at, cleanup_handled, payload_json)
current_conversation_bindings(binding_key, binding_id, target_agent_id, target_session_id, target_session_key, channel, account_id, conversation_kind, parent_conversation_id, conversation_id, target_kind, status, bound_at, expires_at, metadata_json, updated_at)
plugin_binding_approvals(plugin_root, channel, account_id, plugin_id, plugin_name, approved_at)
tui_last_sessions(scope_key, session_key, updated_at)
plugin_state_entries(plugin_id, namespace, entry_key, value_json, created_at, expires_at)
plugin_blob_entries(plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
media_blobs(subdir, id, content_type, size_bytes, blob, created_at, updated_at)
skill_uploads(upload_id, kind, slug, force, size_bytes, sha256, actual_sha256, received_bytes, archive_blob, created_at, expires_at, committed, committed_at, idempotency_key_hash)
web_push_subscriptions(endpoint_hash, subscription_id, endpoint, p256dh, auth, created_at_ms, updated_at_ms)
web_push_vapid_keys(key_id, public_key, private_key, subject, updated_at_ms)
apns_registrations(node_id, transport, token, relay_handle, send_grant, installation_id, topic, environment, distribution, token_debug_suffix, updated_at_ms)
node_host_config(config_key, version, node_id, token, display_name, gateway_host, gateway_port, gateway_tls, gateway_tls_fingerprint, updated_at_ms)
device_identities(identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms)
device_auth_tokens(device_id, role, token, scopes_json, updated_at_ms)
macos_port_guardian_records(pid, port, command, mode, timestamp)
workspace_setup_state(workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at)
native_hook_relay_bridges(relay_id, pid, hostname, port, token, expires_at_ms, updated_at_ms)
model_capability_cache(provider_id, model_id, name, input_text, input_image, reasoning, supports_tools, context_window, max_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, updated_at_ms)
agent_model_catalogs(catalog_key, agent_dir, raw_json, updated_at)
managed_outgoing_image_records(attachment_id, session_key, message_id, created_at, updated_at, retention_class, alt, original_media_id, original_media_subdir, original_content_type, original_width, original_height, original_size_bytes, original_filename, record_json)
gateway_restart_sentinel(sentinel_key, version, kind, status, ts, session_key, thread_id, delivery_channel, delivery_to, delivery_account_id, message, continuation_json, doctor_hint, stats_json, payload_json, updated_at_ms)
channel_pairing_requests(channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json)
channel_pairing_allow_entries(channel_key, account_id, entry, sort_order, updated_at)
voicewake_triggers(config_key, position, trigger, updated_at_ms)
voicewake_routing_config(config_key, version, default_target_mode, default_target_agent_id, default_target_session_key, updated_at_ms)
voicewake_routing_routes(config_key, position, trigger, target_mode, target_agent_id, target_session_key, updated_at_ms)
update_check_state(state_key, last_checked_at, last_notified_version, last_notified_tag, last_available_version, last_available_tag, auto_install_id, auto_first_seen_version, auto_first_seen_tag, auto_first_seen_at, auto_last_attempt_version, auto_last_attempt_at, auto_last_success_version, auto_last_success_at, updated_at_ms)
config_health_entries(config_path, last_known_good_json, last_promoted_good_json, last_observed_suspicious_signature, updated_at_ms)
sandbox_registry_entries(registry_kind, container_name, session_key, backend_id, runtime_label, image, created_at_ms, last_used_at_ms, config_label_kind, config_hash, cdp_port, no_vnc_port, entry_json, updated_at)
cron_run_logs(store_key, job_id, seq, ts, status, error, summary, diagnostics_summary, delivery_status, delivery_error, delivered, session_id, session_key, run_id, run_at_ms, duration_ms, next_run_at_ms, model, provider, total_tokens, entry_json, created_at)
cron_jobs(store_key, job_id, name, description, enabled, delete_after_run, created_at_ms, agent_id, session_key, schedule_kind, schedule_expr, schedule_tz, every_ms, anchor_ms, at, stagger_ms, session_target, wake_mode, payload_kind, payload_message, payload_model, payload_fallbacks_json, payload_thinking, payload_timeout_seconds, payload_allow_unsafe_external_content, payload_external_content_source_json, payload_light_context, payload_tools_allow_json, delivery_mode, delivery_channel, delivery_to, delivery_thread_id, delivery_account_id, delivery_best_effort, failure_delivery_mode, failure_delivery_channel, failure_delivery_to, failure_delivery_account_id, failure_alert_disabled, failure_alert_after, failure_alert_channel, failure_alert_to, failure_alert_cooldown_ms, failure_alert_include_skipped, failure_alert_mode, failure_alert_account_id, next_run_at_ms, running_at_ms, last_run_at_ms, last_run_status, last_error, last_duration_ms, consecutive_errors, consecutive_skipped, schedule_error_count, last_delivery_status, last_delivery_error, last_delivered, last_failure_alert_at_ms, job_json, state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at)
delivery_queue_entries(queue_name, id, status, entry_kind, session_key, channel, target, account_id, retry_count, last_attempt_at, last_error, recovery_state, platform_send_started_at, entry_json, enqueued_at, updated_at, failed_at)
commitments(id, agent_id, session_key, channel, account_id, recipient_id, thread_id, sender_id, kind, sensitivity, source, status, reason, suggested_text, dedupe_key, confidence, due_earliest_ms, due_latest_ms, due_timezone, source_message_id, source_run_id, created_at_ms, updated_at_ms, attempts, last_attempt_at_ms, sent_at_ms, dismissed_at_ms, snoozed_until_ms, expired_at_ms, record_json)
migration_runs(id, started_at, finished_at, status, report_json)
migration_sources(source_key, migration_kind, source_path, target_table, source_sha256, source_size_bytes, source_record_count, last_run_id, status, imported_at, removed_source, report_json)
backup_runs(id, created_at, archive_path, status, manifest_json)
```

Agent database:

```text
schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
sessions(session_id, session_key, session_scope, created_at, updated_at, started_at, ended_at, status, chat_type, channel, account_id, primary_conversation_id, model_provider, model, agent_harness_id, parent_session_key, spawned_by, display_name)
conversations(conversation_id, channel, account_id, kind, peer_id, parent_conversation_id, thread_id, native_channel_id, native_direct_user_id, label, metadata_json, created_at, updated_at)
session_conversations(session_id, conversation_id, role, first_seen_at, last_seen_at)
session_routes(session_key, session_id, updated_at)
session_entries(session_id, session_key, entry_json, updated_at)
transcript_events(session_id, seq, event_json, created_at)
transcript_event_identities(session_id, event_id, seq, event_type, has_parent, parent_id, message_idempotency_key, created_at)
transcript_snapshots(session_id, snapshot_id, reason, event_count, created_at, metadata_json)
vfs_entries(namespace, path, kind, content_blob, metadata_json, updated_at)
tool_artifacts(run_id, artifact_id, kind, metadata_json, blob, created_at)
run_artifacts(run_id, path, kind, metadata_json, blob, created_at)
trajectory_runtime_events(session_id, run_id, seq, event_json, created_at)
memory_index_meta(key, value)
memory_index_sources(path, source, hash, mtime, size)
memory_index_chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
memory_embedding_cache(provider, model, provider_key, hash, embedding, dims, updated_at)
memory_index_state(id, revision)
cache_entries(scope, key, value_json, blob, expires_at, updated_at)
```

Future search can add FTS tables without changing the canonical event tables:

```text
transcript_events_fts(session_id, seq, text)
vfs_entries_fts(namespace, path, text)
```

Large values should use `blob` columns, not JSON string encoding. Keep
`value_json` for small structured data that must remain inspectable with plain
SQLite tooling.

`agent_databases` is the canonical registry for this branch. Do not add an
`agents` table until a real agent-record owner exists; agent config remains in
`openclaw.json`.

## Doctor Migration Shape

Doctor should call one explicit migration step that is reportable and safe to
rerun:

```bash
openclaw doctor --fix
```

`openclaw doctor --fix` invokes the state migration implementation after
ordinary config preflight and creates a verified backup before import. Runtime
startup and `openclaw migrate` must not import legacy OpenClaw state files.

Migration properties:

- One migration pass discovers all legacy file sources and produces a plan
  before mutating anything.
- Doctor creates a verified pre-migration backup archive before importing
  legacy files.
- Imports are idempotent and keyed by source path, mtime, size, hash, and target
  table.
- Successful source files are removed or archived after the target database has
  committed.
- Failed imports leave the source untouched and record a warning in
  `migration_runs`.
- Runtime code reads SQLite only after the migration exists.
- No downgrade/export-to-runtime-files path is required.

## Migration Inventory

Move these into the global database:

- Task registry runtime writes now use the shared database; the unshipped
  `tasks/runs.sqlite` sidecar importer is deleted. Snapshot saves upsert by task
  id and delete only missing task/delivery rows.
- Task Flow runtime writes now use the shared database; the unshipped
  `tasks/flows/registry.sqlite` sidecar importer is deleted. Snapshot saves
  upsert by flow id and delete only missing flow rows.
- Plugin state runtime writes now use the shared database; the unshipped
  `plugin-state/state.sqlite` sidecar importer is deleted.
- Builtin memory search no longer defaults to `memory/<agentId>.sqlite`; its
  index tables live in the owning agent database, and the explicit
  `memorySearch.store.path` sidecar opt-in has been retired to doctor config
  migration.
- Builtin memory reindex resets only memory-owned tables in the agent database.
  It must not replace the whole SQLite file, because the same database owns
  sessions, transcripts, VFS rows, artifacts, and runtime caches.
- Sandbox container/browser registries from monolithic and sharded JSON. Runtime
  writes now use the shared database; legacy JSON import remains.
- Cron job definitions, schedule state, and run history now use shared SQLite;
  doctor imports/removes legacy `jobs.json`, `jobs-state.json`, and
  `cron/runs/*.jsonl` files
- Device identity/auth, push, update check, commitments, OpenRouter model
  cache, installed plugin index, and app-server bindings
- Device/node pairing and bootstrap records now use typed SQLite tables
- Device-pair notification subscribers and delivered-request markers now use the
  shared SQLite plugin-state table instead of `device-pair-notify.json`.
- Voice-call call records now use the shared SQLite plugin-state table under the
  `voice-call` / `calls` namespace instead of `calls.jsonl`; the plugin CLI
  tails and summarizes SQLite-backed call history.
- QQBot gateway sessions, known-user records, and ref-index quote cache now use
  SQLite plugin state under `qqbot` namespaces (`gateway-sessions`,
  `known-users`, `ref-index`) instead of `session-*.json`, `known-users.json`,
  and `ref-index.jsonl`. Those legacy files are caches and are not migrated.
- Discord model-picker preferences, command-deploy hashes, and thread bindings
  now use SQLite plugin state under `discord` namespaces
  (`model-picker-preferences`, `command-deploy-hashes`, `thread-bindings`)
  instead of `model-picker-preferences.json`, `command-deploy-cache.json`, and
  `thread-bindings.json`; the Discord doctor/setup migration imports and
  removes the legacy files.
- BlueBubbles catchup cursors and inbound dedupe markers now use SQLite plugin
  state under `bluebubbles` namespaces (`catchup-cursors`, `inbound-dedupe`)
  instead of `bluebubbles/catchup/*.json` and
  `bluebubbles/inbound-dedupe/*.json`; the BlueBubbles doctor/setup migration
  imports and removes the legacy files.
- Telegram update offsets, sticker cache entries, reply-chain message cache
  entries, sent-message cache entries, topic-name cache entries, and thread
  bindings now use SQLite plugin state under `telegram` namespaces
  (`update-offsets`, `sticker-cache`, `message-cache`, `sent-messages`,
  `topic-names`, `thread-bindings`) instead of `update-offset-*.json`,
  `sticker-cache.json`, `*.telegram-messages.json`,
  `*.telegram-sent-messages.json`, `*.telegram-topic-names.json`, and
  `thread-bindings-*.json`; the Telegram doctor/setup migration imports and
  removes the legacy files.
- iMessage catchup cursors, reply short-id mappings, and sent-echo dedupe rows
  now use SQLite plugin state under `imessage` namespaces (`catchup-cursors`,
  `reply-cache`, `sent-echoes`) instead of `imessage/catchup/*.json`,
  `imessage/reply-cache.jsonl`, and `imessage/sent-echoes.jsonl`; the iMessage
  doctor/setup migration imports and removes the legacy files.
- Microsoft Teams conversations, polls, SSO tokens, and feedback learnings now
  use SQLite plugin state namespaces (`conversations`, `polls`, `sso-tokens`,
  `feedback-learnings`) instead of `msteams-conversations.json`,
  `msteams-polls.json`, `msteams-sso-tokens.json`, and `*.learnings.json`; the
  Microsoft Teams doctor/setup migration imports and archives the legacy files.
  Pending uploads are a short-lived SQLite cache and old JSON cache files are
  not migrated.
- Matrix sync cache, storage metadata, thread bindings, inbound dedupe markers,
  startup verification cooldown state, credentials, recovery keys, and SDK
  IndexedDB crypto snapshots now use SQLite plugin state/blob namespaces under
  `matrix` (`sync-store`, `storage-meta`, `thread-bindings`,
  `matrix.inbound-dedupe.*` via the core claimable dedupe,
  `startup-verification`, `credentials`, `recovery-key`, `idb-snapshots`)
  instead of `bot-storage.json`, `storage-meta.json`, `thread-bindings.json`,
  `inbound-dedupe.json`, `startup-verification.json`, `credentials.json`,
  `recovery-key.json`, and `crypto-idb-snapshot.json`; the Matrix doctor/setup
  migration imports and removes those legacy files (and the retired per-root
  `inbound-dedupe` SQLite rows) from account-scoped Matrix storage roots.
- Nostr bus cursors and profile publish state now use SQLite plugin state under
  `nostr` namespaces (`bus-state`, `profile-state`) instead of
  `bus-state-*.json` and `profile-state-*.json`; the Nostr doctor/setup
  migration imports and removes the legacy files.
- Active Memory session toggles now use SQLite plugin state under
  `active-memory/session-toggles` instead of `session-toggles.json`.
- Skill Workshop proposal queues and review counters now use SQLite plugin state
  under `skill-workshop/proposals` and `skill-workshop/reviews` instead of
  per-workspace `skill-workshop/<workspace>.json` files.
- Outbound delivery and session delivery queues now share the global SQLite
  `delivery_queue_entries` table under separate queue names
  (`outbound-delivery`, `session-delivery`) instead of durable
  `delivery-queue/*.json`, `delivery-queue/failed/*.json`, and
  `session-delivery-queue/*.json` files. The doctor legacy-state step imports
  pending and failed rows, removes stale delivered markers, and deletes the old
  JSON files after import. Hot routing and retry fields are typed columns; the
  JSON payload is retained only for replay/debug.
- ACPX process leases now use SQLite plugin state under `acpx/process-leases`
  instead of `process-leases.json`.
- Backup and migration run metadata

Move these into agent databases:

- Agent session roots and compatibility-shaped session-entry payloads. Done for
  runtime writes: hot session metadata is queryable in `sessions`, while the
  legacy-shaped full `SessionEntry` payload remains in `session_entries`.
- Agent transcript events. Done for runtime writes.
- Compaction checkpoints and transcript snapshots. Done for runtime writes:
  checkpoint transcript copies are SQLite transcript rows and checkpoint
  metadata is recorded in `transcript_snapshots`. Gateway checkpoint helpers
  now name these values as transcript snapshots rather than source files.
- Agent VFS scratch/workspace namespaces. Done for runtime VFS writes.
- Subagent attachment payloads. Done for runtime writes: they are SQLite VFS
  seed entries and never durable workspace files.
- Tool artifacts. Done for runtime writes.
- Run artifacts. Done for worker runtime writes through the per-agent
  `run_artifacts` table.
- Agent-local runtime caches. Done for worker runtime scoped cache writes through
  the per-agent `cache_entries` table. Gateway-wide model caches stay in the
  global database unless they become agent-specific.
- ACP parent stream logs. Done for runtime writes.
- ACP replay ledger sessions. Done for runtime writes via
  `acp_replay_sessions` and `acp_replay_events`; legacy `acp/event-ledger.json`
  remains only as doctor input.
- ACP session metadata. Done for runtime writes via `acp_sessions`; legacy
  `entry.acp` blocks in `sessions.json` are doctor migration input only.
- Trajectory sidecars when they are not explicit export files. Done for runtime
  writes: trajectory capture writes agent-database `trajectory_runtime_events`
  rows and mirrors run-scoped artifacts into SQLite. Legacy sidecars are doctor
  import inputs only; export can materialize fresh JSONL support-bundle outputs
  but does not read or migrate old trajectory/transcript sidecars at runtime.
  Runtime trajectory capture exposes SQLite scope; JSONL path helpers are
  isolated to export/debug support and are not re-exported from the runtime module.
  Embedded-runner trajectory metadata records `{agentId, sessionId, sessionKey}`
  identity instead of persisting a transcript locator.

Keep these file-backed for now:

- `openclaw.json`
- provider or CLI credential files
- plugin/package manifests
- user workspaces and Git repositories when disk mode is selected
- logs intended for operator tailing, unless a specific log surface is moved

## Migration Plan

### Phase 0: Freeze The Boundary

Make the durable-state boundary explicit before moving more rows:

- Add a `migration_runs` table to the global database.
  Done for legacy-state migration execution reports.
- Add a single doctor-owned state migration service for file-to-database import.
  Done: `openclaw doctor --fix` uses the legacy-state migration implementation.
- Make `plan` read-only and make `apply` create a backup, import, verify, and
  then delete or quarantine old files.
  Done: doctor creates a verified pre-migration backup, passes the backup path
  into `migration_runs`, and reuses the importer/removal paths.
- Add static bans so new runtime code cannot write legacy state files while
  migration code and tests can still seed/read them.
  Done for the currently migrated legacy stores; the guard also scans nested
  tests for forbidden runtime transcript locator contracts.

### Phase 1: Finish The Global Control Plane

Keep shared coordination state in `state/openclaw.sqlite`:

- Agents and agent database registry
- Task and Task Flow ledgers
- Plugin state
- Sandbox container/browser registry
- Cron/scheduler run history
- Pairing, device, push, update-check, TUI, OpenRouter/model caches, and other
  small gateway-scoped runtime state
- Backup and migration metadata
- Gateway media attachment bytes. Done for runtime writes; direct file paths
  are temp materializations for compatibility with channel senders and sandbox
  staging. Runtime allowlists accept SQLite materialization paths, not legacy
  state/config media roots. Doctor imports legacy media files into
  `media_blobs` and removes the source files after successful row writes.
- Debug proxy capture sessions, events, and payload blobs. Done: captures live
  in the shared state DB and open through the shared state DB bootstrap, schema,
  WAL, and busy-timeout settings. Payload bytes are gzip-compressed in
  `capture_blobs.data`; there is no debug proxy runtime sidecar DB override,
  blob directory, or proxy-capture-only generated schema/codegen target.
  Doctor/startup migration imports shipped `debug-proxy/capture.sqlite` rows
  and referenced payload blobs, including active legacy DB/blob environment
  overrides, then archives those sources while leaving CA certificates intact.

This phase also deletes duplicate sidecar openers, permission helpers, WAL
setup, filesystem pruning, and compatibility writers from those subsystems.

### Phase 2: Introduce Per-Agent Databases

Create one database per agent and register it from the global DB:

```text
~/.openclaw/state/openclaw.sqlite
~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
```

The global `agent_databases` row stores the path, schema version, last-seen
timestamp, and basic size/integrity metadata. Runtime code asks the registry for
the agent DB instead of deriving file paths directly.

The agent DB owns:

- `sessions` as the canonical session root, with `session_entries` as the
  compatibility-shaped payload table attached to that root, and
  `session_routes` as the unique active `session_key` lookup
- `conversations` and `session_conversations` as the normalized provider
  routing identity attached to sessions
- `transcript_events`
- transcript snapshots and compaction checkpoints. Done for runtime writes.
- `vfs_entries`
- `tool_artifacts` and run artifacts
- agent-local runtime/cache rows. Done for worker scoped caches.
- ACP parent stream events
- trajectory runtime events when they are not explicit export artifacts

### Phase 3: Replace Session Store APIs

Done for runtime. The file-shaped session store surface is not an active
runtime contract:

- Runtime no longer calls `loadSessionStore(storePath)` or treats `storePath` as
  session identity.
- Runtime row operations are `getSessionEntry`, `upsertSessionEntry`,
  `patchSessionEntry`, `deleteSessionEntry`, and `listSessionEntries`.
- Whole-store rewrite helpers, file writers, queue tests, alias pruning, and
  legacy-key deletion parameters are gone from runtime.
- Deprecated root-package compatibility exports still adapt canonical
  `sessions.json` paths onto the SQLite row APIs.
- `sessions.json` parsing remains only in doctor migration/import code and
  doctor tests.
- Runtime lifecycle fallback reads SQLite transcript headers, not JSONL first
  lines.

Keep deleting anything that reintroduces file-lock parameters,
pruning/truncation-as-file-maintenance vocabulary, store-path identity, or tests
whose only assertion is JSON persistence.

### Phase 4: Move Transcripts, ACP Streams, Trajectories, And VFS

Make every agent data stream database-native:

- Transcript append writes go through one SQLite transaction that ensures the
  session header, checks message idempotency, selects the parent tail, inserts
  into `transcript_events`, and records queryable identity metadata in
  `transcript_event_identities`. Done for direct transcript message appends and
  normal persisted `TranscriptSessionManager` appends; explicit branch
  operations keep their explicit parent choice and still write SQLite rows
  without deriving any file locator.
- ACP parent stream logs become rows, not `.acp-stream.jsonl` files. Done.
- ACP spawn setup no longer persists transcript JSONL paths. Done.
- Runtime trajectory capture writes event rows/artifacts directly. The explicit
  support/export command can still produce support-bundle JSONL artifacts as an
  export format, but session export does not recreate session JSONL. Done.
- Disk workspaces stay on disk when configured as disk mode.
- VFS scratch and experimental VFS-only workspace mode use the agent DB.

The migration imports old JSONL files once, records counts/hashes in
`migration_runs`, and removes imported files after integrity checks.

### Phase 5: Backup, Restore, Vacuum, And Verify

Backups remain one archive file:

- Checkpoint every global and agent database.
- Snapshot each DB with SQLite backup semantics or `VACUUM INTO`.
- Archive compact DB snapshots, config, external credentials, and requested
  workspace exports.
- Omit raw live `*.sqlite-wal` and `*.sqlite-shm` files.
- Verify by opening every DB snapshot and running `PRAGMA integrity_check`.
  `openclaw backup create` does this archive verification by default;
  `--no-verify` skips only the post-write archive pass, not the snapshot
  creation integrity check.
- Restore copies snapshots back to their target paths. This branch resets the
  unshipped SQLite layout to `user_version = 1`; future shipped schema changes
  can add explicit migrations when they are needed.

### Phase 6: Worker Runtime

Keep worker mode experimental while the database split lands:

- Workers receive agent id, run id, filesystem mode, and DB registry identity.
- Each worker opens its own SQLite connection.
- Parent keeps channel delivery, approvals, config, and cancellation authority.
- Start with one worker per active run; add pooling only after lifecycle and DB
  connection ownership are stable.

### Phase 7: Delete The Old World

Done for runtime session management. The old world is allowed only as explicit
doctor input or support/export output:

- No runtime `sessions.json`, transcript JSONL, sandbox registry JSON, task
  sidecar SQLite, or plugin-state sidecar SQLite writes.
- No JSON/session file pruning, file transcript truncation, session file locks,
  or lock-shaped session tests.
- No runtime compatibility exports whose purpose is keeping old session files
  current.
- Explicit support exports remain user-requested archive/materialization
  formats and must not feed file names back into runtime identity.

## Backup And Restore

Backups should be one archive file, but database capture should be
SQLite-native:

1. Stop long-running write activity or enter a short backup barrier.
2. For every global and agent database, run a checkpoint.
3. Snapshot each database using SQLite backup semantics or `VACUUM INTO` into a
   temporary backup directory.
4. Archive the compacted database snapshots, config file, credentials directory,
   selected workspaces, and a manifest.
5. Verify the archive by opening every included SQLite snapshot and running
   `PRAGMA integrity_check`.
   `openclaw backup create` does this by default; `--no-verify` is only for
   intentionally skipping the post-write archive pass.

Do not rely on raw live `*.sqlite`, `*.sqlite-wal`, and `*.sqlite-shm` copies as
the primary backup format. The archive manifest should record database role,
agent id, schema version, source path, snapshot path, byte size, and integrity
status.

Restore should rebuild the global database and agent database files from the
archive snapshots. Because the SQLite layout has not shipped yet, this refactor
keeps only the version-1 schema plus doctor file-to-database import. The restore
command validates the archive first, then replaces each manifest asset from the
verified extracted payload.

## Runtime Refactor Plan

1. Add database registry APIs.
   - Resolve global DB and per-agent DB paths.
   - Keep the unshipped schemas at `user_version = 1`; do not add schema
     migration runner code until a shipped schema needs it.
   - Add close/checkpoint/integrity helpers used by tests, backup, and doctor.

2. Collapse sidecar SQLite stores.
   - Move plugin state tables into the global database. Done for runtime
     writes; the unshipped legacy sidecar importer is deleted.
   - Move task registry tables into the global database. Done for runtime
     writes; the unshipped legacy sidecar importer is deleted.
   - Move Task Flow tables into the global database. Done for runtime writes;
     the unshipped legacy sidecar importer is deleted.
   - Move builtin memory-search tables into each agent database. Done; explicit
     custom `memorySearch.store.path` is now removed by doctor config migration.
     Full reindex runs in place against memory tables only; the old whole-file
     swap path and sidecar index swap helper are deleted.
   - Delete duplicate database openers, WAL setup, permission helpers, and
     close paths from those subsystems.

3. Move agent-owned tables into per-agent databases.
   - Create agent DB on demand through the global database registry. Done.
   - Move runtime session entries, transcript events, VFS rows, and tool
     artifacts to agent DBs. Done.
   - Do not migrate branch-local shared-DB session entries, transcript events,
     VFS rows, or tool artifacts; that layout never shipped. Keep only legacy
     file-to-database import in doctor.

4. Replace session store APIs.
   - Remove `storePath` as the runtime identity. Done for runtime and guarded
     by `check:database-first-legacy-stores`: session metadata, route updates,
     command persistence, CLI session cleanup, Feishu reasoning previews,
     transcript-state persistence, subagent depth, auth profile session
     overrides, parent-fork logic, and QA-lab inspection now resolve the
     database from canonical agent/session keys.
     Gateway/TUI/UI/macOS session-list responses now expose `databasePath`
     instead of legacy `path`; macOS debug surfaces show the per-agent database
     as read-only state instead of writing `session.store` config.
     `/status`, chat-driven trajectory export, and CLI dependency proxies no
     longer propagate legacy store paths; transcript usage fallback reads
     SQLite by agent/session identity. Runtime and bridge tests no longer expose
     `storePath`; doctor/migration inputs own that legacy field name.
     Gateway combined-session loading no longer has a special runtime branch for
     non-templated `session.store` values; it aggregates per-agent SQLite rows.
     The legacy session-lock doctor lane and its `.jsonl.lock` cleanup helper
     were removed; SQLite is the session concurrency boundary now.
     Hot runtime call sites use row-oriented helper names such as
     `resolveSessionRowEntry`; the old `resolveSessionStoreEntry` compatibility
     alias has been removed from runtime and plugin SDK exports.

- Use `{ agentId, sessionKey }` row operations.
  Done: `getSessionEntry`, `upsertSessionEntry`, `deleteSessionEntry`,
  `patchSessionEntry`, and `listSessionEntries` are SQLite-first APIs that do
  not require a session store path. Status summary, local agent status, health,
  and the `openclaw sessions` listing command now read per-agent rows directly
  and display per-agent SQLite database paths instead of `sessions.json` paths.
- Replace whole-store delete/insert with `upsertSessionEntry`,
  `deleteSessionEntry`, `listSessionEntries`, and SQL cleanup queries.
  Done for runtime: hot paths now use row APIs and conflict-retried row patches;
  remaining whole-store import/replace helpers are limited to migration import
  code and SQLite backend tests.
  - Delete `store-writer.ts` and writer-queue tests. Done.
  - Delete runtime legacy-key pruning and alias-delete parameters from session
    row upserts/patches. Done.

5. Delete runtime JSON registry behavior.
   - Make sandbox registry reads and writes SQLite-only. Done.
   - Import monolithic and sharded JSON only from the migration step. Done.
   - Remove sharded registry locks and JSON writes. Done.

- Keep one typed registry table instead of storing registry rows as generic
  opaque JSON if the shape remains hot-path operational state. Done.

6. Delete file-lock-shaped session mutation.
   - Done for runtime lock creation and runtime lock APIs.
   - The standalone legacy `.jsonl.lock` doctor cleanup lane is removed.
   - `session.writeLock` is doctor-migrated legacy config, not a typed runtime
     setting.
   - State integrity no longer has a separate orphan transcript-file pruning
     path; doctor migration imports/removes legacy JSONL sources in one place.
   - Gateway singleton coordination uses typed SQLite `state_leases` rows under
     `gateway_locks` and no longer exposes a file-lock directory seam.
   - Generic plugin SDK dedupe persistence no longer uses file locks or JSON
     files; it writes shared SQLite plugin-state rows. Done.
   - QMD embed coordination uses a SQLite state lease instead of
     `qmd/embed.lock`. Done.

7. Make workers database-aware.
   - Workers open their own SQLite connections.
   - Parent owns delivery, channel callbacks, and config.
   - Worker receives agent id, run id, filesystem mode, and DB registry
     identity, not live handles.
   - `vfs-only` stays experimental and uses the agent database as its storage
     root.
   - Keep one worker per active run first. Pooling can wait until DB connection
     lifetime and cancellation behavior are boring.

8. Backup integration.
   - Teach backup to snapshot global and agent databases via SQLite backup or
     `VACUUM INTO`. Done for discovered `*.sqlite` files under the state asset.
   - Add backup verification for SQLite integrity and schema version. Done for
     backup creation and default archive verification integrity checks.
   - Record backup run metadata in SQLite. Done via the shared `backup_runs`
     table with archive path, status, and manifest JSON.
   - Add restore from verified archive snapshots. Done: `openclaw backup
restore` validates before extraction, uses the verifier's normalized
     manifest, supports `--dry-run`, and requires `--yes` before replacing
     recorded source paths.
   - Include VFS/workspace export only when requested; do not export session
     internals as JSON or JSONL.

9. Delete obsolete tests and code. Done for the known runtime session surfaces.

- Remove tests that assert runtime creation of `sessions.json` or transcript
  JSONL files. Done for core session store, chat, gateway transcript events,
  preview, lifecycle, command session-entry updates, auto-reply reset/trace, and
  memory-core dreaming fixtures, approval target routing, session transcript
  repair, security permission repair, trajectory export, and session export.
  Active-memory transcript tests now assert SQLite scopes and no temporary or
  persisted JSONL file creation.
  The old heartbeat transcript-pruning regression was removed because
  runtime no longer truncates JSONL transcripts.
  Agent session-list tool tests no longer model legacy `sessions.json` paths
  as the gateway response shape; app/UI/macOS tests use `databasePath`.
  `/status` transcript-usage tests now seed SQLite transcript rows directly
  instead of writing JSONL files.
  Gateway session lifecycle tests now use SQLite transcript seeding helpers
  directly; the old single-line session-file fixture shape is gone from reset
  and delete coverage.
  `sessions.delete` no longer returns a file-era `archived: []` field; deletion
  reports only the row mutation result. The old `deleteTranscript` option is
  gone too: deleting a session removes the canonical `sessions` root and lets
  SQLite cascade session-owned transcript, snapshot, and trajectory rows, so no
  caller can leave transcript orphans behind or forget a cleanup branch.
  Context-engine trajectory capture tests now read `trajectory_runtime_events`
  rows from an isolated agent database instead of reading
  `session.trajectory.jsonl`.
  Docker MCP channel seed scripts now seed SQLite rows directly. Direct
  `sessions.json` writes are limited to doctor fixtures.
  Tool Search Gateway E2E reads tool-call evidence from SQLite transcript rows
  instead of scanning `agents/<agentId>/sessions/*.jsonl` files.
  Memory-core host events and session-corpus scratch rows now live in shared
  SQLite plugin-state; `events.jsonl` and `session-corpus/*.txt` are legacy
  doctor migration inputs only. Active rows use `memory/session-ingestion/`
  virtual paths, not `.dreams/session-corpus`. The old memory-core dreaming
  repair module and its CLI/Gateway tests were removed because runtime no
  longer owns file archive repair for that corpus. Memory-core
  bridge/public-artifact tests no longer surface `.dreams/events.jsonl`; they
  use the SQLite-backed virtual JSON artifact name.
  Public SDK/Codex testing docs now say SQLite session state instead of session
  files, and the channel-turn example no longer exposes a `storePath` argument.
  Matrix sync state now uses the SQLite plugin-state store directly. Active
  client/runtime contracts pass an account storage root, not a `bot-storage.json`
  path, and doctor imports legacy `bot-storage.json` into SQLite before deleting
  the source. QA Matrix restart/destructive scenarios now mutate the SQLite sync
  row directly instead of creating or deleting fake `bot-storage.json` files, and
  the E2EE substrate passes a sync-store root instead of a fake
  `sync-store.json` path.
  Matrix storage-root selection no longer scores roots by legacy sync/thread JSON
  files; it uses durable root metadata plus real crypto state.
  The runtime SQLite session backend test suite no longer fabricates a
  `sessions.json`; legacy source fixtures now live in the doctor
  tests that import them.
  Gateway session tests no longer expose a `createSessionStoreDir` helper or
  unused temp session-store path setup; fixture dirs are explicit, and direct
  row setup uses SQLite session-row naming.
  Doctor-only JSON5 session-store parser coverage moved out of infra tests and
  into doctor migration tests, so runtime test suites no longer own legacy
  session-file parsing.
  Microsoft Teams runtime SSO/pending-upload tests no longer carry JSON sidecar
  fixtures or parsers; legacy SSO token parsing lives only in the plugin
  migration module. Telegram tests no longer seed fake `/tmp/*.json` store
  paths; they reset the SQLite-backed message cache directly. The generic
  OpenClaw test-state helper no longer exposes a legacy `auth-profiles.json`
  writer; doctor auth migration tests own that fixture locally.
  Runtime tests for TUI last-session pointers, exec approvals, active-memory
  toggles, Matrix dedupe/startup verification, Memory Wiki source sync,
  current-conversation bindings, onboarding auth, and Hermes secret imports no
  longer manufacture old sidecar files or assert old filenames are absent. They
  prove behavior through SQLite rows and public store APIs; doctor/migration
  tests are the only place legacy source filenames belong.
  Runtime tests for device/node pairing, channel allowFrom, restart intents,
  restart handoff, session delivery queue entries, config health, iMessage
  caches, cron jobs, PI transcript headers, subagent registries, and managed
  image attachments also no longer create retired JSON/JSONL files just to prove
  they are ignored or absent.
  PI overflow recovery no longer has a SessionManager rewrite/truncation
  fallback: tool-result truncation and context-engine transcript rewrites mutate
  SQLite transcript rows, then refresh active prompt state from the database.
  Persisted SessionManager message appends delegate to the atomic SQLite
  transcript append helper for parent selection and idempotency. Normal
  metadata/custom entry appends also select the current parent inside SQLite, so
  stale manager instances do not resurrect pre-SQLite parent-chain races.
  Synthetic PI tail cleanup for mid-turn prechecks and `sessions_yield` now
  trims SQLite transcript state directly; the old SessionManager tail-removal
  bridge and its tests are deleted.
  Compaction checkpoint capture also snapshots from SQLite only; callers no
  longer pass a live SessionManager as an alternate transcript source.
- Keep tests that seed legacy files only for migration.
- JSON-file proof has been replaced with SQL row proof for active runtime
  surfaces.

- Add static bans for runtime writes to legacy session/cache JSON paths.
  Done for the repo guard.

10. Make the migration report auditable.
    - Record migration runs in SQLite with started/finished timestamps, source
      paths, source hashes, counts, warnings, and backup path.
      Done: legacy-state migration executions now persist a `migration_runs`
      report with source path/table inventory, source file SHA-256, sizes,
      record counts, warnings, and backup path.
      Done: legacy-state migration executions also persist `migration_sources`
      rows for source-level audit and future skip/backfill decisions.
    - Make apply idempotent. Re-running after a partial import should either
      skip an already imported source or merge by stable key.
      Done: session indexes, transcripts, delivery queues, plugin state, task
      ledgers, and agent-owned global SQLite rows import through stable keys or
      upsert/replace semantics, so reruns merge without duplicating durable
      rows.
    - Failed imports must keep the original source file in place.
      Done: failed transcript imports now leave the original JSONL source at
      its detected path, and `migration_sources` records the source as
      `warning` with `removed_source=0` for the next doctor run.

## Performance Rules

- One connection per thread/process is fine; do not share handles across
  workers.
- Use WAL, `foreign_keys=ON`, a 30s busy timeout, and short `BEGIN IMMEDIATE`
  write transactions.
- Keep write transaction helpers synchronous unless/until an async transaction
  API adds explicit mutex/backpressure semantics.
- Keep parent delivery writes small and transactional.
- Avoid whole-store rewrites; use row-level upsert/delete.
- Add indexes for list-by-agent, list-by-session, updated-at, run id, and
  expiration paths before moving hot code.
- Store large artifacts, media, and vectors as BLOBs or chunked BLOB rows, not
  base64 or numeric-array JSON.
- Keep opaque plugin-state entries small and scoped.
- Add SQL cleanup for TTL/expiration instead of filesystem pruning.
  Done for database-owned runtime stores: media, plugin state, plugin blobs,
  persistent dedupe, and agent cache all expire through SQLite rows. Remaining
  filesystem cleanup is limited to temporary materializations or explicit
  removal commands.

## Static Bans

Add a repo check that fails new runtime writes to legacy state paths:

- `sessions.json`
- `*.trajectory.jsonl` except materialized support-bundle outputs
- `.acp-stream.jsonl`
- `acp/event-ledger.json`
- `cache/*.json` runtime cache files
- `agents/<agentId>/agent/auth.json`
- `agents/<agentId>/agent/models.json`
- `credentials/oauth.json`
- `github-copilot.token.json`
- `openrouter-models.json`
- `auth-profiles.json`
- `auth-state.json`
- `exec-approvals.json`
- `workspace-state.json`
- Matrix `credentials*.json` and `recovery-key.json`
- `cron/runs/*.jsonl`
- `cron/jobs.json`
- `jobs-state.json`
- `device-pair-notify.json`
- `devices/pending.json` / `devices/paired.json` / `devices/bootstrap.json`
  (retired 2026.7: runtime store is `device_pairing_*` /
  `device_bootstrap_tokens` in the shared state DB; paired records import at
  gateway startup, transient pending/bootstrap rows are dropped)
- `nodes/pending.json` / `nodes/paired.json` (retired 2026.7: folded into paired device records at gateway startup)
- `identity/device.json`
- `identity/device-auth.json`
- `push/web-push-subscriptions.json`
- `push/vapid-keys.json`
- `push/apns-registrations.json`
- `process-leases.json`
- `gateway-instance-id`
- `session-toggles.json`
- Memory-core `.dreams/events.jsonl`
- Memory-core `.dreams/session-corpus/`
- Memory-core `.dreams/daily-ingestion.json`
- Memory-core `.dreams/session-ingestion.json`
- Memory-core `.dreams/short-term-recall.json`
- Memory-core `.dreams/phase-signals.json`
- Memory-core `.dreams/short-term-promotion.lock`
- Skill Workshop `skill-workshop/<workspace>.json`
- Skill Workshop `skill-workshop/skill-workshop-review-*.json`
- Nostr `bus-state-*.json`
- Nostr `profile-state-*.json`
- `calls.jsonl`
- `known-users.json`
- `ref-index.jsonl`
- QQBot `session-*.json`
- BlueBubbles `bluebubbles/catchup/*.json`
- BlueBubbles `bluebubbles/inbound-dedupe/*.json`
- Telegram `update-offset-*.json`
- Telegram `sticker-cache.json`
- Telegram `*.telegram-messages.json`
- Telegram `*.telegram-sent-messages.json`
- Telegram `*.telegram-topic-names.json`
- Telegram `thread-bindings-*.json`
- iMessage `catchup/*.json`
- iMessage `reply-cache.jsonl`
- iMessage `sent-echoes.jsonl`
- Microsoft Teams `msteams-conversations.json`
- Microsoft Teams `msteams-polls.json`
- Microsoft Teams `msteams-sso-tokens.json`
- Microsoft Teams `*.learnings.json`
- Matrix `bot-storage.json`
- Matrix `sync-store.json`
- Matrix `thread-bindings.json`
- Matrix `inbound-dedupe.json`
- Matrix `startup-verification.json`
- Matrix `storage-meta.json`
- Matrix `crypto-idb-snapshot.json`
- Discord `model-picker-preferences.json`
- Discord `command-deploy-cache.json`
- sandbox registry shard JSON files
- native hook relay `/tmp` bridge JSON files
- `plugin-state/state.sqlite`
- ad-hoc `openclaw-state.sqlite` runtime sidecars
- `tasks/runs.sqlite`
- `tasks/flows/registry.sqlite`
- `bindings/current-conversations.json`
- `restart-sentinel.json`
- `gateway-restart-intent.json`
- `gateway-supervisor-restart-handoff.json`
- `gateway.<hash>.lock`
- `qmd/embed.lock`
- `commands.log`
- `config-health.json`
- `port-guard.json`
- `settings/voicewake.json`
- `settings/voicewake-routing.json`
- `plugin-binding-approvals.json`
- `plugins/installs.json`
- `audit/file-transfer.jsonl`
- `audit/crestodian.jsonl`
- `crestodian/rescue-pending/*.json`
- `plugins/phone-control/armed.json`
- Memory Wiki `.openclaw-wiki/log.jsonl`
- Memory Wiki `.openclaw-wiki/state.json`
- Memory Wiki `.openclaw-wiki/locks/`
- Memory Wiki `.openclaw-wiki/source-sync.json`
- Memory Wiki `.openclaw-wiki/import-runs/*.json`
- Memory Wiki `.openclaw-wiki/cache/agent-digest.json`
- Memory Wiki `.openclaw-wiki/cache/claims.jsonl`
- ClawHub `.clawhub/lock.json`
- ClawHub `.clawhub/origin.json`
- Browser profile decoration `.openclaw-profile-decorated`
- `SessionManager.open(...)` file-backed session openers
- `SessionManager.listAll(...)` and `TranscriptSessionManager.listAll(...)`
  transcript listing facades
- `SessionManager.forkFromSession(...)` and
  `TranscriptSessionManager.forkFromSession(...)` transcript fork facades
- `SessionManager.newSession(...)` and `TranscriptSessionManager.newSession(...)`
  mutable session replacement facades
- `SessionManager.createBranchedSession(...)` and
  `TranscriptSessionManager.createBranchedSession(...)` branch-session facades

The ban should allow tests to create legacy fixtures and allow migration code to
read/import/remove legacy file sources. Unshipped SQLite sidecars stay banned
and do not get doctor import allowances.

## Done Criteria

- Runtime data and cache writes go to the global or agent SQLite database.
- Runtime no longer writes session indexes, transcript JSONL, sandbox registry
  JSON, task sidecar SQLite, or plugin-state sidecar SQLite. The unshipped task
  and plugin-state sidecar SQLite importers are deleted.
- Legacy file import is doctor-only.
- Backup produces one archive with compact SQLite snapshots and integrity proof.
- Agent workers can run with disk, VFS scratch, or experimental VFS-only
  storage.
- Config and explicit credential files remain the only expected persistent
  non-database control files.
- Repo checks prevent reintroducing legacy runtime file stores.
