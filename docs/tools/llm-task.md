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
        "config": {
          "defaultProvider": "openai",
          "defaultModel": "gpt-5.6-sol",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai/gpt-5.6-sol"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` is an allowlist of `provider/model` strings; a request for any
other model is rejected. All other keys are per-call fallbacks used when the
tool call omits that parameter.

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
- **No tools**: the underlying run has tools disabled, so the model cannot call
  out mid-task.
- Treat output as untrusted unless you validate it with `schema`.
- Put approvals before any side-effecting step (send, post, exec) that consumes
  this output.

## Related

- [Thinking levels](/tools/thinking)
- [Sub-agents](/tools/subagents)
- [Slash commands](/tools/slash-commands)
