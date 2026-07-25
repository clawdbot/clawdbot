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
7. **Execution Engine** — bounded provider execution with ordered, policy-compliant fallback.
8. **Gateway Boundary** — typed operator requests delivered to the execution engine through the `ai.execute` RPC.

## Operating principles

- Local-first for private property, asset, household, and personal records.
- Cloud models may be used for approved nonprivate, difficult engineering work.
- Scores remain provisional until supported by benchmark evidence.
- No model is promoted solely from marketing claims or public hype.
- A human reviews production-routing changes.
- The router must always provide a fallback.
- Runtime entry points must validate requests and responses at trust boundaries.
- Runtime AI execution must fail closed and remain disabled until explicitly enabled for an approved environment.
- Detailed provider and database errors belong in protected operational logs, not client responses.

## Runtime architecture

The OpenClaw Gateway is the control-plane entry point for AI Intelligence execution. Authorized operators submit a typed `ai.execute` request. The Gateway validates the request, invokes the database-backed execution engine through a bounded process bridge, validates the result, and returns the selected model and ordered attempt history.

```text
Authorized operator
        |
        | ai.execute (operator.write)
        v
OpenClaw Gateway
        |
        | bounded JSON process bridge
        v
AI Execution Engine
        |
        +--> AI Intelligence database
        |
        +--> primary model --> approved fallbacks
```

This boundary is additive. It does not replace the existing agent, chat, or channel message pipelines. Components must migrate deliberately after development verification.

The Gateway integration is disabled by default. An approved environment enables it with:

```text
OPENCLAW_AI_INTELLIGENCE_GATEWAY_ENABLED=1
```

The bridge has a bounded timeout and output limit. Client-facing failures are normalized, while operational details remain in Gateway logs. Database credentials are loaded from the runtime environment or the protected AI Intelligence credentials file; they are never accepted from an RPC caller.

## Implementation status

Phase 2F.4G is merged into the `development` branch:

- database-backed execution engine and ordered fallback are implemented;
- constructor and configuration validation are implemented;
- the typed `ai.execute` Gateway boundary is implemented;
- focused Gateway, TypeScript, and AI Intelligence tests pass in the development VM;
- the Gateway boundary remains disabled pending explicit development activation;
- production has not been activated by this integration.

## Kimi K3 decision

Kimi K3 is registered as an evaluation candidate, not a production default. Its likely strengths are long context, repository comprehension, and code generation. It must complete the OpenClaw benchmark suite before promotion.

## Next implementation phase

Activate `ai.execute` in the development Gateway, demonstrate primary failure followed by approved fallback success through the real Gateway boundary, and verify sanitized logging. After that proof, add usage and failover telemetry and expose the scorecard in the RanchBrain dashboard. Production promotion requires a separate checkpoint and rollback plan.
