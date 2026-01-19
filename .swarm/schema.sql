
-- Claude Flow V3 Memory Database
-- Version: 3.0.0
-- Features: Pattern learning, vector embeddings, temporal decay, migration tracking

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ============================================
-- CORE MEMORY TABLES
-- ============================================

-- Memory entries (main storage)
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic' CHECK(type IN ('semantic', 'episodic', 'procedural', 'working', 'pattern')),

  -- Vector embedding for semantic search (stored as JSON array)
  embedding TEXT,
  embedding_model TEXT DEFAULT 'local',
  embedding_dimensions INTEGER,

  -- Metadata
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON object
  owner_id TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER,
  last_accessed_at INTEGER,

  -- Access tracking for hot/cold detection
  access_count INTEGER DEFAULT 0,

  -- Status
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),

  UNIQUE(namespace, key)
);

-- Indexes for memory entries
CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(key);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_accessed ON memory_entries(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_memory_owner ON memory_entries(owner_id);

-- ============================================
-- PATTERN LEARNING TABLES
-- ============================================

-- Learned patterns with confidence scoring and versioning
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,

  -- Pattern identification
  name TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK(pattern_type IN (
    'task-routing', 'error-recovery', 'optimization', 'learning',
    'coordination', 'prediction', 'code-pattern', 'workflow'
  )),

  -- Pattern definition
  condition TEXT NOT NULL, -- Regex or semantic match
  action TEXT NOT NULL, -- What to do when pattern matches
  description TEXT,

  -- Confidence scoring (0.0 - 1.0)
  confidence REAL DEFAULT 0.5,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,

  -- Temporal decay
  decay_rate REAL DEFAULT 0.01, -- How fast confidence decays
  half_life_days INTEGER DEFAULT 30, -- Days until confidence halves without use

  -- Vector embedding for semantic pattern matching
  embedding TEXT,
  embedding_dimensions INTEGER,

  -- Versioning
  version INTEGER DEFAULT 1,
  parent_id TEXT REFERENCES patterns(id),

  -- Metadata
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON object
  source TEXT, -- Where the pattern was learned from

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_matched_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,

  -- Status
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deprecated', 'experimental'))
);

-- Indexes for patterns
CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status);
CREATE INDEX IF NOT EXISTS idx_patterns_last_matched ON patterns(last_matched_at);

-- Pattern evolution history (for versioning)
CREATE TABLE IF NOT EXISTS pattern_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id TEXT NOT NULL REFERENCES patterns(id),
  version INTEGER NOT NULL,

  -- Snapshot of pattern state
  confidence REAL,
  success_count INTEGER,
  failure_count INTEGER,
  condition TEXT,
  action TEXT,

  -- What changed
  change_type TEXT CHECK(change_type IN ('created', 'updated', 'success', 'failure', 'decay', 'merged', 'split')),
  change_reason TEXT,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_pattern_history_pattern ON pattern_history(pattern_id);

-- ============================================
-- LEARNING & TRAJECTORY TABLES
-- ============================================

-- Learning trajectories (SONA integration)
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  session_id TEXT,

  -- Trajectory state
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'abandoned')),
  verdict TEXT CHECK(verdict IN ('success', 'failure', 'partial', NULL)),

  -- Context
  task TEXT,
  context TEXT, -- JSON object

  -- Metrics
  total_steps INTEGER DEFAULT 0,
  total_reward REAL DEFAULT 0,

  -- Timestamps
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  ended_at INTEGER,

  -- Reference to extracted pattern (if any)
  extracted_pattern_id TEXT REFERENCES patterns(id)
);

-- Trajectory steps
CREATE TABLE IF NOT EXISTS trajectory_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id),
  step_number INTEGER NOT NULL,

  -- Step data
  action TEXT NOT NULL,
  observation TEXT,
  reward REAL DEFAULT 0,

  -- Metadata
  metadata TEXT, -- JSON object

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_steps_trajectory ON trajectory_steps(trajectory_id);

-- ============================================
-- MIGRATION STATE TRACKING
-- ============================================

-- Migration state (for resume capability)
CREATE TABLE IF NOT EXISTS migration_state (
  id TEXT PRIMARY KEY,
  migration_type TEXT NOT NULL, -- 'v2-to-v3', 'pattern', 'memory', etc.

  -- Progress tracking
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
  total_items INTEGER DEFAULT 0,
  processed_items INTEGER DEFAULT 0,
  failed_items INTEGER DEFAULT 0,
  skipped_items INTEGER DEFAULT 0,

  -- Current position (for resume)
  current_batch INTEGER DEFAULT 0,
  last_processed_id TEXT,

  -- Source/destination info
  source_path TEXT,
  source_type TEXT,
  destination_path TEXT,

  -- Backup info
  backup_path TEXT,
  backup_created_at INTEGER,

  -- Error tracking
  last_error TEXT,
  errors TEXT, -- JSON array of errors

  -- Timestamps
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================
-- SESSION MANAGEMENT
-- ============================================

-- Sessions for context persistence
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,

  -- Session state
  state TEXT NOT NULL, -- JSON object with full session state
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'expired')),

  -- Context
  project_path TEXT,
  branch TEXT,

  -- Metrics
  tasks_completed INTEGER DEFAULT 0,
  patterns_learned INTEGER DEFAULT 0,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER
);

-- ============================================
-- VECTOR INDEX METADATA (for HNSW)
-- ============================================

-- Track HNSW index state
CREATE TABLE IF NOT EXISTS vector_indexes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,

  -- Index configuration
  dimensions INTEGER NOT NULL,
  metric TEXT DEFAULT 'cosine' CHECK(metric IN ('cosine', 'euclidean', 'dot')),

  -- HNSW parameters
  hnsw_m INTEGER DEFAULT 16,
  hnsw_ef_construction INTEGER DEFAULT 200,
  hnsw_ef_search INTEGER DEFAULT 100,

  -- Quantization
  quantization_type TEXT CHECK(quantization_type IN ('none', 'scalar', 'product')),
  quantization_bits INTEGER DEFAULT 8,

  -- Statistics
  total_vectors INTEGER DEFAULT 0,
  last_rebuild_at INTEGER,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================
-- SYSTEM METADATA
-- ============================================

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);


INSERT OR REPLACE INTO metadata (key, value) VALUES
  ('schema_version', '3.0.0'),
  ('backend', 'hybrid'),
  ('created_at', '2026-01-18T17:29:41.644Z'),
  ('sql_js', 'true'),
  ('vector_embeddings', 'enabled'),
  ('pattern_learning', 'enabled'),
  ('temporal_decay', 'enabled'),
  ('hnsw_indexing', 'enabled');

-- Create default vector index configuration
INSERT OR IGNORE INTO vector_indexes (id, name, dimensions) VALUES
  ('default', 'default', 768),
  ('patterns', 'patterns', 768);
