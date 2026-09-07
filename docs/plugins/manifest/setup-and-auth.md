---
summary: "Manifest setup descriptors, auth choices, conversation discovery, and config UI hints"
read_when:
  - You are wiring a plugin into onboarding or provider setup
  - You need auth choices, CLI flags, or env vars read before runtime loads
  - You are labelling config fields for the setup and Control UI surfaces
title: "Manifest setup and auth fields"
sidebarTitle: "Setup and auth fields"
---

Manifest fields that setup, onboarding, and config UI surfaces read before plugin runtime loads. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## Native conversation discovery

Plugins exposing conversations created outside OpenClaw declare
`setup.nativeSessionCatalog` with a `label`, optional `description`, and optional
`nodeCommands` containing their catalog read/list/resume command names. The
contract uses the plugin's existing `config.sessionCatalog.enabled` preference.
Core checks this preference before registered catalog reads, lists, activity
checks, and the declared node commands execute. Schema-generated defaults for
`enabled` remain available in plugin-local configuration, but the root runtime
config retains only an authored value so a default cannot impersonate consent.

Declare commands that expose the native catalog, not independently authorized
execution transports. Disabling discovery must preserve turns in an already-bound
conversation; those turns retain their existing execution and node permissions.

New declarations default to off when no preference is authored, including plugins
installed after configuration creation. Their schemas should also default `enabled`
to `false`. New configuration files persist `false` for the host-generated catalog
inventory, including installable official plugins. Explicit values are always kept.
These opt-out-only entries do not request installation or widen a plugin allowlist;
an explicit plugin selection or other authored configuration still does.

The host-generated `legacyDefaultEnabled: true` declaration preserves the shipped
Claude/Codex implicit-on behavior only for existing readable configurations. It is
an upgrade exception, not a permission an installed third-party manifest can grant.
Future catalogs do not inherit that exception merely by joining the generated
inventory. Existing undeclared catalogs retain their previous behavior.

Onboarding offers an unchecked enablement choice when all declared catalogs are
off; selecting an agent does not imply consent. Explicit selection persists the
choice for installed declarations too. Detection itself writes no preferences.

Run `pnpm native-catalogs:gen` after changing these declarations and
`pnpm native-catalogs:check` to verify the official catalog metadata and packaged
macOS resource. The required `pnpm check` preflight runs this verification. Fresh native configuration creation fails if its privacy-default
resource is missing.

## providerAuthChoices reference

Each `providerAuthChoices` entry describes one onboarding or auth choice. OpenClaw reads this before provider runtime loads. Provider setup lists use these manifest choices, descriptor-derived setup choices, and install-catalog metadata without loading provider runtime.

| Field                  | Required | Type                                                                  | What it means                                                                                                                       |
| ---------------------- | -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `provider`             | Yes      | `string`                                                              | Provider id this choice belongs to.                                                                                                 |
| `method`               | Yes      | `string`                                                              | Auth method id to dispatch to.                                                                                                      |
| `choiceId`             | Yes      | `string`                                                              | Stable auth-choice id used by onboarding and CLI flows.                                                                             |
| `choiceLabel`          | No       | `string`                                                              | User-facing label. If omitted, OpenClaw falls back to `choiceId`.                                                                   |
| `choiceHint`           | No       | `string`                                                              | Short helper text for the picker.                                                                                                   |
| `icon`                 | No       | HTTPS URL                                                             | Artwork shown beside this choice in supported onboarding clients.                                                                   |
| `website`              | No       | HTTPS URL                                                             | Product, sign-in, or installation page shown by supported onboarding clients.                                                       |
| `assistantPriority`    | No       | `number`                                                              | Lower values sort earlier in assistant-driven interactive pickers.                                                                  |
| `assistantVisibility`  | No       | `"visible"` \| `"manual-only"`                                        | Hide the choice from assistant pickers while still allowing manual CLI selection.                                                   |
| `deprecatedChoiceIds`  | No       | `string[]`                                                            | Legacy choice ids that should redirect users to this replacement choice.                                                            |
| `groupId`              | No       | `string`                                                              | Optional group id for grouping related choices.                                                                                     |
| `groupLabel`           | No       | `string`                                                              | User-facing label for that group.                                                                                                   |
| `groupHint`            | No       | `string`                                                              | Short helper text for the group.                                                                                                    |
| `onboardingFeatured`   | No       | `boolean`                                                             | Surface this group in the featured tier of the interactive onboarding picker, before the "More..." entry.                           |
| `optionKey`            | No       | `string`                                                              | Internal option key for simple one-flag auth flows.                                                                                 |
| `cliFlag`              | No       | `string`                                                              | CLI flag name, such as `--openrouter-api-key`.                                                                                      |
| `cliOption`            | No       | `string`                                                              | Full CLI option shape, such as `--openrouter-api-key <key>`.                                                                        |
| `cliDescription`       | No       | `string`                                                              | Description used in CLI help.                                                                                                       |
| `personalAccount`      | No       | `boolean`                                                             | Offer this method in Connected accounts; it must stage one inline credential without importing host logins or writing shared state. |
| `appGuidedSecret`      | No       | `boolean`                                                             | One pasted secret plus provider defaults is sufficient for app-guided setup.                                                        |
| `appGuidedActionLabel` | No       | `string`                                                              | Short command label shown when starting provider-owned app-guided setup.                                                            |
| `appGuidedDiscovery`   | No       | `boolean`                                                             | The matching runtime auth method owns read-only local discovery through `appGuidedSetup`.                                           |
| `appGuidedAuth`        | No       | `"oauth"` \| `"device-code"`                                          | Provider-owned interactive login that native setup clients can render generically.                                                  |
| `onboardingScopes`     | No       | `Array<"text-inference" \| "image-generation" \| "music-generation">` | Which onboarding surfaces this choice should appear in. If omitted, it defaults to `["text-inference"]`.                            |

When `appGuidedDiscovery` is true, the matching provider auth method must expose
`appGuidedSetup.detect` and `appGuidedSetup.prepare`. Detection must be
read-only: no login, model pull, download, or config write. Preparation rechecks
the exact selected model and returns a config proposal; OpenClaw live-tests that
proposal in isolation and commits it only after success. A provider can also
expose `appGuidedSetup.detectAvailability` to mark its setup choice as detected
when the local service is reachable but no model qualifies for automatic setup.
The availability probe is also read-only.

When `personalAccount` is true, the method runs through the shared wizard protocol
with a credential-free environment/config, no agent directory or preseeded secret,
and plaintext input mode. It must return exactly one inline credential for its
provider and honor cancellation. It must not import a native CLI login, resolve a
SecretRef, write credentials/config, or require shared model activation. The
Gateway owns the private per-person commit; `configPatch`, `defaultModel`, and the
returned shared profile id are not applied. Mark credential prompts sensitive.
Use this capability only when the provider permits this credential use.

Personal-account calls always supply `ctx.assertCurrent`. Preserve this
closure-bound check through provider helpers and invoke it immediately before
external effects, including discovery, polling and token exchange after any
interactive or asynchronous wait. With `fetchWithSsrFGuard`, pass it as
`beforeRequest` so it runs after DNS/proxy preparation and on redirects. Keep
forwarding `ctx.signal` to cancel in-flight work; a signal alone does not recheck
the person's current permission. Standalone CLI/onboarding calls may omit the
check because they do not carry a Gateway person's authority.

An optional `matchesPersonalAccount(credential, existing)` auth-method hook can
prove that an OAuth reconnect is the same provider account. Match the complete
identity, not an email or a shared workspace alone. Without that proof, a new
OAuth account slot is created and old chat pins retain their original credential.
API keys and static tokens reuse a slot only when their literal value matches.

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

Without an explicit `openclaw.setupEntry`, OpenClaw resolves the conventional `setup-api` file at the package root or in package-local `dist/`. Standalone runtime builds include that public surface automatically.

OpenClaw includes `setup.providers[].envVars` in generic provider auth and env-var lookups. Put setup and status env metadata there.

Use `providerUsageAuthEnvVars` when a billing or organization-level credential must activate `resolveUsageAuth` without becoming an inference credential. These names join workspace dotenv blocking, ACP child-process stripping, sandbox secret filtering, and broad secret scrubbing. The provider runtime still reads and classifies the value inside `resolveUsageAuth`.

OpenClaw can also derive simple setup choices from `setup.providers[].authMethods` when no setup entry is available, or when `setup.requiresRuntime: false` declares setup runtime unnecessary. Explicit `providerAuthChoices` entries stay preferred for custom labels, CLI flags, onboarding scope, and assistant metadata.

Set `requiresRuntime: false` only when those descriptors are sufficient for the setup surface. OpenClaw treats explicit `false` as a descriptor-only contract and will not execute `setup-api` or `openclaw.setupEntry` for setup lookup. If a descriptor-only plugin still ships one of those setup runtime entries, OpenClaw reports an additive diagnostic and continues ignoring it. Omitted `requiresRuntime` keeps legacy fallback behavior so existing plugins that added descriptors without the flag do not break.

Because setup lookup can execute plugin-owned `setup-api` code, normalized `setup.providers[].id` and `setup.cliBackends[]` values must stay unique across discovered plugins. Ambiguous ownership fails closed instead of picking a winner from discovery order.

When setup runtime executes, setup registry diagnostics report providers or CLI backends that `setup-api` registers without matching manifest declarations. CLI backend descriptors also report a missing runtime registration because setup lookup needs the registered backend configuration. Provider descriptors may remain metadata-only even when the same setup module contributes migrations, CLI backends, probes, or selected provider runtimes.

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

| Field              | Required | Type       | What it means                                                                                                                                  |
| ------------------ | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`        | No       | `object[]` | Provider setup descriptors exposed during setup and onboarding.                                                                                |
| `cliBackends`      | No       | `string[]` | Setup-time backend ids used for descriptor-first setup lookup. Keep normalized ids globally unique.                                            |
| `configMigrations` | No       | `string[]` | Config migration ids owned by this plugin's setup surface.                                                                                     |
| `requiresRuntime`  | No       | `boolean`  | Whether setup still needs `setup-api` execution after descriptor lookup. Explicit `false` disables it; omission preserves the legacy fallback. |

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

| Field          | Type             | What it means                                                                                                     |
| -------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `label`        | `string`         | User-facing field label.                                                                                          |
| `help`         | `string`         | Short helper text.                                                                                                |
| `tags`         | `string[]`       | Optional UI tags.                                                                                                 |
| `advanced`     | `boolean`        | Marks the field as advanced.                                                                                      |
| `sensitive`    | `boolean`        | Marks the field as secret or sensitive.                                                                           |
| `placeholder`  | `string`         | Placeholder text for form inputs.                                                                                 |
| `presentation` | `"phone-number"` | Display-only localized phone formatting for parseable international (`+...`) values; raw values remain unchanged. |

Channel config sections inherit `help` for the leaves every channel shares
(`enabled`, `allowFrom`, `dmPolicy`, `groupPolicy`, `streaming`, and similar) at
the channel root and under `accounts.<id>`. A channel that declares its own
`help` for one of those keys always wins, so override it whenever the shared
wording is wrong for your provider. Provider-specific keys such as credentials,
hosts, and webhooks still need their own hints.

When multiple plugins declare the same channel, the selected plugin owns its
schema and presentation hints. Redaction preserves `sensitive: true` and
`tags: ["url-secret"]` declarations from every discovered owner, so credentials
left in config stay protected after switching plugins. The `url-secret` tag
protects credentials embedded in URLs while leaving public URLs visible.
Setting `sensitive: false` disables name-based secret detection, but does not
override another owner's positive declaration or URL credential protection.
