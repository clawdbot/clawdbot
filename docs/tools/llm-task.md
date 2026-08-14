---
summary: "JSON-only LLM tasks for workflows (optional plugin tool)"
read_when:
  - You want a JSON-only LLM step inside workflows
  - You need schema-validated LLM output for automation
title: "LLM task"
---

`llm-task` is a bundled **optional plugin tool** that runs a single JSON-only
LLM call and returns structured output, optionally validated against a JSON
Schema. It gives workflow engines like Lobster an LLM step without custom
OpenClaw code per workflow.

## Enable

1. Enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Allow the tool:

```json
{
  "tools": {
    "alsoAllow": ["llm-task"]
  }
}
```

`alsoAllow` adds `llm-task` on top of the active tool profile without
restricting other core tools. Use `tools.allow` only if you want a restrictive
allowlist mode instead.

## Config (optional)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "llm": {
          "allowModelOverride": true,
          "allowedCompletionModels": ["openai/gpt-5.6-sol"],
          "allowAuthProfileOverride": true
        },
        "config": {
          "defaultProvider": "openai",
          "defaultModel": "gpt-5.6-sol",
          "defaultAuthProfileId": "main",
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

The `llm` block is host-owned authorization. `allowedCompletionModels` restricts every
completion, so include the resolved agent default as well as any override targets.
`allowAuthProfileOverride` permits `defaultAuthProfileId` and the per-call
`authProfileId` parameter. The `config` keys are selection defaults used when a
tool call omits the corresponding parameter.

Run `openclaw doctor --fix` once for llm-task entries created by older releases.
Doctor grants the shipped model/profile selection permissions and moves any
legacy `config.allowedModels` value into `llm.allowedCompletionModels` without widening it.

## Tool parameters

| Parameter       | Type   | Notes                                                                                                                                         |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`        | string | Required. Task instruction for the LLM.                                                                                                       |
| `input`         | any    | Optional payload; serialized to JSON and appended to the prompt.                                                                              |
| `schema`        | object | Optional JSON Schema the parsed output must validate against.                                                                                 |
| `provider`      | string | Overrides `defaultProvider` / the agent's default provider.                                                                                   |
| `model`         | string | Overrides `defaultModel`; accepts bare model ids, aliases, or a `provider/model` ref (a duplicate provider prefix is stripped automatically). |
| `thinking`      | string | Reasoning level (e.g. `low`, `medium`); must be one supported by the resolved model.                                                          |
| `authProfileId` | string | Overrides `defaultAuthProfileId`.                                                                                                             |
| `temperature`   | number | Best-effort; not all providers honor it.                                                                                                      |
| `maxTokens`     | number | Best-effort cap on output tokens.                                                                                                             |
| `timeoutMs`     | number | Run timeout; default `30000`.                                                                                                                 |

## Output

Returns `details.json` (the parsed, schema-validated JSON) plus `details.provider`
and `details.model` naming what actually ran.

Each call starts a fresh prompt-only inference operation. It does not reuse the
calling agent's transcript or native runtime session, run agent lifecycle hooks,
or deliver model output to a channel. OpenClaw uses the selected provider,
model, auth profile, and runtime exactly once; it does not fall back to another
route when that owner cannot provide a literal zero-tool call.

A selected agent harness must implement isolated completion. Otherwise the call
fails before inference with a `does not support isolated completion` error.
This fail-closed behavior prevents a JSON task from silently becoming a normal
tool-capable agent turn.

CLI runtimes must provide the equivalent isolated preparation guarantee. The
bundled Claude and Gemini CLI runtimes do; a different CLI runtime that has not
adopted this internal contract fails before its process starts.

Gemini CLI isolated completion supports Gemini API-key and Vertex auth. Google
OAuth and compute/Code Assist auth are rejected because managed-account policy
can add administrator-required tools after local CLI settings are loaded.
Gemini prompts containing native `@path` includes or a leading `/command` also
fail before inference because Gemini CLI has no literal raw-input mode.

## Example: Lobster workflow step

### Important limitation

The example below assumes the **standalone Lobster CLI** is running where
`openclaw.invoke` already has the correct gateway URL/auth context.

For the bundled **embedded** Lobster runner inside OpenClaw, this nested CLI
pattern is **not currently reliable**:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{ ... }'
```

Until embedded Lobster has a supported bridge for this flow, prefer either:

- direct `llm-task` tool calls outside Lobster, or
- Lobster steps that do not rely on nested `openclaw.invoke` calls.

Standalone Lobster CLI example:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Safety notes

- **JSON-only**: the model is instructed to return only a JSON value, no code
  fences, no commentary.
- **No tools**: the selected runtime must expose a literal empty model-callable
  tool surface. OpenClaw rejects tool-shaped results instead of treating them as
  task output.
- **Isolated**: the run has no agent transcript, session reuse, lifecycle hooks,
  channel delivery, or provider fallback.
- Treat output as untrusted unless you validate it with `schema`.
- Put approvals before any side-effecting step (send, post, exec) that consumes
  this output.

## Related

- [Thinking levels](/tools/thinking)
- [Sub-agents](/tools/subagents)
- [Slash commands](/tools/slash-commands)
