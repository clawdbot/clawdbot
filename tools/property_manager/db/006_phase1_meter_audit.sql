-- PropertyManager Phase 1: meter audit fields, proposed meters, mapping proposals
-- Apply: docker exec -i postgres psql -U openclaw -d openclaw < tools/property_manager/db/006_phase1_meter_audit.sql

BEGIN;

-- Proposed meter defaults on assets (operator must activate)
ALTER TABLE propertymanager.assets
    ADD COLUMN IF NOT EXISTS meter_proposed_type text,
    ADD COLUMN IF NOT EXISTS meter_proposed_unit text,
    ADD COLUMN IF NOT EXISTS meter_activated_at timestamptz;

-- Optimistic concurrency and epoch on active meter
ALTER TABLE propertymanager.asset_meter
    ADD COLUMN IF NOT EXISTS meter_epoch integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

-- Audit fields on readings (append-only history)
ALTER TABLE propertymanager.asset_meter_reading
    ADD COLUMN IF NOT EXISTS previous_reading_id uuid
        REFERENCES propertymanager.asset_meter_reading(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS meter_type_at_entry text,
    ADD COLUMN IF NOT EXISTS unit_at_entry text,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'accepted',
    ADD COLUMN IF NOT EXISTS operator_identity text,
    ADD COLUMN IF NOT EXISTS integration_identity text,
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS meter_epoch integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS corrects_reading_id uuid
        REFERENCES propertymanager.asset_meter_reading(id) ON DELETE SET NULL;

ALTER TABLE propertymanager.asset_meter_reading
    DROP CONSTRAINT IF EXISTS asset_meter_reading_status_check;

ALTER TABLE propertymanager.asset_meter_reading
    ADD CONSTRAINT asset_meter_reading_status_check
        CHECK (status IN ('accepted', 'rejected', 'corrected'));

-- Backfill snapshots for existing rows
UPDATE propertymanager.asset_meter_reading r
SET meter_type_at_entry = COALESCE(r.meter_type_at_entry, m.meter_type),
    unit_at_entry = COALESCE(r.unit_at_entry, m.unit),
    status = COALESCE(r.status, 'accepted'),
    meter_epoch = COALESCE(r.meter_epoch, m.meter_epoch, 1)
FROM propertymanager.asset_meter m
WHERE r.asset_id = m.asset_id
  AND (r.meter_type_at_entry IS NULL OR r.unit_at_entry IS NULL);

UPDATE propertymanager.assets a
SET meter_proposed_type = COALESCE(a.meter_proposed_type, m.meter_type),
    meter_proposed_unit = COALESCE(a.meter_proposed_unit, m.unit),
    meter_activated_at = COALESCE(a.meter_activated_at, now())
FROM propertymanager.asset_meter m
WHERE a.id = m.asset_id
  AND m.meter_type <> 'none'
  AND a.meter_activated_at IS NULL;

-- Idempotency: one accepted reading per asset + key
CREATE UNIQUE INDEX IF NOT EXISTS asset_meter_reading_idempotency_idx
    ON propertymanager.asset_meter_reading (asset_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status = 'accepted';

CREATE INDEX IF NOT EXISTS asset_meter_reading_asset_epoch_reading_at_idx
    ON propertymanager.asset_meter_reading (asset_id, meter_epoch, reading_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS asset_meter_reading_status_idx
    ON propertymanager.asset_meter_reading (asset_id, status)
    WHERE status = 'accepted';

-- RanchBrain task→asset mapping review queue (no auto-apply)
CREATE TABLE IF NOT EXISTS propertymanager.asset_task_mapping_proposals (
    id uuid PRIMARY KEY,
    ranchbrain_task_ref text NOT NULL,
    task_id uuid REFERENCES propertymanager.maintenance_tasks(id) ON DELETE SET NULL,
    proposed_asset_id uuid NOT NULL REFERENCES propertymanager.assets(id) ON DELETE CASCADE,
    match_rationale text NOT NULL DEFAULT '',
    confidence numeric(5, 4) NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending',
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT asset_task_mapping_proposals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS asset_task_mapping_proposals_status_idx
    ON propertymanager.asset_task_mapping_proposals (status, confidence DESC);

CREATE UNIQUE INDEX IF NOT EXISTS asset_task_mapping_proposals_task_asset_pending_idx
    ON propertymanager.asset_task_mapping_proposals (ranchbrain_task_ref, proposed_asset_id)
    WHERE status = 'pending';

COMMIT;
