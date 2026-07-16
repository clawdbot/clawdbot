# OpenProse Standard Library

Core programs that ship with OpenProse. Production-quality, well-tested programs for common tasks.

## Programs

### Evaluation & Improvement

| Program                  | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `inspector.prose`        | Post-run analysis for runtime fidelity and task effectiveness  |
| `vm-improver.prose`      | Analyzes inspections and proposes PRs to improve the VM        |
| `program-improver.prose` | Analyzes inspections and proposes PRs to improve .prose source |
| `cost-analyzer.prose`    | Token usage and cost pattern analysis                          |
| `calibrator.prose`       | Validates light evaluations against deep evaluations           |
| `error-forensics.prose`  | Root cause analysis for failed runs                            |

### Memory

| Program                | Description                              |
| ---------------------- | ---------------------------------------- |
| `user-memory.prose`    | Cross-project persistent personal memory |
| `project-memory.prose` | Project-scoped institutional memory      |

## The Improvement Loop

The evaluation programs form a recursive improvement cycle:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Run Program  ──►  Inspector  ──►  VM Improver ──► PR     │
│        ▲                │                                   │
│        │                ▼                                   │
│        │         Program Improver ──► PR                    │
│        │                │                                   │
│        └────────────────┘                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Supporting analysis:

- **cost-analyzer** — Where does the money go? Optimization opportunities.
- **calibrator** — Are cheap evaluations reliable proxies for expensive ones?
- **error-forensics** — Why did a run fail? Root cause analysis.

## Usage

```bash
# Inspect a completed run
prose run lib/inspector.prose
# Inputs: run_path, depth (light|deep), target (vm|task|all)

# Propose VM improvements
prose run lib/vm-improver.prose
# Inputs: inspection_path, prose_repo

# Propose program improvements
prose run lib/program-improver.prose
# Inputs: inspection_path, run_path

# Analyze costs
prose run lib/cost-analyzer.prose
# Inputs: run_path, scope (single|compare|trend)

# Validate light vs deep evaluation
prose run lib/calibrator.prose
# Inputs: run_paths, sample_size

# Investigate failures
prose run lib/error-forensics.prose
# Inputs: run_path, focus (vm|program|context|external)

# Memory programs (recommend sqlite+ backend)
prose run lib/user-memory.prose --backend sqlite+
# Inputs: mode (teach|query|reflect), content

prose run lib/project-memory.prose --backend sqlite+
# Inputs: mode (ingest|query|update|summarize), content
```

## Memory Programs

The memory programs use persistent agents to accumulate knowledge:

**user-memory** (`persist: user`)

- Learns your preferences, decisions, patterns across all projects
- Remembers mistakes and lessons learned
- Answers questions from accumulated knowledge

**project-memory** (`persist: project`)

- Understands this project's architecture and decisions
- Tracks why things are the way they are
- Answers questions with project-specific context

Both recommend `--backend sqlite+` for durable persistence.

## Design Principles

1. **Production-ready** — Tested, documented, handles edge cases
2. **Composable** — Can be imported via `use` in other programs
3. **User-scoped state** — Cross-project utilities use `persist: user`
4. **Minimal dependencies** — No external services required
5. **Clear contracts** — Well-defined inputs and outputs
6. **Incremental value** — Useful in simple mode, more powerful with depth
