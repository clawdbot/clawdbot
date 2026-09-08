---
summary: "Show HTML widgets on supported chat surfaces or pin native data reports to dashboards"
title: "Show widget"
sidebarTitle: "Show widget"
read_when:
  - You want an agent to render an interactive result in web chat, a native app, or Discord
  - You want to pin a report with metrics, tables, charts, or links to a dashboard
  - You want widget buttons to send follow-up prompts into the chat
  - You want to theme widgets with the shared design tokens
  - You need the show_widget input, security, or retention contract
---

`show_widget` is a core tool that shows a self-contained HTML widget on the user's current surface. OpenClaw renders it inline in the Control UI and in iOS, Android, macOS, and Linux Quick Chat transcripts; the Linux dashboard uses the browser Control UI. In a Discord session with [Activities](/channels/discord-activities) enabled, the Discord plugin posts an **Open widget** button that launches it as an Activity.

For a pinned data report, provide a structured `report` with `pin: true`. Reports render directly in the Control UI dashboard using its native typography and layout, without a document frame. Use HTML for arbitrary interactive content or an inline preview. See [Native dashboard reports](#native-dashboard-reports).

## How widgets work

For HTML widgets, OpenClaw core validates `widget_code` by parsing every inline JavaScript `<script>` (classic and module), skipping scripts with `src` or a non-JavaScript `type`, then wraps it once in the canonical HTML document. Core rejects the call with the line and column of the first syntax error, so a widget with a broken script is never hosted. For an inline client, core stores that document as a Canvas document and returns a preview handle. The Control UI reads the document over its authenticated Gateway connection and renders it through the dedicated-origin, double-iframe sandbox used by dashboard widgets and MCP Apps. The widget frame does not need its own login session. iOS, Android, macOS, and Linux Quick Chat use isolated web views. Full chat clients restore the widget after history reload; Quick Chat keeps the widget for its active reply.

Channel plugins can register a contextual presenter behind the same core tool. In a configured Discord session, core hands the composed document to the Discord presenter, which stores it and posts the Activity button in the current channel. The model still makes one `show_widget` call; there is no transport-specific widget tool or content kind.

In Control UI sessions, a Canvas widget can also be pinned to the session dashboard. Set `pin: true` in the tool call, or use **Pin to dashboard** on an existing transcript widget. Pinning gives the dashboard copy its own identity and capability grants; the inline preview never inherits those grants. The browser never resolves a widget data binding inside the untrusted frame.

For browser embedding, the wrapper document injects five small host bridges around the widget code:

- A size reporter posts the rendered content height to the embedding chat, which clamps it and fits the iframe (48 to 8000 pixels).
- A host bridge defines the legacy `sendPrompt(text)` helper plus the structured `openclaw.prompt`, `openclaw.state`, `openclaw.data`, and `openclaw.cron` APIs. Inline chat prompts retain their private message channel; dashboard APIs use a view-ticket-bound request channel. See [Interactive widgets](#interactive-widgets) and [Dashboard capabilities](#dashboard-capabilities).
- A theme bridge listens for the Control UI's current design tokens and applies them as CSS variables, on load and again on every theme change.
- A snapshot bridge renders the current widget document as a PNG when the embedding chat requests an export.
- A chat-host bridge hides embedded scrollbar chrome when the widget runs inline while preserving scrolling behavior.

Everything else stays inside the frame: the document runs in an opaque origin with a strict Content Security Policy, so widget scripts cannot reach the Control UI, the Gateway, or the network.

OpenClaw exposes `show_widget` only when the originating Gateway client declares the `inline-widgets` capability or exactly one registered current-channel presenter synchronously matches trusted run context. The Control UI and supported native apps declare the inline capability automatically. Linux Quick Chat stays text-only for Gateway connections that require a custom TLS leaf pin because its platform WebView cannot bind that pin. Discord matches only when Activities are configured for the current account and a concrete channel is available. Other channel runs without an inline client or matching presenter do not receive the tool.

An agent-turn automation bound to a persistent session and carrying a server-authored scheduled tool policy may explicitly allow `show_widget` without an inline client. That scheduled surface is pinned-only: every call requires `pin: true`, writes to the bound session dashboard, and cannot set `presentation.target`. Detached cron-run sessions, ordinary capless channel runs, and scheduled jobs without an explicit tool cap remain excluded. The originating-client capability remains mandatory for inline presentation.

When the Gateway automatically resumes an interrupted Control UI turn after a restart, the recovered turn can also create or update pinned dashboard widgets without a connected browser. Recovery uses the same pinned-only surface: set `pin: true` and omit `presentation.target`. Inline previews still require a new turn from a client that declares `inline-widgets`; the resumed turn does not inherit a browser connection or device presentation rights.

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

Author widgets with four rules:

1. Use the design variables for every color and background. Do not hardcode color values.
2. Keep the page background transparent so the widget belongs to its host surface.
3. Reserve `--accent-fill` for at most one primary action.
4. Fit the iframe width at every viewport. Avoid fixed page or card widths; use fluid sizing and wrap or stack multi-column layouts when narrow. Use horizontal scrolling only when exact geometry must remain.

**Export:** In web chat, open the widget card menu to copy the rendered widget to the clipboard or download it as a PNG. Older widget documents without the snapshot bridge fall back to an HTML file download.

## Use the tool

The core tool requires `title` and one content input: `widget_code` for HTML or registered source, or `report` for a native dashboard report.

<ParamField path="title" type="string" required>
  Short widget title shown by the destination surface. HTML documents also use it as the document title. Discord accepts up to 80 characters.
</ParamField>

<ParamField path="widget_code" type="string">
  Required for HTML, SVG, or registered source; omit when providing `report`. For HTML, core parses every inline JavaScript `<script>` (classic and module), skipping scripts with `src` or a non-JavaScript `type`. The call is rejected with the line and column of the first syntax error, so a widget with a broken script is never hosted. For inline-widget clients, input beginning with `<svg` after trimming is rendered in SVG mode; maximum length is 262,144 characters. The Discord presenter accepts HTML source up to 48 KiB. A Discord-only route does not advertise or accept registered non-HTML content kinds.
</ParamField>

<ParamField path="report" type="object">
  Structured native report with a `blocks` array. Requires `pin: true`; omit `widget_code`, `kind`, and `capabilities`. Device presentation is unavailable. Maximum 8KB of UTF-8 JSON. See [Native dashboard reports](#native-dashboard-reports).
</ParamField>

Discord also accepts optional `button_label` text for the Activity launch button. The Canvas schema intentionally omits this Discord-only field.

The core `show_widget` tool also accepts these optional dashboard placement fields, including when Discord is the presentation destination:

- `kind`: `html` by default, plus active registered source kinds when available. Applies to `widget_code`; omit with `report`.
- `pin`: also place an HTML or registered widget on the session dashboard. Required for reports and on the pinned-only scheduled surface.
- `name`: stable widget name; defaults to a slug of `title`.
- `tab`: destination tab slug.
- `size`: one of `sm`, `md`, `lg`, `xl`, or `full`.
- `presentation.frame`: pinned dashboard frame: `card`, `full-bleed`, or `frameless`.
- `after`: sibling widget name after which to place the widget.
- `capabilities`: access requested by a pinned widget. `netOrigins` contains exact HTTPS origins; `tools` contains `prompt`, an allowlisted read binding, or an exact `cron.trigger:<jobId>` action.

An inline result includes a Canvas preview handle, so the Control UI and supported native apps render the widget directly from the tool call and restore it after history reload. A successful current-channel presentation returns a generic message receipt describing what became visible. Pinned results retain the board widget name so the Control UI does not offer a duplicate pin after transcript reload.

Pinned results also report `capabilityState`: `none`, `pending`, `rejected`, or
`granted`. A saved widget is not necessarily authorized to read data. For
`pending`, ask the operator to review the dashboard permission card. For
`rejected`, review the requested access and session permission policy with the
operator before retrying. The inline preview does not inherit dashboard grants.

If current-channel presentation fails, core falls back inline only when the originating client actually supports inline widgets. Otherwise the tool fails visibly. When `pin: true` succeeded before presentation failed, the result is explicitly partial and names the durable board widget; presentation failure never rolls back that unrelated board state.

## Native dashboard reports

Use a report for a pinned summary made of text, metrics, tables, simple charts, and links. Provide the report object directly in `report`:

```json
{
  "title": "Weekly delivery report",
  "name": "weekly-delivery",
  "pin": true,
  "size": "lg",
  "report": {
    "blocks": [
      {
        "type": "metrics",
        "items": [{ "label": "Completed", "value": "24", "detail": "This week" }]
      },
      {
        "type": "table",
        "columns": ["Team", "Completed"],
        "rows": [
          ["Platform", "14"],
          ["Product", "10"]
        ]
      }
    ]
  }
}
```

The result names the pinned board widget; it creates no inline preview, native device panel, or Discord Activity. Do not combine `report` with `widget_code`, `kind`, `capabilities`, or device presentation. The report field does not change the registered source-kind namespace.

Each block has a required `type`:

| Type      | Fields and limits                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | `text` (1–4,000 characters), optional `title`. Text is plain text.                                                                                          |
| `metrics` | `items`: 1–8 objects with `label`, string `value` (1–80 characters), and optional `detail`.                                                                 |
| `table`   | `columns`: 1–8 labels; `rows`: up to 40 arrays of string cells. Every row must match the column count; cells have at most 500 characters. Optional `title`. |
| `chart`   | `points`: 1–40 objects with `label` and finite numeric `value`; optional `style` (`bar`, the default, or `line`) and `title`.                               |
| `links`   | `items`: 1–20 objects with `label`, HTTP(S) `url`, and optional `detail`. Optional `title`.                                                                 |

A report contains 1–24 blocks and at most 8KB of encoded JSON. Titles have 1–120 characters, labels 1–160, details at most 240, and URLs at most 2,048. Chart values stay between `-Number.MAX_SAFE_INTEGER` and `Number.MAX_SAFE_INTEGER`. Unknown fields are rejected. Reports accept no HTML, CSS, scripts, media, executable actions, network reads, or Gateway RPCs; links are ordinary navigation.

Reuse the same `name` and `pin: true` with a new `report` object to replace a report's data. The `dashboard` tool can also create or update it with `action: "widget_put"`, `pluginKind: "session:report"`, and `props: report`. To convert an existing HTML widget, first remove it with `dashboard` action `widget_remove`, then create the report. A same-name update cannot change the widget's content owner.

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

Pinned HTML and registered-source widgets expose one ticket-bound host API. An explicit [session permission mode](/gateway/permission-modes) determines how declared capabilities are approved: **Full access** grants them immediately; **Workspace** uses an AI reviewer and rejects anything it does not allow; **Guarded** shows an **Allow** / **Reject** card; **Read only** rejects them. Without an explicit session mode, the equivalent configured exec approval policy applies.

- `openclaw.host.controlUiBaseUrl` exposes the Control UI origin plus its configured base path after the dashboard host initializes. It is `null` before initialization and outside the dashboard, so read it in the link's click handler rather than when the widget script first runs.
- `openclaw.prompt.send(text)` requires transient user activation and posts a visible composer message. Declaring and receiving the `prompt` tool grant skips the extra per-click confirmation; validation, focus checks, and rate limits still apply.
- `openclaw.state.emit(payload)` adds a session notice. Payloads are capped at 8 KiB, and identical client emissions within five seconds are coalesced.
- `openclaw.data.read(bindingId, params?)` resolves only at the Gateway. Core bindings are `sessions.list`, `usage.status`, `usage.cost`, `cron.list`, `cron.status`, `agents.list`, `health`, and the repository-scoped `github.actions.runs` binding below.
- `openclaw.action.run(actionId, params?)` invokes an operator-granted plugin dashboard action verb through its write-scoped Gateway method.
- `openclaw.cron.trigger(jobId)` runs an existing job now only when the exact `cron.trigger:<jobId>` capability was granted.

User-clicked links to `http` or `https` destinations are forwarded to the Control UI host, which opens a new tab with `noopener` and `noreferrer`. Forwarding covers a primary click on a `target="_blank"` link and a middle-button click on any link, matching how links behave elsewhere in the Control UI; a widget's own `preventDefault` still cancels the click. The widget sandbox never grants popup permission, and script-initiated `window.open` does not work.

Network access is separate from host tools. Put exact HTTPS origins in `capabilities.netOrigins`; once the session policy grants them, only those origins enter the widget's `connect-src`. Wildcards, credentials, paths, query strings, and undeclared origins remain blocked. A literal port is allowed only when it is part of the declared origin.

The tool schema describes currently active plugin read bindings and action
verbs, including action parameter schemas when provided. This discovery text is
bounded: it includes complete entries and reports when entries were omitted.
Disabled plugins are not advertised.

### Read GitHub Actions runs

With a usable connected agent GitHub identity, use the host binding instead of
fetching GitHub directly from widget code. For example, give `show_widget` this
input, replacing `owner/repo` in both places:

```json
{
  "title": "Workflow runs",
  "name": "workflow-runs",
  "pin": true,
  "capabilities": { "tools": ["github.actions.runs:owner/repo"] },
  "widget_code": "<pre id='runs'>Loading…</pre><script>openclaw.data.read('github.actions.runs',{repository:'owner/repo',perPage:20}).then(data=>{document.getElementById('runs').textContent=data.workflow_runs.map(run=>run.display_title+': '+(run.conclusion||run.status)).join('\\n')}).catch(error=>{document.getElementById('runs').textContent=String(error)});</script>"
}
```

The read runs in the pinned dashboard after approval, not the inline preview.
No `netOrigins` declaration or token is needed. Repository names are
case-insensitive and grants use lowercase spelling. A grant for one repository
cannot read another; granting only `https://api.github.com` network access does
not authorize this binding.

Direct browser fetches to `api.github.com` do not inherit the agent's login and
share GitHub's anonymous IP quota. Existing widgets using `fetch` should replace
that call with the binding and replace their GitHub `netOrigins` declaration with
the repository-scoped tool grant. Check the effective account in **Agent settings
→ Tools → GitHub account**; administrators can also reach it from **Settings →
Profile → GitHub connections**.

For refreshable widgets, keep the last successful data and a separate error
element. Clear the error after a successful read, and keep result containers in
the document so later refreshes can recover. Show a **Refresh** control for an
immediate retry.

**Approval shares Actions metadata with the widget and its session audience,
including metadata from private repositories accessible to the selected agent
identity.** The host selects the agent override, then the configured System
identity, then native GitHub authentication. It never uses the Control UI
preview credential or a human's publication-only **My GitHub** connection.
A configured but unavailable identity fails closed with reconnect guidance;
it does not retry anonymously or fall through to another account.

Before saving an HTML or registered widget declaring this binding, the Gateway
verifies the selected identity. An unavailable identity or retired caller fails
without replacing an existing widget, creating a pending grant, or broadcasting
a change. Reconnect the agent's GitHub identity in Settings and retry. Pinning
does not query Actions or verify repository permission; those checks happen on
read. Ordinary widgets and MCP App tool names do not trigger this identity check.

| Parameter             | Contract                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`          | Required `owner/repo`.                                                                                                                                                                 |
| `workflow`            | Optional positive numeric workflow ID or workflow filename, such as `ci.yml`. Omit to list repository runs.                                                                            |
| `perPage`             | Integer from 1 to 30; default 20. No pagination.                                                                                                                                       |
| `branch`              | Optional branch name, at most 255 characters.                                                                                                                                          |
| `status`              | Optional `completed`, `action_required`, `cancelled`, `failure`, `neutral`, `skipped`, `stale`, `success`, `timed_out`, `in_progress`, `queued`, `requested`, `waiting`, or `pending`. |
| `created`             | Optional ISO day (`2026-09-01`), comparison (`>=2026-09-01`), or inclusive day range (`2026-08-01..2026-09-01`).                                                                       |
| `excludePullRequests` | Boolean; default `true`. GitHub omits embedded pull-request objects, not pull-request-triggered runs.                                                                                  |

Other fields, including identity overrides, URLs, headers, and methods, are
rejected. The result keeps GitHub's `{ total_count, workflow_runs }` shape.
Each run contains only `id`, `name`, `display_title`, `head_branch`, `status`,
`conclusion`, `html_url`, `run_started_at`, `created_at`, `updated_at`, `event`,
`workflow_id`, and `run_attempt`. No credentials or raw repository objects are
returned. The upstream response is capped at 1 MiB and the projected run list
at 30 entries. Successful reads are cached for about 30 seconds within the
current Gateway, board identity, credential, repository, and filter scope.

Rate limits, access denial, unavailable identity, and upstream failure return
sanitized guidance. Redirects are refused; for a renamed repository, verify its
new name and update both the read and grant. Each caller revalidates its widget,
Gateway, and identity before receiving data, including shared reads and cache
hits. Removing one widget does not fail another authorized widget's shared read.

## Security and storage

Widget documents use restrictive Content Security Policies. Inline style and script are allowed, while arbitrary external resource loads remain blocked. Registered content kinds can load their explicitly public static renderer assets from the isolated sandbox origin. Inline transcript widgets cannot fetch the network. A pinned dashboard widget can fetch only exact HTTPS origins that the agent declared and the session policy granted.

The Control UI's widget content iframe always omits `allow-same-origin`, even when the global embed mode is `trusted`, so widget scripts cannot read the parent application origin. With scripts enabled, the outer proxy runs on a dedicated origin and relays messages across the frame boundary. In `strict` mode, the Control UI still reads the document through its authenticated Gateway connection, but renders it without scripts or scripted interactions. Native clients use isolated, nonpersistent web views and block navigation away from the hosted widget. The core document host also serves widgets with a `Content-Security-Policy: sandbox allow-scripts` response header, so direct rendering still runs the widget in an opaque origin instead of an application origin. Only render widget code you are willing to execute in that isolated frame.

The iframe also follows [`gateway.controlUi.embedSandbox`](/web/control-ui/chat#hosted-embeds). The default `scripts` tier supports interactive widgets while preserving origin isolation.

The accepted WebRTC data-channel egress residual is documented in [Dashboard Architecture](/web/dashboard-architecture#modeled-residual-webrtc-data-channels).

Canvas retains at most 32 widgets per session (or per agent when no session is available). Creating another widget removes the oldest document in that scope.

## Related

- [Control UI hosted embeds](/web/control-ui/chat#hosted-embeds)
- [Discord Activities](/channels/discord-activities)
- [macOS widget panel](/platforms/mac/canvas)
- [Gateway protocol client capabilities](/gateway/protocol/handshake#client-capabilities)
