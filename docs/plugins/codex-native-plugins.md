---
summary: "Configure native Codex plugins for Codex-mode OpenClaw agents"
title: "Native Codex plugins"
read_when:
  - You want Codex-mode OpenClaw agents to use native Codex plugins
  - You are migrating source-installed openai-curated Codex plugins
  - You are discovering or installing a Codex marketplace plugin
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
- Codex app-server reports `0.149.0` or newer. The official plugin ships
  `@openai/codex` `0.150.1`; newer custom, remote, and macOS desktop-owned
  binaries continue with a compatibility warning and normal runtime validation.
- The target Codex app-server can see the expected marketplace, plugin, and
  app inventory.
- Migration supports only `openai-curated` plugins that it observed as
  source-installed in the source Codex home. Codex serves the same catalog to
  API-key and Bedrock accounts under the `openai-api-curated` wire name;
  OpenClaw treats both names as the one curated catalog, so configured
  `openai-curated` plugins resolve from either.
- Native runtime support also includes other marketplaces already available to
  Codex, such as `openai-bundled`, `openai-primary-runtime`,
  `workspace-directory`, and marketplace manifests in the current repository.
  Plugins remain unavailable until an owner or `operator.admin` explicitly
  installs or enables their marketplace-qualified identity.

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

Migration remains limited to `openai-curated`. To find another plugin that
Codex can already see, list the available marketplace catalog and install the
exact marketplace-qualified identity:

```text
/codex plugins available
/codex plugins install security-review@company-tools
```

Codex discovers repository marketplaces from
`.agents/plugins/marketplace.json` in the current conversation workspace. An
owner does not need to add that marketplace to OpenClaw configuration before
listing or installing its plugins. Official bundled, primary-runtime, curated,
workspace, shared, and personal marketplaces depend on the signed-in Codex
account and upstream feature or administrator policies.
When Codex requires marketplace sources to be explicitly configured or
allowlisted, those requirements still apply; OpenClaw does not bypass them.

Installation writes an explicit configuration entry such as:

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
              "security-review@company-tools": {
                enabled: true,
                marketplaceName: "company-tools",
                pluginName: "security-review",
              },
            },
          },
        },
      },
    },
  },
}
```

The install command checks the authenticated owner or administrator before it
calls Codex `plugin/install`. Codex continues to enforce marketplace source,
workspace administrator, account, and connector-authentication policies.
Remote plugins that require a Codex installation interstitial, or do not
report whether one is required, must be installed in Codex first; rerun the
OpenClaw install command afterward to authorize the already-installed plugin.
OpenClaw keeps apps hidden when the response omits the exact marketplace,
plugin identity, detail identity, or app-readiness evidence. If a connector
requires additional sign-in, complete that authorization before expecting the
plugin's tools to become available.

When installation returns apps that still need sign-in, OpenClaw provides
**Set up / manage** links to the app pages returned by Codex. Sign in with the
same ChatGPT account and workspace used by the Codex harness. Opening a link
does not verify the connection or make its tools callable in the current
conversation. If the browser shows a directory instead of the app, or no safe
link is available, run `/apps` in Codex CLI and select the app there. Responses
show up to five app links and explicitly report additional apps to review in
Codex CLI.

After a `codexPlugins` change, new Codex conversations pick up the updated
app set automatically. Run `/new` or `/reset` to refresh the current
conversation. A gateway restart is not required for plugin enable/disable
changes.

## Scheduled automations

When an authenticated owner creates an automation from a Codex turn, OpenClaw
captures the app IDs and approval limits callable on that exact Codex thread.
The stored authority is bound to the creator's prepared Codex profile and
account. Scheduled runs intersect that cap with current Codex policy and app
availability. They never gain new app IDs or a broader destructive,
open-world, or approval ceiling. Tools added later within an already captured
app may run only when both the stored ceiling and current policy allow them.

Scheduled app calls are unattended. Only actions explicitly allowed both when
the job was created and when it runs can proceed without a prompt. An action
that still requires approval or elicitation is declined. A changed account,
runtime, revoked app, narrower policy, or unavailable inventory stops before
app execution and reports how to restore access or reauthorize the automation.
Model fallbacks cannot move this authority to another runtime or account.

Jobs created before app authority capture may keep their ordinary OpenClaw
tool cap and continue non-app work, but cannot recover Codex app access
automatically. Recreate or reauthorize only a job that needs app access, from a
fresh authenticated owner turn. See
[Automations](/automation/cron-jobs#codex-apps-in-scheduled-automations).
Ordinary edits preserve captured app authority. Explicitly replacing a job's
`toolsAllow` cap without a fresh authenticated Codex authority capture clears
that authority; the next run reports that app access requires reauthorization.
An update from a fresh authenticated owner turn can instead capture and store a
new app ceiling for the updated job.

## Manage plugins from chat

`/codex plugins` inspects or changes configured native Codex plugins from the
same chat where you operate the Codex harness:

```text
/codex plugins
/codex plugins list
/codex plugins available
/codex plugins install security-review@company-tools
/codex plugins disable google-calendar
/codex plugins enable google-calendar
/codex plugins disable security-review@company-tools
```

`/codex plugins` is an alias for `/codex plugins list`. The list shows each
configured plugin's key, on/off state, Codex plugin name, and marketplace
from `plugins.entries.codex.config.codexPlugins.plugins`.

`available` reads Codex's marketplace catalog using the bound workspace, so it
can discover repository-local plugins without enabling them. The owner-scoped
`codex_plugins` model tool is also read-only: it can recommend an exact install
command but cannot install, enable, or add a marketplace.

`install`, `enable`, and `disable` require the owner or a gateway client with
the `operator.admin` scope. OpenClaw's reserved `/codex` command is dispatched
before agent invocation, so a model-generated recommendation does not count as
installation approval. For a plugin that Codex has not installed yet, `install`
calls the Codex app-server and records the explicit plugin policy only after
installation succeeds. If Codex confirms that the plugin is already installed
and enabled, the same command records its authorization without installing it
again. `enable` and `disable` change OpenClaw's persisted policy; qualified
identities and existing configuration keys are both accepted.

Installing or enabling a configured plugin also turns on the global
`codexPlugins.enabled` switch without enabling `allow_all_plugins`. If a plugin
reports `auth_required`, authorize the app in Codex before starting a new
conversation. Authorization remains in effect for later conversations until
the plugin is disabled or the upstream account or workspace revokes access.

Only install plugins you trust. A Codex plugin can contribute skills, apps,
MCP servers, and hooks. Some hooks can participate in permission decisions,
so explicit installation trusts the selected plugin's code; it is not a
security review or an isolation boundary.

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

For explicitly approved plugins from any discovered marketplace, OpenClaw uses
its `plugin/installed` snapshot and `plugin/read` details to establish the
exact marketplace-qualified identity and app ownership. The installed-only
check during ordinary thread setup is read-only; apps from disabled or
unapproved plugins stay denied. Owner-issued installation is the explicit
mutation path. Missing or ambiguous ownership fails closed instead of granting
account-wide access.

Runtime app inventory is the target-session accessibility check for both
migrated curated plugins and manually configured workspace plugins. Codex
harness session setup computes a restrictive thread app config from the enabled
and accessible plugin apps; it is not recomputed on every turn, so
`/codex plugins enable`/`disable` only affect
new Codex conversations. Use `/new` or `/reset` to pick up the change in the
current conversation.

## Support boundary

- Only `openai-curated` plugins already installed in the source Codex
  app-server inventory are migration-eligible.
- Runtime supports explicitly approved plugins from Codex-discovered official,
  workspace, personal, shared, and repository-local marketplaces. A missing
  marketplace, plugin, ownership detail, or app readiness evidence exposes no
  plugin app.
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
- Migration does not automatically import non-curated marketplaces, cached
  plugin bundles, hooks, or Codex config files. Use `/codex plugins available`
  and an owner-issued `/codex plugins install <plugin>@<marketplace>` command
  to opt into an additional discovered plugin.
- OpenClaw does not add new Git or local marketplace sources in this flow.
  Additional sources must already be configured in Codex or be discoverable
  from the bound repository.

## App inventory and ownership

OpenClaw first reads and caches one `plugin/installed` snapshot scoped to the
target Codex app-server and configured workspace. That snapshot covers plugins
from the marketplaces visible in that scope, including disabled plugin
identities; failed or incomplete snapshots are never cached. `plugin/read` is
limited to exact configured plugin details required to establish ownership.
Explicit discovery queries `plugin/list` with the conversation workspace to
find repository marketplaces. Routine setup retains its existing curated
recovery behavior; additional marketplace installation requires the explicit
owner or administrator command.

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
  `plugin/install`. Explicit marketplace installation refreshes the same
  target runtime state before subsequent conversations use the plugin.

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
| `marketplace_missing`, `plugin_missing`           | The exact marketplace or configured plugin is unavailable in the installed snapshot; plugin apps fail closed.                        | Verify the target app-server's `plugin/installed` response and exact configured plugin identity.                       |
| `plugin_detail_unavailable`                       | OpenClaw could not read the exact configured plugin's ownership details.                                                             | Inspect the target app-server's `plugin/installed` and `plugin/read` responses.                                        |
| `plugin_disabled`                                 | Codex reports the plugin installed but disabled.                                                                                     | Enable the plugin in Codex, or have the owner explicitly install and authorize it again.                               |
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
`/reset`. OpenClaw does not authenticate plugin apps on the owner's behalf.

For `plugin_detail_unavailable`, verify that the exact installed marketplace
and plugin identity select a matching `plugin/read` result. OpenClaw keeps
owned apps hidden when that selector or ownership detail is unavailable. For
`plugin_activation_failed`, inspect the marketplace, app authorization, and
post-install refresh diagnostics. An explicitly approved plugin must be
installed, enabled, and authenticated before its apps can appear in a thread.

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
