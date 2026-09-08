---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features are preview surfaces controlled by config flags. They need more real-world mileage before their shape and behavior become long-lived contracts.

- Off by default unless the feature docs state otherwise. Swarm is enabled by default with an explicit opt-out.
- Shape and behavior can change faster than stable config.
- Prefer a stable path when one already exists.
- Roll out broadly only after testing in a smaller environment first.

All [plugin APIs](/plugins/sdk-overview#api-stability) are also experimental.
That stability label does not require a Labs switch for ordinary plugins; the
Custom plugin UI flag below controls user-installed native browser code only.

## Currently documented flags

| Surface             | Key                                                                                           | Use it when                                                                                                                       | More                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Local model runtime | `agents.defaults.experimental.localModelLean`, `agents.entries.*.experimental.localModelLean` | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                                                | [Local Models](/gateway/local-models)                                                  |
| Codex harness       | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer`                       | You want native Codex app-server 0.143.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution) |
| Code Mode           | `tools.codeMode.enabled`                                                                      | You want compact code-orchestrated access to a hidden OpenClaw tool catalog                                                       | [Code Mode](/tools/code-mode)                                                          |
| Cloud workers       | `cloudWorkers.desktop`                                                                        | You want to watch or control desktop-capable cloud worker environments from the Control UI                                        | [Cloud Worker Desktop](/gateway/cloud-workers#desktop-interactive)                     |
| Custom plugin UI    | `gateway.controlUi.experimental.customPlugins`                                                | You want trusted user-installed plugins to add native Control UI views or replace built-in views                                  | [Feature plugins](/plugins/feature-plugins#enable-custom-plugin-ui)                    |
| Swarm               | `tools.swarm.enabled`                                                                         | You want Code Mode scripts to orchestrate bounded groups of sub-agents in parallel                                                | [Swarm](/tools/swarm)                                                                  |

## Control UI Labs

Open **Settings → Agents & Tools → Labs** to manage experiments that have a
Control UI switch. Enabling or disabling a lab patches the canonical Gateway
config immediately; the page shows a restart hint only when a feature requires
one.

Labs includes Code Mode, Swarm, Tool Search, Custom plugin UI,
Tool-loop detection, Lean tools for local models, Message audit metadata, and
Cloud Worker Desktop. Message audit metadata, Cloud Worker Desktop, and Custom
plugin UI require a Gateway restart. Custom plugin UI also requires reloading
connected browser tabs; the other listed switches normally take effect for
future agent runs without restarting.

Custom plugin UI is off by default. Enabled bundled plugins, including
Workboard, retain their native UI with the setting off. Backend APIs and
ordinary plugins remain available, and installing or approving a plugin
artifact does not enable the lab.

Code Mode remains disabled until you turn on its Labs switch or explicitly set
`tools.codeMode` to `true` or `"auto"`. The Labs switch writes `"auto"`, so it
engages only for models marked as preferred Code Mode performers; it does not
force Code Mode on for every model.

Swarm is enabled by default, including when `tools.swarm` is omitted or sets
only limits. Turn off its Labs switch, set `tools.swarm: false`, or set
`tools.swarm.enabled: false` to opt out. Per-agent overrides remain available;
an agent that sets only limits inherits global enablement. Swarm does not
enable Code Mode or grant tools: Code Mode's Swarm API requires an executable
native `sessions_spawn` tool, while the low-level flow also requires
`agents_wait`. See [Swarm requirements](/tools/swarm#requirements).

## Local model lean mode

Lean mode is an explicit capability restriction. Local inference normally uses [Tool Search](/tools/tool-search) to defer schemas while preserving capabilities, so leave lean mode off unless you deliberately want a smaller tool set.

`agents.defaults.experimental.localModelLean: true` removes optional tools before catalog construction: `browser`, `automations`, `message`, `image_generate`, `music_generate`, `video_generate`, `tts`, and `pdf`. These removed tools cannot be found through Tool Search. Explicitly allowed or delivery-required tools remain available, though Tool Search may catalog them instead of exposing them directly. Lean mode also defaults catalogs to structured Tool Search (`tool_search`, `tool_describe`, `tool_call`) when `tools.toolSearch` is not already set. Use `agents.entries.*.experimental.localModelLean` to scope this to one agent.

Setup no longer writes this flag. For older installations, `openclaw doctor --fix` removes an onboarding-owned `true` when its ownership marker still matches the default model. Explicit settings and settings with stale ownership markers are preserved. Set a retained flag to `false` to restore optional capabilities; automatic Tool Search still applies to local routes.

If you already tune Tool Search globally, OpenClaw leaves that config alone. Set `tools.toolSearch: false` to opt out of the lean-mode Tool Search default.

In structured `tools` mode, lean runs keep `exec` directly visible beside the Tool Search controls so coding-tuned local models can still choose their familiar shell path. This changes schema visibility only: normal tool policy, sandboxing, and exec approvals still apply. Explicit `code` and `directory` modes keep their normal compaction behavior.

### Why these tools

These tools have the largest descriptions, broadest parameter shapes, or highest chance of distracting a small model from the normal coding and conversation path. On a small-context or stricter OpenAI-compatible backend that is the difference between:

- Tool schemas fitting the prompt vs. crowding out conversation history.
- The model picking the right tool vs. emitting malformed tool calls from too many similar schemas.
- The Chat Completions adapter staying inside structured-output limits vs. a 400 on tool-call payload size.

The model still has `read`, `write`, `edit`, `exec`, `apply_patch`, image understanding, web search/fetch (when configured), memory, and session/agent tools. Remaining catalog tools stay reachable through Tool Search unless you set `tools.toolSearch: false`; explicit tool allows can restore a capability removed by lean mode.

### When to turn it on

Enable lean mode once you have proved the model can talk to the Gateway but full agent turns misbehave:

1. `openclaw infer model run --gateway --model <ref> --prompt "Reply with exactly: pong"` succeeds.
2. A normal agent turn fails with malformed tool calls, oversized prompts, or the model ignoring its tools.
3. Toggling `localModelLean: true` clears the failure.

### When to leave it off

Leave lean mode unset or set `agents.defaults.experimental.localModelLean: false` to retain the full policy-approved tool set. Setup preserves explicit choices and never enables lean mode automatically.

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
    entries: {
      local: {
        default: true,
        model: "lmstudio/gemma-4-e4b-it",
        experimental: {
          localModelLean: true,
        },
      },
    },
  },
}
```

Restart the Gateway after changing the flag. Lean filtering removes `browser`, `automations`, `message`, `image_generate`, `music_generate`, `video_generate`, `tts`, and `pdf` unless you explicitly preserve them with `tools.allow` or `tools.alsoAllow`; Tool Search may still catalog preserved tools instead of exposing them directly.

## Experimental does not mean hidden

An experimental feature should say so plainly in docs and in the config path itself, not hide behind a stable-looking default knob.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
