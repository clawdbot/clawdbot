---
name: block-kit
description: "Use proactively for structured or interactive Slack replies, and when asked to author or validate native Slack Block Kit JSON."
metadata: { "openclaw": { "emoji": "🧱", "requires": { "config": ["channels.slack"] } } }
allowed-tools: ["message"]
---

# Slack Block Kit

Make useful Slack replies feel native. When structure or one-click follow-up improves the outcome, send a rich message without waiting for the user to ask for Block Kit.

## Choose the surface

Use a `presentation` when the reply has at least one of these shapes:

- a decision, confirmation, or next action that belongs on buttons or a select
- a status, comparison, report, or plan that scans better as titled sections, a table, or a chart
- important context that should be visually separated from the primary result

Use plain text for short answers and casual conversation where structure adds no value.

## Send the result

For a reply in Slack, call the `message` tool with `action: "send"` and a portable `presentation`. The Slack plugin renders it as native Block Kit. Use the exact schema exposed by the current tool; supported block types can include `text`, `context`, `divider`, `buttons`, `select`, `chart`, and `table`.

- Put the outcome first. Keep titles, labels, and context concise.
- Give interactive controls real follow-up semantics. Use typed `callback` actions for conversational choices and `url` for an external destination. Do not use generic `command` actions for Slack controls; Slack renders them as text fallback rather than clickable controls.
- Include a useful `message` fallback that preserves the meaning without the rich layout.
- After the visible send succeeds, do not repeat the same content in the final response.

A control is complete only when its value is self-contained enough for the next agent turn to understand and act on. When an interaction returns, acknowledge the choice visibly and continue the requested workflow.

## Native Block Kit authoring

When the user is building a Slack app or explicitly requests raw Block Kit JSON, read [the adapted official Block Kit guide](references/official-block-kit.md) in full. For common message, modal, and App Home layouts, also read [the official patterns](references/official-common-patterns.md).

Follow the adapted guide's live-documentation and `blocks.validate` workflow for native JSON. Do not pass native Slack blocks to OpenClaw's `presentation` field; the plugin owns that conversion.
