---
summary: "Setup wizards, setup-entry.ts, config schemas, and package.json metadata"
title: "Plugin setup and config"
sidebarTitle: "Setup and config"
read_when:
  - You are adding a setup wizard to a plugin
  - You need to understand setup-entry.ts vs index.ts
  - You are defining plugin config schemas or package.json openclaw metadata
---

Reference for plugin packaging (`package.json` metadata), manifests (`openclaw.plugin.json`), setup entries, and config schemas.

<Tip>
**Looking for a walkthrough?** The how-to guides cover packaging in context: [Channel plugins](/plugins/sdk-channel-plugins#step-1-package-and-manifest) and [Provider plugins](/plugins/sdk-provider-plugins#step-1-package-and-manifest).
</Tip>

## Package metadata

Your `package.json` needs an `openclaw` field that tells the plugin system what your plugin provides:

<Tabs>
  <Tab title="Channel plugin">
    ```json
    {
      "name": "@myorg/openclaw-my-channel",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "my-channel",
          "label": "My Channel",
          "blurb": "Short description of the channel."
        }
      }
    }
    ```
  </Tab>
  <Tab title="Provider plugin / ClawHub baseline">
    ```json openclaw-clawhub-package.json
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
  </Tab>
</Tabs>

<Note>
If you publish the plugin externally on ClawHub, those `compat` and `build` fields are required. The canonical publish snippets live in `docs/snippets/plugin-publish/`.
</Note>

### `openclaw` fields

<ParamField path="extensions" type="string[]">
  Entry point files (relative to package root).
</ParamField>
<ParamField path="setupEntry" type="string">
  Lightweight setup-only entry (optional).
</ParamField>
<ParamField path="channel" type="object">
  Channel catalog metadata for setup, picker, quickstart, and status surfaces.
</ParamField>
<ParamField path="providers" type="string[]">
  Provider ids registered by this plugin.
</ParamField>
<ParamField path="install" type="object">
  Install hints: `npmSpec`, `localPath`, `defaultChoice`, `minHostVersion`, `expectedIntegrity`, `allowInvalidConfigRecovery`.
</ParamField>
<ParamField path="startup" type="object">
  Startup behavior flags.
</ParamField>

### `openclaw.channel`

`openclaw.channel` is cheap package metadata for channel discovery and setup surfaces before runtime loads.

| Field                                  | Type       | What it means                                                                 |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `id`                                   | `string`   | Canonical channel id.                                                         |
| `label`                                | `string`   | Primary channel label.                                                        |
| `selectionLabel`                       | `string`   | Picker/setup label when it should differ from `label`.                        |
| `detailLabel`                          | `string`   | Secondary detail label for richer channel catalogs and status surfaces.       |
| `docsPath`                             | `string`   | Docs path for setup and selection links.                                      |
| `docsLabel`                            | `string`   | Override label used for docs links when it should differ from the channel id. |
| `blurb`                                | `string`   | Short onboarding/catalog description.                                         |
| `order`                                | `number`   | Sort order in channel catalogs.                                               |
| `aliases`                              | `string[]` | Extra lookup aliases for channel selection.                                   |
| `preferOver`                           | `string[]` | Lower-priority plugin/channel ids this channel should outrank.                |
| `systemImage`                          | `string`   | Optional icon/system-image name for channel UI catalogs.                      |
| `selectionDocsPrefix`                  | `string`   | Prefix text before docs links in selection surfaces.                          |
| `selectionDocsOmitLabel`               | `boolean`  | Show the docs path directly instead of a labeled docs link in selection copy. |
| `selectionExtras`                      | `string[]` | Extra short strings appended in selection copy.                               |
| `markdownCapable`                      | `boolean`  | Marks the channel as markdown-capable for outbound formatting decisions.      |
| `exposure`                             | `object`   | Channel visibility controls for setup, configured lists, and docs surfaces.   |
| `quickstartAllowFrom`                  | `boolean`  | Opt this channel into the standard quickstart `allowFrom` setup flow.         |
| `forceAccountBinding`                  | `boolean`  | Require explicit account binding even when only one account exists.           |
| `preferSessionLookupForAnnounceTarget` | `boolean`  | Prefer session lookup when resolving announce targets for this channel.       |

Example:

```json
{
  "openclaw": {
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "selectionLabel": "My Channel (self-hosted)",
      "detailLabel": "My Channel Bot",
      "docsPath": "/channels/my-channel",
      "docsLabel": "my-channel",
      "blurb": "Webhook-based self-hosted chat integration.",
      "order": 80,
      "aliases": ["mc"],
      "preferOver": ["my-channel-legacy"],
      "selectionDocsPrefix": "Guide:",
      "selectionExtras": ["Markdown"],
      "markdownCapable": true,
      "exposure": {
        "configured": true,
        "setup": true,
        "docs": true
      },
      "quickstartAllowFrom": true
    }
  }
}
```

`exposure` supports:

- `configured`: include the channel in configured/status-style listing surfaces
- `setup`: include the channel in interactive setup/configure pickers
- `docs`: mark the channel as public-facing in docs/navigation surfaces

<Note>
`showConfigured` and `showInSetup` remain supported as legacy aliases. Prefer `exposure`.
</Note>

### `openclaw.install`

`openclaw.install` is package metadata, not manifest metadata.

| Field                        | Type                 | What it means                                                                    |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `npmSpec`                    | `string`             | Canonical npm spec for install/update flows.                                     |
| `localPath`                  | `string`             | Local development or bundled install path.                                       |
| `defaultChoice`              | `"npm"` \| `"local"` | Preferred install source when both are available.                                |
| `minHostVersion`             | `string`             | Minimum supported OpenClaw version in the form `>=x.y.z`.                        |
| `expectedIntegrity`          | `string`             | Expected npm dist integrity string, usually `sha512-...`, for pinned installs.   |
| `allowInvalidConfigRecovery` | `boolean`            | Lets bundled-plugin reinstall flows recover from specific stale-config failures. |

<AccordionGroup>
  <Accordion title="Onboarding behavior">
    Interactive onboarding also uses `openclaw.install` for install-on-demand surfaces. If your plugin exposes provider auth choices or channel setup/catalog metadata before runtime loads, onboarding can show that choice, prompt for npm vs local install, install or enable the plugin, then continue the selected flow. Npm onboarding choices require trusted catalog metadata with a registry `npmSpec`; exact versions and `expectedIntegrity` are optional pins. If `expectedIntegrity` is present, install/update flows enforce it. Keep the "what to show" metadata in `openclaw.plugin.json` and the "how to install it" metadata in `package.json`.
  </Accordion>
  <Accordion title="minHostVersion enforcement">
    If `minHostVersion` is set, install and manifest-registry loading both enforce it. Older hosts skip the plugin; invalid version strings are rejected.
  </Accordion>
  <Accordion title="Pinned npm installs">
    For pinned npm installs, keep the exact version in `npmSpec` and add the expected artifact integrity:

    ```json
    {
      "openclaw": {
        "install": {
          "npmSpec": "@wecom/wecom-openclaw-plugin@1.2.3",
          "expectedIntegrity": "sha512-REPLACE_WITH_NPM_DIST_INTEGRITY",
          "defaultChoice": "npm"
        }
      }
    }
    ```

  </Accordion>
  <Accordion title="allowInvalidConfigRecovery scope">
    `allowInvalidConfigRecovery` is not a general bypass for broken configs. It is for narrow bundled-plugin recovery only, so reinstall/setup can repair known upgrade leftovers like a missing bundled plugin path or stale `channels.<id>` entry for that same plugin. If config is broken for unrelated reasons, install still fails closed and tells the operator to run `openclaw doctor --fix`.
  </Accordion>
</AccordionGroup>

### Deferred full load

Channel plugins can opt into deferred loading with:

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

When enabled, OpenClaw loads only `setupEntry` during the pre-listen startup phase, even for already-configured channels. The full entry loads after the gateway starts listening.

<Warning>
Only enable deferred loading when your `setupEntry` registers everything the gateway needs before it starts listening (channel registration, HTTP routes, gateway methods). If the full entry owns required startup capabilities, keep the default behavior.
</Warning>

If your setup/full entry registers gateway RPC methods, keep them on a plugin-specific prefix. Reserved core admin namespaces (`config.*`, `exec.approvals.*`, `wizard.*`, `update.*`) stay core-owned and always resolve to `operator.admin`.

## Plugin manifest

Every native plugin must ship an `openclaw.plugin.json` in the package root. OpenClaw uses this to validate config without executing plugin code.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds My Plugin capabilities to OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "webhookSecret": {
        "type": "string",
        "description": "Webhook verification secret"
      }
    }
  }
}
```

For channel plugins, add `kind` and `channels`:

```json
{
  "id": "my-channel",
  "kind": "channel",
  "channels": ["my-channel"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Even plugins with no config must ship a schema. An empty schema is valid:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

See [Plugin manifest](/plugins/manifest) for the full schema reference.

## ClawHub publishing

For plugin packages, use the package-specific ClawHub command:

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

<Note>
The legacy skill-only publish alias is for skills. Plugin packages should always use `clawhub package publish`.
</Note>

## Setup entry

The `setup-entry.ts` file is a lightweight alternative to `index.ts` that OpenClaw loads when it only needs setup surfaces (onboarding, config repair, disabled channel inspection).

```typescript
// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { myChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(myChannelPlugin);
```

This avoids loading heavy runtime code (crypto libraries, CLI registrations, background services) during setup flows.

Bundled workspace channels that keep setup-safe exports in sidecar modules can use `defineBundledChannelSetupEntry(...)` from `openclaw/plugin-sdk/channel-entry-contract` instead of `defineSetupPluginEntry(...)`. That bundled contract also supports an optional `runtime` export so setup-time runtime wiring can stay lightweight and explicit.

<AccordionGroup>
  <Accordion title="When OpenClaw uses setupEntry instead of the full entry">
    - The channel is disabled but needs setup/onboarding surfaces.
    - The channel is enabled but unconfigured.
    - Deferred loading is enabled (`deferConfiguredChannelFullLoadUntilAfterListen`).
  </Accordion>
  <Accordion title="What setupEntry must register">
    - The channel plugin object (via `defineSetupPluginEntry`).
    - Any HTTP routes required before gateway listen.
    - Any gateway methods needed during startup.

    Those startup gateway methods should still avoid reserved core admin namespaces such as `config.*` or `update.*`.

  </Accordion>
  <Accordion title="What setupEntry should NOT include">
    - CLI registrations.
    - Background services.
    - Heavy runtime imports (crypto, SDKs).
    - Gateway methods only needed after startup.
  </Accordion>
</AccordionGroup>

### Narrow setup helper imports

For hot setup-only paths, prefer the narrow setup helper seams over the broader `plugin-sdk/setup` umbrella when you only need part of the setup surface:

| Import path                        | Use it for                                                                                | Key exports                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/setup-runtime`         | setup-time runtime helpers that stay available in `setupEntry` / deferred channel startup | `createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`, `createSetupInputPresenceValidator`, `noteChannelLookupFailure`, `noteChannelLookupSummary`, `promptResolvedAllowFrom`, `splitSetupEntries`, `createAllowlistSetupWizardProxy`, `createDelegatedSetupWizardProxy` |
| `plugin-sdk/setup-adapter-runtime` | environment-aware account setup adapters                                                  | `createEnvPatchedAccountSetupAdapter`                                                                                                                                                                                                                                                        |
| `plugin-sdk/setup-tools`           | setup/install CLI/archive/docs helpers                                                    | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR`                                                                                                                                                                                |

Use the broader `plugin-sdk/setup` seam when you want the full shared setup toolbox, including config-patch helpers such as `moveSingleAccountChannelSectionToDefaultAccount(...)`.

The setup patch adapters stay hot-path safe on import. Their bundled single-account promotion contract-surface lookup is lazy, so importing `plugin-sdk/setup-runtime` does not eagerly load bundled contract-surface discovery before the adapter is actually used.

### Channel-owned single-account promotion

When a channel upgrades from a single-account top-level config to `channels.<id>.accounts.*`, the default shared behavior is to move promoted account-scoped values into `accounts.default`.

Bundled channels can narrow or override that promotion through their setup contract surface:

- `singleAccountKeysToMove`: extra top-level keys that should move into the promoted account
- `namedAccountPromotionKeys`: when named accounts already exist, only these keys move into the promoted account; shared policy/delivery keys stay at the channel root
- `resolveSingleAccountPromotionTarget(...)`: choose which existing account receives promoted values

<Note>
Matrix is the current bundled example. If exactly one named Matrix account already exists, or if `defaultAccount` points at an existing non-canonical key such as `Ops`, promotion preserves that account instead of creating a new `accounts.default` entry.
</Note>

## Config schema

Plugin config is validated against the JSON Schema in your manifest. Users configure plugins via:

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        config: {
          webhookSecret: "abc123",
        },
      },
    },
  },
}
```

Your plugin receives this config as `api.pluginConfig` during registration.

For channel-specific config, use the channel config section instead:

```json5
{
  channels: {
    "my-channel": {
      token: "bot-token",
      allowFrom: ["user1", "user2"],
    },
  },
}
```

### Building channel config schemas

Use `buildChannelConfigSchema` to convert a Zod schema into the `ChannelConfigSchema` wrapper used by plugin-owned config artifacts:

```typescript
import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

const accountSchema = z.object({
  token: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  accounts: z.object({}).catchall(z.any()).optional(),
  defaultAccount: z.string().optional(),
});

const configSchema = buildChannelConfigSchema(accountSchema);
```

For third-party plugins, the cold-path contract is still the plugin manifest: mirror the generated JSON Schema into `openclaw.plugin.json#channelConfigs` so config schema, setup, and UI surfaces can inspect `channels.<id>` without loading runtime code.

## Setup wizards

Channel plugins can provide interactive setup wizards for `openclaw onboard`. The wizard is a `ChannelSetupWizard` object on the `ChannelPlugin`:

```typescript
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";

const setupWizard: ChannelSetupWizard = {
  channel: "my-channel",
  status: {
    configuredLabel: "Connected",
    unconfiguredLabel: "Not configured",
    resolveConfigured: ({ cfg }) => Boolean((cfg.channels as any)?.["my-channel"]?.token),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "my-channel",
      credentialLabel: "Bot token",
      preferredEnvVar: "MY_CHANNEL_BOT_TOKEN",
      envPrompt: "Use MY_CHANNEL_BOT_TOKEN from environment?",
      keepPrompt: "Keep current token?",
      inputPrompt: "Enter your bot token:",
      inspect: ({ cfg, accountId }) => {
        const token = (cfg.channels as any)?.["my-channel"]?.token;
        return {
          accountConfigured: Boolean(token),
          hasConfiguredValue: Boolean(token),
        };
      },
    },
  ],
};
```

The `ChannelSetupWizard` type supports `credentials`, `textInputs`, `dmPolicy`, `allowFrom`, `groupAccess`, `prepare`, `finalize`, and more. See bundled plugin packages (for example the Discord plugin `src/channel.setup.ts`) for full examples.

<AccordionGroup>
  <Accordion title="Shared allowFrom prompts">
    For DM allowlist prompts that only need the standard `note -> prompt -> parse -> merge -> patch` flow, prefer the shared setup helpers from `openclaw/plugin-sdk/setup`: `createPromptParsedAllowFromForAccount(...)`, `createTopLevelChannelParsedAllowFromPrompt(...)`, and `createNestedChannelParsedAllowFromPrompt(...)`.
  </Accordion>
  <Accordion title="Standard channel setup status">
    For channel setup status blocks that only vary by labels, scores, and optional extra lines, prefer `createStandardChannelSetupStatus(...)` from `openclaw/plugin-sdk/setup` instead of hand-rolling the same `status` object in each plugin.
  </Accordion>
  <Accordion title="Optional channel setup surface">
    For optional setup surfaces that should only appear in certain contexts, use `createOptionalChannelSetupSurface` from `openclaw/plugin-sdk/channel-setup`:

    ```typescript
    import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

    const setupSurface = createOptionalChannelSetupSurface({
      channel: "my-channel",
      label: "My Channel",
      npmSpec: "@myorg/openclaw-my-channel",
      docsPath: "/channels/my-channel",
    });
    // Returns { setupAdapter, setupWizard }
    ```

    `plugin-sdk/channel-setup` also exposes the lower-level `createOptionalChannelSetupAdapter(...)` and `createOptionalChannelSetupWizard(...)` builders when you only need one half of that optional-install surface.

    The generated optional adapter/wizard fail closed on real config writes. They reuse one install-required message across `validateInput`, `applyAccountConfig`, and `finalize`, and append a docs link when `docsPath` is set.

  </Accordion>
  <Accordion title="Binary-backed setup helpers">
    For binary-backed setup UIs, prefer the shared delegated helpers instead of copying the same binary/status glue into every channel:

    - `createDetectedBinaryStatus(...)` for status blocks that vary only by labels, hints, scores, and binary detection
    - `createCliPathTextInput(...)` for path-backed text inputs
    - `createDelegatedSetupWizardStatusResolvers(...)`, `createDelegatedPrepare(...)`, `createDelegatedFinalize(...)`, and `createDelegatedResolveConfigured(...)` when `setupEntry` needs to forward to a heavier full wizard lazily
    - `createDelegatedTextInputShouldPrompt(...)` when `setupEntry` only needs to delegate a `textInputs[*].shouldPrompt` decision

  </Accordion>
</AccordionGroup>

## Publishing and installing

**External plugins:** publish to [ClawHub](/tools/clawhub) or npm, then install:

<Tabs>
  <Tab title="Auto (ClawHub then npm)">
    ```bash
    openclaw plugins install @myorg/openclaw-my-plugin
    ```

    OpenClaw tries ClawHub first and falls back to npm automatically.

  </Tab>
  <Tab title="ClawHub only">
    ```bash
    openclaw plugins install clawhub:@myorg/openclaw-my-plugin
    ```
  </Tab>
  <Tab title="npm package spec">
    There is no matching `npm:` override. Use the normal npm package spec when you want the npm path after ClawHub fallback:

    ```bash
    openclaw plugins install @myorg/openclaw-my-plugin
    ```

  </Tab>
</Tabs>

**In-repo plugins:** place under the bundled plugin workspace tree and they are automatically discovered during build.

**Users can install:**

```bash
openclaw plugins install <package-name>
```

<Info>
For npm-sourced installs, `openclaw plugins install` runs project-local `npm install --ignore-scripts` (no lifecycle scripts), ignoring inherited global npm install settings. Keep plugin dependency trees pure JS/TS and avoid packages that require `postinstall` builds.
</Info>

<Note>
Bundled OpenClaw-owned plugins are the only startup repair exception: when a packaged install sees one enabled by plugin config, legacy channel config, or its bundled default-enabled manifest, startup installs that plugin's missing runtime dependencies before import. Third-party plugins should not rely on startup installs; keep using the explicit plugin installer.
</Note>

## Related

- [Building plugins](/plugins/building-plugins) — step-by-step getting started guide
- [Plugin manifest](/plugins/manifest) — full manifest schema reference
- [SDK entry points](/plugins/sdk-entrypoints) — `definePluginEntry` and `defineChannelPluginEntry`
