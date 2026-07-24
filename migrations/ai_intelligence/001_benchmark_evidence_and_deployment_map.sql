BEGIN;

CREATE SCHEMA IF NOT EXISTS ai_intelligence;

CREATE TABLE IF NOT EXISTS ai_intelligence.schema_migrations (
    migration_id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    description text NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_intelligence.models (
    model_id text PRIMARY KEY,
    display_name text NOT NULL,
    provider text NOT NULL,
    deployment text NOT NULL
        CHECK (deployment IN ('local', 'cloud', 'hybrid')),
    status text NOT NULL
        CHECK (
            status IN (
                'production',
                'production-fallback',
                'evaluation',
                'watch',
                'disabled'
            )
        ),
    privacy_tier text NOT NULL,
    cost_tier text NOT NULL,
    notes text,
    registry_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_intelligence.model_versions (
    model_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id text NOT NULL
        REFERENCES ai_intelligence.models(model_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    version_name text NOT NULL,
    provider_version text,
    model_digest text,
    context_window_tokens integer
        CHECK (
            context_window_tokens IS NULL
            OR context_window_tokens > 0
        ),
    first_observed_at timestamptz NOT NULL DEFAULT now(),
    last_observed_at timestamptz NOT NULL DEFAULT now(),
    version_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (model_id, version_name)
);

CREATE TABLE IF NOT EXISTS ai_intelligence.benchmarks (
    benchmark_id text PRIMARY KEY,
    display_name text NOT NULL,
    category text NOT NULL,
    description text,
    maximum_score numeric(10,4) NOT NULL DEFAULT 100
        CHECK (maximum_score > 0),
    passing_score numeric(10,4)
        CHECK (
            passing_score IS NULL
            OR passing_score >= 0
        ),
    benchmark_version text NOT NULL DEFAULT '1',
    active boolean NOT NULL DEFAULT true,
    benchmark_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_intelligence.benchmark_runs (
    benchmark_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id text NOT NULL
        REFERENCES ai_intelligence.models(model_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    model_version_id bigint
        REFERENCES ai_intelligence.model_versions(model_version_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    run_status text NOT NULL
        CHECK (
            run_status IN (
                'started',
                'completed',
                'failed',
                'cancelled'
            )
        ),
    execution_environment text,
    runner_version text,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    total_duration_ms bigint
        CHECK (
            total_duration_ms IS NULL
            OR total_duration_ms >= 0
        ),
    input_tokens bigint
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens bigint
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
    estimated_cost_usd numeric(14,6)
        CHECK (
            estimated_cost_usd IS NULL
            OR estimated_cost_usd >= 0
        ),
    configuration_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        completed_at IS NULL
        OR completed_at >= started_at
    )
);

CREATE TABLE IF NOT EXISTS ai_intelligence.benchmark_results (
    benchmark_result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    benchmark_run_id bigint NOT NULL
        REFERENCES ai_intelligence.benchmark_runs(benchmark_run_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    benchmark_id text NOT NULL
        REFERENCES ai_intelligence.benchmarks(benchmark_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    raw_score numeric(12,4),
    normalized_score numeric(8,4)
        CHECK (
            normalized_score IS NULL
            OR (
                normalized_score >= 0
                AND normalized_score <= 100
            )
        ),
    passed boolean,
    duration_ms bigint
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
    input_tokens bigint
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens bigint
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
    estimated_cost_usd numeric(14,6)
        CHECK (
            estimated_cost_usd IS NULL
            OR estimated_cost_usd >= 0
        ),
    hallucination_count integer NOT NULL DEFAULT 0
        CHECK (hallucination_count >= 0),
    validation_error_count integer NOT NULL DEFAULT 0
        CHECK (validation_error_count >= 0),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    evaluator_notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (benchmark_run_id, benchmark_id)
);

CREATE TABLE IF NOT EXISTS ai_intelligence.project_components (
    component_id text PRIMARY KEY,
    display_name text NOT NULL,
    description text,
    privacy_tier text NOT NULL,
    task_type text,
    active boolean NOT NULL DEFAULT true,
    component_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_intelligence.model_assignments (
    model_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    component_id text NOT NULL
        REFERENCES ai_intelligence.project_components(component_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    assignment_type text NOT NULL
        CHECK (
            assignment_type IN (
                'primary',
                'fallback',
                'embedding',
                'specialist'
            )
        ),
    model_id text NOT NULL
        REFERENCES ai_intelligence.models(model_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    priority integer NOT NULL DEFAULT 1
        CHECK (priority > 0),
    assignment_status text NOT NULL DEFAULT 'configured'
        CHECK (
            assignment_status IN (
                'configured',
                'observed',
                'recommended',
                'disabled'
            )
        ),
    routing_mode text NOT NULL DEFAULT 'production-safe',
    configuration_source text,
    assignment_reason text,
    effective_from timestamptz NOT NULL DEFAULT now(),
    effective_until timestamptz,
    human_approved boolean NOT NULL DEFAULT false,
    approved_by text,
    assignment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        effective_until IS NULL
        OR effective_until > effective_from
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_primary_assignment
    ON ai_intelligence.model_assignments(component_id)
    WHERE
        assignment_type = 'primary'
        AND assignment_status != 'disabled'
        AND effective_until IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_assignment_priority
    ON ai_intelligence.model_assignments(
        component_id,
        assignment_type,
        priority
    )
    WHERE
        assignment_status != 'disabled'
        AND effective_until IS NULL;

CREATE TABLE IF NOT EXISTS ai_intelligence.assignment_history (
    assignment_history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_assignment_id bigint,
    component_id text NOT NULL,
    assignment_type text NOT NULL,
    previous_model_id text,
    new_model_id text,
    previous_status text,
    new_status text,
    change_reason text NOT NULL,
    changed_by text NOT NULL DEFAULT 'system',
    human_approved boolean NOT NULL DEFAULT false,
    change_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_intelligence.observed_model_usage (
    observed_usage_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    component_id text NOT NULL
        REFERENCES ai_intelligence.project_components(component_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    model_id text NOT NULL
        REFERENCES ai_intelligence.models(model_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    model_version_id bigint
        REFERENCES ai_intelligence.model_versions(model_version_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    request_id text,
    task_type text,
    routing_mode text,
    selected_as text
        CHECK (
            selected_as IN (
                'primary',
                'fallback',
                'manual',
                'evaluation',
                'unknown'
            )
        ),
    success boolean,
    duration_ms bigint
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
    input_tokens bigint
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens bigint
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
    estimated_cost_usd numeric(14,6)
        CHECK (
            estimated_cost_usd IS NULL
            OR estimated_cost_usd >= 0
        ),
    privacy_tier text,
    usage_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_intelligence.promotion_history (
    promotion_history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id text NOT NULL
        REFERENCES ai_intelligence.models(model_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    component_id text
        REFERENCES ai_intelligence.project_components(component_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    previous_status text,
    proposed_status text NOT NULL,
    decision text NOT NULL
        CHECK (
            decision IN (
                'recommended',
                'approved',
                'rejected',
                'reverted'
            )
        ),
    evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    decision_reason text NOT NULL,
    decided_by text NOT NULL DEFAULT 'system',
    human_approved boolean NOT NULL DEFAULT false,
    decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_started
    ON ai_intelligence.benchmark_runs(
        model_id,
        started_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_benchmark_results_benchmark
    ON ai_intelligence.benchmark_results(
        benchmark_id,
        normalized_score DESC
    );

CREATE INDEX IF NOT EXISTS idx_assignments_component_status
    ON ai_intelligence.model_assignments(
        component_id,
        assignment_status
    );

CREATE INDEX IF NOT EXISTS idx_observed_usage_component_time
    ON ai_intelligence.observed_model_usage(
        component_id,
        observed_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_observed_usage_model_time
    ON ai_intelligence.observed_model_usage(
        model_id,
        observed_at DESC
    );

CREATE OR REPLACE VIEW ai_intelligence.current_model_deployment AS
SELECT
    pc.component_id,
    pc.display_name AS component_name,
    pc.privacy_tier AS component_privacy_tier,
    pc.task_type,
    ma.assignment_type,
    ma.priority,
    ma.model_id,
    m.display_name AS model_name,
    m.provider,
    m.deployment,
    m.status AS model_status,
    m.privacy_tier AS model_privacy_tier,
    ma.assignment_status,
    ma.routing_mode,
    ma.configuration_source,
    ma.assignment_reason,
    ma.human_approved,
    ma.effective_from
FROM ai_intelligence.project_components AS pc
JOIN ai_intelligence.model_assignments AS ma
    ON ma.component_id = pc.component_id
JOIN ai_intelligence.models AS m
    ON m.model_id = ma.model_id
WHERE
    pc.active = true
    AND ma.assignment_status != 'disabled'
    AND ma.effective_until IS NULL;

CREATE OR REPLACE VIEW ai_intelligence.latest_observed_model_usage AS
SELECT DISTINCT ON (omu.component_id)
    omu.component_id,
    pc.display_name AS component_name,
    omu.model_id,
    m.display_name AS model_name,
    omu.selected_as,
    omu.success,
    omu.routing_mode,
    omu.observed_at
FROM ai_intelligence.observed_model_usage AS omu
JOIN ai_intelligence.project_components AS pc
    ON pc.component_id = omu.component_id
JOIN ai_intelligence.models AS m
    ON m.model_id = omu.model_id
ORDER BY
    omu.component_id,
    omu.observed_at DESC,
    omu.observed_usage_id DESC;

CREATE OR REPLACE VIEW ai_intelligence.deployment_drift AS
SELECT
    configured.component_id,
    configured.component_name,
    configured.model_id AS configured_primary_model,
    observed.model_id AS latest_observed_model,
    observed.observed_at,
    CASE
        WHEN observed.model_id IS NULL THEN 'not-observed'
        WHEN observed.model_id = configured.model_id THEN 'matched'
        ELSE 'drift'
    END AS deployment_status
FROM ai_intelligence.current_model_deployment AS configured
LEFT JOIN ai_intelligence.latest_observed_model_usage AS observed
    ON observed.component_id = configured.component_id
WHERE
    configured.assignment_type = 'primary';

INSERT INTO ai_intelligence.schema_migrations (
    migration_id,
    description
)
VALUES (
    '001_benchmark_evidence_and_deployment_map',
    'Benchmark evidence database and project model deployment map'
)
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
