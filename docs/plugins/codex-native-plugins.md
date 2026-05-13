---
summary: "Configure migrated native Codex plugins for Codex-mode OpenClaw agents"
title: "Native Codex plugins"
read_when:
  - You want Codex-mode OpenClaw agents to use native Codex plugins
  - You are migrating source-installed openai-curated Codex plugins
  - You are troubleshooting codexPlugins, app inventory, destructive actions, or plugin app diagnostics
---

Native Codex plugin support lets a Codex-mode OpenClaw agent use Codex
app-server's own app and plugin capabilities inside the same Codex thread that
handles the OpenClaw turn.

OpenClaw does not translate Codex plugins into synthetic `codex_plugin_*`
OpenClaw dynamic tools. Plugin calls stay in the native Codex transcript, and
Codex app-server owns the app-backed MCP execution.

Use this page after the base [Codex harness](/plugins/codex-harness) is working.

## Requirements

- The selected OpenClaw agent runtime must be the native Codex harness.
- `plugins.entries.codex.enabled` must be true.
- `plugins.entries.codex.config.codexPlugins.enabled` must be true.
- V1 supports only `openai-curated` plugins that migration observed as
  source-installed in the source Codex home.
- The target Codex app-server must be able to see the expected marketplace,
  plugin, and app inventory.

`codexPlugins` has no effect on PI runs, normal OpenAI provider runs, ACP
conversation bindings, or other harnesses because those paths do not create
Codex app-server threads with native `apps` config.

## Quickstart

Preview migration from the source Codex home:

```bash
openclaw migrate codex --dry-run
```

Use strict source app verification when you want migration to check source app
accessibility before planning native plugin activation:

```bash
openclaw migrate codex --dry-run --verify-plugin-apps
```

Apply the migration when the plan looks right:

```bash
openclaw migrate apply codex --yes
```

Migration writes explicit `codexPlugins` entries for eligible plugins and calls
Codex app-server `plugin/install` for selected plugins. A typical migrated
config looks like this:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    },
  },
}
```

After changing `codexPlugins`, use `/new`, `/reset`, or restart the gateway so
future Codex harness sessions start with the updated app set.

## How native plugin setup works

The integration has three separate states:

- Installed: Codex has the local plugin bundle in the target app-server runtime.
- Enabled: OpenClaw config is willing to make the plugin available to Codex
  harness turns.
- Accessible: Codex app-server confirms the plugin's app entries are available
  for the active account and can be mapped to the migrated plugin identity.

Migration is the durable install/eligibility step. During planning, OpenClaw
reads source Codex `plugin/read` details and checks that the source Codex
app-server account response is a ChatGPT subscription account. Non-ChatGPT or
missing account responses skip app-backed plugins with
`codex_subscription_required`. By default, migration does not call source
`app/list`; app-backed source plugins that pass the account gate are planned
without source app accessibility verification, and account lookup transport
failures skip with `codex_account_unavailable`. With `--verify-plugin-apps`,
migration takes a fresh source `app/list` snapshot and requires every owned app
to be present, enabled, and accessible before planning native activation. In
that mode, account lookup transport failures fall through to the source
app-inventory gate. Runtime app inventory is the target-session accessibility
check after migration. Codex harness session setup then computes a restrictive
thread app config for the enabled and accessible plugin apps.

Thread app config is computed when OpenClaw establishes a Codex harness session
or replaces a stale Codex thread binding. It is not recomputed on every turn.

## V1 support boundary

V1 is intentionally narrow:

- Only `openai-curated` plugins that were already installed in the source Codex
  app-server inventory are migration-eligible.
- App-backed source plugins must pass the migration-time subscription gate.
  `--verify-plugin-apps` adds the source app-inventory gate. Subscription-gated
  accounts plus, in verification mode, inaccessible, disabled, missing source
  apps or source app-inventory refresh failures are reported as skipped manual
  items instead of enabled config entries. Unreadable plugin details are skipped
  before the source app-inventory gate.
- Migration writes explicit plugin identities with `marketplaceName` and
  `pluginName`; it does not write local `marketplacePath` cache paths.
- `codexPlugins.enabled` is the global enablement switch.
- There is no `plugins["*"]` wildcard and no config key that grants arbitrary
  install authority.
- Unsupported marketplaces, cached plugin bundles, hooks, and Codex config files
  are preserved in the migration report for manual review.

## App inventory and ownership

OpenClaw reads Codex app inventory through app-server `app/list`, caches it for
one hour, and refreshes stale or missing entries asynchronously. The cache is
in memory only; restarting the CLI or gateway drops it, and OpenClaw rebuilds it
from the next `app/list` read.

Migration and runtime use separate cache keys:

- Source migration verification uses the source Codex home and source app-server
  start options. This runs only when `--verify-plugin-apps` is set, and it
  forces a fresh source `app/list` traversal for that planning run.
- Target runtime setup uses the target agent's Codex app-server identity when it
  builds the Codex thread app config. Plugin activation invalidates that target
  cache key and then force-refreshes it after `plugin/install`.

A plugin app is exposed only when OpenClaw can map it back to the migrated
plugin through stable ownership:

- exact app id from plugin detail
- known MCP server name
- unique stable metadata

Display-name-only or ambiguous ownership is excluded until the next inventory
refresh proves ownership.

## Thread app config

OpenClaw injects a restrictive `config.apps` patch for the Codex thread:
`_default` is disabled and only apps owned by enabled migrated plugins are
enabled.

OpenClaw sets app-level `destructive_enabled` from the effective global or
per-plugin `allow_destructive_actions` policy and lets Codex enforce
destructive tool metadata from its native app tool annotations. The `_default`
app config is disabled with `open_world_enabled: false`. Enabled plugin apps
are emitted with `open_world_enabled: true`; OpenClaw does not expose a separate
plugin open-world policy knob and does not maintain per-plugin destructive
tool-name deny lists.

Tool approval mode is automatic by default for plugin apps so non-destructive
read tools can run without a same-thread approval UI. Destructive tools remain
controlled by each app's `destructive_enabled` policy.

## Destructive action policy

Destructive plugin elicitations are allowed by default for migrated Codex
plugins, while unsafe schemas and ambiguous ownership still fail closed:

- Global `allow_destructive_actions` defaults to `true`.
- Per-plugin `allow_destructive_actions` overrides the global policy for that
  plugin.
- When policy is `false`, OpenClaw returns a deterministic decline.
- When policy is `true`, OpenClaw auto-accepts only safe schemas it can map to
  an approval response, such as a boolean approve field.
- Missing plugin identity, ambiguous ownership, a missing turn id, a wrong turn
  id, or an unsafe elicitation schema declines instead of prompting.

## Troubleshooting

**`auth_required`:** migration installed the plugin, but one of its apps still
needs authentication. The explicit plugin entry is written disabled until you
reauthorize and enable it.

**`app_inaccessible`, `app_disabled`, or `app_missing`:**
migration did not install the plugin because the source Codex app inventory did
not show all owned apps as present, enabled, and accessible while
`--verify-plugin-apps` was set. Reauthorize or enable the app in Codex, then
rerun migration with `--verify-plugin-apps`.

**`app_inventory_unavailable`:** migration did not install the plugin because
strict source app verification was requested and source Codex app inventory
refresh failed. Fix source Codex app-server access or retry without
`--verify-plugin-apps` if you accept the faster account-gated plan.

**`codex_subscription_required`:** migration did not install the app-backed
plugin because the source Codex app-server account was not logged in with a
ChatGPT subscription account. Log in to the Codex app with subscription auth,
then rerun migration.

**`codex_account_unavailable`:** migration did not install the app-backed plugin
because the source Codex app-server account could not be read. Fix source Codex
app-server auth or rerun with `--verify-plugin-apps` if you want source app
inventory to decide eligibility when account lookup fails.

**`marketplace_missing` or `plugin_missing`:** the target Codex app-server
cannot see the expected `openai-curated` marketplace or plugin. Rerun migration
against the target runtime or inspect Codex app-server plugin status.

**`app_inventory_missing` or `app_inventory_stale`:** app readiness came from an
empty or stale cache. OpenClaw schedules an async refresh and excludes plugin
apps until ownership and readiness are known.

**`app_ownership_ambiguous`:** app inventory only matched by display name, so
the app is not exposed to the Codex thread.

**Config changed but the agent cannot see the plugin:** use `/new`, `/reset`, or
restart the gateway. Existing Codex thread bindings keep the app config they
started with until OpenClaw establishes a new harness session or replaces a
stale binding.

**Destructive action is declined:** check the global and per-plugin
`allow_destructive_actions` values. Even when policy is true, unsafe elicitation
schemas and ambiguous plugin identity still fail closed.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Configuration reference](/gateway/configuration-reference#codex-harness-plugin-config)
- [Migrate CLI](/cli/migrate)
