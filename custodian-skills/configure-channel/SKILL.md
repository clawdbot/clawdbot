---
name: configure-channel
description: Configure and prove a Telegram, Discord, Slack, WhatsApp, or other OpenClaw channel.
---

# Configure a channel

Never print or persist secret values; put credentials in SecretRefs or the channel credential store. Never hand-edit config files on disk. Every run ends with the observable Prove result or an exact explanation of why it could not be proven.

Use the channel's guide as the source of truth: [Telegram](https://docs.openclaw.ai/channels/telegram), [Discord](https://docs.openclaw.ai/channels/discord), [Slack](https://docs.openclaw.ai/channels/slack), or [WhatsApp](https://docs.openclaw.ai/channels/whatsapp).

## Gather

Identify the channel family, account, test destination, and intended agent. Read current state with the `gateway` tool's `config.get` action and ask the `openclaw` tool to inspect the channel. Probe live status before changing anything. Do not request a token in chat or logs.

## Mutate

Route setup through the `openclaw` tool. Its Custodian flow uses `connect_channel` and, when masked credential entry is needed, `open_setup` with `target=channels`; these are the canonical channel config flows. If an approved leaf change is necessary inside Custodian, it must use `config_schema` first, then `config_set` or `config_set_ref`, never a filesystem edit. Preserve unrelated accounts and bindings.

## Repair

Run `openclaw doctor`. If it reports a safe repair, explain it and get approval before running `openclaw doctor --fix` outside the active Custodian inference session. Re-read channel state afterward.

## Prove

Send one real, clearly labeled test message through the configured account to the agreed destination. Confirm receipt from the channel response, delivery result, or recipient observation. If sending or confirmation is impossible, report the exact account, permission, destination, or network blocker without exposing credentials.

## Report

State the channel and account changed, the canonical flow used, the redacted config paths affected, the test destination, and the observed receipt. List any remaining operator action.
