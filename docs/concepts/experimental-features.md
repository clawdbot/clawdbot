---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features in OpenClaw are **opt-in preview surfaces**. They are
behind explicit flags because they still need real-world mileage before they
deserve a stable default or a long-lived public contract.

Treat them differently from normal config:

- Keep them **off by default** unless the related doc tells you to try one.
- Expect **shape and behavior to change** faster than stable config.
- Prefer the stable path first when one already exists.
- If you are rolling OpenClaw out broadly, test experimental flags in a smaller
  environment before baking them into a shared baseline.

## Currently documented flags

| Surface                  | Key                                                       | Use it when                                                                                                    | More                                                                                          |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local model runtime      | `agents.defaults.experimental.localModelLean`             | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                             | [Local Models](/gateway/local-models)                                                         |
| Memory search            | `agents.defaults.memorySearch.experimental.sessionMemory` | You want `memory_search` to index prior session transcripts and accept the extra storage/indexing cost         | [Memory configuration reference](/reference/memory-config#session-memory-search-experimental) |
| Structured planning tool | `tools.experimental.planTool`                             | You want the structured `update_plan` tool exposed for multi-step work tracking in compatible runtimes and UIs | [Gateway configuration reference](/gateway/config-tools#toolsexperimental)                    |

## Local model lean mode

`agents.defaults.experimental.localModelLean: true` is a pressure-release valve for weaker local-model setups. When it is on, OpenClaw drops three default tools — `browser`, `cron`, and `message` — from the agent's tool surface for every turn. Nothing else changes.

### Why these three tools

These three tools have the largest descriptions and the most parameter shapes in the default OpenClaw runtime. On a small-context or stricter OpenAI-compatible backend that is the difference between:

- Tool schemas fitting cleanly in the prompt vs. crowding out conversation history.
- The model picking the right tool vs. emitting malformed tool calls because there are too many similar-looking schemas.
- The Chat Completions adapter staying inside the server's structured-output limits vs. tripping a 400 on tool-call payload size.

Removing them does not silently rewire OpenClaw — it just makes the tool list shorter. The model still has `read`, `write`, `edit`, `exec`, `apply_patch`, web search/fetch (when configured), memory, and session/agent tools available.

### When to turn it on

Enable lean mode when you have already proved the model can talk to the Gateway but full agent turns misbehave. The typical signal chain is:

1. `openclaw infer model run --gateway --model <ref> --prompt "Reply with exactly: pong"` succeeds.
2. A normal agent turn fails with malformed tool calls, oversized prompts, or the model ignoring its tools.
3. Toggling `localModelLean: true` clears the failure.

### When to leave it off

If your backend handles the full default runtime cleanly, leave this off. Lean mode is a workaround, not a default. It exists because some local stacks need a smaller tool surface to behave; hosted models and well-resourced local rigs do not.

Lean mode also does not replace `tools.profile`, `tools.allow`/`tools.deny`, or the model `compat.supportsTools: false` escape hatch. If you need a permanent narrower tool surface for a specific agent, prefer those stable knobs over the experimental flag.

### Enable

```json5
{
  agents: {
    defaults: {
      experimental: {
        localModelLean: true,
      },
    },
  },
}
```

Restart the Gateway after changing the flag, then confirm the trimmed tool list with:

```bash
openclaw status --deep
```

The deep status output lists the active agent tools; `browser`, `cron`, and `message` should be absent when lean mode is on.

## Experimental does not mean hidden

If a feature is experimental, OpenClaw should say so plainly in docs and in the
config path itself. What it should **not** do is smuggle preview behavior into a
stable-looking default knob and pretend that is normal. That's how config
surfaces get messy.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
