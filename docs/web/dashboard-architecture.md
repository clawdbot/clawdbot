---
summary: "Session dashboard architecture: widget hosting, capabilities, board storage, and protocol"
read_when:
  - Maintaining or reviewing session dashboards and their security boundaries
  - Changing widget hosting, the widget bridge, or board storage
title: "Dashboard Architecture"
doc-schema-version: 1
---

Session dashboards are persistent widget boards attached to a session. This
reference covers their ownership, sandbox and capability boundaries, storage,
and Gateway protocol. For the operator workflow, see
[Session Dashboards](/web/dashboards); for the widget authoring API, see
[Show widget](/tools/show-widget).

## Vision

A dashboard turns the session into a workbench: the agent renders interactive
widgets, the user pins them onto a persistent board, and the board can occupy
either the main area or a side panel alongside chat. Focusing the main view gives
it the full task area. The board and conversation remain part of the same session.

Principles:

- **A board belongs to a session; it is not a new workspace.** A session with no
  pinned widgets is plain chat. Pin one widget and the board exists in that
  session's Dashboard view. Boards inherit the session's identity, agent
  ownership, naming, pinning, and lifecycle. There is no `dashboard_create`, no
  board registry, and no separate ACL model.
- **Agent parity.** Everything the user can do on a board, the agent can do
  with tools: add/update/remove widgets, arrange them, manage tabs, switch the
  visible tab, and request split or expanded presentation.
- **Native, not embedded.** The board is Lit components in the Control UI shell
  (the same design system as the rest of the app). Only widget _content_ is
  sandboxed in iframes. No URL bar, no browser chrome.
- **Small agent surface.** Widgets are addressed by stable name and updated in
  place. Layout is a fluid auto-compacting grid; the agent speaks sizes and
  anchors, never pixels or coordinates.
- **Capabilities over trust.** Widget code is arbitrary agent-authored HTML/JS
  in a hard sandbox. Reach (gateway data, actions, network) exists only through
  a declared, operator-granted capability manifest.

## Concepts

| Concept             | Definition                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session (thread)    | Existing gateway session, keyed by stable `sessionKey`. Owned by an agent.                                                                         |
| Board               | The widget board of one session. Exists iff the session has widgets/tabs. Survives `/new`/`/reset` (attached to `sessionKey`, not the transcript). |
| Tab                 | A presentation page of a board: which widgets and their arrangement. Boards start with one implicit tab.                                           |
| Widget              | Named, sandboxed HTML/JS program owned by the session. Addressed as `sessionKey` + `name`. Updated in place by name.                               |
| Capability manifest | Per-widget declaration of reach: `data` (read bindings), `actions` (allowlisted verbs), `prompt` (send to session), `net` (allowed origins).       |
| Pin (widget)        | Moving a transcript widget onto the session's board (user affordance or agent tool arg). Unpin removes it from the board.                          |
| Pin (session)       | Existing sidebar pinning of sessions. Opening a pinned session restores that browser's saved task layout.                                          |

## UX flows

- **Graduation:** agent calls `show_widget` from an inline-capable chat → widget
  renders in the transcript → hover shows **Pin to dashboard** → widget appears
  on the session's board. The agent can pass `pin: true` to do the same. A
  channel presenter can instead make the same core document visible on the
  current transport.
- **Board view:** **Dashboard** in the side panel opens the current task's board,
  including its empty state, without editing the chat draft. The first pinned
  widget opens a resizable dashboard beside chat unless a task layout is already
  saved. The task toolbar's **Swap** button exchanges the main view and
  active side-panel content, including Chat, Dashboard, Browser, Terminal,
  Files, and Review. Its tooltip names the two views. The same toolbar's
  **Layout** menu positions the side panel left, right, or below. **Focus** in
  the same toolbar gives the main view the full task area; **Restore split**
  restores the side panel.
  Later board updates preserve the user's current layout. Closing the Dashboard
  tab removes only its view; closing the whole side panel hides it without
  changing the main view.
- **Layout ownership:** the browser stores the arrangement per session, including
  the main view, active side tab, dock position, dimensions, and focus state.
  Ordinary revisits restore it. Gallery links with `?dashboard=expanded` explicitly
  make Dashboard main and focus it. Placement changes reuse the mounted content
  so widget frames, browser views, terminals, and chat drafts survive a swap.
  The task toolbar and side-panel tab header align above their respective panes
  in left/right layouts; stacked layouts keep each header above its own pane.
- **Drag:** user drags widgets; grid auto-compacts (widgets float up, neighbors
  reflow). Resize by handle snaps to size steps. No pixel placement — for
  anyone.
- **Reset warning:** `/new` / `/reset` on a board-bearing session asks for
  confirmation in the web UI ("context resets, the dashboard stays") and keeps
  the board.
- **Sidebar:** opening a pinned session restores its saved task arrangement.
  The Home session's board is the default "agent dashboard".
- **Interactions** (three tiers, see below): silent state events, visible
  prompt sends, and automation triggers.

## Interaction tiers

1. **State events (default).** Widget UI interactions the model should know
   about but not respond to. `bridge.emitState({...})` appends a structured
   session notice (same mechanism as group-activity notices). No agent turn is
   started; the model sees accumulated notices on its next run.
2. **Prompts (explicit talk).** `bridge.sendPrompt(text)` — requires user
   activation; sends a visible user message into the owning session. Rate-limited;
   each send is user-confirmed unless the widget holds
   the `prompt` capability grant.
3. **Automation.** `bridge.runAction(name, args)` — fires a manifest-declared
   action. Initial verb set: `cron.trigger` (run an existing cron job now) and
   `binding.refresh`. Cron jobs already run in visible, isolated run-sessions
   and can use a cheaper model: that is the "small model powers the widget"
   path. No hidden sessions anywhere.

## Widget model and hosting

Widget HTML/JS is authored by the agent (typically via `show_widget`), wrapped
in the standard document shell (CSP meta, size reporter, bridge bootstrap), and
rendered in an opaque-origin content iframe. In the Control UI's default
`scripts` embed mode, both inline and board widgets use the dedicated-origin
sandbox proxy described below.

- **Inline (transcript) widgets** use managed Canvas document artifacts under
  `<stateDir>/canvas/documents`, read through the authenticated
  `canvas.document.view` RPC and pruned per scope.
  These artifacts are separate from SQLite board storage and need no capability
  approval (they are capless by construction — prompt sends require a user gesture).
  Opening an inline preview creates no board state and never inherits the
  pinned copy's grants.
- **Board widgets** are session state: bytes live in the owning agent's SQLite
  DB (`board_widgets`), served by a core gateway route
  (`/__openclaw__/board/<agentId>/<sessionKey>/<name>/`) that reads the DB.
  Pinning a transcript widget copies the bytes. Caps: 256 KB per widget,
  48 widgets per board.
- **Update in place:** re-emitting a widget with the same `name` replaces the
  bytes, bumps `revision`, broadcasts `board.changed`, and live views reload
  that iframe only.
- **Byte freezing:** HTML and registered-source grants bind to the SHA-256
  digest of the approved content. Preserving a grant requires the same content
  scope, a matching approved digest, and a declaration that does not widen.
  Changed bytes require a new decision under the session's approval policy,
  even when the declaration stays the same or shrinks.

### Widgets host content; MCP apps are one content kind

The **widget is the OpenClaw primitive**: the named, pinned, sized,
session-owned board cell with a grant record. What renders inside it is a
content kind:

- `html` — agent-authored via `show_widget`, bytes in board storage.
- `mcp-app` — a third-party MCP app view (`ui://` resource from a configured
  server) hosted inside the widget cell.
- Registered plugin kinds — plugin-validated source rendered through the same
  sandboxed document frame. The Canvas plugin registers `a2ui`; core discovers
  the active registry and never hardcodes plugin kind names.

MCP apps do not define the widget model; widgets gained the ability to host
them. Identity, placement, pinning, grants, and the author-facing API stay
OpenClaw's — so `show_widget` code stays as short as it is today and never
needs to know the MCP Apps spec exists.

Registered kinds use a small runtime Plugin SDK seam. A registration owns the
agent-facing kind name, source validation, capability-scoped renderer
resources, and document-body composition. The Gateway validates source again
at `board.widget.put`, stores it in the existing generic `plugin` descriptor
envelope, and composes the framed document only after a ticketed board read.
This keeps stored source out of board snapshots and avoids a database CHECK or
schema-version change. Disabled plugins are absent from the registry, so new
puts fail with an enable-and-retry error and existing cells render as disabled.

The A2UI implementation composes a small document that references its renderer
bundle. Ticketed board documents use the capability-scoped Gateway asset route;
inline documents load the same public static renderer from the sandbox origin.
Core adds the same CSP, theme bridge, size reporter, and private-port host bridge
used by HTML widgets. v0.8 and v0.9 use separate renderer bundles because their
Lit custom elements share tag names but their processors and action contracts
differ.

A registered kind can expose public static renderer bytes through
`resources.readPublicResource(path)`. The isolated listener serves only exact
registered `resources.paths`, only for `GET` or `HEAD`, and rechecks the active
plugin registry after reading. It does not proxy Gateway routes, credentials,
or data. Canvas opts in its two A2UI bundles; this grants no widget network or
host-tool capability.

Shared hosting infrastructure:

- **One sandbox host.** `html` widgets render through the same hardened
  pipeline MCP apps shipped with (double-iframe on the dedicated sandbox
  origin, per-widget CSP declared and fail-closed decoded) instead of a second
  bespoke iframe host. The proxy receives HTML by value, so local content is
  the natural case.
- **Authenticated loading.** The trusted Control UI reads inline Canvas HTML
  over its existing Gateway connection and board HTML over its ticketed HTTP
  route, then passes the bytes to the proxy. The content iframe never navigates
  to the authenticated document route. This avoids a separate iframe login
  redirect to a page that refuses embedding.
- **One authorization model.** A widget's reach is a granted allowlist,
  whatever its kind: for `html` widgets, host tools; for `mcp-app` widgets,
  the server's app-visible tools and same-server resources (via the existing
  live App-interaction authority, made durable per widget instead of
  per-minting-run).
- **Host tools for `html` widgets** (exposed over the widget bridge, checked
  against the grant):
  - `openclaw.prompt.send` — tier 2; routed through the visible composer,
    user-confirmed unless granted
  - `openclaw.state.emit` — tier 1 session notices (coalesced, size-capped)
  - `openclaw.data.read` — parameterized read-only bindings (existing
    allowlisted read RPC set), resolved gateway-side
  - `openclaw.action.run` — tier 3 plugin-owned automation
  - `openclaw.cron.trigger` — tier 3 automation
- **`net` = CSP.** Network reach uses the already-shipped per-widget CSP
  declaration (`connect-src` origins) — the self-updating weather widget
  fetches its API directly from the sandbox, no gateway involvement.
- **Grants.** HTML and registered widgets declaring nothing render immediately
  (sandboxed, `default-src 'none'`, prompt sends individually confirmed).
  Declared capabilities and interactive MCP Apps follow an explicit
  [session permission mode](/gateway/permission-modes): **Full access** grants;
  **Workspace** uses an AI reviewer and rejects anything it does not allow;
  **Guarded** shows **Allow**/**Reject**; **Read only** rejects. Without an
  explicit session mode, the equivalent configured exec approval policy applies.
  Grants are per widget name and content scope. HTML and registered-source
  updates preserve a grant only while the approved digest matches and the
  declaration does not widen. Wrapper-authored board widgets forward user-clicked
  `http`/`https` new-tab links to the Control UI host; this ordinary navigation
  needs no grant and never grants iframe popup permissions.
- **Authoring shim.** The document wrapper injects `window.openclaw.prompt`,
  `window.openclaw.state`, `window.openclaw.data`, `window.openclaw.action`,
  `window.openclaw.cron`, and the host-provided
  `window.openclaw.host.controlUiBaseUrl` as the stable author API. Dashboard
  calls and trusted new-tab link clicks share one view-ticket-bound request
  channel. The host opens links with `noopener,noreferrer`; size reporting and
  theme tokens remain separate host notifications.

The outer proxy runs on a different origin from both the Control UI and the
Gateway. Its iframe allows `allow-same-origin` so the host can authenticate
proxy messages against that dedicated origin. The proxy puts widget bytes in
an inner `srcdoc` iframe with `allow-scripts allow-forms`, without
`allow-same-origin`. Widget code therefore has neither application-origin
access nor the proxy's origin. Inline views adopt only the wrapper's private
prompt channel; dashboard views initialize their separate ticket-bound bridge.

The shared loader fetches board HTML while the sandbox proxy starts, then
delivers it only after that exact proxy reports ready. Dashboard widgets keep a
themed loading placeholder until the proxy confirms that the current inner
document has loaded. This rendering signal is separate from HTML delivery and
bridge initialization, so an empty widget can finish loading without reporting
a positive content height. Focused dashboard routes reuse an already resolved
session key and agent owner to avoid a second session lookup.

Mounted widgets retain their loaded document across presentation changes and
ticket renewal. Inline views share concurrent reads of the same document only
within one client and connection generation; each view still owns its own sandbox
and prompt channel.
Managed `[embed ref="..."]` previews use that authenticated path whenever their
effective sandbox policy permits scripts, including the default with no explicit
sandbox field. Explicit strict previews remain script-free.
There is no completed-document cache: Canvas permits replacing named document
IDs, so a remount reads the current source again. Reconnection retires pending
results from the previous connection.

### Plugin capability declarations

Enabled plugins can extend the widget host through `dashboard.dataBindings`
and `dashboard.actionVerbs` in `openclaw.plugin.json`. Plugin-local ids become
grant names prefixed by the plugin id, such as `workboard.cards.list` and
`workboard.dispatch`; `%` and `.` in the plugin-id segment are escaped so a
different plugin/local-id split cannot inherit the same persisted grant. During
plugin registration, OpenClaw verifies that every binding targets an RPC
registered by the same plugin with `operator.read` and every action targets one
with `operator.write`; invalid declarations fail the plugin load. The validated
registry is rebuilt only with plugin lifecycle changes, while widget grants
remain per-widget and byte-and-revision-bound.

`show_widget` uses this validated active registry for bounded author discovery,
including complete descriptions and action parameter schemas where available.
It never loads plugins merely to describe their dashboard capabilities.

### Authenticated GitHub reads

Core's existing GitHub identity and HTTP owners serve `github.actions.runs`
through `board.data.read`. The closed parameter contract constructs only the
repository or workflow run-list operation at `api.github.com`. Authorization
requires the exact normalized `github.actions.runs:<owner>/<repo>` tool grant;
network-origin grants never supply GitHub identity authority. Approval discloses
that Actions metadata, including private repository data accessible to the
agent, is shared with the widget/session audience.

Author guidance is conditional on a usable connected agent identity, not a
tool-construction-time probe. `board.widget.put` verifies and revalidates that
identity before saving HTML (including materialized Canvas documents) or
registered widgets declaring this host capability. The same preparation owner
serves pinning and reads, including source-config preview-credential scrubbing
and OAuth refresh. Caller cancellation and session mutation authorization are
rechecked before persistence; failure leaves existing content and grants intact.
MCP App tool names use their own contract and do not trigger this preflight.

The board capability owner carries the canonical agent/session privately and
rechecks the live Gateway, ticket generation, widget revision and grant across
awaits for both data and action paths. GitHub selects the agent override, System,
or native identity using the existing credential owner and OAuth refresh
service. Read authority additionally revalidates selection and credential
rotation before fetch and before returning data. This does not change the
personal publication broker or its admitted credential-snapshot semantics.

Authenticated reads never use preview authentication or anonymous retry.
Redirects are refused. Only this Actions read permits an upstream body up to
1 MiB; other GitHub JSON callers retain their 256 KiB default. The owner validates
and projects at most 30 runs into a small response, without raw repository
objects or secrets. A Gateway-local cache holds at most 32 successful results
for 30 seconds; at most 32 concurrent callers can prepare or await reads.
The shared transport caches only validated projections under its captured
credential scope; this internal cache write is not delivery to a widget.
Every caller, including the initiator, followers, and cache hits, revalidates its
own live authority before delivery. Removing one caller does not invalidate
another authorized caller's result, and failed transport reads are not cached
as success. See the
[authoring contract and example](/tools/show-widget#read-github-actions-runs).

### Modeled residual: WebRTC data channels

The sandbox CSP emits the proposed `webrtc 'block'` directive, but
[Chromium's current CSP directive set](https://chromium.googlesource.com/chromium/src/+/main/services/network/public/mojom/content_security_policy.mojom#95)
does not implement it. Scriptable widgets can therefore use WebRTC data
channels for egress without CSP enforcement of that directive. This residual
also applies to inline chat widgets and the MCP Apps host.

**Accepted tradeoff:** OpenClaw does not gate scriptable widgets on this
residual. Widget content gains access to sensitive OpenClaw data only through
policy-granted, byte-frozen data bindings, and the sandbox Permissions Policy
blocks camera and microphone access.

Inline and board widgets enable a DOM API guard before widget code runs. It removes
same-realm WebRTC constructors and blocks common ways to create descendant
browsing contexts with fresh constructors. This reduces exposure but remains
best-effort defense-in-depth, not an isolation or authorization boundary; it
does not eliminate the accepted residual. The guard is implemented in
`src/agents/sandbox-host.ts` and enabled by the Canvas and board view owners.

### Transcript display: one widget card

Inline HTML and MCP App previews share a widget-card renderer that dispatches
on content kind. Eligible previews expose the same **Pin to dashboard**
affordance. Generated widget names let the card recognize an existing pin and
avoid offering a duplicate. The renderer and pin paths live in
`ui/src/pages/chat/components/widget-card.ts`.

Widgets compose through grid adjacency: an agent-authored widget and an MCP App
can occupy neighboring cells on one tab. Each keeps its own sandbox and bridge
identity. An MCP App must not render inside an agent-authored iframe, where
nesting would compromise bridge identity and allow overlays over granted app UI.

### Server-sourced widgets (pinned MCP apps)

With the unified host, pinning a third-party MCP app is just a widget whose
content is fetched from the server instead of stored: `board_widgets` keeps the
descriptor (`serverName`, `toolName`, `uiResourceUri`, originating
`toolCallId` + `sessionKey`) instead of HTML bytes, and the board re-mints the
view lease past the chat-turn 10-minute TTL (re-fetching the `ui://` resource
on staleness). Chat inline MCP app views get the same **Pin to dashboard**
affordance as agent widgets. Re-opened views are read-only today by design;
pinned apps that should stay interactive get a durable grant over the server's
app-visible tools (explicit allowlist shown to the operator on pin), decoupled
from the minting run. Ungranted pins can render their fetched App HTML but
cannot call tools or access the same-server resource bridge. Pins belong to the
originating session's board; cross-session pinning is not supported.

### WorkBoard integration

The WorkBoard integration program keeps cards and boards plugin-owned while stitching dispatched cards back to their session boards through the existing `sessionKey` and `runId`, exposing WorkBoard feeds and dispatch through plugin-declared bindings and actions, and composing those results with the existing `html` and `mcp-app` widget kinds instead of introducing a WorkBoard-specific widget type.

## Layout: fluid grid

12 columns, fixed row height, **auto-compacting** (gravity-up, push-aside on
drag — gridstack semantics, implemented natively; grid math stays pure and
DOM-free). Widget layout state per tab: `{ name, w (1-12), h (rows) }` plus
order. Agent vocabulary:

- `size`: `sm` (3×3) · `md` (6×4) · `lg` (8×6) · `xl` (12×8) · `full`
  (single-widget tab)
- `after: <widgetName>` optional ordering anchor; omitted = append
- User drags/resizes freely; the same order+size model round-trips.

## Data model (per-agent DB)

Board state lives in `agents/<agentId>/agent/openclaw-agent.sqlite`:

- `board_tabs` stores tab identity, ordering, chat dock, and board revision.
- `board_widgets` stores widget identity, placement, content or descriptors,
  capability declarations, approved digests, and grant state.

The canonical table definitions, constraints, and indexes are in
`src/state/openclaw-agent-schema.sql`. The board schema ensure/repair path is
`src/state/openclaw-agent-board-schema.ts`; runtime reads and writes are owned by
`src/boards/sqlite-board-store.ts`. See [Database schemas](/reference/database-schemas)
for schema versions, migration and downgrade rules, and the review checkpoint for
material storage changes. Do not use a copied SQL sketch as the schema contract.

Board existence = any rows for the `sessionKey`. Deleting a session deletes its
board rows. `/new`/`/reset` does not touch them.

## Protocol surface

RPCs (core method table, typebox schemas in `gateway-protocol`):

- `canvas.document.view { docId }` → HTML and sandbox connection metadata —
  `operator.read`; accepts managed script-enabled Canvas documents up to 2 MiB,
  creates no board state, and returns no capability ticket.
- `board.get { sessionKey }` → tabs + widget metadata (no bytes) — `operator.read`
- `board.update { sessionKey, ops[] }` — tab CRUD/reorder, widget move/resize/
  remove/unpin, dock state, focus-tab — `operator.write`
- `board.widget.put { sessionKey, name, html, manifest, placement }` —
  `operator.write` (agent tool path and pin path)
- `board.widget.grant { sessionKey, name, decision }` — `operator.approvals`
- `board.event { ticket, payload }` — ticket-bound tier-1 state event ingest;
  the legacy trusted-host `{ sessionKey, widget, payload }` shape remains —
  `operator.write`
- `board.prompt.authorize { ticket }` — returns whether a visible prompt send
  still needs per-click confirmation — `operator.read`
- `board.data.read { ticket, bindingId, params? }` — gateway-side allowlisted
  core or active-plugin read binding resolution — `operator.read`
- `board.action { ticket, action, ... }` — exact-grant automation dispatch
  through the existing cron run-now path or an active plugin's validated action
  verb — `operator.write`

Events (in `EVENT_SCOPE_GUARDS`, read scope):

- `board.changed { sessionKey, revision, widget? }` — persisted state changed;
  UI refetches (and reloads one iframe when `widget` is present).
- `board.command { sessionKey, command }` — transient UI drive (agent switches
  the visible tab or dashboard panel presentation) — the `ui.command` pattern.

Board widget bytes use the authenticated HTTP surface. Inline Canvas widget
bytes use `canvas.document.view`; native clients and direct document opens keep
the existing Canvas HTTP routes.

## Agent tools

Three tools total (core; `show_widget` is exposed for an `inline-widgets`
client, one unambiguous matching current-channel presenter, or a persistent-session
automation whose server-authored tool policy explicitly allows pinned-only authoring):

- `show_widget { title, widget_code, kind?, name?, pin?, size?, tab?, after?,
presentation?, capabilities? }` — create/update by name; `kind` defaults to `html` and its enum
  includes active registered kinds; `pin` places it on the board.
  Without `name`/`pin` it behaves exactly like today (inline, ephemeral).
  Headless scheduled authoring requires `pin: true`, cannot select a presentation
  target, and is unavailable to detached cron-run sessions.
- `dashboard { action, ... }` — board management verbs: `read`, `tab_create`,
  `tab_update`, `tab_delete`, `tabs_reorder`, `widget_put`, `widget_move`,
  `widget_resize`, `widget_remove`, `focus_tab`, `set_presentation`.
  Presentation is `split` or `expanded`; `expanded` makes Dashboard main and
  focuses it, while `split` reveals Dashboard using the current arrangement and
  brings chat alongside when Dashboard is main. The Control UI owns the side
  panel's dock position. The tool maps presentation onto the existing
  `set_chat_dock` wire command without changing the Gateway protocol.
- The existing `automations` tool covers the automation tier; no new tool needed.

Tool descriptions teach the size/anchor vocabulary and the tier model. The
agent is told about user tier-1 events via session notices, e.g.
`[dashboard] user clicked "Refresh" on widget weather (tab main)`.

## What this replaces

- **`extensions/workspaces` is deleted.** Experimental, `enabledByDefault:
false`, never in a stable release (first appeared in 2026.7.2 betas). No
  migration; a doctor rule removes stale `<stateDir>/workspaces/` if present.
  Harvested ideas: pure grid math, bridge security model (port bootstrap,
  binding gating, rate limits), byte-frozen approval.
- **Core owns widget hosting.** The canvas doc store, document wrapper, HTTP
  serving, and the `show_widget` tool live in core (`src/canvas/`); the Canvas
  plugin owns the macOS node-panel presenter and the A2UI
  dashboard content kind. The `pluginSurfaceUrls["canvas"]` advertisement and
  `/__openclaw__/canvas` paths are shipped native-client contracts and stay
  stable. Discord Activities register a contextual presenter behind core's
  canonical `show_widget` tool.

## Current boundaries

- Boards do not introduce a separate sharing or ACL model. Session visibility
  and membership use the existing session-sharing surface; widget capability
  grants remain separate from membership.
- Native macOS/iOS board rendering is through the embedded Control UI; the
  inline-widget path is unchanged.
- Enabled plugins extend content kinds, data bindings, and action verbs through
  the existing registries.
