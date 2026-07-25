BEGIN;

-- Phase 2F.5: allow the runtime role to record observed routing/failover usage.
-- Read path remains the primary contract; write access is limited to telemetry.

GRANT USAGE ON SCHEMA ai_intelligence TO openclaw_ai_runtime;

GRANT SELECT, INSERT ON TABLE ai_intelligence.observed_model_usage
    TO openclaw_ai_runtime;

GRANT USAGE, SELECT ON SEQUENCE ai_intelligence.observed_model_usage_observed_usage_id_seq
    TO openclaw_ai_runtime;

GRANT SELECT ON TABLE ai_intelligence.latest_observed_model_usage
    TO openclaw_ai_runtime;

GRANT SELECT ON TABLE ai_intelligence.deployment_drift
    TO openclaw_ai_runtime;

INSERT INTO ai_intelligence.schema_migrations (
    migration_id,
    description
)
VALUES (
    '002_observed_usage_runtime_write_grants',
    'Grant openclaw_ai_runtime INSERT on observed_model_usage for Phase 2F.5 telemetry'
)
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
