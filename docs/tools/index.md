---
doc-schema-version: 1
summary: "OpenClaw tools, skills, and plugins overview: what agents can call and how to extend them"
read_when:
  - You want to understand what tools OpenClaw provides
  - You are deciding between built-in tools, skills, and plugins
  - You need the right docs entry point for tool policy, automation, or agent coordination
title: "Overview"
---

Use this page to choose the right Capabilities surface. **Tools** are callable
actions, **skills** teach agents how to work, and **plugins** add runtime
capabilities such as tools, providers, channels, hooks, and packaged skills.

This is an overview and routing page. For exhaustive tool policy, defaults,
group membership, provider restrictions, and configuration fields, use
[Tools and custom providers](/gateway/config-tools).

## Start here

For most agents, start with the built-in tool categories, then adjust policy
only when the agent should see fewer tools or needs explicit host access.

| If you need to...                           | Use this first                                 | Then read                                                               |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Let an agent act with existing capabilities | [Built-in tools](#built-in-tool-categories)    | [Tool categories](#built-in-tool-categories)                            |
| Control what an agent can call              | [Tool policy](#configure-access-and-approvals) | [Tools and custom providers](/gateway/config-tools)                     |
| Teach an agent a workflow                   | [Skills](#choose-tools-skills-or-plugins)      | [Skills](/tools/skills) and [Creating skills](/tools/creating-skills)   |
| Add a new integration or runtime surface    | [Plugins](#extend-capabilities)                | [Plugins](/tools/plugin) and [Build plugins](/plugins/building-plugins) |
| Run work later or in the background         | [Automation](/automation)                      | [Automation overview](/automation)                                      |
| Coordinate multiple agents or harnesses     | [Sub-agents](/tools/subagents)                 | [ACP agents](/tools/acp-agents) and [Agent send](/tools/agent-send)     |
| Search a large PI tool catalog              | [Tool Search](/tools/tool-search)              | [Tool Search](/tools/tool-search)                                       |

## Choose tools, skills, or plugins

<Steps>
  <Step title="Use a tool when the agent needs to act">
    A tool is a typed function the agent can call, such as `exec`, `browser`,
    `web_search`, `message`, or `image_generate`. Use tools when the agent
    needs to read data, change files, send messages, call a provider, or operate
    another system. Visible tools are sent to the model as structured function
    definitions.

    The model only sees tools that survive the active profile, allow/deny
    policy, provider restrictions, sandbox state, channel permissions, and
    plugin availability.

  </Step>

  <Step title="Use a skill when the agent needs instructions">
    A skill is a `SKILL.md` instruction pack loaded into the agent prompt. Use a
    skill when the agent already has the tools it needs, but needs a repeatable
    workflow, review rubric, command sequence, or operating constraint.

    Skills can live in a workspace, shared skill directory, managed OpenClaw
    skill root, or plugin package.

    [Skills](/tools/skills) | [Creating skills](/tools/creating-skills) | [Skills config](/tools/skills-config)

  </Step>

  <Step title="Use a plugin when OpenClaw needs a new capability">
    A plugin can add tools, skills, channels, model providers, speech, realtime
    voice, media generation, web search, web fetch, hooks, and other runtime
    capabilities. Use a plugin when the capability has code, credentials,
    lifecycle hooks, manifest metadata, or installable packaging. Existing
    plugins can be installed from ClawHub, npm, git, local directories, or
    archives.

    [Install and configure plugins](/tools/plugin) | [Build plugins](/plugins/building-plugins) | [Plugin SDK](/plugins/sdk-overview)

  </Step>
</Steps>

## Built-in tool categories

The table lists representative tools so you can recognize the surface. It is
not the full policy reference. For exact groups, defaults, and allow/deny
semantics, use [Tools and custom providers](/gateway/config-tools).

| Category               | Use when the agent needs to...                                                | Representative tools                                                 | Read next                                                              |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime                | Run commands, manage processes, or use provider-backed Python analysis        | `exec`, `process`, `code_execution`                                  | [Exec](/tools/exec), [Code execution](/tools/code-execution)           |
| Files                  | Read and change workspace files                                               | `read`, `write`, `edit`, `apply_patch`                               | [Apply patch](/tools/apply-patch)                                      |
| Web                    | Search the web, search X posts, or fetch readable page content                | `web_search`, `x_search`, `web_fetch`                                | [Web tools](/tools/web), [Web fetch](/tools/web-fetch)                 |
| Browser                | Operate a browser session                                                     | `browser`                                                            | [Browser](/tools/browser)                                              |
| Messaging and channels | Send replies or channel actions                                               | `message`                                                            | [Agent send](/tools/agent-send)                                        |
| Sessions and agents    | Inspect sessions, delegate work, steer another run, or report status          | `sessions_*`, `subagents`, `agents_list`, `session_status`           | [Sub-agents](/tools/subagents), [Session tool](/concepts/session-tool) |
| Automation             | Schedule work or respond to background events                                 | `cron`, `heartbeat_respond`                                          | [Automation](/automation)                                              |
| Gateway and nodes      | Inspect Gateway state or paired target devices                                | `gateway`, `nodes`                                                   | [Gateway configuration](/gateway/configuration), [Nodes](/nodes)       |
| Media                  | Analyze, generate, or speak media                                             | `image`, `image_generate`, `music_generate`, `video_generate`, `tts` | [Media overview](/tools/media-overview)                                |
| Large PI catalogs      | Search and call many eligible tools without sending every schema to the model | `tool_search_code`, `tool_search`, `tool_describe`                   | [Tool Search](/tools/tool-search)                                      |

<Note>
Tool Search is an experimental PI-agent surface. Codex harness runs use
Codex-native code mode, native tool search, deferred dynamic tools, and nested
tool calls instead of `tools.toolSearch`.
</Note>

## Plugin-provided tools

Plugins can register additional tools. Plugin authors wire tools through
`api.registerTool(...)` and the manifest's `contracts.tools`; use
[Plugin SDK](/plugins/sdk-overview) and [Plugin manifest](/plugins/manifest)
for contract details.

Common plugin-provided tools include:

- [Diffs](/tools/diffs) for rendering file and markdown diffs
- [LLM Task](/tools/llm-task) for JSON-only workflow steps
- [Lobster](/tools/lobster) for typed workflows with resumable approvals
- [Tokenjuice](/tools/tokenjuice) for compacting noisy `exec` and `bash` tool
  output
- [Tool Search](/tools/tool-search) for discovering and calling large tool
  catalogs without putting every schema in the prompt
- [Canvas](/plugins/reference/canvas) for node Canvas control and A2UI
  rendering

## Configure access and approvals

Tool policy is enforced before the model call. If policy removes a tool, the
model does not receive that tool's schema for the turn. A run can lose tools
because of global config, per-agent config, channel policy, provider
restrictions, sandbox rules, owner-only gating, or plugin availability.

- [Tools and custom providers](/gateway/config-tools) documents tool profiles,
  allow/deny lists, provider-specific restrictions, loop detection, and
  provider-backed tool settings.
- [Exec approvals](/tools/exec-approvals) documents host command approval
  policy.
- [Elevated exec](/tools/elevated) documents controlled execution outside the
  sandbox.
- [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) explains which layer controls file and process access.
- [Per-agent sandbox and tool restrictions](/tools/multi-agent-sandbox-tools)
  documents agent-specific restrictions for delegated runs.

## Extend capabilities

Choose the extension path by the job you need OpenClaw to do:

- Install or manage an existing plugin with [Plugins](/tools/plugin).
- Build a new integration, provider, channel, tool, or hook with
  [Build plugins](/plugins/building-plugins).
- Add or tune reusable agent instructions with [Skills](/tools/skills) and
  [Creating skills](/tools/creating-skills).
- Package reusable workflow material with
  [Skill workshop](/plugins/skill-workshop) when the workflow belongs in a
  plugin-distributed skill bundle.
- Use [Plugin SDK](/plugins/sdk-overview) and [Plugin manifest](/plugins/manifest) when you need implementation contracts.

## Troubleshoot missing tools

If the model cannot see or call a tool, start with the effective policy for the
current turn:

1. Check the active profile, `tools.allow`, and `tools.deny` in
   [Tools and custom providers](/gateway/config-tools).
2. Check provider-specific restrictions in
   [Tools and custom providers](/gateway/config-tools) and confirm the selected
   [model provider](/concepts/model-providers) supports the tool shape.
3. Check channel permissions, sandbox state, and elevated access with
   [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) and [Elevated exec](/tools/elevated).
4. Check whether the owning plugin is installed and enabled in
   [Plugins](/tools/plugin).
5. For delegated runs, check per-agent restrictions in
   [Per-agent sandbox and tool restrictions](/tools/multi-agent-sandbox-tools).
6. For large PI catalogs, confirm whether the run uses direct tool exposure or
   [Tool Search](/tools/tool-search).

## Related

- [Automation](/automation) for cron, tasks, heartbeat, commitments, hooks, standing orders, and Task Flow
- [Agents](/concepts/agent) for the agent model, sessions, memory, and multi-agent coordination
- [Tools and custom providers](/gateway/config-tools) for the canonical tool policy reference
- [Plugins](/tools/plugin) for plugin installation and management
- [Plugin SDK](/plugins/sdk-overview) for plugin author reference
- [Skills](/tools/skills) for skill load order, gating, and config
- [Tool Search](/tools/tool-search) for compact PI tool catalog discovery
