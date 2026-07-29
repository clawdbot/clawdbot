---
title: "PropertyManager Foundational Requirements"
version: "1.0"
status: "Foundational — Phase 0"
owner: "OpenClaw Operator"
last_reviewed: "2026-07-29"
category: "Governance"
source_document: "PROPERTY_MANAGER_FOUNDATIONAL_REQUIREMENTS.md"
---

# PropertyManager Foundational Requirements

Version: 1.0  
Status: **Phase 0 — design only; implementation blocked**  
Owner: OpenClaw Operator  
Last Updated: 2026-07-29

---

## Purpose

This document is the authoritative policy and requirements baseline for PropertyManager assets, operating meters, and meter-based preventive maintenance. It governs all schema, API, client, migration, and rollout work.

Implementation details live in [PropertyManager Asset Architecture](../architecture/PROPERTY_MANAGER_ASSET_ARCHITECTURE.md). This document must not be contradicted by implementation.

---

## Phase 0 gate — implementation blocked until operator approval

**No schema migration, API endpoint, dashboard route, Swift client change, or production deployment may proceed until:**

1. This document and the asset architecture document are reviewed and explicitly approved by the operator.
2. The Phase 0 design review checklist (below) is signed off.
3. A separate Phase 1 authorization is issued for implementation on the **development VM**.

Until Phase 1 authorization:

- Existing draft SQL, API stubs, and client prototypes in the repo are **non-authoritative** and must not be applied to any database.
- Documentation updates are the only permitted deliverable for Phase 0.

### Phase 0 design review checklist

| #   | Requirement                                                                                                                       | Blocker ref |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Dev VM is the sole implementation and test environment until operator approval                                                    | 1           |
| 2   | Production (Intel Mini) is a separate checkpoint requiring explicit operator approval                                             | 1           |
| 3   | `asset_meter_reading` audit fields defined (see architecture doc)                                                                 | 3           |
| 4   | Backdated reading rules: no auto-replace of current meter unless chronologically latest                                           | 4           |
| 5   | Lower-reading preview-and-confirm workflow with operator identity + audit record                                                  | 5           |
| 6   | Maintenance completion cannot silently default to stale meter                                                                     | 6           |
| 7   | Calendar intervals never approximate meter hours to days                                                                          | 7           |
| 8   | Meter defaults proposed at import; operator review before activation                                                              | 8           |
| 9   | RanchBrain task→asset matching is review-only; no auto-apply                                                                      | 9           |
| 10  | API reliability contract defined (versioning, auth, decimals, timezones, pagination, idempotency, concurrency, validation errors) | 10          |
| 11  | QR access policy: opaque token ≠ authorization                                                                                    | 11          |
| 12  | Client diagram: all clients → REST API only, not Postgres directly                                                                | 12          |
| 13  | Extended test matrix defined                                                                                                      | 13          |

---

## Development and deployment boundary

All PropertyManager work follows a **two-environment, two-gate** model aligned with [OpenClaw Development Directive](OPENCLAW_DEVELOPMENT_DIRECTIVE.md).

### Environment roles

| Environment                 | Role                                                                                                                          | Authorization                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Development VM**          | Schema design, migration dry-runs, API implementation, dashboard and client integration testing, load and concurrency testing | Normal development on `development` branch          |
| **Production (Intel Mini)** | Authoritative Postgres, live API, operator-facing QR and Telegram paths                                                       | **Explicit operator approval only** after dev proof |

### Deployment phases

| Phase       | Scope                                                                                           | Gate                                  |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Phase 0** | Requirements and architecture docs (this document + asset architecture)                         | Operator design approval              |
| **Phase 1** | Dev VM: schema migrations, API, dashboard QR page, Mac/iOS client wiring, test matrix execution | Operator Phase 1 authorization        |
| **Phase 2** | Dev VM: end-to-end operator acceptance testing on real workflows                                | Operator acceptance sign-off          |
| **Phase 3** | Production Intel Mini: schema apply, API deploy, client cutover                                 | **Explicit production authorization** |
| **Phase 4** | Production monitoring, rollback readiness, documentation update                                 | Post-deploy review                    |

**Rules:**

- Migrations are dry-run on dev VM first; production apply requires a written rollback plan.
- No client may connect to production Postgres directly (see Client access).
- Committing to `development` does not authorize production deployment.
- Rollout runbooks must list dev proof artifacts before each production step.

---

## System of record and client access

- **PostgreSQL** (`propertymanager` schema) on the Intel Mini is the production system of record for assets, meters, readings, schedules, and audit history.
- **All clients** (Mac, iPhone/iPad, Dashboard QR page, Telegram, RanchBrain CLI) interact **only through the PropertyManager REST API**. No client reads or writes Postgres directly.
- Mac and iOS may maintain a local JSON cache for offline display; cache is a **derived copy**, not authoritative.
- CSV export remains legacy/briefing-only and must not be treated as a write path.

See the client topology diagram in [PropertyManager Asset Architecture](../architecture/PROPERTY_MANAGER_ASSET_ARCHITECTURE.md#client-topology).

---

## Operating meters — requirements

### Meter types and defaults

| Asset category                      | Proposed default meter type | Proposed default unit |
| ----------------------------------- | --------------------------- | --------------------- |
| Equipment                           | `runtime_hours`             | `hrs`                 |
| Vehicles / Vehicle                  | `mileage`                   | `mi`                  |
| Tractor, Shop, all other categories | `none`                      | —                     |

**Defaults are proposals only.** At RanchBrain asset import:

1. The system **proposes** a meter type and unit based on category.
2. The operator **reviews and confirms or overrides** before the meter is activated.
3. No meter-based schedules or reading acceptance may run until the operator activates the meter.

### Meter reading audit requirements

Every `asset_meter_reading` record must support full audit reconstruction. Required fields (detailed in architecture doc):

- `previous_reading_id` — chain to prior accepted reading in the same meter epoch
- `meter_type` and `unit` **at entry time** — snapshot even if asset meter config later changes
- `status` — `accepted`, `rejected`, or `corrected`
- Operator or integration identity (`operator_id`, `integration_id`, or equivalent)
- `idempotency_key` — deduplicate mobile retries and offline sync replays
- `meter_epoch` — integer incremented on meter replacement or rollover; readings in different epochs must not be compared for usage deltas
- Link to record being corrected (`corrects_reading_id`) when status is `corrected`
- Existing fields retained: `value`, `reading_at`, `entry_method`, `correction_reason`, `usage_since_previous`

Append-only history: no UPDATE or DELETE of accepted readings; corrections create new rows.

### Backdated readings

When a reading is inserted with `reading_at` earlier than the current latest accepted reading:

1. It must **not** automatically replace `asset_meter.current_value` unless it is chronologically the **latest** reading after full sort by `reading_at` (tie-break by `created_at`).
2. The system must **recalculate `usage_since_previous`** for all readings before and after the insertion within the same `meter_epoch`.
3. If the backdated reading becomes the chronologically latest, `current_value` and `latest_reading_at` update accordingly.
4. PM remaining calculations must rerun after any backdated acceptance.

### Lower-reading confirmation

A reading lower than the previous accepted reading in the same `meter_epoch` is **never silently accepted**.

Requirements:

1. API returns a **preview** showing previous value, proposed value, delta, and required correction type options (`replacement`, `rollover`, `correction`).
2. Operator must **explicitly confirm** via a second request that includes correction type, operator identity, and optional note.
3. `correction_reason` alone on the initial POST is **insufficient**; confirmation creates an audit record with `status=accepted` and linked `previous_reading_id`.
4. Replacement or rollover increments `meter_epoch` on the asset meter; subsequent readings start a new chain.

### Maintenance completion and meter capture

When completing a meter-scheduled maintenance task:

1. The system must **display the current meter reading** (from API, not stale cache).
2. The operator must **confirm the displayed reading** or **enter a new reading**.
3. Silent default to a stale or cached meter value is **prohibited**.
4. Completion creates or links an `asset_meter_reading` with `entry_method=completion` and captures `meter_value_at_completion` on the completion record.

---

## Schedule requirements — calendar and meter

### Calendar intervals

- **Never** convert meter intervals to approximate calendar days (e.g. do not turn "50 hours" into "~7 days").
- Calendar schedules (`warning_days`, `next_due`) and meter schedules (`meter_interval_value`, `meter_interval_unit`) are **independent** fields.
- **Combined schedules** (`schedule_kind=both`) are allowed **only** when the manufacturer manual explicitly specifies "whichever comes first" (or equivalent). Both intervals must be stored as authored; the recalc engine evaluates each independently.

### Meter-based PM

- Meter intervals originate from manufacturer manual import and are stored on the task at import time.
- Recalc after accepted readings and completions: `remaining_meter = next_due_meter_value - current_meter_value`.

---

## RanchBrain asset and task matching

- RanchBrain JSON assets expose `asset_id` (e.g. `EQ-DEERE-MOWER-001`) as the join key to `propertymanager.assets.external_id`.
- **No auto-apply** of task→asset matches based on area, item name, or fuzzy text similarity.
- Import and sync must **generate a reviewable mapping report** listing proposed matches with confidence and match rationale.
- Matches are applied **only after operator approval** of each mapping (or an explicit bulk-approve action logged in audit).

---

## API reliability requirements

The PropertyManager REST API must meet these non-functional requirements before production (Phase 3):

| Concern                 | Requirement                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| **Versioning**          | URL or header version prefix (e.g. `/v1/`); breaking changes require new version                       |
| **Authentication**      | All mutating endpoints require authenticated operator or registered integration identity               |
| **Decimal-safe values** | Meter values as decimal/string types end-to-end; no float rounding for odometer or hour meter readings |
| **Timezone rules**      | `reading_at` stored as `timestamptz`; API accepts ISO 8601 with offset; display uses operator locale   |
| **Pagination**          | Cursor-based pagination for list endpoints; stable ordering documented                                 |
| **Idempotency**         | `Idempotency-Key` header or body field; duplicate requests return original result                      |
| **Concurrency**         | Optimistic locking or row versioning on asset meter updates; conflict returns structured 409           |
| **Validation errors**   | Structured JSON error body: `code`, `message`, `field`, `details[]`                                    |

Endpoint shapes and entity definitions are specified in the architecture document. Phase 1 implements against that contract.

---

## QR code security

- QR URLs embed an **opaque token** (`qr_token`) that identifies an asset for **routing only**.
- **Opaque token ≠ authorization.** Possession of a QR URL does not grant write access.
- Access policy (Phase 1 implementation must enforce):

| Action                                   | Policy                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Read asset name, current meter (display) | May be allowed anonymously on dashboard QR landing **only if** operator enables public read for that asset class |
| Submit meter reading                     | Requires authenticated session, one-time operator PIN, or time-limited signed token issued after auth            |
| Update asset metadata                    | Authenticated operator only; never via QR alone                                                                  |

Exact auth mechanism is a Phase 1 design detail; the **requirement** is that write paths cannot rely on QR token secrecy alone.

---

## Test matrix (required before production)

The following scenarios must pass on the **development VM** before Phase 3 authorization:

| Scenario                                                     | Validates                                       |
| ------------------------------------------------------------ | ----------------------------------------------- |
| Concurrent meter entries on same asset                       | Concurrency protection, no lost updates         |
| Duplicate mobile retries (same `idempotency_key`)            | Idempotent replay                               |
| Offline sync: queue readings, replay on reconnect            | Ordering, idempotency, conflict handling        |
| Backdated reading insertion (middle of history)              | Usage recalc, conditional current_value update  |
| Backdated reading that becomes latest                        | current_value promotion                         |
| Meter replacement (`meter_epoch` increment)                  | Epoch isolation, no invalid deltas              |
| Meter rollover (odometer)                                    | Epoch or correction workflow                    |
| Transactional rollback on partial failure                    | No orphan readings or inconsistent PM state     |
| Maintenance completion with stale cache                      | Forces confirm-or-enter; rejects silent default |
| Maintenance completion with new reading                      | Reading link, PM recalc                         |
| Manual entry provenance                                      | operator_id, entry_method, audit chain          |
| Combined calendar + meter schedule ("whichever comes first") | Independent evaluation, no day/hour conversion  |
| Lower-reading preview-and-confirm                            | Two-step flow, audit record                     |
| RanchBrain mapping report                                    | No auto-apply without approval                  |
| QR read without auth vs write with auth                      | Token ≠ authorization                           |

Test evidence (logs, API responses, DB snapshots) must be archived for operator review at Phase 2 gate.

---

## Related documents

- [PropertyManager Asset Architecture](../architecture/PROPERTY_MANAGER_ASSET_ARCHITECTURE.md) — entity model, API contract, recalc rules, rollout
- [OpenClaw Development Directive](OPENCLAW_DEVELOPMENT_DIRECTIVE.md) — dev/prod governance
- [RanchBrain Architecture](../RanchBrain-Architecture.md) — asset join key
- [Foundational Documents Index](FOUNDATIONAL_DOCUMENTS.md)

---

## Phase 1 scope (after operator approval)

When Phase 1 is authorized, implementation work includes (non-exhaustive):

1. Schema migration on dev VM reflecting audit fields and `meter_epoch`
2. REST API implementing reliability contract
3. Preview-and-confirm lower-reading workflow
4. Backdated reading recalc engine
5. Completion meter confirm-or-enter UI (Mac, iOS, dashboard)
6. RanchBrain mapping report generator (no auto-apply)
7. QR landing page with read/write access policy
8. Test matrix execution and evidence pack

Production deployment (Phase 3) remains blocked until Phase 2 operator acceptance.
