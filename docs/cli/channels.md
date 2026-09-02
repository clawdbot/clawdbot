---
summary: "CLI reference for `openclaw channels` (accounts, status, dead letters, capabilities, resolve, logs, login/logout)"
read_when:
  - You want to add or remove channel accounts (Discord, Google Chat, iMessage, Matrix, Signal, Slack, Telegram, WhatsApp, and more)
  - You want to check channel status or tail channel logs
  - You need to inspect or resubmit a failed inbound channel event
title: "Channels"
---

# `openclaw channels`

Manage chat channel accounts and their runtime status on the Gateway.

Related docs:

- Channel guides: [Channels](/channels)
- Gateway configuration: [Configuration](/gateway/configuration)

## Common commands

```bash
openclaw channels list
openclaw channels list --all
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
openclaw channels dead-letters list --channel telegram --account default
```

`channels status` keeps configured channels visible when their plugin fails to load or register. Affected accounts report `running: false`, `lifecycle: "blocked"`, and the plugin error instead of stale probe success. Run `openclaw doctor`, repair or update the plugin, and restart the Gateway before checking again.

`channels list` shows chat channels only: configured accounts by default, with `installed`, `configured`, and `enabled` status tags per account (`--json` for machine output). Pass `--all` to also surface bundled channels that have no configured account yet and installable catalog channels that are not yet on disk. Provider auth and model usage live elsewhere: `openclaw models auth list` for provider auth profiles, `openclaw status` or `openclaw models list` for usage/quota.

`--json` returns a local account inventory from plugin metadata without contacting the Gateway or executing channel setup/runtime code. Configured accounts remain visible even when their plugin has a setup entry. Use `channels status --probe` for live checks.

In an explicit multi-agent setup, workspace-scoped channel plugins come from
`agents.defaults.systemAgent.agentId`. Without that owner, `channels list`
returns the shared bundled, managed, and global inventory with a diagnostic;
it does not guess one agent workspace.

For `add`, `login`, `logout`, `remove`, and `resolve`, or `capabilities --channel`,
use `--agent <id>` to select the workspace used for channel plugin discovery.
The option works before or after the subcommand; a subcommand value takes precedence.
Without it, discovery uses the configured System Agent or the existing sole/legacy owner.
An explicit fleet with no such owner requires `--agent`. Selecting a workspace
does not create account routing bindings; guided setup asks about routing separately.

## Status / capabilities / resolve / logs

- `channels status`: `--channel <name>`, `--probe`, `--timeout <ms>` (default `10000`), `--json`
- `channels capabilities`: `--channel <name>`, `--agent <id>`, `--account <id>` (requires `--channel`), `--target <dest>` (requires `--channel`), `--timeout <ms>` (default `10000`, capped at `30000`), `--json`
- `channels resolve <entries...>`: `--channel <name>`, `--account <id>`, `--agent <id>`, `--kind <auto|user|group|channel>` (default `auto`), `--json`
- `channels logs`: `--channel <name|all>` (default `all`), `--lines <n>` (default `200`), `--json`

`channels logs --channel <name>` matches subsystem or module names rooted at `<name>`
or `gateway/channels/<name>`, including slash-separated descendants. Similar names
such as `discord-archive` do not match `discord`.

`channels status --probe` is the live path: on a reachable gateway it runs per-account
`probeAccount` and optional `auditAccount` checks, so output can include transport
state plus probe results such as `works`, `probe failed`, `audit ok`, or `audit failed`.
If the gateway is unreachable, `channels status` falls back to config-only summaries
instead of live probe output.

## Inbound dead letters

Inbound events that exhaust their retry policy remain in the shared state database for the queue's existing failed-entry retention period. Inspect one channel account with:

```bash
openclaw channels dead-letters list --channel telegram --account default
openclaw channels dead-letters list --channel telegram --account default --json
```

The text view shows event ids, failure reasons, attempt counts, and failure ages. JSON output also includes the retained payload, metadata, lane, and attempt timestamps for diagnostics.

Omitting `--account` inspects the `default` account. Both dead-letter commands reject a blank value instead of falling back to `default`, so an unset shell variable cannot silently select an account you did not name. You can place `--account` before or after `list` or `resubmit`; a value after the leaf command takes precedence.

After correcting the underlying problem, re-enqueue one event with its original event id:

```bash
openclaw channels dead-letters resubmit <event-id> --channel telegram --account default
```

Run these commands on the Gateway host so they access the same shared state database as the channel runtime. Resubmission preserves the payload, metadata, and lane, but resets the attempt counter and queue age. It atomically replaces that event's failed marker, so repeating the command while the event is pending or claimed refuses instead of creating a second dispatch. The running channel picks it up on its next ingress drain. Completed events remain terminal and cannot be resubmitted. Failed rows created before payload retention was added can still appear in the list, but resubmission refuses them because their payload is unavailable.

`openclaw health` reports dead-letter counts and oldest failure age per channel account. `openclaw doctor` names affected accounts and points back to the inspection command.

Do not use `openclaw sessions`, Gateway `sessions.list`, or the agent
`sessions_list` tool as a channel socket-health signal. Those surfaces report
stored conversation rows, not provider runtime state. After a Discord provider
restart, a connected but quiet account may be healthy while no Discord session
row appears until the next inbound or outbound conversation event.

## Add / remove accounts

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels remove --channel telegram --delete
```

For a headless host, complete non-interactive onboarding first, then add each channel with explicit credential flags or its environment-backed setup option:

```bash
export OPENAI_API_KEY="<provider-key>"
export TELEGRAM_BOT_TOKEN="<bot-token>"

openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --skip-channels \
  --no-install-daemon
openclaw channels add --channel telegram --use-env
```

`--use-env` validates the environment variables declared by the selected channel plugin before writing config. For Telegram, the command requires `TELEGRAM_BOT_TOKEN`; other plugins name their missing variables in the error. The Gateway service must receive the same environment variables as the bootstrap shell. If the Gateway is already running with config reload enabled, it watches the config write and restarts the affected channel automatically.

See [CLI automation](/start/wizard-cli-automation) for additional non-interactive provider and Gateway options. Container deployments should also follow the [Docker headless bootstrap](/install/docker#headless-bootstrap) environment guidance.

<Tip>
`openclaw channels add telegram --help` or `openclaw channels add --channel telegram --help` shows only Telegram's setup flags. `openclaw channels add --help` shows only the shared command envelope.
</Tip>

`channels remove` only operates on installed/configured channel plugins. Use `channels add` first for installable catalog channels. Without `--delete` it asks to disable the account and keeps its config; `--delete` removes the config entries without prompting.
For runtime-backed channel plugins, `channels remove` also asks the running Gateway to stop the selected account before it updates config, so disabling or deleting an account does not leave the old listener active until restart.

The shared control envelope contains `--agent`, `--channel`, `--account`, and the optional account display `--name`. Each modern channel plugin owns its credential, transport, and provider-specific semantics. Once a channel is selected by positional id or `--channel <id>`, the CLI builds only that channel's options from bundled or installed plugin package metadata without loading channel runtime code.

Common-looking flags such as `--token`, `--url`, or `--use-env` are still channel-owned when a modern contract handles them. When a selected third-party plugin still uses the legacy shared setup adapter, core registers the released compatibility flag set for that channel only, alongside its legacy `cliAddOptions`. Unrelated legacy fields do not leak into other channels, and a modern selected channel rejects compatibility flags it did not declare.

Examples of channel-owned flags include:

| Channel     | Flags                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Google Chat | `--webhook-path`, `--webhook-url`, `--audience-type`, `--audience`                                   |
| iMessage    | `--cli-path`, `--db-path`, `--service`, `--region`                                                   |
| Matrix      | `--homeserver`, `--user-id`, `--access-token`, `--password`, `--device-name`, `--initial-sync-limit` |
| Nostr       | `--private-key`, `--relay-urls`                                                                      |
| Signal      | `--signal-number`, `--signal-transport`, `--cli-path`, `--http-url`, `--http-host`, `--http-port`    |
| Tlon        | `--ship`, `--url`, `--code`, `--group-channels`, `--dm-allowlist`, `--auto-discover-channels`        |
| WhatsApp    | `--auth-dir`                                                                                         |

If a channel plugin needs to be installed during a flag-driven add command, OpenClaw uses the channel's default install source without opening the interactive plugin install prompt.

Both guided setup and flag-driven setup pass through the selected channel's parser, validation, account resolution, config writer, and post-write hooks. Unsupported flags fail with the owning channel's setup error instead of being accepted through a global input bag.

When you run `openclaw channels add` with no direct account, credential, or channel-config flags, the interactive wizard can prompt. A positional channel id and `--channel <id>` both open that channel's guided setup immediately. Back returns to the full channel picker:

```bash
openclaw channels add telegram
openclaw channels add --channel telegram
```

Guided setup requires an interactive terminal. In a non-TTY shell, OpenClaw exits immediately instead of waiting for input; use `openclaw channels add --channel <id> --use-env` or pass the selected plugin's credential flags.

The wizard can prompt for:

- account ids per selected channel
- optional display names for those accounts
- `Route these channel accounts to agents now?`

If you confirm bind now, the wizard asks which agent should own each configured channel account and writes account-scoped routing bindings.

You can also manage the same routing rules later with `openclaw agents bindings`, `openclaw agents bind`, and `openclaw agents unbind` (see [agents](/cli/agents)).

When you add a non-default account to a channel that is still using single-account top-level settings, OpenClaw promotes those top-level values into the channel's account map before writing the new account. Promotion reuses an existing named account when the channel has exactly one, or when `defaultAccount` points at one; otherwise the values land in `channels.<channel>.accounts.default`.

Routing behavior stays consistent:

- Existing channel-only bindings (no `accountId`) continue to match the default account.
- `channels add` does not auto-create or rewrite bindings in non-interactive mode.
- Interactive setup can optionally add account-scoped bindings.

If your config was already in a mixed state (named accounts present and top-level single-account values still set), run `openclaw doctor --fix` to move account-scoped values into the promoted account chosen for that channel.

## Login and logout (interactive)

Before `channels add` or `channels login` writes local credentials or configuration, OpenClaw compares the selected CLI state/config paths with the local Gateway or its installed service. A proven mismatch stops before the write. A remote Gateway or an authenticated path that cannot be verified produces a warning instead.

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

- `channels login` supports `--agent <id>`, `--account <id>`, and `--verbose`; `channels logout` supports `--agent <id>` and `--account <id>`.
- `channels login` and `logout` can infer the channel when only one configured channel supports that action; with several, pass `--channel`.
- `channels logout` prefers the live Gateway path when reachable, so logout stops any active listener before clearing channel auth state. If a local Gateway is not reachable, it falls back to local auth cleanup; with `gateway.mode: "remote"` the gateway error fails the command instead.
- Logout reports whether the plugin cleared saved auth. If the plugin reports that the account is not logged out, the CLI warns that other credentials may still be active; this is not a claim that provider-side tokens were revoked.
- Login and logout base config changes on the authored source, not runtime defaults. A logout with no credentials to clear does not rewrite config merely because runtime defaults were materialized; intentional plugin enablement or installation changes can still be saved.
- After a successful login, the CLI asks a reachable local Gateway to start the account. If that start is skipped or another lifecycle operation owns the account, it reports the reason and a status command; saved auth is retained. In remote mode it saves auth locally and notes that the remote runtime was not restarted.
- Run `channels login` from a terminal on the gateway host. Agent `exec` blocks this interactive login flow; channel-native agent login tools, such as `whatsapp_login`, should be used from chat when available.

## Per-account recovery (non-destructive)

When one account needs to reconnect while keeping its pairing and credentials, call the `channels.stop` and `channels.start` Gateway RPCs. Both require `operator.admin`. Invoke them through `openclaw gateway call`:

```bash
# Stop one WhatsApp account without clearing its pairing.
openclaw gateway call channels.stop --params '{"channel":"whatsapp","accountId":"<accountId>"}'
# Start the same account again.
openclaw gateway call channels.start --params '{"channel":"whatsapp","accountId":"<accountId>"}'
openclaw channels status --channel whatsapp --probe
```

Use the same `accountId` in both calls. Omit it from both to select the default account.

`channels.stop` returns `{ channel, accountId, stopped }`; `channels.start` returns `{ channel, accountId, started, outcome }`. These booleans reflect the account's runtime snapshot after the operation: `started` is true only when `running` is true, and `stopped` is true when `running` is not true. A `started: false` response does not by itself establish that the account is stopped, and `started: true` does not establish that the provider connection is healthy. Check channel status and logs after recovery.

`outcome` explains the lifecycle owner's decision for the requested account:

- `{ status: "handed-off" }`: startup was handed to the account runtime. Check status for provider connectivity.
- `{ status: "retry", reason }`: an existing task, start, or stop still owns the account (`task-owned`, `start-in-flight`, or `stop-in-flight`). A running account can return `task-owned` with `started: true`; another start was unnecessary. Wait for an in-flight stop to finish before starting again.
- `{ status: "skipped", reason }`: startup was skipped, for example because the account is `disabled`, `unconfigured`, or `unlinked`. Repair the named account condition before retrying. Other manager reasons are `unsupported`, `autostart-suppressed`, `ambient-suppressed`, `secret-unavailable`, and `manual-stop`; the manual RPC bypasses automatic-start suppression but does not bypass account configuration or secret checks.

Accounts explicitly disabled in channel or account configuration are skipped without resolving inactive credentials. An unavailable configured secret on an enabled account still returns an RPC error instead of starting with another credential.

Unlike this recovery path, `openclaw channels logout` clears the account's credentials and requires login again; `openclaw gateway restart` restarts the whole Gateway. See [Restart recovery](/gateway/restart-recovery) for the crash-loop breaker and its manual `channels.start` override.

## Troubleshooting

- Run `openclaw status --deep` for a broad probe.
- Use `openclaw doctor` for guided fixes.
- `openclaw channels status` falls back to config-only summaries when the gateway is unreachable. If a supported channel credential is configured via SecretRef but unavailable in the current command path, it reports that account as configured with degraded notes instead of showing it as not configured.

## Capabilities probe

Fetch provider capability hints (intents/scopes where available) plus static feature support:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes:

- `--channel` is optional; omit it to list every channel (including plugin-provided channels).
- `--account` is only valid with `--channel`.
- Each account probe and diagnostics step has its own timeout. A stalled step is reported in both text and JSON output, and the command continues with the remaining accounts.
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord. For Discord voice channels, the permission check flags missing `ViewChannel`, `Connect`, `Speak`, `SendMessages`, and `ReadMessageHistory`.
- Probes are provider-specific: Discord bot identity + intents plus optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; Microsoft Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## Resolve names to IDs

Resolve channel/user names to IDs using the provider directory:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
openclaw channels --agent ops resolve --channel slack "#general"
openclaw channels resolve --agent ops --channel slack "#general"
```

Notes:

- In multi-agent configurations, use `--agent <id>` in either parent or leaf position to select the agent-owned workspace and channel plugin context.
- Use `--kind user|group|channel|auto` to force the target type.
- Resolution prefers active matches when multiple entries share the same name.
- `channels resolve` is read-only. If a selected account is configured via SecretRef but that credential is unavailable in the current command path, the command returns degraded unresolved results with notes instead of aborting the entire run.
- `channels resolve` does not install channel plugins. Use `channels add --channel <name>` before resolving names for an installable catalog channel.

## Related

- [CLI reference](/cli)
- [Channels overview](/channels)
