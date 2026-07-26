BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.long_term_memory (
    id BIGSERIAL PRIMARY KEY,
    agent_name TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    embedding vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS long_term_memory_agent_category_created_idx
    ON public.long_term_memory (
        agent_name,
        category,
        created_at DESC
    );

COMMIT;
