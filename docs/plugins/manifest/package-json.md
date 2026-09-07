---
summary: "Which pre-runtime metadata lives in package.json, and which duplicate plugin id wins"
read_when:
  - You are unsure whether metadata belongs in the manifest or package.json
  - You are declaring entrypoints, install hints, or channel catalog metadata
  - Two plugin roots share an id and you need to know which one loads
title: "Manifest versus package.json"
sidebarTitle: "Manifest vs package.json"
---

Where pre-runtime plugin metadata lives when it is not in the manifest, and how OpenClaw picks one manifest when two plugin roots share an id. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

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
| `openclaw.setupEntry`                                                                      | Lightweight setup-only entrypoint used during onboarding, channel setup, and read-only channel status/SecretRef discovery. Must stay inside the plugin package directory.                 |
| `openclaw.runtimeSetupEntry`                                                               | Declares the built JavaScript setup entrypoint for installed packages. Requires `setupEntry`, must exist, and must stay inside the plugin package directory.                              |
| `openclaw.channel`                                                                         | Cheap channel catalog metadata like labels, docs paths, aliases, and selection copy.                                                                                                      |
| `openclaw.channel.approvalFlags`                                                           | Closed approval behavior flags available before runtime load. `native` means the channel owns native approval UI and same-turn resolution.                                                |
| `openclaw.channel.commands`                                                                | Static native command and native skill auto-default metadata used by config, audit, and command-list surfaces before channel runtime loads.                                               |
| `openclaw.channel.cliAddOptions`                                                           | Plugin-owned `openclaw channels add` options. Each entry declares `flags`, `description`, optional `defaultValue`, and optional `valueType` (`int` or `list`) for generic input coercion. |
| `openclaw.channel.configuredState`                                                         | Lightweight configured-state checker metadata that can answer "does env-only setup already exist?" without loading the full channel runtime.                                              |
| `openclaw.channel.persistedAuthState`                                                      | Lightweight persisted-auth checker metadata that can answer "is anything already signed in?" without loading the full channel runtime.                                                    |
| `openclaw.install.clawhubSpec` / `openclaw.install.npmSpec` / `openclaw.install.localPath` | Install/update hints for bundled and externally published plugins.                                                                                                                        |
| `openclaw.install.defaultChoice`                                                           | Install-path hint, including local checkout selection. Default remote requests prefer declared npm, then ClawHub; explicit source choices remain authoritative.                           |
| `openclaw.install.minHostVersion`                                                          | Minimum supported OpenClaw host version, using a semver floor like `>=2026.3.22` or `>=2026.5.1-beta.1`.                                                                                  |
| `openclaw.compat.pluginApi`                                                                | Minimum OpenClaw plugin API range required by this package, using a semver floor like `>=2026.5.27`.                                                                                      |
| `openclaw.install.expectedIntegrity`                                                       | Expected npm dist integrity string such as `sha512-...`; install and update flows verify the fetched artifact against it.                                                                 |
| `openclaw.install.allowInvalidConfigRecovery`                                              | Allows a narrow bundled-plugin reinstall recovery path when config is invalid.                                                                                                            |
| `openclaw.install.requiredPlatformPackages`                                                | npm package aliases that must materialize when their lockfile platform constraints match the current host.                                                                                |

Manifest metadata decides which provider/channel/setup choices appear in onboarding before runtime loads. `package.json#openclaw.install` tells onboarding how to fetch or enable that plugin when the user picks one of those choices. Do not move install hints into `openclaw.plugin.json`.

Configured startup plugins register HTTP routes from their full runtime after the Gateway starts listening. Until startup sidecars are ready, an otherwise-unclaimed HTTP request returns `503` with `Retry-After: 1`; core routes remain available throughout startup.

For `openclaw.channel.cliAddOptions`, use Commander's long-option syntax, such as `--initial-sync-limit <n>`. Set `valueType: "int"` to parse a non-negative integer or `valueType: "list"` to split comma-, semicolon-, or newline-delimited input into strings before the plugin setup adapter receives it. Omit `valueType` to pass the parsed Commander value through unchanged.

`openclaw.install.minHostVersion` is enforced during install and manifest registry loading for non-bundled plugin sources. Invalid values are rejected; newer-but-valid values skip external plugins on older hosts. Bundled source plugins are assumed to be co-versioned with the host checkout.

`openclaw.install.requiredPlatformPackages` is for npm packages that expose required native binaries through optional, platform-specific aliases. List the bare npm package name for every supported platform alias. During npm install, OpenClaw verifies only the declared alias whose lockfile constraints match the current host. If npm reports success but omits that alias, OpenClaw retries once with a fresh cache and rolls back the install if the alias is still missing.

`openclaw.compat.pluginApi` is enforced during package install for non-bundled plugin sources. Use it for the OpenClaw plugin SDK/runtime API floor that the package was built against. It can be stricter than `minHostVersion` when a plugin package needs a newer API but still keeps a lower install hint for other flows. Official OpenClaw release sync bumps existing official plugin API floors to the OpenClaw release version by default, but plugin-only releases can keep a lower floor when the package intentionally supports older hosts. Do not use the package version alone as the compatibility contract. `peerDependencies.openclaw` remains npm package metadata; OpenClaw uses the `openclaw.compat.pluginApi` contract for install compatibility decisions.

Official install-on-demand metadata should declare `npmSpec` as the default and `clawhubSpec` as the secondary source when both publish the same plugin. Default remote installs try npm first, then the declared ClawHub source only when the npm target is unavailable. A ClawHub-only plugin stays on ClawHub; OpenClaw never derives an npm package name from a ClawHub slug. Explicit source selections, exact versions, and non-`latest` tags remain authoritative. Doctor's existing stale runtime repair can refresh an official plugin bound to the current OpenClaw release cohort on its recorded registry, retaining exact npm pin intent by recording the replacement version. Bare specs and `@latest` follow the active release-channel policy while retaining the requested selector in the install record. Integrity, compatibility, trust, install-policy, and capability-consent failures do not authorize switching sources.

Exact npm version pinning already lives in `npmSpec`, for example `"npmSpec": "@wecom/wecom-openclaw-plugin@1.2.3"`. Official external catalog entries should pair exact specs with `expectedIntegrity` so update flows fail closed if the fetched npm artifact no longer matches the pinned release. Interactive onboarding still offers trusted registry npm specs, including bare package names and dist-tags, for compatibility. Catalog diagnostics can distinguish exact, floating, integrity-pinned, missing-integrity, package-name mismatch, and invalid default-choice sources. They also warn when `expectedIntegrity` is present but there is no valid npm source it can pin. When `expectedIntegrity` is present, install/update flows enforce it; when it is omitted, the registry resolution is recorded without an integrity pin.

Channel plugins should provide `openclaw.setupEntry` when status, channel list, or SecretRef scans need to identify configured accounts without loading the full runtime. The setup entry should expose channel metadata plus setup-safe config, status, and secrets adapters; keep network clients, gateway listeners, and transport runtimes in the main extension entrypoint.

Before the first setup-entry load, OpenClaw applies the selected plugin root's file-boundary and hardlink policy, even when discovery metadata is already cached. Validated setup modules remain cached for that plugin cache generation; this check does not rediscover metadata on each status call.

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

Use `env.allOf` when every listed variable is required and `env.anyOf` when any one non-empty variable is enough. If a tiny non-runtime check needs more than environment metadata, use `specifier` plus `exportName` as shown for `persistedAuthState`. A complete, non-empty `specifier` and `exportName` pair takes precedence over `env`. If either field is absent or blank, the probe uses its `env` metadata without loading a module. If the check needs full config resolution or the real channel runtime, keep that logic in the plugin `config.hasConfiguredState` hook instead.

For both state probes, OpenClaw builds rewrite source specifiers only for complete module pairs, naming the exact emitted JavaScript artifact, including its `.js` or `.cjs` extension. Env-backed incomplete pairs are preserved unchanged. Built checkout metadata uses paths relative to the plugin root; standalone packages use the plugin-local `dist/` directory.

## Discovery precedence (duplicate plugin ids)

OpenClaw discovers plugins from explicit `plugins.load.paths` entries, the current workspace root (`<workspace>/.openclaw/extensions`), bundled plugins shipped with OpenClaw, and global install locations (`~/.openclaw/extensions` plus tracked install paths). Discovery order alone does not determine which copy loads.

If two distinct plugin roots share the same `id`, only the **highest-precedence** manifest is kept; lower-precedence duplicates are dropped instead of loading beside it. Precedence, highest to lowest:

1. **Config-selected** — a path explicitly selected in `plugins.load.paths`
2. **Development-source bundled** — a bundled plugin inside the checkout selected by `OPENCLAW_DEV_SOURCE_ROOT`
3. **Global install matching a tracked install record** — an installed global candidate whose path matches its install record, managed by `openclaw plugins install`/`openclaw plugins update`
4. **Bundled** — other plugins shipped with OpenClaw
5. **Workspace** — plugins discovered relative to the current workspace
6. **Untracked global** — other plugins discovered in the global root

Implications:

- An auto-discovered workspace or untracked global copy will not shadow a bundled plugin, even when its id is enabled or allowlisted. `plugins.allow` and `plugins.entries.<id>.enabled` control load permission, not source selection.
- To override a bundled plugin intentionally, select its path via `plugins.load.paths`. A tracked global install can also override an ordinary bundled copy, but not a development-source bundled copy.
- Duplicate warnings identify the discarded copy and selected source, with config-selected winners labeled as explicit overrides. Intentional tracked-install overrides of ordinary bundled copies do not emit duplicate warnings.
