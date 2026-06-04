---
summary: "Give an agent a cheap, reliable view of where it runs and what it can offload to."
title: "Runtime self context"
read_when:
  - You want an agent to know its current runtime, resources, and offload targets
  - You need scale/offload/cost hints exposed via a tool or the prompt
---

Runtime self context gives an agent **a configured, reliable picture of where it
is running** — current runtime, resources, limits, scale/offload action refs,
and cost hints — instead of guessing. Exposure is optional and centralized: you
decide whether the agent sees it through a tool, a short prompt summary, or not
at all.

This is the first (v1) slice and is **static-config driven**: values come from
`runtimeContext` in `openclaw.json`. There is no provider-backed probing or live
cost estimation yet — `cost_estimate` returns a `not_available` placeholder
until provider estimators are registered.

## Enable it

Runtime self context is **off by default**. Configure `runtimeContext` and set
an explicit `expose.mode` to turn it on. Setting a `value` alone does nothing
until you opt in:

```json
{
  "runtimeContext": {
    "source": "static",
    "expose": { "mode": "tool_hint" },
    "value": {
      "id": "openclaw-dev",
      "current": { "id": "openclaw-dev", "locality": "local" },
      "resources": { "cpu": { "effectiveCores": 8, "model": "Apple M3 Max" } },
      "offload": {
        "targets": [
          {
            "id": "gateway-large",
            "locality": "cloud",
            "workloadKinds": ["codex", "long_task"],
            "cost": { "model": "metered", "currency": "USD" }
          }
        ]
      }
    }
  }
}
```

## Exposure modes

`runtimeContext.expose.mode` opts the conversation in to runtime context; it does
not override tool policy. The `runtime` tool and its per-turn hint/summary only
reach the model when your effective tool policy also allows the `runtime` tool.
If tool policy filters out `runtime`, the tool is hidden and no hint or summary
is injected, even under `tool_hint` or `prompt_summary`.

| Mode             | `runtime` tool (when tool policy allows it) | Per-turn prompt text (when tool policy allows it) |
| ---------------- | ------------------------------------------- | ------------------------------------------------- |
| `none` (default) | hidden                                      | none                                              |
| `tool_hint`      | available                                   | a short hint that the `runtime` tool exists       |
| `prompt_summary` | available                                   | the hint plus a compact runtime summary           |

Injected prompt text is wrapped as internal runtime context: it is hidden from
the visible conversation and not persisted as user-authored content.

## The runtime tool

When exposure is not `none`, agents get a `runtime` tool to inspect the
configured context:

- `self` — the full configured runtime context plus exposure/freshness metadata.
- `describe` — filtered sections via `include` (`current`, `resources`,
  `limits`, `actions`, `offload`, `cost`, `freshness`, `provenance`).
- `actions` — scale/offload action refs declared on the runtime and its targets.
- `offload_targets` — summaries of configured offload targets.
- `cost_estimate` — the configured cost hint for a target. In v1 the `estimate`
  field is always `{ status: "not_available" }` until a provider-backed
  estimator is registered.

## Notes

- `actions` and `offload.targets[].actions` carry opaque `ref` strings (for
  example `runtime-action://gateway/current/scale-up`) and a `requiresApproval`
  flag. They describe _what is possible_; they do not perform scaling or
  delegation on their own.
- Keep `value` minimal. Every field is optional except `id`, and the schema is
  strict — unknown keys are rejected so typos surface early.
