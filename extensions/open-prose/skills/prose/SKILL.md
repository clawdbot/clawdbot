---
name: prose
description: OpenProse VM skill pack. Activate on any `prose` command, .prose files, or OpenProse mentions; orchestrates multi-agent workflows.
metadata: { "openclaw": { "emoji": "🪶", "homepage": "https://www.prose.md" } }
---

# OpenProse Skill

OpenProse is a programming language for AI sessions. LLMs are simulators—when given a detailed system description, they don't just describe it, they _simulate_ it. The `prose.md` specification describes a virtual machine with enough fidelity that a Prose Complete system reading it _becomes_ that VM. Simulation with sufficient fidelity is implementation. **You are the Prose Complete system.**

## OpenClaw Runtime Mapping

- **Task tool** in the upstream spec == OpenClaw `sessions_spawn`
- **File I/O** == OpenClaw `read`/`write`
- **Remote fetch** == OpenClaw `web_fetch` (or `exec` with curl when POST is required)

## When to Activate

Activate this skill when the user:

- **Uses ANY `prose` command** (e.g., `prose boot`, `prose run`, `prose compile`, `prose update`, `prose help`, etc.)
- Asks to run a `.prose` file
- Mentions "OpenProse" or "prose program"
- Wants to orchestrate multiple AI agents from a script
- Has a file with `session "..."` or `agent name:` syntax
- Wants to create a reusable workflow

## Command Routing

When a user invokes `prose <command>`, intelligently route based on intent:

| Command                 | Action                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `prose help`            | Load `help.md`, guide user to what they need                  |
| `prose run <file>`      | Load VM (`prose.md` + state backend), execute the program     |
| `prose run handle/slug` | Fetch from registry, then execute (see Remote Programs below) |
| `prose compile <file>`  | Load `compiler.md`, validate the program                      |
| `prose update`          | Run migration (see Migration section below)                   |
| `prose examples`        | Show or run example programs from `examples/`                 |
| Other                   | Intelligently interpret based on context                      |

### Important: Single Skill

There is only ONE skill: `open-prose`. There are NO separate skills like `prose-run`, `prose-compile`, or `prose-boot`. All `prose` commands route through this single skill.

### Resolving Example References

**Examples are bundled in `examples/` (same directory as this file).** When users reference examples by name (e.g., "run the gastown example"):

1. Read `examples/` to list available files
2. Match by partial name, keyword, or number
3. Run with: `prose run examples/28-gas-town.prose`

**Common examples by keyword:**
| Keyword | File |
|---------|------|
| hello, hello world | `examples/01-hello-world.prose` |
| gas town, gastown | `examples/28-gas-town.prose` |
| captain, chair | `examples/29-captains-chair.prose` |
| forge, browser | `examples/37-the-forge.prose` |
| parallel | `examples/16-parallel-reviews.prose` |
| pipeline | `examples/21-pipeline-operations.prose` |
| error, retry | `examples/22-error-handling.prose` |

### Remote Programs

You can run any `.prose` program from a URL or registry reference:

```bash
# Direct URL — any fetchable URL works
prose run https://raw.githubusercontent.com/openprose/prose/main/skills/open-prose/examples/48-habit-miner.prose

# Registry shorthand — handle/slug resolves to p.prose.md
prose run irl-danb/habit-miner
prose run alice/code-review
```

**Resolution rules:**

| Input                               | Resolution                             |
| ----------------------------------- | -------------------------------------- |
| Starts with `http://` or `https://` | Fetch directly from URL                |
| Contains `/` but no protocol        | Resolve to `https://p.prose.md/{path}` |
| Otherwise                           | Treat as local file path               |

**Steps for remote programs:**

1. Apply resolution rules above
2. Fetch the `.prose` content
3. Load the VM and execute as normal

This same resolution applies to `use` statements inside `.prose` files:

```prose
use "https://example.com/my-program.prose"  # Direct URL
use "alice/research" as research             # Registry shorthand
```

---

## File Locations

**Do NOT search for OpenProse documentation files.** All skill files are co-located with this SKILL.md file:

| File                       | Location                    | Purpose                                        |
| -------------------------- | --------------------------- | ---------------------------------------------- |
| `prose.md`                 | Same directory as this file | VM semantics (load to run programs)            |
| `help.md`                  | Same directory as this file | Help, FAQs, onboarding (load for `prose help`) |
| `state/filesystem.md`      | Same directory as this file | File-based state (default, load with VM)       |
| `state/in-context.md`      | Same directory as this file | In-context state (on request)                  |
| `state/sqlite.md`          | Same directory as this file | SQLite state (experimental, on request)        |
| `state/postgres.md`        | Same directory as this file | PostgreSQL state (experimental, on request)    |
| `compiler.md`              | Same directory as this file | Compiler/validator (load only on request)      |
| `guidance/patterns.md`     | Same directory as this file | Best practices (load when writing .prose)      |
| `guidance/antipatterns.md` | Same directory as this file | What to avoid (load when writing .prose)       |
| `examples/`                | Same directory as this file | 37 example programs                            |

**User workspace files** (these ARE in the user's project):

| File/Directory   | Location                 | Purpose                           |
| ---------------- | ------------------------ | --------------------------------- |
| `.prose/.env`    | User's working directory | Config (key=value format)         |
| `.prose/runs/`   | User's working directory | Runtime state for file-based mode |
| `.prose/agents/` | User's working directory | Project-scoped persistent agents  |
| `*.prose` files  | User's project           | User-created programs to execute  |

**User-level files** (in user's home directory, shared across all projects):

| File/Directory     | Location        | Purpose                                       |
| ------------------ | --------------- | --------------------------------------------- |
| `~/.prose/agents/` | User's home dir | User-scoped persistent agents (cross-project) |

When you need to read `prose.md` or `compiler.md`, read them from the same directory where you found this SKILL.md file. Never search the user's workspace for these files.

---

## Core Documentation

| File                       | Purpose                         | When to Load                                                          |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `prose.md`                 | VM / Interpreter                | Always load to run programs                                           |
| `state/filesystem.md`      | File-based state                | Load with VM (default)                                                |
| `state/in-context.md`      | In-context state                | Only if user requests `--in-context` or says "use in-context state"   |
| `state/sqlite.md`          | SQLite state (experimental)     | Only if user requests `--state=sqlite` (requires sqlite3 CLI)         |
| `state/postgres.md`        | PostgreSQL state (experimental) | Only if user requests `--state=postgres` (requires psql + PostgreSQL) |
| `compiler.md`              | Compiler / Validator            | **Only** when user asks to compile or validate                        |
| `guidance/patterns.md`     | Best practices                  | Load when **writing** new .prose files                                |
| `guidance/antipatterns.md` | What to avoid                   | Load when **writing** new .prose files                                |

### Authoring Guidance

When the user asks you to **write or create** a new `.prose` file, load the guidance files:

- `guidance/patterns.md` — Proven patterns for robust, efficient programs
- `guidance/antipatterns.md` — Common mistakes to avoid

Do **not** load these when running or compiling—they're for authoring only.

### State Modes

OpenProse supports three state management approaches:

| Mode                        | When to Use                                                       | State Location              |
| --------------------------- | ----------------------------------------------------------------- | --------------------------- |
| **filesystem** (default)    | Complex programs, resumption needed, debugging                    | `.prose/runs/{id}/` files   |
| **in-context**              | Simple programs (<30 statements), no persistence needed           | Conversation history        |
| **sqlite** (experimental)   | Queryable state, atomic transactions, flexible schema             | `.prose/runs/{id}/state.db` |
| **postgres** (experimental) | True concurrent writes, external integrations, team collaboration | PostgreSQL database         |

**Default behavior:** When loading `prose.md`, also load `state/filesystem.md`. This is the recommended mode for most programs.

**Switching modes:** If the user says "use in-context state" or passes `--in-context`, load `state/in-context.md` instead.

**Experimental SQLite mode:** If the user passes `--state=sqlite` or says "use sqlite state", load `state/sqlite.md`. This mode requires `sqlite3` CLI to be installed (pre-installed on macOS, available via package managers on Linux/Windows). If `sqlite3` is unavailable, warn the user and fall back to filesystem state.

**Experimental PostgreSQL mode:** If the user passes `--state=postgres` or says "use postgres state":

**⚠️ Security Note:** Database credentials in `OPENPROSE_POSTGRES_URL` are passed to subagent sessions and visible in logs. Advise users to use a dedicated database with limited-privilege credentials. See `state/postgres.md` for secure setup guidance.

1. **Check for connection configuration first:**

   ```bash
   # Check .prose/.env for OPENPROSE_POSTGRES_URL
   cat .prose/.env 2>/dev/null | grep OPENPROSE_POSTGRES_URL
   # Or check environment variable
   echo $OPENPROSE_POSTGRES_URL
   ```

2. **If connection string exists, verify connectivity:**

   ```bash
   psql "$OPENPROSE_POSTGRES_URL" -c "SELECT 1" 2>&1
   ```

3. **If not configured or connection fails, advise the user:**

   ```
   ⚠️  PostgreSQL state requires a connection URL.

   To configure:
   1. Set up a PostgreSQL database (Docker, local, or cloud)
   2. Add connection string to .prose/.env:

      echo "OPENPROSE_POSTGRES_URL=postgresql://user:pass@localhost:5432/prose" >> .prose/.env

   Quick Docker setup:
      docker run -d --name prose-pg -e POSTGRES_DB=prose -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16
      echo "OPENPROSE_POSTGRES_URL=postgresql://postgres@localhost:5432/prose" >> .prose/.env

   See state/postgres.md for detailed setup options.
   ```

4. **Only after successful connection check, load `state/postgres.md`**

This mode requires both `psql` CLI and a running PostgreSQL server. If either is unavailable, warn and offer fallback to filesystem state.

**Context warning:** `compiler.md` is large. Only load it when the user explicitly requests compilation or validation. After compiling, recommend `/compact` or a new session before running—don't keep both docs in context.

## Examples

The `examples/` directory contains 37 example programs:

- **01-08**: Basics (hello world, research, code review, debugging)
- **09-12**: Agents and skills
- **13-15**: Variables and composition
- **16-19**: Parallel execution
- **20-21**: Loops and pipelines
- **22-23**: Error handling
- **24-27**: Advanced (choice, conditionals, blocks, interpolation)
- **28**: Gas Town (multi-agent orchestration)
- **29-31**: Captain's chair pattern (persistent orchestrator)
- **33-36**: Production workflows (PR auto-fix, content pipeline, feature factory, bug hunter)
- **37**: The Forge (build a browser from scratch)

Start with `01-hello-world.prose` or try `37-the-forge.prose` to watch AI build a web browser.

## Execution

When first invoking the OpenProse VM in a session, display this banner:

```
┌─────────────────────────────────────┐
│         ◇ OpenProse VM ◇            │
│       A new kind of computer        │
└─────────────────────────────────────┘
```

To execute a `.prose` file, you become the OpenProse VM:

1. **Read `prose.md`** — this document defines how you embody the VM
2. **You ARE the VM** — your conversation is its memory, your tools are its instructions
3. **Spawn sessions** — each `session` statement triggers a Task tool call
4. **Narrate state** — use the narration protocol to track execution ([Position], [Binding], [Success], etc.)
5. **Evaluate intelligently** — `**...**` markers require your judgment

## Help & FAQs

For syntax reference, FAQs, and getting started guidance, load `help.md`.

---

## Migration (`prose update`)

When a user invokes `prose update`, check for legacy file structures and migrate them to the current format.

### Legacy Paths to Check

| Legacy Path         | Current Path   | Notes                            |
| ------------------- | -------------- | -------------------------------- |
| `.prose/state.json` | `.prose/.env`  | Convert JSON to key=value format |
| `.prose/execution/` | `.prose/runs/` | Rename directory                 |

### Migration Steps

1. **Check for `.prose/state.json`**
   - If exists, read the JSON content
   - Convert to `.env` format:
     ```json
     { "OPENPROSE_TELEMETRY": "enabled", "USER_ID": "user-xxx", "SESSION_ID": "sess-xxx" }
     ```
     becomes:
     ```env
     OPENPROSE_TELEMETRY=enabled
     USER_ID=user-xxx
     SESSION_ID=sess-xxx
     ```
   - Write to `.prose/.env`
   - Delete `.prose/state.json`

2. **Check for `.prose/execution/`**
   - If exists, rename to `.prose/runs/`
   - The internal structure of run directories may also have changed; migration of individual run state is best-effort

3. **Create `.prose/agents/` if missing**
   - This is a new directory for project-scoped persistent agents

### Migration Output

```
🔄 Migrating OpenProse workspace...
  ✓ Converted .prose/state.json → .prose/.env
  ✓ Renamed .prose/execution/ → .prose/runs/
  ✓ Created .prose/agents/
✅ Migration complete. Your workspace is up to date.
```

If no legacy files are found:

```
✅ Workspace already up to date. No migration needed.
```

### Skill File References (for maintainers)

These documentation files were renamed in the skill itself (not user workspace):

| Legacy Name       | Current Name               |
| ----------------- | -------------------------- |
| `docs.md`         | `compiler.md`              |
| `patterns.md`     | `guidance/patterns.md`     |
| `antipatterns.md` | `guidance/antipatterns.md` |

If you encounter references to the old names in user prompts or external docs, map them to the current paths.
