---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building an OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin manifest"
---

This page covers the **native OpenClaw plugin manifest**, `openclaw.plugin.json`. For compatible bundle layouts (Agent Plugins, Codex, Claude, Cursor), see [Plugin bundles](/plugins/bundles).

Compatible bundle formats use their own manifest files instead:

- Agent Plugins bundle: `plugin.json` at the package root, per the open [Agent Plugins standard](https://agent-plugins.org)
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
- root CLI command names, descriptions, and subcommand markers (`cliCommands`)
- shorthand model-family ownership
- static capability-ownership snapshots (`contracts`)
- dashboard widget data bindings and action verbs
- static MCP servers that should exist while the plugin is enabled
- durable and regenerable state- or agent-relative backup resources
- QA runner metadata the shared `openclaw qa` host can inspect
- channel-specific config metadata merged into catalog and validation surfaces

**Do not use it for:** registering native runtime hooks, declaring the full plugin runtime entrypoint, or npm install metadata. Those belong in your plugin code and `package.json`.

## Where each field is documented

Every manifest field is documented on this page or on one of the seven child pages below.
The anchors from the single-page version still resolve here.

### Model fields

[Manifest model fields](/plugins/manifest/models) — Manifest model catalog, shorthand family, id normalization, and pricing fields.

- <a id="modelsupport-reference"></a>[`modelSupport`](/plugins/manifest/models#modelsupport-reference)
- <a id="modelcatalog-reference"></a>[`modelCatalog`](/plugins/manifest/models#modelcatalog-reference)
- <a id="modelidnormalization-reference"></a>[`modelIdNormalization`](/plugins/manifest/models#modelidnormalization-reference)
- <a id="modelpricing-reference"></a>[`modelPricing`](/plugins/manifest/models#modelpricing-reference)
- <a id="openclaw-provider-index"></a>[OpenClaw Provider Index](/plugins/manifest/models#openclaw-provider-index)

### Provider fields

[Manifest provider fields](/plugins/manifest/providers) — Manifest generation, media-understanding, endpoint, and request provider metadata.

- <a id="generation-provider-metadata-reference"></a>[`imageGenerationProviderMetadata`, `videoGenerationProviderMetadata`, `musicGenerationProviderMetadata`](/plugins/manifest/providers#generation-provider-metadata-reference)
- <a id="mediaunderstandingprovidermetadata-reference"></a>[`mediaUnderstandingProviderMetadata`](/plugins/manifest/providers#mediaunderstandingprovidermetadata-reference)
- <a id="providerendpoints-reference"></a>[`providerEndpoints`](/plugins/manifest/providers#providerendpoints-reference)
- <a id="providerrequest-reference"></a>[`providerRequest`](/plugins/manifest/providers#providerrequest-reference)

### Setup and auth fields

[Manifest setup and auth fields](/plugins/manifest/setup-and-auth) — Manifest setup descriptors, auth choices, conversation discovery, and config UI hints.

- <a id="native-conversation-discovery"></a>[`setup.nativeSessionCatalog`](/plugins/manifest/setup-and-auth#native-conversation-discovery)
- <a id="providerauthchoices-reference"></a>[`providerAuthChoices`](/plugins/manifest/setup-and-auth#providerauthchoices-reference)
- <a id="setup-reference"></a>[`setup`, `providerUsageAuthEnvVars`](/plugins/manifest/setup-and-auth#setup-reference)
- <a id="setup.providers-reference"></a><a id="setup-providers-reference"></a>[`setup.providers`](/plugins/manifest/setup-and-auth#setup-providers-reference)
- <a id="setup-fields"></a>[`setup` field table](/plugins/manifest/setup-and-auth#setup-fields)
- <a id="uihints-reference"></a>[`uiHints`](/plugins/manifest/setup-and-auth#uihints-reference)

### Capability fields

[Manifest capability fields](/plugins/manifest/capabilities) — Manifest capability ownership, tool availability metadata, and activation planning.

- <a id="contracts-reference"></a>[`contracts`](/plugins/manifest/capabilities#contracts-reference)
- <a id="tool-metadata-reference"></a>[`toolMetadata`](/plugins/manifest/capabilities#tool-metadata-reference)
- <a id="activation-reference"></a>[`activation`](/plugins/manifest/capabilities#activation-reference)

### Host surface fields

[Manifest host surface fields](/plugins/manifest/surfaces) — Manifest fields for icons, CLI, MCP, Control UI, dashboard, QA, channel, and backup surfaces.

- <a id="plugin-icon"></a>[Plugin icon, `doctorContract`, `doctorHealthChecks`, `sessionRouteStateOwners`](/plugins/manifest/surfaces#plugin-icon)
- <a id="transcript-sources-reference"></a>[`transcriptSources`](/plugins/manifest/surfaces#transcript-sources-reference)
- <a id="backupresources-reference"></a>[`backupResources`](/plugins/manifest/surfaces#backupresources-reference)
- <a id="mcp-server-reference"></a>[`mcpServers`](/plugins/manifest/surfaces#mcp-server-reference)
- <a id="controlui-reference"></a>[`controlUi`](/plugins/manifest/surfaces#controlui-reference)
- <a id="dashboard-reference"></a>[`dashboard`](/plugins/manifest/surfaces#dashboard-reference)
- <a id="catalog-reference"></a>[`catalog`](/plugins/manifest/surfaces#catalog-reference)
- <a id="clicommands-reference"></a>[`cliCommands`](/plugins/manifest/surfaces#clicommands-reference)
- <a id="commandaliases-reference"></a>[`commandAliases`](/plugins/manifest/surfaces#commandaliases-reference)
- <a id="qarunners-reference"></a>[`qaRunners`](/plugins/manifest/surfaces#qarunners-reference)
- <a id="channelconfigs-reference"></a>[`channelConfigs`](/plugins/manifest/surfaces#channelconfigs-reference)
- <a id="replacing-another-channel-plugin"></a>[`channelConfigs.<id>.preferOver`](/plugins/manifest/surfaces#replacing-another-channel-plugin)

### Config and secret fields

[Manifest config and secret fields](/plugins/manifest/config-and-secrets) — Manifest dangerous-flag, SecretRef migration, and secret provider preset metadata.

- <a id="configcontracts-reference"></a>[`configContracts`](/plugins/manifest/config-and-secrets#configcontracts-reference)
- <a id="secretproviderintegrations-reference"></a>[`secretProviderIntegrations`](/plugins/manifest/config-and-secrets#secretproviderintegrations-reference)

### Manifest and package.json fields

[Manifest versus package.json](/plugins/manifest/package-json) — Which pre-runtime metadata lives in package.json, and which duplicate plugin id wins.

- <a id="manifest-versus-package.json"></a><a id="manifest-versus-package-json"></a>[Manifest versus `package.json`](/plugins/manifest/package-json#manifest-versus-package-json)
- <a id="package.json-fields-that-affect-discovery"></a><a id="package-json-fields-that-affect-discovery"></a>[`package.json#openclaw` fields](/plugins/manifest/package-json#package-json-fields-that-affect-discovery)
- <a id="discovery-precedence-(duplicate-plugin-ids)"></a><a id="discovery-precedence-duplicate-plugin-ids"></a>[Discovery precedence](/plugins/manifest/package-json#discovery-precedence-duplicate-plugin-ids)

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

| Field                                | Required | Type                         | What it means                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                 | Yes      | `string`                     | Canonical plugin id. This is the id used in `plugins.entries.<id>`. Exception: a package whose `package.json` declares multiple plugin entries registers each entry as `<id>/<entry-basename>` (for example `pack/one`), and that entry-scoped id is the `plugins.entries` key for that entry. Entry basenames must be unique within the package; colliding basenames are rejected at discovery. |
| `configSchema`                       | Yes      | `object`                     | Inline JSON Schema for this plugin's config.                                                                                                                                                                                                                                                                                                                                                     |
| `requiresPlugins`                    | No       | `string[]`                   | Plugin ids that must also be installed for this plugin to have an effect. Discovery keeps the plugin loadable but warns when any required plugin is missing.                                                                                                                                                                                                                                     |
| `enabledByDefault`                   | No       | `true`                       | Marks a bundled plugin as enabled by default. Omit it, or set any non-`true` value, to leave the plugin disabled by default.                                                                                                                                                                                                                                                                     |
| `enabledByDefaultOnPlatforms`        | No       | `string[]`                   | Marks a bundled plugin as enabled by default only on the listed Node.js platforms, for example `["darwin"]`. Explicit config still wins.                                                                                                                                                                                                                                                         |
| `legacyPluginIds`                    | No       | `string[]`                   | Legacy ids that normalize to this canonical plugin id.                                                                                                                                                                                                                                                                                                                                           |
| `autoEnableWhenConfiguredProviders`  | No       | `string[]`                   | Provider ids that should auto-enable this plugin when auth, config, or model refs mention them.                                                                                                                                                                                                                                                                                                  |
| `kind`                               | No       | `PluginKind \| PluginKind[]` | Declares one or more exclusive plugin kinds (`"memory"`, `"context-engine"`) used by `plugins.slots.*`. A plugin that owns both slots declares both kinds in one array.                                                                                                                                                                                                                          |
| `channels`                           | No       | `string[]`                   | Channel ids owned by this plugin. Used for discovery and config validation.                                                                                                                                                                                                                                                                                                                      |
| `providers`                          | No       | `string[]`                   | Provider ids owned by this plugin.                                                                                                                                                                                                                                                                                                                                                               |
| `providerCatalogEntry`               | No       | `string`                     | Lightweight provider-catalog module path, relative to the plugin root, for manifest-scoped provider catalog metadata that can be loaded without activating the full plugin runtime.                                                                                                                                                                                                              |
| `capabilityCatalogEntry`             | No       | `string`                     | Lightweight module of typed speech, realtime transcription, and realtime voice provider descriptors, relative to the plugin root. See [Capability catalogs](#capability-catalogs).                                                                                                                                                                                                               |
| `modelSupport`                       | No       | `object`                     | Manifest-owned shorthand model-family metadata used to auto-load the plugin before runtime.                                                                                                                                                                                                                                                                                                      |
| `modelCatalog`                       | No       | `object`                     | Declarative model catalog metadata for providers owned by this plugin. This is the control-plane contract for future read-only listing, onboarding, model pickers, aliases, and suppression without loading plugin runtime.                                                                                                                                                                      |
| `modelPricing`                       | No       | `object`                     | Provider-owned hosted-pricing publication policy. Use it to opt local/self-hosted providers out of published pricing or map provider refs to supported public pricing catalogs without hardcoding provider ids in core.                                                                                                                                                                          |
| `modelIdNormalization`               | No       | `object`                     | Provider-owned model-id alias/prefix cleanup that must run before provider runtime loads.                                                                                                                                                                                                                                                                                                        |
| `providerEndpoints`                  | No       | `object[]`                   | Manifest-owned endpoint host/baseUrl metadata for provider routes that core must classify before provider runtime loads.                                                                                                                                                                                                                                                                         |
| `providerRequest`                    | No       | `object`                     | Cheap provider-family and request-compatibility metadata used by generic request policy before provider runtime loads.                                                                                                                                                                                                                                                                           |
| `secretProviderIntegrations`         | No       | `Record<string, object>`     | Declarative SecretRef exec provider presets that setup or install surfaces can offer without hardcoding provider-specific integrations in core.                                                                                                                                                                                                                                                  |
| `cliBackends`                        | No       | `string[]`                   | CLI inference backend ids owned by this plugin. Used for startup auto-activation from explicit config refs.                                                                                                                                                                                                                                                                                      |
| `syntheticAuthRefs`                  | No       | `string[]`                   | Provider or CLI backend refs whose plugin-owned synthetic auth hook should be probed during cold model discovery before runtime loads.                                                                                                                                                                                                                                                           |
| `nonSecretAuthMarkers`               | No       | `string[]`                   | Bundled-plugin-owned placeholder API key values that represent non-secret local, OAuth, or ambient credential state.                                                                                                                                                                                                                                                                             |
| `commandAliases`                     | No       | `object[]`                   | Command names owned by this plugin that should produce plugin-aware config and CLI diagnostics before runtime loads.                                                                                                                                                                                                                                                                             |
| `cliCommands`                        | No       | `object[]`                   | Root CLI commands shown in `openclaw --help` before plugin code loads. Each row requires `name`, `description`, and `hasSubcommands`.                                                                                                                                                                                                                                                            |
| `providerUsageAuthEnvVars`           | No       | `Record<string, string[]>`   | Usage/billing-only provider credentials. OpenClaw uses these names for usage discovery and secret scrubbing but never for inference auth.                                                                                                                                                                                                                                                        |
| `providerAuthAliases`                | No       | `Record<string, string>`     | Provider ids that should reuse another provider id for auth lookup, for example a coding provider that shares the base provider API key and auth profiles.                                                                                                                                                                                                                                       |
| `providerAuthChoices`                | No       | `object[]`                   | Cheap auth-choice metadata for onboarding pickers, preferred-provider resolution, and simple CLI flag wiring.                                                                                                                                                                                                                                                                                    |
| `activation`                         | No       | `object`                     | Cheap activation planner metadata for startup, provider, command, channel, route, and capability-triggered loading. Metadata only; plugin runtime still owns actual behavior.                                                                                                                                                                                                                    |
| `backupResources`                    | No       | `object[]`                   | Manifest-owned durable or regenerable state- or agent-relative backup resources. Applied only for effectively activated, loadable plugins without executing their runtime. See [backupResources reference](/plugins/manifest/surfaces#backupresources-reference).                                                                                                                                |
| `setup`                              | No       | `object`                     | Cheap setup/onboarding descriptors that discovery and setup surfaces can inspect without loading plugin runtime.                                                                                                                                                                                                                                                                                 |
| `doctorContract`                     | No       | `object`                     | Declares which dynamic doctor-contract surfaces the plugin artifact exports so doctor loads only relevant modules.                                                                                                                                                                                                                                                                               |
| `doctorHealthChecks`                 | No       | `boolean`                    | Declares health-check registration in the selected plugin's public API. Currently used for the Codex health API.                                                                                                                                                                                                                                                                                 |
| `sessionRouteStateOwners`            | No       | `object[]`                   | Static session-route ownership for doctor cleanup. Each entry declares an `id`, `label`, and optional `providerIds`, `runtimeIds`, `cliSessionKeys`, and `authProfilePrefixes`.                                                                                                                                                                                                                  |
| `qaRunners`                          | No       | `object[]`                   | Cheap QA runner descriptors used by the shared `openclaw qa` host before plugin runtime loads.                                                                                                                                                                                                                                                                                                   |
| `dashboard`                          | No       | `object`                     | Dashboard widget data bindings and action verbs. Each entry is validated against a Gateway method registered by this plugin with the required read or write scope. See [dashboard reference](/plugins/manifest/surfaces#dashboard-reference).                                                                                                                                                    |
| `mcpServers`                         | No       | `Record<string, object>`     | Static MCP server definitions contributed while this plugin is enabled. Relative command arguments and working directories resolve from the plugin root. Operator `mcp.servers` entries override or disable definitions with the same name. See [MCP server reference](/plugins/manifest/surfaces#mcp-server-reference).                                                                         |
| `contracts`                          | No       | `object`                     | Static capability ownership snapshot for external auth hooks, embeddings, speech, realtime transcription, realtime voice, media-understanding, image/video/music generation, web fetch, web search, worker providers, document/web-content extraction, and tool ownership.                                                                                                                       |
| `transcriptSources`                  | No       | `Record<string, object>`     | Static transcript source names and auto-start locator requirements for IDs declared in `contracts.transcriptSourceProviders`. See [Transcript sources reference](/plugins/manifest/surfaces#transcript-sources-reference).                                                                                                                                                                       |
| `configContracts`                    | No       | `object`                     | Manifest-owned config behavior consumed by generic core helpers: dangerous-flag detection, SecretRef migration targets, and legacy config-path narrowing. See [configContracts reference](/plugins/manifest/config-and-secrets#configcontracts-reference).                                                                                                                                       |
| `mediaUnderstandingProviderMetadata` | No       | `Record<string, object>`     | Cheap media-understanding defaults for provider ids declared in `contracts.mediaUnderstandingProviders`.                                                                                                                                                                                                                                                                                         |
| `imageGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap image-generation auth metadata for provider ids declared in `contracts.imageGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                                                                                                                                               |
| `videoGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap video-generation auth metadata for provider ids declared in `contracts.videoGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                                                                                                                                               |
| `musicGenerationProviderMetadata`    | No       | `Record<string, object>`     | Cheap music-generation auth metadata for provider ids declared in `contracts.musicGenerationProviders`, including provider-owned auth aliases and base-url guards.                                                                                                                                                                                                                               |
| `toolMetadata`                       | No       | `Record<string, object>`     | Cheap availability metadata for plugin-owned tools declared in `contracts.tools`. Use it when a tool should not load runtime unless config, env, or auth evidence exists.                                                                                                                                                                                                                        |
| `channelConfigs`                     | No       | `Record<string, object>`     | Manifest-owned channel config metadata merged into discovery and validation surfaces before runtime loads.                                                                                                                                                                                                                                                                                       |
| `skills`                             | No       | `string[]`                   | Skill directories to load, relative to the plugin root.                                                                                                                                                                                                                                                                                                                                          |
| `name`                               | No       | `string`                     | Human-readable plugin name.                                                                                                                                                                                                                                                                                                                                                                      |
| `description`                        | No       | `string`                     | Short summary shown in plugin surfaces.                                                                                                                                                                                                                                                                                                                                                          |
| `catalog`                            | No       | `object`                     | Optional presentation hints for plugin catalog surfaces. This metadata does not install, enable, or grant trust to a plugin.                                                                                                                                                                                                                                                                     |
| `version`                            | No       | `string`                     | Informational plugin version.                                                                                                                                                                                                                                                                                                                                                                    |
| `uiHints`                            | No       | `Record<string, object>`     | UI labels, placeholders, and sensitivity hints for config fields.                                                                                                                                                                                                                                                                                                                                |

## JSON Schema requirements

- **Every plugin must ship a JSON Schema**, even if it accepts no config.
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).
- Config is validated against the manifest schema at config read/write time and before the plugin loads.
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

### Capability catalogs

`capabilityCatalogEntry` declares a lightweight module relative to the selected
plugin root, for example `"./capability-catalog.ts"`. It exports actual speech,
realtime transcription, or realtime voice provider descriptors without importing
the full plugin entry. See the [typed SDK contract](/plugins/sdk-subpaths#capability-catalog-entry).

Each supplied family is authoritative, including an empty array. An omitted
family, or a plugin without this declaration, retains the existing `register()`
discovery contract for installed plugins. A malformed, missing, or broken declared
entry fails with a repair diagnostic; it does not fall through to full registration.
Already registered runtime providers remain authoritative, including live broker
and readiness closures.

The entry uses the same plugin-root boundary checks, installed-owner precedence,
prepared metadata generation, and source/built artifact policy as other plugin
surfaces. Repository builds include declared entries and rewrite emitted manifest
paths to the corresponding JavaScript artifacts. Plugin reload owns invalidation;
catalog requests do not poll files for changes.

### Configuration validation

- Required-field errors identify every missing field after schema defaults are applied. For dependencies on multiple fields, the error reports the dependency condition without claiming that fields already present are missing.
- Unknown `channels.*` keys are **errors**, unless the channel id is declared by a plugin manifest. If the same id also appears in `plugins.allow`, `plugins.entries`, or `plugins.installs` (a plugin that is referenced but not currently discoverable), OpenClaw downgrades this to a **warning** instead.
- `plugins.entries.<id>`, `plugins.allow`, and `plugins.deny` referencing unknown plugin ids are **warnings** ("stale config entry ignored"), not errors, so upgrades and removed/renamed plugins do not block gateway startup. An exact `{ enabled: false }` plugin entry is an intentional uninstall marker, so validation and Doctor keep it without a stale-config warning.
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
- Declare exclusive plugin kind in this manifest. Bundled plugins use manifest kinds without loading their runtime during enablement. Runtime-entry `OpenClawPluginDefinition.kind` is deprecated and remains only as a compatibility fallback for older external plugins.
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
  <Card title="Model fields" href="/plugins/manifest/models" icon="list">
    Manifest model catalog, shorthand family, id normalization, and pricing fields.
  </Card>
  <Card title="Provider fields" href="/plugins/manifest/providers" icon="list">
    Manifest generation, media-understanding, endpoint, and request provider metadata.
  </Card>
  <Card title="Setup and auth fields" href="/plugins/manifest/setup-and-auth" icon="list">
    Manifest setup descriptors, auth choices, conversation discovery, and config UI hints.
  </Card>
  <Card title="Capability fields" href="/plugins/manifest/capabilities" icon="list">
    Manifest capability ownership, tool availability metadata, and activation planning.
  </Card>
  <Card title="Host surface fields" href="/plugins/manifest/surfaces" icon="list">
    Manifest fields for icons, CLI, MCP, Control UI, dashboard, QA, channel, and backup surfaces.
  </Card>
  <Card title="Config and secret fields" href="/plugins/manifest/config-and-secrets" icon="list">
    Manifest dangerous-flag, SecretRef migration, and secret provider preset metadata.
  </Card>
  <Card title="Manifest vs package.json" href="/plugins/manifest/package-json" icon="list">
    Which pre-runtime metadata lives in package.json, and which duplicate plugin id wins.
  </Card>
</CardGroup>
