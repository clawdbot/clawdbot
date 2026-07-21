---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building an OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin manifest"
---

This page covers the **native OpenClaw plugin manifest**, `openclaw.plugin.json`. For compatible bundle layouts (Codex, Claude, Cursor), see [Plugin bundles](/plugins/bundles).

Compatible bundle formats use their own manifest files instead:

- Codex bundle: `.codex-plugin/plugin.json`
- Claude bundle: `.claude-plugin/plugin.json`, or the default Claude component layout with no manifest
- Cursor bundle: `.cursor-plugin/plugin.json`

OpenClaw auto-detects those layouts but does not validate them against the `openclaw.plugin.json` schema below. For a compatible bundle, OpenClaw reads bundle metadata, declared skill roots, Claude command roots, Claude `settings.json` defaults, Claude LSP defaults, and supported hook packs, when the layout matches OpenClaw's runtime expectations.

Every native OpenClaw plugin **must** ship `openclaw.plugin.json` in the **plugin root**. OpenClaw reads it to validate configuration **without executing plugin code**. A missing or invalid manifest blocks config validation and is treated as a plugin error.

See [Plugins](/tools/plugin) for the full plugin system guide, and [Capability model](/plugins/architecture#public-capability-model) for the native capability model and current external-compatibility guidance.

## What this file does

`openclaw.plugin.json` is metadata OpenClaw reads **before loading your plugin code**. Everything in it must be cheap enough to inspect without booting plugin runtime.

**Use it for:**

- plugin identity, config validation, and config UI hints
- auth, onboarding, and setup metadata (alias, auto-enable, provider env vars, auth choices)
- activation hints for control-plane surfaces
- shorthand model-family ownership
- static capability-ownership snapshots (`contracts`)
- dashboard widget data bindings and action verbs
- QA runner metadata the shared `openclaw qa` host can inspect
- channel-specific config metadata merged into catalog and validation surfaces

**Do not use it for:** registering runtime behavior, declaring code entrypoints, or npm install metadata. Those belong in your plugin code and `package.json`.

## Minimal example

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

## Rich example

```json
{
  "id": "openrouter",
  "name": "OpenRouter",
  "description": "OpenRouter provider plugin",
  "version": "1.0.0",
  "providers": ["openrouter"],
  "modelSupport": {
    "modelPrefixes": ["router-"]
  },
  "modelIdNormalization": {
    "providers": {
      "openrouter": {
        "prefixWhenBare": "openrouter"
      }
    }
  },
  "providerEndpoints": [
    {
      "endpointClass": "openrouter",
      "hostSuffixes": ["openrouter.ai"]
    }
  ],
  "providerRequest": {
    "providers": {
      "openrouter": {
        "family": "openrouter"
      }
    }
  },
  "cliBackends": ["openrouter-cli"],
  "syntheticAuthRefs": ["openrouter-cli"],
  "setup": {
    "providers": [
      {
        "id": "openrouter",
        "envVars": ["OPENROUTER_API_KEY"]
      }
    ]
  },
  "providerAuthAliases": {
    "openrouter-coding": "openrouter"
  },
  "providerAuthChoices": [
    {
      "provider": "openrouter",
      "method": "api-key",
      "choiceId": "openrouter-api-key",
      "choiceLabel": "OpenRouter API key",
      "groupId": "openrouter",
      "groupLabel": "OpenRouter",
      "optionKey": "openrouterApiKey",
      "cliFlag": "--openrouter-api-key",
      "cliOption": "--openrouter-api-key <key>",
      "cliDescription": "OpenRouter API key",
      "onboardingScopes": ["text-inference"]
    }
  ],
  "uiHints": {
    "apiKey": {
      "label": "API key",
      "placeholder": "sk-or-v1-...",
      "sensitive": true
    }
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": {
        "type": "string"
      }
    }
  }
}
```

## Top-level field reference

| Field                                | Required | Type                         | What it means                                                                                                                                                                                                                                                              |
| ------------------------------------ | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | Yes      | `string`                     | Canonical plugin id. This is the id used in `plugins.entries.<id>`.                                                                                                                                                                                                        |
| `configSchema`                       | Yes      | `object`                     | Inline JSON Schema for this plugin's config.                                                                                                                                                                                                                               |
| `requiresPlugins`                    | No       | `string[]`                   | Plugin ids that must also be installed for this plugin to have an effect. Discovery keeps the plugin loadable but warns when any required plugin is missing.                                                                                                               |
| `enabledByDefault`                   | No       | `true`                       | Marks a bundled plugin as enabled by default. Omit it, or set any non-`true` value, to leave the plugin disabled by default.                                                                                                                                               |
| `enabledByDefaultOnPlatforms`        | No       | `string[]`                   | Marks a bundled plugin as enabled by default only on the listed Node.js platforms, for example `["darwin"]`. Explicit config still wins.                                                                                                                                   |
| `legacyPluginIds`                    | No       | `string[]`                   | Legacy ids that normalize to this canonical plugin id.                                                                                                                                                                                                                     |
| `autoEnableWhenConfiguredProviders`  | No       | `string[]`                   | Provider ids that should auto-enable this plugin when auth, config, or model refs mention them.                                                                                                                                                                            |
| `kind`                               | No       | `PluginKind \| PluginKind[]` | Declares one or more exclusive plugin kinds (`"memory"`, `"context-engine"`) used by `plugins.slots.*`. A plugin that owns both slots declares both kinds in one array.                                                                                                    |
| `channels`                           | No       | `string[]`                   | Channel ids owned by this plugin. Used for discovery and config validation.                                                                                                                                                                                                |
| `providers`                          | No       | `string[]`                   | Provider ids owned by this plugin.                                                                                                                                                                                                                                         |
| `providerCatalogEntry`               | No       | `string`                     | Lightweight provider-catalog module path, relative to the plugin root, for manifest-scoped provider catalog metadata that can be loaded without activating the full plugin runtime.                                                                                        |
| `modelSupport`                       | No       | `object`                     | Manifest-owned shorthand model-family metadata used to auto-load the plugin before runtime.                                                                                                                                                                                |
| `modelCatalog`                       | No       | `object`                     | Declarative model catalog metadata for providers owned by this plugin. This is the control-plane contract for future read-only listing, onboarding, model pickers, aliases, and suppression without loading plugin runtime.                                                |
| `modelPricing`                       | No       | `object`                     | Provider-owned external pricing lookup policy. Use it to opt local/self-hosted providers out of remote pricing catalogs or map provider refs to OpenRouter/LiteLLM catalog ids without hardcoding provider ids in core.                                                    |
| `modelIdNormalization`               | No       | `object`                     | Provider-owned model-id alias/prefix cleanup that must run before provider runtime loads.                                                                                                                                                                                  |
| `providerEndpoints`                  | No       | `object[]`                   | Manifest-owned endpoint host/baseUrl metadata for provider routes that core must classify before provider runtime loads.                                                                                                                                                   |
| `providerRequest`                    | No       | `object`                     | Cheap provider-family and request-compatibility metadata used by generic request policy before provider runtime loads.                                                                                                                                                     |
| `secretProviderIntegrations`         | No       | `Record<string, object>`     | Declarative SecretRef exec provider presets that setup or install surfaces can offer without hardcoding provider-specific integrations in core.                                                                                                                            |
| `cliBackends`                        | No       | `string[]`                   | CLI inference backend ids owned by this plugin. Used for startup auto-activation from explicit config refs.                                                                                                                                                                |
| `syntheticAuthRefs`                  | No       | `string[]`                   | Provider or CLI backend refs whose plugin-owned synthetic auth hook should be probed during cold model discovery before runtime loads.                                                                                                                                     |
| `nonSecretAuthMarkers`               | No       | `string[]`                   | Bundled-plugin-owned placeholder API key values that represent non-secret local, OAuth, or ambient credential state.                                                                                                                                                       |
| `commandAliases`                     | No       | `object[]`                   | Command names owned by this plugin that should produce plugin-aware config and CLI diagnostics before runtime loads.                                                                                                                                                       |
| `providerUsageAuthEnvVars`           | No       | `Record<string, string[]>`   | Usage/billing-only provider credentials. OpenClaw uses these names for usage discovery and secret scrubbing but never for inference auth.                                                                                                                                  |
| `providerAuthAliases`                | No       | `Record<string, string>`     | Provider ids that should reuse another provider id for auth lookup, for example a coding provider that shares the base provider API key and auth profiles.                                                                                                                 |
| `providerAuthChoices`                | No       | `object[]`                   | Cheap auth-choice metadata for onboarding pickers, preferred-provider resolution, and simple CLI flag wiring.                                                                                                                                                              |
| `activation`                         | No       | `object`                     | Cheap activation planner metadata for startup, provider, command, channel, route, and capability-triggered loading. Metadata only; plugin runtime still owns actual behavior.                                                                                              |
| `setup`                              | No       | `object`                     | Cheap setup/onboarding descriptors that discovery and setup surfaces can inspect without loading plugin runtime.                                                                                                                                                           |
| `qaRunners`                          | No       | `object[]`                   | Cheap QA runner descriptors used by the shared `openclaw qa` host before plugin runtime loads.                                                                                                                                                                             |
| `dashboard`                          | No       | `object`                     | Dashboard widget data bindings and action verbs. Each entry is validated against a Gateway method registered by this plugin with the required read or write scope. See [dashboard reference](#dashboard-reference).                                                        |
| `contracts`                          | No       | `object`                     | Static capability ownership snapshot for external auth hooks, embeddings, speech, realtime transcription, realtime voice, media-understanding, image/video/music generation, web fetch, web search, worker providers, document/web-content extraction, and tool ownership. |
| `configContracts`                    | No       | `object`                     | Manifest-owned config behavior consumed by generic core helpers: dangerous-flag detection, SecretRef migration targets, and legacy config-path narrowing. See [configContracts reference](#configcontracts-reference).                                                     |
| `mediaUnderstandingProviderMetadata` | No       | `Record<string, object>`     | Cheap media-understanding defaults for provider ids declared in `contracts.mediaUnderstandingProviders`.                                                                                                                                                                   |
| `imageGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap image-generation auth metadata for provider ids declared in `contracts.imageGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                         |
| `videoGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap video-generation auth metadata for provider ids declared in `contracts.videoGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                         |
| `musicGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap music-generation auth metadata for provider ids declared in `contracts.musicGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                         |
| `toolMetadata`                       | No       | `Record<string, object>`     | Cheap availability metadata for plugin-owned tools declared in `contracts.tools`. Use it when a tool should not load runtime unless config, env, or auth evidence exists.                                                                                                  |
| `channelConfigs`                     | No       | `Record<string, object>`     | Manifest-owned channel config metadata merged into discovery and validation surfaces before runtime loads.                                                                                                                                                                 |
| `skills`                             | No       | `string[]`                   | Skill directories to load, relative to the plugin root.                                                                                                                                                                                                                    |
| `name`                               | No       | `string`                     | Human-readable plugin name.                                                                                                                                                                                                                                                |
| `description`                        | No       | `string`                     | Short summary shown in plugin surfaces.                                                                                                                                                                                                                                    |
| `catalog`                            | No       | `object`                     | Optional presentation hints for plugin catalog surfaces. This metadata does not install, enable, or grant trust to a plugin.                                                                                                                                               |
| `icon`                               | No       | `string`                     | HTTPS image URL for marketplace/catalog cards. ClawHub accepts any valid `https://` URL and falls back to the default plugin icon when this is omitted or invalid.                                                                                                         |
| `version`                            | No       | `string`                     | Informational plugin version.                                                                                                                                                                                                                                              |
| `uiHints`                            | No       | `Record<string, object>`     | UI labels, placeholders, and sensitivity hints for config fields.                                                                                                                                                                                                          |

## dashboard reference

`dashboard` lets an enabled plugin expose existing Gateway RPCs to granted dashboard widgets without adding plugin policy to core. Data bindings must name a method the same plugin registers with `operator.read`; action verbs must name a method it registers with `operator.write`. A mismatch rejects the plugin during registration.

```json
{
  "dashboard": {
    "dataBindings": [
      {
        "id": "items.list",
        "method": "example.items.list",
        "description": "List example items."
      }
    ],
    "actionVerbs": [
      {
        "id": "refresh",
        "method": "example.items.refresh",
        "description": "Refresh example items.",
        "paramShape": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "force": { "type": "boolean" }
          }
        }
      }
    ]
  }
}
```

The manifest ids are plugin-local. Widget grants use `<plugin-id>.<id>`, such as `example.items.list` and `example.refresh`. To keep the persisted grant namespace unambiguous, OpenClaw escapes `%` and `.` in the plugin-id segment as `%25` and `%2E`; ordinary plugin ids keep the natural form. `paramShape` is an optional JSON Schema applied to the action params object before OpenClaw invokes the plugin RPC.

## catalog reference

`catalog` provides optional display hints to plugin browsers. Hosts may ignore these hints. They never install or enable the plugin, and they do not change its runtime behavior or trust level.

```json
{
  "catalog": {
    "featured": true,
    "order": 10
  }
}
```

| Field      | Type      | What it means                                                              |
| ---------- | --------- | -------------------------------------------------------------------------- |
| `featured` | `boolean` | Whether catalog surfaces should feature this plugin.                       |
| `order`    | `number`  | Ascending display hint among curated plugins; lower values appear earlier. |

## Generation provider metadata reference

The generation provider metadata fields describe static auth signals for providers declared in the matching `contracts.*GenerationProviders` list. OpenClaw reads these fields before provider runtime loads so core tools can decide whether a generation provider is available without importing every provider plugin.

Use these fields only for cheap, declarative facts. Transport, request transforms, token refresh, credential validation, and actual generation behavior stay in the plugin runtime.

```json
{
  "contracts": {
    "imageGenerationProviders": ["example-image"]
  },
  "imageGenerationProviderMetadata": {
    "example-image": {
      "aliases": ["example-image-oauth"],
      "authProviders": ["example-image"],
      "configSignals": [
        {
          "rootPath": "plugins.entries.example-image.config",
          "overlayPath": "image",
          "mode": {
            "path": "mode",
            "default": "local",
            "allowed": ["local"]
          },
          "requiredAny": ["workflow", "workflowPath"],
          "required": ["promptNodeId"]
        }
      ],
      "authSignals": [
        {
          "provider": "example-image"
        },
        {
          "provider": "example-image-oauth",
          "providerBaseUrl": {
            "provider": "example-image",
            "defaultBaseUrl": "https://api.example.com/v1",
            "allowedBaseUrls": ["https://api.example.com/v1"]
          }
        }
      ]
    }
  }
}
```

Each metadata entry supports:

| Field                  | Required | Type       | What it means                                                                                                                                       |
| ---------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aliases`              | No       | `string[]` | Additional provider ids that should count as static auth aliases for the generation provider.                                                       |
| `authProviders`        | No       | `string[]` | Provider ids whose configured auth profiles should count as auth for this generation provider.                                                      |
| `configSignals`        | No       | `object[]` | Cheap config-only availability signals for local or self-hosted providers that can be configured without auth profiles or env vars.                 |
| `authSignals`          | No       | `object[]` | Explicit auth signals. When present, these replace the default signal set from the provider id, `aliases`, and `authProviders`.                     |
| `referenceAudioInputs` | No       | `boolean`  | Video-generation only. Set to `true` when the provider accepts reference audio assets; otherwise `video_generate` hides audio reference parameters. |

Each `configSignals` entry supports:

| Field            | Required | Type       | What it means                                                                                                                                                                             |
| ---------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootPath`       | Yes      | `string`   | Dot path to the plugin-owned config object to inspect, for example `plugins.entries.example.config`.                                                                                      |
| `overlayPath`    | No       | `string`   | Dot path inside the root config whose object should overlay the root object before evaluating the signal. Use this for capability-specific config such as `image`, `video`, or `music`.   |
| `overlayMapPath` | No       | `string`   | Dot path inside the root config whose object values should each overlay the root object. Use this for named account maps such as `accounts`, where any configured account should qualify. |
| `required`       | No       | `string[]` | Dot paths inside the effective config that must have configured values. Strings must be non-empty; objects and arrays must not be empty.                                                  |
| `requiredAny`    | No       | `string[]` | Dot paths inside the effective config where at least one must have a configured value.                                                                                                    |
| `mode`           | No       | `object`   | Optional string mode guard inside the effective config. Use this when config-only availability applies only to one mode.                                                                  |

Each `mode` guard supports:

| Field        | Required | Type       | What it means                                                                      |
| ------------ | -------- | ---------- | ---------------------------------------------------------------------------------- |
| `path`       | No       | `string`   | Dot path inside the effective config. Defaults to `mode`.                          |
| `default`    | No       | `string`   | Mode value to use when the config omits the path.                                  |
| `allowed`    | No       | `string[]` | If present, the signal passes only when the effective mode is one of these values. |
| `disallowed` | No       | `string[]` | If present, the signal fails when the effective mode is one of these values.       |

Each `authSignals` entry supports:

| Field             | Required | Type     | What it means                                                                                                                                                                 |
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | Yes      | `string` | Provider id to check in configured auth profiles.                                                                                                                             |
| `providerBaseUrl` | No       | `object` | Optional guard that makes the signal count only when the referenced configured provider uses an allowed base URL. Use this when an auth alias is valid only for certain APIs. |

Each `providerBaseUrl` guard supports:

| Field             | Required | Type       | What it means                                                                                                                                        |
| ----------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | Yes      | `string`   | Provider config id whose `baseUrl` should be checked.                                                                                                |
| `defaultBaseUrl`  | No       | `string`   | Base URL to assume when the provider config omits `baseUrl`.                                                                                         |
| `allowedBaseUrls` | Yes      | `string[]` | Allowed base URLs for this auth signal. The signal is ignored when the configured or default base URL does not match one of these normalized values. |

## Tool metadata reference

`toolMetadata` uses the same `configSignals` and `authSignals` shapes as generation provider metadata, keyed by tool name. `contracts.tools` declares ownership. `toolMetadata` declares cheap availability evidence so OpenClaw can avoid importing a plugin runtime just to have its tool factory return `null`.

```json
{
  "setup": {
    "providers": [
      {
        "id": "example",
        "envVars": ["EXAMPLE_API_KEY"]
      }
    ]
  },
  "contracts": {
    "tools": ["example_search"]
  },
  "toolMetadata": {
    "example_search": {
      "authSignals": [
        {
          "provider": "example"
        }
      ],
      "configSignals": [
        {
          "rootPath": "plugins.entries.example.config",
          "overlayPath": "search",
          "required": ["apiKey"]
        }
      ]
    }
  }
}
```

`toolMetadata` entries also accept `optional` (marks the tool as non-required for plugin activation) and `replaySafe` (marks tool execution as safe to repeat after an incomplete model turn), on top of the shared `configSignals`/`authSignals` fields above.

If a tool has no `toolMetadata`, OpenClaw preserves the existing behavior and loads the owning plugin when the tool contract matches policy. For hot-path tools whose factory depends on auth/config, plugin authors should declare `toolMetadata` instead of making core import runtime to ask.

## providerAuthChoices reference

Each `providerAuthChoices` entry describes one onboarding or auth choice. OpenClaw reads this before provider runtime loads. Provider setup lists use these manifest choices, descriptor-derived setup choices, and install-catalog metadata without loading provider runtime.

| Field                 | Required | Type                                                                  | What it means                                                                                             |
| --------------------- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `provider`            | Yes      | `string`                                                              | Provider id this choice belongs to.                                                                       |
| `method`              | Yes      | `string`                                                              | Auth method id to dispatch to.                                                                            |
| `choiceId`            | Yes      | `string`                                                              | Stable auth-choice id used by onboarding and CLI flows.                                                   |
| `choiceLabel`         | No       | `string`                                                              | User-facing label. If omitted, OpenClaw falls back to `choiceId`.                                         |
| `choiceHint`          | No       | `string`                                                              | Short helper text for the picker.                                                                         |
| `icon`                | No       | HTTPS URL                                                             | Artwork shown beside this choice in supported onboarding clients.                                         |
| `website`             | No       | HTTPS URL                                                             | Product, sign-in, or installation page shown by supported onboarding clients.                             |
| `assistantPriority`   | No       | `number`                                                              | Lower values sort earlier in assistant-driven interactive pickers.                                        |
| `assistantVisibility` | No       | `"visible"` \| `"manual-only"`                                        | Hide the choice from assistant pickers while still allowing manual CLI selection.                         |
| `deprecatedChoiceIds` | No       | `string[]`                                                            | Legacy choice ids that should redirect users to this replacement choice.                                  |
| `groupId`             | No       | `string`                                                              | Optional group id for grouping related choices.                                                           |
| `groupLabel`          | No       | `string`                                                              | User-facing label for that group.                                                                         |
| `groupHint`           | No       | `string`                                                              | Short helper text for the group.                                                                          |
| `onboardingFeatured`  | No       | `boolean`                                                             | Surface this group in the featured tier of the interactive onboarding picker, before the "More..." entry. |
| `optionKey`           | No       | `string`                                                              | Internal option key for simple one-flag auth flows.                                                       |
| `cliFlag`             | No       | `string`                                                              | CLI flag name, such as `--openrouter-api-key`.                                                            |
| `cliOption`           | No       | `string`                                                              | Full CLI option shape, such as `--openrouter-api-key <key>`.                                              |
| `cliDescription`      | No       | `string`                                                              | Description used in CLI help.                                                                             |
| `appGuidedSecret`     | No       | `boolean`                                                             | One pasted secret plus provider defaults is sufficient for app-guided setup.                              |
| `appGuidedDiscovery`  | No       | `boolean`                                                             | The matching runtime auth method owns read-only local discovery through `appGuidedSetup`.                 |
| `appGuidedAuth`       | No       | `"oauth"` \| `"device-code"`                                          | Provider-owned interactive login that native setup clients can render generically.                        |
| `onboardingScopes`    | No       | `Array<"text-inference" \| "image-generation" \| "music-generation">` | Which onboarding surfaces this choice should appear in. If omitted, it defaults to `["text-inference"]`.  |

When `appGuidedDiscovery` is true, the matching provider auth method must expose
`appGuidedSetup.detect` and `appGuidedSetup.prepare`. Detection must be
read-only: no login, model pull, download, or config write. Preparation rechecks
the exact selected model and returns a config proposal; OpenClaw live-tests that
proposal in isolation and commits it only after success.

## commandAliases reference

Use `commandAliases` when a plugin owns a runtime command name that users may mistakenly put in `plugins.allow` or try to run as a root CLI command. OpenClaw uses this metadata for diagnostics without importing plugin runtime code.

```json
{
  "commandAliases": [
    {
      "name": "dreaming",
      "kind": "runtime-slash",
      "cliCommand": "memory"
    }
  ]
}
```

| Field        | Required | Type              | What it means                                                           |
| ------------ | -------- | ----------------- | ----------------------------------------------------------------------- |
| `name`       | Yes      | `string`          | Command name that belongs to this plugin.                               |
| `kind`       | No       | `"runtime-slash"` | Marks the alias as a chat slash command rather than a root CLI command. |
| `cliCommand` | No       | `string`          | Related root CLI command to suggest for CLI operations, if one exists.  |

## activation reference

Use `activation` when the plugin can cheaply declare which control-plane events should include it in an activation/load plan.

This block is planner metadata, not a lifecycle API. It does not register runtime behavior, does not replace `register(...)`, and does not promise that plugin code has already executed. The activation planner uses these fields to narrow candidate plugins before falling back to existing manifest ownership metadata such as `providers`, `channels`, `commandAliases`, `setup.providers`, `contracts.tools`, and hooks.

Prefer the narrowest metadata that already describes ownership. Use `providers`, `channels`, `commandAliases`, setup descriptors, or `contracts` when those fields express the relationship. Use `activation` for extra planner hints that cannot be represented by those ownership fields. Use top-level `cliBackends` for CLI runtime aliases such as `claude-cli`, `my-cli`, or `google-gemini-cli`; `activation.onAgentHarnesses` is only for embedded agent harness ids that do not already have an ownership field.

Every plugin should set `activation.onStartup` intentionally. Set it to `true` only when the plugin must run during Gateway startup. Set it to `false` when the plugin is inert at startup and should load only from narrower triggers. Omitting `onStartup` no longer startup-loads the plugin implicitly; use explicit activation metadata for startup, channel, config, agent-harness, memory, or other narrower activation triggers.

```json
{
  "activation": {
    "onStartup": false,
    "onProviders": ["openai"],
    "onCommands": ["models"],
    "onChannels": ["web"],
    "onRoutes": ["gateway-webhook"],
    "onConfigPaths": ["browser"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| Field              | Required | Type                                                 | What it means                                                                                                                                                                               |
| ------------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onStartup`        | No       | `boolean`                                            | Explicit Gateway startup activation. Every plugin should set this. `true` imports the plugin during startup; `false` keeps it startup-lazy unless another matched trigger requires loading. |
| `onProviders`      | No       | `string[]`                                           | Provider ids that should include this plugin in activation/load plans.                                                                                                                      |
| `onAgentHarnesses` | No       | `string[]`                                           | Embedded agent harness runtime ids that should include this plugin in activation/load plans. Use top-level `cliBackends` for CLI backend aliases.                                           |
| `onCommands`       | No       | `string[]`                                           | Command ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onChannels`       | No       | `string[]`                                           | Channel ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onRoutes`         | No       | `string[]`                                           | Route kinds that should include this plugin in activation/load plans.                                                                                                                       |
| `onConfigPaths`    | No       | `string[]`                                           | Root-relative config paths that should include this plugin in startup/load plans when the path is present and not explicitly disabled.                                                      |
| `onCapabilities`   | No       | `Array<"provider" \| "channel" \| "tool" \| "hook">` | Broad capability hints used by control-plane activation planning. Prefer narrower fields when possible.                                                                                     |

Current live consumers:

- Gateway startup planning uses `activation.onStartup` for explicit startup import.
- Command-triggered CLI planning falls back to legacy `commandAliases[].cliCommand` or `commandAliases[].name`.
- Agent-runtime startup planning uses `activation.onAgentHarnesses` for embedded harnesses and top-level `cliBackends[]` for CLI runtime aliases.
- Channel-triggered setup/channel planning falls back to legacy `channels[]` ownership when explicit channel activation metadata is missing.
- Startup plugin planning uses `activation.onConfigPaths` for non-channel root config surfaces such as the bundled browser plugin's `browser` block.
- Provider-triggered setup/runtime planning falls back to legacy `providers[]` and top-level `cliBackends[]` ownership when explicit provider activation metadata is missing.

Planner diagnostics can distinguish explicit activation hints from manifest ownership fallback. For example, `activation-command-hint` means `activation.onCommands` matched, while `manifest-command-alias` means the planner used `commandAliases` ownership instead. These reason labels are for host diagnostics and tests; plugin authors should keep declaring the metadata that best describes ownership.

## qaRunners reference

Use `qaRunners` when a plugin contributes one or more transport runners beneath
the shared `openclaw qa` root. Keep this metadata cheap and static; the plugin
runtime still owns actual CLI registration through a lightweight
`runtime-api.ts` surface that exports matching `qaRunnerCliRegistrations`. An
optional `adapterFactory` exposes the transport to shared QA scenarios without
changing the registered command's runner.

```json
{
  "qaRunners": [
    {
      "commandName": "matrix",
      "description": "Run the Docker-backed Matrix live QA lane against a disposable homeserver"
    }
  ]
}
```

| Field         | Required | Type     | What it means                                                      |
| ------------- | -------- | -------- | ------------------------------------------------------------------ |
| `commandName` | Yes      | `string` | Subcommand mounted beneath `openclaw qa`, for example `matrix`.    |
| `description` | No       | `string` | Fallback help text used when the shared host needs a stub command. |

The `adapterFactory` id must match `commandName`. Do not export registrations
for commands absent from the manifest.

## setup reference

Use `setup` when setup and onboarding surfaces need cheap plugin-owned metadata before runtime loads.

```json
{
  "setup": {
    "providers": [
      {
        "id": "openai",
        "authMethods": ["api-key"],
        "envVars": ["OPENAI_API_KEY"],
        "authEvidence": [
          {
            "type": "local-file-with-env",
            "fileEnvVar": "OPENAI_CREDENTIALS_FILE",
            "requiresAllEnv": ["OPENAI_PROJECT"],
            "credentialMarker": "openai-local-credentials",
            "source": "openai local credentials"
          }
        ]
      }
    ],
    "cliBackends": ["openai-cli"],
    "configMigrations": ["legacy-openai-auth"],
    "requiresRuntime": false
  }
}
```

Top-level `cliBackends` stays valid and continues to describe CLI inference backends. `setup.cliBackends` is the setup-specific descriptor surface for control-plane/setup flows that should stay metadata-only.

When present, `setup.providers` and `setup.cliBackends` are the preferred descriptor-first lookup surface for setup discovery. If the descriptor only narrows the candidate plugin and setup still needs richer setup-time runtime hooks, set `requiresRuntime: true` and keep `setup-api` in place as the fallback execution path.

OpenClaw includes `setup.providers[].envVars` in generic provider auth and env-var lookups. Put setup and status env metadata there.

Use `providerUsageAuthEnvVars` when a billing or organization-level credential must activate `resolveUsageAuth` without becoming an inference credential. These names join workspace dotenv blocking, ACP child-process stripping, sandbox secret filtering, and broad secret scrubbing. The provider runtime still reads and classifies the value inside `resolveUsageAuth`.

OpenClaw can also derive simple setup choices from `setup.providers[].authMethods` when no setup entry is available, or when `setup.requiresRuntime: false` declares setup runtime unnecessary. Explicit `providerAuthChoices` entries stay preferred for custom labels, CLI flags, onboarding scope, and assistant metadata.

Set `requiresRuntime: false` only when those descriptors are sufficient for the setup surface. OpenClaw treats explicit `false` as a descriptor-only contract and will not execute `setup-api` or `openclaw.setupEntry` for setup lookup. If a descriptor-only plugin still ships one of those setup runtime entries, OpenClaw reports an additive diagnostic and continues ignoring it. Omitted `requiresRuntime` keeps legacy fallback behavior so existing plugins that added descriptors without the flag do not break.

Because setup lookup can execute plugin-owned `setup-api` code, normalized `setup.providers[].id` and `setup.cliBackends[]` values must stay unique across discovered plugins. Ambiguous ownership fails closed instead of picking a winner from discovery order.

When setup runtime does execute, setup registry diagnostics report descriptor drift if `setup-api` registers a provider or CLI backend that the manifest descriptors do not declare, or if a descriptor has no matching runtime registration. These diagnostics are additive and do not reject legacy plugins.

### setup.providers reference

| Field          | Required | Type       | What it means                                                                                    |
| -------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `id`           | Yes      | `string`   | Provider id exposed during setup or onboarding. Keep normalized ids globally unique.             |
| `authMethods`  | No       | `string[]` | Setup/auth method ids this provider supports without loading full runtime.                       |
| `envVars`      | No       | `string[]` | Env vars that generic setup/status surfaces can check before plugin runtime loads.               |
| `authEvidence` | No       | `object[]` | Cheap local auth evidence checks for providers that can authenticate through non-secret markers. |

`authEvidence` is for provider-owned local credential markers that can be verified without loading runtime code. These checks must stay cheap and local: no network calls, no keychain or secret-manager reads, no shell commands, and no provider API probes.

Supported evidence entries:

| Field              | Required | Type       | What it means                                                                                                  |
| ------------------ | -------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `type`             | Yes      | `string`   | Currently `local-file-with-env`.                                                                               |
| `fileEnvVar`       | No       | `string`   | Env var containing an explicit credential file path.                                                           |
| `fallbackPaths`    | No       | `string[]` | Local credential file paths checked when `fileEnvVar` is absent or empty. Supports `${HOME}` and `${APPDATA}`. |
| `requiresAnyEnv`   | No       | `string[]` | At least one listed env var must be non-empty before the evidence is valid.                                    |
| `requiresAllEnv`   | No       | `string[]` | Every listed env var must be non-empty before the evidence is valid.                                           |
| `credentialMarker` | Yes      | `string`   | Non-secret marker returned when the evidence is present.                                                       |
| `source`           | No       | `string`   | User-facing source label for auth/status output.                                                               |

### setup fields

| Field              | Required | Type       | What it means                                                                                       |
| ------------------ | -------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `providers`        | No       | `object[]` | Provider setup descriptors exposed during setup and onboarding.                                     |
| `cliBackends`      | No       | `string[]` | Setup-time backend ids used for descriptor-first setup lookup. Keep normalized ids globally unique. |
| `configMigrations` | No       | `string[]` | Config migration ids owned by this plugin's setup surface.                                          |
| `requiresRuntime`  | No       | `boolean`  | Whether setup still needs `setup-api` execution after descriptor lookup.                            |

## uiHints reference

`uiHints` is a map from config field names to small rendering hints. Keys can use dots for nested config fields, but no path segment may be `__proto__`, `constructor`, or `prototype`; setup rejects those names.

```json
{
  "uiHints": {
    "apiKey": {
      "label": "API key",
      "help": "Used for OpenRouter requests",
      "placeholder": "sk-or-v1-...",
      "sensitive": true
    }
  }
}
```

Each field hint can include:

| Field         | Type       | What it means                           |
| ------------- | ---------- | --------------------------------------- |
| `label`       | `string`   | User-facing field label.                |
| `help`        | `string`   | Short helper text.                      |
| `tags`        | `string[]` | Optional UI tags.                       |
| `advanced`    | `boolean`  | Marks the field as advanced.            |
| `sensitive`   | `boolean`  | Marks the field as secret or sensitive. |
| `placeholder` | `string`   | Placeholder text for form inputs.       |

## contracts reference

Use `contracts` only for static capability ownership metadata that OpenClaw can read without importing the plugin runtime.

```json
{
  "contracts": {
    "agentToolResultMiddleware": ["openclaw", "codex"],
    "trustedToolPolicies": ["workflow-budget"],
    "externalAuthProviders": ["acme-ai"],
    "embeddingProviders": ["openai-compatible"],
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "memoryEmbeddingProviders": ["local"],
    "mediaUnderstandingProviders": ["openai"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "musicGenerationProviders": ["stability-audio"],
    "documentExtractors": ["example-docs"],
    "webContentExtractors": ["firecrawl"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "workerProviders": ["example-worker"],
    "usageProviders": ["acme-ai"],
    "migrationProviders": ["hermes"],
    "gatewayMethodDispatch": ["authenticated-request"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

Each list is optional:

| Field                            | Type       | What it means                                                                                                                        |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `embeddedExtensionFactories`     | `string[]` | Codex app-server extension factory ids, currently `codex-app-server`.                                                                |
| `agentToolResultMiddleware`      | `string[]` | Runtime ids this plugin may register tool-result middleware for.                                                                     |
| `trustedToolPolicies`            | `string[]` | Plugin-local trusted pre-tool policy ids an installed plugin may register. Bundled plugins may register policies without this field. |
| `externalAuthProviders`          | `string[]` | Provider ids whose external auth profile hook this plugin owns.                                                                      |
| `embeddingProviders`             | `string[]` | General embedding provider ids this plugin owns for reusable vector embedding use, including memory.                                 |
| `speechProviders`                | `string[]` | Speech provider ids this plugin owns.                                                                                                |
| `realtimeTranscriptionProviders` | `string[]` | Realtime-transcription provider ids this plugin owns.                                                                                |
| `realtimeVoiceProviders`         | `string[]` | Realtime-voice provider ids this plugin owns.                                                                                        |
| `memoryEmbeddingProviders`       | `string[]` | Deprecated memory-specific embedding provider ids this plugin owns.                                                                  |
| `mediaUnderstandingProviders`    | `string[]` | Media-understanding provider ids this plugin owns.                                                                                   |
| `transcriptSourceProviders`      | `string[]` | Transcript source provider ids this plugin owns.                                                                                     |
| `documentExtractors`             | `string[]` | Document (for example PDF) extractor provider ids this plugin owns.                                                                  |
| `imageGenerationProviders`       | `string[]` | Image-generation provider ids this plugin owns.                                                                                      |
| `videoGenerationProviders`       | `string[]` | Video-generation provider ids this plugin owns.                                                                                      |
| `musicGenerationProviders`       | `string[]` | Music-generation provider ids this plugin owns.                                                                                      |
| `webContentExtractors`           | `string[]` | Web-page content-extraction provider ids this plugin owns.                                                                           |
| `webFetchProviders`              | `string[]` | Web-fetch provider ids this plugin owns.                                                                                             |
| `webSearchProviders`             | `string[]` | Web-search provider ids this plugin owns.                                                                                            |
| `workerProviders`                | `string[]` | Cloud-worker provider ids this plugin owns for provisioning and profile-backed lease lifecycle.                                      |
| `usageProviders`                 | `string[]` | Provider ids whose usage-auth and usage-snapshot hooks this plugin owns.                                                             |
| `migrationProviders`             | `string[]` | Import provider ids this plugin owns for `openclaw migrate`.                                                                         |
| `gatewayMethodDispatch`          | `string[]` | Reserved entitlement for authenticated plugin HTTP routes that dispatch Gateway methods in-process.                                  |
| `tools`                          | `string[]` | Agent tool names this plugin owns.                                                                                                   |

`contracts.embeddedExtensionFactories` is retained for bundled Codex app-server-only extension factories. Bundled tool-result transforms should declare `contracts.agentToolResultMiddleware` and register with `api.registerAgentToolResultMiddleware(...)` instead. Installed plugins may use the same middleware seam only when explicitly enabled and only for runtimes they declare in `contracts.agentToolResultMiddleware`.

Installed plugins that need the host-trusted pre-tool policy tier must declare each registered local id in `contracts.trustedToolPolicies` and be explicitly enabled. Bundled plugins keep the existing trusted-policy path, but installed plugins with undeclared policy ids are rejected before registration. Policy ids are scoped to the registering plugin, so two plugins may both declare and register `workflow-budget`; a single plugin may not register the same local id twice.

Runtime `api.registerTool(...)` registrations must match `contracts.tools`. Tool discovery uses this list to load only the plugin runtimes that can own the requested tools.

Provider plugins that implement `resolveExternalAuthProfiles` should declare `contracts.externalAuthProviders`; undeclared external-auth hooks are ignored.

Provider plugins that implement both `resolveUsageAuth` and `fetchUsageSnapshot` should declare each auto-discovered provider id in `contracts.usageProviders`. Usage discovery reads this contract before loading runtime code, then verifies both hooks after loading only the declared owners.

General embedding providers should declare `contracts.embeddingProviders` for each adapter registered with `api.registerEmbeddingProvider(...)`. Use the general contract for reusable vector generation, including providers consumed by memory search. `contracts.memoryEmbeddingProviders` is deprecated memory-specific compatibility and remains only while existing providers migrate to the generic embedding provider seam.

Worker providers must declare each `api.registerWorkerProvider(...)` id in `contracts.workerProviders`. Core persists durable intent before calling `provision`; providers validate their settings before external allocation, and repeated calls with the same operation id must adopt the same lease. Core also persists that validated settings snapshot and passes it with `leaseId` to `inspect({ leaseId, profile })` and `destroy({ leaseId, profile })`, including after the named profile is changed or removed. Destruction is idempotent, inspection returns the closed `active` / `destroyed` / `unknown` status union, and SSH private-key material is referenced only through `SecretRef`. Provisioned SSH endpoints must also include a public `hostKey` from trusted provisioning output as exactly `algorithm base64`, without a hostname or comment, so core can pin the host before connecting. Providers that mint dynamic identity refs may implement authoritative `resolveSshIdentity({ leaseId, profile, keyRef })`; providers without it use core's generic secret resolver. An authoritative `unknown` orphans an active local record; after a persisted destroy request it confirms teardown.

`contracts.gatewayMethodDispatch` currently accepts `"authenticated-request"`. It is an API hygiene gate for native plugin HTTP routes that intentionally dispatch Gateway control-plane methods in-process, not a sandbox against malicious native plugins. Use it only for tightly reviewed bundled/operator surfaces that already require Gateway HTTP auth. An entitled route remains reachable while Gateway root-work admission is closed only when it also declares `auth: "gateway"` and the route-specific `gatewayRuntimeScopeSurface: "trusted-operator"`; ordinary sibling routes from the same plugin remain behind the admission boundary. This keeps suspension status and resume reachable without granting the whole plugin an admission bypass. Keep parsing and response shaping bounded outside dispatch; substantive or mutating work must go through Gateway method dispatch, which owns admission and scope enforcement.

## configContracts reference

Use `configContracts` for manifest-owned config behavior that generic core helpers need without importing plugin runtime: dangerous-flag detection, SecretRef migration targets, and legacy config-path narrowing.

```json
{
  "configContracts": {
    "compatibilityMigrationPaths": ["legacyProvider"],
    "compatibilityRuntimePaths": ["legacyProvider.webhook"],
    "dangerousFlags": [
      {
        "path": "accounts.*.allowUnverifiedSenders",
        "equals": true
      }
    ],
    "secretInputs": {
      "bundledDefaultEnabled": false,
      "paths": [
        {
          "path": "routes.*.secret",
          "expected": "string",
          "ownerKind": "route"
        }
      ]
    }
  }
}
```

| Field                         | Required | Type       | What it means                                                                                                                                                                                                                          |
| ----------------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compatibilityMigrationPaths` | No       | `string[]` | Root-relative config paths that indicate this plugin's setup-time compatibility migrations might apply. Lets generic runtime config reads skip every plugin setup surface when the config never references the plugin.                 |
| `compatibilityRuntimePaths`   | No       | `string[]` | Root-relative compatibility paths this plugin can service during runtime before plugin code fully activates. Use this for legacy surfaces that should narrow bundled candidate sets without importing every compatible plugin runtime. |
| `dangerousFlags`              | No       | `object[]` | Config literals that `openclaw doctor` should flag as insecure or dangerous when enabled. See below.                                                                                                                                   |
| `secretInputs`                | No       | `object`   | Config paths under `plugins.entries.<id>.config` for SecretRef migration, audit, startup materialization, and optional runtime owner isolation. See below.                                                                             |

Each `dangerousFlags` entry supports:

| Field    | Required | Type                                  | What it means                                                                                                       |
| -------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `path`   | Yes      | `string`                              | Dot-separated config path relative to `plugins.entries.<id>.config`. Supports `*` wildcards for map/array segments. |
| `equals` | Yes      | `string \| number \| boolean \| null` | Exact literal that marks this config value as dangerous.                                                            |

`secretInputs` supports:

| Field                   | Required | Type       | What it means                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundledDefaultEnabled` | No       | `boolean`  | Override bundled-plugin default enablement when deciding whether this SecretRef surface is active. Use this when the plugin is bundled but the surface should stay inactive until explicitly enabled in config.                                                                                                                                            |
| `paths`                 | Yes      | `object[]` | Secret-shaped config paths, each with `path` (dot-separated, relative to `plugins.entries.<id>.config`, supports `*` wildcards), optional `expected` (currently only `"string"`), and optional `ownerKind` (currently only `"route"`). A declared owner isolates only that exact matched path when resolution fails; its owner id is the full config path. |

## mediaUnderstandingProviderMetadata reference

Use `mediaUnderstandingProviderMetadata` when a media-understanding provider has default models, auto-auth fallback priority, or native document support that generic core helpers need before runtime loads. Keys must also be declared in `contracts.mediaUnderstandingProviders`.

```json
{
  "contracts": {
    "mediaUnderstandingProviders": ["example"]
  },
  "mediaUnderstandingProviderMetadata": {
    "example": {
      "capabilities": ["image", "audio"],
      "defaultModels": {
        "image": "example-vision-latest",
        "audio": "example-transcribe-latest"
      },
      "autoPriority": {
        "image": 40
      },
      "nativeDocumentInputs": ["pdf"],
      "documentModels": {
        "pdf": {
          "textExtraction": "example-doc-text-latest",
          "image": "example-doc-vision-latest"
        }
      }
    }
  }
}
```

Each provider entry can include:

| Field                  | Type                                                             | What it means                                                                                                   |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `capabilities`         | `("image" \| "audio" \| "video")[]`                              | Media capabilities exposed by this provider.                                                                    |
| `defaultModels`        | `Record<string, string>`                                         | Capability-to-model defaults used when config does not specify a model.                                         |
| `autoPriority`         | `Record<string, number>`                                         | Lower numbers sort earlier for automatic credential-based provider fallback.                                    |
| `nativeDocumentInputs` | `"pdf"[]`                                                        | Native document inputs supported by the provider.                                                               |
| `documentModels`       | `{ pdf?: { textExtraction?: string; image?: string \| false } }` | Per-document-type model overrides. Set `image: false` to disable image-based extraction for that document type. |

## channelConfigs reference

Use `channelConfigs` when a channel plugin needs cheap config metadata before runtime loads. Read-only channel setup/status discovery can use this metadata directly for configured external channels when no setup entry is available, or when `setup.requiresRuntime: false` declares setup runtime unnecessary.

`channelConfigs` is plugin manifest metadata, not a new top-level user config section. Users still configure channel instances under `channels.<channel-id>`. OpenClaw reads manifest metadata to decide which plugin owns that configured channel before plugin runtime code executes.

For a channel plugin, `configSchema` and `channelConfigs` describe different paths:

- `configSchema` validates `plugins.entries.<plugin-id>.config`
- `channelConfigs.<channel-id>.schema` validates `channels.<channel-id>`

Non-bundled plugins that declare `channels[]` should also declare matching `channelConfigs` entries. Without them, OpenClaw can still load the plugin, but cold-path config schema, setup, and Control UI surfaces cannot know the channel-owned option shape until plugin runtime executes.

`channelConfigs.<channel-id>.commands.nativeCommandsAutoEnabled` and `nativeSkillsAutoEnabled` can declare static `auto` defaults for command config checks that run before channel runtime loads. Bundled channels can also publish the same defaults through `package.json#openclaw.channel.commands` alongside their other package-owned channel catalog metadata.

```json
{
  "channelConfigs": {
    "matrix": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "homeserverUrl": { "type": "string" }
        }
      },
      "uiHints": {
        "homeserverUrl": {
          "label": "Homeserver URL",
          "placeholder": "https://matrix.example.com"
        }
      },
      "label": "Matrix",
      "description": "Matrix homeserver connection",
      "commands": {
        "nativeCommandsAutoEnabled": true,
        "nativeSkillsAutoEnabled": true
      },
      "preferOver": ["matrix-legacy"]
    }
  }
}
```

Each channel entry can include:

| Field         | Type                     | What it means                                                                             |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `schema`      | `object`                 | JSON Schema for `channels.<id>`. Required for each declared channel config entry.         |
| `uiHints`     | `Record<string, object>` | Optional UI labels/placeholders/sensitive hints for that channel config section.          |
| `label`       | `string`                 | Channel label merged into picker and inspect surfaces when runtime metadata is not ready. |
| `description` | `string`                 | Short channel description for inspect and catalog surfaces.                               |
| `commands`    | `object`                 | Static native command and native skill auto-defaults for pre-runtime config checks.       |
| `preferOver`  | `string[]`               | Legacy or lower-priority plugin ids this channel should outrank in selection surfaces.    |

### Replacing another channel plugin

Use `preferOver` when your plugin is the preferred owner for a channel id that another plugin can also provide. Common cases are a renamed plugin id, a standalone plugin that supersedes a bundled plugin, or a maintained fork that keeps the same channel id for config compatibility.

```json
{
  "id": "acme-chat",
  "channels": ["chat"],
  "channelConfigs": {
    "chat": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "webhookUrl": { "type": "string" }
        }
      },
      "preferOver": ["chat"]
    }
  }
}
```

When `channels.chat` is configured, OpenClaw considers both the channel id and the preferred plugin id. If the lower-priority plugin was only selected because it is bundled or enabled by default, OpenClaw disables it in the effective runtime config so one plugin owns the channel and its tools. Explicit user selection still wins: if the user explicitly enables both plugins (via `plugins.allow` or a material `plugins.entries` config), OpenClaw preserves that choice and reports duplicate channel/tool diagnostics instead of silently changing the requested plugin set.

Keep `preferOver` scoped to plugin ids that can really provide the same channel. It is not a general priority field and it does not rename user config keys.

## modelSupport reference

Use `modelSupport` when OpenClaw should infer your provider plugin from shorthand model ids like `gpt-5.6-sol` or `claude-sonnet-4.6` before plugin runtime loads.

```json
{
  "modelSupport": {
    "modelPrefixes": ["gpt-", "o1", "o3", "o4"],
    "modelPatterns": ["^computer-use-preview"]
  }
}
```

OpenClaw applies this precedence:

- explicit `provider/model` refs use the owning `providers` manifest metadata
- `modelPatterns` beat `modelPrefixes`
- if one non-bundled plugin and one bundled plugin both match, the non-bundled plugin wins
- remaining ambiguity is ignored until the user or config specifies a provider

Fields:

| Field           | Type       | What it means                                                                   |
| --------------- | ---------- | ------------------------------------------------------------------------------- |
| `modelPrefixes` | `string[]` | Prefixes matched with `startsWith` against shorthand model ids.                 |
| `modelPatterns` | `string[]` | Regex sources matched against shorthand model ids after profile suffix removal. |

`modelPatterns` entries are compiled through `compileSafeRegex`, which rejects patterns containing nested repetition (for example `(a+)+$`). Patterns that fail the safety check are silently skipped, the same as syntactically invalid regex. Keep patterns simple and avoid nested quantifiers.

## modelCatalog reference

Use `modelCatalog` when OpenClaw should know provider model metadata before loading plugin runtime. This is the manifest-owned source for fixed catalog rows, provider aliases, suppression rules, and discovery mode. Runtime refresh still belongs in provider runtime code, but the manifest tells core when runtime is required.

```json
{
  "providers": ["openai"],
  "modelCatalog": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai-responses",
        "models": [
          {
            "id": "gpt-5.4",
            "name": "GPT-5.4",
            "input": ["text", "image"],
            "reasoning": true,
            "contextWindow": 256000,
            "maxTokens": 128000,
            "cost": {
              "input": 1.25,
              "output": 10,
              "cacheRead": 0.125
            },
            "status": "available",
            "tags": ["default"]
          }
        ]
      }
    },
    "aliases": {
      "azure-openai-responses": {
        "provider": "openai",
        "api": "azure-openai-responses"
      }
    },
    "suppressions": [
      {
        "provider": "azure-openai-responses",
        "model": "gpt-5.3-codex-spark",
        "reason": "not available on Azure OpenAI Responses"
      }
    ],
    "discovery": {
      "openai": "static"
    }
  }
}
```

Top-level fields:

| Field            | Type                                                     | What it means                                                                                               |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `providers`      | `Record<string, object>`                                 | Catalog rows for provider ids owned by this plugin. Keys should also appear in top-level `providers`.       |
| `aliases`        | `Record<string, object>`                                 | Provider aliases that should resolve to an owned provider for catalog or suppression planning.              |
| `suppressions`   | `object[]`                                               | Model rows from another source that this plugin suppresses for a provider-specific reason.                  |
| `discovery`      | `Record<string, "static" \| "refreshable" \| "runtime">` | Whether the provider catalog can be read from manifest metadata, refreshed into cache, or requires runtime. |
| `runtimeAugment` | `boolean`                                                | Set to `true` only when the provider runtime must append catalog rows after manifest/config planning.       |

`aliases` participates in provider ownership lookup for model-catalog planning. Alias targets must be top-level providers owned by the same plugin. When a provider-filtered list uses an alias, OpenClaw can read the owning manifest and apply alias API/base URL overrides without loading provider runtime. Aliases do not expand unfiltered catalog listings; broad lists emit the owning canonical provider rows only.

`suppressions` replaces the old provider runtime `suppressBuiltInModel` hook. Suppression entries are honored only when the provider is owned by the plugin or declared as a `modelCatalog.aliases` key that targets an owned provider. Runtime suppression hooks are no longer called during model resolution.

Provider fields:

| Field                 | Type                     | What it means                                                                                                                                                                                                     |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`             | `string`                 | Optional default base URL for models in this provider catalog.                                                                                                                                                    |
| `api`                 | `ModelApi`               | Optional default API adapter for models in this provider catalog.                                                                                                                                                 |
| `headers`             | `Record<string, string>` | Optional static headers that apply to this provider catalog.                                                                                                                                                      |
| `defaultUtilityModel` | `string`                 | Optional provider-recommended small model id for short internal utility tasks (titles, progress narration). Used when `agents.defaults.utilityModel` is unset and this provider serves the agent's primary model. |
| `models`              | `object[]`               | Required model rows. Rows without an `id` are ignored.                                                                                                                                                            |

Model fields:

| Field              | Type                                                           | What it means                                                               |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`               | `string`                                                       | Provider-local model id, without the `provider/` prefix.                    |
| `name`             | `string`                                                       | Optional display name.                                                      |
| `api`              | `ModelApi`                                                     | Optional per-model API override.                                            |
| `baseUrl`          | `string`                                                       | Optional per-model base URL override.                                       |
| `headers`          | `Record<string, string>`                                       | Optional per-model static headers.                                          |
| `input`            | `Array<"text" \| "image" \| "document">`                       | Modalities the model accepts. Other values are silently dropped.            |
| `reasoning`        | `boolean`                                                      | Whether the model exposes reasoning behavior.                               |
| `contextWindow`    | `number`                                                       | Native provider context window.                                             |
| `contextTokens`    | `number`                                                       | Optional effective runtime context cap when different from `contextWindow`. |
| `maxTokens`        | `number`                                                       | Maximum output tokens when known.                                           |
| `thinkingLevelMap` | `Record<string, string \| null>`                               | Optional per-thinking-level model-id or param overrides.                    |
| `cost`             | `object`                                                       | Optional USD per million token pricing, including optional `tieredPricing`. |
| `compat`           | `object`                                                       | Optional compatibility flags matching OpenClaw model config compatibility.  |
| `mediaInput`       | `object`                                                       | Optional per-modality input config, currently image-only.                   |
| `status`           | `"available"` \| `"preview"` \| `"deprecated"` \| `"disabled"` | Listing status. Suppress only when the row must not appear at all.          |
| `statusReason`     | `string`                                                       | Optional reason shown with non-available status.                            |
| `replaces`         | `string[]`                                                     | Older provider-local model ids this model supersedes.                       |
| `replacedBy`       | `string`                                                       | Replacement provider-local model id for deprecated rows.                    |
| `tags`             | `string[]`                                                     | Stable tags used by pickers and filters.                                    |

Suppression fields:

| Field                      | Type       | What it means                                                                                             |
| -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `provider`                 | `string`   | Provider id for the upstream row to suppress. Must be owned by this plugin or declared as an owned alias. |
| `model`                    | `string`   | Provider-local model id to suppress.                                                                      |
| `reason`                   | `string`   | Optional message shown when the suppressed row is requested directly.                                     |
| `when.baseUrlHosts`        | `string[]` | Optional list of effective provider base URL hosts required before the suppression applies.               |
| `when.providerConfigApiIn` | `string[]` | Optional list of exact provider-config `api` values required before the suppression applies.              |

Do not put runtime-only data in `modelCatalog`. Use `static` only when manifest rows are complete enough for provider-filtered list and picker surfaces to skip registry/runtime discovery. Use `refreshable` when manifest rows are useful listable seeds or supplements but a refresh/cache can add more rows later; refreshable rows are not authoritative by themselves. Use `runtime` when OpenClaw must load provider runtime to know the list.

## modelIdNormalization reference

Use `modelIdNormalization` for cheap provider-owned model-id cleanup that must happen before provider runtime loads. This keeps aliases such as short model names, provider-local legacy ids, and proxy prefix rules in the owning plugin manifest instead of in core model-selection tables.

```json
{
  "providers": ["anthropic", "openrouter"],
  "modelIdNormalization": {
    "providers": {
      "anthropic": {
        "aliases": {
          "sonnet-4.6": "claude-sonnet-4-6"
        }
      },
      "openrouter": {
        "prefixWhenBare": "openrouter"
      }
    }
  }
}
```

Provider fields:

| Field                                | Type                    | What it means                                                                             |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `aliases`                            | `Record<string,string>` | Case-insensitive exact model-id aliases. Values are returned as written.                  |
| `stripPrefixes`                      | `string[]`              | Prefixes to remove before alias lookup, useful for legacy provider/model duplication.     |
| `prefixWhenBare`                     | `string`                | Prefix to add when the normalized model id does not already contain `/`.                  |
| `prefixWhenBareAfterAliasStartsWith` | `object[]`              | Conditional bare-id prefix rules after alias lookup, keyed by `modelPrefix` and `prefix`. |

## providerEndpoints reference

Use `providerEndpoints` for endpoint classification that generic request policy must know before provider runtime loads. Core still owns the meaning of each `endpointClass`; plugin manifests own the host and base URL metadata.

Officially externalized provider plugins are excluded from the core dist, so
their manifests are invisible until installed. Their `providerEndpoints` must
also be mirrored in `scripts/lib/official-external-provider-catalog.json` so
endpoint classification keeps working without the plugin; a contract test
enforces the mirror.

Endpoint fields:

| Field                          | Type       | What it means                                                                                  |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `endpointClass`                | `string`   | Known core endpoint class, such as `openrouter`, `moonshot-native`, or `google-vertex`.        |
| `hosts`                        | `string[]` | Exact hostnames that map to the endpoint class.                                                |
| `hostSuffixes`                 | `string[]` | Host suffixes that map to the endpoint class. Prefix with `.` for domain suffix-only matching. |
| `baseUrls`                     | `string[]` | Exact normalized HTTP(S) base URLs that map to the endpoint class.                             |
| `googleVertexRegion`           | `string`   | Static Google Vertex region for exact global hosts.                                            |
| `googleVertexRegionHostSuffix` | `string`   | Suffix to strip from matching hosts to expose the Google Vertex region prefix.                 |

## providerRequest reference

Use `providerRequest` for cheap request-compatibility metadata that generic request policy needs without loading provider runtime. Keep behavior-specific payload rewriting in provider runtime hooks or shared provider-family helpers.

```json
{
  "providerRequest": {
    "providers": {
      "vllm": {
        "family": "vllm",
        "openAICompletions": {
          "supportsStreamingUsage": true
        }
      }
    }
  }
}
```

Provider fields:

| Field                 | Type         | What it means                                                                          |
| --------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `family`              | `string`     | Provider family label used by generic request compatibility decisions and diagnostics. |
| `compatibilityFamily` | `"moonshot"` | Optional provider-family compatibility bucket for shared request helpers.              |
| `openAICompletions`   | `object`     | OpenAI-compatible completions request flags, currently `supportsStreamingUsage`.       |

## secretProviderIntegrations reference

Use `secretProviderIntegrations` when a plugin can publish a reusable SecretRef exec provider preset. OpenClaw reads this metadata before plugin runtime loads, stores plugin ownership in `secrets.providers.<alias>.pluginIntegration`, and leaves actual secret resolution to the SecretRef runtime. Presets are exposed only for bundled plugins and installed plugins discovered from the managed plugin install roots, such as git and ClawHub installs.

```json
{
  "secretProviderIntegrations": {
    "secret-store": {
      "providerAlias": "team-secrets",
      "displayName": "Team secrets",
      "source": "exec",
      "command": "${node}",
      "args": ["./bin/resolve-secrets.mjs"]
    }
  }
}
```

The map key is the integration id. If `providerAlias` is omitted, OpenClaw uses the integration id as the SecretRef provider alias. Provider aliases must match the normal SecretRef provider alias pattern, for example `team-secrets` or `onepassword-work`.

When an operator selects the preset, OpenClaw writes a provider reference like:

```json
{
  "secrets": {
    "providers": {
      "team-secrets": {
        "source": "exec",
        "pluginIntegration": {
          "pluginId": "acme-secrets",
          "integrationId": "secret-store"
        }
      }
    }
  }
}
```

At startup/reload, OpenClaw resolves that provider by loading current plugin manifest metadata, checking that the owning plugin is installed and active, and materializing the exec command from the manifest. Disabling or removing the plugin revokes the provider for active SecretRefs. Operators who want standalone exec configuration can still write manual `command`/`args` providers directly.

Only `source: "exec"` presets are currently supported. `command` must be `${node}`, and `args[0]` must be a `./` plugin-root-relative resolver script. OpenClaw materializes it at startup/reload to the current Node executable and the absolute in-plugin script path. Node options such as `--require`, `--import`, `--loader`, `--env-file`, `--eval`, and `--print` are not part of the manifest preset contract. Operators who need non-Node commands can configure standalone manual exec providers directly.

OpenClaw derives `trustedDirs` for manifest presets from the plugin root and, for `${node}` presets, the current Node executable directory. Manifest-authored `trustedDirs` are ignored. Other exec provider options such as `timeoutMs`, `noOutputTimeoutMs`, `maxOutputBytes`, `jsonOnly`, `env`, `passEnv`, and `allowInsecurePath` pass through to the normal SecretRef exec provider config.

## modelPricing reference

Use `modelPricing` when a provider needs control-plane pricing behavior before runtime loads. The Gateway pricing cache reads this metadata without importing provider runtime code.

```json
{
  "providers": ["ollama", "openrouter"],
  "modelPricing": {
    "providers": {
      "ollama": {
        "external": false
      },
      "openrouter": {
        "openRouter": {
          "passthroughProviderModel": true
        },
        "liteLLM": false
      }
    }
  }
}
```

Provider fields:

| Field        | Type              | What it means                                                                                      |
| ------------ | ----------------- | -------------------------------------------------------------------------------------------------- |
| `external`   | `boolean`         | Set `false` for local/self-hosted providers that should never fetch OpenRouter or LiteLLM pricing. |
| `openRouter` | `false \| object` | OpenRouter pricing lookup mapping. `false` disables OpenRouter lookup for this provider.           |
| `liteLLM`    | `false \| object` | LiteLLM pricing lookup mapping. `false` disables LiteLLM lookup for this provider.                 |

Source fields:

| Field                      | Type               | What it means                                                                                                        |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `provider`                 | `string`           | External catalog provider id when it differs from the OpenClaw provider id, for example `z-ai` for a `zai` provider. |
| `passthroughProviderModel` | `boolean`          | Treat slash-containing model ids as nested provider/model refs, useful for proxy providers such as OpenRouter.       |
| `modelIdTransforms`        | `"version-dots"[]` | Extra external catalog model-id variants. `version-dots` tries dotted version ids like `claude-opus-4.6`.            |

### OpenClaw Provider Index

The OpenClaw Provider Index is OpenClaw-owned preview metadata for providers whose plugins may not be installed yet. It is not part of a plugin manifest. Plugin manifests remain the installed-plugin authority. The Provider Index is the internal fallback contract that future installable-provider and pre-install model picker surfaces will consume when a provider plugin is not installed.

Catalog authority order:

1. User config.
2. Installed plugin manifest `modelCatalog`.
3. Model catalog cache from explicit refresh.
4. OpenClaw Provider Index preview rows.

The Provider Index must not contain secrets, enabled state, runtime hooks, or live account-specific model data. Its preview catalogs use the same `modelCatalog` provider row shape as plugin manifests, but should stay limited to stable display metadata unless runtime adapter fields such as `api`, `baseUrl`, pricing, or compatibility flags are intentionally kept aligned with the installed plugin manifest. Providers with live `/models` discovery should write refreshed rows through the explicit model catalog cache path instead of making normal listing or onboarding call provider APIs.

Provider Index entries may also carry installable-plugin metadata for providers whose plugin has moved out of core or is otherwise not installed yet. This metadata mirrors the channel catalog pattern: package name, npm install spec, expected integrity, and cheap auth-choice labels are enough to show an installable setup option. Once the plugin is installed, its manifest wins and the Provider Index entry is ignored for that provider.

`openclaw doctor --fix` migrates a small, closed set of legacy top-level manifest capability keys into `contracts.*`: `speechProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, and `tools`. None of these (or any other capability list) are read as top-level manifest fields anymore; normal manifest loading only recognizes them under `contracts`.

## Manifest versus package.json

The two files serve different jobs:

| File                   | Use it for                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw.plugin.json` | Discovery, config validation, auth-choice metadata, and UI hints that must exist before plugin code runs                         |
| `package.json`         | npm metadata, dependency installation, and the `openclaw` block used for entrypoints, install gating, setup, or catalog metadata |

If you are unsure where a piece of metadata belongs, use this rule:

- if OpenClaw must know it before loading plugin code, put it in `openclaw.plugin.json`
- if it is about packaging, entry files, or npm install behavior, put it in `package.json`

### package.json fields that affect discovery

Some pre-runtime plugin metadata intentionally lives in `package.json` under the `openclaw` block instead of `openclaw.plugin.json`. `openclaw.bundle` and `openclaw.bundle.json` are not OpenClaw plugin contracts; native plugins must use `openclaw.plugin.json` plus the supported `package.json#openclaw` fields below.

Important examples:

| Field                                                                                      | What it means                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw.extensions`                                                                      | Declares native plugin entrypoints. Must stay inside the plugin package directory.                                                                                                        |
| `openclaw.runtimeExtensions`                                                               | Declares built JavaScript runtime entrypoints for installed packages. Must stay inside the plugin package directory.                                                                      |
| `openclaw.setupEntry`                                                                      | Lightweight setup-only entrypoint used during onboarding, deferred channel startup, and read-only channel status/SecretRef discovery. Must stay inside the plugin package directory.      |
| `openclaw.runtimeSetupEntry`                                                               | Declares the built JavaScript setup entrypoint for installed packages. Requires `setupEntry`, must exist, and must stay inside the plugin package directory.                              |
| `openclaw.channel`                                                                         | Cheap channel catalog metadata like labels, docs paths, aliases, and selection copy.                                                                                                      |
| `openclaw.channel.approvalFlags`                                                           | Closed approval behavior flags available before runtime load. `native` means the channel owns native approval UI and same-turn resolution.                                                |
| `openclaw.channel.commands`                                                                | Static native command and native skill auto-default metadata used by config, audit, and command-list surfaces before channel runtime loads.                                               |
| `openclaw.channel.cliAddOptions`                                                           | Plugin-owned `openclaw channels add` options. Each entry declares `flags`, `description`, optional `defaultValue`, and optional `valueType` (`int` or `list`) for generic input coercion. |
| `openclaw.channel.configuredState`                                                         | Lightweight configured-state checker metadata that can answer "does env-only setup already exist?" without loading the full channel runtime.                                              |
| `openclaw.channel.persistedAuthState`                                                      | Lightweight persisted-auth checker metadata that can answer "is anything already signed in?" without loading the full channel runtime.                                                    |
| `openclaw.install.clawhubSpec` / `openclaw.install.npmSpec` / `openclaw.install.localPath` | Install/update hints for bundled and externally published plugins.                                                                                                                        |
| `openclaw.install.defaultChoice`                                                           | Preferred install path when multiple install sources are available.                                                                                                                       |
| `openclaw.install.minHostVersion`                                                          | Minimum supported OpenClaw host version, using a semver floor like `>=2026.3.22` or `>=2026.5.1-beta.1`.                                                                                  |
| `openclaw.compat.pluginApi`                                                                | Minimum OpenClaw plugin API range required by this package, using a semver floor like `>=2026.5.27`.                                                                                      |
| `openclaw.install.expectedIntegrity`                                                       | Expected npm dist integrity string such as `sha512-...`; install and update flows verify the fetched artifact against it.                                                                 |
| `openclaw.install.allowInvalidConfigRecovery`                                              | Allows a narrow bundled-plugin reinstall recovery path when config is invalid.                                                                                                            |
| `openclaw.install.requiredPlatformPackages`                                                | npm package aliases that must materialize when their lockfile platform constraints match the current host.                                                                                |
| `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`                          | Lets setup-runtime channel surfaces load before listen, then defers the full configured channel plugin until post-listen activation.                                                      |

Manifest metadata decides which provider/channel/setup choices appear in onboarding before runtime loads. `package.json#openclaw.install` tells onboarding how to fetch or enable that plugin when the user picks one of those choices. Do not move install hints into `openclaw.plugin.json`.

For `openclaw.channel.cliAddOptions`, use Commander's long-option syntax, such as `--initial-sync-limit <n>`. Set `valueType: "int"` to parse a non-negative integer or `valueType: "list"` to split comma-, semicolon-, or newline-delimited input into strings before the plugin setup adapter receives it. Omit `valueType` to pass the parsed Commander value through unchanged.

`openclaw.install.minHostVersion` is enforced during install and manifest registry loading for non-bundled plugin sources. Invalid values are rejected; newer-but-valid values skip external plugins on older hosts. Bundled source plugins are assumed to be co-versioned with the host checkout.

`openclaw.install.requiredPlatformPackages` is for npm packages that expose required native binaries through optional, platform-specific aliases. List the bare npm package name for every supported platform alias. During npm install, OpenClaw verifies only the declared alias whose lockfile constraints match the current host. If npm reports success but omits that alias, OpenClaw retries once with a fresh cache and rolls back the install if the alias is still missing.

`openclaw.compat.pluginApi` is enforced during package install for non-bundled plugin sources. Use it for the OpenClaw plugin SDK/runtime API floor that the package was built against. It can be stricter than `minHostVersion` when a plugin package needs a newer API but still keeps a lower install hint for other flows. Official OpenClaw release sync bumps existing official plugin API floors to the OpenClaw release version by default, but plugin-only releases can keep a lower floor when the package intentionally supports older hosts. Do not use the package version alone as the compatibility contract. `peerDependencies.openclaw` remains npm package metadata; OpenClaw uses the `openclaw.compat.pluginApi` contract for install compatibility decisions.

Official install-on-demand metadata should use `clawhubSpec` when the plugin is published on ClawHub; onboarding treats that as the preferred remote source and records ClawHub artifact facts after install. `npmSpec` remains the compatibility fallback for packages that have not moved to ClawHub yet.

Exact npm version pinning already lives in `npmSpec`, for example `"npmSpec": "@wecom/wecom-openclaw-plugin@1.2.3"`. Official external catalog entries should pair exact specs with `expectedIntegrity` so update flows fail closed if the fetched npm artifact no longer matches the pinned release. Interactive onboarding still offers trusted registry npm specs, including bare package names and dist-tags, for compatibility. Catalog diagnostics can distinguish exact, floating, integrity-pinned, missing-integrity, package-name mismatch, and invalid default-choice sources. They also warn when `expectedIntegrity` is present but there is no valid npm source it can pin. When `expectedIntegrity` is present, install/update flows enforce it; when it is omitted, the registry resolution is recorded without an integrity pin.

Channel plugins should provide `openclaw.setupEntry` when status, channel list, or SecretRef scans need to identify configured accounts without loading the full runtime. The setup entry should expose channel metadata plus setup-safe config, status, and secrets adapters; keep network clients, gateway listeners, and transport runtimes in the main extension entrypoint.

Runtime entrypoint fields do not override package-boundary checks for source entrypoint fields. For example, `openclaw.runtimeExtensions` cannot make an escaping `openclaw.extensions` path loadable.

`openclaw.install.allowInvalidConfigRecovery` is intentionally narrow. It does not make arbitrary broken configs installable. Today it only allows install flows to recover from specific stale bundled-plugin upgrade failures, such as a missing bundled plugin path or a stale `channels.<id>` entry for that same bundled plugin. Unrelated config errors still block install and send operators to `openclaw doctor --fix`.

`openclaw.channel.persistedAuthState` is package metadata for a tiny checker module:

```json
{
  "openclaw": {
    "channel": {
      "id": "whatsapp",
      "persistedAuthState": {
        "specifier": "./auth-presence",
        "exportName": "hasAnyWhatsAppAuth"
      }
    }
  }
}
```

Use it when setup, doctor, status, or read-only presence flows need a cheap yes/no auth probe before the full channel plugin loads. Persisted auth state is not configured channel state: do not use this metadata to auto-enable plugins, repair runtime dependencies, or decide whether a channel runtime should load. The target export should be a small function that reads persisted state only; do not route it through the full channel runtime barrel.

`openclaw.channel.configuredState` supports cheap configured checks. Prefer declarative env metadata when environment variables are sufficient:

```json
{
  "openclaw": {
    "channel": {
      "id": "telegram",
      "configuredState": {
        "env": {
          "allOf": ["TELEGRAM_BOT_TOKEN"]
        }
      }
    }
  }
}
```

Use `env.allOf` when every listed variable is required and `env.anyOf` when any one non-empty variable is enough. If a tiny non-runtime check needs more than environment metadata, use `specifier` plus `exportName` as shown for `persistedAuthState`; when `env` is present, OpenClaw uses it without loading that module. If the check needs full config resolution or the real channel runtime, keep that logic in the plugin `config.hasConfiguredState` hook instead.

## Discovery precedence (duplicate plugin ids)

OpenClaw discovers plugins from three roots, checked in this order: bundled plugins shipped with OpenClaw, the global install root (`~/.openclaw/extensions`), and the current workspace root (`<workspace>/.openclaw/extensions`), plus any explicit `plugins.load.paths` entries.

If two discoveries share the same `id`, only the **highest-precedence** manifest is kept; lower-precedence duplicates are dropped instead of loading beside it. Precedence, highest to lowest:

1. **Config-selected** — a path explicitly pinned in `plugins.entries.<id>`
2. **Global install matching a tracked install record** — a plugin installed via `openclaw plugin install`/`openclaw plugin update` that OpenClaw's install tracking recognizes for that same id, even when the id also belongs to a bundled plugin
3. **Bundled** — plugins shipped with OpenClaw
4. **Workspace** — plugins discovered relative to the current workspace
5. Any other discovered candidate

Implications:

- A forked or stale copy of a bundled plugin sitting untracked in the workspace or global root will not shadow the bundled build.
- To override a bundled plugin, either run `openclaw plugin install` for that id so the tracked global install outranks the bundled copy, or pin a specific path via `plugins.entries.<id>` so it wins by config-selected precedence.
- Duplicate drops are logged so Doctor and startup diagnostics can point at the discarded copy.
- Config-selected duplicate overrides are worded as explicit overrides in diagnostics, but still warn so stale forks and accidental shadows stay visible.

## JSON Schema requirements

- **Every plugin must ship a JSON Schema**, even if it accepts no config.
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).
- Schemas are validated at config read/write time, not at runtime.
- When extending or forking a bundled plugin with new config keys, update that plugin's `openclaw.plugin.json` `configSchema` at the same time. Bundled plugin schemas are strict, so adding `plugins.entries.<id>.config.myNewKey` in user config without adding `myNewKey` to `configSchema.properties` will be rejected before the plugin runtime loads.

Example schema extension:

```json
{
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "myNewKey": {
        "type": "string"
      }
    }
  }
}
```

## Validation behavior

- Unknown `channels.*` keys are **errors**, unless the channel id is declared by a plugin manifest. If the same id also appears in `plugins.allow`, `plugins.entries`, or `plugins.installs` (a plugin that is referenced but not currently discoverable), OpenClaw downgrades this to a **warning** instead.
- `plugins.entries.<id>`, `plugins.allow`, and `plugins.deny` referencing unknown plugin ids are **warnings** ("stale config entry ignored"), not errors, so upgrades and removed/renamed plugins do not block gateway startup.
- `plugins.slots.memory` referencing an unknown plugin id is an **error**, except for the known `memory-lancedb` official external plugin, which warns instead.
- If a plugin is installed but has a broken or missing manifest or schema, validation fails and Doctor reports the plugin error.
- If plugin config exists but the plugin is **disabled**, the config is kept and a **warning** is surfaced in Doctor + logs.

See [Configuration reference](/gateway/configuration) for the full `plugins.*` schema.

## Notes

- The manifest is **required for native OpenClaw plugins**, including local filesystem loads. Runtime still loads the plugin module separately; the manifest is only for discovery + validation.
- Native manifests are parsed with JSON5, so comments, trailing commas, and unquoted keys are accepted as long as the final value is still an object.
- Only documented manifest fields are read by the manifest loader. Avoid custom top-level keys.
- `channels`, `providers`, `cliBackends`, and `skills` can all be omitted when a plugin does not need them.
- `providerCatalogEntry` must stay lightweight and should not import broad runtime code; use it for static provider catalog metadata or narrow discovery descriptors, not request-time execution.
- Exclusive plugin kinds are selected through `plugins.slots.*`: `kind: "memory"` via `plugins.slots.memory` (default `memory-core`), `kind: "context-engine"` via `plugins.slots.contextEngine` (default `legacy`).
- Declare exclusive plugin kind in this manifest. Runtime-entry `OpenClawPluginDefinition.kind` is deprecated and remains only as a compatibility fallback for older plugins.
- Env-var metadata in `setup.providers[].envVars` is declarative only. Status, audit, cron delivery validation, and other read-only surfaces still apply plugin trust and effective activation policy before treating an env var as configured.
- For runtime wizard metadata that requires provider code, see [Provider runtime hooks](/plugins/architecture-internals#provider-runtime-hooks).
- If your plugin depends on native modules, document the build steps and any package-manager allowlist requirements (for example, pnpm `allow-build-scripts` + `pnpm rebuild <package>`).

## Related

<CardGroup cols={3}>
  <Card title="Building plugins" href="/plugins/building-plugins" icon="rocket">
    Getting started with plugins.
  </Card>
  <Card title="Plugin architecture" href="/plugins/architecture" icon="diagram-project">
    Internal architecture and capability model.
  </Card>
  <Card title="SDK overview" href="/plugins/sdk-overview" icon="book">
    Plugin SDK reference and subpath imports.
  </Card>
</CardGroup>
