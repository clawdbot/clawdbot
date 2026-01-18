---
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists)"
read_when:
  - You want to add a new agent tool in a plugin
  - You need to make a tool opt-in via allowlists
---
# Plugin agent tools

Clawdbot plugins can register **agent tools** (JSON‑schema functions) that are exposed
to the LLM during agent runs. Tools can be **required** (always available) or
**optional** (opt‑in).

Agent tools are configured under `tools` in the main config, or per‑agent under
`agents.list[].tools`. The allowlist/denylist policy controls which tools the agent
can call.

## Basic tool

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Optional tool (opt‑in)

Optional tools are **never** auto‑enabled. Users must add them to an agent
allowlist.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Enable optional tools in `agents.list[].tools.allow` (or global `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool",  // specific tool name
            "workflow",       // plugin id (enables all tools from that plugin)
            "group:plugins"   // all plugin tools
          ]
        }
      }
    ]
  }
}
```

Other config knobs that affect tool availability:
- `tools.profile` / `agents.list[].tools.profile` (base allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider‑specific allow/deny)
- `tools.sandbox.tools.*` (sandbox tool policy when sandboxed)

## Rules + tips

- Tool names must **not** clash with core tool names; conflicting tools are skipped.
- Plugin ids used in allowlists must not clash with core tool names.
- Prefer `optional: true` for tools that trigger side effects or require extra
  binaries/credentials.
