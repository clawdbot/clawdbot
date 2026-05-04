---
summary: "Create your first OpenClaw plugin in minutes"
title: "Building plugins"
sidebarTitle: "Getting Started"
read_when:
  - You want to create a new OpenClaw plugin
  - You need a quick-start for plugin development
  - You are adding a new channel, provider, tool, or other capability to OpenClaw
---

Plugins extend OpenClaw with new capabilities: channels, model providers,
speech, realtime transcription, realtime voice, media understanding, image
generation, video generation, web fetch, web search, agent tools, or any
combination.

You do not need to add your plugin to the OpenClaw repository. Publish to
[ClawHub](/tools/clawhub) and users install with
`openclaw plugins install clawhub:<package-name>`. Bare package specs still
install from npm during the launch cutover.

## Prerequisites

- Node >= 22 and a package manager (npm or pnpm)
- Familiarity with TypeScript (ESM)
- For in-repo plugins: repository cloned and `pnpm install` done. Source
  checkout plugin development is pnpm-only because OpenClaw loads bundled
  plugins from the `extensions/*` workspace packages.

## What kind of plugin?

<CardGroup cols={3}>
  <Card title="Channel plugin" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Connect OpenClaw to a messaging platform (Discord, IRC, etc.)
  </Card>
  <Card title="Provider plugin" icon="cpu" href="/plugins/sdk-provider-plugins">
    Add a model provider (LLM, proxy, or custom endpoint)
  </Card>
  <Card title="Tool / hook plugin" icon="wrench" href="/plugins/hooks">
    Register agent tools, event hooks, or services — continue below
  </Card>
</CardGroup>

For a channel plugin that isn't guaranteed to be installed when onboarding/setup
runs, use `createOptionalChannelSetupSurface(...)` from
`openclaw/plugin-sdk/channel-setup`. It produces a setup adapter + wizard pair
that advertises the install requirement and fails closed on real config writes
until the plugin is installed.

## Quick start: tool plugin

This walkthrough creates a minimal plugin that registers an agent tool. Channel
and provider plugins have dedicated guides linked above.

<Steps>
  <Step title="Create the package and manifest">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-my-plugin",
      "version": "1.0.0",
      "type": "module",
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

    Every plugin needs a manifest, even with no config. Runtime-registered tools
    must be listed in `contracts.tools` so OpenClaw can discover the owning
    plugin without loading every plugin runtime. Plugins should also declare
    `activation.onStartup` intentionally. This example sets it to `true`. See
    [Manifest](/plugins/manifest) for the full schema. The canonical ClawHub
    publish snippets live in `docs/snippets/plugin-publish/`.

  </Step>

  <Step title="Write the entry point">

    ```typescript
    // index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { Type } from "@sinclair/typebox";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Adds a custom tool to OpenClaw",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "Do a thing",
          parameters: Type.Object({ input: Type.String() }),
          async execute(_id, params) {
            return { content: [{ type: "text", text: `Got: ${params.input}` }] };
          },
        });
      },
    });
    ```

    `definePluginEntry` is for non-channel plugins. For channels, use
    `defineChannelPluginEntry` — see [Channel Plugins](/plugins/sdk-channel-plugins).
    For full entry point options, see [Entry Points](/plugins/sdk-entrypoints).

  </Step>

  <Step title="Test and publish">

    **External plugins:** validate and publish with ClawHub, then install:

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    openclaw plugins install clawhub:@myorg/openclaw-my-plugin
    ```

    Bare package specs like `@myorg/openclaw-my-plugin` install from npm during
    the launch cutover. Use `clawhub:` when you want ClawHub resolution.

    **In-repo plugins:** place under the bundled plugin workspace tree — automatically discovered.

    ```bash
    pnpm test -- <bundled-plugin-root>/my-plugin/
    ```

  </Step>
</Steps>

## Plugin capabilities

A single plugin can register any number of capabilities via the `api` object:

| Capability             | Registration method                              | Detailed guide                                                                  |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Text inference (LLM)   | `api.registerProvider(...)`                      | [Provider Plugins](/plugins/sdk-provider-plugins)                               |
| CLI inference backend  | `api.registerCliBackend(...)`                    | [CLI Backends](/gateway/cli-backends)                                           |
| Channel / messaging    | `api.registerChannel(...)`                       | [Channel Plugins](/plugins/sdk-channel-plugins)                                 |
| Speech (TTS/STT)       | `api.registerSpeechProvider(...)`                | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Realtime transcription | `api.registerRealtimeTranscriptionProvider(...)` | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Realtime voice         | `api.registerRealtimeVoiceProvider(...)`         | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Media understanding    | `api.registerMediaUnderstandingProvider(...)`    | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Image generation       | `api.registerImageGenerationProvider(...)`       | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Music generation       | `api.registerMusicGenerationProvider(...)`       | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Video generation       | `api.registerVideoGenerationProvider(...)`       | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Web fetch              | `api.registerWebFetchProvider(...)`              | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Web search             | `api.registerWebSearchProvider(...)`             | [Provider Plugins](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| Tool-result middleware | `api.registerAgentToolResultMiddleware(...)`     | [SDK Overview](/plugins/sdk-overview#registration-api)                          |
| Agent tools            | `api.registerTool(...)`                          | Below                                                                           |
| Custom commands        | `api.registerCommand(...)`                       | [Entry Points](/plugins/sdk-entrypoints)                                        |
| Plugin hooks           | `api.on(...)`                                    | [Plugin hooks](/plugins/hooks)                                                  |
| Internal event hooks   | `api.registerHook(...)`                          | [Entry Points](/plugins/sdk-entrypoints)                                        |
| HTTP routes            | `api.registerHttpRoute(...)`                     | [Internals](/plugins/architecture-internals#gateway-http-routes)                |
| CLI subcommands        | `api.registerCli(...)`                           | [Entry Points](/plugins/sdk-entrypoints)                                        |

For the full registration API, see [SDK Overview](/plugins/sdk-overview#registration-api).

Bundled plugins can use `api.registerAgentToolResultMiddleware(...)` when they
need async tool-result rewriting before the model sees the output. Declare the
targeted runtimes in `contracts.agentToolResultMiddleware`, for example
`["pi", "codex"]`. This is a trusted bundled-plugin seam; external
plugins should prefer regular OpenClaw plugin hooks unless OpenClaw grows an
explicit trust policy for this capability.

If your plugin registers custom gateway RPC methods, keep them on a
plugin-specific prefix. Core admin namespaces (`config.*`,
`exec.approvals.*`, `wizard.*`, `update.*`) stay reserved and always resolve to
`operator.admin`, even if a plugin asks for a narrower scope.

Hook guard semantics to keep in mind:

- `before_tool_call`: `{ block: true }` is terminal and stops lower-priority handlers.
- `before_tool_call`: `{ block: false }` is treated as no decision.
- `before_tool_call`: `{ requireApproval: true }` pauses agent execution and prompts the user for approval via the exec approval overlay, Telegram buttons, Discord interactions, or the `/approve` command on any channel.
- `before_install`: `{ block: true }` is terminal and stops lower-priority handlers.
- `before_install`: `{ block: false }` is treated as no decision.
- `message_sending`: `{ cancel: true }` is terminal and stops lower-priority handlers.
- `message_sending`: `{ cancel: false }` is treated as no decision.
- `message_received`: prefer the typed `threadId` field when you need inbound thread/topic routing. Keep `metadata` for channel-specific extras.
- `message_sending`: prefer typed `replyToId` / `threadId` routing fields over channel-specific metadata keys.

The `/approve` command handles both exec and plugin approvals with bounded fallback: when an exec approval id is not found, OpenClaw retries the same id through plugin approvals. Plugin approval forwarding can be configured independently via `approvals.plugin` in config.

If custom approval plumbing needs to detect that same bounded fallback case,
prefer `isApprovalNotFoundError` from `openclaw/plugin-sdk/error-runtime`
instead of matching approval-expiry strings manually.

See [Plugin hooks](/plugins/hooks) for examples and the hook reference.

## Registering agent tools

Tools are typed functions the LLM can call. They can be required (always
available) or optional (user opt-in):

```typescript
register(api) {
  // Required tool — always available
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });

  // Optional tool — user must add to allowlist
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a workflow",
      parameters: Type.Object({ pipeline: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Every tool registered with `api.registerTool(...)` must also be declared in the
plugin manifest:

```json
{
  "contracts": {
    "tools": ["my_tool", "workflow_tool"]
  },
  "toolMetadata": {
    "workflow_tool": {
      "optional": true
    }
  }
}
```

OpenClaw captures and caches the validated descriptor from the registered tool,
so plugins do not duplicate `description` or schema data in the manifest. The
manifest contract only declares ownership and discovery; execution still calls
the live registered tool implementation.
Set `toolMetadata.<tool>.optional: true` for tools registered with
`api.registerTool(..., { optional: true })` so OpenClaw can avoid loading that
plugin runtime until the tool is explicitly allowlisted.

Users enable optional tools in config:

```json5
{
  tools: { allow: ["workflow_tool"] },
}
```

- Tool names must not clash with core tools (conflicts are skipped)
- Tools with malformed registration objects, including missing `parameters`, are skipped and reported in plugin diagnostics instead of breaking agent runs
- Use `optional: true` for tools with side effects or extra binary requirements
- Users can enable all tools from a plugin by adding the plugin id to `tools.allow`

## Registering CLI commands

Plugins can add root `openclaw` command groups with `api.registerCli`. Provide
`descriptors` for every top-level command root so OpenClaw can show and route
the command without eagerly loading every plugin runtime.

```typescript
register(api) {
  api.registerCli(
    ({ program }) => {
      const demo = program
        .command("demo-plugin")
        .description("Run demo plugin commands");

      demo
        .command("ping")
        .description("Check that the plugin CLI is executable")
        .action(() => {
          console.log("demo-plugin:pong");
        });
    },
    {
      descriptors: [
        {
          name: "demo-plugin",
          description: "Run demo plugin commands",
          hasSubcommands: true,
        },
      ],
    },
  );
}
```

After install, verify the runtime registration and execute the command:

```bash
openclaw plugins inspect demo-plugin --runtime --json
openclaw demo-plugin ping
```

## Import conventions

Always import from focused `openclaw/plugin-sdk/<subpath>` paths:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// Wrong: monolithic root (deprecated, will be removed)
import { ... } from "openclaw/plugin-sdk";
```

For the full subpath reference, see [SDK Overview](/plugins/sdk-overview).

Within your plugin, use local barrel files (`api.ts`, `runtime-api.ts`) for
internal imports — never import your own plugin through its SDK path.

For provider plugins, keep provider-specific helpers in those package-root
barrels unless the seam is truly generic. Current bundled examples:

- Anthropic: Claude stream wrappers and `service_tier` / beta helpers
- OpenAI: provider builders, default-model helpers, realtime providers
- OpenRouter: provider builder plus onboarding/config helpers

If a helper is only useful inside one bundled provider package, keep it on that
package-root seam instead of promoting it into `openclaw/plugin-sdk/*`.

Some generated `openclaw/plugin-sdk/<bundled-id>` helper seams still exist for
bundled-plugin maintenance when they have tracked owner usage. Treat those as
reserved surfaces, not as the default pattern for new third-party plugins.

## Pre-submission checklist

<Check>**package.json** has correct `openclaw` metadata</Check>
<Check>**openclaw.plugin.json** manifest is present and valid</Check>
<Check>Entry point uses `defineChannelPluginEntry` or `definePluginEntry`</Check>
<Check>All imports use focused `plugin-sdk/<subpath>` paths</Check>
<Check>Internal imports use local modules, not SDK self-imports</Check>
<Check>Tests pass (`pnpm test -- <bundled-plugin-root>/my-plugin/`)</Check>
<Check>`pnpm check` passes (in-repo plugins)</Check>

## Beta release testing

1. Watch for GitHub release tags on [openclaw/openclaw](https://github.com/openclaw/openclaw/releases) and subscribe via `Watch` > `Releases`. Beta tags look like `v2026.3.N-beta.1`. You can also turn on notifications for the official OpenClaw X account [@openclaw](https://x.com/openclaw) for release announcements.
2. Test your plugin against the beta tag as soon as it appears. The window before stable is typically only a few hours.
3. Post in your plugin's thread in the `plugin-forum` Discord channel after testing with either `all good` or what broke. If you do not have a thread yet, create one.
4. If something breaks, open or update an issue titled `Beta blocker: <plugin-name> - <summary>` and apply the `beta-blocker` label. Put the issue link in your thread.
5. Open a PR to `main` titled `fix(<plugin-id>): beta blocker - <summary>` and link the issue in both the PR and your Discord thread. Contributors cannot label PRs, so the title is the PR-side signal for maintainers and automation. Blockers with a PR get merged; blockers without one might ship anyway. Maintainers watch these threads during beta testing.
6. Silence means green. If you miss the window, your fix likely lands in the next cycle.

## Next steps

<CardGroup cols={2}>
  <Card title="Channel Plugins" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Build a messaging channel plugin
  </Card>
  <Card title="Provider Plugins" icon="cpu" href="/plugins/sdk-provider-plugins">
    Build a model provider plugin
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

- [Plugin Architecture](/plugins/architecture) — internal architecture deep dive
- [SDK Overview](/plugins/sdk-overview) — Plugin SDK reference
- [Manifest](/plugins/manifest) — plugin manifest format
- [Channel Plugins](/plugins/sdk-channel-plugins) — building channel plugins
- [Provider Plugins](/plugins/sdk-provider-plugins) — building provider plugins
