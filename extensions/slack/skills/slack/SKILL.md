---
name: slack
description: "Slack messaging workflows through OpenClaw's message tool."
metadata: { "openclaw": { "emoji": "💬", "requires": { "config": ["channels.slack"] } } }
allowed-tools: ["message"]
---

# Slack

Use the `message` tool with `channel: "slack"`. The tool schema lists the actions enabled for the current Slack account; do not assume an action that is not present.

## Workflow

- Prefer stable Slack IDs from context. Sends outside the current conversation use `channel:<id>` or `user:<id>` targets.
- Keep replies in the current thread unless the user asks for a top-level post. For another thread, pass its Slack timestamp as `threadId`; use the same timestamp as `messageId` for message-specific actions.
- Before editing, deleting, pinning, or reacting to an ambiguous message, read the conversation and resolve its exact ID.
- When multiple Slack accounts are configured, pass `accountId` rather than guessing.
- Confirm destructive deletes when the target or intent is unclear.

Slack formatting, mentions, tables, charts, and interactive controls are described automatically by the current `message` tool hints. Follow those hints instead of maintaining a second action or formatting catalog here.
