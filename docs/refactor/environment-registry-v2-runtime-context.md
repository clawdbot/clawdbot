# Runtime Self Context Plan

Design and implementation plan for issue #89537.

## Goal

OpenClaw should give an agent a cheap, reliable place to understand its own runtime and decide whether work should run here, scale this runtime, or be offloaded somewhere else.

This is not a full environment inventory in v1. The first useful contract is a conversation-scoped runtime context with an optional prompt summary and a tool path for fresh details.

The user-facing problems this should solve:

- the agent knows where it is running
- the agent knows its basic resources and limits
- the agent knows whether scale up or scale down is possible
- the agent knows where else work can be sent
- the agent can compare local execution, scaling, and offload options
- plugins can provide provider-specific details, costs, and actions without inflating prompt context

## Non-Goals For V1

- no broad CMDB-style inventory
- no automatic load/scheduler model
- no capacity slots
- no CPU or memory "class" fields
- no raw provider commands in prompt-facing data
- no detailed hardware dump unless explicitly requested through a provider/tool path

## Core Shape

The core object is `runtimeContext`, stored as conversation/session metadata.

```ts
type RuntimeContextConfig = {
  source: "static" | "provider" | "mixed";
  expose: RuntimeContextExposure;
  ttlSeconds?: number;
  validUntil?: string;
  value?: RuntimeSelfContext;
};

type RuntimeContextExposure = {
  mode: "none" | "tool_hint" | "prompt_summary";
};
```

`runtimeContext.value` is the structured source of truth. Prompt text is derived from it, not copied into every agent flavor.

## Exposure Modes

Runtime context can be present without being injected into the prompt.

### none

No runtime details are injected into the prompt.

Use when:

- runtime context is disabled
- the conversation must not reveal runtime details
- tools may still hold provider state internally, but the agent is not told about it

Prompt impact:

- no runtime summary
- no runtime-specific superinstruction

### tool_hint

The prompt only tells the agent that runtime details are available through a tool.

Example injected instruction:

```text
Runtime details are available through the runtime tool. Do not guess resources,
scale options, offload targets, or cost. For tasks that may need more compute,
delegation, or runtime changes, call runtime.self or runtime.describe.
```

Use when:

- we want minimal prompt overhead
- the model should know there is a canonical source
- details may be stale, sensitive, or expensive to render

Prompt impact:

- small superinstruction only
- no resource or target details

### prompt_summary

The prompt gets a compact, redacted summary plus the tool hint.

Example injected card:

```yaml
runtime:
  current: openclaw-dev
  locality: local
  resources: "8 CPU, 32 GiB memory, no accelerator"
  scale: "scale_up available, scale_down unavailable"
  offload: "2 targets available"
  cost: "metered targets require estimate"
  detailsTool: runtime.describe
  validUntil: 2026-06-03T19:00:00-07:00
```

Use when:

- the agent should make cheap first-pass decisions
- the summary is stable and safe enough for the conversation
- avoiding repeated tool calls is worth a small context cost

Prompt impact:

- short runtime card
- same superinstruction as `tool_hint`
- full details still require the runtime tool

## Conversation Assembly

Runtime context is a conversation-level attachment/injection, not part of every agent prompt flavor.

Assembly order:

```text
base system/developer instructions
+ selected agent/persona/flavor instructions
+ conversation-scoped runtime context injection
+ tools
+ user/task messages
```

This keeps the design centralized. Adding a new agent flavor should not require copying runtime text into that flavor.

## Runtime Tool

The agent-facing tool should be the main path for details.

Initial tool surface:

```text
runtime.self()
runtime.describe({ include? })
runtime.actions()
runtime.offload.targets()
runtime.cost.estimate({ targetId, workload })
runtime.offload.plan({ workload, requirements?, budget? })
```

Suggested include values for `runtime.describe`:

```ts
type RuntimeDescribeInclude =
  | "current"
  | "resources"
  | "limits"
  | "actions"
  | "offload"
  | "cost"
  | "freshness"
  | "provenance";
```

The runtime tool should read the conversation/session runtime context and may ask providers/plugins for fresh details when configured.

## Runtime Self Context Schema

```ts
type RuntimeSelfContext = {
  id: string;
  label?: string;
  current: CurrentRuntime;
  resources?: RuntimeResources;
  limits?: RuntimeLimits;
  actions?: RuntimeActionRef[];
  offload?: RuntimeOffload;
  cost?: RuntimeCostHint;
  freshness?: RuntimeFreshness;
  provenance?: RuntimeProvenance;
};
```

### Current Runtime

```ts
type CurrentRuntime = {
  id: string;
  label?: string;
  locality: "local" | "remote" | "cloud" | "unknown";
  environmentId?: string;
  workspace?: RuntimeWorkspace;
};

type RuntimeWorkspace = {
  mode: "local" | "mounted" | "synced" | "remote" | "none" | "unknown";
  writable?: boolean;
  cwdRelative?: string;
};
```

### Resources

Keep resources recognizable and practical. Avoid vague classes.

```ts
type RuntimeResources = {
  cpu?: {
    architecture?: string;
    effectiveCores?: number;
    model?: string;
    features?: string[];
  };
  memory?: {
    effectiveBytes?: number;
  };
  disk?: {
    effectiveBytes?: number;
  };
  accelerators?: RuntimeAccelerator[];
};

type RuntimeAccelerator = {
  kind: "gpu" | "npu" | "tpu" | "other";
  vendor?: string;
  model?: string;
  memoryBytes?: number;
  runtimes?: Array<
    "cuda" | "rocm" | "metal" | "opencl" | "vulkan" | "sycl" | "level-zero" | "unknown"
  >;
};
```

### Limits

```ts
type RuntimeLimits = {
  maxTaskSeconds?: number;
  secretsAllowed?: boolean;
  networkAccess?: "enabled" | "disabled" | "restricted" | "unknown";
  filesystemAccess?: "full" | "workspace" | "read_only" | "none" | "unknown";
  approvalRequiredFor?: RuntimeActionKind[];
};
```

### Actions

Actions are opaque references. They must not look like executable commands.

```ts
type RuntimeActionKind =
  | "scale_up"
  | "scale_down"
  | "delegate"
  | "provision"
  | "open_session"
  | "submit_task";

type RuntimeActionRef = {
  kind: RuntimeActionKind;
  label: string;
  ref: string;
  requiresApproval?: boolean;
  validUntil?: string;
  providerId?: string;
};
```

The resolver behind `ref` is plugin/provider-owned. Core owns the shape, redaction, authorization, and approval boundary.

## Offload Targets

Offload targets answer: "Where else can this work go?"

```ts
type RuntimeOffload = {
  targets: RuntimeOffloadTarget[];
};

type RuntimeOffloadTarget = {
  id: string;
  label?: string;
  locality: "local" | "remote" | "cloud" | "unknown";
  workloadKinds: RuntimeWorkloadKind[];
  resources?: RuntimeResources;
  limits?: RuntimeLimits;
  availability?: RuntimeAvailability;
  actions: {
    submitTask?: RuntimeActionRef;
    openSession?: RuntimeActionRef;
    provision?: RuntimeActionRef;
  };
  cost?: RuntimeCostHint;
  validUntil?: string;
  providerId?: string;
};

type RuntimeWorkloadKind =
  | "codex"
  | "shell"
  | "build"
  | "test"
  | "long_task"
  | "gpu_compute"
  | "media"
  | "generic";

type RuntimeAvailability = {
  state: "available" | "unavailable" | "starting" | "stopping" | "error" | "unknown";
  reason?: string;
};
```

Offload does not imply that the agent may immediately send work. The action can still require approval, budget confirmation, credentials, or a lease.

## Cost

Core should expose normalized cost hints, not a billing engine.

```ts
type RuntimeCostHint = {
  model: "free" | "included" | "metered" | "quota" | "unknown";
  currency?: string;
  roughUnitCost?: string;
  quotaRemaining?: string;
  estimateRef?: string;
  notes?: string;
};
```

Provider plugins own precise estimates. Other tools should be able to use the same estimate path.

Example:

```text
runtime.cost.estimate({
  targetId: "gateway-large",
  workload: {
    kind: "build",
    expectedSeconds: 1800,
    acceleratorRequired: false
  }
})
```

The estimate response can include:

```ts
type RuntimeCostEstimate = {
  targetId: string;
  model: RuntimeCostHint["model"];
  estimatedCost?: {
    currency: string;
    min?: number;
    max?: number;
    value?: number;
  };
  quotaImpact?: string;
  requiresApproval?: boolean;
  validUntil?: string;
  providerId?: string;
};
```

## Freshness And Provenance

Every runtime context and offload target may expire.

```ts
type RuntimeFreshness = {
  observedAt?: string;
  validUntil?: string;
  ttlSeconds?: number;
  stale?: boolean;
};

type RuntimeProvenance = {
  source: "static_config" | "provider" | "probe" | "operator" | "mixed";
  providerId?: string;
};
```

Rule: if the task depends on resources, scale, offload, or cost, and the relevant data is expired or absent, the agent should call the runtime tool before making a decision.

## Config Examples

### Config Only

```yaml
runtimeContext:
  source: static
  expose:
    mode: none
  value:
    id: local-dev
    current:
      id: local-dev
      locality: local
```

### Tool Hint

```yaml
runtimeContext:
  source: mixed
  expose:
    mode: tool_hint
  ttlSeconds: 3600
  value:
    id: openclaw-dev
    current:
      id: openclaw-dev
      locality: local
    actions:
      - kind: scale_up
        label: Resize current runtime
        ref: runtime-action://gateway/current/resize-up
        requiresApproval: true
```

### Prompt Summary

```yaml
runtimeContext:
  source: mixed
  expose:
    mode: prompt_summary
  ttlSeconds: 3600
  value:
    id: openclaw-dev
    current:
      id: openclaw-dev
      label: OpenClaw Dev
      locality: local
      workspace:
        mode: local
        writable: true
    resources:
      cpu:
        architecture: arm64
        effectiveCores: 8
        model: Apple M3 Max
      memory:
        effectiveBytes: 34359738368
    actions:
      - kind: scale_up
        label: Resize this runtime
        ref: runtime-action://gateway/current/scale-up
        requiresApproval: true
    offload:
      targets:
        - id: gateway-large
          label: Gateway large VM
          locality: cloud
          workloadKinds: [codex, shell, build, test, long_task]
          resources:
            cpu:
              effectiveCores: 16
              model: Cloud vCPU
            memory:
              effectiveBytes: 68719476736
          actions:
            submitTask:
              kind: submit_task
              label: Submit task
              ref: runtime-action://gateway-large/submit
              requiresApproval: true
          cost:
            model: metered
            currency: USD
            estimateRef: runtime-cost://gateway-large/estimate
```

## Prompt Text Contract

For `tool_hint`:

```text
Runtime details are available through the runtime tool. Do not guess local
resources, scale options, offload targets, or cost. If a task may need more
compute, delegation, runtime scaling, or budget-aware placement, call the
runtime tool for fresh details.
```

For `prompt_summary`, append a compact generated card:

```text
Runtime summary:
- current: OpenClaw Dev, local
- resources: 8 CPU, 32 GiB memory, no accelerator
- scale: scale_up available, approval required
- offload: 1 target available, metered
- details: call runtime.describe for fresh details
- valid until: 2026-06-03T19:00:00-07:00
```

The renderer should be centralized in conversation assembly. Agent flavors should not duplicate this text.

## Core vs Plugins

Core owns:

- `runtimeContext` config shape
- conversation/session storage
- exposure mode handling
- prompt summary rendering
- runtime tool contract
- opaque action ref format and authorization boundary
- approval policy integration
- freshness/TTL rules
- normalized cost hints

Plugins own:

- discovering provider-specific resources
- refreshing runtime context
- resolving scale/provision/offload action refs
- computing precise cost estimates
- submitting work to remote targets
- opening remote sessions
- reporting quotas and provider errors

## Relationship To Environments API

`environments.list` and `environments.status` should remain cheap compatibility APIs.

For v1, do not turn `environments.describe` into the main agent-facing surface. If it exists, it can feed runtime providers and operator UI, but the agent should primarily see:

- optional prompt summary
- runtime tool
- conversation-scoped runtime context

Environment Registry can remain a future provider behind this runtime context, not the thing injected into every prompt.

## Implementation Milestones

1. Add `runtimeContext` to conversation/session config.
2. Add exposure modes: `none`, `tool_hint`, `prompt_summary`.
3. Implement centralized prompt renderer for the runtime superinstruction/card.
4. Add a first `runtime.self` / `runtime.describe` tool backed by static config.
5. Add offload target and cost hint schema.
6. Add provider/plugin hook for refreshing runtime context and cost estimates.
7. Add action ref resolver for scale/offload actions with approval integration.
8. Add tests for prompt injection, hidden/config-only mode, TTL/stale behavior, and tool output redaction.

## Open Questions

- Should the runtime tool live under a new namespace (`runtime.*`) or reuse an existing conversation/session tool namespace?
- Should `prompt_summary` be allowed in group chats by default, or should it require an explicit config opt-in?
- Should cost hints be included in prompt summaries, or only the fact that metered targets exist?
- How much workload description should `runtime.offload.plan` accept before it becomes a scheduler?

## Recommended V1 Decision

Start with conversation-scoped runtime context, `tool_hint` as the default exposure, and `prompt_summary` as an opt-in.

This keeps prompt overhead low, gives the agent a canonical place to ask about itself, and leaves provider-specific discovery, cost, scale, and offload mechanics in plugins.
