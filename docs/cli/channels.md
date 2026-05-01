---
summary: "CLI reference for `openclaw channels` (accounts, status, login/logout, logs)"
read_when:
  - You want to add/remove channel accounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/Matrix)
  - You want to check channel status or tail channel logs
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
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Status / capabilities / resolve / logs

- `channels status`: `--probe`, `--timeout <ms>`, `--json`
- `channels capabilities`: `--channel <name>`, `--account <id>` (only with `--channel`), `--target <dest>`, `--timeout <ms>`, `--json`
- `channels resolve`: `<entries...>`, `--channel <name>`, `--account <id>`, `--kind <auto|user|group>`, `--json`
- `channels logs`: `--channel <name|all>`, `--lines <n>`, `--json`

`channels status --probe` is the live path: on a reachable gateway it runs per-account
`probeAccount` and optional `auditAccount` checks, so output can include transport
state plus probe results such as `works`, `probe failed`, `audit ok`, or `audit failed`.
If the gateway is unreachable, `channels status` falls back to config-only summaries
instead of live probe output.

## Add / remove accounts

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels remove --channel telegram --delete
```

<Tip>
`openclaw channels add --help` shows per-channel flags (token, private key, app token, signal-cli paths, etc).
</Tip>

`channels remove` only operates on installed/configured channel plugins. Use `channels add` first for installable catalog channels.

Common non-interactive add surfaces include:

- bot-token channels: `--token`, `--bot-token`, `--app-token`, `--token-file`
- Signal/iMessage transport fields: `--signal-number`, `--cli-path`, `--http-url`, `--http-host`, `--http-port`, `--db-path`, `--service`, `--region`
- Google Chat fields: `--webhook-path`, `--webhook-url`, `--audience-type`, `--audience`
- Matrix fields: `--homeserver`, `--user-id`, `--access-token`, `--password`, `--device-name`, `--initial-sync-limit`
- Nostr fields: `--private-key`, `--relay-urls`
- Tlon fields: `--ship`, `--url`, `--code`, `--group-channels`, `--dm-allowlist`, `--auto-discover-channels`
- `--use-env` for default-account env-backed auth where supported

If a channel plugin needs to be installed during a flag-driven add command, OpenClaw uses the channel's default install source without opening the interactive plugin install prompt.

When you run `openclaw channels add` without flags, the interactive wizard can prompt:

- account ids per selected channel
- optional display names for those accounts
- `Bind configured channel accounts to agents now?`

If you confirm bind now, the wizard asks which agent should own each configured channel account and writes account-scoped routing bindings.

You can also manage the same routing rules later with `openclaw agents bindings`, `openclaw agents bind`, and `openclaw agents unbind` (see [agents](/cli/agents)).

When you add a non-default account to a channel that is still using single-account top-level settings, OpenClaw promotes account-scoped top-level values into the channel's account map before writing the new account. Most channels land those values in `channels.<channel>.accounts.default`, but bundled channels can preserve an existing matching promoted account instead. Matrix is the current example: if one named account already exists, or `defaultAccount` points at an existing named account, promotion preserves that account instead of creating a new `accounts.default`.

Routing behavior stays consistent:

- Existing channel-only bindings (no `accountId`) continue to match the default account.
- `channels add` does not auto-create or rewrite bindings in non-interactive mode.
- Interactive setup can optionally add account-scoped bindings.

If your config was already in a mixed state (named accounts present and top-level single-account values still set), run `openclaw doctor --fix` to move account-scoped values into the promoted account chosen for that channel. Most channels promote into `accounts.default`; Matrix can preserve an existing named/default target instead.

## Login and logout (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

- `channels login` supports `--verbose`.
- `channels login` and `logout` can infer the channel when only one supported login target is configured.
- Run `channels login` from a terminal on the gateway host. Agent `exec` blocks this interactive login flow; channel-native agent login tools, such as `whatsapp_login`, should be used from chat when available.

## Troubleshooting

- Run `openclaw status --deep` for a broad probe.
- Use `openclaw doctor` for guided fixes.
- `openclaw channels list` prints `Claude: HTTP 403 ... user:profile` → usage snapshot needs the `user:profile` scope. Use `--no-usage`, or provide a claude.ai session key (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), or re-auth via Claude CLI.
- `openclaw channels status` falls back to config-only summaries when the gateway is unreachable. If a supported channel credential is configured via SecretRef but unavailable in the current command path, it reports that account as configured with degraded notes instead of showing it as not configured.

## Capabilities probe

Fetch provider capability hints (intents/scopes where available) plus static feature support:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes:

- `--channel` is optional; omit it to list every channel (including extensions).
- `--account` is only valid with `--channel`.
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord.
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; Microsoft Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

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
