# Sprint 003 – Multi-Profile Indexing

## Objective

Enable RanchBrain to maintain multiple searchable indexes optimized for different kinds of questions.

## Profiles

### knowledge (default)

Purpose:
Personal knowledge and operational memory.

Includes:

- memories/
- notes/
- documents/
- manuals/
- modules/
- reports/

Excludes:

- logs/
- index/
- \_archive/
- scripts/
- src/
- tests/
- docs/
- .venv/
- **pycache**/

Typical questions:

- When did I replace the pool pump?
- What happened with Time Machine?
- Show my maintenance history.

---

### code

Purpose:
Developer-oriented source code search.

Includes:

- ranchbrain_app/
- OpenClaw source
- scripts/
- tests/
- docs/

Excludes:

- logs/
- index/
- .venv/
- **pycache**/

Typical questions:

- Where is duplicate detection implemented?
- Show the MemoryResult class.
- Which file builds the JSON index?

---

### all

Purpose:
Complete repository search.

Indexes everything except:

- logs/
- generated indexes
- \_archive/
- .venv/
- **pycache**/

## Sprint Goal

Implement profile-aware indexing while preserving the existing CLI.

Status: Sprint 003 Started
