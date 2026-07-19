---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features are preview surfaces behind explicit flags. They need more real-world mileage before they get a stable default or a long-lived contract.

- Off by default unless a doc describes a narrow automatic setup rule.
- Shape and behavior can change faster than stable config.
- Prefer a stable path when one already exists.
- Roll out broadly only after testing in a smaller environment first.

## Currently documented flags

| Surface                  | Key                                                                                        | Use it when                                                                                                                       | More                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local model runtime      | `agents.defaults.experimental.localModelLean`, `agents.list[].experimental.localModelLean` | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                                                | [Local Models](/gateway/local-models)                                                         |
| Memory search            | `agents.defaults.memorySearch.experimental.sessionMemory`                                  | You want `memory_search` to index prior session transcripts and accept the extra storage/indexing cost                            | [Memory configuration reference](/reference/memory-config#session-memory-search-experimental) |
| Codex harness            | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer`                    | You want native Codex app-server 0.132.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution)        |
| Structured planning tool | `tools.experimental.planTool`                                                              | You want the structured `update_plan` tool exposed for multi-step work tracking in compatible runtimes and UIs                    | [Gateway configuration reference](/gateway/config-tools#toolsexperimental)                    |
| Code Mode                | `tools.codeMode.enabled`                                                                   | You want compact code-orchestrated access to a hidden OpenClaw tool catalog                                                       | [Code Mode](/tools/code-mode)                                                                 |

## Control UI Labs

Open **Settings → Agents & Tools → Labs** to manage experiments that have a
Control UI switch. Enabling or disabling a lab patches the canonical Gateway
config immediately; the page shows a restart hint only when a feature requires
one.

Code Mode is currently the only shipped Labs entry. Swarm is not exposed yet:
its config shape has not shipped, so Control UI does not write a speculative
key that would invalidate the operator's config.

## Local model lean mode

`agents.defaults.experimental.localModelLean: true` drops heavyweight optional tools from the agent's direct surface every turn: `browser`, `cron`, `message`, `image_generate`, `music_generate`, `video_generate`, `tts`, and `pdf`. Explicitly allowed or delivery-required tools remain available, though Tool Search may catalog them instead of exposing them directly. Lean mode also defaults plugin/MCP/client catalogs to structured Tool Search (`tool_search`, `tool_describe`, `tool_call`) when `tools.toolSearch` is not already set. Use `agents.list[].experimental.localModelLean` to scope this to one agent.

During onboarding, a verified `ollama` or `lmstudio` inference route automatically sets `agents.defaults.experimental.localModelLean: true` when that value is absent. OpenClaw records that the setting came from onboarding, so a later verified non-local route lifts only the automatic setting. An explicitly configured `true` or `false` is preserved. Other self-hosted and OpenAI-compatible providers are not inferred from model names or URLs.

If you already tune Tool Search globally, OpenClaw leaves that config alone. Set `tools.toolSearch: false` to opt out of the lean-mode Tool Search default.

In structured `tools` mode, lean runs keep `exec` directly visible beside the Tool Search controls so coding-tuned local models can still choose their familiar shell path. This changes schema visibility only: normal tool policy, sandboxing, and exec approvals still apply. Explicit `code` and `directory` modes keep their normal compaction behavior.

### Why these tools

These tools have the largest descriptions, broadest parameter shapes, or highest chance of distracting a small model from the normal coding and conversation path. On a small-context or stricter OpenAI-compatible backend that is the difference between:

- Tool schemas fitting the prompt vs. crowding out conversation history.
- The model picking the right tool vs. emitting malformed tool calls from too many similar schemas.
- The Chat Completions adapter staying inside structured-output limits vs. a 400 on tool-call payload size.

Removing them only shortens the direct tool list. The model still has `read`, `write`, `edit`, `exec`, `apply_patch`, image understanding, web search/fetch (when configured), memory, and session/agent tools. Extra catalogs stay reachable through Tool Search unless you set `tools.toolSearch: false`; explicit tool allows can opt a lean agent back into a trimmed workflow.

### When to turn it on

Enable lean mode once you have proved the model can talk to the Gateway but full agent turns misbehave:

1. `openclaw infer model run --gateway --model <ref> --prompt "Reply with exactly: pong"` succeeds.
2. A normal agent turn fails with malformed tool calls, oversized prompts, or the model ignoring its tools.
3. Toggling `localModelLean: true` clears the failure.

### When to leave it off

If your backend handles the full default runtime cleanly, leave this off. It is a workaround for local stacks that need a smaller tool surface, not a default for hosted models or well-resourced local rigs.

Lean mode does not replace `tools.profile`, `tools.allow`/`tools.deny`, or the model `compat.supportsTools: false` escape hatch. For a permanent narrower tool surface on a specific agent, prefer those stable knobs.

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

For one agent only:

```json5
{
  agents: {
    list: [
      {
        id: "local",
        model: "lmstudio/gemma-4-e4b-it",
        experimental: {
          localModelLean: true,
        },
      },
    ],
  },
}
```

Restart the Gateway after changing the flag. Lean filtering removes `browser`, `cron`, `message`, `image_generate`, `music_generate`, `video_generate`, `tts`, and `pdf` unless you explicitly preserve them with `tools.allow` or `tools.alsoAllow`; Tool Search may still catalog preserved tools instead of exposing them directly.

## Experimental does not mean hidden

An experimental feature should say so plainly in docs and in the config path itself, not hide behind a stable-looking default knob.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
