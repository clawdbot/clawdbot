---
name: configure-channel
description: Configure and prove a chat channel with non-interactive one-liners; secrets only as SecretRefs.
---

# Configure a channel

Never print or persist secret values; channel tokens enter config only as SecretRefs, or through the in-session `connect_channel` flow where the operator types the secret into a masked prompt. Never hand-edit config files on disk. Every run ends with the observable Prove result or an exact explanation of why it could not be proven.

## Gather

```
openclaw channels list --all
openclaw channels status
openclaw config get channels --json        # "Config path not found" is normal before first setup
```

Confirm the exact config path before writing — key names differ per channel (`channels.telegram.botToken`, `channels.discord.token`, ...):

```
openclaw config schema --json | jq '.properties.channels.properties.telegram'
```

## Mutate

Confirm the intended account and access changes with the operator before writing. Preserve existing approved allowlist entries, `dmPolicy`, and `groupPolicy` unless their replacement or change is explicitly approved; never broaden access to make a probe pass.

Preferred shell path — token staged as an env var on the gateway process or in a `0600` file, wired as a SecretRef (Telegram example):

```
openclaw config set channels.telegram.botToken --ref-provider default --ref-source env --ref-id TELEGRAM_BOT_TOKEN
```

With the bot connected and DM policy `pairing`, ask the operator to DM it. Read `Your Telegram user id` in the pairing reply, or run `openclaw logs --follow` and read `senderUserId` in that sender's `telegram pairing request` entry. Stop following once captured; keep unrelated logs private. If the current policy prevents this flow, use an already verified ID or report the discovery blocker; do not broaden access.

Use the numeric **Telegram user ID**, not a phone number, username, chat/group ID, or bot ID. In this single-user example, `123456789` is a placeholder: replace it with the verified, approved user ID and retain any other approved entries.

```
openclaw config set channels.telegram.allowFrom '["123456789"]' --strict-json
```

Multi-field changes in one validated write:

```
openclaw config patch --stdin <<'JSON'
{ channels: { telegram: { enabled: true, groupPolicy: "allowlist" } } }
JSON
```

In-session alternative: call the `connect_channel` tool action with the channel id — the operator enters the token in a masked prompt, never in chat. Avoid `openclaw channels add --token <value>`: it puts the secret in argv and process listings.

## Repair

```
openclaw doctor --lint
openclaw channels status --probe
```

`doctor --lint` can exit `1` for findings: read the report and continue the remaining checks. Ordinary `doctor` and `doctor --non-interactive` can write config/state; do not use them for diagnosis before approval. Apply `openclaw doctor --fix --non-interactive` only after explicit approval, then re-check status.

## Prove

Send one real, clearly labeled test message and confirm delivery from the command result (use `--dry-run` first to inspect the payload):

```
openclaw message send --channel telegram --target <chatId> --message "OpenClaw channel test — please ignore" --dry-run
openclaw message send --channel telegram --target <chatId> --message "OpenClaw channel test — please ignore"
```

If sending fails, report the exact account, permission, destination, or network blocker without exposing credentials.

## Report

State the channel and account changed, the exact config paths written (never values), the test destination, and the observed delivery result. List any remaining operator action.

Further reference: https://docs.openclaw.ai/channels/telegram (and the matching page for other channels)
