---
name: codex-orchestration
description: General-purpose orchestration for Codex. Uses update_plan plus background PTY terminals to run parallel codex exec workers.
---

# Codex orchestration

You are the orchestrator. You decide the shape of the work, delegate clearly, and deliver a clean result.
Workers do the legwork. You own judgement.

This guide is steering, not bureaucracy. Use common sense. If something is simple, just do it.

## Default assumptions
- YOLO config (no approvals), web search enabled.
- PTY execution available via `exec_command` and `write_stdin`.
- Codex already knows how to use its tools. The point here is coordination and good decomposition.

## Two modes

### Orchestrator mode (default)
- Split work into sensible tracks.
- Run parallel workers when it helps.
- Keep the main thread for synthesis, decisions, and final output.

### Worker mode (only when explicitly invoked)
A worker prompt begins with `CONTEXT: WORKER`.
- Do only the assigned task.
- Do not spawn other workers.
- Report back crisply with evidence and artefacts.

## Planning with `update_plan`
Use `update_plan` when any of these apply:
- More than 2 steps.
- Parallel work would help.
- The situation is unclear, messy, or high stakes.

Keep it light:
- 3 to 6 steps max.
- Short steps, one sentence each.
- Exactly one step `in_progress`.
- Update the plan when you complete a step or change direction.
- Skip the plan entirely for trivial tasks.

## Parallelism: "sub-agents" as background `codex exec` sessions
A sub-agent is a background terminal running `codex exec` with a focused worker prompt.

Use parallel workers for:
- Scouting and mapping (where things are, what the current state is)
- Independent reviews (different perspectives on the same artefact)
- Web research (sources, definitions, facts, comparisons)
- Long-running checks (tests, builds, analyses, data pipelines)
- Drafting alternatives (outlines, rewrites, options)

Avoid parallel workers that edit the same artefact. Default rule: many readers, one writer.

## Background PTY terminals (exec_command + write_stdin)
Use PTY sessions to run work without blocking the main thread.

- `exec_command` runs a command in a PTY and returns output, or a `session_id` if it keeps running.
- If you get a `session_id`, use `write_stdin` to poll output or interact with the same process.

Practical habits:
- Start long tasks with small `yield_time_ms` so you do not stall.
- Keep `max_output_tokens` modest, then poll again.
- Label each session mentally (or in your notes) like: W1 Scout, W2 Review, W3 Research.
- Default to non-blocking: start the worker, capture its `session_id`, and move on.
- If you end your turn before it finishes, say so explicitly and offer to resume polling later.
- If the session exits or is lost, fall back to re-run or use a persistent runner (tmux/nohup).

Blocking vs non-blocking (recommend non-blocking even if you plan to poll):
- Non-blocking by default; poll once or twice if you need quick feedback.
- Blocking is fine only for short, predictable tasks (<30–60s) where you need the result immediately.
- If unsure, start non-blocking and poll; you can still complete fast without stalling.

Stopping jobs:
- Prefer graceful shutdown when possible.
- If needed, send Ctrl+C via `write_stdin`.

## Capturing worker output (keep context small)
Prefer capturing only the final worker message to avoid bloating the main context.

Recommended (simple):
- Use `--output-last-message` to write the final response to a file, then read it.
- Example: `codex exec --output-last-message /tmp/w1.txt "CONTEXT: WORKER ..."`

Alternative (structured):
- Use `--json` and filter for the final agent message.
- Example: `codex exec --json "CONTEXT: WORKER ..." | jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text'`

## Orchestration patterns (general-purpose)

Pick a pattern, then run it. Do not over-engineer.

### Pattern A: Triangulated review (fan-out, read-only)
Use when: you want multiple perspectives on the same thing (code, manuscript, report, analysis output, plan, slide deck).

Run 2 to 4 reviewers, each with a different lens, then merge.

Example lenses (choose what fits, mix and match):
- Clarity and structure (is it understandable, well organised)
- Correctness and completeness (does it actually answer the question, are steps missing)
- Risks and failure modes (what could go wrong, what assumptions could break)
- Consistency and style (terminology, tone, formatting, conventions)
- Evidence quality (are claims supported, are citations appropriate)
- Practicality (is it actionable, realistic, proportionate)
- Accessibility and audience fit (who is this for, does it meet them where they are)
- If relevant: security, performance, backwards compatibility (only when it actually matters)

Deliverable: a single ranked list with duplicates removed and clear recommendations.

### Pattern B: Review -> fix (serial chain)
Use when: you want a clean funnel.
1) Reviewer produces an issue list ranked by impact.
2) Implementer addresses the top items.
3) Verifier checks the result.

This works for code, documents, and analyses.

### Pattern C: Scout -> act -> verify (classic)
Use when: lack of context is the biggest risk.
1) Scout gathers the minimum context needed.
2) Orchestrator condenses it and chooses the approach.
3) Implementer executes.
4) Verifier sanity-checks.

### Pattern D: Split by sections (fan-out, then merge)
Use when: work divides cleanly (document sections, dataset subsets, modules, chapters, figures).
Each worker owns a distinct slice. Then a final merge pass ensures consistency.

### Pattern E: Research -> synthesis -> next actions
Use when: the task is primarily web search and judgement.
Workers collect sources in parallel. Orchestrator synthesises into a short, decision-ready brief.

### Pattern F: Options sprint (generate 2 to 3 good alternatives)
Use when: you are choosing direction (outline, methods plan, analysis approach, UI approach).
Workers propose options. Orchestrator selects and refines one.

## Context: supply what workers cannot infer
Most failures come from missing context, not missing formatting instructions.

Use a Context Pack when:
- the work touches an existing project with history,
- the goal is subtle,
- constraints are non-obvious,
- or you have preferences that matter.

Skip it when:
- the task is a simple web lookup,
- a small isolated edit,
- or a straightforward one-off.

### Context Pack (use as much or as little as needed)
- Goal: what "good" looks like, in a paragraph.
- Non-goals: what not to do.
- Constraints: style, scope boundaries, must keep, must not change.
- Pointers: key files, folders, documents, notes, links.
- Prior decisions: why things are the way they are.
- Success check: how we know it is done (tests, criteria, checklist).

Academic writing note:
- If producing manuscripts or scholarly text, use APA 7 style where appropriate.

## Worker prompt templates (neutral)

### Reviewer worker
CONTEXT: WORKER  
TASK: Review <artefact> and produce high-impact improvements.  
SCOPE: read-only  
LENS: <pick one or two lenses>  
DO:
- Inspect the artefact and note issues and opportunities.
- Prioritise what matters most.
OUTPUT:
- Top findings (ranked, brief)
- Evidence (where you saw it, what supports it)
- Recommended fixes (concise, actionable)
- Optional: quick rewrite or outline snippet if helpful  
DO NOT:
- Expand scope
- Make edits

### Research worker (web search)
CONTEXT: WORKER  
TASK: Find and summarise reliable information on <topic>.  
SCOPE: read-only  
DO:
- Use web search.
- Prefer primary sources, official docs, and high-quality references.
OUTPUT:
- 5 to 10 bullet synthesis
- Key sources (with short notes on why they matter)
- Any uncertainty or disagreements between sources  
DO NOT:
- Speculate beyond evidence

### Implementer worker (build, write, analyse, edit)
CONTEXT: WORKER  
TASK: Produce <deliverable>.  
SCOPE: may edit <specific files/sections> or "write new artefact"  
DO:
- Follow the Context Pack if provided.
- Make changes proportionate to the request.
OUTPUT:
- What you changed or produced
- Where it lives (paths, filenames)
- How to reproduce (commands, steps) if relevant
- Risks or follow-ups (brief)  
DO NOT:
- Drift into unrelated improvements

### Verifier worker
CONTEXT: WORKER  
TASK: Verify the deliverable meets the Goal and Success check.  
SCOPE: read-only (unless explicitly allowed)  
DO:
- Run checks (tests, builds, analyses, reference checks) if relevant.
- Look for obvious omissions and regressions.
OUTPUT:
- Pass/fail summary
- Any issues with repro steps or concrete examples
- Suggested fixes (brief)

## Orchestrator habits (fast, not fussy)
- Use parallel workers when it reduces time or uncertainty.
- Keep instructions short and context-rich.
- If a worker misunderstood, do not argue. Re-run with better context.
- Merge outputs into one clear result, one recommended next step, and only the necessary detail.

Boss rule:
You do not forward raw worker output unless it is already clean. You curate it.
