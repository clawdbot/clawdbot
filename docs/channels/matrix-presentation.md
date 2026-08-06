---
summary: "Matrix MessagePresentation metadata for OpenClaw-aware clients"
read_when:
  - Building Matrix clients that render OpenClaw rich responses
  - Debugging com.openclaw.presentation event content
title: "Matrix presentation metadata"
---

OpenClaw attaches normalized `MessagePresentation` metadata to outbound Matrix `m.room.message` events under the `com.openclaw.presentation` content key.

Stock Matrix clients keep rendering the plain text `body`. OpenClaw-aware clients can read the structured metadata and render native UI such as buttons, selects, context rows, and dividers.

## Event content

```json
{
  "msgtype": "m.text",
  "body": "Select model\n\nChoose model:\n- DeepSeek",
  "com.openclaw.presentation": {
    "version": 1,
    "type": "message.presentation",
    "title": "Select model",
    "tone": "info",
    "blocks": [
      {
        "type": "select",
        "placeholder": "Choose model",
        "options": [
          {
            "label": "DeepSeek",
            "value": "/model deepseek/deepseek-chat"
          }
        ]
      }
    ]
  }
}
```

- `version` is the metadata schema version; the current version is `1`. `type` is a stable discriminator, always `"message.presentation"`. The Matrix adapter only emits payloads with exactly this version and type; clients should likewise ignore unknown versions they cannot safely interpret, unknown `type` values, and unknown block types.
- `title` and `tone` (`info`, `success`, `warning`, `danger`, `neutral`) are optional hints.
- Buttons and select options can carry a typed `action` (`{ "type": "command", "command": "/..." }` or `{ "type": "callback", "value": "..." }`) alongside the legacy string `value`. Prefer `action` when both are present.

## Fallback behavior

OpenClaw always renders a readable plain text fallback into `body`. The structured metadata is additive and must not be required for basic Matrix interoperability.

Fallback rendering rules:

- `title`, `text`, and `context` content renders as plain lines.
- Buttons with a `command` action render as ``label: `/command` `` so the command stays copyable. Buttons with a `callback` action or only a legacy `value` render label-only so opaque callback values stay private; disabled buttons are always label-only. URL and web-app buttons render as `label: URL`.
- Select blocks render the placeholder (or `Options:`) as a heading plus label-only option lines.
- If nothing renders, for example a divider-only presentation, the body falls back to `---`.

Unsupported clients keep showing the fallback text. OpenClaw-aware clients may prefer the structured metadata for display while preserving the fallback for copy, search, notifications, and accessibility.

## Supported blocks

The Matrix outbound adapter advertises native support for:

- `buttons`
- `select`
- `context`
- `divider`

`text` blocks are always supported through the fallback body. Treat all blocks as best-effort presentation hints; ignore unknown fields and block types rather than failing the whole message.

## Interactions

This metadata does not add Matrix callback semantics. Button and select values are fallback interaction payloads, usually slash commands or text commands. A Matrix client that wants to support interaction resolves the control value (`action.command`, then `action.value`, then `value`) and sends it back to the room as a normal message.

For example, a button with value `/model deepseek/deepseek-chat` can be handled by sending that value as an encrypted Matrix text message in the same room.

## Relationship to approval metadata

`com.openclaw.presentation` is for general rich message presentation.

Approval prompts use the dedicated `com.openclaw.approval` metadata because approvals carry safety-sensitive state, decisions, and exec/plugin details. If both metadata keys are present on the same event, clients should prefer the dedicated approval renderer.

## Media messages

When a reply contains multiple media URLs, OpenClaw sends one Matrix event per media URL. Caption text and presentation metadata attach only to the first event so clients get one stable structured payload without duplicate renderers. The same rule applies when long text is chunked across events: the metadata rides on the first event only.

Keep presentation metadata compact. Large user-visible text should stay in `body` and use the normal Matrix text chunking path.
