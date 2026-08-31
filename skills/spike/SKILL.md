---
name: spike
description: Run throwaway prototypes to validate feasibility, compare approaches, and report a verdict.
metadata: { "openclaw": { "emoji": "🧪" } }
---

# Spike

Use when the user wants to test an idea before committing to a real build: "spike this", "quick prototype", "is this possible", "compare A/B", "before we build".

Do not use when reading docs/code can answer the question, or when the user clearly asked for production implementation.

Loop

1. Question: state the concrete feasibility question.
2. Research: read enough docs/source to choose credible approach.
3. Build: create the smallest runnable artifact that validates or invalidates the idea.
4. Stress: try one edge case or failure mode.
5. Verdict: `VALIDATED`, `PARTIAL`, or `INVALIDATED`.

Output shape

- Default workspace: `.tmp/openclaw-spikes/<slug>` unless user asks for a tracked repo-local path.
- Repo-local option: `spikes/<NNN-slug>/` with `README.md` and minimal code.
- Prefer runnable CLI, tiny HTML, one endpoint, or focused test.
- Avoid package sprawl, Docker, env files, app frameworks, and production cleanup.

Multi-spike ideas

- Split into 2-5 independent questions.
- Run the riskiest question first.
- For A/B comparisons, keep inputs equal and measure the same dimensions.
- Ask before building all variants if the work is more than a small prototype.

Verdict format

```markdown
## Verdict: VALIDATED | PARTIAL | INVALIDATED

Question: ...
Evidence: exact command/output/measurement.
What worked: ...
What failed or surprised us: ...
Recommendation: ship / adjust / avoid, with the next production step.
```

Rules

- An invalidated spike is useful when it rules out a path with evidence.
- Do not merge spike code into production without rewriting it normally.
- If external dependencies are evaluated, check health: recent release/commit, docs, license, install friction.
