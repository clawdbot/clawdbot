---
summary: "Agent workspace paths, bootstrap injection, context budgets, image handling, and timezone"
read_when:
  - Choosing where an agent reads and writes files
  - Tuning bootstrap injection or a context budget
  - Adjusting inbound image scaling or the agent timezone
title: "Configuration — agent workspace and bootstrap"
---

`agents.defaults.*` keys for filesystem scope, bootstrap context injection, the context budget map, inbound image handling, and the agent timezone.

## `agents.defaults.workspace`

Default: `OPENCLAW_WORKSPACE_DIR` when set, otherwise `<state-dir>/workspace`. This is `~/.openclaw/workspace` for the default install and `~/.openclaw-<profile>/workspace` for a named profile. A custom `OPENCLAW_STATE_DIR` keeps the workspace under that state directory.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

An explicit `agents.defaults.workspace` value takes precedence over `OPENCLAW_WORKSPACE_DIR`. A sole agent uses this path directly. In a multi-agent fleet, agents without their own `workspace` use an agent-id subdirectory so no implicit owner claims the shared root.

## `agents.defaults.cwd`

Optional working directory for agent reply runs. Use it to run coding tools in an
existing repository while bootstrap files (`AGENTS.md`, `SOUL.md`) and memory stay
in the managed agent workspace.

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    entries: { coder: { cwd: "~/path/to/app", sandbox: { mode: "off" } } },
  },
}
```

Session-spawned working directories take precedence, then `agents.entries.*.cwd`,
then `agents.defaults.cwd`. When none is set, tools use the agent workspace.
Paths expand `~` like `workspace`; relative paths resolve against the Gateway
process working directory. A distinct working directory requires an unsandboxed
run; sandboxed runs reject it. When the directories differ, the system prompt
identifies their separate roles so deliverables stay in the working directory.

## `agents.defaults.repoRoot`

Optional repository root shown in the system prompt's Runtime line. If unset, OpenClaw auto-detects by walking upward from the workspace.

```json5
{
  agents: { defaults: { repoRoot: "~/path/to/openclaw" } },
}
```

## `agents.defaults.skills`

Optional default skill allowlist for agents that do not set
`agents.entries.*.skills`.

```json5
{
  agents: {
    ownership: "explicit",
    defaults: { skills: ["github", "weather"] },
    entries: {
      writer: {}, // inherits github, weather
      docs: { skills: ["docs-search"] }, // replaces defaults
      "locked-down": { skills: [] }, // no skills
    },
  },
}
```

- Omit `agents.defaults.skills` for unrestricted skills by default.
- Omit `agents.entries.*.skills` to inherit the defaults.
- Set `agents.entries.*.skills: []` for no skills.
- A non-empty `agents.entries.*.skills` list is the final set for that agent; it
  does not merge with defaults.

## `agents.defaults.skipBootstrap`

Disables automatic creation of workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`).

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

## `agents.defaults.skipOptionalBootstrapFiles`

Skips creation of selected optional workspace files while still writing required bootstrap files (`AGENTS.md`, `BOOTSTRAP.md`). Valid values: `SOUL.md`, `USER.md`, and `IDENTITY.md` (`HEARTBEAT.md` is accepted but a no-op since heartbeat context moved to cron monitor scratch).

```json5
{
  agents: {
    defaults: {
      skipOptionalBootstrapFiles: ["SOUL.md", "USER.md"],
    },
  },
}
```

## `agents.defaults.contextInjection`

Controls when workspace bootstrap files are injected into the system prompt. Default: `"always"`.

- `"continuation-skip"`: safe continuation turns (after a completed assistant response) skip workspace bootstrap re-injection, reducing prompt size. Heartbeat runs and post-compaction retries still rebuild context.
- `"never"`: disable workspace bootstrap and context-file injection on every turn. Use this only for agents that fully own their prompt lifecycle (custom context engines, native runtimes that build their own context, or specialized bootstrap-free workflows). Heartbeat and compaction-recovery turns also skip injection.

```json5
{
  agents: { defaults: { contextInjection: "continuation-skip" } },
}
```

Per-agent override: `agents.entries.*.contextInjection`. Omitted values inherit
`agents.defaults.contextInjection`.

## `agents.defaults.bootstrapMaxChars`

Max characters per workspace bootstrap file before truncation. Default: `20000`.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

Per-agent override: `agents.entries.*.bootstrapMaxChars`. Omitted values inherit
`agents.defaults.bootstrapMaxChars`.

## `agents.defaults.bootstrapTotalMaxChars`

Max total characters injected across all workspace bootstrap files. Default: `60000`.

```json5
{
  agents: { defaults: { bootstrapTotalMaxChars: 60000 } },
}
```

Per-agent override: `agents.entries.*.bootstrapTotalMaxChars`. Omitted values
inherit `agents.defaults.bootstrapTotalMaxChars`.

## Per-agent bootstrap profile overrides

Use per-agent bootstrap profile overrides when one agent needs different prompt
injection behavior from the shared defaults. Omitted fields inherit from
`agents.defaults`.

```json5
{
  agents: {
    defaults: {
      contextInjection: "continuation-skip",
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 60000,
    },
    entries: {
      "strict-worker": {
        contextInjection: "always",
        bootstrapMaxChars: 50000,
        bootstrapTotalMaxChars: 300000,
      },
    },
  },
}
```

## Bootstrap truncation notice

When bootstrap context is truncated, OpenClaw always injects a concise
agent-visible notice into the system prompt saying some bootstrap files were
truncated and to read the affected files directly. This notice is built in
and not configurable, and it deliberately omits per-file diagnostics: file
names, raw vs injected counts, and limit causes stay in diagnostics such as
context/status reports and logs.

## Context budget ownership map

OpenClaw has multiple high-volume prompt/context budgets, and they are
intentionally split by subsystem instead of all flowing through one generic
knob.

| Budget                                                         | Covers                                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.defaults.bootstrapMaxChars` / `bootstrapTotalMaxChars` | Normal workspace bootstrap injection                                                                                                                            |
| `agents.defaults.startupContext.*`                             | One-shot reset/startup model-run prelude, including recent daily `memory/*.md` files. Bare chat `/new` and `/reset` are acknowledged without invoking the model |
| `skills.limits.*`                                              | The compact skills list injected into the system prompt                                                                                                         |
| `agents.defaults.contextLimits.*`                              | Bounded runtime excerpts and injected runtime-owned blocks                                                                                                      |

Matching per-agent overrides:

- `agents.entries.*.skillsLimits.maxSkillsPromptChars`
- `agents.entries.*.contextInjection`
- `agents.entries.*.bootstrapMaxChars`
- `agents.entries.*.bootstrapTotalMaxChars`
- `agents.entries.*.contextLimits.*`

### `agents.defaults.startupContext`

Controls the first-turn startup prelude injected on reset/startup model runs.
Bare chat `/new` and `/reset` commands acknowledge the reset without invoking
the model, so they do not load this prelude.

```json5
{
  agents: {
    defaults: {
      startupContext: {
        enabled: true,
        applyOn: ["new", "reset"],
        dailyMemoryDays: 2,
        maxFileBytes: 16384,
        maxFileChars: 1200,
        maxTotalChars: 2800,
      },
    },
  },
}
```

### `agents.defaults.contextLimits`

Shared defaults for bounded runtime context surfaces.

```json5
{
  agents: {
    defaults: {
      contextLimits: {
        memoryGetMaxChars: 12000,
        postCompactionMaxChars: 1800,
      },
    },
  },
}
```

- `memoryGetMaxChars`: default `memory_get` excerpt cap before truncation
  metadata and continuation notice are added.
- When `memory_get` omits `lines`, OpenClaw uses a built-in 120-line window and
  then applies `memoryGetMaxChars`.
- Live tool results use a model-context auto cap: `16000` chars below 100K
  tokens, `32000` chars at 100K+ tokens, and `64000` chars at 200K+ tokens.
- `postCompactionMaxChars`: AGENTS.md excerpt cap used during post-compaction
  refresh injection.

### `agents.entries.*.contextLimits`

Per-agent override for the shared `contextLimits` knobs. Omitted fields inherit
from `agents.defaults.contextLimits`.

```json5
{
  agents: {
    defaults: {
      contextLimits: { memoryGetMaxChars: 12000 },
    },
    entries: {
      "tiny-local": {
        contextLimits: {
          memoryGetMaxChars: 6000,
        },
      },
    },
  },
}
```

### `skills.limits.maxSkillsPromptChars`

Global cap for the compact skills list injected into the system prompt. This
does not affect reading `SKILL.md` files on demand.

```json5
{
  skills: { limits: { maxSkillsPromptChars: 18000 } },
}
```

### `agents.entries.*.skillsLimits.maxSkillsPromptChars`

Per-agent override for the skills prompt budget.

```json5
{
  agents: {
    entries: {
      "tiny-local": { skillsLimits: { maxSkillsPromptChars: 6000 } },
    },
  },
}
```

## `agents.defaults.imageMaxDimensionPx`

Max pixel size for the longest image side in transcript/tool image blocks before provider calls.
Default: `1200`.

Lower values usually reduce vision-token usage and request payload size for screenshot-heavy runs.
Higher values preserve more visual detail.

```json5
{
  agents: { defaults: { imageMaxDimensionPx: 1200 } },
}
```

## `agents.defaults.imageQuality`

Image-tool compression/detail preference for images loaded from file paths, URLs, and media references.
Default: `auto`.

OpenClaw adapts the resize ladder to the selected image model. For example, Claude Opus 4.8, OpenAI GPT-5.6 Sol, Qwen VL, and hosted Llama 4 vision models can use larger images than older/default high-detail vision paths, while multi-image turns are compressed more aggressively in `auto` mode to control token and latency cost.

Values:

- `auto`: adapt to model limits and image count.
- `efficient`: prefer smaller images for lower token and byte usage.
- `balanced`: use the standard middle-ground ladder.
- `high`: preserve more detail for screenshots, diagrams, and document images.

```json5
{
  agents: { defaults: { imageQuality: "auto" } },
}
```

## `agents.defaults.userTimezone`

Timezone for message envelopes, queued system events, and the system prompt's local
date context. Falls back to the host timezone.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```
