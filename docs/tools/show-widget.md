---
summary: "Show self-contained HTML widgets on supported chat surfaces"
title: "Show widget"
sidebarTitle: "Show widget"
read_when:
  - You want an agent to render an interactive result in web chat, a native app, or Discord
  - You want widget buttons to send follow-up prompts into the chat
  - You want to theme widgets with the shared design tokens
  - You need the show_widget input, security, or retention contract
---

`show_widget` is a core tool that shows a self-contained HTML widget on the user's current surface. OpenClaw renders it inline in the Control UI and in iOS, Android, macOS, and Linux Quick Chat transcripts; the Linux dashboard uses the browser Control UI. In a Discord session with [Activities](/channels/discord-activities) enabled, the Discord plugin posts an **Open widget** button that launches it as an Activity.

## How widgets work

When the agent calls `show_widget`, OpenClaw core validates `widget_code` and wraps it once in the canonical HTML document. For an inline client, core stores that document as a Canvas document and returns a preview handle. The Control UI renders the handle in a sandboxed iframe, while iOS, Android, macOS, and Linux Quick Chat use isolated web views. Full chat clients restore the widget after history reload; Quick Chat keeps the widget for its active reply.

Channel plugins can register a contextual presenter behind the same core tool. In a configured Discord session, core hands the composed document to the Discord presenter, which stores it and posts the Activity button in the current channel. The model still makes one `show_widget` call; there is no transport-specific widget tool or content kind.

In Control UI sessions, a Canvas widget can also be pinned to the session dashboard. Set `pin: true` in the tool call, or use **Pin to dashboard** on an existing transcript widget. Pinned HTML runs behind the same dedicated-origin, double-iframe sandbox host used by MCP Apps; the browser never resolves a widget data binding inside the untrusted frame.

For browser embedding, the wrapper document injects five small host bridges around the widget code:

- A size reporter posts the rendered content height to the embedding chat, which clamps it and fits the iframe (48 to 1200 pixels).
- A host bridge defines the legacy `sendPrompt(text)` helper plus the structured `openclaw.prompt`, `openclaw.state`, `openclaw.data`, and `openclaw.cron` APIs. Inline chat prompts retain their private message channel; dashboard APIs use a view-ticket-bound request channel. See [Interactive widgets](#interactive-widgets) and [Dashboard capabilities](#dashboard-capabilities).
- A theme bridge listens for the Control UI's current design tokens and applies them as CSS variables, on load and again on every theme change.
- A snapshot bridge renders the current widget document as a PNG when the embedding chat requests an export.
- A chat-host bridge hides embedded scrollbar chrome when the widget runs inline while preserving scrolling behavior.

Everything else stays inside the frame: the document runs in an opaque origin with a strict Content Security Policy, so widget scripts cannot reach the Control UI, the Gateway, or the network.

OpenClaw exposes `show_widget` only when the originating Gateway client declares the `inline-widgets` capability or exactly one registered current-channel presenter synchronously matches trusted run context. The Control UI and supported native apps declare the inline capability automatically. Linux Quick Chat stays text-only for Gateway connections that require a custom TLS leaf pin because its platform WebView cannot bind that pin. Discord matches only when Activities are configured for the current account and a concrete channel is available. Other channel runs without an inline client or matching presenter do not receive the tool.

Capability transport covers embedded, Codex app-server, and CLI-backed model backends. Grant-authenticated MCP callers without `inline-widgets` remain fail closed unless their trusted run context matches a presenter. Authenticated direct HTTP `tools/invoke` requests cannot request inline rendering, but a request carrying eligible current-channel context can use the matching presenter. Authentication never bypasses presenter or route eligibility.

## Design system

Every Canvas widget includes a classless base stylesheet and a small token set:

| Token                                                                                 | Purpose                               |
| ------------------------------------------------------------------------------------- | ------------------------------------- |
| `--surface`                                                                           | Page-level surface color              |
| `--card`                                                                              | Card, button, and code background     |
| `--elevated`                                                                          | Elevated form-control background      |
| `--text`                                                                              | Default body and control text         |
| `--text-strong`                                                                       | Headings and prominent values         |
| `--muted`                                                                             | Secondary text and subtle borders     |
| `--border`                                                                            | Standard separators and card borders  |
| `--border-strong`                                                                     | Strong control borders                |
| `--accent`                                                                            | Links and focus rings                 |
| `--accent-fill`                                                                       | Primary action fill                   |
| `--accent-fg`                                                                         | Text on a primary action              |
| `--ok`                                                                                | Success state                         |
| `--warn`                                                                              | Warning state                         |
| `--danger`                                                                            | Error or destructive state            |
| `--info`                                                                              | Informational state                   |
| `--radius`                                                                            | Shared control and card corner radius |
| `--font-body`                                                                         | Host body font stack                  |
| `--font-mono`                                                                         | Host monospace font stack             |
| `--accent-subtle`, `--ok-subtle`, `--warn-subtle`, `--danger-subtle`, `--info-subtle` | Derived translucent state backgrounds |

Bare headings, paragraphs, links, buttons, inputs, selects, textareas, tables, and code blocks receive base styles. Helper classes provide common patterns:

- `.card` for a bordered content surface
- `.badge`, plus `.ok`, `.warn`, `.danger`, or `.info`, for compact status labels
- `.metric` for a prominent numeric value
- `.muted` for secondary text
- `.row` for a wrapping horizontal layout
- `button.primary` for the primary action

The Control UI posts an `openclaw:widget-theme` message with the active theme values when a widget loads and whenever the theme changes. Widgets therefore track every theme family, including Claw, Knot, Dash, and custom themes, without reloading. Outside the Control UI, including native apps and direct opens, widgets use the baked light or dark palette selected by `prefers-color-scheme`.

Author widgets with three rules:

1. Use the design variables for every color and background. Do not hardcode color values.
2. Keep the page background transparent so the widget belongs to its host surface.
3. Reserve `--accent-fill` for at most one primary action.

**Export:** In web chat, open the widget card menu to copy the rendered widget to the clipboard or download it as a PNG. Older widget documents without the snapshot bridge fall back to an HTML file download.

## Use the tool

The core tool uses these required fields on every destination:

<ParamField path="title" type="string" required>
  Short title shown with the inline preview and in the hosted document title. Discord accepts up to 80 characters.
</ParamField>

<ParamField path="widget_code" type="string" required>
  Self-contained HTML or SVG. For inline-widget clients, input beginning with `<svg` after trimming is rendered in SVG mode; maximum length is 262,144 characters. The Discord presenter accepts HTML source up to 48 KiB. A Discord-only route does not advertise or accept registered non-HTML content kinds.
</ParamField>

Discord also accepts optional `button_label` text for the Activity launch button. The Canvas schema intentionally omits this Discord-only field.

The core `show_widget` tool also accepts these optional dashboard placement fields, including when Discord is the presentation destination:

- `pin`: also place the widget on the session dashboard.
- `name`: stable widget name; defaults to a slug of `title`.
- `tab`: destination tab slug.
- `size`: one of `sm`, `md`, `lg`, `xl`, or `full`.
- `presentation.frame`: pinned dashboard frame: `card`, `full-bleed`, or `frameless`.
- `after`: sibling widget name after which to place the widget.
- `capabilities`: access requested by a pinned widget. `netOrigins` contains exact HTTPS origins; `tools` contains `prompt`, an allowlisted read binding, or an exact `cron.trigger:<jobId>` action.

An inline result includes a Canvas preview handle, so the Control UI and supported native apps render the widget directly from the tool call and restore it after history reload. A successful current-channel presentation returns a generic message receipt describing what became visible. Pinned results retain the board widget name so the Control UI does not offer a duplicate pin after transcript reload.

If current-channel presentation fails, core falls back inline only when the originating client actually supports inline widgets. Otherwise the tool fails visibly. When `pin: true` succeeded before presentation failed, the result is explicitly partial and names the durable board widget; presentation failure never rolls back that unrelated board state.

## Show on a device

When a widget presenter plugin is active, `presentation.target` also offers `node_panel`. OpenClaw creates the same hosted widget document, selects a connected widget-panel-capable Mac, and opens its native panel at that document. The tool result names the selected Mac.

If no eligible Mac is connected or the node command fails, the widget still appears inline in chat and the result explains how to recover. Pair a Mac running OpenClaw or open the macOS app, then retry. Widgets shown in a native panel are render-only in this first version; widget actions remain disabled there.

## Interactive widgets

In the Control UI, widget scripts can drive the conversation. The wrapper document defines a global `sendPrompt(text)` function; calling it submits `text` to the chat as if the user had typed and sent the message. Wire it to buttons or other controls to build interactive flows such as pickers, quizzes, or drill-down dashboards. Native apps render interactive widget code but do not expose this chat prompt bridge.

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

## Dashboard capabilities

Pinned widgets can use one ticket-bound host API after the operator reviews the declaration shown on the pending card:

- `openclaw.prompt.send(text)` requires transient user activation and posts a visible composer message. Declaring and receiving the `prompt` tool grant skips the extra per-click confirmation; validation, focus checks, and rate limits still apply.
- `openclaw.state.emit(payload)` adds a session notice. Payloads are capped at 8 KiB, and identical client emissions within five seconds are coalesced.
- `openclaw.data.read(bindingId, params?)` resolves only at the Gateway. Grantable bindings are `sessions.list`, `usage.status`, `usage.cost`, `cron.list`, `cron.status`, `agents.list`, and `health`.
- `openclaw.cron.trigger(jobId)` runs an existing job now only when the exact `cron.trigger:<jobId>` capability was granted.

Network access is separate from host tools. Put exact HTTPS origins in `capabilities.netOrigins`; after approval, only those origins enter the widget's `connect-src`. Wildcards, credentials, paths, query strings, and undeclared origins remain blocked. A literal port is allowed only when it is part of the declared origin.

## Security and storage

Widget documents use restrictive Content Security Policies. Inline style and script are allowed, while external resource loads remain blocked. Inline transcript widgets cannot fetch the network. A pinned dashboard widget can fetch only exact HTTPS origins that the agent declared and the operator granted.

The Control UI iframe always omits `allow-same-origin`, even when the global embed mode is `trusted`, so widget scripts cannot read the parent application origin. Native clients use isolated, nonpersistent web views and block navigation away from the hosted widget. The core document host also serves widgets with a `Content-Security-Policy: sandbox allow-scripts` response header, so direct rendering still runs the widget in an opaque origin instead of an application origin. Only render widget code you are willing to execute in that isolated frame.

The iframe also follows [`gateway.controlUi.embedSandbox`](/web/control-ui#hosted-embeds). The default `scripts` tier supports interactive widgets while preserving origin isolation.

The accepted WebRTC data-channel egress residual is documented in [Dashboard Architecture](/web/dashboard-architecture#modeled-residual-webrtc-data-channels).

Canvas retains at most 32 widgets per session (or per agent when no session is available). Creating another widget removes the oldest document in that scope.

## Related

- [Control UI hosted embeds](/web/control-ui#hosted-embeds)
- [Discord Activities](/channels/discord-activities)
- [macOS widget panel](/platforms/mac/canvas)
- [Gateway protocol client capabilities](/gateway/protocol#client-capabilities)
