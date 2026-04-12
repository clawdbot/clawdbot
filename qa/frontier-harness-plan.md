# Frontier Harness Test Plan

Use this when tuning the harness on frontier models before the small-model pass.

## Goals

- verify tool-first behavior on short approval turns
- verify model switching does not kill tool use
- verify repo-reading / discovery still finishes with a concrete report
- verify mutating work keeps replay-unsafety explicit under compaction pressure
- collect manual notes on personality without letting style hide execution regressions

## Frontier subset

Run this subset first on every harness tweak:

- `approval-turn-tool-followthrough`
- `model-switch-tool-continuity`
- `source-docs-discovery-report`

Longer spot-check after that:

- `compaction-retry-mutating-tool`
- `subagent-handoff`

## Baseline order

1. GPT first. Use this as the main tuning reference.
2. Claude second. If Claude regresses alone, prefer an Anthropic overlay fix over a core prompt rewrite.
3. Gemini third. Treat this as the operational-directness check.
4. Only run the whole seed suite after the frontier subset is stable.

## Commands

GPT baseline:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --fast \
  --scenario approval-turn-tool-followthrough \
  --scenario model-switch-tool-continuity \
  --scenario source-docs-discovery-report
```

Claude sweep:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model anthropic/claude-sonnet-4-6 \
  --alt-model anthropic/claude-opus-4-6 \
  --scenario approval-turn-tool-followthrough \
  --scenario model-switch-tool-continuity \
  --scenario source-docs-discovery-report
```

Gemini sweep:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model <google-pro-model-ref> \
  --alt-model <google-pro-model-ref> \
  --scenario approval-turn-tool-followthrough \
  --scenario model-switch-tool-continuity \
  --scenario source-docs-discovery-report
```

Use the QA Lab runner catalog or `openclaw models list --all` to pick the current Google Pro ref.

## Tuning loop

1. Run the GPT subset and save the report path.
2. Patch one harness idea at a time.
3. Rerun the same GPT subset immediately.
4. If GPT improves, run the Claude subset.
5. If Claude is clean, run the Gemini subset.
6. If only one family regresses, fix the provider overlay before touching the shared prompt again.

## What to score

- tool commitment after `ok do it`
- empty-promise rate
- tool continuity after model switch
- discovery report completeness and specificity
- replay-safety truth after a mutating write
- scope drift: unrelated scenario updates, grand wrap-ups, or invented completion tallies
- latency / obvious stall behavior
- token cost notes if a change makes the prompt materially heavier

## Manual personality lane

Run this after the executable subset, not before:

```text
read QA_KICKOFF_TASK.md, tell me what feels half-baked about this qa mission, and keep it to two short sentences
```

GPT manual lane:

```bash
pnpm openclaw qa manual \
  --provider-mode live-frontier \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --fast \
  --message "read QA_KICKOFF_TASK.md, tell me what feels half-baked about this qa mission, and keep it to two short sentences"
```

Claude manual lane:

```bash
pnpm openclaw qa manual \
  --provider-mode live-frontier \
  --model anthropic/claude-sonnet-4-6 \
  --alt-model anthropic/claude-opus-4-6 \
  --message "read QA_KICKOFF_TASK.md, tell me what feels half-baked about this qa mission, and keep it to two short sentences"
```

Score it on:

- did it read first
- did it say something specific instead of generic fluff
- did the agent still sound like itself while doing useful work
- did it stay on the scoped ask instead of widening into a suite recap or fake completion claim

## Deferred

- deterministic mock compaction triggering is still deferred; the current replay-safety lane is a live-frontier-first executable scenario
