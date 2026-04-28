---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building an OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin manifest"
---

This page is for the **native OpenClaw plugin manifest** only.

For compatible bundle layouts, see [Plugin bundles](/plugins/bundles).

Compatible bundle formats use different manifest files:

- Codex bundle: `.codex-plugin/plugin.json`
- Claude bundle: `.claude-plugin/plugin.json` or the default Claude component
  layout without a manifest
- Cursor bundle: `.cursor-plugin/plugin.json`

OpenClaw auto-detects those bundle layouts too, but they are not validated
against the `openclaw.plugin.json` schema described here.

For compatible bundles, OpenClaw currently reads bundle metadata plus declared
skill roots, Claude command roots, Claude bundle `settings.json` defaults,
Claude bundle LSP defaults, and supported hook packs when the layout matches
OpenClaw runtime expectations.

Every native OpenClaw plugin **must** ship a `openclaw.plugin.json` file in the
**plugin root**. OpenClaw uses this manifest to validate configuration
**without executing plugin code**. Missing or invalid manifests are treated as
plugin errors and block config validation.

See the full plugin system guide: [Plugins](/tools/plugin).
For the native capability model and current external-compatibility guidance:
[Capability model](/plugins/architecture#public-capability-model).

## What this file does

`openclaw.plugin.json` is the metadata OpenClaw reads **before it loads your
plugin code**. Everything below must be cheap enough to inspect without booting
plugin runtime.

**Use it for:**

- plugin identity, config validation, and config UI hints
- auth, onboarding, and setup metadata (alias, auto-enable, provider env vars, auth choices)
- activation hints for control-plane surfaces
- shorthand model-family ownership
- static capability-ownership snapshots (`contracts`)
- QA runner metadata the shared `openclaw qa` host can inspect
- channel-specific config metadata merged into catalog and validation surfaces

**Do not use it for:** registering runtime behavior, declaring code entrypoints,
or npm install metadata. Those belong in your plugin code and `package.json`.

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
  "providerAuthEnvVars": {
    "openrouter": ["OPENROUTER_API_KEY"]
  },
  "providerAuthAliases": {
    "openrouter-coding": "openrouter"
  },
  "channelEnvVars": {
    "openrouter-chatops": ["OPENROUTER_CHATOPS_TOKEN"]
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

| Field                                | Required | Type                             | What it means                                                                                                                                                                                                                     |
| ------------------------------------ | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | Yes      | `string`                         | Canonical plugin id. This is the id used in `plugins.entries.<id>`.                                                                                                                                                               |
| `configSchema`                       | Yes      | `object`                         | Inline JSON Schema for this plugin's config.                                                                                                                                                                                      |
| `enabledByDefault`                   | No       | `true`                           | Marks a bundled plugin as enabled by default. Omit it, or set any non-`true` value, to leave the plugin disabled by default.                                                                                                      |
| `legacyPluginIds`                    | No       | `string[]`                       | Legacy ids that normalize to this canonical plugin id.                                                                                                                                                                            |
| `autoEnableWhenConfiguredProviders`  | No       | `string[]`                       | Provider ids that should auto-enable this plugin when auth, config, or model refs mention them.                                                                                                                                   |
| `kind`                               | No       | `"memory"` \| `"context-engine"` | Declares an exclusive plugin kind used by `plugins.slots.*`.                                                                                                                                                                      |
| `channels`                           | No       | `string[]`                       | Channel ids owned by this plugin. Used for discovery and config validation.                                                                                                                                                       |
| `providers`                          | No       | `string[]`                       | Provider ids owned by this plugin.                                                                                                                                                                                                |
| `providerDiscoveryEntry`             | No       | `string`                         | Lightweight provider-discovery module path, relative to the plugin root, for manifest-scoped provider catalog metadata that can be loaded without activating the full plugin runtime.                                             |
| `modelSupport`                       | No       | `object`                         | Manifest-owned shorthand model-family metadata used to auto-load the plugin before runtime.                                                                                                                                       |
| `modelCatalog`                       | No       | `object`                         | Declarative model catalog metadata for providers owned by this plugin. This is the control-plane contract for future read-only listing, onboarding, model pickers, aliases, and suppression without loading plugin runtime.       |
| `modelPricing`                       | No       | `object`                         | Provider-owned external pricing lookup policy. Use it to opt local/self-hosted providers out of remote pricing catalogs or map provider refs to OpenRouter/LiteLLM catalog ids without hardcoding provider ids in core.           |
| `modelIdNormalization`               | No       | `object`                         | Provider-owned model-id alias/prefix cleanup that must run before provider runtime loads.                                                                                                                                         |
| `providerEndpoints`                  | No       | `object[]`                       | Manifest-owned endpoint host/baseUrl metadata for provider routes that core must classify before provider runtime loads.                                                                                                          |
| `providerRequest`                    | No       | `object`                         | Cheap provider-family and request-compatibility metadata used by generic request policy before provider runtime loads.                                                                                                            |
| `cliBackends`                        | No       | `string[]`                       | CLI inference backend ids owned by this plugin. Used for startup auto-activation from explicit config refs.                                                                                                                       |
| `syntheticAuthRefs`                  | No       | `string[]`                       | Provider or CLI backend refs whose plugin-owned synthetic auth hook should be probed during cold model discovery before runtime loads.                                                                                            |
| `nonSecretAuthMarkers`               | No       | `string[]`                       | Bundled-plugin-owned placeholder API key values that represent non-secret local, OAuth, or ambient credential state.                                                                                                              |
| `commandAliases`                     | No       | `object[]`                       | Command names owned by this plugin that should produce plugin-aware config and CLI diagnostics before runtime loads.                                                                                                              |
| `providerAuthEnvVars`                | No       | `Record<string, string[]>`       | Deprecated compatibility env metadata for provider auth/status lookup. Prefer `setup.providers[].envVars` for new plugins; OpenClaw still reads this during the deprecation window.                                               |
| `providerAuthAliases`                | No       | `Record<string, string>`         | Provider ids that should reuse another provider id for auth lookup, for example a coding provider that shares the base provider API key and auth profiles.                                                                        |
| `channelEnvVars`                     | No       | `Record<string, string[]>`       | Cheap channel env metadata that OpenClaw can inspect without loading plugin code. Use this for env-driven channel setup or auth surfaces that generic startup/config helpers should see.                                          |
| `providerAuthChoices`                | No       | `object[]`                       | Cheap auth-choice metadata for onboarding pickers, preferred-provider resolution, and simple CLI flag wiring.                                                                                                                     |
| `activation`                         | No       | `object`                         | Cheap activation planner metadata for startup, provider, command, channel, route, and capability-triggered loading. Metadata only; plugin runtime still owns actual behavior.                                                     |
| `setup`                              | No       | `object`                         | Cheap setup/onboarding descriptors that discovery and setup surfaces can inspect without loading plugin runtime.                                                                                                                  |
| `qaRunners`                          | No       | `object[]`                       | Cheap QA runner descriptors used by the shared `openclaw qa` host before plugin runtime loads.                                                                                                                                    |
| `contracts`                          | No       | `object`                         | Static bundled capability snapshot for external auth hooks, speech, realtime transcription, realtime voice, media-understanding, image-generation, music-generation, video-generation, web-fetch, web search, and tool ownership. |
| `mediaUnderstandingProviderMetadata` | No       | `Record<string, object>`         | Cheap media-understanding defaults for provider ids declared in `contracts.mediaUnderstandingProviders`.                                                                                                                          |
| `channelConfigs`                     | No       | `Record<string, object>`         | Manifest-owned channel config metadata merged into discovery and validation surfaces before runtime loads.                                                                                                                        |
| `skills`                             | No       | `string[]`                       | Skill directories to load, relative to the plugin root.                                                                                                                                                                           |
| `name`                               | No       | `string`                         | Human-readable plugin name.                                                                                                                                                                                                       |
| `description`                        | No       | `string`                         | Short summary shown in plugin surfaces.                                                                                                                                                                                           |
| `version`                            | No       | `string`                         | Informational plugin version.                                                                                                                                                                                                     |
| `uiHints`                            | No       | `Record<string, object>`         | UI labels, placeholders, and sensitivity hints for config fields.                                                                                                                                                                 |

## providerAuthChoices reference

Each `providerAuthChoices` entry describes one onboarding or auth choice.
OpenClaw reads this before provider runtime loads.
Provider setup lists use these manifest choices, descriptor-derived setup
choices, and install-catalog metadata without loading provider runtime.

| Field                 | Required | Type                                            | What it means                                                                                            |
| --------------------- | -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `provider`            | Yes      | `string`                                        | Provider id this choice belongs to.                                                                      |
| `method`              | Yes      | `string`                                        | Auth method id to dispatch to.                                                                           |
| `choiceId`            | Yes      | `string`                                        | Stable auth-choice id used by onboarding and CLI flows.                                                  |
| `choiceLabel`         | No       | `string`                                        | User-facing label. If omitted, OpenClaw falls back to `choiceId`.                                        |
| `choiceHint`          | No       | `string`                                        | Short helper text for the picker.                                                                        |
| `assistantPriority`   | No       | `number`                                        | Lower values sort earlier in assistant-driven interactive pickers.                                       |
| `assistantVisibility` | No       | `"visible"` \| `"manual-only"`                  | Hide the choice from assistant pickers while still allowing manual CLI selection.                        |
| `deprecatedChoiceIds` | No       | `string[]`                                      | Legacy choice ids that should redirect users to this replacement choice.                                 |
| `groupId`             | No       | `string`                                        | Optional group id for grouping related choices.                                                          |
| `groupLabel`          | No       | `string`                                        | User-facing label for that group.                                                                        |
| `groupHint`           | No       | `string`                                        | Short helper text for the group.                                                                         |
| `optionKey`           | No       | `string`                                        | Internal option key for simple one-flag auth flows.                                                      |
| `cliFlag`             | No       | `string`                                        | CLI flag name, such as `--openrouter-api-key`.                                                           |
| `cliOption`           | No       | `string`                                        | Full CLI option shape, such as `--openrouter-api-key <key>`.                                             |
| `cliDescription`      | No       | `string`                                        | Description used in CLI help.                                                                            |
| `onboardingScopes`    | No       | `Array<"text-inference" \| "image-generation">` | Which onboarding surfaces this choice should appear in. If omitted, it defaults to `["text-inference"]`. |

## commandAliases reference

Use `commandAliases` when a plugin owns a runtime command name that users may
mistakenly put in `plugins.allow` or try to run as a root CLI command. OpenClaw
uses this metadata for diagnostics without importing plugin runtime code.

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

Use `activation` when the plugin can cheaply declare which control-plane events
should include it in an activation/load plan.

This block is planner metadata, not a lifecycle API. It does not register
runtime behavior, does not replace `register(...)`, and does not promise that
plugin code has already executed. The activation planner uses these fields to
narrow candidate plugins before falling back to existing manifest ownership
metadata such as `providers`, `channels`, `commandAliases`, `setup.providers`,
`contracts.tools`, and hooks.

Prefer the narrowest metadata that already describes ownership. Use
`providers`, `channels`, `commandAliases`, setup descriptors, or `contracts`
when those fields express the relationship. Use `activation` for extra planner
hints that cannot be represented by those ownership fields.
Use top-level `cliBackends` for CLI runtime aliases such as `claude-cli`,
`codex-cli`, or `google-gemini-cli`; `activation.onAgentHarnesses` is only for
embedded agent harness ids that do not already have an ownership field.

This block is metadata only. It does not register runtime behavior, and it does
not replace `register(...)`, `setupEntry`, or other runtime/plugin entrypoints.
Current consumers use it as a narrowing hint before broader plugin loading, so
missing activation metadata usually only costs performance; it should not
change correctness while legacy manifest ownership fallbacks still exist.

Every plugin should set `activation.onStartup` intentionally as OpenClaw moves
away from implicit startup imports. Set it to `true` only when the plugin must
run during Gateway startup. Set it to `false` when the plugin is inert at
startup and should load only from narrower triggers. Omitting `onStartup` keeps
the deprecated legacy implicit startup sidecar fallback for plugins with no
static capability metadata; future versions may stop startup-loading those
plugins unless they declare `activation.onStartup: true`. Plugin status and
compatibility reports warn with `legacy-implicit-startup-sidecar` when a plugin
still relies on that fallback.

For migration testing, set
`OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS=1` to disable only that
deprecated fallback. This opt-in mode does not block explicit
`activation.onStartup: true` plugins or plugins loaded by channel, config,
agent-harness, memory, or other narrower activation triggers.

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

| Field              | Required | Type                                                 | What it means                                                                                                                                                                                                                      |
| ------------------ | -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onStartup`        | No       | `boolean`                                            | Explicit Gateway startup activation. Every plugin should set this. `true` imports the plugin during startup; `false` opts out of the deprecated implicit sidecar startup fallback unless another matched trigger requires loading. |
| `onProviders`      | No       | `string[]`                                           | Provider ids that should include this plugin in activation/load plans.                                                                                                                                                             |
| `onAgentHarnesses` | No       | `string[]`                                           | Embedded agent harness runtime ids that should include this plugin in activation/load plans. Use top-level `cliBackends` for CLI backend aliases.                                                                                  |
| `onCommands`       | No       | `string[]`                                           | Command ids that should include this plugin in activation/load plans.                                                                                                                                                              |
| `onChannels`       | No       | `string[]`                                           | Channel ids that should include this plugin in activation/load plans.                                                                                                                                                              |
| `onRoutes`         | No       | `string[]`                                           | Route kinds that should include this plugin in activation/load plans.                                                                                                                                                              |
| `onConfigPaths`    | No       | `string[]`                                           | Root-relative config paths that should include this plugin in startup/load plans when the path is present and not explicitly disabled.                                                                                             |
| `onCapabilities`   | No       | `Array<"provider" \| "channel" \| "tool" \| "hook">` | Broad capability hints used by control-plane activation planning. Prefer narrower fields when possible.                                                                                                                            |

Current live consumers:

- Gateway startup planning uses `activation.onStartup` for explicit startup
  import and opt-out of deprecated implicit sidecar startup fallback
- command-triggered CLI planning falls back to legacy
  `commandAliases[].cliCommand` or `commandAliases[].name`
- agent-runtime startup planning uses `activation.onAgentHarnesses` for
  embedded harnesses and top-level `cliBackends[]` for CLI runtime aliases
- channel-triggered setup/channel planning falls back to legacy `channels[]`
  ownership when explicit channel activation metadata is missing
- startup plugin planning uses `activation.onConfigPaths` for non-channel root
  config surfaces such as the bundled browser plugin's `browser` block
- provider-triggered setup/runtime planning falls back to legacy
  `providers[]` and top-level `cliBackends[]` ownership when explicit provider
  activation metadata is missing

Planner diagnostics can distinguish explicit activation hints from manifest
ownership fallback. For example, `activation-command-hint` means
`activation.onCommands` matched, while `manifest-command-alias` means the
planner used `commandAliases` ownership instead. These reason labels are for
host diagnostics and tests; plugin authors should keep declaring the metadata
that best describes ownership.

## qaRunners reference

Use `qaRunners` when a plugin contributes one or more transport runners beneath
the shared `openclaw qa` root. Keep this metadata cheap and static; the plugin
runtime still owns actual CLI registration through a lightweight
`runtime-api.ts` surface that exports `qaRunnerCliRegistrations`.

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

## setup reference

Use `setup` when setup and onboarding surfaces need cheap plugin-owned metadata
before runtime loads.

```json
{
  "setup": {
    "providers": [
      {
        "id": "openai",
        "authMethods": ["api-key"],
        "envVars": ["OPENAI_API_KEY"]
      }
    ],
    "cliBackends": ["openai-cli"],
    "configMigrations": ["legacy-openai-auth"],
    "requiresRuntime": false
  }
}
```

Top-level `cliBackends` stays valid and continues to describe CLI inference
backends. `setup.cliBackends` is the setup-specific descriptor surface for
control-plane/setup flows that should stay metadata-only.

When present, `setup.providers` and `setup.cliBackends` are the preferred
descriptor-first lookup surface for setup discovery. If the descriptor only
narrows the candidate plugin and setup still needs richer setup-time runtime
hooks, set `requiresRuntime: true` and keep `setup-api` in place as the
fallback execution path.

OpenClaw also includes `setup.providers[].envVars` in generic provider auth and
env-var lookups. `providerAuthEnvVars` remains supported through a compatibility
adapter during the deprecation window, but non-bundled plugins that still use it
receive a manifest diagnostic. New plugins should put setup/status env metadata
on `setup.providers[].envVars`.

OpenClaw can also derive simple setup choices from `setup.providers[].authMethods`
when no setup entry is available, or when `setup.requiresRuntime: false`
declares setup runtime unnecessary. Explicit `providerAuthChoices` entries stay
preferred for custom labels, CLI flags, onboarding scope, and assistant metadata.

Set `requiresRuntime: false` only when those descriptors are sufficient for the
setup surface. OpenClaw treats explicit `false` as a descriptor-only contract
and will not execute `setup-api` or `openclaw.setupEntry` for setup lookup. If
a descriptor-only plugin still ships one of those setup runtime entries,
OpenClaw reports an additive diagnostic and continues ignoring it. Omitted
`requiresRuntime` keeps legacy fallback behavior so existing plugins that added
descriptors without the flag do not break.

Because setup lookup can execute plugin-owned `setup-api` code, normalized
`setup.providers[].id` and `setup.cliBackends[]` values must stay unique across
discovered plugins. Ambiguous ownership fails closed instead of picking a
winner from discovery order.

When setup runtime does execute, setup registry diagnostics report descriptor
drift if `setup-api` registers a provider or CLI backend that the manifest
descriptors do not declare, or if a descriptor has no matching runtime
registration. These diagnostics are additive and do not reject legacy plugins.

### setup.providers reference

| Field         | Required | Type       | What it means                                                                        |
| ------------- | -------- | ---------- | ------------------------------------------------------------------------------------ |
| `id`          | Yes      | `string`   | Provider id exposed during setup or onboarding. Keep normalized ids globally unique. |
| `authMethods` | No       | `string[]` | Setup/auth method ids this provider supports without loading full runtime.           |
| `envVars`     | No       | `string[]` | Env vars that generic setup/status surfaces can check before plugin runtime loads.   |

### setup fields

| Field              | Required | Type       | What it means                                                                                       |
| ------------------ | -------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `providers`        | No       | `object[]` | Provider setup descriptors exposed during setup and onboarding.                                     |
| `cliBackends`      | No       | `string[]` | Setup-time backend ids used for descriptor-first setup lookup. Keep normalized ids globally unique. |
| `configMigrations` | No       | `string[]` | Config migration ids owned by this plugin's setup surface.                                          |
| `requiresRuntime`  | No       | `boolean`  | Whether setup still needs `setup-api` execution after descriptor lookup.                            |

## uiHints reference

`uiHints` is a map from config field names to small rendering hints.

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

Use `contracts` only for static capability ownership metadata that OpenClaw can
read without importing the plugin runtime.

```json
{
  "contracts": {
    "agentToolResultMiddleware": ["pi", "codex"],
    "externalAuthProviders": ["acme-ai"],
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "memoryEmbeddingProviders": ["local"],
    "mediaUnderstandingProviders": ["openai", "openai-codex"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "migrationProviders": ["hermes"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

Each list is optional:

| Field                            | Type       | What it means                                                         |
| -------------------------------- | ---------- | --------------------------------------------------------------------- |
| `embeddedExtensionFactories`     | `string[]` | Codex app-server extension factory ids, currently `codex-app-server`. |
| `agentToolResultMiddleware`      | `string[]` | Runtime ids a bundled plugin may register tool-result middleware for. |
| `externalAuthProviders`          | `string[]` | Provider ids whose external auth profile hook this plugin owns.       |
| `speechProviders`                | `string[]` | Speech provider ids this plugin owns.                                 |
| `realtimeTranscriptionProviders` | `string[]` | Realtime-transcription provider ids this plugin owns.                 |
| `realtimeVoiceProviders`         | `string[]` | Realtime-voice provider ids this plugin owns.                         |
| `memoryEmbeddingProviders`       | `string[]` | Memory embedding provider ids this plugin owns.                       |
| `mediaUnderstandingProviders`    | `string[]` | Media-understanding provider ids this plugin owns.                    |
| `imageGenerationProviders`       | `string[]` | Image-generation provider ids this plugin owns.                       |
| `videoGenerationProviders`       | `string[]` | Video-generation provider ids this plugin owns.                       |
| `webFetchProviders`              | `string[]` | Web-fetch provider ids this plugin owns.                              |
| `webSearchProviders`             | `string[]` | Web-search provider ids this plugin owns.                             |
| `migrationProviders`             | `string[]` | Import provider ids this plugin owns for `openclaw migrate`.          |
| `tools`                          | `string[]` | Agent tool names this plugin owns for bundled contract checks.        |

`contracts.embeddedExtensionFactories` is retained for bundled Codex
app-server-only extension factories. Bundled tool-result transforms should
declare `contracts.agentToolResultMiddleware` and register with
`api.registerAgentToolResultMiddleware(...)` instead. External plugins cannot
register tool-result middleware because the seam can rewrite high-trust tool
output before the model sees it.

Provider plugins that implement `resolveExternalAuthProfiles` should declare
`contracts.externalAuthProviders`. Plugins without the declaration still run
through a deprecated compatibility fallback, but that fallback is slower and
will be removed after the migration window.

Bundled memory embedding providers should declare
`contracts.memoryEmbeddingProviders` for every adapter id they expose, including
built-in adapters such as `local`. Standalone CLI paths use this manifest
contract to load only the owning plugin before the full Gateway runtime has
registered providers.

## mediaUnderstandingProviderMetadata reference

Use `mediaUnderstandingProviderMetadata` when a media-understanding provider has
default models, auto-auth fallback priority, or native document support that
generic core helpers need before runtime loads. Keys must also be declared in
`contracts.mediaUnderstandingProviders`.

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
      "nativeDocumentInputs": ["pdf"]
    }
  }
}
```

Each provider entry can include:

| Field                  | Type                                | What it means                                                                |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `capabilities`         | `("image" \| "audio" \| "video")[]` | Media capabilities exposed by this provider.                                 |
| `defaultModels`        | `Record<string, string>`            | Capability-to-model defaults used when config does not specify a model.      |
| `autoPriority`         | `Record<string, number>`            | Lower numbers sort earlier for automatic credential-based provider fallback. |
| `nativeDocumentInputs` | `"pdf"[]`                           | Native document inputs supported by the provider.                            |

## channelConfigs reference

Use `channelConfigs` when a channel plugin needs cheap config metadata before
runtime loads. Read-only channel setup/status discovery can use this metadata
directly for configured external channels when no setup entry is available, or
when `setup.requiresRuntime: false` declares setup runtime unnecessary.

`channelConfigs` is plugin manifest metadata, not a new top-level user config
section. Users still configure channel instances under `channels.<channel-id>`.
OpenClaw reads manifest metadata to decide which plugin owns that configured
channel before plugin runtime code executes.

For a channel plugin, `configSchema` and `channelConfigs` describe different
paths:

- `configSchema` validates `plugins.entries.<plugin-id>.config`
- `channelConfigs.<channel-id>.schema` validates `channels.<channel-id>`

Non-bundled plugins that declare `channels[]` should also declare matching
`channelConfigs` entries. Without them, OpenClaw can still load the plugin, but
cold-path config schema, setup, and Control UI surfaces cannot know the
channel-owned option shape until plugin runtime executes.

`channelConfigs.<channel-id>.commands.nativeCommandsAutoEnabled` and
`nativeSkillsAutoEnabled` can declare static `auto` defaults for command config
checks that run before channel runtime loads. Bundled channels can also publish
the same defaults through `package.json#openclaw.channel.commands` alongside
their other package-owned channel catalog metadata.

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

Use `preferOver` when your plugin is the preferred owner for a channel id that
another plugin can also provide. Common cases are a renamed plugin id, a
standalone plugin that supersedes a bundled plugin, or a maintained fork that
keeps the same channel id for config compatibility.

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

When `channels.chat` is configured, OpenClaw considers both the channel id and
the preferred plugin id. If the lower-priority plugin was only selected because
it is bundled or enabled by default, OpenClaw disables it in the effective
runtime config so one plugin owns the channel and its tools. Explicit user
selection still wins: if the user explicitly enables both plugins, OpenClaw
preserves that choice and reports duplicate channel/tool diagnostics instead of
silently changing the requested plugin set.

Keep `preferOver` scoped to plugin ids that can really provide the same channel.
It is not a general priority field and it does not rename user config keys.

## modelSupport reference

Use `modelSupport` when OpenClaw should infer your provider plugin from
shorthand model ids like `gpt-5.5` or `claude-sonnet-4.6` before plugin runtime
loads.

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
- if one non-bundled plugin and one bundled plugin both match, the non-bundled
  plugin wins
- remaining ambiguity is ignored until the user or config specifies a provider

Fields:

| Field           | Type       | What it means                                                                   |
| --------------- | ---------- | ------------------------------------------------------------------------------- |
| `modelPrefixes` | `string[]` | Prefixes matched with `startsWith` against shorthand model ids.                 |
| `modelPatterns` | `string[]` | Regex sources matched against shorthand model ids after profile suffix removal. |

## modelCatalog reference

Use `modelCatalog` when OpenClaw should know provider model metadata before
loading plugin runtime. This is the manifest-owned source for fixed catalog
rows, provider aliases, suppression rules, and discovery mode. Runtime refresh
still belongs in provider runtime code, but the manifest tells core when runtime
is required.

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

| Field          | Type                                                     | What it means                                                                                               |
| -------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `providers`    | `Record<string, object>`                                 | Catalog rows for provider ids owned by this plugin. Keys should also appear in top-level `providers`.       |
| `aliases`      | `Record<string, object>`                                 | Provider aliases that should resolve to an owned provider for catalog or suppression planning.              |
| `suppressions` | `object[]`                                               | Model rows from another source that this plugin suppresses for a provider-specific reason.                  |
| `discovery`    | `Record<string, "static" \| "refreshable" \| "runtime">` | Whether the provider catalog can be read from manifest metadata, refreshed into cache, or requires runtime. |

`aliases` participates in provider ownership lookup for model-catalog planning.
Alias targets must be top-level providers owned by the same plugin. When a
provider-filtered list uses an alias, OpenClaw can read the owning manifest and
apply alias API/base URL overrides without loading provider runtime.

`suppressions` replaces the old provider runtime `suppressBuiltInModel` hook.
Suppression entries are honored only when the provider is owned by the plugin or
declared as a `modelCatalog.aliases` key that targets an owned provider. Runtime
suppression hooks are no longer called during model resolution.

Provider fields:

| Field     | Type                     | What it means                                                     |
| --------- | ------------------------ | ----------------------------------------------------------------- |
| `baseUrl` | `string`                 | Optional default base URL for models in this provider catalog.    |
| `api`     | `ModelApi`               | Optional default API adapter for models in this provider catalog. |
| `headers` | `Record<string, string>` | Optional static headers that apply to this provider catalog.      |
| `models`  | `object[]`               | Required model rows. Rows without an `id` are ignored.            |

Model fields:

| Field           | Type                                                           | What it means                                                               |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`            | `string`                                                       | Provider-local model id, without the `provider/` prefix.                    |
| `name`          | `string`                                                       | Optional display name.                                                      |
| `api`           | `ModelApi`                                                     | Optional per-model API override.                                            |
| `baseUrl`       | `string`                                                       | Optional per-model base URL override.                                       |
| `headers`       | `Record<string, string>`                                       | Optional per-model static headers.                                          |
| `input`         | `Array<"text" \| "image" \| "document" \| "audio" \| "video">` | Modalities the model accepts.                                               |
| `reasoning`     | `boolean`                                                      | Whether the model exposes reasoning behavior.                               |
| `contextWindow` | `number`                                                       | Native provider context window.                                             |
| `contextTokens` | `number`                                                       | Optional effective runtime context cap when different from `contextWindow`. |
| `maxTokens`     | `number`                                                       | Maximum output tokens when known.                                           |
| `cost`          | `object`                                                       | Optional USD per million token pricing, including optional `tieredPricing`. |
| `compat`        | `object`                                                       | Optional compatibility flags matching OpenClaw model config compatibility.  |
| `status`        | `"available"` \| `"preview"` \| `"deprecated"` \| `"disabled"` | Listing status. Suppress only when the row must not appear at all.          |
| `statusReason`  | `string`                                                       | Optional reason shown with non-available status.                            |
| `replaces`      | `string[]`                                                     | Older provider-local model ids this model supersedes.                       |
| `replacedBy`    | `string`                                                       | Replacement provider-local model id for deprecated rows.                    |
| `tags`          | `string[]`                                                     | Stable tags used by pickers and filters.                                    |

Suppression fields:

| Field                      | Type       | What it means                                                                                             |
| -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `provider`                 | `string`   | Provider id for the upstream row to suppress. Must be owned by this plugin or declared as an owned alias. |
| `model`                    | `string`   | Provider-local model id to suppress.                                                                      |
| `reason`                   | `string`   | Optional message shown when the suppressed row is requested directly.                                     |
| `when.baseUrlHosts`        | `string[]` | Optional list of effective provider base URL hosts required before the suppression applies.               |
| `when.providerConfigApiIn` | `string[]` | Optional list of exact provider-config `api` values required before the suppression applies.              |

Do not put runtime-only data in `modelCatalog`. Use `static` only when manifest
rows are complete enough for provider-filtered list and picker surfaces to skip
registry/runtime discovery. Use `refreshable` when manifest rows are useful
listable seeds or supplements but a refresh/cache can add more rows later;
refreshable rows are not authoritative by themselves. Use `runtime` when OpenClaw
must load provider runtime to know the list.

## modelIdNormalization reference

Use `modelIdNormalization` for cheap provider-owned model-id cleanup that must
happen before provider runtime loads. This keeps aliases such as short model
names, provider-local legacy ids, and proxy prefix rules in the owning plugin
manifest instead of in core model-selection tables.

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

Use `providerEndpoints` for endpoint classification that generic request policy
must know before provider runtime loads. Core still owns the meaning of each
`endpointClass`; plugin manifests own the host and base URL metadata.

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

Use `providerRequest` for cheap request-compatibility metadata that generic
request policy needs without loading provider runtime. Keep behavior-specific
payload rewriting in provider runtime hooks or shared provider-family helpers.

```json
{
  "providers": ["vllm"],
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

## modelPricing reference

Use `modelPricing` when a provider needs control-plane pricing behavior before
runtime loads. The Gateway pricing cache reads this metadata without importing
provider runtime code.

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

The OpenClaw Provider Index is OpenClaw-owned preview metadata for providers
whose plugins may not be installed yet. It is not part of a plugin manifest.
Plugin manifests remain the installed-plugin authority. The Provider Index is
the internal fallback contract that future installable-provider and pre-install
model picker surfaces will consume when a provider plugin is not installed.

Catalog authority order:

1. User config.
2. Installed plugin manifest `modelCatalog`.
3. Model catalog cache from explicit refresh.
4. OpenClaw Provider Index preview rows.

The Provider Index must not contain secrets, enabled state, runtime hooks, or
live account-specific model data. Its preview catalogs use the same
`modelCatalog` provider row shape as plugin manifests, but should stay limited
to stable display metadata unless runtime adapter fields such as `api`,
`baseUrl`, pricing, or compatibility flags are intentionally kept aligned with
the installed plugin manifest. Providers with live `/models` discovery should
write refreshed rows through the explicit model catalog cache path instead of
making normal listing or onboarding call provider APIs.

Provider Index entries may also carry installable-plugin metadata for providers
whose plugin has moved out of core or is otherwise not installed yet. This
metadata mirrors the channel catalog pattern: package name, npm install spec,
expected integrity, and cheap auth-choice labels are enough to show an
installable setup option. Once the plugin is installed, its manifest wins and
the Provider Index entry is ignored for that provider.

Legacy top-level capability keys are deprecated. Use `openclaw doctor --fix` to
move `speechProviders`, `realtimeTranscriptionProviders`,
`realtimeVoiceProviders`, `mediaUnderstandingProviders`,
`imageGenerationProviders`, `videoGenerationProviders`,
`webFetchProviders`, and `webSearchProviders` under `contracts`; normal
manifest loading no longer treats those top-level fields as capability
ownership.

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

Some pre-runtime plugin metadata intentionally lives in `package.json` under the
`openclaw` block instead of `openclaw.plugin.json`.

Important examples:

| Field                                                             | What it means                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openclaw.extensions`                                             | Declares native plugin entrypoints. Must stay inside the plugin package directory.                                                                                                   |
| `openclaw.runtimeExtensions`                                      | Declares built JavaScript runtime entrypoints for installed packages. Must stay inside the plugin package directory.                                                                 |
| `openclaw.setupEntry`                                             | Lightweight setup-only entrypoint used during onboarding, deferred channel startup, and read-only channel status/SecretRef discovery. Must stay inside the plugin package directory. |
| `openclaw.runtimeSetupEntry`                                      | Declares the built JavaScript setup entrypoint for installed packages. Must stay inside the plugin package directory.                                                                |
| `openclaw.channel`                                                | Cheap channel catalog metadata like labels, docs paths, aliases, and selection copy.                                                                                                 |
| `openclaw.channel.commands`                                       | Static native command and native skill auto-default metadata used by config, audit, and command-list surfaces before channel runtime loads.                                          |
| `openclaw.channel.configuredState`                                | Lightweight configured-state checker metadata that can answer "does env-only setup already exist?" without loading the full channel runtime.                                         |
| `openclaw.channel.persistedAuthState`                             | Lightweight persisted-auth checker metadata that can answer "is anything already signed in?" without loading the full channel runtime.                                               |
| `openclaw.install.npmSpec` / `openclaw.install.localPath`         | Install/update hints for bundled and externally published plugins.                                                                                                                   |
| `openclaw.install.defaultChoice`                                  | Preferred install path when multiple install sources are available.                                                                                                                  |
| `openclaw.install.minHostVersion`                                 | Minimum supported OpenClaw host version, using a semver floor like `>=2026.3.22`.                                                                                                    |
| `openclaw.install.expectedIntegrity`                              | Expected npm dist integrity string such as `sha512-...`; install and update flows verify the fetched artifact against it.                                                            |
| `openclaw.install.allowInvalidConfigRecovery`                     | Allows a narrow bundled-plugin reinstall recovery path when config is invalid.                                                                                                       |
| `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen` | Lets setup-only channel surfaces load before the full channel plugin during startup.                                                                                                 |

Manifest metadata decides which provider/channel/setup choices appear in
onboarding before runtime loads. `package.json#openclaw.install` tells
onboarding how to fetch or enable that plugin when the user picks one of those
choices. Do not move install hints into `openclaw.plugin.json`.

`openclaw.install.minHostVersion` is enforced during install and manifest
registry loading. Invalid values are rejected; newer-but-valid values skip the
plugin on older hosts.

Exact npm version pinning already lives in `npmSpec`, for example
`"npmSpec": "@wecom/wecom-openclaw-plugin@1.2.3"`. Official external catalog
entries should pair exact specs with `expectedIntegrity` so update flows fail
closed if the fetched npm artifact no longer matches the pinned release.
Interactive onboarding still offers trusted registry npm specs, including bare
package names and dist-tags, for compatibility. Catalog diagnostics can
distinguish exact, floating, integrity-pinned, missing-integrity, package-name
mismatch, and invalid default-choice sources. They also warn when
`expectedIntegrity` is present but there is no valid npm source it can pin.
When `expectedIntegrity` is present,
install/update flows enforce it; when it is omitted, the registry resolution is
recorded without an integrity pin.

Channel plugins should provide `openclaw.setupEntry` when status, channel list,
or SecretRef scans need to identify configured accounts without loading the full
runtime. The setup entry should expose channel metadata plus setup-safe config,
status, and secrets adapters; keep network clients, gateway listeners, and
transport runtimes in the main extension entrypoint.

Runtime entrypoint fields do not override package-boundary checks for source
entrypoint fields. For example, `openclaw.runtimeExtensions` cannot make an
escaping `openclaw.extensions` path loadable.

`openclaw.install.allowInvalidConfigRecovery` is intentionally narrow. It does
not make arbitrary broken configs installable. Today it only allows install
flows to recover from specific stale bundled-plugin upgrade failures, such as a
missing bundled plugin path or a stale `channels.<id>` entry for that same
bundled plugin. Unrelated config errors still block install and send operators
to `openclaw doctor --fix`.

`openclaw.channel.persistedAuthState` is package metadata for a tiny checker
module:

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

Use it when setup, doctor, status, or read-only presence flows need a cheap
yes/no auth probe before the full channel plugin loads. Persisted auth state is
not configured channel state: do not use this metadata to auto-enable plugins,
repair runtime dependencies, or decide whether a channel runtime should load.
The target export should be a small function that reads persisted state only; do
not route it through the full channel runtime barrel.

`openclaw.channel.configuredState` follows the same shape for cheap env-only
configured checks:

```json
{
  "openclaw": {
    "channel": {
      "id": "telegram",
      "configuredState": {
        "specifier": "./configured-state",
        "exportName": "hasTelegramConfiguredState"
      }
    }
  }
}
```

Use it when a channel can answer configured-state from env or other tiny
non-runtime inputs. If the check needs full config resolution or the real
channel runtime, keep that logic in the plugin `config.hasConfiguredState`
hook instead.

## Discovery precedence (duplicate plugin ids)

OpenClaw discovers plugins from several roots (bundled, global install, workspace, explicit config-selected paths). If two discoveries share the same `id`, only the **highest-precedence** manifest is kept; lower-precedence duplicates are dropped instead of loading beside it.

Precedence, highest to lowest:

1. **Config-selected** — a path explicitly pinned in `plugins.entries.<id>`
2. **Bundled** — plugins shipped with OpenClaw
3. **Global install** — plugins installed into the global OpenClaw plugin root
4. **Workspace** — plugins discovered relative to the current workspace

Implications:

- A forked or stale copy of a bundled plugin sitting in the workspace will not shadow the bundled build.
- To actually override a bundled plugin with a local one, pin it via `plugins.entries.<id>` so it wins by precedence rather than relying on workspace discovery.
- Duplicate drops are logged so Doctor and startup diagnostics can point at the discarded copy.

## JSON Schema requirements

- **Every plugin must ship a JSON Schema**, even if it accepts no config.
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).
- Schemas are validated at config read/write time, not at runtime.

## Validation behavior

- Unknown `channels.*` keys are **errors**, unless the channel id is declared by
  a plugin manifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`
  must reference **discoverable** plugin ids. Unknown ids are **errors**.
- If a plugin is installed but has a broken or missing manifest or schema,
  validation fails and Doctor reports the plugin error.
- If plugin config exists but the plugin is **disabled**, the config is kept and
  a **warning** is surfaced in Doctor + logs.

See [Configuration reference](/gateway/configuration) for the full `plugins.*` schema.

## Notes

- The manifest is **required for native OpenClaw plugins**, including local filesystem loads. Runtime still loads the plugin module separately; the manifest is only for discovery + validation.
- Native manifests are parsed with JSON5, so comments, trailing commas, and unquoted keys are accepted as long as the final value is still an object.
- Only documented manifest fields are read by the manifest loader. Avoid custom top-level keys.
- `channels`, `providers`, `cliBackends`, and `skills` can all be omitted when a plugin does not need them.
- `providerDiscoveryEntry` must stay lightweight and should not import broad runtime code; use it for static provider catalog metadata or narrow discovery descriptors, not request-time execution.
- Exclusive plugin kinds are selected through `plugins.slots.*`: `kind: "memory"` via `plugins.slots.memory`, `kind: "context-engine"` via `plugins.slots.contextEngine` (default `legacy`).
- Env-var metadata (`setup.providers[].envVars`, deprecated `providerAuthEnvVars`, and `channelEnvVars`) is declarative only. Status, audit, cron delivery validation, and other read-only surfaces still apply plugin trust and effective activation policy before treating an env var as configured.
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
