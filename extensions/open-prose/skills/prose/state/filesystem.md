---
role: file-system-state-management
summary: |
  File-system state management for OpenProse programs. This approach persists
  execution state to the `.prose/` directory, enabling inspection, resumption,
  and long-running workflows.
see-also:
  - ../prose.md: VM execution semantics
  - in-context.md: In-context state management (alternative approach)
  - sqlite.md: SQLite state management (experimental)
  - postgres.md: PostgreSQL state management (experimental)
  - ../primitives/session.md: Session context and compaction guidelines
---

# File-System State Management

This document describes how the OpenProse VM tracks execution state using **files in the `.prose/` directory**. This is one of two state management approaches (the other being in-context state in `in-context.md`).

## Overview

File-based state persists all execution artifacts to disk. This enables:

- **Inspection**: See exactly what happened at each step
- **Resumption**: Pick up interrupted programs
- **Long-running workflows**: Handle programs that exceed context limits
- **Debugging**: Trace through execution history

**Key principle:** Files are inspectable artifacts. The directory structure IS the execution state.

---

## Directory Structure

```
# Project-level state (in working directory)
.prose/
├── .env                              # Config (simple key=value format)
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose             # Copy of running program
│       ├── state.md                  # Execution state with code snippets
│       ├── bindings/
│       │   ├── {name}.md             # Root scope bindings
│       │   └── {name}__{execution_id}.md  # Scoped bindings (block invocations)
│       ├── imports/
│       │   └── {handle}--{slug}/     # Nested program executions (same structure recursively)
│       └── agents/
│           └── {name}/
│               ├── memory.md         # Agent's current state
│               ├── {name}-001.md     # Historical segments (flattened)
│               ├── {name}-002.md
│               └── ...
└── agents/                           # Project-scoped agent memory
    └── {name}/
        ├── memory.md
        ├── {name}-001.md
        └── ...

# User-level state (in home directory)
~/.prose/
└── agents/                           # User-scoped agent memory (cross-project)
    └── {name}/
        ├── memory.md
        ├── {name}-001.md
        └── ...
```

### Run ID Format

Format: `{YYYYMMDD}-{HHMMSS}-{random6}`

Example: `20260115-143052-a7b3c9`

No "run-" prefix needed—the directory name makes context obvious.

### Segment Numbering

Segments use 3-digit zero-padded numbers: `captain-001.md`, `captain-002.md`, etc.

If a program exceeds 999 segments, extend to 4 digits: `captain-1000.md`.

---

## File Formats

### `.prose/.env`

Simple key=value configuration file:

```env
OPENPROSE_TELEMETRY=enabled
USER_ID=user-a7b3c9d4e5f6
SESSION_ID=sess-1704326400000-x9y8z7
```

**Why this format:** Self-evident, no JSON parsing needed, familiar to developers.

---

### `state.md`

The execution state file shows the program's current position using **annotated code snippets**. This makes it self-evident where execution is and what has happened.

**Only the VM writes this file.** Subagents never modify `state.md`.

The format shows:

- **Full history** of executed code with inline annotations
- **Current position** clearly marked with status
- **~5-10 lines ahead** of current position (what's coming next)
- **Index** of all bindings and agents with file paths

````markdown
# Execution State

run: 20260115-143052-a7b3c9
program: feature-implementation.prose
started: 2026-01-15T14:30:52Z
updated: 2026-01-15T14:35:22Z

## Execution Trace

```prose
agent researcher:
  model: sonnet
  prompt: "You research topics thoroughly"

agent captain:
  model: opus
  persist: true
  prompt: "You coordinate and review"

let research = session: researcher           # --> bindings/research.md
  prompt: "Research AI safety"

parallel:
  a = session "Analyze risk A"               # --> bindings/a.md (complete)
  b = session "Analyze risk B"               # <-- EXECUTING

loop until **analysis complete** (max: 3):   # [not yet entered]
  session "Synthesize"
    context: { a, b, research }

resume: captain                              # [...next...]
  prompt: "Review the synthesis"
  context: synthesis
```
````

## Active Constructs

### Parallel (lines 14-16)

- a: complete
- b: executing

### Loop (lines 18-21)

- status: not yet entered
- iteration: 0/3
- condition: **analysis complete**

## Index

### Bindings

| Name     | Kind | Path                     | Execution ID |
| -------- | ---- | ------------------------ | ------------ |
| research | let  | bindings/research.md     | (root)       |
| a        | let  | bindings/a.md            | (root)       |
| result   | let  | bindings/result\_\_43.md | 43           |

### Agents

| Name    | Scope     | Path            |
| ------- | --------- | --------------- |
| captain | execution | agents/captain/ |

## Call Stack

| execution_id | block   | depth | status    |
| ------------ | ------- | ----- | --------- |
| 43           | process | 3     | executing |
| 42           | process | 2     | waiting   |
| 41           | process | 1     | waiting   |

````

**Status annotations:**

| Annotation | Meaning |
|------------|---------|
| `# --> bindings/name.md` | Output written to this file |
| `# <-- EXECUTING` | Currently executing this statement |
| `# (complete)` | Statement finished successfully |
| `# [not yet entered]` | Block not yet reached |
| `# [...next...]` | Coming up next |
| `# <-- RETRYING (attempt 2/3)` | Retry in progress |

---

### `bindings/{name}.md`

All named values (input, output, let, const) are stored as binding files.

```markdown
# research

kind: let

source:
```prose
let research = session: researcher
  prompt: "Research AI safety"
````

---

AI safety research covers several key areas including alignment,
robustness, and interpretability. The field has grown significantly
since 2020 with major contributions from...

````

**Structure:**
- Header with binding name
- `kind:` field indicating type (input, output, let, const)
- `source:` code snippet showing origin
- `---` separator
- Actual value below

**The `kind` field distinguishes:**

| Kind | Meaning |
|------|---------|
| `input` | Value received from caller |
| `output` | Value to return to caller |
| `let` | Mutable variable |
| `const` | Immutable variable |

### Anonymous Session Bindings

Sessions without explicit output capture still produce results:

```prose
session "Analyze the codebase"   # No `let x = ...` capture
````

These get auto-generated names with an `anon_` prefix:

- `bindings/anon_001.md`
- `bindings/anon_002.md`
- etc.

This ensures all session outputs are persisted and inspectable.

---

### Scoped Bindings (Block Invocations)

When a binding is created inside a block invocation, it's scoped to that execution frame to prevent collisions across recursive calls.

**Naming convention:** `{name}__{execution_id}.md`

Examples:

- `bindings/result__43.md` — binding `result` in execution_id 43
- `bindings/parts__44.md` — binding `parts` in execution_id 44

**File format with execution scope:**

````markdown
# result

kind: let
execution_id: 43

source:

```prose
let result = session "Process chunk"
```
````

---

Processed chunk into 3 sub-parts...

```

**Scope resolution:** The VM resolves variable references by checking:
1. `{name}__{current_execution_id}.md`
2. `{name}__{parent_execution_id}.md`
3. Continue up the call stack
4. `{name}.md` (root scope)

The first match wins.

**Example directory for recursive calls:**

```

bindings/
├── data.md # Root scope input
├── result**1.md # First process() invocation
├── parts**1.md # Parts from first invocation
├── result**2.md # Recursive call (depth 2)
├── parts**2.md # Parts from depth 2
├── result\_\_3.md # Recursive call (depth 3)
└── ...

````

---

### Agent Memory Files

#### `agents/{name}/memory.md`

The agent's current accumulated state:

```markdown
# Agent Memory: captain

## Current Understanding

The project is implementing a REST API for user management.
Architecture uses Express + PostgreSQL. Test coverage target is 80%.

## Decisions Made

- 2026-01-15: Approved JWT over session tokens (simpler stateless auth)
- 2026-01-15: Set 80% coverage threshold (balances quality vs velocity)

## Open Concerns

- Rate limiting not yet implemented on login endpoint
- Need to verify OAuth flow works with new token format
````

#### `agents/{name}/{name}-NNN.md` (Segments)

Historical records of each invocation, flattened in the same directory:

```markdown
# Segment 001

timestamp: 2026-01-15T14:32:15Z
prompt: "Review the research findings"

## Summary

- Reviewed: docs from parallel research session
- Found: good coverage of core concepts, missing edge cases
- Decided: proceed with implementation, note gaps for later
- Next: review implementation against identified gaps
```

---

## Who Writes What

| File                          | Written By       |
| ----------------------------- | ---------------- |
| `state.md`                    | VM only          |
| `bindings/{name}.md`          | Subagent         |
| `agents/{name}/memory.md`     | Persistent agent |
| `agents/{name}/{name}-NNN.md` | Persistent agent |

The VM orchestrates; subagents write their own outputs directly to the filesystem. **The VM never holds full binding values—it tracks file paths.**

---

## Subagent Output Writing

When the VM spawns a session, it tells the subagent where to write output.

### For Regular Sessions

````
When you complete this task, write your output to:
  .prose/runs/20260115-143052-a7b3c9/bindings/research.md

Format:
# research

kind: let

source:
```prose
let research = session: researcher
  prompt: "Research AI safety"
````

---

[Your output here]

```

### For Persistent Agents (resume:)

```

Your memory is at:
.prose/runs/20260115-143052-a7b3c9/agents/captain/memory.md

Read it first to understand your prior context. When done, update it
with your compacted state following the guidelines in primitives/session.md.

Also write your segment record to:
.prose/runs/20260115-143052-a7b3c9/agents/captain/captain-003.md

```

### What Subagents Return to the VM

After writing output, the subagent returns a **confirmation message**—not the full content:

**Root scope (outside block invocations):**
```

Binding written: research
Location: .prose/runs/20260115-143052-a7b3c9/bindings/research.md
Summary: AI safety research covering alignment, robustness, and interpretability with 15 citations.

```

**Inside block invocation (include execution_id):**
```

Binding written: result
Location: .prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md
Execution ID: 43
Summary: Processed chunk into 3 sub-parts for recursive processing.

```

The VM records the location and continues. It does NOT read the file—it passes the reference to subsequent sessions that need the context.

---

## Imports Recursive Structure

Imported programs use the **same unified structure recursively**:

```

.prose/runs/{id}/imports/{handle}--{slug}/
├── program.prose
├── state.md
├── bindings/
│ └── {name}.md
├── imports/ # Nested imports go here
│ └── {handle2}--{slug2}/
│ └── ...
└── agents/
└── {name}/

```

This allows unlimited nesting depth while maintaining consistent structure at every level.

---

## Memory Scoping for Persistent Agents

| Scope | Declaration | Path | Lifetime |
|-------|-------------|------|----------|
| Execution (default) | `persist: true` | `.prose/runs/{id}/agents/{name}/` | Dies with run |
| Project | `persist: project` | `.prose/agents/{name}/` | Survives runs in project |
| User | `persist: user` | `~/.prose/agents/{name}/` | Survives across projects |
| Custom | `persist: "path"` | Specified path | User-controlled |

---

## VM Update Protocol

After each statement completes, the VM:

1. **Confirms** subagent wrote its output file(s)
2. **Updates** `state.md` with new position and annotations
3. **Continues** to next statement

The VM never does compaction—that's the subagent's responsibility.

---

## Resuming Execution

If execution is interrupted, resume by:

1. Reading `.prose/runs/{id}/state.md` to find current position
2. Loading all bindings from `bindings/`
3. Continuing from the marked position

The `state.md` file contains everything needed to understand where execution stopped and what has been accomplished.
```
