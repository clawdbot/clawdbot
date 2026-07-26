# Phase 2F — Runtime AI Router Architecture

**Status:** Implementation complete; Gateway activation proved; usage/failover telemetry implemented
**Project:** OpenClaw AI Intelligence Layer  
**Environment:** Development first  
**Core requirement:** Automatic failover is mandatory

## 1. Purpose

The Runtime AI Router is the single authoritative service responsible for selecting AI models for OpenClaw components and executing requests through an ordered, policy-compliant failover chain.

It eliminates hard-coded model selections and provides RanchBrain, PropertyManager, Home Assistant, Telegram Ranch Bot, engineering tools, and future OpenClaw components with one consistent routing interface.

## 2. Required Outcomes

The router must:

- Read configured deployments from PostgreSQL.
- Enforce privacy and routing policies.
- Select the configured primary model.
- Verify model and provider availability.
- Automatically attempt approved fallback models when necessary.
- Preserve fallback priority order.
- Record routing attempts and failover events.
- Return a structured failure only after all approved models are exhausted.
- Avoid hard-coded model identifiers in application components.
- Operate in the development environment before production deployment.

## 3. Architecture

```text
RanchBrain ───────────────┐
PropertyManager ──────────┤
Home Assistant ───────────┤
Telegram Ranch Bot ───────┤
Engineering Tools ────────┤
Future Components ────────┘
                          │
                          ▼
                 Runtime AI Router
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
  AI Intelligence Database      Provider Health Checks
             │                         │
             ▼                         ▼
 current_model_deployment    Ollama / approved cloud APIs
             │
             ▼
 Primary → Fallback 1 → Fallback 2
```

## 4. Design Principles

### 4.1 Database-driven

Configured model assignments come from:

```text
ai_intelligence.current_model_deployment
```

OpenClaw components must not independently define primary or fallback model names.

### 4.2 Privacy-first

Local-only data must never be sent to a cloud model.

The router must reject any candidate model whose deployment or provider violates the component's privacy requirements.

Privacy enforcement applies to both primary models and every fallback.

### 4.3 Deterministic routing

For an unchanged configuration and health state, the router must return the same ordered candidate chain.

Fallback priority must be preserved exactly as configured.

### 4.4 Fail closed

The router must not silently bypass privacy, deployment, or production-safety rules merely because an approved model is unavailable.

### 4.5 Observable behavior

Selection, execution, failure, and failover decisions must be recordable for operational review and future model evaluation.

## 5. Public Interface

The internal Python interface uses the execution engine and routing request contract.

```python
router = AIRouter()

result = router.execute(
    component_id="property_manager",
    task_type="private_property_data",
    request=payload,
)
```

A routing plan may also be requested without execution:

```python
decision = router.route(
    component_id="property_manager",
    task_type="private_property_data",
)
```

The first OpenClaw control-plane integration is the typed Gateway RPC:

```json
{
  "method": "ai.execute",
  "params": {
    "componentId": "telegram_ranch_bot",
    "prompt": "Summarize the current ranch status.",
    "requestId": "example-request",
    "timeoutSeconds": 60
  }
}
```

The method requires `operator.write` scope. The Gateway validates both the request and bridge response. It invokes the Python engine through a single-request JSON process boundary rather than importing the Python runtime into the Node.js process.

The boundary is disabled unless the Gateway process has:

```text
OPENCLAW_AI_INTELLIGENCE_GATEWAY_ENABLED=1
```

Runtime controls include:

- a request timeout range of 0.1 to 300 seconds;
- an execution grace period before forced process termination;
- a combined standard-output and standard-error limit of 1 MiB;
- generic client errors with detailed failures restricted to Gateway logs;
- database credentials sourced only from the runtime environment or protected credentials file;
- response-schema validation before data is returned to the caller.

## 6. Routing Decision Contract

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class ModelCandidate:
    model_id: str
    assignment_type: str
    priority: int
    provider: str
    deployment: str

@dataclass(frozen=True)
class RoutingDecision:
    component_id: str
    task_type: str
    routing_mode: str
    privacy_tier: str
    candidates: list[ModelCandidate] = field(default_factory=list)
```

The first candidate is the configured primary. Remaining candidates are ordered fallbacks.

## 7. Mandatory Automatic Failover

Automatic failover is part of Phase 2F and is not deferred work.

For every execution request, the router must:

1. Load the approved candidate chain.
2. Remove candidates prohibited by privacy or routing policy.
3. Check the primary model's provider and model availability.
4. Attempt the primary model when healthy.
5. Detect retryable failures such as:
   - provider unavailable;
   - connection failure;
   - configured timeout;
   - model not installed or not loaded;
   - transient provider error;
   - temporary rate limiting where another approved provider is available.
6. Record the failed attempt.
7. Attempt the next approved fallback automatically.
8. Continue in configured priority order.
9. Return the first successful response.
10. Raise a structured `FallbackExhaustedError` only after every approved candidate fails or is unavailable.

The router must not repeatedly retry the same failed candidate within one execution cycle.

## 8. Failover Safety Rules

Automatic failover must never:

- Send local-only data to a cloud provider.
- Select an evaluation-only model in production-safe mode.
- Use a disabled or retired model.
- Invent an unconfigured fallback.
- Change fallback order.
- Hide the fact that failover occurred.
- Retry indefinitely.

Cloud fallback is allowed only when both component policy and routing policy explicitly permit it.

## 9. Health and Availability Checks

Provider-specific adapters will implement lightweight checks.

Examples include:

- PostgreSQL connectivity.
- Ollama API responsiveness.
- Required local model presence.
- Cloud provider configuration availability.
- Request timeout enforcement.
- Temporary provider cooldown after repeated failures.

Health checks should be inexpensive and bounded by short timeouts.

A successful health check does not guarantee inference success; execution failures must still trigger failover when classified as retryable.

## 10. Failure Classification

Failures must be classified rather than treated identically.

### Retryable

- Connection refused.
- Provider timeout.
- Temporary server error.
- Model temporarily unavailable.
- Rate limiting when another approved model exists.

### Non-retryable for the current request

- Invalid input.
- Authentication policy violation.
- Privacy-policy violation.
- Unsupported request format.
- Caller cancellation.

Non-retryable request errors should not be sent repeatedly to fallback models unless an adapter explicitly determines that another candidate can validly handle the request.

## 11. Structured Errors

Initial exception types:

```text
AIRouterError
ConfigurationError
DatabaseUnavailableError
UnknownComponentError
NoApprovedCandidateError
ProviderUnavailableError
ModelExecutionError
FallbackExhaustedError
PrivacyPolicyError
```

`FallbackExhaustedError` should include a sanitized summary of attempted models and failure categories.

Secrets, request contents, API keys, and sensitive property data must not be included in error messages.

## 12. Usage and Failover Recording

Each routing execution should eventually record:

- Timestamp.
- Component ID.
- Task type.
- Routing mode.
- Candidate model.
- Attempt number.
- Whether the candidate was primary or fallback.
- Health-check outcome.
- Execution outcome.
- Failure category.
- Latency.
- Token usage when available.
- Estimated cost when available.
- Whether failover occurred.
- Final selected model.

Telemetry failure must not prevent a valid model response from being returned.

## 13. Health Interface

The router should expose a health summary suitable for the OpenClaw dashboard and Daily Executive Briefing.

Example:

```json
{
  "status": "healthy",
  "database": "healthy",
  "routing_mode": "production-safe",
  "components_configured": 10,
  "active_assignments": 22,
  "providers_available": 2,
  "providers_unavailable": 0
}
```

## 14. Database Interaction

The initial router reads configured candidates from:

```sql
SELECT
    component_id,
    assignment_type,
    priority,
    model_id,
    routing_mode,
    assignment_status
FROM ai_intelligence.current_model_deployment
WHERE component_id = %s
ORDER BY
    CASE assignment_type
        WHEN 'primary' THEN 0
        ELSE 1
    END,
    priority;
```

Additional model metadata may be joined from the model registry tables when required for provider, deployment, privacy, or status enforcement.

Database queries must be parameterized.

## 15. Initial File Layout

```text
tools/ai_intelligence/
├── router.py
├── providers.py
├── exceptions.py
└── tests/
    └── test_router.py
```

The implementation may be divided further after repository inspection, but responsibilities must remain separated:

- `router.py`: routing and failover orchestration.
- `providers.py`: provider adapters and health checks.
- `exceptions.py`: structured router exceptions.
- `test_router.py`: deterministic unit tests.

## 16. Testing Requirements

The Phase 2F tests must verify:

- Correct primary selection.
- Correct fallback ordering.
- Primary success without failover.
- Automatic failover after primary unavailability.
- Automatic failover after a retryable execution failure.
- Multiple sequential fallback attempts.
- Failure after all candidates are exhausted.
- Local-only routing never selects a cloud model.
- Evaluation models remain excluded in production-safe mode.
- Unknown component handling.
- Empty deployment handling.
- Database failure handling.
- Non-retryable request failures do not cause unsafe retries.
- Failover events contain the correct attempted and selected models.
- No duplicate candidate attempts during one request.

Tests must use fakes or mocks and must not require real provider calls.

## 17. Implementation Checkpoints

### Phase 2F.1 — Router Core

- Repository inspection.
- Confirm database connection conventions.
- Define routing dataclasses and exceptions.
- Read ordered candidates from PostgreSQL.
- Enforce model status, routing mode, and privacy policy.

### Phase 2F.2 — Provider Adapters and Failover Executor

- Define provider adapter contract.
- Implement Ollama availability checks.
- Implement bounded execution attempts.
- Add mandatory ordered failover.
- Add structured exhaustion errors.

### Phase 2F.3 — Automated Tests

- Add deterministic unit tests.
- Add database integration tests against development PostgreSQL.
- Verify all existing AI Intelligence tests continue to pass.

### Phase 2F.4 — First Runtime Integration

The additive `ai.execute` Gateway method is implemented on the `development` branch. It provides the control-plane seam without changing existing chat, agent, or channel routing.

Recommended initial component:

```text
telegram_ranch_bot
```

Activation must occur in the development Gateway first. The feature flag must remain off in production until the development proof and production-promotion checkpoint are complete.

### Phase 2F.4G Gateway Execution Boundary

Implemented:

- typed request and result schemas;
- `operator.write` method registration;
- disabled-by-default activation control;
- bounded Node.js to Python process bridge;
- development Gateway image packaging for the bridge and its pinned Python dependency;
- engine construction from the approved database environment;
- ordered attempt details in successful results;
- sanitized Gateway error responses;
- focused Gateway tests and bridge serialization tests;
- real `ai.execute` activation proof on the loopback Gateway for `telegram_ranch_bot`;
- primary success through the live Gateway boundary;
- primary failure with approved fallback success through the live Gateway boundary;
- sanitized client errors with detailed operational Gateway logs;
- activation and rollback checkpoint recorded under `reports/architect/`.

Pending:

- separate production-promotion review after telemetry and broader acceptance checks;
- keep the feature flag removable by drop-in edit plus Gateway restart.

### Phase 2F.5 — Usage and Failover Telemetry

Implemented:

- persist configured versus observed routing into `ai_intelligence.observed_model_usage`;
- record ordered attempt details, failover flag, and final selection in `usage_metadata`;
- soft-fail telemetry so recording errors never block a valid model response;
- operator report via `tools/ai_intelligence/report_routing_telemetry.py`;
- Daily Executive Briefing AI routing telemetry summary;
- OpenClaw dashboard AI routing telemetry panel.
- OpenClaw dashboard AI Model Scorecard review page with immutable
  approval, rejection, promotion, evidence, queue, and audit views.

Dashboard scorecard mutations are restricted to loopback requests. Approval
and rejection are direct operator decisions bound to the pipeline displayed on
the page; stale pipeline submissions are rejected. Promotion remains a
separate action that requires the exact decision ID. Remote dashboard
connections remain review-only. Operators should use an SSH tunnel to
`127.0.0.1:5051` when performing a decision action.

The scorecard exposes read-only evidence for each recommendation and must
distinguish executed evidence from development fixtures or missing reports.
The dashboard discovers archived Evaluation Lab reports, orders undecided
pipelines deterministically, and advances to the next pipeline after a
decision. Evidence links remain bound to the selected pipeline. When no
undecided report remains, the dashboard preserves completed decisions and shows
an empty review queue. It must not create synthetic review items to keep the
queue populated.

## 18. Production Promotion Requirements

Phase 2F must not be promoted to production until:

- All existing tests pass.
- New router and failover tests pass.
- Development database integration passes.
- Local privacy enforcement is demonstrated.
- Primary failure and fallback success are demonstrated.
- Complete fallback exhaustion is demonstrated.
- No production configuration was modified during development.
- Changes are committed to the feature branch and reviewed.
- The Gateway boundary has been enabled and exercised in development.
- The development Gateway can be disabled by removing the feature flag and restarting the service.
- The production service configuration and rollback point are recorded before activation.

## 19. Future Dynamic Routing

After deterministic routing and automatic failover are stable, candidate selection may incorporate:

- Live provider latency.
- Model benchmark scores.
- Historical success rate.
- Cost.
- Token limits.
- Local processor and memory utilization.
- Model warm/cold state.
- Task-specific scorecard weights.

Dynamic routing must remain subordinate to privacy, model status, and production-safety rules.

## 20. Acceptance Statement

Phase 2F is complete only when an OpenClaw component can submit a request through the Runtime AI Router, have the configured primary model fail, automatically receive a successful response from an approved fallback, and produce an auditable record of the failover without violating privacy policy.
