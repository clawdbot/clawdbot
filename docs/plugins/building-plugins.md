---
summary: "Create your first OpenClaw plugin in minutes"
title: "Building plugins"
sidebarTitle: "Getting Started"
doc-schema-version: 1
read_when:
  - You want to create a new OpenClaw plugin
  - You need a quick-start for plugin development
  - You are choosing between channel, provider, CLI backend, tool, or hook docs
---

Plugins extend OpenClaw without changing core. A plugin can add a messaging
channel, model provider, local CLI backend, agent tool, hook, media provider,
or another plugin-owned capability.

You do not need to add an external plugin to the OpenClaw repository. Publish
the package to [ClawHub](/clawhub) and users install it with:

```bash
openclaw plugins install clawhub:<package-name>
```

Bare package specs still install from npm during the launch cutover. Use the
`clawhub:` prefix when you want ClawHub resolution.

## Requirements

- Node 22.22.3+, Node 24.15+, or Node 25.9+, and `npm` or `pnpm`.
- TypeScript ESM modules.
- For in-repo bundled plugin work, clone the repository and run `pnpm install`.
  Source-checkout plugin development is pnpm-only because OpenClaw discovers
  bundled plugins from `extensions/*` workspace packages.

## Choose the plugin shape

<CardGroup cols={2}>
  <Card title="Channel plugin" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Connect OpenClaw to a messaging platform.
  </Card>
  <Card title="Provider plugin" icon="cpu" href="/plugins/sdk-provider-plugins">
    Add a model, media, search, fetch, speech, or realtime provider.
  </Card>
  <Card title="CLI backend plugin" icon="terminal" href="/plugins/cli-backend-plugins">
    Run a local AI CLI through OpenClaw model fallback.
  </Card>
  <Card title="Tool plugin" icon="wrench" href="/plugins/tool-plugins">
    Register agent tools.
  </Card>
</CardGroup>

## Quickstart

Build a minimal tool plugin by registering one required agent tool. This is the
shortest useful plugin shape and covers the package, manifest, entry point, and
local proof.

<Steps>
  <Step title="Create package metadata">
    <CodeGroup>

```json package.json
{
  "name": "@myorg/openclaw-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "typebox": "1.1.39"
  },
  "peerDependencies": {
    "openclaw": ">=2026.3.24-beta.2"
  },
  "openclaw": {
    "extensions": ["./index.ts"],
    "compat": {
      "pluginApi": ">=2026.3.24-beta.2",
      "minGatewayVersion": "2026.3.24-beta.2"
    },
    "build": {
      "openclawVersion": "2026.3.24-beta.2",
      "pluginSdkVersion": "2026.3.24-beta.2"
    }
  }
}
```

```json openclaw.plugin.json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds a custom tool to OpenClaw",
  "contracts": {
    "tools": ["my_tool"]
  },
  "activation": {
    "onStartup": true
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

    </CodeGroup>

    Published external plugins should point runtime entries at built JavaScript
    files. See [SDK entry points](/plugins/sdk-entrypoints) for the full entry
    point contract.

    Every plugin needs a manifest, even with no config. Runtime tools must
    appear in `contracts.tools` so OpenClaw can discover ownership without
    eagerly loading every plugin runtime. Set `activation.onStartup`
    intentionally; this example loads on Gateway startup.

    Host-trusted plugin surfaces are manifest-gated too and require explicit
    declaration for installed plugins: `api.registerAgentToolResultMiddleware(...)`
    needs each target runtime listed in `contracts.agentToolResultMiddleware`,
    and `api.registerTrustedToolPolicy(...)` needs each policy id in
    `contracts.trustedToolPolicies`. These declarations keep install-time
    inspection and runtime registration aligned.

    For every manifest field, see [Plugin manifest](/plugins/manifest).

  </Step>

  <Step title="Register the tool">
    ```typescript index.ts
    import { Type } from "typebox";
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Adds a custom tool to OpenClaw",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "Echo one input value",
          parameters: Type.Object({ input: Type.String() }),
          outputSchema: Type.Object(
            { input: Type.String() },
            { additionalProperties: false },
          ),
          async execute(_id, params) {
            const details = { input: params.input };
            return {
              content: [{ type: "text", text: `Got: ${params.input}` }],
              details,
            };
          },
        });
      },
    });
    ```

    Use `definePluginEntry` for non-channel plugins. Channel plugins use
    `defineChannelPluginEntry` from `openclaw/plugin-sdk/core` instead.

  </Step>

  <Step title="Test the runtime">
    For an installed or external plugin, inspect the loaded runtime:

    ```bash
    openclaw plugins inspect my-plugin --runtime --json
    ```

    If the plugin registers a CLI command, run that command too and confirm
    output, for example `openclaw demo-plugin ping`.

    For a bundled plugin in this repository, OpenClaw discovers source-checkout
    plugin packages from the `extensions/*` workspace. Run the closest targeted
    test:

    ```bash
    pnpm test extensions/my-plugin/
    pnpm check
    ```

  </Step>

  <Step title="Test the package install">
    Before publishing a package-ready plugin, test the same install shape users
    will get. First add a build step, point runtime entries such as
    `openclaw.extensions` at built JavaScript like `./dist/index.js`, and make
    sure `npm pack` includes that `dist/` output. TypeScript source entries are
    only for source checkouts and local development paths.

    Then pack the plugin and install the tarball with `npm-pack:`:

    ```bash
    npm pack --pack-destination /tmp
    openclaw plugins install npm-pack:/tmp/<plugin-package>.tgz --force
    openclaw plugins inspect my-plugin --runtime --json
    ```

    `npm-pack:` uses OpenClaw's managed per-plugin npm project, so it catches
    runtime dependency mistakes that source checkout testing can hide. It proves
    the package and dependency shape, not catalog-linked official trust.
    Runtime imports must be in `dependencies` or `optionalDependencies`;
    dependencies left only in `devDependencies` will not be installed for the
    managed runtime project.

    Do not use a raw archive/path install as the final proof for official or
    privileged plugin behavior. Raw sources are useful for local debugging, but
    they do not prove the same dependency path as npm or ClawHub installs. If
    your plugin relies on trusted official plugin status, add a second proof
    through a catalog-backed official install or a published package path that
    records official trust. See
    [Plugin dependency resolution](/plugins/dependency-resolution) for
    install-root and dependency ownership details.

  </Step>

  <Step title="Publish">
    Validate the package before publishing:

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    ```

    Canonical ClawHub package snippets live in `docs/snippets/plugin-publish/`.

  </Step>

  <Step title="Install">
    Install the published package through ClawHub:

    ```bash
    openclaw plugins install clawhub:your-org/your-plugin
    ```

  </Step>
</Steps>

<a id="registering-agent-tools"></a>

## Registering tools

Tools can be required or optional. Required tools are always available when the
plugin is enabled. Optional tools need explicit user opt-in before OpenClaw
loads the owning plugin runtime.

Tool factories receive trusted runtime context, including `deliveryContext`,
`nativeChannelId` for the active platform conversation when available, and
`requesterSenderId`.

```typescript
register(api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a workflow",
      parameters: Type.Object({ pipeline: Type.String() }),
      outputSchema: Type.Object(
        { pipeline: Type.String() },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.pipeline }],
          details: { pipeline: params.pipeline },
        };
      },
    },
    { optional: true },
  );
}
```

`outputSchema` is optional. It describes the structured `details` value used by
[Code Mode](/tools/code-mode) and [Tool Search](/tools/tool-search). Catalog
calls reject invalid schemas before execution and validate the final value after
tool hooks. Omit it for tools without a stable JSON result. See
[Tool plugins](/plugins/tool-plugins#output-contracts) for the full contract.

Every tool registered with `api.registerTool(...)` must also be declared in the
plugin manifest:

```json
{
  "contracts": {
    "tools": ["workflow_tool"]
  },
  "toolMetadata": {
    "workflow_tool": {
      "optional": true
    }
  }
}
```

Users opt in with `tools.allow`:

```json5
{
  tools: { allow: ["workflow_tool"] }, // or ["my-plugin"] for every tool from one plugin
}
```

Optional tools control whether a tool is exposed to the model. Use
[plugin permission requests](/plugins/plugin-permission-requests) when a tool
or hook should ask for approval after the model selects it and before the
action runs.

Use optional tools for side effects, unusual binaries, or capabilities that
should not be exposed by default. Tool names must not conflict with core tool
names; conflicts are skipped and reported in plugin diagnostics. Malformed
registrations are skipped and reported the same way: a missing non-empty
`name`, a non-function `execute`, or a tool descriptor without a `parameters`
object.

Tool factories receive a runtime-supplied context object. Use `ctx.activeModel`
when a tool needs to log, display, or adapt to the active model for the current
turn; it can include `provider`, `modelId`, and `modelRef`. Treat it as
informational runtime metadata, not a security boundary against the local
operator, installed plugin code, or a modified OpenClaw runtime. Sensitive
local tools should still require an explicit plugin or operator opt-in and
fail closed when active-model metadata is missing or unsuitable.

The manifest declares ownership and discovery; execution still calls the live
registered tool implementation. Keep `toolMetadata.<tool>.optional: true`
aligned with `api.registerTool(..., { optional: true })` so OpenClaw can avoid
loading that plugin runtime until the tool is explicitly allowlisted.

## Import conventions

Import from focused SDK subpaths:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
```

Do not import from the deprecated root barrel:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk";
```

Within your plugin package, use local barrel files such as `api.ts` and
`runtime-api.ts` for internal imports. Do not import your own plugin through an
SDK path. Provider-specific helpers should stay in the provider package unless
the seam is truly generic.

Custom Gateway RPC methods are an advanced entry point. Keep them on a
plugin-specific prefix; core admin namespaces such as `config.*`,
`exec.approvals.*`, `operator.admin.*`, `wizard.*`, and `update.*` stay reserved
and resolve to `operator.admin`. The
`openclaw/plugin-sdk/gateway-method-runtime` bridge is reserved for plugin HTTP
routes that declare `contracts.gatewayMethodDispatch: ["authenticated-request"]`.

For the full import map, see [Plugin SDK overview](/plugins/sdk-overview).

## Pre-submission checklist

<Check>**package.json** has correct `openclaw` metadata</Check>
<Check>**openclaw.plugin.json** manifest is present and valid</Check>
<Check>Entry point uses `defineChannelPluginEntry` or `definePluginEntry`</Check>
<Check>All imports use focused `plugin-sdk/<subpath>` paths</Check>
<Check>Internal imports use local modules, not SDK self-imports</Check>
<Check>Tests pass (`pnpm test <bundled-plugin-root>/my-plugin/`)</Check>
<Check>`pnpm check` passes (in-repo plugins)</Check>

## Test against beta releases

1. Watch [openclaw/openclaw](https://github.com/openclaw/openclaw/releases) releases (`Watch` > `Releases`). Beta tags look like `v2026.3.N-beta.1`. You can also follow [@openclaw](https://x.com/openclaw) on X for release announcements.
2. Test your plugin against the beta tag as soon as it appears. The window before stable is typically only a few hours.
3. Post in your plugin's thread in the `plugin-forum` Discord channel ([discord.gg/clawd](https://discord.gg/clawd)) after testing, with either `all good` or what broke. Create a thread if you do not have one yet.
4. If something breaks, open or update an issue titled `Beta blocker: <plugin-name> - <summary>` and apply the `beta-blocker` label. Link the issue in your thread.
5. Open a PR to `main` titled `fix(<plugin-id>): beta blocker - <summary>` and link the issue in both the PR and your Discord thread. Contributors cannot label PRs, so the title is the PR-side signal for maintainers and automation. Blockers with a PR get merged; blockers without one might ship anyway.
6. Silence means green. Missing the window usually means your fix lands in the next cycle.

## Next steps

<CardGroup cols={2}>
  <Card title="Channel Plugins" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Build a messaging channel plugin
  </Card>
  <Card title="Provider Plugins" icon="cpu" href="/plugins/sdk-provider-plugins">
    Build a model provider plugin
  </Card>
  <Card title="CLI Backend Plugins" icon="terminal" href="/plugins/cli-backend-plugins">
    Register a local AI CLI backend
  </Card>
  <Card title="SDK Overview" icon="book-open" href="/plugins/sdk-overview">
    Import map and registration API reference
  </Card>
  <Card title="Runtime Helpers" icon="settings" href="/plugins/sdk-runtime">
    TTS, search, subagent via api.runtime
  </Card>
  <Card title="Testing" icon="test-tubes" href="/plugins/sdk-testing">
    Test utilities and patterns
  </Card>
  <Card title="Plugin Manifest" icon="file-json" href="/plugins/manifest">
    Full manifest schema reference
  </Card>
</CardGroup>

## Related

- [Plugin hooks](/plugins/hooks)
- [Plugin architecture](/plugins/architecture)
