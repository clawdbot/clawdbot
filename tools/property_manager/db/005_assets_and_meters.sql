-- PropertyManager assets and operating meters
-- Apply: docker exec -i postgres psql -U openclaw -d openclaw < tools/property_manager/db/005_assets_and_meters.sql

BEGIN;

CREATE TABLE IF NOT EXISTS propertymanager.assets (
    id uuid PRIMARY KEY,
    external_id text NOT NULL UNIQUE,
    ranchbrain_guid uuid,
    name text NOT NULL,
    manufacturer text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    category text NOT NULL DEFAULT '',
    location text NOT NULL DEFAULT '',
    aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
    qr_token text NOT NULL UNIQUE,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_external_id_idx ON propertymanager.assets (external_id);
CREATE INDEX IF NOT EXISTS assets_qr_token_idx ON propertymanager.assets (qr_token);
CREATE INDEX IF NOT EXISTS assets_name_lower_idx ON propertymanager.assets (lower(name));

CREATE TABLE IF NOT EXISTS propertymanager.asset_meter (
    asset_id uuid PRIMARY KEY REFERENCES propertymanager.assets(id) ON DELETE CASCADE,
    meter_type text NOT NULL DEFAULT 'none',
    current_value numeric(14, 3) NOT NULL DEFAULT 0,
    unit text NOT NULL DEFAULT '',
    latest_reading_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT asset_meter_type_check
        CHECK (meter_type IN ('runtime_hours', 'mileage', 'cycles', 'none'))
);

CREATE TABLE IF NOT EXISTS propertymanager.asset_meter_reading (
    id uuid PRIMARY KEY,
    asset_id uuid NOT NULL REFERENCES propertymanager.assets(id) ON DELETE CASCADE,
    value numeric(14, 3) NOT NULL,
    reading_at timestamptz NOT NULL DEFAULT now(),
    entry_method text NOT NULL DEFAULT 'manual',
    note text,
    correction_reason text,
    usage_since_previous numeric(14, 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT asset_meter_reading_entry_method_check
        CHECK (entry_method IN ('manual', 'voice', 'qr', 'api', 'telegram', 'completion')),
    CONSTRAINT asset_meter_reading_correction_reason_check
        CHECK (
            correction_reason IS NULL
            OR correction_reason IN ('replacement', 'rollover', 'correction')
        )
);

CREATE INDEX IF NOT EXISTS asset_meter_reading_asset_id_reading_at_idx
    ON propertymanager.asset_meter_reading (asset_id, reading_at DESC);

ALTER TABLE propertymanager.maintenance_tasks
    ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES propertymanager.assets(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS schedule_kind text NOT NULL DEFAULT 'calendar',
    ADD COLUMN IF NOT EXISTS meter_interval_value numeric(14, 3),
    ADD COLUMN IF NOT EXISTS meter_interval_unit text,
    ADD COLUMN IF NOT EXISTS last_done_meter_value numeric(14, 3),
    ADD COLUMN IF NOT EXISTS next_due_meter_value numeric(14, 3);

ALTER TABLE propertymanager.maintenance_tasks
    DROP CONSTRAINT IF EXISTS maintenance_tasks_schedule_kind_check;

ALTER TABLE propertymanager.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_schedule_kind_check
    CHECK (schedule_kind IN ('calendar', 'meter', 'both'));

CREATE INDEX IF NOT EXISTS maintenance_tasks_asset_id_idx
    ON propertymanager.maintenance_tasks (asset_id)
    WHERE is_active = true;

ALTER TABLE propertymanager.maintenance_completions
    ADD COLUMN IF NOT EXISTS meter_value_at_completion numeric(14, 3),
    ADD COLUMN IF NOT EXISTS meter_reading_id uuid REFERENCES propertymanager.asset_meter_reading(id) ON DELETE SET NULL;

COMMIT;
