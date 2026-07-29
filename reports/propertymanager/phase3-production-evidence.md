# PropertyManager Phase 3 Production Evidence

**Date:** 2026-07-29  
**Gate:** Operator authorized Phase 3 ("Page 3 authorized")  
**Host:** `intelmini` (confirmed production Intel Mini)  
**Branch / commit at start:** `production` @ `d6a5e0cc6c6` (Phase 2)  
**IPs:** LAN `192.168.50.104`, Tailscale `100.85.36.72`  
**API:** `http://100.85.36.72:5062` (also `http://127.0.0.1:5062` on host)

## Preflight

| Check | Result |
|-------|--------|
| This host is Intel Mini production | **YES** (`hostname=intelmini`) |
| Phase 2 commit present | `d6a5e0cc6c6` |
| Postgres container | `postgres` Up |
| Pre-existing API | Port 5062 held by manual `run_api.sh` with `AUTH_DISABLED=1`; systemd unit crash-looping (address in use) |

### Backup

```bash
docker exec postgres pg_dump -U openclaw openclaw -n propertymanager \
  > reports/propertymanager/pre-phase3-propertymanager-20260729095500.sql
```

- Path: `reports/propertymanager/pre-phase3-propertymanager-20260729095500.sql`
- Size: ~78K / 793 lines
- **Not committed** (contains production data; `reports/` is gitignored)

### Rollback steps

1. Stop API: `systemctl --user stop propertymanager-api.service`
2. Restore schema dump:
   ```bash
   docker exec -i postgres psql -U openclaw -d openclaw \
     -c "DROP SCHEMA IF EXISTS propertymanager CASCADE;"
   docker exec -i postgres psql -U openclaw -d openclaw \
     < reports/propertymanager/pre-phase3-propertymanager-20260729095500.sql
   ```
3. Restore systemd unit from backup under `~/.config/systemd/user/propertymanager-api.service.bak-phase3-*` if needed; `daemon-reload`; start service.
4. Optional: revert to prior commit on `production` after restore.

## Migrations

Migrations **005** and **006** were **already applied** on this host (verified before re-apply).

| Object | Present |
|--------|---------|
| `propertymanager.assets` (+ `meter_proposed_*`, `meter_activated_at`) | yes |
| `propertymanager.asset_meter` (+ `meter_epoch`, `row_version`) | yes |
| `propertymanager.asset_meter_reading` audit cols | yes |
| `propertymanager.asset_task_mapping_proposals` | yes |
| Health `schema_version` | `006` |

No migration re-apply required. Idempotent SQL left in place for future hosts.

## Auth + API deploy

### Secrets

- Created `~/.config/openclaw/db.env` mode `0600` with:
  - `PROPERTYMANAGER_AUTH_DISABLED=0`
  - `PROPERTYMANAGER_API_KEY` (generated, not printed)
  - `PROPERTYMANAGER_OPERATOR_PIN` (generated, not printed)
- **Operator must rotate/set PIN and API key** to preferred values and update Mac/iOS settings accordingly.
- Secrets are **not** in git.

### systemd

Updated `~/.config/systemd/user/propertymanager-api.service`:

- `PROPERTYMANAGER_AUTH_DISABLED=0`
- `PROPERTYMANAGER_DB_ENV_FILE=%h/.config/openclaw/db.env`
- Stopped crash-loop / freed port 5062 / started unit

### Code deploy notes

- `tools/property_manager/api/run_api.sh`: default auth **enabled** (`AUTH_DISABLED` defaults to `0`).
- `tools/property_manager/api/assets_api.py`: meter create/confirm use `@auth_required(allow_pin=True)` so dashboard QR PIN writes work.
- `tools/property_manager/deploy/install_dashboard_pm_auth.sh`: operator sudo helper to EnvironmentFile-wire dashboard.

### Health smoke

```json
{
  "api_version": "v1",
  "auth_mode": "api_key",
  "auth_required": true,
  "schema_version": "006",
  "service": "propertymanager-api",
  "status": "ok"
}
```

| Probe | Result |
|-------|--------|
| Anonymous meter POST | `401 UNAUTHORIZED` |
| API key POST to unactivated meter | `400` meter not activated |
| Operator PIN POST to unactivated meter | `400` meter not activated |
| Anonymous `GET /v1/assets/by-qr/<token>` | `200` |

## RanchBrain import

```bash
python3 tools/property_manager/db/import_ranchbrain_assets_to_postgres.py \
  --root /mnt/ai-storage/ranchbrain --dry-run
python3 tools/property_manager/db/import_ranchbrain_assets_to_postgres.py \
  --root /mnt/ai-storage/ranchbrain --apply
```

| Metric | Count |
|--------|-------|
| RanchBrain JSON files | 25 |
| Active assets | 39 |
| Proposed `runtime_hours` | 27 |
| Proposed `mileage` | 4 |
| Proposed `none` | 8 |
| Meters activated | 27 |
| Proposed but not activated | 4 (test assets: MAP-TEST-*, QR-TEST-*) |

### Mapping proposals

- Pending: **0** (none auto-approved during Phase 3)
- Approved: **3** (pre-existing Phase 1/2 test proposals; left as-is)

Operator review CLI:

```bash
python3 tools/property_manager/propertymanager-mapping-proposals.py list --status pending
```

## Dashboard QR

- Routes live after `kill -HUP` on gunicorn main PID (code reload).
- Verified: `GET http://127.0.0.1:5051/pm/asset/<qr_token>` → **200**, shows asset name + meter + PIN form.
- Dashboard system unit **does not yet** load `db.env` (sudo required). Until operator runs install helper, dashboard process may still use default PIN env while API uses generated PIN — **QR writes need the sudo wiring step below**.

```bash
# Operator (requires password):
tools/property_manager/deploy/install_dashboard_pm_auth.sh
```

## Client pointers (Mac / iOS)

| Setting | Production value |
|---------|------------------|
| API URL | `http://100.85.36.72:5062` |
| Auth | API key and/or operator PIN from `~/.config/openclaw/db.env` on Intel Mini |
| Path prefix | `/v1/` for assets/meters |

**Do not force-push Mac apps from this host.** On M4:

1. Pull `production` (this Phase 3 commit).
2. Copy/sync `tools/property_manager/swift-mac/AssetAPIClient.swift` + `AssetViews.swift` if using patch flow.
3. Set Settings API URL to Tailscale URL above; paste API key / PIN (do not commit).
4. `swift build -c release` and relaunch Mac app.
5. Rebuild/reinstall iOS against same URL + credentials.

## Operator post-deploy checklist

1. **Rotate secrets** in `~/.config/openclaw/db.env` if desired; restart `propertymanager-api.service`.
2. **Wire dashboard auth:** run `tools/property_manager/deploy/install_dashboard_pm_auth.sh` (sudo).
3. **Activate meters** for real assets still proposed (review list; skip test MAP-/QR-/Phase* assets or delete later).
4. **Approve mapping proposals** when new RanchBrain imports create pending rows.
5. **Rebuild Mac + iOS** against `http://100.85.36.72:5062` with production credentials.
6. Spot-check: QR read anonymous; QR write with PIN; Mac meter entry + lower-reading confirm; completion with `confirm_current_meter`.

## What was not done / gaps

- Full concurrency/offline-sync matrix not re-run on production (dev Phase 2 acceptance stands).
- Dashboard EnvironmentFile install blocked here (no passwordless sudo); operator must run helper.
- Mac/iOS binary cutover deferred to operator on M4 (documented only).
