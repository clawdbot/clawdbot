---
summary: "Build simple typed agent tools with defineToolPlugin and openclaw plugins init/build/validate"
title: "Tool plugins"
sidebarTitle: "Tool Plugins"
read_when:
  - You want to build a simple OpenClaw plugin that only adds agent tools
  - You want to use defineToolPlugin instead of hand-writing plugin manifest metadata
  - You need to scaffold, generate, validate, test, or publish a tool-only plugin
---

Tool plugins add agent-callable tools to OpenClaw without adding a channel,
model provider, hook, service, or setup backend. Use `defineToolPlugin` when the
plugin owns a fixed list of tools and you want OpenClaw to generate the manifest
metadata that keeps those tools discoverable without loading runtime code.

The recommended flow is:

1. Scaffold a package with `openclaw plugins init`.
2. Write tools with `defineToolPlugin`.
3. Build JavaScript.
4. Generate `openclaw.plugin.json` and `package.json` metadata with
   `openclaw plugins build`.
5. Validate the generated metadata before publishing or installing.

For provider, channel, hook, service, or mixed-capability plugins, start with
[Building plugins](/plugins/building-plugins), [Channel Plugins](/plugins/sdk-channel-plugins),
or [Provider Plugins](/plugins/sdk-provider-plugins) instead.

## Requirements

- Node >= 22.
- TypeScript ESM package output.
- `typebox` for config and tool parameter schemas.
- `openclaw >=2026.5.17`, the first OpenClaw version that exports
  `openclaw/plugin-sdk/tool-plugin`.
- A package root that can ship `dist/`, `openclaw.plugin.json`, and
  `package.json`.

The generated plugin imports `typebox` at runtime, so keep `typebox` in
`dependencies`, not only `devDependencies`.

## Quickstart

Create a new plugin package:

```bash
openclaw plugins init stock-quotes --name "Stock Quotes"
cd stock-quotes
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

The scaffold creates:

- `src/index.ts`: a `defineToolPlugin` entry with an `echo` tool.
- `src/index.test.ts`: a small metadata test.
- `tsconfig.json`: NodeNext TypeScript output to `dist/`.
- `package.json`: scripts, runtime dependencies, and
  `openclaw.extensions: ["./dist/index.js"]`.
- `openclaw.plugin.json`: generated manifest metadata for the initial tool.

Expected validation output:

```text
Plugin stock-quotes is valid.
```

## Write a tool

`defineToolPlugin` takes plugin identity, an optional config schema, and a
static list of tools. Parameter and config types are inferred from TypeBox
schemas.

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
is sent to a model:

```typescript
tool({
  name: "workflow_run",
  description: "Run an external workflow.",
  parameters: Type.Object({ goal: Type.String() }),
  optional: true,
  execute: ({ goal }) => ({ queued: true, goal }),
});
```

`openclaw plugins build` writes the matching `toolMetadata.<tool>.optional`
manifest entry, so OpenClaw can discover the tool without loading plugin
runtime code.

Use `factory` when a tool needs the runtime tool context before it can be
created. The factory keeps metadata static while letting the tool opt out for a
specific run, inspect sandbox state, or bind runtime helpers.

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

Factories are still for fixed tool names. Use `definePluginEntry` directly when
the plugin computes tool names dynamically or combines tools with hooks,
services, providers, commands, or other runtime surfaces.

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

Use a factory tool when you need to return a custom `AgentToolResult` or reuse
an existing `api.registerTool` implementation. Use `definePluginEntry` instead
of `defineToolPlugin` when you need fully dynamic tools or mixed plugin
capabilities.

## Configuration

`configSchema` is optional. If you omit it, OpenClaw uses a strict empty object
schema and the generated manifest still includes `configSchema`.

```typescript
export default defineToolPlugin({
  id: "no-config-tools",
  name: "No Config Tools",
  description: "Adds tools that do not need configuration.",
  tools: () => [],
});
```

When you include `configSchema`, the second `execute` argument is typed from the
schema:

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

OpenClaw reads plugin config from the plugin entry in the Gateway config. Do not
hard-code secrets in source or in docs examples. Use config, environment
variables, or SecretRefs according to the plugin's security model.

## Generated metadata

OpenClaw discovers installed plugins from cold metadata. It must be able to read
the plugin manifest before importing plugin runtime code. `defineToolPlugin`
therefore exposes static metadata, and `openclaw plugins build` writes that
metadata into the package.

Run the generator after changing plugin id, name, description, config schema,
activation, or tool names:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js
```

For a one-tool plugin, the generated manifest looks like this:

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

`contracts.tools` is the important discovery contract. It tells OpenClaw which
plugin owns each tool without loading every installed plugin runtime. If the
manifest is stale, the tool may be missing from discovery or the wrong plugin
may be blamed for a registration error.

## Package metadata

For the simple tool-plugin workflow, `openclaw plugins build` aligns
`package.json` to the selected single runtime entry:

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

Use built JavaScript such as `./dist/index.js` for installed packages. Source
entries are useful in workspace development, but published packages should not
depend on TypeScript runtime loading.

## Validate in CI

Use `plugins build --check` to fail CI when generated metadata is stale without
rewriting files:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js --check
openclaw plugins validate --entry ./dist/index.js
npm test
```

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

For a packaged smoke, pack first and install the tarball:

```bash
npm pack
openclaw plugins install npm-pack:./openclaw-plugin-stock-quotes-0.1.0.tgz
openclaw plugins inspect stock-quotes --runtime --json
```

After installation, start or restart the Gateway and ask the agent to use the
tool. If you are debugging tool visibility, inspect the plugin runtime and the
effective tool catalog before changing the code.

## Publish

Publish through ClawHub when the package is ready:

```bash
clawhub package publish your-org/stock-quotes --dry-run
clawhub package publish your-org/stock-quotes
```

Install with an explicit ClawHub locator:

```bash
openclaw plugins install clawhub:your-org/stock-quotes
```

Bare npm package specs remain supported during the launch cutover, but ClawHub
is the preferred discovery and distribution surface for OpenClaw plugins.

## Troubleshooting

### `plugin entry not found: ./dist/index.js`

The selected entry file does not exist. Run `npm run build`, then rerun
`openclaw plugins build --entry ./dist/index.js` or
`openclaw plugins validate --entry ./dist/index.js`.

### `plugin entry does not expose defineToolPlugin metadata`

The entry did not export a value created by `defineToolPlugin`. Check that the
module default export is the `defineToolPlugin(...)` result, or pass the correct
entry with `--entry`.

### `openclaw.plugin.json generated metadata is stale`

The manifest no longer matches the entry metadata. Run:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js
```

Commit both `openclaw.plugin.json` and `package.json` changes.

### `package.json openclaw.extensions must include ./dist/index.js`

The package metadata points at a different runtime entry. Run
`openclaw plugins build --entry ./dist/index.js` so the generator aligns the
package metadata with the entry you intend to ship.

### `Cannot find package 'typebox'`

The built plugin imports `typebox` at runtime. Keep `typebox` in
`dependencies`, reinstall package dependencies, rebuild, and rerun validation.

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
