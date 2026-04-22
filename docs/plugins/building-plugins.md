---
title: "Building Plugins"
sidebarTitle: "Getting Started"
summary: "Create your first OpenClaw plugin in minutes"
read_when:
  - You want to create a new OpenClaw plugin
  - You need a quick-start for plugin development
  - You are adding a new channel, provider, tool, or other capability to OpenClaw
---

# Building Plugins

Plugins extend OpenClaw with new capabilities: channels, model providers,
speech, realtime transcription, realtime voice, media understanding, image
generation, video generation, web fetch, web search, agent tools, or any
combination.

You do not need to add your plugin to the OpenClaw repository. Publish to
[ClawHub](/tools/clawhub) or npm and users install with
`openclaw plugins install <package-name>`. OpenClaw tries ClawHub first and
falls back to npm automatically.

## Prerequisites

- Node >= 22 and a package manager (npm or pnpm)
- Familiarity with TypeScript (ESM)
- For in-repo plugins: repository cloned and `pnpm install` done

## What kind of plugin?

<CardGroup cols={3}>
  <Card title="Channel plugin" icon="messages-square" href="/plugins/sdk-channel-plugins">
    Connect OpenClaw to a messaging platform (Discord, IRC, etc.)
  </Card>
  <Card title="Provider plugin" icon="cpu" href="/plugins/sdk-provider-plugins">
    Add a model provider (LLM, proxy, or custom endpoint)
  </Card>
  <Card title="Tool / hook plugin" icon="wrench">
    Register agent tools, event hooks, or services — continue below
  </Card>
</CardGroup>

If a channel plugin is optional and may not be installed when onboarding/setup
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
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    Every plugin needs a manifest, even with no config. See
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

    OpenClaw also checks ClawHub before npm for bare package specs like
    `@myorg/openclaw-my-plugin`.

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
| Embedded Pi extension  | `api.registerEmbeddedExtensionFactory(...)`      | [SDK Overview](/plugins/sdk-overview#registration-api)                          |
| Agent tools            | `api.registerTool(...)`                          | Below                                                                           |
| Custom commands        | `api.registerCommand(...)`                       | [Entry Points](/plugins/sdk-entrypoints)                                        |
| Event hooks            | `api.registerHook(...)`                          | [Entry Points](/plugins/sdk-entrypoints)                                        |
| HTTP routes            | `api.registerHttpRoute(...)`                     | [Internals](/plugins/architecture#gateway-http-routes)                          |
| CLI subcommands        | `api.registerCli(...)`                           | [Entry Points](/plugins/sdk-entrypoints)                                        |

For the full registration API, see [SDK Overview](/plugins/sdk-overview#registration-api).

Use `api.registerEmbeddedExtensionFactory(...)` when a plugin needs Pi-native
embedded-runner hooks such as async `tool_result` rewriting before the final
tool result message is emitted. Prefer regular OpenClaw plugin hooks when the
work does not need Pi extension timing.

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

The `/approve` command handles both exec and plugin approvals with bounded fallback: when an exec approval id is not found, OpenClaw retries the same id through plugin approvals. Plugin approval forwarding can be configured independently via `approvals.plugin` in config.

If custom approval plumbing needs to detect that same bounded fallback case,
prefer `isApprovalNotFoundError` from `openclaw/plugin-sdk/error-runtime`
instead of matching approval-expiry strings manually.

See [SDK Overview hook decision semantics](/plugins/sdk-overview#hook-decision-semantics) for details.

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

Users enable optional tools in config:

```json5
{
  tools: { allow: ["workflow_tool"] },
}
```

- Tool names must not clash with core tools (conflicts are skipped)
- Use `optional: true` for tools with side effects or extra binary requirements
- Users can enable all tools from a plugin by adding the plugin id to `tools.allow`

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
bundled-plugin maintenance and compatibility, for example
`plugin-sdk/feishu-setup` or `plugin-sdk/zalo-setup`. Treat those as reserved
surfaces, not as the default pattern for new third-party plugins.

## Pre-submission checklist

<Check>**package.json** has correct `openclaw` metadata</Check>
<Check>**openclaw.plugin.json** manifest is present and valid</Check>
<Check>Entry point uses `defineChannelPluginEntry` or `definePluginEntry`</Check>
<Check>All imports use focused `plugin-sdk/<subpath>` paths</Check>
<Check>Internal imports use local modules, not SDK self-imports</Check>
<Check>Tests pass (`pnpm test -- <bundled-plugin-root>/my-plugin/`)</Check>
<Check>`pnpm check` passes (in-repo plugins)</Check>

## Beta Release Testing

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
