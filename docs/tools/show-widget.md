---
summary: "Show self-contained HTML widgets on the current chat surface"
title: "Show widget"
sidebarTitle: "Show widget"
read_when:
  - You want an agent to render an interactive result in web chat or Discord
  - You want widget buttons to send follow-up prompts into the chat
  - You need the show_widget input, security, or retention contract
---

`show_widget` shows a self-contained HTML widget on the user's current surface. In the Control UI, the Canvas plugin renders it inline in the chat transcript. In a Discord session with [Activities](/channels/discord-activities) enabled, the Discord plugin posts an **Open widget** button that launches it as an Activity.

## How widgets work

When the agent calls `show_widget`, the Canvas plugin wraps `widget_code` in a minimal HTML document, stores it as a Canvas document, and returns a preview handle. Web chat renders that handle as a sandboxed iframe directly under the tool call and restores it after history reload.

The wrapper document injects two small host bridges around the widget code:

- A size reporter posts the rendered content height to the embedding chat, which clamps it and fits the iframe (160 to 1200 pixels).
- A prompt bridge defines a global `sendPrompt(text)` function that widget scripts can call to submit a follow-up message into the chat. The bridge creates a private message channel and offers one endpoint to the chat before any widget code runs; the chat adopts only that first offer. See [Interactive widgets](#interactive-widgets).

Everything else stays inside the frame: the document runs in an opaque origin with a strict Content Security Policy, so widget scripts cannot reach the Control UI, the Gateway, or the network.

The Canvas implementation is available only when the originating Gateway client declares the `inline-widgets` capability. The Control UI declares this capability automatically. The Discord implementation is available only in Discord sessions with Activities configured. Other channel runs do not receive `show_widget`.

Capability transport covers embedded, Codex app-server, and CLI-backed model backends. Grant-authenticated MCP callers and direct HTTP tool-invoke callers remain fail closed because they do not declare client capabilities.

## Use the tool

Both implementations use the same required fields:

<ParamField path="title" type="string" required>
  Short title shown with the inline preview and in the hosted document title.
</ParamField>

<ParamField path="widget_code" type="string" required>
  Self-contained HTML or SVG. In the Control UI, input beginning with `<svg` after trimming is rendered in SVG mode; maximum length is 262,144 characters. Discord accepts a complete HTML document or body fragment up to 48 KiB.
</ParamField>

Discord also accepts optional `button_label` text for the Activity launch button. The Canvas schema intentionally omits this Discord-only field.

The Control UI result includes a Canvas preview handle, so web chat renders the widget directly from the tool call and restores it after history reload. Discord returns the stored widget and posted-message identifiers.

`discord_widget` remains registered as a deprecated alias for one release. New agent calls should use `show_widget`.

## Interactive widgets

Widget scripts can drive the conversation. The wrapper document defines a global `sendPrompt(text)` function; calling it submits `text` to the chat as if the user had typed and sent the message. Wire it to buttons or other controls to build interactive flows such as pickers, quizzes, or drill-down dashboards:

```html
<button onclick="sendPrompt('Show the failing tests in detail')">Failing tests</button>
```

Every prompt is validated on both sides of the frame boundary:

- `sendPrompt` requires [transient user activation](https://developer.mozilla.org/en-US/docs/Web/Security/User_activation) inside the widget: it only works in the few seconds after the user clicks or presses a key in the widget, so wire it to buttons and other click targets — calling it automatically on load does nothing. The bridge keeps the sending endpoint private to itself and fails closed in browsers that do not expose user activation, so widget code cannot bypass the check.
- Prompt authority belongs to the original widget document only. The trusted bridge offers its channel endpoint to the chat before widget code can run or navigate the frame, the chat adopts only that first offer, and the channel dies with the document on navigation. Externally allowed embed URLs are never adopted.
- The widget frame must be visible in the chat transcript and hold focus — an additional host-observed signal that the user is actually interacting with this widget.
- The text must be non-empty after trimming and at most 4,000 characters.
- Prompts starting with `/` are rejected, so widget code cannot trigger chat commands such as `/approve` or `/stop`.
- Each widget document may send at most 10 prompts per rolling minute; excess prompts are dropped silently.

Accepted prompts appear in the transcript as regular user messages and start a normal agent turn in the session that owns the widget. There is no feedback channel into the widget: a dropped prompt fails silently, and the widget cannot read the agent's reply.

## Security and storage

Widget documents use restrictive Content Security Policies. Inline style and script are allowed, while external fetches and resource loads are blocked. Keep all markup, styles, scripts, and image data inside `widget_code`.

The iframe always omits `allow-same-origin`, even when the Control UI's global embed mode is `trusted`, so widget scripts cannot read the parent application origin. The Canvas host also serves widget documents with a `Content-Security-Policy: sandbox allow-scripts` response header, so opening the hosted URL directly still runs the widget in an opaque origin instead of the Control UI origin. Browser sandboxing does not prevent a script from navigating its own iframe; only render widget code you are willing to execute in that isolated frame.

The iframe also follows [`gateway.controlUi.embedSandbox`](/web/control-ui#hosted-embeds). The default `scripts` tier supports interactive widgets while preserving origin isolation.

Canvas retains at most 32 widgets per session (or per agent when no session is available). Creating another widget removes the oldest document in that scope.

## Related

- [Control UI hosted embeds](/web/control-ui#hosted-embeds)
- [Discord Activities](/channels/discord-activities)
- [Canvas plugin](/plugins/reference/canvas)
- [Gateway protocol client capabilities](/gateway/protocol#client-capabilities)
