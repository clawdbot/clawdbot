BEGIN;

CREATE TABLE IF NOT EXISTS public.reference_documents (
    id BIGSERIAL PRIMARY KEY,
    storage_root TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    category TEXT NOT NULL,
    document_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    page_count INTEGER CHECK (page_count IS NULL OR page_count >= 1),
    encrypted BOOLEAN,
    source_host TEXT NOT NULL,
    storage_state TEXT NOT NULL
        CHECK (storage_state IN ('pending', 'available', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (storage_root, relative_path),
    UNIQUE (storage_root, sha256)
);

CREATE INDEX IF NOT EXISTS reference_documents_category_idx
    ON public.reference_documents (category);

CREATE INDEX IF NOT EXISTS reference_documents_created_at_idx
    ON public.reference_documents (created_at DESC);

COMMIT;
