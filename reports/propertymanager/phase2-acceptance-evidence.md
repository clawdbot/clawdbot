# PropertyManager Phase 2 Acceptance Evidence

**Date:** 2026-07-29  
**Environment:** Development VM (`production` branch)  
**API:** `http://127.0.0.1:5062` (schema_version `006`, api_version `v1`)  
**Auth mode:** `PROPERTYMANAGER_AUTH_DISABLED=1` (dev integration)

## Client changes (Phase 2)

### iPhone/iPad (`apps/propertymanager-ios/Sources/`)

| File | Change |
|------|--------|
| `PropertyAPIClient.swift` | New core client: `/v1/` asset paths via `makeURL(..., versioned: true)`, auth headers (API key / operator PIN), `completeTask` with `meter_value_at_completion` and `confirm_current_meter` |
| `AssetAPIClient.swift` | Migrated to `/v1/assets`, `/v1/meter-readings`, `/v1/meter-readings/confirm`, `/v1/meter-readings/parse`, `activate-meter`; paginated readings (`items[]`); 409 preview → confirm flow |
| `AssetModels.swift` | `LowerReadingPreview`, `ProposedMeter`, decimal-safe decoding |
| `MeterEntrySheet.swift` | Two-step lower-reading: POST → 409 preview → confirm with `preview_token` + `correction_reason` |
| `VoiceMeterEntry.swift` | Same preview/confirm flow for voice entry |
| `AssetDetailView.swift` | Activate-meter banner for proposed meters |
| `TaskListView.swift` | Meter-scheduled completion: confirm current or enter new (no silent default) |
| `SettingsView.swift` | API URL, optional API key, operator PIN, operator identity |
| `MaintenanceModels.swift` | Task/category models with `scheduleKind`, meter fields |

### Mac (`tools/property_manager/swift-mac/`)

| File | Change |
|------|--------|
| `AssetAPIClient.swift` | `/v1/` paths via `makeURL("v1/...")`, preview/confirm, activate-meter |
| `AssetViews.swift` | Proposed-meter activation, lower-reading confirm UI |
| `apply_mac_meter_patch.py` | Copies swift-mac files; Phase 2 `confirm_current_meter` patch |

**M4 deploy:** `AssetAPIClient.swift` + `AssetViews.swift` copied via SSH; `swift build -c release` **passed** on M4 (2026-07-29).

## Test results

### Phase 1 smoke (`test_phase1_meters.py`)

```
  OK health
  OK normal reading + activate meter
  OK idempotency
  OK lower reading preview/confirm
  OK backdated reading (current unchanged)
  OK mapping proposal approve
All Phase 1 smoke tests passed.
```

### Phase 2 client contract (`test_phase2_meters.py`)

```
  OK health
  OK GET /v1/assets
  OK activate-meter (proposed → active)
  OK paginated meter-readings (items[])
  OK POST /v1/meter-readings/parse
  OK lower-reading preview/confirm
  OK normal reading flow (standalone asset)
  OK completion confirm_current_meter required
  OK mapping proposal approve
  OK QR read (anonymous GET by-qr)
All Phase 2 client contract tests passed.
```

## curl examples

### Health

```bash
curl -s http://127.0.0.1:5062/health | jq .
# schema_version: "006", api_version: "v1"
```

### List assets (v1)

```bash
curl -s http://127.0.0.1:5062/v1/assets | jq '.[0] | {id, name, meter, proposed_meter}'
```

### Activate proposed meter

```bash
curl -s -X POST http://127.0.0.1:5062/v1/assets/<asset_id>/activate-meter \
  -H "Content-Type: application/json" \
  -H "X-Operator-Identity: curl-smoke" \
  -d '{}' | jq .
```

### Lower-reading preview → confirm

```bash
# Step 1: POST lower value → 409 with preview_token
curl -s -X POST http://127.0.0.1:5062/v1/assets/<asset_id>/meter-readings \
  -H "Content-Type: application/json" \
  -H "X-Operator-Identity: curl-smoke" \
  -d '{"value":"50"}' | jq .

# Step 2: Confirm
curl -s -X POST http://127.0.0.1:5062/v1/assets/<asset_id>/meter-readings/confirm \
  -H "Content-Type: application/json" \
  -H "X-Operator-Identity: curl-smoke" \
  -d '{"preview_token":"<token>","correction_reason":"correction","operator_identity":"curl-smoke"}' | jq .
```

### Task completion (meter required)

```bash
# Fails without meter acknowledgment
curl -s -X POST http://127.0.0.1:5062/tasks/<task_id>/complete \
  -H "Content-Type: application/json" \
  -d '{"note":"no meter"}' | jq .
# → 400 VALIDATION_ERROR

# Succeeds with confirm_current_meter
curl -s -X POST http://127.0.0.1:5062/tasks/<task_id>/complete \
  -H "Content-Type: application/json" \
  -d '{"note":"done","confirm_current_meter":true}' | jq .
```

### QR read (anonymous)

```bash
curl -s http://127.0.0.1:5062/v1/assets/by-qr/<qr_token> | jq '{name, meter}'
```

### QR write policy

- Write to unactivated meter returns `400`: `meter not activated; operator must activate proposed meter first`
- With auth enabled, write requires `X-Operator-PIN` or `Authorization: Bearer <api_key>` (dashboard uses PIN)

## RanchBrain import dry-run

```
Found 25 RanchBrain asset JSON files under /mnt/ai-storage/ranchbrain
```

| Metric | Count |
|--------|-------|
| Active assets in DB | 34 |
| Mapping proposals (pending) | 0 |
| Mapping proposals (approved) | 1 |

Import sets **proposed** meter defaults (`runtime_hours`/`hrs` for Equipment, `mileage`/`mi` for Vehicles); operator must activate via `POST /v1/assets/<id>/activate-meter`.

## Smoke checklist

| Scenario | Result |
|----------|--------|
| activate-meter | PASS |
| mapping approve | PASS |
| QR read (anonymous GET by-qr) | PASS |
| QR write (requires activated meter + auth when enabled) | PASS (validation enforced) |
| lower-reading preview/confirm | PASS |
| completion confirm_current_meter | PASS |

## Not in scope (Phase 2)

- Intel Mini production deploy
- Production migration apply
- Full test matrix (concurrency, offline sync) — Phase 3 prerequisites

## Phase 3 prerequisites for operator

See updated status in `docs/foundation/PROPERTY_MANAGER_FOUNDATIONAL_REQUIREMENTS.md`.
