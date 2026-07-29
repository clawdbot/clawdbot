---
summary: "Rich output protocol for structured media, embeds, audio hints, and replies"
read_when:
  - Changing assistant output rendering in the Control UI
  - Debugging `[embed ...]`, structured media, reply, or audio presentation directives
title: "Rich output protocol"
---

Assistant output carries delivery/render directives through a few dedicated channels:

- Structured `mediaUrl` / `mediaUrls` fields for attachment delivery.
- `[[audio_as_voice]]` for audio presentation hints.
- `[[reply_to_current]]` / `[[reply_to:<id>]]` for reply metadata.
- `[embed ...]` for Control UI rich rendering.

Structured media fields and `[[...]]` tags are delivery metadata. `[embed ...]` is the separate web-only rich-render path; it is not a media alias.

## Media attachments

Remote attachments must be public `https:` URLs. `http:`, loopback, link-local, private, and internal hostnames are rejected as attachment directives; server-side media fetchers apply their own network guards on top.

Local attachments accept absolute paths, workspace-relative paths, or home-relative `~/` paths. They still pass the agent file-read policy and media type checks before delivery.

<Warning>
Do not emit text commands for attachments from tools, plugins, streaming blocks, browser output, or message actions. Use structured media fields instead:

```json
{ "message": "Here is your image.", "mediaUrl": "/workspace/image.png" }
```

Legacy final-reply text may still be normalized for compatibility, but this is not a general plugin/tool protocol.
</Warning>

Plain Markdown image syntax (`![alt](url)`) stays text by default. Channels that want Markdown images treated as media replies opt in at their outbound adapter; Telegram does this so `![alt](url)` becomes a media attachment.

When block streaming is enabled, media must ride on structured payload fields. If the same media URL appears in a streamed block and again in the final assistant payload, OpenClaw delivers it once and strips the duplicate from the final payload.

## `[embed ...]`

`[embed ...]` is the only agent-facing rich-render syntax for the Control UI. Self-closing example:

```text
[embed ref="cv_123" title="Status" /]
```

Rules:

- `[view ...]` is no longer valid for new output.
- Embed shortcodes render only in the assistant message surface.
- Only URL-backed embeds render; use `ref="..."` or `url="..."`.
- Block-form inline HTML embed shortcodes do not render.
- The web UI strips the shortcode from visible text and renders the embed inline.

## Stored rendering shape

The normalized/stored assistant content block is a structured `canvas` item:

```json
{
  "type": "canvas",
  "preview": {
    "kind": "canvas",
    "surface": "assistant_message",
    "render": "url",
    "viewId": "cv_123",
    "url": "/__openclaw__/canvas/documents/cv_123/index.html",
    "title": "Status",
    "preferredHeight": 320
  }
}
```

`present_view` is not recognized; stored/rendered rich blocks always use this `canvas` shape.

## Related

- [RPC adapters](/reference/rpc)
- [Typebox](/concepts/typebox)
