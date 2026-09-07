---
summary: "Manifest dangerous-flag, SecretRef migration, and secret provider preset metadata"
read_when:
  - You need doctor to flag a dangerous config literal your plugin owns
  - You are migrating plugin config values to SecretRefs
  - You are publishing a reusable SecretRef exec provider preset
title: "Manifest config and secret fields"
sidebarTitle: "Config and secret fields"
---

Manifest fields that generic core config helpers read: dangerous-flag detection, SecretRef migration targets, legacy path narrowing, and secret provider presets. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

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

| Field                   | Required | Type       | What it means                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundledDefaultEnabled` | No       | `boolean`  | Override bundled-plugin default enablement when deciding whether this SecretRef surface is active. Use this when the plugin is bundled but the surface should stay inactive until explicitly enabled in config.                                                                                                                                               |
| `paths`                 | Yes      | `object[]` | Secret-shaped config paths, each with `path` (dot-separated, relative to `plugins.entries.<id>.config`, supports `*` wildcards), optional `expected` (currently only `"string"`), and optional `ownerKind` (`"capability"` or `"route"`). A declared owner isolates only that exact matched path when resolution fails; its owner id is the full config path. |

Capability owners fail cold when their provider is unavailable, so a stale credential never remains active. Route owners may retain the last-known-good value while their full plugin config and provider definition stay unchanged.

Declared paths also control Settings redaction, including wildcards and fields behind local schema references. Structured SecretRefs retain `source` and `provider` while `id` is concealed; plaintext secrets are fully concealed. Unrelated Settings saves preserve the original reference. Changing its source or provider requires an explicit identifier.

For plugins declaring `secretInputs`, `configSchema` validates the pre-resolution source config paired with the runtime config. A valid SecretRef is not rejected because its resolved credential is a string with a different shape. Invalid plaintext source values still fail validation. Runtime loading, CLI registration, and root command discovery use the same rule; plugins receive resolved values with defaults selected from the source config, without changing either input.

Concrete paths preserve literal record keys and array indices: `headers["X.Trace"]` remains distinct from `headers.X.Trace`, and record key `["0"]` remains distinct from array index `[0]`. Plugin IDs containing dots are quoted the same way, such as `plugins.entries["example.plugin"].config.headers["X.Trace"]`.

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

OpenClaw derives `trustedDirs` for manifest presets from the plugin root and, for `${node}` presets, the current Node executable directory. Manifest-authored `trustedDirs` are ignored. Other exec provider options such as `timeoutMs`, `noOutputTimeoutMs`, `maxOutputBytes`, `jsonOnly`, `env`, and `passEnv` pass through to the normal SecretRef exec provider config.
