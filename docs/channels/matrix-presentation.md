---
summary: "Matrix MessagePresentation metadata for OpenClaw-aware clients"
read_when:
  - Building Matrix clients that render OpenClaw rich responses
  - Debugging com.openclaw.presentation event content
title: "Matrix presentation metadata"
---

OpenClaw can attach normalized `MessagePresentation` metadata to outbound Matrix `m.room.message` events under `com.openclaw.presentation`.

Stock Matrix clients continue to render the plain text `body`. OpenClaw-aware clients can read the structured metadata and render native UI such as buttons, selects, context rows, and dividers.

## Event content

The metadata is stored in Matrix event content:

```json
{
  "msgtype": "m.text",
  "body": "Select model\n\n- DeepSeek: /model deepseek/deepseek-chat",
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

`version` is the Matrix presentation metadata schema version. `type` is a stable discriminator for OpenClaw-aware clients. Clients should ignore unknown `type` values, unknown versions they cannot safely interpret, and unknown block types.

## Fallback behavior

OpenClaw always renders a readable plain text fallback into `body`. The structured metadata is additive and must not be required for basic Matrix interoperability.

Unsupported clients should continue to show the fallback text. OpenClaw-aware clients may prefer the structured metadata for display while preserving the fallback text for copy, search, notifications, and accessibility.

## Supported blocks

The Matrix outbound adapter advertises support for:

- `buttons`
- `select`
- `context`
- `divider`

Clients should treat these blocks as best-effort presentation hints. Unknown fields and unknown block types should be ignored rather than causing the full message to fail rendering.

## Interactions

This metadata does not add Matrix callback semantics. Button and select option values are fallback interaction payloads, usually slash commands or text commands. A Matrix client that wants to support interaction can send the selected value back to the room as a normal message.

For example, a button with value `/model deepseek/deepseek-chat` can be handled by sending that value as an encrypted Matrix text message in the same room.

## Relationship to approval metadata

`com.openclaw.presentation` is for general rich message presentation.

Approval prompts use the dedicated `com.openclaw.approval` metadata because approvals carry safety-sensitive state, decisions, and exec/plugin details. If both metadata keys are present on the same event, clients should prefer the dedicated approval renderer.

## Media messages

When a reply contains multiple media URLs, OpenClaw sends one Matrix event per media URL. Presentation metadata is attached only to the first media event so clients have one stable structured payload and duplicate renderers are avoided.

Keep presentation metadata compact. Large user-visible text should stay in `body` and use the normal Matrix text chunking path.
