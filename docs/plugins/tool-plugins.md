---
summary: "Build simple typed agent tools with defineToolPlugin and openclaw plugins init/build/validate"
title: "Tool plugins"
sidebarTitle: "Tool Plugins"
read_when:
  - You want to build a simple OpenClaw plugin that only adds agent tools
  - You want to use defineToolPlugin instead of hand-writing plugin manifest metadata
  - You need to scaffold, generate, validate, test, or publish a tool-only plugin
---

`defineToolPlugin` builds a plugin that only adds agent-callable tools: no
channel, model provider, hook, service, or setup backend. It generates the
manifest metadata OpenClaw needs to discover tools without loading plugin
runtime code.

For provider, channel, hook, service, or mixed-capability plugins, start with
[Building plugins](/plugins/building-plugins), [Channel Plugins](/plugins/sdk-channel-plugins),
or [Provider Plugins](/plugins/sdk-provider-plugins) instead.

## Requirements

- Node 22.22.3+, Node 24.15+, or Node 25.9+.
- TypeScript ESM package output.
- `typebox` in `dependencies` (not just `devDependencies` - the generated
  plugin imports it at runtime).
- `openclaw >=2026.5.17`, the first version that exports
  `openclaw/plugin-sdk/tool-plugin`.
- A package root that ships `dist/`, `openclaw.plugin.json`, and
  `package.json`.

## Quickstart

```bash
openclaw plugins init stock-quotes --name "Stock Quotes"
cd stock-quotes
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

`plugins init` scaffolds:

| File                   | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `src/index.ts`         | `defineToolPlugin` entry with one `echo` tool                     |
| `src/index.test.ts`    | Metadata test asserting the tool list                             |
| `tsconfig.json`        | NodeNext TypeScript output to `dist/`                             |
| `vitest.config.ts`     | Vitest config for `src/**/*.test.ts`                              |
| `package.json`         | Scripts, runtime deps, `openclaw.extensions: ["./dist/index.js"]` |
| `openclaw.plugin.json` | Generated manifest metadata for the initial tool                  |

`npm run plugin:build` runs `npm run build` (tsc) then
`openclaw plugins build --entry ./dist/index.js`. `npm run plugin:validate`
rebuilds and runs `openclaw plugins validate --entry ./dist/index.js`.
Successful validation prints:

```text
Plugin stock-quotes is valid.
```

`openclaw plugins init <id>` options:

| Flag                 | Default            | Effect                                 |
| -------------------- | ------------------ | -------------------------------------- |
| `--directory <path>` | `<id>`             | Output directory                       |
| `--name <name>`      | Title-cased `<id>` | Display name                           |
| `--type <type>`      | `tool`             | Scaffold type: `tool` or `provider`    |
| `--force`            | off                | Overwrite an existing output directory |

## Write a tool

`defineToolPlugin` takes plugin identity, an optional config schema, and a
static list of tools. Parameter and config types are inferred from the
TypeBox schemas.

```typescript
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "stock-quotes",
  name: "Stock Quotes",
  description: "Fetch stock quote snapshots.",
  configSchema: Type.Object({
    apiKey: Type.Optional(Type.String({ description: "Quote API key." })),
    baseUrl: Type.Optional(Type.String({ description: "Quote API base URL." })),
  }),
  tools: (tool) => [
    tool({
      name: "stock_quote",
      label: "Stock Quote",
      description: "Fetch a stock quote snapshot.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Ticker symbol, for example OPEN." }),
      }),
      outputSchema: Type.Object(
        {
          symbol: Type.String(),
          configured: Type.Boolean(),
          baseUrl: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute({ symbol }, config, context) {
        context.signal?.throwIfAborted();
        return {
          symbol: symbol.toUpperCase(),
          configured: Boolean(config.apiKey),
          baseUrl: config.baseUrl ?? "https://api.example.com",
        };
      },
    }),
  ],
});
```

Tool names are the stable API. Pick names that are unique, lowercase, and
specific enough to avoid collisions with core tools or other plugins.

## Optional and factory tools

Set `optional: true` when users should explicitly allowlist the tool before it
is sent to a model. `openclaw plugins build` writes the matching
`toolMetadata.<tool>.optional` manifest entry, so OpenClaw can see that the
tool is optional without loading plugin runtime code.

```typescript
tool({
  name: "workflow_run",
  description: "Run an external workflow.",
  parameters: Type.Object({ goal: Type.String() }),
  optional: true,
  execute: ({ goal }) => ({ queued: true, goal }),
});
```

Use `factory` when a tool needs the runtime tool context before it can be
created - to opt out for a specific run, inspect sandbox state, or bind
runtime helpers. Metadata stays static even though the concrete tool is built
at runtime.

```typescript
tool({
  name: "local_workflow",
  description: "Run a local workflow outside sandboxed sessions.",
  parameters: Type.Object({ goal: Type.String() }),
  optional: true,
  factory({ api, toolContext }) {
    if (toolContext.sandboxed) {
      return null;
    }
    return createLocalWorkflowTool(api);
  },
});
```

Factories still declare a fixed tool name up front. Use `definePluginEntry`
directly when the plugin computes tool names dynamically or combines tools
with hooks, services, providers, or commands.

## Return values

`defineToolPlugin` wraps plain return values into the OpenClaw tool-result
format:

- Return a string when the model should see that exact text.
- Return a JSON-compatible value when you want the model to see formatted JSON
  and OpenClaw to keep the original value in `details`.

```typescript
tool({
  name: "echo_text",
  description: "Echo input text.",
  parameters: Type.Object({
    input: Type.String(),
  }),
  execute: ({ input }) => input,
});
```

```typescript
tool({
  name: "echo_json",
  description: "Echo input as structured JSON.",
  parameters: Type.Object({
    input: Type.String(),
  }),
  execute: ({ input }) => ({ input, length: input.length }),
});
```

Use a factory tool when you need a custom `AgentToolResult` or want to reuse an
existing `api.registerTool` implementation.

## Output contracts

Add `outputSchema` when a tool returns stable JSON-compatible data. It describes
the original value stored in `AgentToolResult.details`, not the formatted text
in `content`:

```typescript
tool({
  name: "shipment_list",
  description: "List shipments.",
  parameters: Type.Object({
    buyer: Type.Optional(Type.String()),
  }),
  outputSchema: Type.Array(
    Type.Object(
      {
        id: Type.String(),
        buyer: Type.String(),
        paid: Type.Boolean(),
        tons: Type.Number(),
      },
      { additionalProperties: false },
    ),
  ),
  execute: ({ buyer }) => listShipments(buyer),
});
```

[Code Mode](/tools/code-mode) and [Tool Search](/tools/tool-search) turn this
schema into a bounded TypeScript-style output hint. That lets a model call and
transform a known result in one program instead of spending another model turn
observing its shape.

OpenClaw compiles the schema before executing a catalog call, then validates the
final `details` value after tool hooks before returning it through the bridge.
An invalid schema cannot run the tool; a result mismatch fails the completed
call. Include every non-throwing result variant, including structured error
variants, or omit the schema when the result is not stable. Do not put secrets
or sensitive values in schema descriptions because trusted output metadata can
become model-visible.
Use `{ additionalProperties: false }` on object layers when you want a complete
compact output hint; open or truncated schemas remain available through
`tools.describe(...)` but are not advertised as complete quick-index contracts.

Factory tools declare `outputSchema` on the concrete `AnyAgentTool` they
return. The static `tool({ factory })` declaration does not accept a separate
output schema because it could drift from the runtime tool.

## Configuration

`configSchema` is optional. Omit it and OpenClaw applies a strict empty object
schema; the generated manifest still includes `configSchema`.

```typescript
export default defineToolPlugin({
  id: "no-config-tools",
  name: "No Config Tools",
  description: "Adds tools that do not need configuration.",
  tools: () => [],
});
```

With a `configSchema`, the second `execute` argument is typed from it:

```typescript
const configSchema = Type.Object({
  apiKey: Type.String(),
});

export default defineToolPlugin({
  id: "configured-tools",
  name: "Configured Tools",
  description: "Adds configured tools.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "configured_ping",
      description: "Check whether configuration is available.",
      parameters: Type.Object({}),
      execute: (_params, config) => ({ hasKey: config.apiKey.length > 0 }),
    }),
  ],
});
```

OpenClaw reads plugin config from the plugin's entry in the Gateway config. Do
not hard-code secrets in source or docs examples; use config, environment
variables, or SecretRefs per the plugin's security model.

## Generated metadata

OpenClaw must read the plugin manifest before importing plugin runtime code.
`defineToolPlugin` exposes static metadata for this, and
`openclaw plugins build` writes it into the package. Rerun the generator after
changing plugin id, name, description, config schema, activation, or tool
names:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js
```

Generated manifest for a one-tool plugin:

```json
{
  "id": "stock-quotes",
  "name": "Stock Quotes",
  "description": "Fetch stock quote snapshots.",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "activation": {
    "onStartup": true
  },
  "contracts": {
    "tools": ["stock_quote"]
  }
}
```

`contracts.tools` is the important discovery contract: it tells OpenClaw which
plugin owns each tool without loading every installed plugin's runtime. A
stale manifest means a tool can go missing from discovery, or a registration
error gets blamed on the wrong plugin.

## Package metadata

`openclaw plugins build` also aligns `package.json` to the selected runtime
entry:

```json
{
  "type": "module",
  "files": ["dist", "openclaw.plugin.json", "README.md"],
  "dependencies": {
    "typebox": "^1.1.38"
  },
  "peerDependencies": {
    "openclaw": ">=2026.5.17"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

Ship built JavaScript (`./dist/index.js`), not a TypeScript source entry.
Source entries only work for workspace-local development.

## Validate in CI

`plugins build --check` fails without rewriting files when generated metadata
is stale:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js --check
openclaw plugins validate --entry ./dist/index.js
npm test
```

OpenClaw SDK compatibility fields carry TypeScript `@deprecated` annotations,
which editors surface as migration warnings. To enforce them in CI, enable a
type-aware rule such as
[`@typescript-eslint/no-deprecated`](https://typescript-eslint.io/rules/no-deprecated/).
Oxlint is not type-aware, so it cannot enforce these annotations. The generated
`plugins init` scaffold therefore does not add a deprecation lint config.

`plugins validate` checks that:

- `openclaw.plugin.json` exists and passes the normal manifest loader.
- The current entry exports `defineToolPlugin` metadata.
- Generated manifest fields match the entry metadata.
- `contracts.tools` matches the declared tool names.
- `package.json` points `openclaw.extensions` at the selected runtime entry.

## Install and inspect locally

From a separate OpenClaw checkout or installed CLI, install the package path:

```bash
openclaw plugins install ./stock-quotes
openclaw plugins inspect stock-quotes --runtime
```

For a packaged smoke test, pack first and install the tarball:

```bash
npm pack
openclaw plugins install npm-pack:./openclaw-plugin-stock-quotes-0.1.0.tgz
openclaw plugins inspect stock-quotes --runtime --json
```

After installing, restart or reload the Gateway and ask the agent to use the
tool. If the tool is not visible, inspect the plugin runtime and the effective
tool catalog before changing code (see [Troubleshooting](#troubleshooting)).

## Publish

Publish through ClawHub once the package is ready. `clawhub package publish`
takes a source: a local folder, a GitHub repo (`owner/repo[@ref]`), or a
tarball URL.

```bash
clawhub package publish ./stock-quotes --dry-run
clawhub package publish ./stock-quotes
```

Install with an explicit ClawHub locator:

```bash
openclaw plugins install clawhub:your-org/stock-quotes
```

Bare npm package specs still install from npm during the launch cutover, but
ClawHub is the preferred discovery and distribution surface for OpenClaw
plugins. See [ClawHub publishing](/clawhub/publishing) for owner scope and
release review.

## Troubleshooting

### `plugin entry not found: ./dist/index.js`

The selected entry file does not exist. Run `npm run build`, then rerun
`openclaw plugins build --entry ./dist/index.js` or
`openclaw plugins validate --entry ./dist/index.js`.

### `plugin entry does not expose defineToolPlugin metadata`

The entry did not export a value created by `defineToolPlugin`. Confirm the
module's default export is the `defineToolPlugin(...)` result, or pass the
correct entry with `--entry`.

### `openclaw.plugin.json generated metadata is stale`

The manifest no longer matches the entry metadata. Run:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js
```

Commit both `openclaw.plugin.json` and `package.json` changes.

### `package.json openclaw.extensions must include ./dist/index.js`

The package metadata points at a different runtime entry. Run
`openclaw plugins build --entry ./dist/index.js` so the generator aligns
package metadata with the entry you intend to ship.

### `Cannot find package 'typebox'`

The built plugin imports `typebox` at runtime. Keep it in `dependencies`,
reinstall, rebuild, and rerun validation.

### Tool does not appear after install

Check these in order:

1. `openclaw plugins inspect <plugin-id> --runtime`
2. `openclaw plugins validate --root <plugin-root> --entry ./dist/index.js`
3. `openclaw.plugin.json` has `contracts.tools` with the expected tool names.
4. `package.json` has `openclaw.extensions: ["./dist/index.js"]`.
5. The Gateway was restarted or reloaded after installing the plugin.

## See also

- [Building plugins](/plugins/building-plugins)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Plugin SDK subpaths](/plugins/sdk-subpaths)
- [Plugin manifest](/plugins/manifest)
- [Plugins CLI](/cli/plugins)
- [ClawHub publishing](/clawhub/publishing)
