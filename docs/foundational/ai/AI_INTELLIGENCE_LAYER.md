# RanchBrain AI Intelligence Layer

## Purpose

The AI Intelligence Layer selects the most appropriate model for each OpenClaw task while protecting private ranch data, controlling cost, and requiring benchmark evidence before model promotion.

## Components

1. **Model Registry** — known models, deployment, privacy, cost, and operational status.
2. **Model Scorecard** — weighted OpenClaw-specific capability ratings.
3. **Routing Policy** — task-specific preferred and fallback models.
4. **Benchmark Suite** — repeatable tests for engineering, safety, and reliability.
5. **Technology Watch** — candidates such as Kimi K3 that should be evaluated.
6. **Recommendation Engine** — deterministic first-stage model selection.

## Operating principles

- Local-first for private property, asset, household, and personal records.
- Cloud models may be used for approved nonprivate, difficult engineering work.
- Scores remain provisional until supported by benchmark evidence.
- No model is promoted solely from marketing claims or public hype.
- A human reviews production-routing changes.
- The router must always provide a fallback.

## Kimi K3 decision

Kimi K3 is registered as an evaluation candidate, not a production default. Its likely strengths are long context, repository comprehension, and code generation. It must complete the OpenClaw benchmark suite before promotion.

## Next implementation phase

Connect the deterministic recommendation engine to the OpenClaw request router. Add benchmark result storage in PostgreSQL and expose the scorecard in the RanchBrain dashboard.
