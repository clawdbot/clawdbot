---
role: sqlite-state-management
status: experimental
summary: |
  SQLite-based state management for OpenProse programs. This approach persists
  execution state to a SQLite database, enabling structured queries, atomic
  transactions, and flexible schema evolution.
requires: sqlite3 CLI tool in PATH
see-also:
  - ../prose.md: VM execution semantics
  - filesystem.md: File-based state (default, more prescriptive)
  - in-context.md: In-context state (for simple programs)
  - ../primitives/session.md: Session context and compaction guidelines
---

# SQLite State Management (Experimental)

This document describes how the OpenProse VM tracks execution state using a **SQLite database**. This is an experimental alternative to file-based state (`filesystem.md`) and in-context state (`in-context.md`).

## Prerequisites

**Requires:** The `sqlite3` command-line tool must be available in your PATH.

| Platform | Installation                                               |
| -------- | ---------------------------------------------------------- |
| macOS    | Pre-installed                                              |
| Linux    | `apt install sqlite3` / `dnf install sqlite3` / etc.       |
| Windows  | `winget install SQLite.SQLite` or download from sqlite.org |

If `sqlite3` is not available, the VM will fall back to filesystem state and warn the user.

---

## Overview

SQLite state provides:

- **Atomic transactions**: State changes are ACID-compliant
- **Structured queries**: Find specific bindings, filter by status, aggregate results
- **Flexible schema**: Add columns and tables as needed
- **Single-file portability**: The entire run state is one `.db` file
- **Concurrent access**: SQLite handles locking automatically

**Key principle:** The database is a flexible workspace. The VM and subagents share it as a coordination mechanism, not a rigid contract.

---

## Database Location

The database lives within the standard run directory:

```
.prose/runs/{YYYYMMDD}-{HHMMSS}-{random}/
├── state.db          # SQLite database (this file)
├── program.prose     # Copy of running program
└── attachments/      # Large outputs that don't fit in DB (optional)
```

**Run ID format:** Same as filesystem state: `{YYYYMMDD}-{HHMMSS}-{random6}`

Example: `.prose/runs/20260116-143052-a7b3c9/state.db`

### Project-Scoped and User-Scoped Agents

Execution-scoped agents (the default) live in the per-run `state.db`. However, **project-scoped agents** (`persist: project`) and **user-scoped agents** (`persist: user`) must survive across runs.

For project-scoped agents, use a separate database:

```
.prose/
├── agents.db                 # Project-scoped agent memory (survives runs)
└── runs/
    └── {id}/
        └── state.db          # Execution-scoped state (dies with run)
```

For user-scoped agents, use a database in the home directory:

```
~/.prose/
└── agents.db                 # User-scoped agent memory (survives across projects)
```

The `agents` and `agent_segments` tables for project-scoped agents live in `.prose/agents.db`, and for user-scoped agents live in `~/.prose/agents.db`. The VM initializes these databases on first use and provides the correct path to subagents.

---

## Responsibility Separation

The VM/subagent contract matches [postgres.md](./postgres.md#responsibility-separation).

SQLite-specific differences:

- the VM creates `state.db` instead of an `openprose` schema
- subagent confirmation messages point at a local database path, for example `.prose/runs/<runId>/state.db`
- cleanup is typically `VACUUM` or file deletion rather than dropping schema objects

Example return values:

```text
Binding written: research
Location: .prose/runs/20260116-143052-a7b3c9/state.db (bindings table, name='research', execution_id=NULL)
```

```text
Binding written: result
Location: .prose/runs/20260116-143052-a7b3c9/state.db (bindings table, name='result', execution_id=43)
Execution ID: 43
```

The VM still tracks locations, not full values.

---

## Core Schema

The VM initializes these tables. This is a **minimum viable schema**—extend freely.

```sql
-- Run metadata
CREATE TABLE IF NOT EXISTS run (
    id TEXT PRIMARY KEY,
    program_path TEXT,
    program_source TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'running',  -- running, completed, failed, interrupted
    state_mode TEXT DEFAULT 'sqlite'
);

-- Execution position and history
CREATE TABLE IF NOT EXISTS execution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_index INTEGER,
    statement_text TEXT,
    status TEXT,  -- pending, executing, completed, failed, skipped
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    parent_id INTEGER REFERENCES execution(id),  -- for nested blocks
    metadata TEXT  -- JSON for construct-specific data (loop iteration, parallel branch, etc.)
);

-- All named values (input, output, let, const)
CREATE TABLE IF NOT EXISTS bindings (
    name TEXT,
    execution_id INTEGER,  -- NULL for root scope, non-null for block invocations
    kind TEXT,  -- input, output, let, const
    value TEXT,
    source_statement TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    attachment_path TEXT,  -- if value is too large, store path to file
    PRIMARY KEY (name, IFNULL(execution_id, -1))  -- IFNULL handles NULL for root scope
);

-- Persistent agent memory
CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY,
    scope TEXT,  -- execution, project, user, custom
    memory TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Agent invocation history
CREATE TABLE IF NOT EXISTS agent_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT REFERENCES agents(name),
    segment_number INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    prompt TEXT,
    summary TEXT,
    UNIQUE(agent_name, segment_number)
);

-- Import registry
CREATE TABLE IF NOT EXISTS imports (
    alias TEXT PRIMARY KEY,
    source_url TEXT,
    fetched_at TEXT,
    inputs_schema TEXT,  -- JSON
    outputs_schema TEXT  -- JSON
);
```

### Schema Conventions

- **Timestamps**: Use ISO 8601 format (`datetime('now')`)
- **JSON fields**: Store structured data as JSON text in `metadata`, `*_schema` columns
- **Large values**: If a binding value exceeds ~100KB, write to `attachments/{name}.md` and store path
- **Extension tables**: Prefix with `x_` (e.g., `x_metrics`, `x_audit_log`)
- **Anonymous bindings**: Sessions without explicit capture (`session "..."` without `let x =`) use auto-generated names: `anon_001`, `anon_002`, etc.
- **Import bindings**: Prefix with import alias for scoping: `research.findings`, `research.sources`
- **Scoped bindings**: Use `execution_id` column—NULL for root scope, non-null for block invocations

### Scope Resolution Query

For recursive blocks, bindings are scoped to their execution frame. Resolve variables by walking up the call stack:

```sql
-- Find binding 'result' starting from execution_id 43
WITH RECURSIVE scope_chain AS (
  -- Start with current execution
  SELECT id, parent_id FROM execution WHERE id = 43
  UNION ALL
  -- Walk up to parent
  SELECT e.id, e.parent_id
  FROM execution e
  JOIN scope_chain s ON e.id = s.parent_id
)
SELECT b.* FROM bindings b
LEFT JOIN scope_chain s ON b.execution_id = s.id
WHERE b.name = 'result'
  AND (b.execution_id IN (SELECT id FROM scope_chain) OR b.execution_id IS NULL)
ORDER BY
  CASE WHEN b.execution_id IS NULL THEN 1 ELSE 0 END,  -- Prefer scoped over root
  s.id DESC NULLS LAST  -- Prefer deeper (more local) scope
LIMIT 1;
```

**Simpler version if you know the scope chain:**

```sql
-- Direct lookup: check current scope, then parent, then root
SELECT * FROM bindings
WHERE name = 'result'
  AND (execution_id = 43 OR execution_id = 42 OR execution_id IS NULL)
ORDER BY execution_id DESC NULLS LAST
LIMIT 1;
```

---

## Database Interaction

Both VM and subagents interact via the `sqlite3` CLI.

### From the VM

```bash
# Initialize database
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "CREATE TABLE IF NOT EXISTS..."

# Update execution position
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "
  INSERT INTO execution (statement_index, statement_text, status, started_at)
  VALUES (3, 'session \"Research AI safety\"', 'executing', datetime('now'))
"

# Read a binding
sqlite3 -json .prose/runs/20260116-143052-a7b3c9/state.db "
  SELECT value FROM bindings WHERE name = 'research'
"

# Check parallel branch status
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "
  SELECT statement_text, status FROM execution
  WHERE json_extract(metadata, '$.parallel_id') = 'p1'
"
```

### From Subagents

The VM provides the database path and instructions when spawning:

**Root scope (outside block invocations):**

```
Your output database is:
  .prose/runs/20260116-143052-a7b3c9/state.db

When complete, write your output:

sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "
  INSERT OR REPLACE INTO bindings (name, execution_id, kind, value, source_statement, updated_at)
  VALUES (
    'research',
    NULL,  -- root scope
    'let',
    'AI safety research covers alignment, robustness...',
    'let research = session: researcher',
    datetime('now')
  )
"
```

**Inside block invocation (include execution_id):**

```
Execution scope:
  execution_id: 43
  block: process
  depth: 3

Your output database is:
  .prose/runs/20260116-143052-a7b3c9/state.db

When complete, write your output:

sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "
  INSERT OR REPLACE INTO bindings (name, execution_id, kind, value, source_statement, updated_at)
  VALUES (
    'result',
    43,  -- scoped to this execution
    'let',
    'Processed chunk into 3 sub-parts...',
    'let result = session \"Process chunk\"',
    datetime('now')
  )
"
```

For persistent agents (execution-scoped):

```
Your memory is in the database:
  .prose/runs/20260116-143052-a7b3c9/state.db

Read your current state:
  sqlite3 -json .prose/runs/20260116-143052-a7b3c9/state.db "SELECT memory FROM agents WHERE name = 'captain'"

Update when done:
  sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "UPDATE agents SET memory = '...', updated_at = datetime('now') WHERE name = 'captain'"

Record this segment:
  sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "INSERT INTO agent_segments (agent_name, segment_number, prompt, summary) VALUES ('captain', 3, '...', '...')"
```

For project-scoped agents, use `.prose/agents.db`. For user-scoped agents, use `~/.prose/agents.db`.

---

## Context Preservation in Main Thread

**This is critical.** The database is for persistence and coordination, but the VM must still maintain conversational context.

### What the VM Must Narrate

Even with SQLite state, the VM should narrate key events in its conversation:

```
[Position] Statement 3: let research = session: researcher
   Spawning session, will write to state.db
   [Task tool call]
[Success] Session complete, binding written to DB
[Binding] research = <stored in state.db>
```

### Why Both?

| Purpose                   | Mechanism                                                            |
| ------------------------- | -------------------------------------------------------------------- |
| **Working memory**        | Conversation narration (what the VM "remembers" without re-querying) |
| **Durable state**         | SQLite database (survives context limits, enables resumption)        |
| **Subagent coordination** | SQLite database (shared access point)                                |
| **Debugging/inspection**  | SQLite database (queryable history)                                  |

The narration is the VM's "mental model" of execution. The database is the "source of truth" for resumption and inspection.

---

## Parallel Execution

For parallel blocks, the VM uses the `metadata` JSON field to track branches. **Only the VM writes to the `execution` table.**

```sql
-- VM marks parallel start
INSERT INTO execution (statement_index, statement_text, status, metadata)
VALUES (5, 'parallel:', 'executing', '{"parallel_id": "p1", "strategy": "all", "branches": ["a", "b", "c"]}');

-- VM creates execution record for each branch
INSERT INTO execution (statement_index, statement_text, status, parent_id, metadata)
VALUES (6, 'a = session "Task A"', 'executing', 5, '{"parallel_id": "p1", "branch": "a"}');

-- Subagent writes its output to bindings table (see "From Subagents" section)
-- Task tool signals completion to VM via substrate

-- VM marks branch complete after Task returns
UPDATE execution SET status = 'completed', completed_at = datetime('now')
WHERE json_extract(metadata, '$.parallel_id') = 'p1' AND json_extract(metadata, '$.branch') = 'a';

-- VM checks if all branches complete
SELECT COUNT(*) as pending FROM execution
WHERE json_extract(metadata, '$.parallel_id') = 'p1' AND status != 'completed';
```

---

## Loop Tracking

```sql
-- Loop metadata tracks iteration state
INSERT INTO execution (statement_index, statement_text, status, metadata)
VALUES (10, 'loop until **analysis complete** (max: 5):', 'executing',
  '{"loop_id": "l1", "max_iterations": 5, "current_iteration": 0, "condition": "**analysis complete**"}');

-- Update iteration
UPDATE execution
SET metadata = json_set(metadata, '$.current_iteration', 2),
    updated_at = datetime('now')
WHERE json_extract(metadata, '$.loop_id') = 'l1';
```

---

## Error Handling

```sql
-- Record failure
UPDATE execution
SET status = 'failed',
    error_message = 'Connection timeout after 30s',
    completed_at = datetime('now')
WHERE id = 15;

-- Track retry attempts in metadata
UPDATE execution
SET metadata = json_set(metadata, '$.retry_attempt', 2, '$.max_retries', 3)
WHERE id = 15;
```

---

## Large Outputs

When a binding value is too large for comfortable database storage (>100KB):

1. Write content to `attachments/{binding_name}.md`
2. Store the path in the `attachment_path` column
3. Leave `value` as a summary or null

```sql
INSERT INTO bindings (name, kind, value, attachment_path, source_statement)
VALUES (
  'full_report',
  'let',
  'Full analysis report (847KB) - see attachment',
  'attachments/full_report.md',
  'let full_report = session "Generate comprehensive report"'
);
```

---

## Resuming Execution

To resume an interrupted run:

```sql
-- Find current position
SELECT statement_index, statement_text, status
FROM execution
WHERE status = 'executing'
ORDER BY id DESC LIMIT 1;

-- Get all completed bindings
SELECT name, kind, value, attachment_path FROM bindings;

-- Get agent memory states
SELECT name, memory FROM agents;

-- Check parallel block status
SELECT json_extract(metadata, '$.branch') as branch, status
FROM execution
WHERE json_extract(metadata, '$.parallel_id') IS NOT NULL
  AND parent_id = (SELECT id FROM execution WHERE status = 'executing' AND statement_text LIKE 'parallel:%');
```

---

## Flexibility Encouragement

Unlike filesystem state, SQLite state is intentionally **less prescriptive**. The core schema is a starting point. You are encouraged to:

- **Add columns** to existing tables as needed
- **Create extension tables** (prefix with `x_`)
- **Store custom metrics** (timing, token counts, model info)
- **Build indexes** for your query patterns
- **Use JSON functions** for semi-structured data

Example extensions:

```sql
-- Custom metrics table
CREATE TABLE x_metrics (
    execution_id INTEGER REFERENCES execution(id),
    metric_name TEXT,
    metric_value REAL,
    recorded_at TEXT DEFAULT (datetime('now'))
);

-- Add custom column
ALTER TABLE bindings ADD COLUMN token_count INTEGER;

-- Create index for common query
CREATE INDEX idx_execution_status ON execution(status);
```

The database is your workspace. Use it.

---

## Comparison with Other Modes

| Aspect                 | filesystem.md             | in-context.md        | sqlite.md                     |
| ---------------------- | ------------------------- | -------------------- | ----------------------------- |
| **State location**     | `.prose/runs/{id}/` files | Conversation history | `.prose/runs/{id}/state.db`   |
| **Queryable**          | Via file reads            | No                   | Yes (SQL)                     |
| **Atomic updates**     | No                        | N/A                  | Yes (transactions)            |
| **Schema flexibility** | Rigid file structure      | N/A                  | Flexible (add tables/columns) |
| **Resumption**         | Read state.md             | Re-read conversation | Query database                |
| **Complexity ceiling** | High                      | Low (<30 statements) | High                          |
| **Dependency**         | None                      | None                 | sqlite3 CLI                   |
| **Status**             | Stable                    | Stable               | **Experimental**              |

---

## Summary

SQLite state management:

1. Uses a **single database file** per run
2. Provides **clear responsibility separation** between VM and subagents
3. Enables **structured queries** for state inspection
4. Supports **atomic transactions** for reliable updates
5. Allows **flexible schema evolution** as needed
6. Requires the **sqlite3 CLI** tool
7. Is **experimental**—expect changes

The core contract: the VM manages execution flow and spawns subagents; subagents write their own outputs directly to the database. Both maintain the principle that what happens is recorded, and what is recorded can be queried.
