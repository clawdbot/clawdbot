---
summary: "Configure native Codex plugins for Codex-mode OpenClaw agents"
title: "Native Codex plugins"
read_when:
  - You want Codex-mode OpenClaw agents to use native Codex plugins
  - You are migrating source-installed openai-curated Codex plugins
  - You are configuring an existing workspace-directory Codex plugin
  - You are troubleshooting codexPlugins, app inventory, destructive actions, or plugin app diagnostics
---

Native Codex plugin support lets a Codex-mode OpenClaw agent use Codex
app-server's own app and plugin capabilities inside the same Codex thread that
handles the OpenClaw turn. Plugin calls stay in the native Codex transcript;
Codex app-server owns app-backed MCP execution. OpenClaw does not translate
Codex plugins into synthetic `codex_plugin_*` OpenClaw dynamic tools.

Use this page after the base [Codex harness](/plugins/codex-harness) is
working.

## Requirements

- The agent runtime must be the native Codex harness.
- `plugins.entries.codex.enabled` is `true`.
- `plugins.entries.codex.config.codexPlugins.enabled` is `true`.
- Codex app-server reports exactly stable `0.146.0`. The official plugin ships
  `@openai/codex` `0.146.0`; custom, remote, and macOS desktop-owned binaries
  must use the same exact version.
- The target Codex app-server can see the expected marketplace, plugin, and
  app inventory.
- Migration supports only `openai-curated` plugins that it observed as
  source-installed in the source Codex home. Codex serves the same catalog to
  API-key and Bedrock accounts under the `openai-api-curated` wire name;
  OpenClaw treats both names as the one curated catalog, so configured
  `openai-curated` plugins resolve from either.
- Manually configured `workspace-directory` plugins must already appear
  installed and enabled under their exact marketplace-qualified identity in
  `plugin/installed`. Their owned apps must be accessible and callable for the
  configured Codex thread.

`codexPlugins` has no effect on OpenClaw-provider runs, ACP conversation
bindings, or other harnesses, because those paths never create Codex
app-server threads with native `apps` config.

OpenAI-side Codex account, app availability, and workspace app/plugin controls
come from the signed-in Codex account. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
for the OpenAI account and admin model.

## Quickstart

Preview migration from the source Codex home:

```bash
openclaw migrate codex --dry-run
```

Add `--verify-plugin-apps` to make migration read the source installed app
snapshot and app metadata, requiring every owned app to be present, enabled,
and accessible before planning native activation:

```bash
openclaw migrate codex --dry-run --verify-plugin-apps
```

Apply the migration when the plan looks right:

```bash
openclaw migrate apply codex --yes
```

Migration writes explicit `codexPlugins` entries for eligible plugins and
calls Codex app-server `plugin/install` for selected plugins. A migrated
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

Migration remains limited to `openai-curated`. To use an existing
`workspace-directory` plugin, add it manually with the exact
marketplace-qualified `summary.id` returned by `plugin/installed`. For example,
if Codex returns `example-plugin@workspace-directory`, configure that complete
value instead of its display name:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            plugins: {
              "example-plugin": {
                enabled: true,
                marketplaceName: "workspace-directory",
                pluginName: "example-plugin@workspace-directory",
              },
            },
          },
        },
      },
    },
  },
}
```

OpenClaw does not call `plugin/install` or start authentication for a
`workspace-directory` plugin. Install, enable, and authenticate it in Codex
before adding or enabling the OpenClaw policy. OpenClaw keeps apps hidden when
the response omits the exact marketplace, plugin ID, detail ID, or app-readiness
evidence. If the installed snapshot omits the workspace marketplace, OpenClaw
reports `marketplace_missing` for each enabled workspace plugin and keeps any
independently discovered curated plugins available.

After a `codexPlugins` change, new Codex conversations pick up the updated
app set automatically. Run `/new` or `/reset` to refresh the current
conversation. A gateway restart is not required for plugin enable/disable
changes.

## Manage plugins from chat

`/codex plugins` inspects or changes configured native Codex plugins from the
same chat where you operate the Codex harness:

```text
/codex plugins
/codex plugins list
/codex plugins disable google-calendar
/codex plugins enable google-calendar
```

`/codex plugins` is an alias for `/codex plugins list`. The list shows each
configured plugin's key, on/off state, Codex plugin name, and marketplace
from `plugins.entries.codex.config.codexPlugins.plugins`.

`enable`/`disable` write only to `~/.openclaw/openclaw.json`; they never edit
`~/.codex/config.toml` or install new Codex plugins. Only the owner or a
gateway client with the `operator.admin` scope can run them.

Enabling a configured plugin also turns on the global `codexPlugins.enabled`
switch. If a curated plugin was written disabled because migration returned
`auth_required`, reauthorize the app in Codex before enabling it in OpenClaw.
For a `workspace-directory` entry, enabling it here changes only OpenClaw
policy; the plugin and app must already be active in Codex.

## How native plugin setup works

The integration tracks three states:

| State      | Meaning                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Installed  | Codex has the plugin bundle in the target app-server runtime.                                                                      |
| Enabled    | Codex reports the plugin enabled, and OpenClaw config allows it for Codex harness turns.                                           |
| Accessible | Codex app-server confirms the plugin's app entries are available for the active account and map to the configured plugin identity. |

For `openai-curated` plugins, migration is the durable install/eligibility
step:

- During planning, OpenClaw reads source Codex `plugin/read` details and
  checks the source Codex app-server account. `codex_subscription_required`
  means `account/read` positively identified an API-key or other
  non-ChatGPT account; a missing account is not evidence that a subscription
  is absent.
- By default, migration skips source app inventory calls: app-backed source
  plugins that pass the account gate are planned without source app
  accessibility verification. A missing account or failed `account/read`
  skips them with `codex_account_unavailable`.
- With `--verify-plugin-apps`, migration takes a fresh source `app/installed`
  snapshot, fetches authenticated metadata with `app/read`, and requires every
  owned app to be present, enabled, and accessible in the source Codex account
  before planning native activation. If `account/read` is missing or fails,
  strict verification can still prove access through the source app-server's
  configured bearer or header authentication. A positively identified
  non-ChatGPT account remains ineligible.

For `workspace-directory` plugins, setup happens outside OpenClaw. OpenClaw
uses its `plugin/installed` snapshot only for explicitly configured enabled
entries, or when `allow_all_plugins` requires identifying apps owned by an
explicitly configured disabled workspace plugin. It resolves each plugin by
exact `summary.id` and uses `plugin/read` for ownership. The disabled-plugin
check is read-only: its apps stay denied, and OpenClaw does not install,
enable, or authenticate the plugin. Missing or ambiguous ownership fails
closed instead of granting account-wide access.

Runtime app inventory is the target-session accessibility check for both
migrated curated plugins and manually configured workspace plugins. Codex
harness session setup computes a restrictive thread app config from the enabled
and accessible plugin apps; it is not recomputed on every turn, so
`/codex plugins enable`/`disable` only affect
new Codex conversations. Use `/new` or `/reset` to pick up the change in the
current conversation.

## V1 support boundary

- Only `openai-curated` plugins already installed in the source Codex
  app-server inventory are migration-eligible.
- Runtime also supports explicit `workspace-directory` entries reported by
  `plugin/installed`. These entries must use their exact
  marketplace-qualified `summary.id` and must already be installed, enabled,
  and app-accessible. A missing marketplace, plugin, ownership detail, or app
  readiness evidence exposes no workspace app. OpenClaw never scans the
  marketplace catalog to discover or activate a workspace plugin.
- Positively identified non-ChatGPT source accounts fail the subscription gate.
  Missing or unreadable source accounts are unavailable by default.
  `--verify-plugin-apps` can instead establish access through authenticated
  source app inventory, including bearer- or header-authenticated app-servers.
  Inaccessible, disabled, or missing source apps and inventory refresh failures
  remain skipped manual items. Unreadable plugin details are skipped before the
  app-inventory gate.
- Migration writes explicit plugin identities (`marketplaceName` and
  `pluginName`); it does not write local `marketplacePath` cache paths.
- `codexPlugins.enabled` is the only global enablement switch; there is no
  `plugins["*"]` wildcard or config key that grants arbitrary install
  authority.
- Non-curated marketplaces, cached plugin bundles, hooks, and Codex config
  files are preserved in the migration report for manual review, not activated
  automatically. Runtime accepts manually configured `workspace-directory`
  entries; other marketplaces remain unsupported.

## App inventory and ownership

OpenClaw first reads and caches one `plugin/installed` snapshot scoped to the
target Codex app-server and configured workspace. That snapshot covers
installed curated and workspace plugins, including disabled plugin identities;
failed or incomplete snapshots are never cached. `plugin/read` is limited to
the exact configured plugin details required to establish ownership. Routine
thread setup never scans the marketplace catalog. `plugin/list` runs only to
find or repair an explicitly enabled missing curated plugin, and
`plugin/install` runs only for that explicitly configured curated plugin.

OpenClaw reads installed app runtime state through `app/installed` and fetches
canonical app metadata with `app/read` in batches of at most 100 app IDs. The
first read force-refreshes a cold installed runtime snapshot. When multiple
configured curated plugins are installed, OpenClaw combines their cache
invalidations into a single app-inventory refresh. Ordinary cached reads do
not force a connector refresh for every new thread. OpenClaw caches the
combined inventory in memory for one hour and refreshes stale or missing
entries asynchronously. The cache is process-local; restarting the CLI or
gateway drops it.

Missing inventory methods, authentication errors, transport failures, and
connector refresh failures fail closed.

Migration and runtime use separate cache keys:

- Source migration verification uses the source Codex home and start
  options. It runs only with `--verify-plugin-apps` and forces a fresh
  source runtime snapshot and metadata read for that planning run.
- Target runtime setup uses the target agent's Codex app-server identity when
  building and verifying the thread app config. Curated plugin activation
  invalidates that target cache key, then force-refreshes it after
  `plugin/install`. `workspace-directory` setup never runs this activation path.

A plugin app is exposed only when OpenClaw can map it back to the configured
plugin through stable ownership: an exact app id from plugin detail, a known
MCP server name, or unique stable metadata. Display-name-only or ambiguous
ownership is excluded until the next inventory refresh proves ownership.

## Connected account apps

Owner-operated agents can opt into every app already connected to their Codex
account without requiring a matching plugin package:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_all_plugins: true,
            allow_destructive_actions: "auto",
          },
        },
      },
    },
  },
}
```

`allow_all_plugins: true` reads the installed app snapshot and authenticated
metadata when a new native Codex thread is established. It admits only
account-accessible apps. Codex must also confirm each admitted app is enabled
and callable for that thread. OpenClaw does not install, authenticate, or enable
apps globally. Existing threads keep their persisted app set; use `/new`,
`/reset`, or restart the gateway to pick up newly connected or revoked apps.

An explicitly disabled configured plugin always overrides account-wide app
access. Because Codex `app/read` omits a disabled workspace plugin's display
names, OpenClaw uses its `plugin/installed` snapshot and reads only that exact
configured plugin's details to reserve its owned app IDs. This narrow,
read-only check does not discover unrelated marketplaces, activate the plugin,
or grant its apps. If the disabled plugin's ownership cannot be established,
the account-wide app selection fails closed.

Account apps inherit the global `codexPlugins.allow_destructive_actions` value,
which accepts `true`, `false`, `"auto"`, or `"ask"`. Explicit per-plugin policy
overrides the global policy for overlapping app ids. Inventory failures fail
closed instead of falling back to an unrestricted default.

## Thread app config

OpenClaw injects a restrictive `config.apps` patch for the Codex thread:
`_default` is disabled, and only apps owned by enabled configured plugins or
accessible account apps admitted by `allow_all_plugins` are enabled.

An app can be installed and authenticated but non-callable in the account-wide
snapshot while `_default` is disabled. OpenClaw provisionally admits only
ownership-proven, policy-allowed apps, creates the restrictive thread, and then
rereads `app/installed` once with the resulting thread ID and
`forceRefresh: false`. Codex must confirm each admitted app is enabled and
callable under the thread's effective app, managed, workspace, and tool
policies before the turn proceeds. If that attestation fails, the provisional
thread is never bound or used. OpenClaw deletes a failed persistent provisional
thread, unsubscribes a failed ephemeral thread, and retires the app-server
connection if safe cleanup cannot be confirmed.

`destructive_enabled` on each app comes from the effective global or
per-plugin `allow_destructive_actions` policy; `true`, `"auto"`, and `"ask"`
all set `destructive_enabled: true`, and `false` sets it `false`. Codex still
enforces destructive tool metadata from its native app tool annotations.
`_default` is disabled with `open_world_enabled: false`; enabled plugin apps
get `open_world_enabled: true`. OpenClaw does not expose a separate
plugin-level open-world policy knob and does not maintain per-plugin
destructive tool-name deny lists.

Tool approval mode defaults to automatic for admitted apps, so non-destructive
read tools run without a same-thread approval prompt. Destructive tools stay
controlled by each app's `destructive_enabled` policy.

## Destructive action policy

Destructive plugin elicitations are allowed by default for configured Codex
plugins, while unsafe schemas and ambiguous ownership fail closed:

- Global `allow_destructive_actions` defaults to `true`.
- Per-plugin `allow_destructive_actions` overrides the global policy for
  that plugin.
- `false`: OpenClaw returns a deterministic decline.
- `true`: OpenClaw auto-accepts only safe schemas it can map to an approval
  response, such as a boolean approve field.
- `"auto"`: OpenClaw exposes destructive plugin actions to Codex, then
  turns ownership-proven MCP approval elicitations into OpenClaw plugin
  approvals before returning the Codex approval response.
- `"ask"`: OpenClaw uses the same Codex write/destructive gating as
  `"auto"`, clears durable Codex per-tool approval overrides for the app
  before the thread starts, and offers only one-shot approval or denial so
  durable approvals cannot suppress later write-action prompts. For each
  admitted app using `"ask"`, OpenClaw selects Codex's human approvals
  reviewer for that app so Codex sends its approval elicitations to
  OpenClaw; other apps and non-app thread approvals keep their configured
  reviewer and policy.
- Missing plugin identity, ambiguous ownership, a missing or mismatched
  turn id, or an unsafe elicitation schema declines instead of prompting.

## Troubleshooting

| Code                                              | Meaning                                                                                                                              | Fix                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `auth_required`                                   | Migration installed the plugin, but one of its apps still needs authentication. The entry is written disabled until you reauthorize. | Reauthorize the app in Codex, then enable the plugin in OpenClaw.                                                      |
| `app_inaccessible`, `app_disabled`, `app_missing` | With `--verify-plugin-apps`, the source Codex app inventory did not show all owned apps as present, enabled, and accessible.         | Reauthorize or enable the app in Codex, then rerun migration with `--verify-plugin-apps`.                              |
| `app_inventory_unavailable`                       | Strict source app verification was requested but the source Codex app inventory refresh failed.                                      | Fix source Codex app-server access, or retry without `--verify-plugin-apps` to accept the faster account-gated plan.   |
| `codex_subscription_required`                     | The source app-server positively identified an API-key or other non-ChatGPT account.                                                 | Log in to the Codex app with subscription auth, then rerun migration.                                                  |
| `codex_account_unavailable`                       | The source account was missing or `account/read` failed without strict app verification.                                             | Restore source account access, or use `--verify-plugin-apps` when authenticated source app inventory can prove access. |
| `marketplace_missing`, `plugin_missing`           | The exact marketplace or configured plugin is unavailable in the installed snapshot; workspace apps fail closed.                     | Verify the target app-server's `plugin/installed` response and exact configured plugin identity.                       |
| `plugin_detail_unavailable`                       | OpenClaw could not read the exact configured plugin's ownership details.                                                             | Inspect the target app-server's `plugin/installed` and `plugin/read` responses.                                        |
| `plugin_disabled`                                 | Codex reports the plugin installed but disabled.                                                                                     | Curated activation may repair it; enable a workspace plugin in Codex before retrying.                                  |
| `plugin_activation_failed`                        | Plugin activation did not complete.                                                                                                  | Use the attached diagnostic to distinguish marketplace, auth, refresh, or workspace-readiness failures.                |
| `app_inventory_missing`, `app_inventory_stale`    | App readiness came from an empty or stale cache.                                                                                     | OpenClaw schedules an async refresh automatically; plugin apps stay excluded until ownership and readiness are known.  |
| `app_ownership_ambiguous`                         | App inventory only matched by display name.                                                                                          | The app stays hidden from the Codex thread until a later refresh proves ownership.                                     |

**Workspace plugin is installed but not visible:** confirm the workspace
`plugin/installed` snapshot reports the exact configured ID as installed and
enabled, then confirm `app/installed` returns every owned app for the same
Codex account and `app/read` returns its metadata. An app disabled only by the
account-wide default can become callable after OpenClaw starts and verifies
its explicitly configured thread. Revoked auth, missing metadata, disabled
workspace plugins, and Codex managed or workspace restrictions still block
access. Reauthorize or repair those upstream conditions before starting a new
thread. If you changed that state after the gateway cached app inventory, wait
for the one-hour cache refresh or restart the gateway, then use `/new` or
`/reset`. OpenClaw does not repair or authenticate workspace plugins.

For `plugin_detail_unavailable`, verify that the exact installed marketplace
and plugin identity select a matching `plugin/read` result. OpenClaw keeps
owned apps hidden when that selector or ownership detail is unavailable. For
`plugin_activation_failed`, curated plugins may report a marketplace, auth, or
post-install refresh failure. A workspace plugin reports this code when it is
not already active; install, enable, and authenticate it outside OpenClaw.

**Config changed but the agent cannot see the plugin:** run `/codex plugins
list` to confirm the configured state, then `/new` or `/reset`. Existing
Codex thread bindings keep the app config they started with until OpenClaw
establishes a new harness session or replaces a stale binding.

**Destructive action is declined:** check the global and per-plugin
`allow_destructive_actions` values. Even with `true`, `"auto"`, or `"ask"`,
unsafe elicitation schemas and ambiguous plugin identity still fail closed.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Configuration reference](/gateway/configuration-reference#codex-harness-plugin-config)
- [Migrate CLI](/cli/migrate)
