---
summary: "Reference for defineToolPlugin, definePluginEntry, defineChannelPluginEntry, and defineSetupPluginEntry"
title: "Plugin entry points"
sidebarTitle: "Entry Points"
read_when:
  - You need the exact type signature of defineToolPlugin, definePluginEntry, or defineChannelPluginEntry
  - You want to understand registration mode (full vs setup vs CLI metadata)
  - You are looking up entry point options
---

Every plugin exports a default entry object. The SDK provides a helper for
each entry shape: `defineToolPlugin`, `definePluginEntry`,
`defineChannelPluginEntry`, `defineSetupPluginEntry`.

<Tip>
  **Looking for a walkthrough?** See [Tool Plugins](/plugins/tool-plugins),
  [Channel Plugins](/plugins/sdk-channel-plugins), or
  [Provider Plugins](/plugins/sdk-provider-plugins) for step-by-step guides.
</Tip>

## Package entries

Installed plugins point `package.json` `openclaw` fields at both source and
built entries:

```json
{
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "runtimeExtensions": ["./dist/index.js"],
    "setupEntry": "./src/setup-entry.ts",
    "runtimeSetupEntry": "./dist/setup-entry.js"
  }
}
```

- `extensions` and `setupEntry` are source entries, used for workspace and git
  checkout development.
- `runtimeExtensions` and `runtimeSetupEntry` are preferred for installed
  packages: they let npm packages skip runtime TypeScript compilation.
- `runtimeExtensions`, when present, must match `extensions` in array length
  (entries pair positionally). `runtimeSetupEntry` requires `setupEntry`.
- If a `runtimeExtensions`/`runtimeSetupEntry` artifact is declared but
  missing, install/discovery fails with a packaging error; OpenClaw does not
  silently fall back to source. Source fallback (below) only applies when no
  runtime entry is declared at all.
- If an installed package declares only a TypeScript source entry, OpenClaw
  looks for a matching built `dist/*.js` (or `.mjs`/`.cjs`) peer and uses it;
  otherwise it falls back to the TypeScript source.
- All entry paths must stay inside the plugin package directory. Runtime
  entries and inferred built-JS peers do not make an escaping `extensions` or
  `setupEntry` source path valid.

## `defineToolPlugin`

**Import:** `openclaw/plugin-sdk/tool-plugin`

For plugins that only add agent tools. Keeps the source small, infers config
and tool-parameter types from TypeBox schemas, wraps plain return values in
the OpenClaw tool-result format, and exposes static metadata that
`openclaw plugins build` writes into the plugin manifest (`contracts.tools`,
`configSchema`).

```typescript
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "stock-quotes",
  name: "Stock Quotes",
  description: "Fetch stock quotes.",
  configSchema: Type.Object({
    apiKey: Type.Optional(Type.String({ description: "API key." })),
  }),
  tools: (tool) => [
    tool({
      name: "quote",
      label: "Quote",
      description: "Fetch a quote.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Ticker symbol." }),
      }),
      outputSchema: Type.Object(
        {
          symbol: Type.String(),
          hasKey: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      execute: async ({ symbol }, config) => ({ symbol, hasKey: Boolean(config.apiKey) }),
    }),
  ],
});
```

- `configSchema` is optional; omitting it uses a strict empty object schema
  (the generated manifest still includes `configSchema`).
- `execute` returns a plain string or JSON-serializable value; the helper
  wraps it as a text tool result with `details` set to the original
  (unstringified) return value.
- `outputSchema` optionally describes that original `details` value for Code
  Mode and Tool Search. Catalog calls reject an invalid schema before execution
  and validate the final value before returning it.
- For custom tool results, `openclaw/plugin-sdk/tool-results` exports
  `textResult` and `jsonResult`.
- Tool names are static, so `openclaw plugins build` derives
  `contracts.tools` from the declared tools without hand-duplicated names.
- Runtime loading stays strict: installed plugins still need
  `openclaw.plugin.json` and `package.json` `openclaw.extensions`. OpenClaw
  never executes plugin code to infer missing manifest data.

## `definePluginEntry`

**Import:** `openclaw/plugin-sdk/plugin-entry`

For provider plugins, advanced tool plugins, hook plugins, and anything that
is **not** a messaging channel.

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Short summary",
  register(api) {
    api.registerProvider({/* ... */});
    api.registerTool({/* ... */});
  },
});
```

| Field                     | Type                                                             | Required | Default             |
| ------------------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`                      | `string`                                                         | Yes      | -                   |
| `name`                    | `string`                                                         | Yes      | -                   |
| `description`             | `string`                                                         | Yes      | -                   |
| `kind`                    | `string` (deprecated, see below)                                 | No       | -                   |
| `configSchema`            | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `reload`                  | `OpenClawPluginReloadRegistration`                               | No       | -                   |
| `nodeHostCommands`        | `OpenClawPluginNodeHostCommand[]`                                | No       | -                   |
| `securityAuditCollectors` | `OpenClawPluginSecurityAuditCollector[]`                         | No       | -                   |
| `register`                | `(api: OpenClawPluginApi) => void`                               | Yes      | -                   |

- `id` must match your `openclaw.plugin.json` manifest.
- External session catalogs use
  `openclaw/plugin-sdk/session-catalog` and
  `api.registerSessionCatalog({ id, label, list, read, continueSession?, archive? })`.
  Core owns the `sessions.catalog.*` Gateway methods; providers return host,
  session, and normalized transcript projections without registering RPCs. A
  list provider should call the optional `onHost(host)` callback as each host
  settles; the returned host array remains required as the final compatibility
  snapshot.
- `kind` is deprecated: declare an exclusive slot (`"memory"` or
  `"context-engine"`) in the `openclaw.plugin.json` manifest `kind` field
  instead. Runtime-entry `kind` remains only as a compatibility fallback for
  older plugins.
- `configSchema` can be a function for lazy evaluation. OpenClaw resolves and
  memoizes the schema on first access, so expensive schema builders only run
  once.
- A `nodeHostCommands` descriptor can define `isAvailable({ config, env })`.
  Returning `false` omits that command and its capability from the headless
  node's Gateway declaration. OpenClaw evaluates it against the node-local
  startup config; command handlers should still validate availability when
  invoked.

## `defineChannelPluginEntry`

**Import:** `openclaw/plugin-sdk/channel-core`

Wraps `definePluginEntry` with channel-specific wiring: it automatically
calls `api.registerChannel({ plugin })`, exposes an optional root-help CLI
metadata seam, and gates `registerFull` on registration mode.

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineChannelPluginEntry({
  id: "my-channel",
  name: "My Channel",
  description: "Short summary",
  plugin: myChannelPlugin,
  setRuntime: setMyRuntime,
  registerCliMetadata(api) {
    api.registerCli(/* ... */);
  },
  registerFull(api) {
    api.registerGatewayMethod(/* ... */);
  },
});
```

| Field                 | Type                                                             | Required | Default             |
| --------------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`                  | `string`                                                         | Yes      | -                   |
| `name`                | `string`                                                         | Yes      | -                   |
| `description`         | `string`                                                         | Yes      | -                   |
| `plugin`              | `ChannelPlugin`                                                  | Yes      | -                   |
| `configSchema`        | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `setRuntime`          | `(runtime: PluginRuntime) => void`                               | No       | -                   |
| `registerCliMetadata` | `(api: OpenClawPluginApi) => void`                               | No       | -                   |
| `registerFull`        | `(api: OpenClawPluginApi) => void`                               | No       | -                   |

Callbacks run per registration mode (full table under
[Registration mode](#registration-mode)):

- `setRuntime` runs in every mode except `"cli-metadata"` and
  `"tool-discovery"`. Store the runtime reference here, typically via
  `createPluginRuntimeStore`.
- `registerCliMetadata` runs for `"cli-metadata"`, `"discovery"`, and
  `"full"`. Use it as the canonical place for channel-owned CLI descriptors
  so root help stays non-activating, discovery snapshots include static
  command metadata, and normal CLI registration stays compatible with full
  plugin loads.
- `registerFull` runs only for `"full"` and `"tool-discovery"`. For
  `"tool-discovery"` it runs _instead of_ channel registration: OpenClaw
  skips `registerChannel`/`setRuntime` entirely and calls only
  `registerFull`, so any provider/tool registration your channel needs for
  standalone tool discovery or execution must live there, not behind normal
  channel setup.
- Discovery registration is non-activating, not import-free: OpenClaw may
  evaluate the trusted plugin entry and channel plugin module to build the
  snapshot. Keep top-level imports side-effect-free and put sockets,
  clients, workers, and services behind `"full"`-only paths.
- Like `definePluginEntry`, `configSchema` can be a lazy factory; OpenClaw
  memoizes the resolved schema on first access.

CLI registration:

- Use `api.registerCli(..., { descriptors: [...] })` for plugin-owned root
  CLI commands you want lazy-loaded without disappearing from the root CLI
  parse tree. Descriptor names must match letters, numbers, hyphen, and
  underscore, starting with a letter or number; OpenClaw rejects other
  shapes and strips terminal control sequences from descriptions before
  rendering help. Cover every top-level command root the registrar exposes.
  `commands` alone stays on the eager compatibility path.
- Use `api.registerNodeCliFeature(...)` for paired-node feature commands so
  they land under `openclaw nodes` (equivalent to
  `registerCli(registrar, { parentPath: ["nodes"], ... })`).
- For other nested plugin commands, add `parentPath` and register commands
  on the `program` object passed to the registrar; OpenClaw resolves it to
  the parent command before calling the plugin.
- For channel plugins, register CLI descriptors from `registerCliMetadata`
  and keep `registerFull` focused on runtime-only work.
- If `registerFull` also registers gateway RPC methods, keep them on a
  plugin-specific prefix. Reserved core admin namespaces (`config.*`,
  `exec.approvals.*`, `wizard.*`, `update.*`) always coerce to
  `operator.admin`.

## `defineSetupPluginEntry`

**Import:** `openclaw/plugin-sdk/channel-core`

For the lightweight `setup-entry.ts` file. Returns just `{ plugin }` with no
runtime or CLI wiring.

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineSetupPluginEntry(myChannelPlugin);
```

OpenClaw loads this instead of the full entry when a channel is disabled,
unconfigured, or when deferred loading is enabled. See
[Setup and Config](/plugins/sdk-setup#setup-entry) for when this matters.

Pair `defineSetupPluginEntry(...)` with the narrow setup helper families:

| Import                              | Use for                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw/plugin-sdk/setup-runtime` | Runtime-safe setup helpers: `createSetupTranslator`, import-safe setup patch adapters, lookup-note output, `promptResolvedAllowFrom`, `splitSetupEntries`, delegated setup proxies |
| `openclaw/plugin-sdk/channel-setup` | Optional-install setup surfaces                                                                                                                                                    |
| `openclaw/plugin-sdk/setup-tools`   | Setup/install CLI, archive, and docs helpers                                                                                                                                       |

Keep heavy SDKs, CLI registration, and long-lived runtime services in the
full entry.

Bundled workspace channels that split setup and runtime surfaces can use
`defineBundledChannelSetupEntry(...)` from
`openclaw/plugin-sdk/channel-entry-contract` instead. It lets the setup
entry keep setup-safe plugin/secrets exports while still exposing a runtime
setter:

```typescript
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "myChannelPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMyChannelRuntime",
  },
  registerSetupRuntime(api) {
    api.registerHttpRoute({
      path: "/my-channel/events",
      auth: "plugin",
      handler: async (req, res) => {
        /* setup-safe route */
      },
    });
  },
});
```

Use this only when a setup flow truly needs a lightweight runtime setter or
setup-safe gateway surface before the full channel entry loads.
`registerSetupRuntime` runs only for `"setup-runtime"` loads; keep it
limited to config-only routes or methods that must exist before deferred
full activation.

## Registration mode

`api.registrationMode` tells your plugin how it was loaded:

| Mode               | When                                               | What to register                                                                                                        |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `"full"`           | Normal gateway startup                             | Everything                                                                                                              |
| `"discovery"`      | Read-only capability discovery                     | Channel registration plus static CLI descriptors; entry code may load, but skip sockets, workers, clients, and services |
| `"tool-discovery"` | Scoped load to list or run specific plugins' tools | Capability/tool registration only; no channel activation                                                                |
| `"setup-only"`     | Disabled/unconfigured channel                      | Channel registration only                                                                                               |
| `"setup-runtime"`  | Setup flow with runtime available                  | Channel registration plus only the lightweight runtime needed before the full entry loads                               |
| `"cli-metadata"`   | Root help / CLI metadata capture                   | CLI descriptors only                                                                                                    |

`defineChannelPluginEntry` handles this split automatically. If you use
`definePluginEntry` directly for a channel, check mode yourself and remember
`"tool-discovery"` skips channel registration:

```typescript
register(api) {
  if (
    api.registrationMode === "cli-metadata" ||
    api.registrationMode === "discovery" ||
    api.registrationMode === "full"
  ) {
    api.registerCli(/* ... */);
    if (api.registrationMode === "cli-metadata") return;
  }

  if (api.registrationMode === "tool-discovery") {
    // Register capability-only surfaces (providers/tools), no channel.
    return;
  }

  api.registerChannel({ plugin: myPlugin });
  if (api.registrationMode !== "full") return;

  // Heavy runtime-only registrations
  api.registerService(/* ... */);
}
```

Long-lived services may emit small invalidation or lifecycle events through
their service context:

```typescript
api.registerService({
  id: "index-events",
  start(ctx) {
    ctx.gatewayEvents?.emit("changed", { revision: 1 }, { scope: "operator.read" });
  },
});
```

OpenClaw namespaces this as `plugin.<plugin-id>.changed`. Event names are one
lowercase segment, payloads must be bounded JSON, and the scope must be
`operator.read`, `operator.write`, or `operator.admin`. The emitter exists only
for the service lifetime and is revoked after stop or failed start. Prefer
version or invalidation payloads over full records so authorized clients reread
canonical state through the plugin's scoped Gateway methods.

Discovery mode builds a non-activating registry snapshot. It may still
evaluate the plugin entry and the channel plugin object so OpenClaw can
register channel capabilities and static CLI descriptors. Treat module
evaluation in discovery as trusted but lightweight: no network clients,
subprocesses, listeners, database connections, background workers,
credential reads, or other live runtime side effects at top level.

Treat `"setup-runtime"` as the window where setup-only startup surfaces must
exist without re-entering the full bundled channel runtime. Good fits are
channel registration, setup-safe HTTP routes, setup-safe gateway methods,
and delegated setup helpers. Heavy background services, CLI registrars, and
provider/client SDK bootstraps still belong in `"full"`.

## Plugin shapes

OpenClaw classifies loaded plugins by their registration behavior:

| Shape                 | Description                                        |
| --------------------- | -------------------------------------------------- |
| **plain-capability**  | One capability type (e.g. provider-only)           |
| **hybrid-capability** | Multiple capability types (e.g. provider + speech) |
| **hook-only**         | Only hooks, no capabilities                        |
| **non-capability**    | Tools/commands/services but no capabilities        |

Use `openclaw plugins inspect <id>` to see a plugin's shape.

## Related

- [SDK Overview](/plugins/sdk-overview) - registration API and subpath reference
- [Runtime Helpers](/plugins/sdk-runtime) - `api.runtime` and `createPluginRuntimeStore`
- [Setup and Config](/plugins/sdk-setup) - manifest, setup entry, deferred loading
- [Channel Plugins](/plugins/sdk-channel-plugins) - building the `ChannelPlugin` object
- [Provider Plugins](/plugins/sdk-provider-plugins) - provider registration and hooks
