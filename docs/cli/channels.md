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

`channels list` shows chat channels only: configured accounts by default, with `installed`, `configured`, and `enabled` status tags per account (`--json` for machine output). Pass `--all` to also surface bundled channels that have no configured account yet and installable catalog channels that are not yet on disk. Provider auth and model usage live elsewhere: `openclaw models auth list` for provider auth profiles, `openclaw status` or `openclaw models list` for usage/quota.

## Status / capabilities / resolve / logs

- `channels status`: `--channel <name>`, `--probe`, `--timeout <ms>` (default `10000`), `--json`
- `channels capabilities`: `--channel <name>`, `--account <id>` (requires `--channel`), `--target <dest>` (requires `--channel`), `--timeout <ms>` (default `10000`, capped at `30000`), `--json`
- `channels resolve <entries...>`: `--channel <name>`, `--account <id>`, `--kind <auto|user|group>` (default `auto`), `--json`
- `channels logs`: `--channel <name|all>` (default `all`), `--lines <n>` (default `200`), `--json`

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

<Tip>
`openclaw channels add telegram --help` or `openclaw channels add --channel telegram --help` shows only Telegram's setup flags. `openclaw channels add --help` shows only the shared command envelope.
</Tip>

`channels remove` only operates on installed/configured channel plugins. Use `channels add` first for installable catalog channels. Without `--delete` it asks to disable the account and keeps its config; `--delete` removes the config entries without prompting.
For runtime-backed channel plugins, `channels remove` also asks the running Gateway to stop the selected account before it updates config, so disabling or deleting an account does not leave the old listener active until restart.

The shared control envelope contains only `--channel`, `--account`, and the optional account display `--name`. Each modern channel plugin owns its credential, transport, and provider-specific semantics. Once a channel is selected by positional id or `--channel <id>`, the CLI builds only that channel's options from bundled or installed plugin package metadata without loading channel runtime code.

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

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

- `channels login` supports `--account <id>` and `--verbose`; `channels logout` supports `--account <id>`.
- `channels login` and `logout` can infer the channel when only one configured channel supports that action; with several, pass `--channel`.
- `channels logout` prefers the live Gateway path when reachable, so logout stops any active listener before clearing channel auth state. If a local Gateway is not reachable, it falls back to local auth cleanup; with `gateway.mode: "remote"` the gateway error fails the command instead.
- After a successful login, the CLI asks a reachable local Gateway to start the account; in remote mode it saves auth locally and notes that the remote runtime was not restarted.
- Run `channels login` from a terminal on the gateway host. Agent `exec` blocks this interactive login flow; channel-native agent login tools, such as `whatsapp_login`, should be used from chat when available.

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
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord. For Discord voice channels, the permission check flags missing `ViewChannel`, `Connect`, `Speak`, `SendMessages`, and `ReadMessageHistory`.
- Probes are provider-specific: Discord bot identity + intents plus optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; Microsoft Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## Resolve names to IDs

Resolve channel/user names to IDs using the provider directory:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notes:

- Use `--kind user|group|auto` to force the target type.
- Resolution prefers active matches when multiple entries share the same name.
- `channels resolve` is read-only. If a selected account is configured via SecretRef but that credential is unavailable in the current command path, the command returns degraded unresolved results with notes instead of aborting the entire run.
- `channels resolve` does not install channel plugins. Use `channels add --channel <name>` before resolving names for an installable catalog channel.

## Related

- [CLI reference](/cli)
- [Channels overview](/channels)
