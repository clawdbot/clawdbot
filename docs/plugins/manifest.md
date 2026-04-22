---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building an OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin Manifest"
---

# Plugin manifest (openclaw.plugin.json)

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

`openclaw.plugin.json` is the metadata OpenClaw reads before it loads your
plugin code.

Use it for:

- plugin identity
- config validation
- auth and onboarding metadata that should be available without booting plugin
  runtime
- cheap activation hints that control-plane surfaces can inspect before runtime
  loads
- cheap setup descriptors that setup/onboarding surfaces can inspect before
  runtime loads
- alias and auto-enable metadata that should resolve before plugin runtime loads
- shorthand model-family ownership metadata that should auto-activate the
  plugin before runtime loads
- static capability ownership snapshots used for bundled compat wiring and
  contract coverage
- cheap QA runner metadata that the shared `openclaw qa` host can inspect
  before plugin runtime loads
- channel-specific config metadata that should merge into catalog and validation
  surfaces without loading runtime
- config UI hints

Do not use it for:

- registering runtime behavior
- declaring code entrypoints
- npm install metadata

Those belong in your plugin code and `package.json`.

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
  "providerEndpoints": [
    {
      "endpointClass": "xai-native",
      "hosts": ["api.x.ai"]
    }
  ],
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

| Field                                | Required | Type                             | What it means                                                                                                                                                                                                |
| ------------------------------------ | -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                 | Yes      | `string`                         | Canonical plugin id. This is the id used in `plugins.entries.<id>`.                                                                                                                                          |
| `configSchema`                       | Yes      | `object`                         | Inline JSON Schema for this plugin's config.                                                                                                                                                                 |
| `enabledByDefault`                   | No       | `true`                           | Marks a bundled plugin as enabled by default. Omit it, or set any non-`true` value, to leave the plugin disabled by default.                                                                                 |
| `legacyPluginIds`                    | No       | `string[]`                       | Legacy ids that normalize to this canonical plugin id.                                                                                                                                                       |
| `autoEnableWhenConfiguredProviders`  | No       | `string[]`                       | Provider ids that should auto-enable this plugin when auth, config, or model refs mention them.                                                                                                              |
| `kind`                               | No       | `"memory"` \| `"context-engine"` | Declares an exclusive plugin kind used by `plugins.slots.*`.                                                                                                                                                 |
| `channels`                           | No       | `string[]`                       | Channel ids owned by this plugin. Used for discovery and config validation.                                                                                                                                  |
| `providers`                          | No       | `string[]`                       | Provider ids owned by this plugin.                                                                                                                                                                           |
| `modelSupport`                       | No       | `object`                         | Manifest-owned shorthand model-family metadata used to auto-load the plugin before runtime.                                                                                                                  |
| `providerEndpoints`                  | No       | `object[]`                       | Manifest-owned endpoint host/baseUrl metadata for provider routes that core must classify before provider runtime loads.                                                                                     |
| `cliBackends`                        | No       | `string[]`                       | CLI inference backend ids owned by this plugin. Used for startup auto-activation from explicit config refs.                                                                                                  |
| `syntheticAuthRefs`                  | No       | `string[]`                       | Provider or CLI backend refs whose plugin-owned synthetic auth hook should be probed during cold model discovery before runtime loads.                                                                       |
| `nonSecretAuthMarkers`               | No       | `string[]`                       | Bundled-plugin-owned placeholder API key values that represent non-secret local, OAuth, or ambient credential state.                                                                                         |
| `commandAliases`                     | No       | `object[]`                       | Command names owned by this plugin that should produce plugin-aware config and CLI diagnostics before runtime loads.                                                                                         |
| `providerAuthEnvVars`                | No       | `Record<string, string[]>`       | Cheap provider-auth env metadata that OpenClaw can inspect without loading plugin code.                                                                                                                      |
| `providerAuthAliases`                | No       | `Record<string, string>`         | Provider ids that should reuse another provider id for auth lookup, for example a coding provider that shares the base provider API key and auth profiles.                                                   |
| `channelEnvVars`                     | No       | `Record<string, string[]>`       | Cheap channel env metadata that OpenClaw can inspect without loading plugin code. Use this for env-driven channel setup or auth surfaces that generic startup/config helpers should see.                     |
| `providerAuthChoices`                | No       | `object[]`                       | Cheap auth-choice metadata for onboarding pickers, preferred-provider resolution, and simple CLI flag wiring.                                                                                                |
| `activation`                         | No       | `object`                         | Cheap activation hints for provider, command, channel, route, and capability-triggered loading. Metadata only; plugin runtime still owns actual behavior.                                                    |
| `setup`                              | No       | `object`                         | Cheap setup/onboarding descriptors that discovery and setup surfaces can inspect without loading plugin runtime.                                                                                             |
| `qaRunners`                          | No       | `object[]`                       | Cheap QA runner descriptors used by the shared `openclaw qa` host before plugin runtime loads.                                                                                                               |
| `contracts`                          | No       | `object`                         | Static bundled capability snapshot for speech, realtime transcription, realtime voice, media-understanding, image-generation, music-generation, video-generation, web-fetch, web search, and tool ownership. |
| `mediaUnderstandingProviderMetadata` | No       | `Record<string, object>`         | Cheap media-understanding defaults for provider ids declared in `contracts.mediaUnderstandingProviders`.                                                                                                     |
| `channelConfigs`                     | No       | `Record<string, object>`         | Manifest-owned channel config metadata merged into discovery and validation surfaces before runtime loads.                                                                                                   |
| `skills`                             | No       | `string[]`                       | Skill directories to load, relative to the plugin root.                                                                                                                                                      |
| `name`                               | No       | `string`                         | Human-readable plugin name.                                                                                                                                                                                  |
| `description`                        | No       | `string`                         | Short summary shown in plugin surfaces.                                                                                                                                                                      |
| `version`                            | No       | `string`                         | Informational plugin version.                                                                                                                                                                                |
| `uiHints`                            | No       | `Record<string, object>`         | UI labels, placeholders, and sensitivity hints for config fields.                                                                                                                                            |

## providerAuthChoices reference

Each `providerAuthChoices` entry describes one onboarding or auth choice.
OpenClaw reads this before provider runtime loads.

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
should activate it later.

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

This block is metadata only. It does not register runtime behavior, and it does
not replace `register(...)`, `setupEntry`, or other runtime/plugin entrypoints.
Current consumers use it as a narrowing hint before broader plugin loading, so
missing activation metadata usually only costs performance; it should not
change correctness while legacy manifest ownership fallbacks still exist.

```json
{
  "activation": {
    "onProviders": ["openai"],
    "onCommands": ["models"],
    "onChannels": ["web"],
    "onRoutes": ["gateway-webhook"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| Field            | Required | Type                                                 | What it means                                                     |
| ---------------- | -------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `onProviders`    | No       | `string[]`                                           | Provider ids that should activate this plugin when requested.     |
| `onCommands`     | No       | `string[]`                                           | Command ids that should activate this plugin.                     |
| `onChannels`     | No       | `string[]`                                           | Channel ids that should activate this plugin.                     |
| `onRoutes`       | No       | `string[]`                                           | Route kinds that should activate this plugin.                     |
| `onCapabilities` | No       | `Array<"provider" \| "channel" \| "tool" \| "hook">` | Broad capability hints used by control-plane activation planning. |

Current live consumers:

- command-triggered CLI planning falls back to legacy
  `commandAliases[].cliCommand` or `commandAliases[].name`
- channel-triggered setup/channel planning falls back to legacy `channels[]`
  ownership when explicit channel activation metadata is missing
- provider-triggered setup/runtime planning falls back to legacy
  `providers[]` and top-level `cliBackends[]` ownership when explicit provider
  activation metadata is missing

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

Because setup lookup can execute plugin-owned `setup-api` code, normalized
`setup.providers[].id` and `setup.cliBackends[]` values must stay unique across
discovered plugins. Ambiguous ownership fails closed instead of picking a
winner from discovery order.

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
    "embeddedExtensionFactories": ["pi"],
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "mediaUnderstandingProviders": ["openai", "openai-codex"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

Each list is optional:

| Field                            | Type       | What it means                                                     |
| -------------------------------- | ---------- | ----------------------------------------------------------------- |
| `embeddedExtensionFactories`     | `string[]` | Embedded runtime ids a bundled plugin may register factories for. |
| `speechProviders`                | `string[]` | Speech provider ids this plugin owns.                             |
| `realtimeTranscriptionProviders` | `string[]` | Realtime-transcription provider ids this plugin owns.             |
| `realtimeVoiceProviders`         | `string[]` | Realtime-voice provider ids this plugin owns.                     |
| `mediaUnderstandingProviders`    | `string[]` | Media-understanding provider ids this plugin owns.                |
| `imageGenerationProviders`       | `string[]` | Image-generation provider ids this plugin owns.                   |
| `videoGenerationProviders`       | `string[]` | Video-generation provider ids this plugin owns.                   |
| `webFetchProviders`              | `string[]` | Web-fetch provider ids this plugin owns.                          |
| `webSearchProviders`             | `string[]` | Web-search provider ids this plugin owns.                         |
| `tools`                          | `string[]` | Agent tool names this plugin owns for bundled contract checks.    |

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
runtime loads.

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
| `preferOver`  | `string[]`               | Legacy or lower-priority plugin ids this channel should outrank in selection surfaces.    |

## modelSupport reference

Use `modelSupport` when OpenClaw should infer your provider plugin from
shorthand model ids like `gpt-5.4` or `claude-sonnet-4.6` before plugin runtime
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
| `openclaw.channel.configuredState`                                | Lightweight configured-state checker metadata that can answer "does env-only setup already exist?" without loading the full channel runtime.                                         |
| `openclaw.channel.persistedAuthState`                             | Lightweight persisted-auth checker metadata that can answer "is anything already signed in?" without loading the full channel runtime.                                               |
| `openclaw.install.npmSpec` / `openclaw.install.localPath`         | Install/update hints for bundled and externally published plugins.                                                                                                                   |
| `openclaw.install.defaultChoice`                                  | Preferred install path when multiple install sources are available.                                                                                                                  |
| `openclaw.install.minHostVersion`                                 | Minimum supported OpenClaw host version, using a semver floor like `>=2026.3.22`.                                                                                                    |
| `openclaw.install.allowInvalidConfigRecovery`                     | Allows a narrow bundled-plugin reinstall recovery path when config is invalid.                                                                                                       |
| `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen` | Lets setup-only channel surfaces load before the full channel plugin during startup.                                                                                                 |

`openclaw.install.minHostVersion` is enforced during install and manifest
registry loading. Invalid values are rejected; newer-but-valid values skip the
plugin on older hosts.

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

Use it when setup, doctor, or configured-state flows need a cheap yes/no auth
probe before the full channel plugin loads. The target export should be a small
function that reads persisted state only; do not route it through the full
channel runtime barrel.

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

- The manifest is **required for native OpenClaw plugins**, including local filesystem loads.
- Runtime still loads the plugin module separately; the manifest is only for
  discovery + validation.
- Native manifests are parsed with JSON5, so comments, trailing commas, and
  unquoted keys are accepted as long as the final value is still an object.
- Only documented manifest fields are read by the manifest loader. Avoid adding
  custom top-level keys here.
- `providerAuthEnvVars` is the cheap metadata path for auth probes, env-marker
  validation, and similar provider-auth surfaces that should not boot plugin
  runtime just to inspect env names.
- `providerAuthAliases` lets provider variants reuse another provider's auth
  env vars, auth profiles, config-backed auth, and API-key onboarding choice
  without hardcoding that relationship in core.
- `providerEndpoints` lets provider plugins own simple endpoint host/baseUrl
  matching metadata. Use it only for endpoint classes core already supports;
  the plugin still owns runtime behavior.
- `syntheticAuthRefs` is the cheap metadata path for provider-owned synthetic
  auth hooks that must be visible to cold model discovery before the runtime
  registry exists. Only list refs whose runtime provider or CLI backend actually
  implements `resolveSyntheticAuth`.
- `nonSecretAuthMarkers` is the cheap metadata path for bundled plugin-owned
  placeholder API keys such as local, OAuth, or ambient credential markers.
  Core treats these as non-secrets for auth display and secret audits without
  hardcoding the owning provider.
- `channelEnvVars` is the cheap metadata path for shell-env fallback, setup
  prompts, and similar channel surfaces that should not boot plugin runtime
  just to inspect env names. Env names are metadata, not activation by
  themselves: status, audit, cron delivery validation, and other read-only
  surfaces still apply plugin trust and effective activation policy before they
  treat an env var as a configured channel.
- `providerAuthChoices` is the cheap metadata path for auth-choice pickers,
  `--auth-choice` resolution, preferred-provider mapping, and simple onboarding
  CLI flag registration before provider runtime loads. For runtime wizard
  metadata that requires provider code, see
  [Provider runtime hooks](/plugins/architecture#provider-runtime-hooks).
- Exclusive plugin kinds are selected through `plugins.slots.*`.
  - `kind: "memory"` is selected by `plugins.slots.memory`.
  - `kind: "context-engine"` is selected by `plugins.slots.contextEngine`
    (default: built-in `legacy`).
- `channels`, `providers`, `cliBackends`, and `skills` can be omitted when a
  plugin does not need them.
- If your plugin depends on native modules, document the build steps and any
  package-manager allowlist requirements (for example, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).

## Related

- [Building Plugins](/plugins/building-plugins) — getting started with plugins
- [Plugin Architecture](/plugins/architecture) — internal architecture
- [SDK Overview](/plugins/sdk-overview) — Plugin SDK reference
