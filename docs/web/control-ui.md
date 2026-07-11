---
summary: "Browser-based control UI for the Gateway (chat, activity, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
sidebarTitle: "Control UI"
---

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

It speaks **directly to the Gateway WebSocket** on the same port.

## Quick open (local)

If the Gateway is running on the same computer, open [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/)).

If the page fails to load, start the Gateway first: `openclaw gateway`.

<Note>
On native Windows LAN binds, Windows Firewall or organization-managed Group Policy can still block the advertised LAN URL even when `127.0.0.1` works on the Gateway host. Run `openclaw gateway status --deep` on the Windows host; it reports likely-blocked ports, profile mismatches, and local firewall rules that policy may ignore.
</Note>

Auth is supplied during the WebSocket handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
- Tailscale Serve identity headers when `gateway.auth.allowTailscale: true`
- trusted-proxy identity headers when `gateway.auth.mode: "trusted-proxy"`

The dashboard settings panel keeps a token for the current browser tab session and selected gateway URL; passwords are not persisted. Onboarding usually generates a gateway token for shared-secret auth on first connect, but password auth works too when `gateway.auth.mode` is `"password"`.

## Device pairing (first connection)

Connecting from a new browser or device usually requires a **one-time pairing approval**, shown as `disconnected (1008): pairing required`.

<Steps>
  <Step title="List pending requests">
    ```bash
    openclaw devices list
    ```
  </Step>
  <Step title="Approve by request ID">
    ```bash
    openclaw devices approve <requestId>
    ```
  </Step>
</Steps>

If the browser retries pairing with changed auth details (role/scopes/public key), the previous pending request is superseded and a new `requestId` is created; re-run `openclaw devices list` before approving.

Switching an already-paired browser from read access to write/admin access is treated as an approval upgrade, not a silent reconnect: OpenClaw keeps the old approval active, blocks the broader reconnect, and asks you to approve the new scope set explicitly.

Once approved, the device is remembered and won't require re-approval unless you revoke it with `openclaw devices revoke --device <id> --role <role>`. See [Devices CLI](/cli/devices) for token rotation, revocation, and the Paperclip / `openclaw_gateway` first-run approval flow.

<Note>
- Direct local loopback browser connections (`127.0.0.1` / `localhost`) are auto-approved.
- Tailscale Serve can skip the pairing round trip for Control UI operator sessions when `gateway.auth.allowTailscale: true`, Tailscale identity verifies, and the browser presents its device identity. Device-less browsers and node-role connections still follow the normal device checks.
- Direct Tailnet binds, LAN browser connects, and browser profiles without device identity still require explicit approval.
- Each browser profile generates a unique device ID, so switching browsers or clearing browser data requires re-pairing.

</Note>

## Pair a mobile device

An already paired administrator can create the iOS/Android connection QR without opening a terminal:

<Steps>
  <Step title="Open mobile pairing">
    Select **Nodes**, then click **Pair mobile device** in the **Nodes & devices** card.
  </Step>
  <Step title="Connect the phone">
    In the OpenClaw mobile app, open **Settings** → **Gateway** and scan the QR code. You can copy and paste the setup code instead.
  </Step>
  <Step title="Confirm the connection">
    The official iOS/Android app connects automatically. If **Pending approval** shows a request, review its role and scopes before approving it.
  </Step>
</Steps>

Creating a setup code requires `operator.admin`; the button is disabled for sessions without it. A setup code contains a short-lived bootstrap credential, so treat the QR and copied code like a password while they are valid. For remote pairing, the Gateway must resolve to `wss://` (for example, through Tailscale Serve/Funnel); plain `ws://` is limited to loopback and private LAN addresses. See [Pairing](/channels/pairing#pair-from-the-control-ui-recommended) for the full security and fallback details.

## Personal identity (browser-local)

The Control UI supports a per-browser personal identity (display name and avatar) attached to outgoing messages, for attribution in shared sessions. It lives in browser storage, scoped to the current browser profile, and is not synced to other devices or persisted server-side beyond the normal transcript authorship metadata on messages you send. Clearing site data or switching browsers resets it to empty.

The assistant avatar override follows the same browser-local pattern: uploaded overrides overlay the gateway-resolved identity locally and never round-trip through `config.patch`. The shared `ui.assistant.avatar` config field is still available for non-UI clients that write the field directly.

## Runtime config endpoint

The Control UI fetches its runtime settings from `/control-ui-config.json`, resolved relative to the gateway's Control UI base path (for example `/__openclaw__/control-ui-config.json` under base path `/__openclaw__/`). That endpoint is gated by the same gateway auth as the rest of the HTTP surface: unauthenticated browsers cannot fetch it, and a successful fetch requires a valid gateway token/password, Tailscale Serve identity, or a trusted-proxy identity.

## Gateway host status

Open **Settings** in Simple view to see the **Gateway Host** card with the Gateway machine, LAN address, operating system, runtime, uptime, CPU load, memory, and state-volume disk space. The card refreshes every 10 seconds while visible through the `system.info` Gateway RPC, which requires the `operator.read` scope. Older Gateways and connections without that scope omit the card.

## Language support

The Control UI localizes itself on first load based on your browser locale. To override it later, open **Overview -> Gateway Access -> Language** (the picker lives in the Gateway Access card, not under Appearance).

- Supported locales: `en`, `ar`, `de`, `es`, `fa`, `fr`, `hi`, `id`, `it`, `ja-JP`, `ko`, `nl`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

Docs translations are generated for the same non-English locale set, but the docs site's built-in Mintlify language picker only lists locale codes Mintlify accepts. Thai (`th`) and Persian (`fa`) docs are still generated in the publish repo; they may not appear in that picker until Mintlify supports those codes.

## Appearance themes

The Appearance panel has the built-in Claw, Knot, and Dash themes (Claw is default), plus one browser-local tweakcn import slot. To import a theme, open the [tweakcn editor](https://tweakcn.com/editor/theme), choose or create a theme, click **Share**, and paste the copied link into Appearance. The importer also accepts `https://tweakcn.com/r/themes/<id>` registry URLs, editor URLs like `https://tweakcn.com/editor/theme?theme=amethyst-haze`, relative `/themes/<id>` paths, raw theme IDs, and default theme names such as `amethyst-haze`.

Imported themes are stored only in the current browser profile; they are not written to gateway config and do not sync across devices. Replacing the imported theme updates the one local slot; clearing it switches back to Claw if the imported theme was active.

Appearance also has a browser-local Text size setting, stored with the rest of Control UI preferences. It applies to chat text, composer text, tool cards, and chat sidebars, and keeps text inputs at least 16px so mobile Safari does not auto-zoom on focus.

## Manage plugins

Open **Plugins** in the sidebar, or use `/settings/plugins` relative to the
configured Control UI base path, to browse and manage plugins without leaving
the Control UI. For example, a base path of `/openclaw` uses
`/openclaw/settings/plugins`. The page is always available, even when every
optional plugin is disabled.

The **Installed** tab shows the full local inventory grouped by category, with
overview counts. Each row opens a detail view; its overflow (`…`) menu enables
or disables the plugin and offers **Remove** for externally installed plugins.
It also lists configured [MCP servers](/cli/mcp) and supports adding, disabling,
and removing them inline. The **Discover** tab is the store: featured plugins
included with OpenClaw, official external plugins, and one-click MCP connectors
for popular services. Typing in the search box queries
[ClawHub](https://clawhub.ai/plugins) inline and appends a **From ClawHub**
section with download counts and source-verification badges.

Included plugins are already present on the Gateway and show **Enable** or
**Disable** instead of **Install**. For example, Workboard is included with
OpenClaw but disabled by default, so its action is **Enable**. Bundled plugins
cannot be removed, only disabled.

Reading the catalog and searching ClawHub require `operator.read`. Installing,
enabling, disabling, or removing a plugin and changing MCP servers require
`operator.admin`; those actions stay disabled for read-only operators.

ClawHub installs run through the Gateway and keep the same trust, integrity,
and plugin-install policy checks as other Gateway-mediated installs. Installing
or removing plugin code requires a Gateway restart. Enabling or disabling an
installed plugin can apply without a restart when the plugin and current
Gateway runtime support it; otherwise the UI reports that a restart is
required. OAuth-backed MCP connectors need a one-time
`openclaw mcp login <name>` from the CLI after they are added.

The page intentionally focuses on inventory, discovery, install, enablement,
and removal. Use [`openclaw plugins`](/cli/plugins) for arbitrary npm, git, or
local-path sources, updates, and advanced plugin configuration.

## Sidebar navigation

The sidebar pins navigation above a scrollable session list. In multi-agent setups every agent appears as a collapsible top-level section; expanding an agent browses its sessions without navigating away from the open chat, and collapsed agents show an unread indicator. Within an agent the list splits into **Pinned**, one built-in section per connected channel (Telegram, Slack, WhatsApp, ...), a built-in **Work** section for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), custom groups (the session `category`), and **Chats** for the rest. Channel and Work sections classify rows automatically; assigning a session to a custom group always wins. Opening a session moves the selection highlight without reordering the rows. Sessions with new activity since they were last read show an unread dot, and opening one marks it read. Each session row has a context menu (kebab button or right-click) with Pin/Unpin, Mark as unread/read, Rename, Fork, Move to group (including New group and Remove from group), Archive, and Delete; touch layouts keep the direct pin and menu controls visible. Drag a session onto a custom group or **Chats** to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names and their order live in the gateway (`sessions.groups.*`), so they follow you across browsers, while the collapsed state stays in the browser profile. Group headers also have a menu (kebab button or right-click) with Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Chats. The single **+** in the session-list header opens the New session page (see below). The sort control also has a Group by toggle: Grouped (default) or None for one flat list (Pinned stays separate); the choice is stored in the current browser profile. **Overview** is the only destination pinned by default; expand **More** to reach every other destination. Select **Edit pinned items** under More, or right-click the navigation area, to pin or unpin destinations and restore the defaults. The pinned set and More expansion state are stored in the current browser profile and survive reloads.

## New session page

The **+** in the sidebar session-list header opens a full-page draft at `/new`: nothing is created until you send the first message. A target row above the message box picks where the session works: the agent (multi-agent setups), where exec runs (**Gateway · local** or a paired node that exposes `system.run`; requires `operator.admin`), the folder (defaults to the agent workspace; other absolute host paths require `operator.admin` and a worktree), and an optional **Worktree** toggle with a base-branch picker (backed by `worktrees.branches`, so no fetch happens) and an optional worktree name (the branch becomes `openclaw/<name>`). Admins can browse the gateway host filesystem instead of typing a path: the folder chip's browse button opens an inline directory picker (backed by the admin-only `fs.listDir` method) that starts from the current folder or the gateway home directory. Browsing is unavailable when exec runs on a paired node; type the node-side path instead. Submitting calls `sessions.create` with the first message, so the run starts in the same round-trip and the UI jumps to the new session's chat.

Inside **Settings**, the dedicated sidebar starts with a **Search settings** field for quickly finding settings sections.

A **Search** field at the top of the sidebar opens the command palette (⌘K). The compact footer keeps connection status, **Settings**, **Docs**, mobile pairing, and the light/dark/system color-mode toggle together; when the gateway runs from a source checkout on a branch other than `main`, the footer also shows that branch name in red so a non-release gateway is obvious at a glance (release installs never show it). Shift-Command-Comma opens **Settings** without overriding the browser's Command-Comma shortcut. The sidebar header also holds the collapse toggle (⌘B); collapsing hides the sidebar entirely for a full-width workspace, and a floating expand control (or ⌘B) brings it back. The sidebar is the only navigation chrome on desktop, with no top bar. Narrow viewports swap the sidebar for a slide-over drawer behind a compact header row holding the drawer toggle, brand, and command-palette search; in the macOS app that header row folds the titlebar clearance into a single compact strip beside the window controls. Navigation uses regular browser history, so the browser's back/forward buttons traverse it; the macOS app adds native back/forward buttons next to the window controls, plus trackpad swipe gestures.

## What it can do (today)

<AccordionGroup>
  <Accordion title="Chat and Talk">
    - Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`).
    - Chat history refreshes request a bounded recent window with per-message text caps, so large sessions do not force the browser to render a full transcript payload before chat becomes usable.
    - Hovering or keyboard-focusing a public GitHub issue or pull request link shows its state, title, author, recent activity, comments, and change statistics. The connected Gateway fetches and caches public metadata without changing the link target, including when the UI uses a remote Gateway. The Gateway uses `GH_TOKEN` or `GITHUB_TOKEN` when available, after confirming the repository is public; otherwise it uses GitHub's anonymous API with a longer cache.
    - Talk through browser realtime sessions. OpenAI uses direct WebRTC, Google Live uses a constrained one-use browser token over WebSocket, and backend-only realtime voice plugins use the Gateway relay transport. Client-owned provider sessions start with `talk.client.create`; Gateway relay sessions start with `talk.session.create`. The relay keeps provider credentials on the Gateway while the browser streams microphone PCM through `talk.session.appendAudio`, forwards `openclaw_agent_consult` provider tool calls through `talk.client.toolCall` for Gateway policy and the larger configured OpenClaw model, and routes active-run voice steering through `talk.client.steer` or `talk.session.steer`.
    - Stream tool calls and live tool output cards in Chat (agent events). Tool activity renders as kind-aware rows: shell commands show the syntax-highlighted command with terminal-style output; supported edit and write calls show bounded inline diffs, line numbers when available, and `+added -removed` stats; and consecutive calls collapse into a summary such as "Ran 13 commands, read 6 files, edited 9 files". While a run is live, the newest running call names the group header. Expand a row to inspect its remaining arguments and raw output.
    - Optional AI purpose titles for complex tool calls (long shell commands, argument-heavy plugin tools), enabled with `gateway.controlUi.toolTitles: true` (default off). Titles come from the batched `chat.toolTitles` method through standard utility-model routing — an explicit `utilityModel` (operator-chosen provider, like other utility tasks), else the session provider's declared small-model default — and cache gateway-side per agent. When the opt-in is off or no cheap model is usable, rows keep their deterministic labels and no model call happens.
    - Start or dismiss ephemeral model-suggested follow-up tasks; accepted suggestions open a fresh managed-worktree session with the proposed prompt.
    - Activity tab with browser-local, redaction-first summaries of live tool activity from existing `session.tool` / tool event delivery.

  </Accordion>
  <Accordion title="Channels, instances, sessions, dreams">
    - Channels: built-in plus bundled/external plugin channels status, QR login, and per-channel config (`channels.status`, `web.login.*`, `config.patch`).
    - Channel probe refreshes keep the previous snapshot visible while slow provider checks finish, and label partial snapshots when a probe or audit exceeds its UI budget.
    - Instances: presence list and refresh (`system-presence`).
    - Sessions: list configured-agent sessions by default, pin frequent sessions, rename them, archive or restore inactive sessions, fall back from stale unconfigured agent session keys, and apply per-session model/thinking/fast/verbose/trace/reasoning overrides (`sessions.list`, `sessions.patch`). Pinned sessions sort above recent unpinned sessions; archived sessions live in the Sessions page's archived view and keep their transcripts. Rows show an unread dot for sessions with activity since their last read, with mark-unread/mark-read actions (`sessions.patch { unread }`), and a Fork action that branches the transcript into a new session (`sessions.create { parentSessionKey, fork: true }`). Overview tiles above the table summarize the loaded roster (session count, live runs, unread sessions, total tokens), each row carries a kind glyph with a live-run dot, status renders as a plain dot plus label, and the Tokens column shows a context-window usage meter when the session reports token and context sizes. Row management actions live in a per-row menu (kebab button or right-click) mirroring the sidebar's session menu, and the row drawer carries the agent runtime and run duration alongside the other session details.
    - Session grouping: a Group by control organizes the sessions table into sections by custom groups, channel, kind, agent, or date. Custom groups persist per session via `sessions.patch` (`category`), so sessions started from message channels (Discord, Telegram, WhatsApp, ...) can be categorized too; assign groups by dragging rows onto a section, or with the per-row group selector, and create groups with the New group action.
    - Dreams: dreaming status, enable/disable toggle, and Dream Diary reader (`doctor.memory.status`, `doctor.memory.dreamDiary`, `config.patch`).

  </Accordion>
  <Accordion title="Cron, tasks, plugins, skills, nodes, exec approvals">
    - Cron jobs: list/add/edit/run/enable/disable plus run history (`cron.*`).
    - Tasks: live active and recent background task ledger with linked sessions and cancellation (`tasks.*`).
    - Plugins: browse the installed inventory and curated store, search ClawHub, install and remove plugin code, and enable or disable installed plugins (`plugins.*`); MCP server rows edit `mcp.servers` through the config methods.
    - Skills: status, enable/disable, install, API key updates (`skills.*`).
    - Nodes: one **Nodes & devices** inventory that joins paired device records with the node catalog (`node.list`, `device.pair.list`) — one entry per machine with roles, live link status, tokens, and capabilities. Duplicate pairings of the same client collapse into an expandable group, and **Clean up N stale** bulk-removes superseded pairings that are offline and were auto-approved (silent local or trusted-CIDR), so affected clients re-pair without user action. Entries can be removed (`node.pair.remove`, `device.pair.remove`), device pairing and node re-approvals handled inline (`device.pair.*`, `node.pair.approve`/`reject`), and mobile setup codes created from the same card.
    - Exec approvals: edit gateway or node allowlists and ask policy for `exec host=gateway/node` (`exec.approvals.*`).

  </Accordion>
  <Accordion title="Config">
    - View/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`).
    - Profile: a settings page showing the default agent's identity with all-time usage stats — lifetime tokens, peak day, longest session, activity streaks, a year-long token heatmap, top tools, and channel highlights (`usage.cost`, `sessions.usage`).
    - MCP has a dedicated settings page for configured servers, enablement, OAuth/filter/parallel summaries, common operator commands, and the scoped `mcp` config editor.
    - Model Providers: a settings page listing every configured model provider with its brand icon, auth state (`models.authStatus`), model availability (`models.list`), live plan/quota/billing data where the provider reports it (`usage.status`), and local session spend for the last 30 days (`sessions.usage`). A Refresh action re-reads credential state and provider usage.
    - Apply and restart with validation (`config.apply`), then wake the last active session.
    - Writes include a base-hash guard to prevent clobbering concurrent edits.
    - Writes (`config.set`/`config.apply`/`config.patch`) preflight active SecretRef resolution for refs in the submitted config payload; unresolved active submitted refs are rejected before write.
    - Form saves discard stale redacted placeholders that cannot be restored from the saved config, while preserving redacted values that still map to saved secrets.
    - Schema and form rendering come from `config.schema` / `config.schema.lookup`, including field `title`/`description`, matched UI hints, immediate child summaries, docs metadata on nested object/wildcard/array/composition nodes, plus plugin and channel schemas when available. Raw JSON editor is available only when the snapshot has a safe raw round-trip; otherwise Control UI forces Form mode.
    - Raw JSON editor "Reset to saved" preserves the raw-authored shape (formatting, comments, `$include` layout) instead of re-rendering a flattened snapshot, so external edits survive a reset when the snapshot can safely round-trip.
    - Structured SecretRef object values render read-only in form text inputs, to prevent accidental object-to-string corruption.

  </Accordion>
  <Accordion title="Usage">
    - Session-derived token and estimated-cost analysis stays separate from provider billing.
    - Provider cards call `usage.status` and show live plan names, quota windows, balances, spend, and budgets reported by configured provider plugins.
    - A provider usage failure does not block the session/cost dashboard; unavailable provider cards show their own error state.

  </Accordion>
  <Accordion title="Debug, logs, update">
    - Debug: status/health/models snapshots, event log, and manual RPC calls (`status`, `health`, `models.list`).
    - The event log includes Control UI refresh/RPC timings, slow chat/config render timings, and browser responsiveness entries for long animation frames or long tasks when the browser exposes those PerformanceObserver entry types.
    - Logs: live tail of gateway file logs with filter/export (`logs.tail`).
    - Update: run a package/git update plus restart (`update.run`) with a restart report, then poll `update.status` after reconnect to verify the running gateway version.

  </Accordion>
  <Accordion title="Cron jobs panel notes">
    - For isolated jobs, delivery defaults to announce summary; switch to none for internal-only runs.
    - Channel/target fields appear when announce is selected.
    - Webhook mode uses `delivery.mode = "webhook"` with `delivery.to` set to a valid HTTP(S) webhook URL.
    - For main-session jobs, webhook and none delivery modes are available.
    - Advanced edit controls include delete-after-run, clear agent override, cron exact/stagger options, agent model/thinking overrides, and best-effort delivery toggles.
    - Form validation is inline with field-level errors; invalid values disable the save button until fixed.
    - Set `cron.webhookToken` to send a dedicated bearer token; if omitted, the webhook is sent without an auth header.
    - `cron.webhook` is a deprecated legacy fallback: run `openclaw doctor --fix` to migrate stored jobs that still use `notify: true` to explicit per-job webhook or completion delivery.

  </Accordion>
</AccordionGroup>

## MCP page

The dedicated MCP page is an operator view for OpenClaw-managed MCP servers under `mcp.servers`. It does not start MCP transports by itself; use it to inspect and edit saved config, then use `openclaw mcp doctor --probe` when you need live server proof.

Typical workflow:

1. Open **MCP** from the sidebar.
2. Check the summary cards for total, enabled, OAuth, and filtered server counts.
3. Review each server row for transport, enablement, auth, filters, timeouts, and command hints.
4. Toggle enablement when a server should remain configured but stay out of runtime discovery.
5. Edit the scoped `mcp` config section for server definitions, headers, TLS/mTLS paths, OAuth metadata, tool filters, and Codex projection metadata.
6. Use **Save** for a config write, or **Save & Publish** when the running Gateway should apply the changed config.
7. Run `openclaw mcp status --verbose`, `openclaw mcp doctor --probe`, or `openclaw mcp reload` from a terminal for static diagnostics, live proof, or cached-runtime disposal.

The page redacts credential-bearing URL-like values before rendering and quotes server names in command snippets so copied commands still work with spaces or shell metacharacters. Full CLI and config reference: [MCP](/cli/mcp).

## Activity tab

The Activity tab is an ephemeral browser-local observer for live tool activity, derived from the same Gateway `session.tool` / tool event stream that powers Chat tool cards. It does not add another Gateway event family, endpoint, durable activity store, metrics feed, or external observer stream.

Activity entries keep only sanitized summaries and redacted, truncated output previews. Tool argument values are not stored in Activity state; the UI shows that arguments are hidden and records only the argument field count. The in-memory list follows the current browser tab, survives navigation within the Control UI, and resets on page reload, session switch, or **Clear**.

## Operator terminal

The dockable operator terminal is disabled by default. To enable it, set `gateway.terminal.enabled: true` and restart the Gateway. The terminal requires an `operator.admin` connection and opens a host PTY in the active agent workspace. New tabs follow the currently selected chat agent.

<Warning>
The terminal is an unconfined host shell and inherits the Gateway process environment. Enable it only for trusted operator deployments. OpenClaw refuses terminal sessions for agents with `sandbox.mode: "all"`; changing an active agent to that mode closes its existing and in-flight terminal sessions.
</Warning>

Use **Ctrl + backtick** to toggle the dock. The layout supports bottom and right docking, resizes with the browser viewport, and keeps multiple shell tabs. See [Gateway configuration](/gateway/configuration-reference#gateway) for `gateway.terminal.enabled` and the optional `gateway.terminal.shell` override.

Sessions survive disconnects: a page reload, laptop sleep, or network blip detaches the session on the Gateway instead of killing it, and the same browser tab reattaches on reconnect with recent output replayed. Detached sessions are killed after `gateway.terminal.detachedSessionTimeoutSeconds` (default 300 seconds; `0` restores kill-on-disconnect). `terminal.list` shows attachable sessions, `terminal.attach` adopts one (tmux-style take-over), and `terminal.text` reads a session's recent output as plain text without attaching - an agent/tooling affordance.

The terminal is also available as a full-screen, terminal-only document at `/?view=terminal`. The iOS and Android apps embed this page in their Terminal screens, reusing the stored gateway credentials; availability follows the same `gateway.terminal.enabled` and `operator.admin` gate, and the page shows a notice when the connected Gateway does not offer the terminal.

## Browser panel

The Control UI ships a dockable browser panel that renders the Gateway-controlled browser (the same one agents drive through the [browser tool](/tools/browser-control)) in any regular web browser - no native webview required. It appears when the connected Gateway advertises `browser.request` to an `operator.admin` connection; the globe button in the session workspace rail toggles it. The panel shows a live page snapshot with tabs, an editable URL bar, back/forward/reload, and open-in-your-browser, docks right or bottom, and forwards clicks, wheel scrolling, and basic typing to the remote page.

Two capture modes package page context for the agent:

- **Annotate (pencil)**: draw freehand markup over the page. **Send to chat** composites the strokes into the screenshot, attaches the image to the active chat composer, and prefills a prompt describing the page URL, title, and each marked region so the agent knows exactly what you circled.
- **Inspect (pointer)**: hover to see the element under the cursor (selector, accessible name, role, size); click to send that element's details plus a highlighted screenshot through the same composer flow. Inspect, wheel scrolling, and back/forward need `browser.evaluateEnabled` (on by default).

The macOS app keeps its native link-browser sidebar for links clicked in the dashboard; the browser panel works there too, and is the way to annotate pages on every other platform.

## Chat behavior

<AccordionGroup>
  <Accordion title="Send and history semantics">
    - `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events. Trusted Control UI clients may also receive optional ACK timing metadata for local diagnostics.
    - Chat uploads accept images plus non-video files. Images keep the native image path; other files are stored as managed media and shown in history as attachment links.
    - Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.
    - `chat.history` responses are size-bounded for UI safety. When transcript entries are too large, Gateway may truncate long text fields, omit heavy metadata blocks, and replace oversized messages with a placeholder (`[chat.history omitted: message too large]`).
    - When a visible assistant message was truncated in `chat.history`, the side reader can fetch the full display-normalized transcript entry on demand through `chat.message.get` by `sessionKey`, active `agentId` when needed, and transcript `messageId`. If the Gateway still cannot return more, the reader shows an explicit unavailable state instead of silently repeating the truncated preview.
    - Assistant/generated images are persisted as managed media references and served back through authenticated Gateway media URLs, so reloads do not depend on raw base64 image payloads staying in the chat history response.
    - When rendering `chat.history`, the Control UI strips display-only inline directive tags from visible assistant text (for example `[[reply_to_*]]` and `[[audio_as_voice]]`), plain-text tool-call XML payloads (including `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks), and leaked ASCII/full-width model control tokens. It omits assistant entries whose whole visible text is only the exact silent token `NO_REPLY` / `no_reply` or the heartbeat acknowledgement token `HEARTBEAT_OK`.
    - During an active send and the final history refresh, the chat view keeps local optimistic user/assistant messages visible if `chat.history` briefly returns an older snapshot; the canonical transcript replaces those local messages once the Gateway history catches up.
    - Live `chat` events are delivery state, while `chat.history` is rebuilt from the durable session transcript. After tool-final events the Control UI reloads history and merges only a small optimistic tail; the transcript boundary is documented in [WebChat](/web/webchat).
    - `chat.inject` appends an assistant note to the session transcript and broadcasts a `chat` event for UI-only updates (no agent run, no channel delivery).
    - The sidebar lists every loaded active session by agent section and pinned/channel/work/custom/Chats buckets with a single New Session action that opens the draft dialog. Opening a visible row moves only the highlight. Custom groups are collapsible and drag-reorderable, and sessions can be dropped onto a group or Chats; group names and order sync through the gateway while the collapsed state stays in the browser. A new dashboard session asynchronously gets a concise generated title from its first non-command message; explicit names are never replaced. Set `agents.defaults.utilityModel` (or `agents.list[].utilityModel`) to route this separate model call to a lower-cost model. Expanding another agent section browses that agent's sessions without leaving the open chat.
    - Session search lives in the command palette (⌘K, or the Search field at the top of the sidebar): typing a query follows a bounded number of matching pages across agents, filters internal child/cron rows, and lists visible matches next to navigation commands. The Sessions page keeps the exhaustive searchable list with filters.
    - Each sidebar row keeps direct pin access plus a full context menu for unread state, rename, fork, grouping, archive, and delete. An active run and an agent's main session cannot be archived. Archiving or deleting the currently selected session switches Chat back to that agent's main session.
    - In the macOS app, the OpenClaw mark uses the otherwise-empty native titlebar strip next to the window controls instead of consuming a sidebar row.
    - On desktop widths, chat controls stay on one compact row and collapse while scrolling down the transcript; scrolling up, returning to the top, or reaching the bottom restores the controls.
    - Consecutive duplicate text-only messages render as one bubble with a count badge. Messages that carry images, attachments, tool output, or canvas previews are left uncollapsed.
    - When a session's checkout sits on a non-default branch of a GitHub repository, the chat view pins pull request chips above the composer: PR number, repo, branch, diff counts, a CI pill, and draft/merged/closed state, each linking to the PR. The row shows at most two chips — live (open/draft) PRs first — and a "Show more" button reveals collapsed merged/closed history. The CI pill opens a small CI monitoring popover with passed/failed/running/skipped check counts and a link to the PR's checks page. Detection runs server-side through `controlUi.sessionPullRequests`, which reuses the Gateway's `GH_TOKEN`/`GITHUB_TOKEN` when set. When the GitHub API rate limit is hit, chips keep the last known status and show a warning that the status may be out of date; dismissing a chip hides it for that session in the current browser profile.
    - The session diff panel shows what a session's checkout actually changed: the branch button (in the workspace rail header, the split-pane header, or the floating button in single-pane chat) opens the detail panel with a per-file diff of branch, uncommitted, and untracked work against the checkout's default-branch merge base — status dot, rename arrow, per-file +/− counts, collapsible files, and "N unmodified lines" markers between hunks. Diffs are computed server-side through the `sessions.diff` Gateway method (`operator.read` scope); binary and oversized files degrade to stats-only entries, and the button only appears when the connected Gateway advertises `sessions.diff`.
    - The session workspace rail in each Chat pane lists session files, project files, and artifacts. It docks to the pane's right edge by default; drag its header (or use the dock button) to move it to the bottom, and the choice is stored in the current browser profile. A collapsed rail takes no space at all: reopen it with ⇧⌘B, the files toggle in the split-pane header, or the floating files button in single-pane chat (both carry a changed-file count badge). The separate file, tool, and Canvas detail panel is unaffected.
    - The background tasks rail in each Chat pane lists the current agent's background tasks and subagents (`tasks.list` scoped by agent, kept live by `task` events): running work with a stop control, a collapsible finished section, and a View transcript link that opens the task's child session in the pane. Open it with the activity toggle in the split-pane header or the floating activity button in single-pane chat (both carry a running-count badge once loaded). The Tasks page remains the full cross-agent ledger.
    - The workspace rail and detail panel adapt to each pane's own width rather than the window: in a narrow pane or compact window the workspace rail always presents as a bottom strip (side-dock controls hide until the pane widens), and the detail panel stacks below the thread with a horizontal resize handle instead of sharing the row with it. Phone-sized viewports still open the detail panel full-screen.
    - The chat header model and thinking pickers patch the active session immediately through `sessions.patch`; they are persistent session overrides, not one-turn-only send options.
    - **Split view:** open it from the bottom-right page action, then split the active pane right or down for as many panes as fit. Each pane has its own session, transcript, composer, and tool stream.
    - Drag a session from the sidebar into chat to open it in a pane. An animated drop preview glides between zones and labels the outcome — "Split" over the exact half a new pane will occupy, "Open here" over a whole pane — and drops also work from single-pane mode.
    - The active split pane drives the sidebar selection and URL. Each pane carries its own header row with the session title plus workspace-rail, split, and close controls; dividers resize columns and stacked panes, and the browser stores the layout locally across reloads.
    - On narrow screens, split view keeps the layout but renders only the active pane, including its header with the close control.
    - If you send a message while a model picker change for the same session is still saving, the composer waits for that session patch before calling `chat.send` so the send uses the selected model.
    - Typing `/new` creates and switches to the same fresh dashboard session as New Chat, except when `session.dmScope: "main"` is configured and the current parent is the agent's main session; then it resets the main session in place. Typing `/reset` keeps the Gateway's explicit in-place reset for the current session.
    - The chat model picker requests the Gateway's configured model view. If `agents.defaults.models` is present, that allowlist drives the picker, including `provider/*` entries that keep provider-scoped catalogs dynamic. Otherwise the picker shows explicit `models.providers.*.models` entries plus providers with usable auth. The full catalog stays available through the debug `models.list` RPC with `view: "all"`.
    - When fresh Gateway session usage reports include current context tokens, the chat composer toolbar shows a small context usage ring with the used percentage. Open the ring for the current context window, latest-run token counts and estimated total cost, provider/model identity, and the latest provider response's input/output/cache cost breakdown when reported. The ring switches to warning styling at high context pressure and, at recommended compaction levels, shows a compact button that runs the normal session compaction path. Stale token snapshots are hidden until the Gateway reports fresh usage again.

  </Accordion>
  <Accordion title="Talk mode (browser realtime)">
    Talk mode uses a registered realtime voice provider. Configure OpenAI with `talk.realtime.provider: "openai"` plus an `openai` API-key profile, `talk.realtime.providers.openai.apiKey`, or `OPENAI_API_KEY`. OpenAI Realtime uses the public Platform API and requires a Platform API key; a Codex OAuth login does not satisfy this surface. Configure Google with `talk.realtime.provider: "google"` plus `talk.realtime.providers.google.apiKey`. The browser never receives a standard provider API key: OpenAI receives an ephemeral Realtime client secret for WebRTC, and Google Live receives a one-use constrained Live API auth token for a browser WebSocket session, with instructions and tool declarations locked into the token by the Gateway. Providers that only expose a backend realtime bridge run through the Gateway relay transport, so credentials and vendor sockets stay server-side while browser audio moves through authenticated Gateway RPCs. The Realtime session prompt is assembled by the Gateway; `talk.client.create` does not accept caller-provided instruction overrides.

    Persistent provider, model, voice, transport, reasoning effort, exact VAD threshold, silence duration, and prefix padding defaults live in **Settings → Communications → Talk**; changing them requires `operator.admin` access. Configuring Gateway relay forces the backend relay path; configuring WebRTC keeps the session client-owned and fails instead of silently falling back to relay if the provider cannot create a browser session.

    The Talk control itself is the microphone button in the composer toolbar. Its caret lists **System default** and every microphone exposed by the browser, including USB, Bluetooth, and virtual inputs. The selected device ID stays browser-local and is never sent to the Gateway; if that exact device disappears, Talk asks you to choose another input instead of silently recording from a different microphone. While Talk is live, the microphone button becomes a pill showing the live input-level meter; clicking it stops voice input, and hovering it reveals the stop glyph. Screen readers announce `Connecting voice input...`, `Listening...`, or `Asking OpenClaw...` while a realtime tool call is consulting the configured larger model through `talk.client.toolCall`. Stopping a running agent response stays a separate square **Stop** control next to the pill.

    Maintainer live smoke: `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts` verifies the OpenAI backend WebSocket bridge, OpenAI browser WebRTC SDP exchange, Google Live constrained-token browser WebSocket setup, and the Gateway relay browser adapter with fake microphone media. The command prints provider status only and does not log secrets.

  </Accordion>
  <Accordion title="Stop and abort">
    - Click **Stop** (calls `chat.abort`).
    - While a run is active, normal follow-ups queue. Click **Steer** on a queued message to inject that follow-up into the running turn.
    - Type `/stop` (or standalone abort phrases like `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`) to abort out-of-band.
    - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session.

  </Accordion>
  <Accordion title="Abort partial retention">
    - When a run is aborted, partial assistant text can still be shown in the UI.
    - Gateway persists aborted partial assistant text into transcript history when buffered output exists.
    - Persisted entries include abort metadata so transcript consumers can tell abort partials from normal completion output.

  </Accordion>
</AccordionGroup>

## Connection loss and reconnect

Once a session is established, a dropped Gateway connection does not log you out. The dashboard
stays visible with a floating amber "Gateway connection lost — Reconnecting…" pill under the top
bar while the client retries automatically with backoff (800 ms up to 15 s). Live updates and
realtime/session actions pause until the connection returns; **Retry now** in the pill forces an
immediate attempt. Chat remains editable: ordinary text and attachment sends are kept in the
current tab's gateway/session-scoped browser storage, shown as waiting for reconnect, and sent
automatically when the Gateway returns. Live controls and slash commands remain unavailable while
offline.

When this browser already holds credentials (a configured token/password or an approved device
token), first opens and reloads show a small animated OpenClaw mark while the connection is
established instead of flashing the login gate. The login gate only appears when no credentials
are stored yet or when the Gateway actively rejects them (bad token/password, revoked pairing) —
states that need your input rather than waiting.

## PWA install and web push

The Control UI ships a `manifest.webmanifest` and a service worker, so modern browsers can install it as a standalone PWA. Web Push lets the Gateway wake the installed PWA with notifications even when the tab or browser window is not open.

If the page shows **Protocol mismatch** right after an OpenClaw update, first reopen the dashboard with `openclaw dashboard` and hard-refresh. If it still fails, clear site data for the dashboard origin or test in a private browser window; an old tab or browser service-worker cache can keep running a pre-update Control UI bundle against the newer Gateway.

| Surface                                               | What it does                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `ui/public/manifest.webmanifest`                      | PWA manifest. Browsers offer "Install app" once it is reachable.   |
| `ui/public/sw.js`                                     | Service worker that handles `push` events and notification clicks. |
| `push/vapid-keys.json` (under the OpenClaw state dir) | Auto-generated VAPID keypair used to sign Web Push payloads.       |
| `push/web-push-subscriptions.json`                    | Persisted browser subscription endpoints.                          |

Override the VAPID keypair through env vars on the Gateway process when you want to pin keys (multi-host deployments, secrets rotation, or tests):

- `OPENCLAW_VAPID_PUBLIC_KEY`
- `OPENCLAW_VAPID_PRIVATE_KEY`
- `OPENCLAW_VAPID_SUBJECT` (defaults to `https://openclaw.ai`)

The Control UI uses these scope-gated Gateway methods to register and test browser subscriptions:

- `push.web.vapidPublicKey` fetches the active VAPID public key.
- `push.web.subscribe` registers an `endpoint` plus `keys.p256dh`/`keys.auth`.
- `push.web.unsubscribe` removes a registered endpoint.
- `push.web.test` sends a test notification to the caller's subscription.

<Note>
Web Push is independent of the iOS APNS relay path (see [Configuration](/gateway/configuration) for relay-backed push) and the `push.test` method, which targets native mobile pairing.
</Note>

## Hosted embeds

Assistant messages can render hosted web content inline with the `[embed ...]` shortcode. The iframe sandbox policy is controlled by `gateway.controlUi.embedSandbox`:

The bundled Canvas plugin also provides [`show_widget`](/tools/show-widget) to render self-contained SVG or HTML directly from a tool call. The browser advertises the `inline-widgets` Gateway capability, and the resulting Canvas document remains available when chat history reloads. Channel-originated runs do not receive this tool.

<Tabs>
  <Tab title="strict">
    Disables script execution inside hosted embeds.
  </Tab>
  <Tab title="scripts (default)">
    Allows interactive embeds while keeping origin isolation; usually enough for self-contained browser games/widgets.
  </Tab>
  <Tab title="trusted">
    Adds `allow-same-origin` on top of `allow-scripts` for same-site documents that intentionally need stronger privileges.
  </Tab>
</Tabs>

```json5
{
  gateway: {
    controlUi: {
      embedSandbox: "scripts",
    },
  },
}
```

<Warning>
Use `trusted` only when the embedded document genuinely needs same-origin behavior. For most agent-generated games and interactive canvases, `scripts` is the safer choice.
</Warning>

Absolute external `http(s)` embed URLs stay blocked by default. To let `[embed url="https://..."]` load third-party pages, set `gateway.controlUi.allowExternalEmbedUrls: true`.

## Chat message width

Grouped chat messages use a readable default max-width. Wide-monitor deployments can override it without patching bundled CSS by setting `gateway.controlUi.chatMessageMaxWidth`:

```json5
{
  gateway: {
    controlUi: {
      chatMessageMaxWidth: "min(1280px, 82%)",
    },
  },
}
```

The value is validated before it reaches the browser. Supported forms include plain lengths and percentages such as `960px` or `82%`, plus constrained `min(...)`, `max(...)`, `clamp(...)`, `calc(...)`, and `fit-content(...)` width expressions.

## Tailnet access (recommended)

<Tabs>
  <Tab title="Integrated Tailscale Serve (preferred)">
    Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

    ```bash
    openclaw gateway --tailscale serve
    ```

    Open `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`).

    By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers (`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw verifies the identity by resolving the `x-forwarded-for` address with `tailscale whois` and matching it to the header, and only accepts these when the request hits loopback with Tailscale's `x-forwarded-*` headers. For Control UI operator sessions with browser device identity, this verified Serve path also skips the device-pairing round trip; device-less browsers and node-role connections still follow the normal device checks. Set `gateway.auth.allowTailscale: false` if you want to require explicit shared-secret credentials even for Serve traffic, then use `gateway.auth.mode: "token"` or `"password"`.

    For that async Serve identity path, failed auth attempts for the same client IP and auth scope are serialized before rate-limit writes. Concurrent bad retries from the same browser can therefore show `retry later` on the second request instead of two plain mismatches racing in parallel.

    <Warning>
    Tokenless Serve auth assumes the gateway host is trusted. If untrusted local code may run on that host, require token/password auth.
    </Warning>

  </Tab>
  <Tab title="Bind to tailnet + token">
    ```bash
    openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
    ```

    Open `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`).

    Paste the matching shared secret into the UI settings (sent as `connect.params.auth.token` or `connect.params.auth.password`).

  </Tab>
</Tabs>

## Insecure HTTP

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`), the browser runs in a **non-secure context** and blocks WebCrypto. By default, OpenClaw **blocks** Control UI connections without device identity.

Documented exceptions:

- localhost-only insecure HTTP compatibility with `gateway.controlUi.allowInsecureAuth=true`
- successful operator Control UI auth through `gateway.auth.mode: "trusted-proxy"`
- break-glass `gateway.controlUi.dangerouslyDisableDeviceAuth=true`

**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally at `https://<magicdns>/` (Serve) or `http://127.0.0.1:18789/` (on the gateway host).

<AccordionGroup>
  <Accordion title="Insecure-auth toggle behavior">
    ```json5
    {
      gateway: {
        controlUi: { allowInsecureAuth: true },
        bind: "tailnet",
        auth: { mode: "token", token: "replace-me" },
      },
    }
    ```

    `allowInsecureAuth` is a local compatibility toggle only:

    - It lets localhost Control UI sessions proceed without device identity in non-secure HTTP contexts.
    - It does not bypass pairing checks.
    - It does not relax remote (non-localhost) device identity requirements.

  </Accordion>
  <Accordion title="Break-glass only">
    ```json5
    {
      gateway: {
        controlUi: { dangerouslyDisableDeviceAuth: true },
        bind: "tailnet",
        auth: { mode: "token", token: "replace-me" },
      },
    }
    ```

    <Warning>
    `dangerouslyDisableDeviceAuth` disables Control UI device identity checks and is a severe security downgrade. Revert quickly after emergency use.
    </Warning>

  </Accordion>
  <Accordion title="Trusted-proxy note">
    - Successful trusted-proxy auth can admit **operator** Control UI sessions without device identity.
    - This does **not** extend to node-role Control UI sessions.
    - Same-host loopback reverse proxies still do not satisfy trusted-proxy auth; see [Trusted proxy auth](/gateway/trusted-proxy-auth).

  </Accordion>
</AccordionGroup>

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Content security policy

The Control UI ships a tight `img-src` policy: only **same-origin** assets, `data:` URLs, and locally generated `blob:` URLs are allowed. Remote `http(s)` and protocol-relative image URLs are rejected by the browser and never issue network fetches.

In practice:

- Avatars and images served under relative paths (for example `/avatars/<id>`) still render, including authenticated avatar routes the UI fetches and converts into local `blob:` URLs.
- Inline `data:image/...` URLs still render.
- Local `blob:` URLs created by the Control UI still render.
- GitHub link preview avatars are fetched by the Gateway from GitHub's fixed avatar host and returned as bounded `data:` URLs; the operator browser never contacts the remote avatar host.
- Remote avatar URLs emitted by channel metadata are stripped at the Control UI's avatar helpers and replaced with the built-in logo/badge, so a compromised or malicious channel cannot force arbitrary remote image fetches from an operator browser.

This is always on and not configurable.

## Avatar route auth

When gateway auth is configured, the Control UI avatar endpoint requires the same gateway token as the rest of the API:

- `GET /avatar/<agentId>` returns the avatar image only to authenticated callers. `GET /avatar/<agentId>?meta=1` returns the avatar metadata under the same rule.
- Unauthenticated requests to either route are rejected (matching the sibling assistant-media route), so the avatar route cannot leak agent identity on hosts that are otherwise protected.
- The Control UI forwards the gateway token as a bearer header when fetching avatars, and uses authenticated blob URLs so the image still renders in dashboards.

If you disable gateway auth (not recommended on shared hosts), the avatar route also becomes unauthenticated, in line with the rest of the gateway.

## Assistant media route auth

When gateway auth is configured, assistant local-media previews use a two-step route:

- `GET /__openclaw__/assistant-media?meta=1&source=<path>` requires the normal Control UI operator auth; the browser sends the gateway token as a bearer header when checking availability.
- Successful metadata responses include a short-lived `mediaTicket` scoped to that exact source path.
- Browser-rendered image, audio, video, and document URLs use `mediaTicket=<ticket>` instead of the active gateway token or password. The ticket expires quickly and cannot authorize a different source.

This keeps media rendering compatible with browser-native media elements without putting reusable gateway credentials in visible media URLs.

## Building the UI

The Gateway serves static files from `dist/control-ui`:

```bash
pnpm ui:build
```

Optional absolute base (fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Local development (separate dev server):

```bash
pnpm ui:dev
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

## Blank Control UI page

If the browser loads a blank dashboard and DevTools shows no useful error, an extension or early content script may have prevented the JavaScript module app from evaluating. The static page includes a plain HTML recovery panel that appears when `<openclaw-app>` is not registered after startup.

Use the panel's **Try again** action after changing the browser environment, or reload manually after these checks:

- Disable extensions that inject into all pages, especially extensions with `<all_urls>` content scripts.
- Try a private window, a clean browser profile, or another browser.
- Keep the Gateway running and verify the same dashboard URL after the browser change.

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can differ from the HTTP origin. This is handy when you want the Vite dev server locally but the Gateway runs elsewhere.

<Steps>
  <Step title="Start the UI dev server">
    ```bash
    pnpm ui:dev
    ```
  </Step>
  <Step title="Open with gatewayUrl">
    ```text
    http://localhost:5173/?gatewayUrl=ws%3A%2F%2F<gateway-host>%3A18789
    ```

    Optional one-time auth (if needed):

    ```text
    http://localhost:5173/?gatewayUrl=wss%3A%2F%2F<gateway-host>%3A18789#token=<gateway-token>
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Notes">
    - `gatewayUrl` is stored in localStorage after load and removed from the URL.
    - If you pass a full `ws://` or `wss://` endpoint via `gatewayUrl`, URL-encode the value so the browser parses the query string correctly.
    - `token` should be passed via the URL fragment (`#token=...`) whenever possible. Fragments are not sent to the server, which avoids request-log and Referer leakage. Legacy `?token=` query params are still imported once for compatibility, but only as a fallback, and are stripped immediately after bootstrap.
    - `password` is kept in memory only.
    - When `gatewayUrl` is set, the UI does not fall back to config or environment credentials. Provide `token` (or `password`) explicitly; missing explicit credentials is an error.
    - Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).
    - `gatewayUrl` is only accepted in a top-level window (not embedded), to prevent clickjacking.
    - Public non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins` explicitly (full origins). Private same-origin LAN/Tailnet loads from loopback, RFC1918/link-local, `.local`, `.ts.net`, or Tailscale CGNAT hosts are accepted without enabling Host-header fallback.
    - Gateway startup may seed local origins such as `http://localhost:<port>` and `http://127.0.0.1:<port>` from the effective runtime bind and port, but remote browser origins still need explicit entries.
    - Do not use `gateway.controlUi.allowedOrigins: ["*"]` except for tightly controlled local testing; it means allow any browser origin, not "match whatever host I am using."
    - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables Host-header origin fallback mode, but it is a dangerous security mode.

  </Accordion>
</AccordionGroup>

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).

## Related

- [Dashboard](/web/dashboard) — gateway dashboard
- [Health Checks](/gateway/health) — gateway health monitoring
- [TUI](/web/tui) — terminal user interface
- [WebChat](/web/webchat) — browser-based chat interface
