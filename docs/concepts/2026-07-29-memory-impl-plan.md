# OpenClaw Multiplayer Memory Implementation Plan

Date: 2026-07-29

Status: planning document; no behavior described here is shipped

Canonical design: `docs/concepts/memory-multiplayer.md`

## 1. Outcome

Implement identity-aware private, channel, role, shared, projection, agent, and
quarantine memory without turning prompts into an authorization boundary.

The completed system must:

- resolve a durable session subject before memory access;
- expose only a selected memory plugin's authorized virtual view;
- apply the same policy to bootstrap, search, exact reads, prompt supplements,
  automatic recall, files, transcripts, compaction, dreaming, delegation,
  writes, sync, import, export, and public artifacts;
- keep direct user-to-user private-store reads unavailable;
- preserve existing single-user behavior until explicit migration;
- fail closed for memory without taking unrelated conversation paths down;
- distinguish cooperative, model-adversarial, process-adversarial, and
  hostile-tenant claims.

This plan splits the design's large security stages into smaller, independently
reviewable milestones. The numbering maps back to the canonical design:

- Design Stage 0 -> implementation Phase 0.
- Design Stage 1 -> implementation Phases 1A through 1D.
- Design Stage 2 -> implementation Phases 2A through 2C.
- Design Stage 3 -> implementation Phase 3.
- Design Stage 4 -> implementation Phase 4.
- Design Stage 5 -> implementation Phase 5.
- Phase 6 is rollout, migration completion, and cleanup.

## 2. Non-negotiable architecture boundaries

### 2.1 Core ownership

Core owns facts and confinement whose absence could widen access:

- canonical principal and identity-binding resolution;
- write-once session memory subjects;
- actor, collaboration, delivery, route, and session-instance revisions;
- creation and validation of the branded memory access context;
- selected-memory-capability admission;
- generic prompt, filesystem, sandbox, and egress enforcement;
- fail-closed behavior when memory is unavailable or nonconforming.
- atomic persistence of session-subject and transcript-policy companion rows
  in the core-owned transcript transaction.

Likely owner surfaces:

- `src/routing/session-key.ts:216-259`
- `src/channels/message-access/types.ts:15-35`
- `src/config/sessions/session-entry-provenance.ts:4-38`
- `src/config/sessions/session-sharing-store.ts:104-213`
- `src/gateway/session-reset-service.ts`
- `src/plugins/memory-runtime.ts:10-79`
- `src/plugins/memory-state.ts:8-195`
- `src/agents/tool-fs-policy.ts:15-63`
- `src/agents/sandbox/workspace-mounts.ts:39-181`

### 2.2 Plugin SDK ownership

The SDK owns a small, versioned contract between core and the selected memory
plugin:

- serializable access facts;
- plugin-issued authorization plans and opaque handles;
- authorized read, write, sync, import, export, and status operations;
- exposure and egress receipts;
- backend capability declaration;
- a reusable conformance suite.

Prefer one narrow memory-authorization subpath. Do not add a broad convenience
barrel or expose core implementation details.

Likely contract surfaces:

- `packages/memory-host-sdk/src/host/types.ts:1-168`
- a new focused file under `packages/memory-host-sdk/src/host/`
- a narrow facade under `src/plugin-sdk/`
- `scripts/lib/plugin-sdk-entrypoints.json`
- `src/plugin-sdk/entrypoints.ts`
- `src/plugin-sdk/api-baseline.ts`
- package exports and SDK contract tests

### 2.3 Selected memory plugin ownership

The selected memory plugin owns:

- logical stores and physical/backend namespaces;
- resource and immutable revision catalogs;
- policy revisions, entries, evaluation, and decision traces;
- view construction from core-supplied verified facts;
- candidate prefilter and authoritative postfilter;
- content reads and writes;
- lineage, projections, postbox, exposure records, repair, and sync;
- backend-specific crash recovery.

For transcript policy persistence, the selected plugin computes opaque
policy-set contents, stable policy IDs, and receipts before the SQLite commit.
Core persists those opaque records atomically beside transcript events. Core
does not interpret plugin policy semantics, and no plugin call occurs inside a
SQLite transaction.

Core must not import deep `extensions/memory-core/src/**` internals. Bundled
plugins use the same public contract as external plugins.

Current selected-runtime seam:

- `src/plugins/memory-runtime.ts:10-79`
- `src/plugins/memory-state.ts:144-195`
- `packages/memory-host-sdk/src/host/types.ts:120-168`

### 2.4 Identity plugin ownership

Identity plugins may provide raw verification material, registered adapter
attestations, group snapshots, and refresh support. They do not return final
principals or final memory decisions.

Core validates protocol-appropriate issuer, audience, signature or registered
adapter identity, tenant binding, expiry, and snapshot freshness before adding
facts to the access context.

### 2.5 Storage and migration rules

- Runtime reads only one canonical layout after migration.
- No dual-read, lazy import, read-through fallback, or dual-write.
- Ambiguous legacy data enters quarantine, not shared memory.
- Provider, tenant, channel, and user identifiers do not appear in storage
  paths or backend locator tokens.
- Runtime SQLite access uses Kysely helpers except schema DDL, migrations, FTS,
  vector primitives, and narrowly justified transaction-time rereads.
- No asynchronous work or filesystem access occurs inside SQLite transaction
  callbacks.
- Additive tables use canonical schema declarations plus idempotent lazy
  ensures. Shared-state tables must be listed in
  `LAZY_ADDITIVE_STATE_TABLES`. Per-agent tables/columns must also be registered
  in `AGENT_SCHEMA_COMPATIBILITY.allowedMissingTables` /
  `allowedMissingColumns`; optional scoped FTS/vector trigger groups must be
  represented in `optionalCanonicalTriggerGroups`. Otherwise current-version
  existing agent databases fail schema assertion before the lazy ensure runs.
  Do not bump a SQLite schema version without explicit maintainer discussion
  and approval.
- Postbox defaults to `off`; review-required is the first enabled posture.
- Direct private-store grants between users remain deferred.

## 3. Current implementation anchors

| Area                       | Current source of truth                                                                                                       | Planning implication                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory slot                | `src/plugins/memory-runtime.ts:10-79`                                                                                         | Exactly one selected memory plugin supplies the runtime. Authorization must be backend-neutral.                                               |
| Memory capability registry | `src/plugins/memory-state.ts:8-195,230-424`                                                                                   | Prompt builders, preparations, supplements, flush planning, runtime, and public artifacts are separate paths that all need access context.    |
| Host manager contract      | `packages/memory-host-sdk/src/host/types.ts:1-168`                                                                            | Current search, read, sync, status, and probe methods carry no authorization plan or resource revision.                                       |
| DM routing                 | `src/routing/session-key.ts:216-259`                                                                                          | Default `dmScope: main` cannot receive a private memory subject.                                                                              |
| Session identity           | `src/state/openclaw-agent-schema.sql:34-112`                                                                                  | `session_nodes` owns the logical key and current window; `session_windows` owns generations and already records a coarse session scope.       |
| Session sharing            | `src/config/sessions/session-sharing-store.ts:104-213`                                                                        | Existing Gateway collaboration membership is authoritative only for Gateway collaborative sessions and includes a session-rebound guard.      |
| Transcript persistence     | `src/config/sessions/session-accessor.sqlite-transcript-write.ts:333-748`                                                     | Message and non-message transcript writes already converge on synchronous SQLite commit sections and can receive companion policy writes.     |
| Current memory index       | `src/state/openclaw-agent-schema.sql:400-454`                                                                                 | Existing chunks contain plaintext text and embeddings and are agent-scoped legacy state. Scoped content must use new tables.                  |
| Builtin memory schema      | `packages/memory-host-sdk/src/host/memory-schema-base.ts:7-61`                                                                | Existing source/chunk tables are content-bearing derived state, not authorization objects.                                                    |
| Memory search tools        | `extensions/memory-core/src/tools.ts:465-980`                                                                                 | `memory_search`, `memory_get`, session recall, and corpus merging must use authorized handles and receipts.                                   |
| Corpus supplements         | `extensions/memory-core/src/tools.shared.ts:163-212`                                                                          | Supplemental corpora are currently context-free registration surfaces.                                                                        |
| Prompt supplements         | `src/plugins/memory-state.ts:263-408`                                                                                         | Synchronous and prepared prompt sections are run-scoped but not authorization-scoped.                                                         |
| LanceDB                    | `extensions/memory-lancedb/index.ts:493-637`                                                                                  | `before_prompt_build` recall and `agent_end` auto-capture bypass the selected authorized runtime contract today.                              |
| Memory wiki                | `extensions/memory-wiki/index.ts:82-162`                                                                                      | Prompt preparation, prompt supplementation, corpus search, and Gateway/CLI surfaces need the same authorized plan.                            |
| Memory flush               | `src/auto-reply/reply/agent-runner-memory.ts:756-1665` and `extensions/memory-core/src/flush-plan.ts`                         | The model currently receives a filesystem target such as `memory/YYYY-MM-DD.md`; enforced mode must replace this with an authorized mutation. |
| Compaction                 | `src/agents/embedded-agent-runner/compaction-checkpoint.ts:17-65` and `src/gateway/session-compaction-checkpoints.ts:574-760` | Summary/checkpoint persistence needs source-policy sets and immutable audience metadata.                                                      |
| Dreaming                   | `extensions/memory-core/src/dreaming-phases.ts:1142-2030`                                                                     | Session and daily ingestion currently span workspace files and transcripts; enforced mode must run one authorized store at a time.            |
| Filesystem policy          | `src/agents/tool-fs-policy.ts:15-63`                                                                                          | Current policy is a single `workspaceOnly` boolean, not a per-session memory view.                                                            |
| Sandbox mounts             | `src/agents/sandbox/workspace-mounts.ts:135-181`                                                                              | Current mounts expose whole workspaces as `none`, `ro`, or `rw`; model-adversarial isolation requires mount-level narrowing.                  |
| Doctor memory repair       | `src/commands/doctor-agent-memory-schema.ts:61-149`                                                                           | Doctor already owns offline per-agent memory schema convergence and handle closure.                                                           |
| Additive shared tables     | `src/state/openclaw-state-db-contract.ts:7-17`                                                                                | `LAZY_ADDITIVE_STATE_TABLES` establishes the shared no-bump additive-table pattern.                                                           |
| Additive per-agent tables  | `src/state/openclaw-agent-db-schema-helpers.ts:46-83`                                                                         | New canonical tables/columns and optional trigger groups must be accepted by `AGENT_SCHEMA_COMPATIBILITY` until their lazy ensure runs.       |

## 4. Decisions required before implementation

These are owner decisions. Record them in the tracking issue before merging
the phase that consumes them.

1. **Enablement surface**
   - Recommended: one durable agent-level policy state managed by CLI/Doctor,
     rather than several public config flags.
   - Stage 0 remains internal shadow-only.
   - Do not expose the final mode until migration and conformance checks exist.

2. **Canonical storage root**
   - Choose the controlled per-agent artifact root.
   - Define backup ownership, filesystem permissions, path-key versioning, and
     cross-platform behavior.
   - Keep the selected plugin's catalog authoritative for opaque path keys.

3. **Local identity binding**
   - Define how a channel sender proves ownership of a Gateway profile.
   - Define account merge, recovery, revocation, and audit behavior.
   - Never bind by display name, email equality, username equality, phone
     equality, session key, or `identityLinks`.

4. **Membership staleness**
   - Define provider-specific expiry and outage behavior.
   - Expired evidence removes the affected role/channel mount.

5. **Incognito**
   - Recommended initial rule: no durable memory, transcript-derived memory,
     flush, dreaming, projection, or postbox writes.

6. **Audit retention and admin inspection**
   - Define retention, export, deletion, and which admins may inspect resource
     existence versus only redacted decision metadata.

7. **Egress registry scope**
   - Approve whether the run-exposure audience gate lands in Stage 1 or is
     split into a separate security RFC.
   - If deferred, pilot scope must disable or narrowly allow outbound
     capabilities after scoped exposure and must not claim complete audience
     confinement.

8. **Process boundary**
   - Decide whether Stage 5 uses a broker child process, a separate local
     service, or separate Gateway cells.

9. **Shared publishing**
   - Decide which local roles may receive publisher authority for role and
     agent-shared stores.
   - Decide whether every update requires review.

10. **Projection experience**
    - Approve selection, preview, expiry, refresh, and revocation-residual
      behavior before Phase 3.
    - Do not allow broad "share everywhere" defaults.

## 5. Phase dependency graph

```text
Phase 0: contract + shadow
  |
  +--> Phase 1A: identity + session subject
  |      |
  |      +--> Phase 1B: scoped store + migration foundation
  |               |
  |               +--> Phase 1C: authorized reads + minimum transcript labels
  |                        |
  |                        +--> Phase 1D: filesystem + egress confinement
  |                                  |
  |                                  +--> Phase 2A: authorized writes
  |                                           |
  |                                           +--> Phase 2B: full transcript policy
  |                                                    |
  |                                                    +--> Phase 2C: derivation lifecycle
  |                                                              |
  |                                                              +--> Phase 3: projections + postbox
  |                                                              |
  |                                                              +--> Phase 4: enterprise identity
  |                                                              |
  |                                                              +--> Phase 5: process isolation
  |
  +--> Phase 6: pilot, migration rollout, cleanup
```

Phase 3 and Phase 4 can proceed independently after Phase 2C. Phase 5 is
required only for a process-adversarial claim, but its interfaces must be
preserved from Phase 0.

## 6. Phase 0: contracts and shadow surface inspection

### Goal

Create the generic core/SDK/plugin contract, inventory all memory paths, and
evaluate selected-runtime authorization-surface compatibility in shadow mode
without moving content or changing results.

### Deliverables

#### 6.1 Serializable contract

Define versioned serializable types for:

- `SessionMemorySubject`
- `MemoryOperation`
- `MemoryAccessContext`
- `MemoryAuthorizationCapabilities`
- `AuthorizedMemoryPlan`
- `AuthorizedResourceHandle`
- `AuthorizedMemoryMutation`
- `MemoryExposureReceipt`
- `MemoryEgressAuthorizationReceipt`
- `AuthorizedMemoryResultEnvelope<T>`

Keep core-only brands and freeze logic outside the serializable SDK shape.
Brands are an in-process anti-forgery mechanism, not an IPC credential.

Required invariants:

- Callers cannot name a raw store, owner, audience, or principal.
- Plans bind context fingerprint, agent, session/window identity, subject
  revision, operation, delivery revision, policy revision, and expiry.
- Handles are revision-bound references, not bearer grants.
- Content-bearing methods return both exposure and egress receipts.
- A selected backend advertises exact supported capabilities.

#### 6.2 Runtime capability extension

Extend the selected memory capability with a versioned authorization declaration
and its optional runtime with the authorized surface:

```ts
type AuthorizedMemoryPlanForContext<Context extends MemoryAccessContext> =
  Context extends MemoryAccessContext & { operation: infer Operation extends MemoryOperation }
    ? Operation extends MemoryContentAccessOperation
      ? AuthorizedMemoryContentPlan<Operation>
      : AuthorizedMemoryPlan & { operation: Operation }
    : never;

type MemoryPluginCapability = Readonly<{
  authorization?: MemoryAuthorizationCapabilities;
  runtime?: MemoryPluginRuntime;
}>;

interface AuthorizedMemoryRuntime {
  authorize<Context extends MemoryAccessContext>(
    context: Context,
  ): Promise<AuthorizedMemoryPlanForContext<Context>>;
  searchAuthorized(...): Promise<AuthorizedMemoryResultEnvelope<readonly AuthorizedMemorySearchResult[]>>;
  readAuthorized(...): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>>;
  writeAuthorized(...): Promise<MemoryWriteResult>;
  importAuthorized(...): Promise<MemoryWriteResult>;
  syncAuthorized(...): Promise<AuthorizedMemoryResultEnvelope<MemorySyncResult>>;
  exportAuthorized(...): Promise<AuthorizedMemoryResultEnvelope<MemoryExportResult>>;
  statusAuthorized(...): Promise<AuthorizedMemoryResultEnvelope<MemoryProviderStatus>>;
}
```

The selected `MemoryPluginCapability`, rather than its optional `runtime`,
declares `authorization`. Legacy agents may continue to use the existing manager
path. An enforced agent must reject a selected capability without the new
declaration. Do not silently wrap a context-free backend and call it conforming.

The declaration and the conformance suite describe plugin behavior only; they
do not construct a trusted context or make an authorization decision. Phase 0
does not enforce this surface. A later core-owned enforcement path must consume
the trusted context and admitted capability at selected-runtime acquisition,
rather than treating the current narrow search-hit filter as whole-runtime
enforcement.

#### 6.3 Trusted-context issuance boundary

Phase 0 deliberately does not expose a core context factory or an admission
path. `MemoryAccessContext` is a serializable SDK DTO in this phase, not a
trusted in-process object. A factory that accepts a caller-assembled bag of
facts would manufacture authority before Phase 1A has durable principal,
session-subject, and verified ingress evidence.

Phase 1A owns the core-only factory. It will receive trusted runtime facts,
reread the current session-key-to-session-ID mapping, reject
`session-rebound`, freeze and brand the in-process object, exclude
model-authored JSON and extensible extras, and produce the stable context
fingerprint consumed by a later enforced path.

#### 6.4 Pure policy conformance harness

Create a reusable test harness that can generate:

- principal sets;
- stores and views;
- policy entries and explicit denies;
- expiry and revisions;
- delivery audiences;
- delegation intersections;
- lineage requirements.

The harness must assert:

- deny precedence;
- permission implication;
- no cross-agent cell access;
- no plan reuse across context revisions;
- candidate prefilter superset property;
- no unauthorized count, score, path, title, citation, cursor, or denial detail.

#### 6.5 Complete path inventory

Classify every current path as:

- converted through authorized capability;
- blocked in enforced mode;
- legacy-only for unmigrated agents;
- operator-only with explicit authenticated context.

Minimum inventory:

- selected runtime manager acquisition;
- bootstrap and recent-memory startup context;
- `memory_search` and `memory_get`;
- session transcript recall;
- active-memory trigger recall;
- memory-wiki prompt/corpus/Gateway/CLI;
- LanceDB tool recall, auto-recall, store, forget, and auto-capture;
- memory prompt supplements and preparations;
- corpus supplements;
- Talk fast context and project bootstrap;
- status, sync, CLI, import, export, and public artifacts;
- generic file tools;
- memory flush;
- transcript writes and replay;
- compaction and checkpoints;
- dreaming and profile promotion;
- child agents and completion handoff;
- cron, heartbeat, webhook, and system runs.

### Data changes

None required for the first contract PR. Shadow traces may use bounded
structured logs or test-only fixtures. Do not create a permanent audit schema
until the stable identifiers are decided.

### Suggested PR slices

1. Serializable types, capability declaration, and SDK conformance harness.
2. Shadow wiring at selected runtime acquisition and path-inventory tests.
3. Phase 1A core context factory with durable subject and trusted-ingress
   adapters.

### Tests

- SDK export and API baseline checks.
- `src/plugins/memory-state.test.ts`
- `src/plugins/contracts/*`
- new generated policy evaluator tests;
- new "no context-free enforced backend" contract test.

### Definition of done

Phase 0 is complete only when all of the following are demonstrated on the
current implementation head:

- [ ] Every memory ingress and egress path has a recorded owner and one explicit
      disposition: authorized, blocked in enforced mode, or legacy-only.
- [ ] Phase 0 exposes no trusted-context factory or enforcement admission path;
      tool JSON, prompt text, plugin extras, and caller-assembled objects
      therefore cannot opt into or modify an enforced authorization plan.
- [ ] Every selected backend must declare authorization capabilities, and the
      conformance suite rejects a context-free backend in enforced mode.
- [ ] Shadow evaluation emits only bounded selected-runtime surface metadata;
      it never logs memory content, prompts, queries, snippets, or raw
      principal identifiers, and does not claim to evaluate context-free policy
      decisions.
- [ ] Existing single-user results, configured corpora, and measured hot-path
      latency remain unchanged.
- [ ] SDK exports, API baselines, contract and runtime-inspection tests, and any
      required build/lazy-import gates pass.
- [ ] Product and security documentation still describes the feature as
      shadow-only, with no public isolation claim or public configuration.

### Rollback

Remove shadow invocation and ignore the new capability when the agent is not
enforced. No content or schema rollback is required.

## 7. Phase 1A: identity and write-once session subject

### Goal

Resolve one immutable memory subject for every logical session before any
private store can open.

### Deliverables

#### 7.1 Principal model

Add canonical principals for:

- existing durable Gateway profiles;
- verified enterprise subjects;
- service agents;
- system actors;
- conversation principals.

Store raw provider identifiers only where an explicitly protected operational
workflow needs them. Ordinary binding lookup should use a keyed-HMAC over:

```text
(channel, account, normalized stable sender ID)
```

#### 7.2 Identity binding

Create a core-owned binding lifecycle:

- create through pairing/OAuth/admin-link only;
- record adapter, assurance, evidence revision, creator, and timestamp;
- revoke without deleting history;
- resolve current merge head before each operation;
- never derive a principal from `identityLinks`, display fields, route keys, or
  message text.

Ingress integration starts from authenticated or trusted-adapter sender facts.
The current `stable-id` material in
`src/channels/message-access/types.ts:15-35` is input evidence, not the final
principal.

#### 7.3 Session memory subject

Persist a write-once subject against the logical `session_nodes` row:

- verified user for an isolated DM;
- conversation principal for group/channel sessions;
- explicit service/agent/system principal for autonomous runs;
- `ambiguous` for shared-main/unbound/conflicting DM identity.

The subject is immutable provenance. Current binding, membership, collaboration,
and revocation state is rechecked separately and may deny all operations.

Reset, rollover, fork, rewind, and recovery windows copy the exact subject and
subject revision. Imports without provable lineage become quarantined imports,
not subject successors.

#### 7.4 DM precondition

- `dmScope: main` never receives a user-private subject.
- Doctor reports the exact `per-channel-peer` or
  `per-account-channel-peer` remediation.
- Do not silently rewrite `session.dmScope`.

#### 7.5 Actor separation

Keep:

- session subject for default audience and write target;
- actor for audit and collaboration;
- source message/sender evidence for postbox targeting.

Steering may change actor evidence but never the session subject.

#### 7.6 Core trusted access-context factory

Build the single core-owned factory deferred from Phase 0. It receives only
trusted runtime facts:

- request and run IDs;
- agent, session key, and current session ID;
- persisted session subject and revision;
- actor evidence;
- verified principals and memberships;
- collaboration decision and revision;
- delivery audiences, sink, and route revision;
- delegation snapshot;
- requested operation; and
- host-facts revision.

The factory rereads the current session-key-to-session-ID mapping, rejects a
stale mapping as `session-rebound`, freezes and brands the in-process object,
excludes model-authored JSON and extensible message extras, and produces the
stable context fingerprint. It is not an SDK entrypoint and no plugin can mint
or modify its output.

### Data changes

Shared state:

- `memory_principals`
- `memory_identity_bindings`

Per-agent:

- `session_memory_subjects`
- `session_memory_subject_snapshots`

Use additive lazy ensures. Fold into the next natural schema-version bump.

### Likely files

- `src/routing/session-key.ts`
- `src/routing/resolve-route.ts`
- `src/channels/message-access/*`
- `src/config/sessions/session-entry-provenance.ts`
- `src/config/sessions/session-accessor*`
- `src/gateway/session-create-service.ts`
- `src/gateway/session-reset-service.ts`
- `src/gateway/server-methods/sessions-create.ts`
- `src/state/openclaw-agent-schema.sql`
- shared state schema/contract files

### Tests

- isolated DM, shared-main DM, group, channel, cron, heartbeat, webhook,
  subagent, system, and incognito subject matrix;
- stable sender ID cannot become a principal without a binding;
- revoked or conflicting binding produces no private subject;
- reset/fork/rewind copies provenance but rechecks current authority;
- session-rebound race denies;
- profile-less compatibility does not open private memory.
- trusted-context branding, fingerprint, trusted-fact provenance, and
  caller-assembled lookalike rejection.

Reuse and extend:

- `src/routing/resolve-route.test.ts`
- `src/gateway/session-sharing.test.ts`
- `src/config/sessions/session-accessor.conformance.test.ts`
- `src/config/sessions/session-accessor.sqlite-cleanup-race.test.ts`
- Gateway session create/reset tests

### Definition of done

Phase 1A is complete only when all of the following are demonstrated:

- [ ] Every logical session kind resolves to a persisted write-once subject or
      an explicit ambiguous state.
- [ ] Raw sender fields, display names, aliases, `identityLinks`, route keys,
      and model-visible context cannot grant or replace a principal.
- [ ] Revoked, expired, unbound, or conflicting identity evidence prevents a
      private subject from being issued.
- [ ] A shared-main DM cannot mount private memory, and Doctor reports the exact
      isolating `dmScope` remediation without rewriting configuration.
- [ ] Reset, rollover, fork, rewind, recovery, and confirmed import tests prove
      that subject provenance is copied exactly while current authority is
      rechecked.
- [ ] Session-rebound and revoke-between-check-and-use races fail closed.
- [ ] The core-only trusted context factory rejects caller-assembled facts,
      stale session mappings, model/plugin extras, and lookalikes; its branded,
      frozen result binds the current subject, identity, delivery, delegation,
      and host-fact revisions into a stable fingerprint.
- [ ] Additive schema compatibility and identity/session lifecycle tests pass
      for existing and newly created agent databases.

### Rollback

Keep the new subject rows unused while current memory remains legacy-only.
Bindings may remain as inert identity metadata.

## 8. Phase 1B: scoped store, policy, and migration foundation

### Goal

Give the builtin selected memory plugin isolated logical stores and immutable
resource/policy revisions without changing legacy agents.

### Deliverables

#### 8.1 Root and store registry

Create opaque IDs and path keys:

- `storage_root_id`
- `store_id`
- random path key generated with a CSPRNG;
- `path_key_version`;
- authority kind and owner;
- backend kind and opaque locator;
- lifecycle state.

Create directories with exclusive `mkdir`; retry collisions with a fresh key.
Never place provider/user/channel IDs in the path.

#### 8.2 Resource revision model

Builtin resources use:

- stable `resource_id`;
- immutable `revision_id`;
- stable logical locator inside a store;
- exactly one active revision;
- content hash;
- actor and timestamps;
- lifecycle state (`pending`, `active`, `quarantined`, `tombstoned`).

The catalog stores pointers and policy metadata. Markdown remains canonical
content for builtin memory. Scoped index chunks are content-bearing derived
state inside the same trusted plugin/broker boundary.

#### 8.3 Policy model

Create stable policies and immutable policy revisions:

- placement authority for common user/channel/agent stores;
- explicit allow/deny entries for exceptional narrowing and publishing;
- requested-operation implication;
- expiry;
- grantor/actor/reason;
- delivery-audience coverage;
- current revision/revocation epoch.

The initial product exposes no direct private user-to-user allow.

#### 8.4 Builtin authorized runtime

Implement the Phase 0 contract for builtin memory:

- resolve authorized view;
- issue opaque mount handles;
- query only stores in the view;
- prefilter candidates;
- authoritative postfilter;
- read immutable active revisions only;
- record exposure before returning content.

Do not insert scoped content into `memory_index_sources`,
`memory_index_chunks`, or legacy FTS/vector tables.

#### 8.5 Alternate backend admission

Define conformance requirements for:

- isolated collections/namespaces;
- authorized exact reads;
- candidate over-fetch/filter behavior;
- revision/hash checks;
- status and export;
- no silent fallback to a broader backend.

If a selected alternate backend cannot meet the contract in the first release,
enforced agents use the builtin backend or memory remains unavailable. A failed
alternate backend must not fall back to legacy broad builtin search.

#### 8.6 Doctor migration scaffold

Implement dry-run only first:

1. scan legacy files and transcripts;
2. classify from trusted structural evidence;
3. preview owner/admin choices;
4. place ambiguous data in quarantine;
5. estimate copy/index/backup work;
6. report `dmScope`, backend, filesystem, and sandbox blockers.

No runtime cutover in the dry-run PR.

### Data changes

Per-agent plugin tables:

- `memory_storage_roots`
- `memory_stores`
- `memory_resources`
- `memory_resource_revisions`
- `memory_resource_subjects`
- `memory_policies`
- `memory_policy_revisions`
- `memory_policy_entries`
- `memory_scoped_chunks` plus scoped FTS/vector tables
- `memory_migrations`

Register every additive per-agent table in
`AGENT_SCHEMA_COMPATIBILITY.allowedMissingTables`. Register scoped FTS/vector
shadow tables and triggers in the corresponding optional canonical trigger
groups. Add any lazily ensured columns to `allowedMissingColumns`.

### Likely files

- `packages/memory-host-sdk/src/host/memory-schema*.ts`
- `src/state/openclaw-agent-schema.sql`
- `extensions/memory-core/src/memory/*`
- `extensions/memory-core/runtime-api.ts`
- `extensions/memory-core/api.ts`
- `src/plugin-sdk/memory-core-*`
- `src/commands/doctor-agent-memory-schema.ts`
- new memory-core doctor/migration modules

### Tests

- opaque path collision/retry and path traversal;
- no provider identity in path or locator;
- active/pending/quarantined/tombstoned revision visibility;
- policy deny precedence and expiry;
- candidate-superset property for FTS, vector scan, sqlite-vec, and exact read;
- alternate-backend nonconformance rejects enforced mode;
- dry-run migration is deterministic and content-free in logs;
- existing legacy agent remains byte-for-byte on the old path.

### Definition of done

Phase 1B is complete only when all of the following are demonstrated:

- [ ] Builtin memory passes the full authorized-backend conformance suite for
      store isolation, immutable revisions, policy evaluation, search, and
      exact reads.
- [ ] Pending, quarantined, expired, stale-hash, and tombstoned revisions cannot
      be returned.
- [ ] Scoped resources and chunks never enter legacy
      `memory_index_sources`/`memory_index_chunks` or legacy FTS/vector tables.
- [ ] Every additive per-agent table, column, and trigger group is registered
      in schema compatibility so an existing current-version database opens
      before feature-local lazy ensure.
- [ ] A nonconforming or failed alternate backend becomes unavailable in
      enforced mode and never falls back to broader legacy search.
- [ ] Doctor dry-run produces a deterministic, content-redacted classification,
      backup, copy, reindex, verification, and cutover plan without modifying
      files or database state.
- [ ] Legacy single-user agents remain on the existing runtime path with no
      user-visible behavior change or runtime cutover.

### Rollback

Drop or ignore empty additive tables and remove dry-run state. Legacy content
was never moved.

## 9. Phase 1C: private and channel read isolation

### Goal

Convert every content-bearing read lane to the authorized runtime and enable a
single-subject/shadow read-only pilot. A pilot with two distinct verified
subjects is gated on Phase 1D filesystem and exec confinement.

### Deliverables

#### 9.1 Core access host

For each read operation:

1. build and revalidate `MemoryAccessContext`;
2. call selected plugin `authorize`;
3. invoke the authorized method;
4. validate plan/context binding;
5. reject missing or stale receipts;
6. merge exposure into the run exposure set;
7. return only safe unavailable/not-found details to model-facing callers.

#### 9.2 Search and exact read

Convert:

- `memory_search`;
- `memory_get`;
- transcript recall;
- `corpus=memory`, `sessions`, `wiki`, and `all`;
- citations and continuation behavior.

Search returns opaque revision-bound handles. Human-friendly virtual paths are
display only and resolve inside the current view.

The postfilter runs before final result count, ranking, pagination, snippet
rendering, path exposure, or citation generation.

#### 9.3 Bootstrap and automatic recall

Convert:

- curated/front-card bootstrap;
- startup recent-memory context;
- trigger injection;
- active-memory recall;
- Talk fast context;
- project bootstrap;
- prompt supplements and preparations.

`MemoryPromptSectionParams` and corpus supplement inputs must carry a trusted
host invocation/context handle, not only `agentId` and `agentSessionKey`.

#### 9.4 Supplemental plugin paths

Memory wiki:

- prompt builder;
- prompt preparation;
- corpus search/get;
- Gateway methods;
- CLI and public artifacts.

LanceDB:

- `memory_recall`;
- `before_prompt_build` auto-recall;
- status/CLI reads.

Any supplemental plugin that cannot route through the selected capability is
blocked in enforced mode. Supplemental plugins do not become independent
policy engines.

#### 9.5 Operator surfaces

Status, CLI, sync inspection, and export must authenticate explicitly and use
an operator/admin access context. A purpose string such as `"status"` or
`"cli"` is not authorization.

#### 9.6 Minimum transcript policy labeling

Before any scoped resource enters a run, persist enough metadata to prevent the
next durable turn from becoming an unlabeled copy:

- source-policy-set ID;
- exposed resource revisions;
- delivery audience;
- session identity and subject revision;
- run exposure-set ID/revision.

Write the companion policy row in the same per-agent SQLite transaction as the
transcript event. If that is not possible, mark the event
authorization-pending and exclude it from replay, search, compaction, export,
and derivation.

At this phase, durable memory writes remain disabled for enforced agents.

#### 9.7 Minimum transcript policy storage

Create the minimum additive forms of:

- `transcript_event_memory_policies`;
- `memory_policy_sets`;
- `memory_run_exposures`.

The selected plugin produces opaque policy-set contents/IDs and receipts before
the transcript transaction. Core writes the policy-set row, run exposure
reference, and event companion row atomically with the transcript event. There
is no plugin callback inside the transaction.

### Likely files

- `src/plugins/memory-runtime.ts`
- `src/plugins/memory-state.ts`
- `packages/memory-host-sdk/src/host/types.ts`
- `extensions/memory-core/src/tools.ts`
- `extensions/memory-core/src/tools.shared.ts`
- `extensions/memory-core/src/session-search-visibility.ts`
- `extensions/memory-core/src/prompt-section.ts`
- `extensions/active-memory/*`
- `extensions/memory-wiki/*`
- `extensions/memory-lancedb/index.ts`
- `src/auto-reply/reply/startup-context*`
- `src/auto-reply/reply/agent-runner-memory.ts`
- `src/config/sessions/session-accessor.sqlite-transcript-write.ts`

### Tests

Read-lane matrix:

- bootstrap;
- search;
- exact get;
- session recall;
- trigger recall;
- active recall;
- wiki supplement;
- LanceDB auto-recall;
- status;
- CLI;
- public artifact inspection.

Leak assertions:

- no denied path/title/snippet/score/count/citation/cursor;
- denied nearest neighbors do not crowd out an allowed top K;
- no private store in a channel view;
- no role store in a group because the latest actor has that role;
- memory plugin crash/disable/nonconformance never re-enables legacy reads;
- missing transcript policy companion row denies replay and derivation.

Focused existing tests:

- `extensions/memory-core/src/tools.test.ts`
- `extensions/memory-core/src/tools.citations.test.ts`
- `extensions/memory-core/src/session-search-visibility.test.ts`
- `extensions/memory-lancedb/index.test.ts`
- `extensions/memory-wiki/index.test.ts`
- `src/auto-reply/reply/startup-context.test.ts`
- `src/auto-reply/reply/agent-runner-memory.test.ts`
- transcript accessor and projection tests

### Definition of done

Phase 1C is complete only when all of the following are demonstrated:

- [ ] Every content-bearing read lane is either converted to the authorized
      runtime or explicitly unavailable in enforced mode.
- [ ] Through every converted lane, two verified users cannot observe one
      another's private existence bits, paths, titles, snippets, scores,
      counts, citations, cursors, or content.
- [ ] A group view contains only its channel store, eligible shared content,
      and projections explicitly addressed to that audience.
- [ ] Bootstrap, automatic recall, Active Memory, Memory Wiki, LanceDB, CLI,
      status, session recall, and corpus supplements pass the same context and
      receipt checks or are blocked.
- [ ] Every scoped exposure is recorded before content leaves the selected
      plugin, and missing/stale exposure or egress receipts are rejected.
- [ ] The minimum transcript policy-set, run-exposure, and event-companion rows
      commit atomically with each durable event after scoped exposure.
- [ ] Enforced agents remain read-only; every ordinary, watcher, plugin,
      import, sync, and generic-file durable write path is disabled until Phase
      2A.
- [ ] The read-lane, top-K crowd-out, plugin-failure, missing-label, and
      transcript-visibility test matrix passes.
- [ ] No two-subject pilot or stronger isolation claim is enabled before Phase
      1D closes raw file and exec bypasses.

### Rollback

Disable enforced mode for agents not yet cut over. Migrated agents remain
read-only until restored through the documented pre-write rollback path; never
fall back to broad legacy reads.

## 10. Phase 1D: filesystem and egress confinement

### Goal

Prevent model-facing file and delivery surfaces from bypassing an authorized
memory view.

### Deliverables

#### 10.1 Virtual filesystem view

Replace raw host memory paths with:

- virtual roots such as `private/`, `channel/`, `shared/`, `projections/`, and
  `postbox-review/` only when authorized;
- plugin-issued mount handles;
- symlink-safe resolution inside one authorized store root;
- no model-visible controlled artifact root.

Generic `read`, `write`, `edit`, and `apply_patch` calls against virtual memory
paths delegate to the broker/capability. Direct host paths into controlled
memory storage are rejected.

#### 10.2 Tool filesystem policy

Extend the closed policy shape beyond a parallel nullable boolean. Prefer a
discriminated result that represents:

- normal workspace view;
- authorized memory virtual view;
- sandbox mount plan;
- blocked/unavailable memory.

Keep routing and mount preparation deterministic and runtime-light.

#### 10.3 Sandbox

For model-adversarial mode:

- mount only authorized virtual roots;
- do not mount the real artifact root;
- make read-only roots physically read-only;
- ensure a writable channel/private root cannot reach siblings;
- reject dangerous and reserved mount targets;
- include mount view identity in sandbox config hashes.

#### 10.4 Exec behavior

Choose one:

- hide/deny `exec` for an enforced run without a scoped sandbox; or
- allow it only under the cooperative-isolation claim with an explicit Doctor
  security finding.

Never claim model-adversarial isolation while unsandboxed `exec` can open the
workspace/state tree.

#### 10.5 Run exposure and egress

If approved for this stage:

- register stable egress capability IDs for message, session-send, network,
  process, browser, webhook, upload/export, plugin, MCP, file delivery, fanout,
  and final reply surfaces;
- deny unclassified side-effect tools after scoped exposure;
- intersect every exposed resource audience into the run exposure set;
- invalidate receipts after a later read or route/delivery/registry revision;
- deny delivery or rerun without ineligible content after route changes.

If the registry is deferred, document and enforce a narrower pilot profile that
disables unclassified egress after scoped exposure.

### Likely files

- `src/agents/tool-fs-policy.ts`
- `src/agents/tool-fs-policy.types.ts`
- `src/agents/agent-tools.ts`
- `src/agents/agent-tools.read.ts`
- `src/agents/sandbox/*`
- `src/agents/tool-policy-*`
- requester/delivery policy files
- message/session-send/browser/webhook/plugin/MCP tool registration surfaces
- final reply route and outbound delivery paths

### Tests

- traversal, symlink, case, Unicode, hard-link where relevant, stale handle, and
  virtual-to-host confusion;
- sandbox gets only authorized roots;
- direct controlled-root host paths fail;
- route/sink revision change invalidates egress receipt;
- later exposure invalidates an older receipt;
- every unregistered side-effect tool is denied;
- unsandboxed `exec` cannot be used in a model-adversarial profile.

Focused existing tests:

- `src/agents/tool-fs-policy.test.ts`
- `src/agents/agent-tools.workspace-paths.test.ts`
- `src/agents/sandbox/validate-sandbox-security.test.ts`
- `src/agents/sandbox/workspace-mounts.test.ts`
- `src/agents/requester-tool-policy.test.ts`
- delivery and message-tool tests

### Definition of done

Phase 1D is complete only when all of the following are demonstrated:

- [ ] Model-facing `read`, `write`, `edit`, and `apply_patch` cannot resolve a
      raw controlled-memory path or an unmounted store.
- [ ] Traversal, symlink, case-normalization, Unicode, stale-handle,
      virtual-to-host, and relevant hard-link tests fail closed.
- [ ] Sandboxed runs receive only their authorized virtual roots, with physical
      read-only enforcement where required and no real artifact-root mount.
- [ ] Unsandboxed `exec` is denied/hidden for model-adversarial mode, or the
      deployment is explicitly limited to cooperative isolation with a Doctor
      security finding.
- [ ] Every enabled side-effect path after scoped exposure is classified in the
      egress registry or denied by the approved constrained-pilot policy.
- [ ] A later exposure, route change, sink change, delivery revision, or
      registry revision invalidates older egress authorization.
- [ ] Scoped content cannot reach an audience outside the run exposure set.
- [ ] Filesystem, sandbox, exec, route-rebound, and egress-registry tests pass
      on the required local and remote/cross-platform lanes.
- [ ] Only after all prior items pass may a two-subject read-only pilot begin,
      and its documented isolation claim matches the tested profile.

### Rollback

Withdraw the stronger isolation claim and disable enforced memory for profiles
that cannot provide the required filesystem/egress boundary. Do not restore raw
path access.

## 11. Phase 2A: authorized writes and crash-consistent resources

### Goal

Route every durable memory mutation through the selected plugin's authorized
resource lifecycle.

### Deliverables

#### 11.1 Closed mutation model

Define a discriminated mutation union for:

- remember/append;
- replace;
- delete/tombstone;
- derive;
- deposit;
- project/publish;
- import;
- sync;
- admin reclassification.

The runtime chooses the default target from the session subject. Model JSON may
select content or narrow an operation but cannot name another owner, store,
root, or broader audience.

#### 11.2 Builtin write state machine

1. Complete identity, membership, policy, filesystem preparation, and plugin
   hooks before opening a transaction.
2. Stage a revision file with restrictive permissions and fsync it.
3. In one short synchronous transaction, reread authoritative rows, insert a
   pending immutable revision/write intent, and enqueue the audit outbox row.
4. Commit.
5. Rename the staged file to the revision-scoped locator and fsync.
6. Compute finalized hash outside a transaction.
7. In a second synchronous transaction, compare prepared facts, activate the
   revision, repoint current resource revision, and finalize policy/lineage/
   outbox state.
8. Index only active revisions.

Startup recovery completes valid pending intents or quarantines orphans. A
pending file is never readable.

#### 11.3 Convert write paths

Convert or block:

- explicit remember;
- generic file writes to virtual memory;
- human/operator edits and watcher ingestion;
- delete/forget;
- sync;
- imports;
- exports that create durable artifacts;
- public artifact publication;
- LanceDB store, forget, and auto-capture;
- memory wiki write/import flows;
- memory-core short-term promotion.

New files without a valid catalog mapping enter quarantine.

#### 11.4 Audit outbox

Commit write/exposure decision records locally with plugin state, then drain
idempotently to the shared redacted audit table. Audit delivery never becomes
an allow dependency.

### Data changes

Per-agent:

- `memory_write_intents`
- `memory_audit_outbox`
- lifecycle/index state extensions needed by active revisions

Shared:

- `memory_access_audit`

### Tests

- reject model-supplied store, owner, and audience;
- every interruption boundary in stage/pending/rename/activate/index/outbox;
- duplicate/retry/idempotency;
- watcher edits without mapping quarantine;
- delete removes current read eligibility immediately;
- plugin crash cannot expose pending content;
- LanceDB auto-capture uses session subject and policy;
- sync/import/export cannot bypass authorization.

### Definition of done

Phase 2A is complete only when all of the following are demonstrated:

- [ ] Every durable mutation path for an enforced agent routes through
      `writeAuthorized`; no remember, file, watcher, import, export, sync,
      plugin, LanceDB, or Memory Wiki bypass remains.
- [ ] The runtime, not model arguments, selects the target store, owner, and
      maximum audience.
- [ ] Pending, orphaned, ambiguous, and quarantined revisions are never
      readable or indexed as active.
- [ ] The stage -> pending commit -> rename/fsync -> activation commit -> index
      -> audit-outbox state machine survives interruption at every boundary.
- [ ] Retries, duplicate requests, and recovery are idempotent and do not
      create two active revisions.
- [ ] Delete/tombstone removes read eligibility immediately and cannot leave a
      readable FTS/vector/file artifact.
- [ ] SQLite transaction callbacks perform no async work, filesystem access,
      network access, plugin calls, or model calls.
- [ ] Legacy/context-free writers remain blocked for enforced agents.
- [ ] Focused write, crash-recovery, watcher, import/export, sync, and plugin
      mutation tests pass.

### Rollback

Disable new writes while preserving scoped data. Resume only after repair.
Never dual-write to legacy files/tables.

## 12. Phase 2B: complete transcript policy lifecycle

### Goal

Make every transcript event and session transition carry durable authorization
metadata for its full retention lifetime.

### Deliverables

#### 12.1 Policy companion rows

Every assistant, user, tool-result, summary, checkpoint, and system event
records:

- source-policy-set ID;
- normalized audience intersection;
- finalized delivery and egress audiences;
- actor evidence;
- session identity and subject revisions;
- delegation snapshot;
- run exposure-set ID/revision;
- exposed resource revisions;
- expected current policy revision/revocation epoch.

Append the event and companion row in one per-agent SQLite transaction.
The selected plugin must finish policy evaluation and return the opaque
policy-set payload before this transaction begins. Core persists it without
understanding store kinds or ACL semantics.

#### 12.2 Policy sets

Store immutable policy sets for transcript and derivation retention:

- member stable policy IDs;
- captured revisions;
- expected active revisions/revocation epochs;
- normalized audience intersection;
- retention state.

Captured revisions preserve history, not permanent allow. Each read/derivation
resolves the stable policy against its current active revision.

#### 12.3 Session transitions

Reset, fork, rewind, branch, checkpoint restore, archive, and export preserve:

- source subject provenance;
- policy-set references;
- session identity revision;
- event lineage.

An import that cannot prove lineage remains quarantine and receives no normal
memory view.

#### 12.4 Missing-label behavior

Missing or invalid companion metadata is pending/denied. Never reconstruct
authorization from event JSON, prompt text, session key shape, or
`InputProvenance`.

### Data changes

Extend the Phase 1C minimum tables with full lineage-retention and transition
fields:

- `transcript_event_memory_policies`
- `memory_policy_sets`
- `memory_run_exposures`

Add:

- `memory_compaction_policies`

### Likely files

- `src/config/sessions/session-accessor.sqlite-transcript-write.ts`
- `src/config/sessions/session-accessor.sqlite-transcript-store.ts`
- `src/config/sessions/session-accessor.sqlite-contract.ts`
- `src/config/sessions/session-accessor.types.ts`
- `src/config/sessions/session-transcript-*`
- `src/gateway/session-reset-service.ts`
- `src/gateway/server-methods/sessions-rewind.ts`
- transcript export/import/archive paths

### Tests

- atomic event + policy companion write;
- authorization-pending exclusion;
- reset/fork/rewind/archive/export preservation;
- current-policy revision invalidates old captured allow;
- revoke-between-check-and-commit;
- session-rebound during transcript append;
- legacy unlabeled transcript remains unavailable unless migration confirms it.

### Definition of done

Phase 2B is complete only when all of the following are demonstrated:

- [ ] Every readable user, assistant, tool-result, summary, checkpoint, and
      system event has an atomic, evaluable policy companion row.
- [ ] Every scoped exposure can be mapped to the durable events, policy-set
      revision, delivery audience, and run exposure revision it influenced.
- [ ] Stable policy IDs are revalidated against current active revisions and
      revocation epochs; captured historical allows are not permanent grants.
- [ ] Reset, rollover, fork, rewind, checkpoint restore, archive, export, and
      confirmed import preserve subject and policy lineage exactly.
- [ ] Missing, invalid, stale, or authorization-pending labels exclude events
      from replay, search, compaction, export, and derivation.
- [ ] Authorization is never reconstructed from session-key shape, transcript
      JSON, rendered prompt text, or `InputProvenance`.
- [ ] No plugin call or async work occurs inside the transcript commit
      transaction.
- [ ] Atomic-write, transition, policy-revision, revoke-race, session-rebound,
      and legacy-unlabeled transcript tests pass.

### Rollback

Disable transcript recall, compaction, flush, dreaming, and derivation for the
affected enforced agent. Keep ordinary conversation available with memory
unavailable.

## 13. Phase 2C: compaction, flush, dreaming, and delegation

### Goal

Prevent durable derived artifacts from laundering scoped content into a broader
audience.

### Deliverables

#### 13.1 Derivation requirements

Every derivation:

- identifies immutable parent revisions or transcript policy sets;
- checks `derive` authority before the model sees source content;
- computes the intersection of all source audiences and requested target;
- partitions or quarantines when no representable common audience exists;
- records lineage;
- preserves current stable policy requirements;
- creates a new immutable revision.

#### 13.2 Compaction

Before summarization:

- collect every compacted event, prior summary, preserved turn, and injected
  memory revision;
- compute one source-policy set;
- ensure the summarizer receives only authorized content.

After summarization:

- derive output policy deterministically;
- reject unrepresentable audience;
- persist summary, checkpoint, policy metadata, and lineage together;
- preserve through all session transitions.

Integration anchors:

- `src/agents/embedded-agent-runner/compaction-checkpoint.ts:17-65`
- `src/gateway/session-compaction-checkpoints.ts:574-760`
- embedded compaction execution and queued compaction paths

Any provider/harness adapter, including Codex-specific integration, must inspect
the exact upstream dependency/runtime contract before implementation. Do not
infer native compaction behavior from OpenClaw wrappers.

#### 13.3 Memory flush

Replace the current model-directed raw filesystem target with an authorized
mutation:

- private DM -> user episodic store;
- channel/group -> conversation store;
- service/agent -> agent store or no write;
- ambiguous/incognito -> no durable write.

Extend provenance with resource/store/audience/source-event revisions.

#### 13.4 Dreaming and promotion

Run one authorized store at a time:

- session ingestion;
- daily ingestion;
- Light/REM phases;
- `DREAMS.md`;
- profile/front-card promotion;
- consolidation and repair.

Never combine unrelated stores in one model context. Postbox and quarantine are
ineligible until review changes their state.

#### 13.5 Tombstones and descendants

- materialize source policy requirements on derived revisions;
- tombstone/revoke invalidates descendants immediately;
- background jobs may recompute utility but do not restore access
  automatically;
- reclassification requires explicit declassification authority and a new
  reviewed revision.

#### 13.6 Delegation and autonomous runs

Child view:

```text
parent authorized view
intersect child capability snapshot
intersect child session/collaboration visibility
intersect current revocation and membership
```

Children receive minimal explicit excerpts or opaque plugin capabilities, never
raw DB handles, credentials, or an unbounded parent view.

Cron, heartbeat, webhook, and system runs use explicit service identities and
cannot acquire private user memory from an old session key.

### Data changes

- `memory_revision_policy_requirements`
- `memory_lineage_edges`
- descendant invalidation/repair state as needed

### Tests

- mixed private/channel/shared/projected compaction;
- summary policy intersection;
- tombstoned/revoked ancestor denial;
- compaction policy survives reset/fork/rewind/archive/export;
- flush target matrix;
- dreaming one-store-at-a-time and no postbox promotion;
- child cannot widen parent view;
- autonomous run cannot mount private store;
- crash recovery around summary/checkpoint/resource activation.

Focused existing tests:

- `src/gateway/session-compaction-checkpoints.test.ts`
- `src/agents/agent-hooks/compaction-safeguard.test.ts`
- embedded compaction/checkpoint tests
- `extensions/memory-core/src/flush-plan.test.ts`
- `extensions/memory-core/src/dreaming-phases.test.ts`
- memory-core dreaming consolidation/repair tests
- subagent requester and completion-handoff tests

### Definition of done

Phase 2C is complete only when all of the following are demonstrated:

- [ ] Every compaction, checkpoint, memory flush, dreaming output, promotion,
      export, and child-produced durable artifact identifies immutable parents
      and records lineage.
- [ ] `derive` authority is checked before source content enters a model
      context.
- [ ] No unlabeled or policy-unrepresentable derived artifact is readable.
- [ ] Group compaction and flush remain channel-scoped; private compaction and
      flush remain user-scoped; autonomous work remains agent-scoped or writes
      nothing.
- [ ] Mixed audiences are partitioned or denied and can never be widened by
      model wording.
- [ ] Tombstoning/revoking an ancestor denies descendants immediately; any
      recomputation creates a new reviewed immutable revision.
- [ ] Dreaming and promotion run one authorized store at a time, and postbox or
      quarantine content cannot auto-promote.
- [ ] Child agents receive only the intersection of parent view, task
      capability, session visibility, and current authority; cron, heartbeat,
      webhook, and system runs cannot recover private access from a session key.
- [ ] Compaction, flush, dreaming, lineage, revocation, delegation, and
      interruption tests pass, including any dependency-specific contract
      checks required by the selected harness.

### Rollback

Disable derivation and background memory jobs while preserving scoped resources.
Do not restore context-free compaction or flush.

## 14. Phase 3: explicit sharing and postbox

### Goal

Add deliberate sharing without introducing direct private-store reads.

### Deliverables

#### 14.1 Publisher operations

Agent-shared and role stores require explicit publisher authority independent
of read authority. Ordinary memory capture cannot write them.

#### 14.2 Projections

A projection is a reviewed copy with:

- one target channel, role, or agent-shared audience;
- purpose and human-readable preview;
- source immutable revision;
- publisher;
- required expiry or explicit audited `no_expiry`;
- revocation behavior;
- lineage to the source.

Source edits do not auto-republish. A refreshed projection is a new reviewed
revision.

#### 14.3 Postbox

Initial modes:

- `off` by default;
- `review-required` when explicitly enabled.

Do not ship labeled automatic use in the first rollout.

Deposit requirements:

- model names a server-issued source-message handle, not a user/store ID;
- core resolves current verified sender evidence;
- selected plugin resolves the target quarantine;
- channel receives success or generic refusal only;
- channel cannot search/list/read/exact-get the item;
- persistent per-source-channel/target rate limits;
- owner provenance label, approve/edit/reject/purge controls;
- no bootstrap, trigger injection, dreaming, or promotion before review.

#### 14.4 Owner/admin surfaces

Add authenticated CLI/UI/API workflows for:

- store inspection;
- projection preview/create/revoke/refresh;
- postbox review and purge;
- safe deletion;
- revocation impact.

Do not add direct user-to-user private-store grant APIs.

### Data changes

- `memory_projections`
- `memory_postbox_items`
- persisted rate-limit/review state

### Tests

- target sees projection copy but never source;
- unrelated/newly joined channel cannot see projection;
- expiry/revoke removes all new reads;
- prior exposure impact is enumerable;
- forged/stale/cross-channel source-message handle denied;
- channel cannot read deposited item back;
- postbox never auto-promotes;
- no direct private grant through tool, SDK, API, CLI, UI, or raw DB helper.

### Definition of done

Phase 3 is complete only when all of the following are demonstrated:

- [ ] Agent-shared and role writes require explicit publisher authority
      independent of read authority.
- [ ] Every projection names one audience, purpose, source revision, publisher,
      expiry/no-expiry decision, and revocation behavior.
- [ ] A projection exposes only its reviewed copy; the target cannot read or
      mutate the private source.
- [ ] Projection refresh creates a new reviewed revision, while expiry or
      revocation removes all new reads and enumerates affected prior exposures.
- [ ] Postbox remains `off` by default and supports review-required mode before
      any labeled automatic-use mode.
- [ ] A source session can deposit only through a current server-issued source
      message handle and receives no list/read/exact-get capability over the
      result.
- [ ] Postbox rate limits, provenance, review, purge, and no-auto-promotion
      behavior are persisted and tested.
- [ ] Owner/admin CLI, API, and UI operations authenticate and use authorized
      plans.
- [ ] No tool, SDK, API, CLI, UI, plugin, or raw argument can create direct
      private user-to-user store access.
- [ ] Projection, publisher, postbox, expiry, revocation, forged-handle, and
      prior-exposure tests pass.

### Rollback

Disable new projection/deposit operations. Tombstone projection reads and keep
postbox items quarantined for review or purge.

## 15. Phase 4: enterprise identity and operations

### Goal

Add revisioned enterprise identity evidence and operational access review
without moving policy authority out of the selected memory plugin.

### Deliverables

#### 15.1 Generic adapter registry

- manifest-declared provider capability;
- operator allowlist;
- duplicate registration refusal;
- startup-only sealing;
- core constructs canonical principals;
- adapter can deny service but cannot forge another provider's principal.

#### 15.2 Provider adapters

Implement alphabetically:

- Entra ID;
- Google Workspace;
- Okta.

Each adapter provides protocol-appropriate verification material and group
snapshots. Core validates before adding facts to the context.

#### 15.3 Membership snapshots

- revisioned evidence;
- observed and expiry times;
- provider/tenant binding;
- bounded staleness;
- outage expiry removes access;
- refresh/removal and audit.

Use existing `session_members` only for Gateway collaborative-session
membership. Native channel and enterprise group membership remains separate
provider evidence.

#### 15.4 Operations

- redacted access explanation;
- audit query/export/retention;
- policy drift alerts;
- revocation impact;
- periodic access review;
- load tests for hundreds/thousands of stores, roles, and channels.

If this introduces a new plugin, update `.github/labeler.yml` and create the
matching GitHub labels as part of the plugin PR.

### Tests

- wrong issuer/audience/signature/tenant;
- expired, revoked, and unbound identity;
- duplicate/unlisted provider registration;
- role removal within documented bound;
- provider outage does not extend membership indefinitely;
- audit explanation reveals no unauthorized resource title/existence;
- collection/mount fan-out benchmarks for builtin and alternate backends.

### Definition of done

Phase 4 is complete only when all of the following are demonstrated:

- [ ] Every enabled enterprise adapter is operator-allowlisted, manifest
      declared, unique for its provider prefix, and registered before the
      registry seals.
- [ ] Core, not the adapter, validates issuer/audience/signature or registered
      attestation, tenant binding, assurance, expiry, and snapshot freshness
      before constructing principals.
- [ ] Private stores never open for forged, wrong-issuer, wrong-audience,
      expired, revoked, conflicting, or unbound identities.
- [ ] Role and native-channel evidence is revisioned, bounded by documented
      staleness, and removed fail-closed during expiry or provider outage.
- [ ] Existing `session_members` remains authoritative only for Gateway
      collaborative sessions; provider membership does not create a competing
      session-sharing store.
- [ ] Operators can explain allow/deny decisions from redacted revisions,
      subject/store kinds, collaboration roles, evidence, and rules without
      storing or revealing unauthorized memory content.
- [ ] Audit retention/export and periodic access-review behavior are approved
      and implemented.
- [ ] Provider verification, outage/expiry, group removal, registry sealing,
      audit explanation, and scale/fan-out tests pass, including required live
      official-provider proof.
- [ ] Any new plugin surface has matching labeler paths, GitHub labels, SDK
      contracts, docs, and package ownership metadata.

### Rollback

Disable adapters and allow evidence to expire. Local verified user/channel
stores continue under Stage 2 rules. Stale role evidence never becomes a local
allow.

## 16. Phase 5: process-adversarial isolation

### Goal

Prevent a compromised non-broker agent/tool process from crossing its issued
memory view.

### Deliverables

- move selected memory plugin, content-bearing indexes, and controlled artifact
  roots behind authenticated local IPC;
- keep broker DB handles, filesystem roots, and keys out of agent processes;
- bind IPC to Gateway-issued subject, capability snapshot, agent, session,
  policy revision, and request nonce;
- reject client-supplied principals and replay;
- run agents in per-session sandboxes with only virtual mounts;
- define bounded queues, cancellation, timeouts, and denial-of-service limits;
- define broker startup, health, upgrade, backup, and recovery;
- document the trusted computing base: Gateway, broker backend, selected memory
  plugin, and operator.

If at-rest application encryption is added, do it only after process separation
creates real key isolation. Do not add SQLCipher merely to protect an
in-process key from the same process.

### Tests

- compromised agent opens another store;
- raw artifact path and DB handle probing;
- IPC replay across session/actor/agent/revision;
- confused deputy;
- stale/revoked capability;
- malicious model-facing plugin inside constrained process;
- broker crash/restart and backpressure;
- OS permissions and credential separation;
- separate-cell hostile-tenant scenario.

### Definition of done

Phase 5 is complete only when all of the following are demonstrated:

- [ ] The selected memory plugin, content-bearing indexes, and controlled
      artifact roots execute behind authenticated IPC outside the agent/tool
      process.
- [ ] Agent processes receive no broker database handle, raw artifact root,
      encryption key, or reusable broker credential.
- [ ] IPC binds requests to agent, session, subject, actor/capability snapshot,
      policy revision, request nonce, and expiry; cross-context replay fails.
- [ ] Per-session sandboxes expose only the issued virtual mounts.
- [ ] Compromised non-broker agent/tool code cannot read, write, enumerate, or
      infer a store outside its issued view.
- [ ] Broker cancellation, timeout, queue bounds, restart, upgrade, backup,
      repair, and denial-of-service behavior are defined and tested.
- [ ] OS-permission, raw-path, DB-handle, replay, confused-deputy,
      stale-capability, malicious-tool, crash/restart, and separate-cell tests
      pass in a real process-isolated environment.
- [ ] Documentation states the exact tested process-adversarial boundary and
      names the trusted Gateway, broker backend, selected memory plugin, and
      operator.
- [ ] Hostile tenants continue to require separate
      Gateway/process/credential/storage cells.

### Rollback

Explicitly withdraw the process-adversarial claim. Either return to cooperative
Stage 2 after a verified export/cutover or split trust domains into separate
cells. Never replace a failed broker with raw filesystem/database access.

## 17. Phase 6: migration, pilot, and cleanup

### Goal

Cut over selected agents safely, prove real behavior, and remove temporary
shadow/legacy paths.

### Deliverables

#### 17.1 Migration

1. Doctor dry-run and owner decisions.
2. Verified backup.
3. Copy to opaque scoped stores.
4. Commit catalog, policy, subjects, and lineage.
5. Build scoped index.
6. Verify hashes, mounts, bootstrap, denial matrix, and backend conformance.
7. Write one atomic cutover marker.
8. Start enforced runtime.
9. Archive/remove legacy files and legacy index rows only after verification.

Rollback is available before cutover, or before any new scoped writes after
cutover. Once new scoped writes exist, downgrade requires an explicit export
that warns about lost audience metadata.

#### 17.2 Pilot matrix

Minimum end-to-end scenario:

1. Alice and Bob create verified isolated DMs.
2. Both store distinct private facts using colliding names/keywords.
3. Both join one group and create a channel fact.
4. Private recall returns only the current user's fact.
5. Group recall returns only channel/shared/addressed projection content.
6. Run child agent, compaction, flush, and dreaming in every context.
7. Bob leaves, a projection is revoked, and a binding is revoked.
8. New reads deny immediately or within the documented evidence bound.
9. Audit proves decisions/exposures without storing the facts.

#### 17.3 Cleanup

- remove shadow-only adapters and temporary metrics;
- remove context-free overloads from the enforced path;
- remove legacy scoped-data import helpers after migration window;
- update architecture, plugin SDK, security, multi-user, memory, compaction,
  sandbox, Doctor, CLI, backup, and testing docs;
- retain only explicit public API compatibility with a removal plan.

### Definition of done

Phase 6 is complete only when all of the following are demonstrated:

- [ ] Doctor dry-run, verified backup, scoped copy, catalog/policy commit,
      reindex, hash/mount/denial verification, and atomic cutover complete for
      every pilot agent.
- [ ] Ambiguous legacy files and transcripts are quarantined; no migration
      decision is inferred from prose, filenames, route shape, or the launching
      sender.
- [ ] Each migrated agent has exactly one canonical runtime path with no
      dual-read, dual-write, lazy import, or legacy fallback.
- [ ] Every selected and supplemental backend is conforming or explicitly
      unavailable in enforced mode.
- [ ] The two-user/group pilot proves private, channel, shared, projection,
      child, compaction, flush, dreaming, leave/revoke, binding-revoke, and
      redacted-audit behavior.
- [ ] New scoped writes make downgrade possible only through the documented
      explicit export path; pre-write rollback is verified separately.
- [ ] Shadow-only adapters, temporary metrics, context-free enforced overloads,
      and migrated legacy index rows/files are removed according to the
      approved retention window.
- [ ] Architecture, memory, multi-user, compaction, sandbox, Doctor, CLI,
      backup, plugin SDK, security, migration, and testing documentation matches
      current behavior.
- [ ] Exact-head focused and broad risk-appropriate validation is green, and
      the recorded deployment claim matches the controls actually tested.

## 18. Recommended PR sequence

Keep each PR independently safe and feature-gated.

1. SDK authorization types and conformance harness.
2. Shadow selected-runtime inspection and complete path inventory.
3. Session subject/binding additive schema, lifecycle, and core branded context factory.
4. Builtin scoped store/resource/policy schema.
5. Builtin authorized search/read contract.
6. Doctor dry-run migration and backend admission.
7. `memory_search`/`memory_get`/session recall conversion.
8. Bootstrap, prompt supplements, active recall, wiki, and LanceDB read
   conversion.
9. Minimum transcript policy companion rows and exposure receipts.
10. Virtual memory filesystem and file-tool confinement.
11. Run exposure/egress registry, or approved constrained pilot alternative.
12. Authorized write state machine and recovery.
13. Convert remember/file/watcher/import/export/sync/plugin write paths.
14. Complete transcript policy sets and transition preservation.
15. Compaction/checkpoint derivation.
16. Flush, dreaming, promotion, child, and autonomous derivation.
17. Projections and publisher operations.
18. Postbox off/review-required workflow.
19. Enterprise adapter registry and provider plugins.
20. Out-of-process broker and sandbox hardening.
21. Pilot migration, evidence, and legacy cleanup.

Public SDK PRs must update exports, baselines, docs, and bundled consumers in
the same change. Schema PRs must state explicitly whether they are additive and
why no version bump is required.

## 19. Validation strategy

### 19.1 Test layers

| Layer                | Proof                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Pure types/evaluator | Property tests for implication, deny precedence, revision, audience, delegation, and lineage.         |
| SQL/backend          | Candidate superset, top-K crowd-out, immutable revision, pending/quarantine denial, hash/path checks. |
| Core context         | Identity, session-rebound, subject revision, actor separation, delivery revision.                     |
| Plugin contract      | Builtin, LanceDB, wiki, active-memory, and alternate-backend conformance or enforced unavailability.  |
| Filesystem/sandbox   | Virtual mount, traversal/symlink/case/Unicode, direct host-path denial, exec profile.                 |
| Transcript           | Atomic companion labels, reset/fork/rewind/archive/export, missing-label denial.                      |
| Derivation           | Compaction/flush/dreaming/delegation audience intersection and ancestor revocation.                   |
| Sharing              | Projection copy, postbox one-way behavior, expiry/revocation impact.                                  |
| Enterprise           | Verification, expiry, group snapshot, outage, registry sealing.                                       |
| Process              | IPC auth/replay, OS separation, compromised agent/tool process.                                       |
| End to end           | Two-user/group/pilot matrix with revocation and audit.                                                |

### 19.2 Repository commands

For trusted source and one/few focused files with ready dependencies:

```bash
node scripts/run-vitest.mjs <path-or-filter>
git diff --check
```

For changed-path classification in a linked/Codex worktree:

```bash
node scripts/check-changed.mjs -- <changed-files...>
```

Use Testbox/Crabbox for:

- SDK surface checks;
- changed typecheck/lint fan-out;
- builds;
- broad plugin suites;
- sandbox/Docker/E2E;
- cross-platform;
- live enterprise provider proof;
- package/install/upgrade proof.

Required gates by risk:

- SDK change: `pnpm plugin-sdk:surface:check`, export/baseline tests, bundled
  plugin contract tests, build.
- SQLite schema: focused schema/maintenance/Doctor tests plus migration
  interruption cases.
- Plugin runtime loading: build and isolated extension import profiling.
- Sandbox/filesystem: focused policy tests plus Docker/Testbox scenario.
- User-visible migration: Doctor live-copy scenario against an isolated state
  directory.
- Enterprise API: official contract/source verification plus live test.
- Process isolation: real remote scenario, not only unit mocks.

Do not run independent Vitest commands concurrently in one worktree.

## 20. Observability

Expose only bounded, redacted signals:

- decision counts by operation and stable reason;
- postfilter denial after prefilter pass;
- backend capability/conformance failures;
- subject/binding/membership revision age;
- exposed resource count and bytes by scope kind;
- quarantine/postbox/projection backlog;
- projection expiry/revocation backlog;
- search/policy/write/repair latency;
- pending write intents and hash mismatches;
- audit outbox backlog;
- egress denial by capability class.

Do not label metrics with query text, prompt text, memory content, raw provider
IDs, or unbounded principal/resource identifiers.

Stable denial reasons should include:

- `invalid-context`
- `session-rebound`
- `delivery-rebound`
- `plan-expired`
- `identity-revoked`
- `membership-stale`
- `outside-view`
- `revision-stale`
- `explicit-deny`
- `default-deny`
- `lineage-deny`
- `backend-nonconforming`

## 21. Main risks and mitigations

| Risk                                             | Mitigation                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Scope grows into a second memory architecture    | Keep selected plugin ownership; add generic contracts only; no core deep imports into bundled memory implementation. |
| Stage 1 is too large to land                     | Use Phases 1A-1D with read-only enforced state and explicit exit gates.                                              |
| Legacy backend silently widens access            | Reject nonconforming backend; never fall back from an authorized alternate backend to broad legacy builtin.          |
| Transcript or compaction launders content        | Require atomic policy companion rows before scoped exposure; compaction is derivation.                               |
| File tools bypass memory policy                  | Controlled artifact roots are never model-visible; virtual memory paths delegate to authorized operations.           |
| Unsandboxed exec defeats model isolation         | Hide/deny or restrict claim to cooperative isolation with Doctor finding.                                            |
| Write crash exposes orphan/pending content       | Two-transaction pending-to-active state machine plus startup repair.                                                 |
| Policy revisions leave descendants readable      | Store stable policy requirements and revalidate current revisions/epochs.                                            |
| Migration publishes personal legacy data         | Structural classification and owner confirmation; ambiguous data goes to quarantine.                                 |
| Too many public config knobs                     | One enablement surface; staged features unavailable until implemented.                                               |
| Audit becomes a second sensitive corpus          | Store IDs, revisions, decisions, hashes, and timestamps only; explicit retention/access policy.                      |
| Egress registry becomes unbounded project scope  | Owner decision before Phase 1D; constrained pilot if deferred, with no broad claim.                                  |
| Enterprise plugin can forge identity             | Adapters provide evidence; core validates and constructs principals; allowlisted sealed registry.                    |
| Direct grant complexity leaks into first release | Keep direct user-to-user private reads structurally absent.                                                          |

## 22. Completion checklist

- [ ] One trusted, write-once subject or explicit ambiguous/service state exists
      for every session.
- [ ] Every selected memory backend uses the versioned authorized contract.
- [ ] Every supplemental memory path routes through the selected capability or
      is unavailable.
- [ ] Every content-bearing result has valid exposure and egress receipts.
- [ ] Every durable memory resource has store, audience, authority, origin,
      revision, and lifecycle state.
- [ ] Every transcript event after scoped exposure has an evaluable policy
      companion row.
- [ ] Every write uses the authorized crash-consistent lifecycle.
- [ ] Every derivation records source revisions and audience intersection.
- [ ] Bootstrap, search, exact read, automatic recall, files, transcripts,
      compaction, dreaming, delegation, sync, import, export, and public
      artifacts have no unscoped fallback.
- [ ] Existing session collaboration and provider membership are consumed only
      at their owning boundaries.
- [ ] Migration is explicit, idempotent, verified, and single-path at runtime.
- [ ] Ambiguous legacy data is quarantined.
- [ ] Postbox defaults off and remains write-only from source sessions.
- [ ] No direct private user-to-user read path exists.
- [ ] The tested isolation claim and trusted computing base are documented.
- [ ] Stronger hostile-tenant guidance still requires separate cells.
