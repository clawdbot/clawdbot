---
summary: "Session dashboards: architecture and implementation plan (technical design, pre-GA)"
read_when:
  - Implementing or reviewing the session dashboard (boards) feature
  - Changing widget hosting, the widget bridge, or board storage
title: "Dashboard Architecture"
---

<Note>
Technical design document for the session dashboard feature, written before and
during implementation. It is the source of truth for the build-out. When the
feature ships, `/web/dashboard` becomes the user-facing page and this page stays
as the architecture reference.
</Note>

## Vision

Working with an agent today is a text stream. The dashboard makes it a
workbench: the agent renders live, interactive widgets; the user pins them onto
a persistent surface; chat docks to the side (or hides) and the main content is
the board. You go from "talking to the agent" to "operating a control panel the
agent built for you" without ever leaving the session.

Principles:

- **A board is a face of a session, not a new object.** Every session (thread)
  has two faces: the transcript and the board. A session with no pinned widgets
  is plain chat. Pin one widget and the board exists. Boards inherit the
  session's identity, agent ownership, naming, pinning, and lifecycle. There is
  no `dashboard_create`, no board registry, no separate ACL model.
- **Agent parity.** Everything the user can do on a board, the agent can do
  with tools: add/update/remove widgets, arrange them, manage tabs, switch the
  visible tab, dock or hide the chat.
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

| Concept             | Definition                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session (thread)    | Existing gateway session, keyed by stable `sessionKey`. Owned by an agent.                                                                                        |
| Board               | The widget face of one session. Exists iff the session has widgets/tabs. Survives `/new`/`/reset` (attached to `sessionKey`, not the transcript).                 |
| Tab                 | A presentation page of a board: which widgets, their arrangement, and the chat dock state (`left`/`right`/`bottom`/`hidden`). Boards start with one implicit tab. |
| Widget              | Named, sandboxed HTML/JS program owned by the session. Addressed as `sessionKey` + `name`. Updated in place by name.                                              |
| Capability manifest | Per-widget declaration of reach: `data` (read bindings), `actions` (allowlisted verbs), `prompt` (send to session), `net` (allowed origins).                      |
| Pin (widget)        | Moving a transcript widget onto the session's board (user affordance or agent tool arg). Unpin removes it from the board.                                         |
| Pin (session)       | Existing sidebar pinning of sessions. A pinned session with a board opens on its board face.                                                                      |

## UX flows

- **Graduation:** agent calls `show_widget` in any chat → widget renders inline
  in the transcript exactly as today → hover shows **Pin to dashboard** → widget
  appears on the session's board. The agent can pass `pin: true` to do the same.
- **Board view:** a session with a board gets a face toggle (Chat / Dashboard).
  Board view = tab strip (only when >1 tab) + fluid grid + docked chat pane.
  Chat dock is resizable, movable (left/right/bottom), and collapsible exactly
  like the sidebar. Per-tab dock state is remembered.
- **Drag:** user drags widgets; grid auto-compacts (widgets float up, neighbors
  reflow). Resize by handle snaps to size steps. No pixel placement — for
  anyone.
- **Reset warning:** `/new` / `/reset` on a board-bearing session asks for
  confirmation in the web UI ("context resets, the dashboard stays") and keeps
  the board.
- **Sidebar:** pinned sessions render their board face when they have one.
  The Home session's board is the default "agent dashboard".
- **Interactions** (three tiers, see below): silent state events, visible
  prompt sends, and automation triggers.

## Interaction tiers

1. **State events (default).** Widget UI interactions the model should know
   about but not respond to. `bridge.emitState({...})` appends a structured
   session notice (same mechanism as group-activity notices). No agent turn is
   started; the model sees accumulated notices on its next run.
2. **Prompts (explicit talk).** `bridge.sendPrompt(text)` — requires user
   activation; sends a visible user message into the session (the docked chat
   shows it). Rate-limited; each send is user-confirmed unless the widget holds
   the `prompt` capability grant.
3. **Automation.** `bridge.runAction(name, args)` — fires a manifest-declared
   action. Initial verb set: `cron.trigger` (run an existing cron job now) and
   `binding.refresh`. Cron jobs already run in visible, isolated run-sessions
   and can use a cheaper model: that is the "small model powers the widget"
   path. No hidden sessions anywhere.

## Widget model and hosting

Widget HTML/JS is authored by the agent (typically via `show_widget`), wrapped
in the standard document shell (CSP meta, size reporter, bridge bootstrap) and
rendered in `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).

- **Inline (transcript) widgets** keep the current canvas-document pipeline:
  written under the state dir, served by the gateway, pruned per scope, no
  approval (they are capless by construction — prompt sends are user-confirmed).
- **Board widgets** are session state: bytes live in the owning agent's SQLite
  DB (`board_widgets`), served by a core gateway route
  (`/__openclaw__/board/<agentId>/<sessionKey>/<name>/`) that reads the DB.
  Pinning a transcript widget copies the bytes. Caps: 256 KB per widget,
  48 widgets per board.
- **Update in place:** re-emitting a widget with the same `name` replaces the
  bytes, bumps `revision`, broadcasts `board.changed`, and live views reload
  that iframe only.
- **Byte freezing:** granted capabilities bind to the sha256 of the widget
  bytes. Changing bytes keeps `data`/`net`/`actions` grants only if the new
  revision declares a subset of the granted manifest; a widened manifest
  re-prompts the operator.

### Widgets host content; MCP apps are one content kind

The **widget is the OpenClaw primitive**: the named, pinned, sized,
session-owned board cell with a grant record. What renders inside it is a
content kind:

- `html` — agent-authored via `show_widget`, bytes in board storage.
- `mcp-app` — a third-party MCP app view (`ui://` resource from a configured
  server) hosted inside the widget cell.

MCP apps do not define the widget model; widgets gained the ability to host
them. Identity, placement, pinning, grants, and the author-facing API stay
OpenClaw's — so `show_widget` code stays as short as it is today and never
needs to know the MCP Apps spec exists.

Shared infrastructure underneath (this is where the simplification lands):

- **One sandbox host.** `html` widgets render through the same hardened
  pipeline MCP apps shipped with (double-iframe on the dedicated sandbox
  origin, per-widget CSP declared and fail-closed decoded) instead of a second
  bespoke iframe host. The proxy receives HTML by value, so local content is
  the natural case.
- **One authorization model.** A widget's reach is a granted allowlist,
  whatever its kind: for `html` widgets, host tools; for `mcp-app` widgets,
  the server's app-visible tools (via the existing `allowedAppToolNames`
  mechanism, made durable per widget instead of per-minting-run).
- **Host tools for `html` widgets** (exposed over the widget bridge, checked
  against the grant):
  - `openclaw.prompt.send` — tier 2; routed through the visible composer,
    user-confirmed unless granted
  - `openclaw.state.emit` — tier 1 session notices (coalesced, size-capped)
  - `openclaw.data.read` — parameterized read-only bindings (existing
    allowlisted read RPC set), resolved gateway-side
  - `openclaw.cron.trigger` — tier 3 automation
- **`net` = CSP.** Network reach uses the already-shipped per-widget CSP
  declaration (`connect-src` origins) — the self-updating weather widget
  fetches its API directly from the sandbox, no gateway involvement.
- **Grants.** A widget declaring nothing renders immediately (sandboxed,
  `default-src 'none'`, prompt sends individually confirmed) — same trust as
  today's inline chat widgets. Declared tools/origins put the widget in
  `pending` on the board: a placeholder card lists them human-readably with
  one-tap **Allow**/**Reject**. Grants are per widget name; for `html` widgets
  they are byte-frozen (sha256), and changed bytes keep the grant only if the
  declaration shrank.
- **Authoring shim.** The document wrapper injects
  `window.openclaw.sendPrompt/emitState/read/call` as the stable author API;
  whether the transport underneath is our channel or the AppBridge is an
  internal detail the widget author never sees. Size reporting and theme
  tokens ride the same bridge.

### Transcript display: one widget card

Inline display unifies on the widget primitive. When a tool result carries UI —
`show_widget` output or an MCP tool result with an app resource — the system
materializes an **ephemeral, auto-named widget** (session-scoped, pruned) and
the transcript renders a single widget card that dispatches on content kind.
MCP app auto-display stays exactly as the spec expects (zero extra model work);
it just _is_ a widget underneath. This deletes the parallel `mcpApp`
special-cases in chat rendering (surface gating, separate dedup), gives every
inline UI the same pin affordance, and makes the widget registry the primary
re-open path (transcript-scan reconstruction stays as fallback for never-pinned
history). The read-only ticketed standalone host overlaps with boards as a
persistent re-open surface — consolidation candidate to evaluate in T6, not
assumed.

Composition: v1 is grid adjacency (agent chrome widget next to an app widget on
one tab). v2 adds **host-managed app slots** — agent widget HTML declares a
slot region and the host composites the real app view as a sibling sandbox.
The app never renders inside the agent's iframe: nesting would break bridge
identity and enable overlay/clickjack of granted app UI, so the slot is a
layout contract, not an embed.

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
from the minting run. Ungranted pins stay read-only — still useful for display
dashboards. v1 pins to the originating session's board; cross-session pinning
needs a lease broker and waits. Coordinate with open PR #109807 (`ui/message`
composer routing, theme/size propagation).

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

New tables in `agents/<agentId>/agent/openclaw-agent.sqlite`
(**requires an agent-DB schema-version bump — operator sign-off required
before this lands**):

```sql
CREATE TABLE board_tabs (
  session_key TEXT NOT NULL,
  tab_id      TEXT NOT NULL,           -- slug
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  chat_dock   TEXT NOT NULL DEFAULT 'right',  -- left|right|bottom|hidden
  created_by  TEXT NOT NULL,           -- 'user' | 'agent'
  PRIMARY KEY (session_key, tab_id)
) STRICT;

CREATE TABLE board_widgets (
  session_key  TEXT NOT NULL,
  name         TEXT NOT NULL,          -- stable widget name
  tab_id       TEXT NOT NULL,
  title        TEXT,
  html         BLOB NOT NULL,          -- wrapped document source
  sha256       TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  size_w       INTEGER NOT NULL,
  size_h       INTEGER NOT NULL,
  position     INTEGER NOT NULL,       -- order within tab (auto-compact input)
  manifest     TEXT NOT NULL DEFAULT '{}',  -- capability manifest JSON
  grant_state  TEXT NOT NULL DEFAULT 'none', -- none|pending|granted|rejected
  granted_sha  TEXT,                   -- byte-frozen grant
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_key, name)
) STRICT;
```

Board existence = any rows for the `sessionKey`. Deleting a session deletes its
board rows. `/new`/`/reset` does not touch them.

## Protocol surface

RPCs (core method table, typebox schemas in `gateway-protocol`):

- `board.get { sessionKey }` → tabs + widget metadata (no bytes) — `operator.read`
- `board.update { sessionKey, ops[] }` — tab CRUD/reorder, widget move/resize/
  remove/unpin, dock state, focus-tab — `operator.write`
- `board.widget.put { sessionKey, name, html, manifest, placement }` —
  `operator.write` (agent tool path and pin path)
- `board.widget.grant { sessionKey, name, decision }` — `operator.approvals`
- `board.event { sessionKey, widget, payload }` — tier-1 state event ingest —
  `operator.write`

Events (in `EVENT_SCOPE_GUARDS`, read scope):

- `board.changed { sessionKey, revision, widget? }` — persisted state changed;
  UI refetches (and reloads one iframe when `widget` is present).
- `board.command { sessionKey, command }` — transient UI drive (agent switches
  the visible tab, toggles chat dock) — the `ui.command` pattern.

Widget bytes are served over the authenticated HTTP surface, not the socket.

## Agent tools

Three tools total (core, always registered; rendering gated on the
`inline-widgets` client cap as today):

- `show_widget { title, widget_code, name?, pin?, size?, tab?, after?,
capabilities? }` — create/update by name; `pin` places it on the board.
  Without `name`/`pin` it behaves exactly like today (inline, ephemeral).
- `dashboard { action, ... }` — board management verbs: `read`, `tab_create`,
  `tab_update`, `tab_delete`, `tabs_reorder`, `widget_move`, `widget_remove`,
  `unpin`, `focus_tab`, `set_chat_dock`.
- Existing `cron` tools cover the automation tier; no new tool needed.

Tool descriptions teach the size/anchor vocabulary and the tier model. The
agent is told about user tier-1 events via session notices, e.g.
`[dashboard] user clicked "Refresh" on widget weather (tab main)`.

## What this replaces

- **`extensions/workspaces` is deleted.** Experimental, `enabledByDefault:
false`, never in a stable release (first appeared in 2026.7.2 betas). No
  migration; a doctor rule removes stale `<stateDir>/workspaces/` if present.
  Harvested ideas: pure grid math, bridge security model (port bootstrap,
  binding gating, rate limits), byte-frozen approval.
- **Widget hosting moves from `extensions/canvas` to core.** The canvas doc
  store, document wrapper, HTTP serving, and the `show_widget` tool become core
  (`src/canvas/`); the plugin keeps the node-canvas control tool (`canvas`) and
  A2UI. The `pluginSurfaceUrls["canvas"]` advertisement and
  `/__openclaw__/canvas` paths are shipped native-client contracts and stay
  stable. Discord sessions keep the Discord-owned `show_widget` variant.
- **WorkBoard is untouched** (integration is a follow-up program).

## Non-goals (this program)

- Multi-user board sharing/ACLs (future; will arrive via session sharing).
- Native macOS/iOS board rendering (they get it wherever they embed the
  Control UI; the inline-widget path is unchanged).
- Builtin data widgets (sessions/usage/cron cards) — the capability bridge plus
  agent-authored widgets cover v1; a builtin kind registry can come later.
- WorkBoard-on-dashboard.

## Implementation plan

Independent worktrees, Codex-built, review+land sequentially. Land-then-fix.

| #   | Branch                               | Scope                                                                                                                                                                              | Depends on                       |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| T1  | `claude/dashboard-remove-workspaces` | Delete workspaces plugin + UI + docs + i18n keys; doctor cleanup rule                                                                                                              | —                                |
| T2  | `claude/dashboard-canvas-core`       | Promote widget hosting + `show_widget` to core; canvas plugin keeps node tool; zero behavior change                                                                                | —                                |
| T3  | `claude/dashboard-domain`            | Agent-DB tables (schema bump), `board.*` RPCs + events, `dashboard` tool, `show_widget` pin/name/manifest args, tier-1 notices, reset-keeps-board                                  | T2                               |
| T4  | `claude/dashboard-ui`                | Board face + tab strip + fluid auto-compact grid + chat dock (left/right/bottom/hidden) + transcript pin affordance + sidebar board face + reset confirm                           | T3 (mock-first via dev fixtures) |
| T5  | `claude/dashboard-capabilities`      | Grant store/UI + byte freezing; move `html` widgets onto the shared sandbox host; host tools (`openclaw.prompt.send/state.emit/data.read/cron.trigger`); `net` CSP; authoring shim | T3, T4                           |
| T7  | `claude/dashboard-mcp-apps`          | `mcp-app` content kind: pin affordance on inline app views, descriptor storage, lease re-mint/refresh, durable server-tool grants (reuses shipped MCP Apps host)                   | T3, T4                           |
| T6  | polish                               | Live E2E on a scratch gateway (real keys), screenshots, fixes, user-focused `/web/dashboard` rewrite, enable-by-default review                                                     | all                              |

Validation per repo rules: focused vitest locally, full gates on
Crabbox/Testbox, `$autoreview` before every land, live proof for T6.
