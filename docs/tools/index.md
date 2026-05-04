---
summary: "OpenClaw tools and plugins overview: what the agent can do and how to extend it"
read_when:
  - You want to understand what tools OpenClaw provides
  - You need to configure, allow, or deny tools
  - You are deciding between built-in tools, skills, and plugins
title: "Tools and plugins"
---

Everything the agent does beyond generating text happens through **tools**.
Tools are how the agent reads files, runs commands, browses the web, sends
messages, and interacts with devices.

## Tools, skills, and plugins

OpenClaw has three layers that work together:

<Steps>
  <Step title="Tools are what the agent calls">
    A tool is a typed function the agent can invoke (e.g. `exec`, `browser`,
    `web_search`, `message`). OpenClaw ships a set of **built-in tools** and
    plugins can register additional ones.

    The agent sees tools as structured function definitions sent to the model API.

  </Step>

  <Step title="Skills teach the agent when and how">
    A skill is a markdown file (`SKILL.md`) injected into the system prompt.
    Skills give the agent context, constraints, and step-by-step guidance for
    using tools effectively. Skills live in your workspace, in shared folders,
    or ship inside plugins.

    [Skills reference](/tools/skills) | [Creating skills](/tools/creating-skills)

  </Step>

  <Step title="Plugins package everything together">
    A plugin is a package that can register any combination of capabilities:
    channels, model providers, tools, skills, speech, realtime transcription,
    realtime voice, media understanding, image generation, video generation,
    web fetch, web search, and more. Some plugins are **core** (shipped with
    OpenClaw), others are **external** (published on npm by the community).

    [Install and configure plugins](/tools/plugin) | [Build your own](/plugins/building-plugins)

  </Step>
</Steps>

## Built-in tools

These tools ship with OpenClaw and are available without installing any plugins:

| Tool                                       | What it does                                                          | Page                                                         |
| ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `exec` / `process`                         | Run shell commands, manage background processes                       | [Exec](/tools/exec), [Exec Approvals](/tools/exec-approvals) |
| `code_execution`                           | Run sandboxed remote Python analysis                                  | [Code Execution](/tools/code-execution)                      |
| `browser`                                  | Control a Chromium browser (navigate, click, screenshot)              | [Browser](/tools/browser)                                    |
| `web_search` / `x_search` / `web_fetch`    | Search the web, search X posts, fetch page content                    | [Web](/tools/web), [Web Fetch](/tools/web-fetch)             |
| `read` / `write` / `edit`                  | File I/O in the workspace                                             |                                                              |
| `apply_patch`                              | Multi-hunk file patches                                               | [Apply Patch](/tools/apply-patch)                            |
| `message`                                  | Send messages across all channels                                     | [Agent Send](/tools/agent-send)                              |
| `canvas`                                   | Drive node Canvas (present, eval, snapshot)                           |                                                              |
| `nodes`                                    | Discover and target paired devices                                    |                                                              |
| `cron` / `gateway`                         | Manage scheduled jobs; inspect, patch, restart, or update the gateway |                                                              |
| `image` / `image_generate`                 | Analyze or generate images                                            | [Image Generation](/tools/image-generation)                  |
| `music_generate`                           | Generate music tracks                                                 | [Music Generation](/tools/music-generation)                  |
| `video_generate`                           | Generate videos                                                       | [Video Generation](/tools/video-generation)                  |
| `tts`                                      | One-shot text-to-speech conversion                                    | [TTS](/tools/tts)                                            |
| `sessions_*` / `subagents` / `agents_list` | Session management, status, and sub-agent orchestration               | [Sub-agents](/tools/subagents)                               |
| `session_status`                           | Lightweight `/status`-style readback and session model override       | [Session Tools](/concepts/session-tool)                      |

For image work, use `image` for analysis and `image_generate` for generation or editing. If you target `openai/*`, `google/*`, `fal/*`, or another non-default image provider, configure that provider's auth/API key first.

For music work, use `music_generate`. If you target `google/*`, `minimax/*`, or another non-default music provider, configure that provider's auth/API key first.

For video work, use `video_generate`. If you target `qwen/*` or another non-default video provider, configure that provider's auth/API key first.

For workflow-driven audio generation, use `music_generate` when a plugin such as
ComfyUI registers it. This is separate from `tts`, which is text-to-speech.

`session_status` is the lightweight status/readback tool in the sessions group.
It answers `/status`-style questions about the current session and can
optionally set a per-session model override; `model=default` clears that
override. Like `/status`, it can backfill sparse token/cache counters and the
active runtime model label from the latest transcript usage entry.

`gateway` is the owner-only runtime tool for gateway operations:

- `config.schema.lookup` for one path-scoped config subtree before edits
- `config.get` for the current config snapshot + hash
- `config.patch` for partial config updates with restart
- `config.apply` only for full-config replacement
- `update.run` for explicit self-update + restart

For partial changes, prefer `config.schema.lookup` then `config.patch`. Use
`config.apply` only when you intentionally replace the entire config.
For broader config docs, read [Configuration](/gateway/configuration) and
[Configuration reference](/gateway/configuration-reference).
The tool also refuses to change `tools.exec.ask` or `tools.exec.security`;
legacy `tools.bash.*` aliases normalize to the same protected exec paths.

### Plugin-provided tools

Plugins can register additional tools. Some examples:

- [Diffs](/tools/diffs) — diff viewer and renderer
- [LLM Task](/tools/llm-task) — JSON-only LLM step for structured output
- [Lobster](/tools/lobster) — typed workflow runtime with resumable approvals
- [Music Generation](/tools/music-generation) — shared `music_generate` tool with workflow-backed providers
- [OpenProse](/prose) — markdown-first workflow orchestration
- [Tokenjuice](/tools/tokenjuice) — compact noisy `exec` and `bash` tool results

Plugin tools are still authored with `api.registerTool(...)` and declared in
the plugin manifest's `contracts.tools` list. OpenClaw captures the validated
tool descriptor during discovery and caches it by plugin source and contract, so
later tool planning can skip plugin runtime loading. Tool execution still loads
the owning plugin and calls the live registered implementation.

## Tool configuration

### Allow and deny lists

Control which tools the agent can call via `tools.allow` / `tools.deny` in
config. Deny always wins over allow.

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

OpenClaw fails closed when an explicit allowlist resolves to no callable tools.
For example, `tools.allow: ["query_db"]` only works if a loaded plugin actually
registers `query_db`. If no built-in, plugin, or bundled MCP tool matches the
allowlist, the run stops before the model call instead of continuing as a
text-only run that could hallucinate tool results.

### Tool profiles

`tools.profile` sets a base allowlist before `allow`/`deny` is applied.
Per-agent override: `agents.list[].tools.profile`.

| Profile     | What it includes                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`      | All core and optional plugin tools; unrestricted baseline for broader command/control access                                                      |
| `coding`    | `group:fs`, `group:runtime`, `group:web`, `group:sessions`, `group:memory`, `cron`, `image`, `image_generate`, `music_generate`, `video_generate` |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`                                                         |
| `minimal`   | `session_status` only                                                                                                                             |

<Note>
`tools.profile: "messaging"` is intentionally narrow for channel-focused
agents. It leaves out broader command/control tools such as filesystem, runtime,
browser, canvas, nodes, cron, and gateway control. Use `tools.profile: "full"`
as the unrestricted baseline for broader command/control access, then trim
access with `tools.allow` / `tools.deny` when needed.
</Note>

`coding` includes lightweight web tools (`web_search`, `web_fetch`, `x_search`)
but not the full browser-control tool. Browser automation can drive real
sessions and logged-in profiles, so add it explicitly with
`tools.alsoAllow: ["browser"]` or a per-agent
`agents.list[].tools.alsoAllow: ["browser"]`.

<Note>
Configuring `tools.exec` or `tools.fs` under a restrictive profile (`messaging`, `minimal`) does not implicitly widen the profile's allowlist. Add explicit `tools.alsoAllow` entries (for example `["exec", "process"]` for exec, or `["read", "write", "edit"]` for fs) when you want a restrictive profile to use those configured sections. OpenClaw logs a startup warning when a config section is present without a matching `alsoAllow` grant.
</Note>

The `coding` and `messaging` profiles also allow configured bundle MCP tools
under the plugin key `bundle-mcp`. Add `tools.deny: ["bundle-mcp"]` when you
want a profile to keep its normal built-ins but hide all configured MCP tools.
The `minimal` profile does not include bundle MCP tools.

Example (broadest tool surface by default):

```json5
{
  tools: {
    profile: "full",
  },
}
```

### Tool groups

Use `group:*` shorthands in allow/deny lists:

| Group              | Tools                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `group:runtime`    | exec, process, code_execution (`bash` is accepted as an alias for `exec`)                                 |
| `group:fs`         | read, write, edit, apply_patch                                                                            |
| `group:sessions`   | sessions_list, sessions_history, sessions_send, sessions_spawn, sessions_yield, subagents, session_status |
| `group:memory`     | memory_search, memory_get                                                                                 |
| `group:web`        | web_search, x_search, web_fetch                                                                           |
| `group:ui`         | browser, canvas                                                                                           |
| `group:automation` | cron, gateway                                                                                             |
| `group:messaging`  | message                                                                                                   |
| `group:nodes`      | nodes                                                                                                     |
| `group:agents`     | agents_list                                                                                               |
| `group:media`      | image, image_generate, music_generate, video_generate, tts                                                |
| `group:openclaw`   | All built-in OpenClaw tools (excludes plugin tools)                                                       |

`sessions_history` returns a bounded, safety-filtered recall view. It strips
thinking tags, `<relevant-memories>` scaffolding, plain-text tool-call XML
payloads (including `<tool_call>...</tool_call>`,
`<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`,
`<function_calls>...</function_calls>`, and truncated tool-call blocks),
downgraded tool-call scaffolding, leaked ASCII/full-width model control
tokens, and malformed MiniMax tool-call XML from assistant text, then applies
redaction/truncation and possible oversized-row placeholders instead of acting
as a raw transcript dump.

### Provider-specific restrictions

Use `tools.byProvider` to restrict tools for specific providers without
changing global defaults:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```
