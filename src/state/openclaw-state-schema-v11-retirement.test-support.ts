// Exact schema of the two tables retired by state schema 11, matching the
// documented 11→10 downgrade recipe in docs/reference/database-schemas.md.
// Tests use it to rebuild v10-shaped databases: the v11 retirement regression
// seeds a pre-migration file, and pinned older readers project a current
// database back to the schema era they were built against.
export const STATE_SCHEMA_11_TO_10_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS skill_lifecycle (
  skill_file TEXT NOT NULL PRIMARY KEY,
  skill_key TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stale', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  state_changed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  archived_reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_key
  ON skill_lifecycle(skill_key, skill_file);
CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_state
  ON skill_lifecycle(state, skill_file);

CREATE TABLE IF NOT EXISTS skill_workshop_proposal_origin_runs (
  proposal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  mutation_count INTEGER NOT NULL CHECK (mutation_count > 0),
  PRIMARY KEY (proposal_id, run_id),
  FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
) STRICT;
`;
