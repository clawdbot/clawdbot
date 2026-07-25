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

While you watch a running session, the Gateway can use that agent's utility model to produce a compact status digest. Chat shows it as a one-line status pill that expands into a card with the assessment, plan progress, pull requests, and elapsed time. The card can expand once when a run becomes stuck or needs input; the `/btw` side chat takes priority over the expanded card.

The expanded card also accepts short questions about the run. Answers use only the observer's current digest and sanitized bounded notes, stay in the browser for that session, and never enter or interrupt the main agent run. If the observations do not contain the answer, the observer says that it cannot know.

After the first digest arrives, it owns that run's sidebar subtitle instead of heuristic live activity. A final done or failed digest remains visible while the session is unread, then the row returns to its normal work subtitle.

Session observation is enabled by default. In **Settings > Appearance > Sidebar**, you can turn it off gateway-wide, inspect the resolved small model and its provenance, or choose automatic routing, disable utility tasks, or select an explicit `agents.defaults.utilityModel`. The equivalent config controls are `gateway.controlUi.sessionObserver: false` and `agents.defaults.utilityModel: ""`.

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

Gateway auth runs before device pairing. A direct loopback connection does not bypass token or password auth. The dashboard settings panel keeps a token for the current browser tab session and selected gateway URL; passwords are not persisted. After pairing, the browser can use its stored per-device token on later connections.

Onboarding usually configures a gateway token for shared-secret auth. If the Gateway starts in token mode without a configured token, it generates an ephemeral runtime token for that process instead. The runtime token is not written to config, so `openclaw config get gateway.auth.token` cannot retrieve it and a loopback browser without that token is rejected. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then paste the configured token in Control UI settings. Password auth works instead when `gateway.auth.mode` is `"password"`.

## Device pairing (first connection)

After gateway auth succeeds, connecting from a new browser or device usually requires a **one-time pairing approval**, shown as `disconnected (1008): pairing required`.

<Warning>
When upgrading directly from a release that used the retired
`gateway.controlUi.dangerouslyDisableDeviceAuth=true` break-glass setting,
OpenClaw keeps token/password- or trusted-proxy-authenticated Control UI access
available for pairing-only remediation. If the browser is on plain HTTP and cannot create device identity,
reopen it over HTTPS or localhost first. Then click **Secure this browser** in
the warning banner. The Gateway returns to normal device-auth enforcement only
after a signed browser pairs explicitly; it never creates or approves an
identity for a device-less browser. The transition is not available when
another operator device is already paired. Gateway startup and
`openclaw doctor --fix` both report this migration explicitly instead of
silently discarding the old key.
</Warning>

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

Switching an already-paired remote browser from read access to write/admin access is treated as an approval upgrade, not a silent reconnect: OpenClaw keeps the old approval active, blocks the broader reconnect, and asks you to approve the new scope set explicitly. A qualifying direct-loopback Control UI connection can silently approve the upgrade after it authenticates.

Once approved, the device is remembered and won't require re-approval unless you revoke it with `openclaw devices revoke --device <id> --role <role>`. See [Devices CLI](/cli/devices) for token rotation, revocation, and the Paperclip / `openclaw_gateway` first-run approval flow.

<Note>
- Direct local Control UI connections from a loopback TCP peer (`127.0.0.1` or `::1`, typically reached as `localhost`) with no forwarded/proxy headers can auto-approve device pairing only after gateway auth succeeds and the browser presents device identity. In token/password mode, the first connection still needs the configured shared secret; this auto-approval is not a token bypass.
- Direct loopback needs no shared secret only when `gateway.auth.mode: "none"` is explicitly configured. That disables gateway auth and is not the recommended Control UI setup. Tailscale Serve and trusted-proxy modes can avoid a pasted shared secret only when their respective identity checks succeed.
- Tailscale Serve can skip the pairing round trip for Control UI operator sessions when `gateway.auth.allowTailscale: true`, Tailscale identity verifies, and the browser presents its device identity. Device-less browsers and node-role connections still follow the normal device checks.
- Direct Tailnet binds and LAN browser connects still require explicit approval. Browser profiles without device identity cannot use loopback auto-approval.
- Each browser profile generates a unique device ID, so switching browsers or clearing browser data requires re-pairing.

</Note>

## Pair a mobile device

An already paired administrator can create the iOS/Android connection QR without opening a terminal:

<Steps>
  <Step title="Open mobile pairing">
    Select **Devices**, then click **Pair mobile device** in the **Devices** card.
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

Open **Settings → General** to see the **Gateway Host** card with the Gateway machine, LAN address, operating system, runtime, uptime, CPU load, memory, and state-volume disk space. The card refreshes every 10 seconds while visible through the `system.info` Gateway RPC, which requires the `operator.read` scope. Older Gateways and connections without that scope omit the card.

## Language support

The Control UI localizes itself on first load based on your browser locale. To override it later, open **Settings -> General -> Language** (the picker lives on the General page, not under Appearance).

- Supported locales: `en`, `ar`, `de`, `es`, `fa`, `fr`, `hi`, `id`, `it`, `ja-JP`, `ko`, `nl`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

Docs translations are generated for the same non-English locale set, but the docs site's built-in Mintlify language picker only lists locale codes Mintlify accepts. Thai (`th`) and Persian (`fa`) docs are still generated in the publish repo; they may not appear in that picker until Mintlify supports those codes.

## Appearance themes

The Appearance panel has the built-in Claw, Knot, and Dash themes (Claw is default), plus one browser-local tweakcn import slot. To import a theme, open the [tweakcn editor](https://tweakcn.com/editor/theme), choose or create a theme, click **Share**, and paste the copied link into Appearance. The importer also accepts `https://tweakcn.com/r/themes/<id>` registry URLs, editor URLs like `https://tweakcn.com/editor/theme?theme=amethyst-haze`, relative `/themes/<id>` paths, raw theme IDs, and default theme names such as `amethyst-haze`.

Imported themes are stored only in the current browser profile; they are not written to gateway config and do not sync across devices. Replacing the imported theme updates the one local slot; clearing it switches back to Claw if the imported theme was active.

Appearance also has a Text size setting. It applies to chat text, composer text, tool cards, and chat sidebars, and keeps text inputs at least 16px so mobile Safari does not auto-zoom on focus.

Theme, theme mode, text size, language, and chat display preferences sync through the gateway config (`ui.prefs`), so they follow you across devices and agents can change them through the approval gate — connected clients apply changes live via the gateway's `config.changed` notice. Each browser keeps a local mirror for instant boot; clients that cannot write config (viewer scope, offline) keep changes device-local. See [Configuration reference](/gateway/configuration-reference#ui).

## OpenClaw system care

Open **Settings → Ask OpenClaw** to talk to the system setup and repair agent. Outside onboarding, this page can show at most one dismissible event chip per visit. It stays silent for routine Gateway traffic and reacts only to health snapshots that report a disabled configuration reloader, a configured channel disconnect/degradation, a failed channel probe, or unavailable channel credentials. A newer event replaces the pending chip only when it is more severe; dismissing or using the chip silences event prompts for that visit. Clicking the chip sends its diagnosis question as a real `openclaw.chat` message, so the transcript records the request and OpenClaw performs the diagnosis. Onboarding never shows these event chips.

## Manage plugins

Open **Plugins** in the sidebar, or use `/settings/plugins` relative to the
configured Control UI base path, to browse and manage plugins without leaving
the Control UI. For example, a base path of `/openclaw` uses
`/openclaw/settings/plugins`. The page is always available, even when every
optional plugin is disabled.

Plugins is a hub with four tabs: **Installed** and **Discover** manage plugin
code at `/settings/plugins`, **Skills** hosts the per-agent skill manager at
`/skills`, and **Workshop** hosts Skill Workshop proposal review at
`/skills/workshop`. Each tab keeps its own URL, and the sidebar shows the
single Plugins entry for all of them.

The **Installed** tab shows the full local inventory grouped by category, with
overview counts. Each row opens a detail view; its overflow (`…`) menu enables
or disables the plugin and offers **Remove** for externally installed plugins.
It also lists configured [MCP servers](/cli/mcp) and supports adding, disabling,
and removing them inline. The same server controls live on **Settings → MCP**.
The **Discover** tab is the store: featured plugins included with OpenClaw,
official external plugins, and one-click MCP connectors for popular services.
Typing in the search box queries
[ClawHub](https://clawhub.ai/plugins) inline and appends a **From ClawHub**
section with download counts and source-verification badges. Deep links can
target the store directly with `/settings/plugins?tab=discover`.

The **Skills** tab keeps the skill status report, enable/disable toggles, API
key entry, and inline ClawHub skill search, scoped to the selected agent. The
**Workshop** tab keeps the Skill Workshop board and Today review flow for
[skill proposals](/tools/skill-workshop). **Find skill ideas** reviews a bounded
window of substantial sessions from newest to oldest and leaves any results as
pending proposals. The panel shows cumulative coverage; **Scan earlier work**
continues from the persisted cursor, then becomes **Scan new work** after older
history is exhausted. Manual history review works while autonomous self-learning
is disabled and uses the selected agent's configured model.

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

## Apps and extensions

Open **Apps** from the sidebar **More** menu, the command palette, or the
sidebar agent menu (**Get the apps**), or use `/apps` relative to the
configured Control UI base path. The page collects install links for every
OpenClaw companion surface: the [iOS](/platforms/ios) and
[Android](/platforms/android) apps, the Apple Watch and Wear OS companions
bundled with them, the [macOS](/platforms/macos), [Windows](/platforms/windows),
and [Linux](/platforms/linux) desktop apps, the
[Chrome extension](/tools/chrome-extension), the in-app Plugins hub with
[ClawHub](https://clawhub.ai), and the Discord community and docs.

## Sidebar navigation

The sidebar organizes everything around the agent. The identity row at the top is the active agent; below it, the **Pages** section starts with **Home** — the agent's rolling main session, badged with its unread or running state — followed by the pinned destinations (**Automations** and **Plugins** by default). The customize control on the Pages header opens a menu with every other destination, including **Usage** and plugin-provided tabs, plus **Edit pinned items**; right-clicking the navigation area opens the pin editor directly. The session list below splits into zones: **Threads** for the agent's chat sessions (the main session stays behind Home; sessions it spawned appear here as top-level threads, and named threads show without a type prefix), **Groups** for group and room conversations, and **Coding** for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), ACP-backed harness sessions, and the Codex/Claude CLI catalogs. Coding starts collapsed on first run and remembers your choice; its collapsed header keeps the true count and shows a running indicator while contained sessions work. Custom groups (the session `category`) and **Pinned** rows sit above Threads, and assigning a session to a custom group always wins over the automatic zone classification. The Threads header holds the sort control (Created or Last updated, Group by, and a persisted **Status** filter for Active, Archived, or All) and the **+** that opens the New session page. Archived rows stay inline, dimmed with an archive glyph; they do not contribute unread or attention state and stay outside lineage promotion. Opening a session moves the selection highlight without reordering rows. Parent sessions with recent child runs show a disclosure and child count; expand it to inspect nested child sessions, live or terminal status, and runtime without leaving the sidebar. Selecting a child opens its chat and automatically reveals its ancestor path. Child rows stay outside root grouping, pinning, dragging, multi-select, and pagination; collapsed zones do not consume the visible page budget. Sessions with new activity since they were last read show an unread dot, and opening one marks it read. An agent can also publish a short expiring status line and optionally request attention with a curated amber icon; that declaration clears when you open the session, send the next message, clear it explicitly, or its TTL expires. Cloud-worker lifecycle states use a globe badge; local and reclaimed sessions omit a placement badge because local execution is the default. Each root session row has a context menu (kebab button or right-click) with Pin/Unpin, Mark as unread/read, Rename, Fork, Move to group (including New group and Remove from group), Archive or Unarchive, and Delete; touch layouts keep the direct pin and menu controls visible. Cmd/Ctrl-click toggles root rows into a multi-select and Shift-click extends it across the visible order; opening the menu on a selected row then offers batch actions (Mark N as unread/read, Move N to group, Archive N, Delete N) that apply to every selected session, with a single confirmation for batch delete. Drag a root session onto **Pinned** to pin it, or onto a custom group to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names and their order live in the gateway (`sessions.groups.*`), so they follow you across browsers, while collapsed state stays in the browser profile. Group headers also have a menu (kebab button or right-click) with Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Threads.

## New session page

The **+** in the sidebar session-list header opens a full-page draft at `/new`: nothing is created until you send the first message. A unified **Place** picker chooses the working folder and, for admin operators, the execution destination: **Gateway · local**, a paired node that exposes `system.run`, or an available cloud profile. The folder defaults to the agent workspace; another absolute Gateway path requires `operator.admin` but can run directly without being a Git checkout. When the selected Gateway folder is a Git checkout, the same picker offers optional **Worktree** isolation with a base-branch picker backed by `worktrees.branches` (no fetch) and an optional worktree name (the branch becomes `openclaw/<name>`). Cloud workers require that managed-worktree path; paired nodes never expose it. The composer footer chooses the new session's model and reasoning level. Its **Incognito** toggle creates a web-only thread whose session entry, transcript, and compaction state stay in memory until the Gateway restarts; OpenClaw also skips its automatic memory flush. The agent keeps its normal tools, so an explicit save request or tool-driven file write can still persist data. The model provider still processes messages, and content-free audit metadata is still recorded. Cloud starts persist their model and reasoning choices before dispatching the session to its worker.

On multi-user gateways, only admin-scope connections can create or view incognito threads, and other sessions cannot reach them through agent session tools or transcript search. Incognito protects against storage and other gateway-mediated users, not against the gateway owner or process operator, who can always observe live sessions.

**Browse folders** opens the Place picker's inline directory browser, backed by the admin-only `fs.listDir` method and scoped to the selected Gateway or node. Gateway and browse-capable nodes list their filesystem; an execution-capable node without `fs.listDir` still accepts a typed absolute path. Recent places can restore a folder and its owning node together without carrying paths across hosts. Submitting calls `sessions.create` with the first message, so the run starts in the same round-trip and the UI jumps to the new session's chat. If the Gateway creates the session but rejects that first send, the chat preserves the prompt and error across reloads; **Retry** sends it through the already-created session instead of creating another one.

Inside **Settings**, the dedicated sidebar includes **Ask OpenClaw** and starts with a **Search settings** field for quickly finding settings sections.

On desktop web, a fixed control cluster at the top-left of the content area — the web counterpart of the macOS titlebar strip — holds the sidebar collapse toggle (⌘B) and the command-palette search button (⌘K). Clicking the agent identity row at the top of the sidebar opens the agent menu; **Home** opens the main session. When something needs action — failed or overdue cron jobs, expiring or expired model auth — compact attention chips appear above the sidebar footer and click through to the owning page. The identity row shows the agent's avatar (identity image or emoji), name, connection dot, and a live subtitle. Its agent-scoped menu contains the inline agent switcher (multi-agent setups), **New agent**, "What can this agent do?", and **Agent settings**. Rosters above ten agents get a filter field and list pinned agents first; pin or unpin agents from the Agents settings page, with the pinned set stored in the browser profile. Choosing an agent scopes Chat plus Usage, Automations, Tasks, Workboard, and Sessions to that agent. Each scoped page exposes an **Agent** control with **All agents** as an escape; this widens the shared page scope without changing the concrete chat agent, while direct session links still open their target. The Agents settings page keeps its own `?agent=` selection and does not follow the shared page scope. The footer is one full-width identity card that remains available offline and shows **Reconnecting…** beneath the last-known account name. It opens the app/account menu, whose profile identity header is followed by **Settings**, **Usage**, mobile pairing, **Get the apps**, **Help** (help, Discord, Docs, and the changelog), an offline retry action when needed, the version/build chip, and the color-mode toggle. The build chip opens the About page. When the gateway runs from a source checkout on a branch other than `main`, the footer also shows that branch name in red so a non-release gateway is obvious at a glance (release installs never show it). Shift-Command-Comma on Apple platforms or Ctrl-Shift-Comma elsewhere opens **Settings** without overriding the browser's plain Command-Comma shortcut. Collapsing the sidebar (⌘B or the cluster's toggle) hides it entirely for a full-width workspace; while collapsed, the top-left cluster keeps the expand toggle and search and gains a new-thread button — mirroring what the macOS app hosts natively in its titlebar. The sidebar is the only navigation chrome on desktop, with no top bar. Narrow viewports swap the sidebar for a slide-over drawer behind a compact header row holding the drawer toggle, brand, and command-palette search; on phones, Chat absorbs that navigation row into its title bar, with the menu and search controls beside the session title. In the macOS app the separate header row folds the titlebar clearance into a single compact strip beside the window controls. Navigation uses regular browser history, so the browser's back/forward buttons traverse it; the macOS app adds a native sidebar toggle next to the window controls plus trackpad swipe gestures, with back/forward buttons at the sidebar's right edge while it is expanded and native search (command palette) and new-session buttons while it is collapsed.

Pending approvals also contribute an attention chip above the sidebar footer;
select it to open the owning Approvals page.

## What it can do (today)

<AccordionGroup>
  <Accordion title="Chat and Talk">
    - Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`). Archived sessions keep the composer disabled and show a banner with an **Unarchive** action before the conversation can continue.
    - Chat history refreshes request a bounded recent window with per-message text caps, so large sessions do not force the browser to render a full transcript payload before chat becomes usable.
    - Hovering or keyboard-focusing a public GitHub issue or pull request link shows its state, title, author, recent activity, comments, and change statistics. The connected Gateway fetches and caches public metadata without changing the link target, including when the UI uses a remote Gateway. The Gateway uses `GH_TOKEN` or `GITHUB_TOKEN` when available, after confirming the repository is public; otherwise it uses GitHub's anonymous API with a longer cache.
    - Talk through browser realtime sessions. OpenAI uses direct WebRTC, Google Live uses a constrained one-use browser token over WebSocket, and backend-only realtime voice plugins use the Gateway relay transport. Video-capable browser sessions can choose a device-local camera in Settings or flip cameras from the live preview; the browser captures JPEG frames for the realtime provider without streaming camera video through the Gateway. Client-owned provider sessions start with `talk.client.create`; Gateway relay sessions start with `talk.session.create`. The relay keeps provider credentials on the Gateway while the browser streams microphone PCM through `talk.session.appendAudio`, forwards `openclaw_agent_consult` provider tool calls through `talk.client.toolCall` for Gateway policy and the larger configured OpenClaw model, and routes active-run voice steering through `talk.client.steer` or `talk.session.steer`.
    - Stream tool calls and live tool output cards in Chat (agent events). Tool activity renders as kind-aware rows: shell commands show the syntax-highlighted command with terminal-style output; supported edit and write calls show bounded inline diffs, line numbers when available, and `+added -removed` stats; and consecutive calls collapse into a summary such as "Ran 13 commands, read 6 files, edited 9 files". While a run is live, the newest running call names the group header. Expand a row to inspect its remaining arguments and raw output.
    - Optional AI purpose titles for complex tool calls (long shell commands, argument-heavy plugin tools), enabled with `gateway.controlUi.toolTitles: true` (default off). Titles come from the batched `chat.toolTitles` method through standard utility-model routing — an explicit `utilityModel` (operator-chosen provider, like other utility tasks), else the session provider's declared small-model default — and cache gateway-side per agent. When the opt-in is off or no cheap model is usable, rows keep their deterministic labels and no model call happens.
    - Start or dismiss ephemeral model-suggested follow-up tasks; accepted suggestions open a fresh managed-worktree session with the proposed prompt.
    - Activity tab with browser-local, redaction-first summaries of live tool activity from existing `session.tool` / tool event delivery.

  </Accordion>
  <Accordion title="Channels, sessions, memory">
    - Channels: built-in plus bundled/external plugin channels status, QR login, and per-channel config (`channels.status`, `web.login.*`, `config.patch`).
    - Channel probe refreshes keep the previous snapshot visible while slow provider checks finish, and label partial snapshots when a probe or audit exceeds its UI budget.
    - Threads (a workspace page at `/sessions`, with a **Worktrees** tab alongside it): list configured-agent sessions by default, pin frequent sessions, rename them, archive or restore inactive sessions, fall back from stale unconfigured agent session keys, and apply per-session model/thinking/fast/verbose/trace/reasoning overrides (`sessions.list`, `sessions.patch`). A three-way **Active / Archived / All** filter controls both this page and the sidebar; All dims archived rows and labels them explicitly. Archived sessions keep their transcripts, are never auto-pruned, and remain shelved until explicitly unarchived or deleted. Rows show an unread dot for active sessions with activity since they were last read, with mark-unread/mark-read actions (`sessions.patch { unread }`), and a Fork action that branches the transcript into a new session (`sessions.create { parentSessionKey, fork: true }`). Overview tiles above the table summarize the loaded roster (session count, live runs, unread sessions, total tokens, and archived count when available), each row carries a kind glyph with a live-run dot, status renders as a plain dot plus label, and the Tokens column shows a context-window usage meter when the session reports token and context sizes. Row management actions live in a per-row menu (kebab button or right-click) mirroring the sidebar's session menu, and the row drawer carries the agent runtime and run duration alongside the other session details.
    - Native Claude and Codex sidebar catalogs stream one host at a time, then reconcile after node connectivity changes, on page focus, and at most every 30 seconds while visible. Catalog changes trigger a faster follow-up pass, so sessions created in the native tools appear without reloading the Control UI. Claude Desktop rows also retain their local custom-group label when present; OpenClaw reads that mapping from Desktop's local store and never writes it.
    - Session grouping: a Group by control organizes the sessions table into sections by custom groups, channel, kind, agent, or date. Custom groups persist per session via `sessions.patch` (`category`), so sessions started from message channels (Discord, Telegram, WhatsApp, ...) can be categorized too; assign groups by dragging rows onto a section, or with the per-row group selector, and create groups with the New group action.
    - Memory (a tab on the Agents page, scoped to the selected agent): dreaming status, enable/disable toggle, and Dream Diary reader (`doctor.memory.status`, `doctor.memory.dreamDiary`, `config.patch`).
    - Import Memory (`/memory-import`, reached from the Agents page's Memory tab): preview and copy local Claude Code auto-memory, Codex consolidated memory, or Hermes memory files into the selected agent workspace (`migrations.memory.plan`, `migrations.memory.apply`).
    - Onboarding memory offer: when the Control UI opens in onboarding mode (`?onboarding=1`, used by the Linux companion app after its first-run install), a one-page dialog offers to import detected memories with the same plan/apply flow; skipping leaves the settings page as the later entry point.

  </Accordion>
  <Accordion title="Cron, tasks, plugins, skills, devices, exec approvals">
    - Automations (cron jobs): stat cards (automation count, failing count, scheduler state, next wake) above an Automations/Run history tab switch; the Automations tab lists jobs in a filterable table (All/Active/Paused, search, schedule and last-run filters, per-row action menu) with starter suggestions below, and the Run history tab shows recent runs across all automations (`cron.*`).
    - Tasks: live active and recent background task ledger with linked sessions and cancellation (`tasks.*`). Chat's Background tasks rail groups running and finished work; select a row to inspect its bounded prompt and output or error summary.
    - Plugins: browse the installed inventory and curated store, search ClawHub, install and remove plugin code, and enable or disable installed plugins (`plugins.*`); MCP server rows edit `mcp.servers` through the config methods.
    - Skills: status, enable/disable, install, API key updates (`skills.*`).
    - Devices: one inventory joins paired device records, the node catalog, and live presence (`device.pair.list`, `node.list`, `system-presence`). The Gateway host is pinned first; paired clients show connection status, roles, tokens, capabilities, and commands. Duplicate pairings collapse into an expandable group, and **Clean up N stale** bulk-removes admin-confirmed offline duplicates that were auto-approved (silent local, trusted-CIDR, or SSH-verified) or predate approval provenance. Entries can be removed (`node.pair.remove`, `device.pair.remove`), device pairing and node re-approvals handled inline (`device.pair.*`, `node.pair.approve`/`reject`), and mobile setup codes created from the same card.
    - Exec approvals: edit gateway or node allowlists and ask policy for `exec host=gateway/node` (`exec.approvals.*`).

  </Accordion>
  <Accordion title="Config">
    - View/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`).
    - Settings navigation starts with Ask OpenClaw, then groups pages by attention: General, Appearance, and Notifications up top; Connections (Connection, Channels, Communications, Devices); Agents & Tools (Agents, AI & Agents, Model Providers, MCP, Automation, Labs); Privacy & Security (Security, Approvals); and System (Infrastructure, Advanced, Debug, Logs, About). General is a slim hub with model defaults, language, and gateway host stats; every other setting lives on exactly one page.
    - Privacy & Security: curated rows for gateway auth, exec policy, browser enablement, tool profile, device auth, and mobile pairing, above the schema-backed `security`/`approvals` sections.
    - Approvals includes newest-first, 30-day history for resolved exec, plugin, and system-agent requests. Filter by kind or page through older rows to review the decision, reason, source session, and resolver attribution recorded by the Gateway.
    - Labs exposes shipped experimental switches. Code Mode and Swarm are the current entries and save `tools.codeMode.enabled` and `tools.swarm.enabled` immediately; unshipped experiments do not appear or write speculative config keys.
    - Notifications: browser web-push status, subscribe/unsubscribe, and a test send.
    - Advanced: every config section without a curated home, plus the raw JSON5 editor (previously the General page's Advanced mode).
    - Model Setup (`/settings/model-setup`) is a subpage of Model Providers, launched from its header.
    - Agents: a settings page (**Settings → Agents**, `/settings/agents`) with per-agent tabs (Overview, Files, Tools, Skills, Channels, Automations, Memory). The Overview tab edits the agent's identity — display name, emoji, and an avatar image that is downscaled and size-bounded in the browser before `agents.update`. Saving stores configured identity fields and mirrors them to the workspace `IDENTITY.md`; configured values take precedence over manual edits to the same file fields.
    - Profile: a settings page showing the default agent's identity with all-time usage stats — lifetime tokens, peak day, longest session, activity streaks, a year-long token heatmap, top tools, and channel highlights (`usage.cost`, `sessions.usage`).
    - MCP has a dedicated settings page with server rows (transport, enablement, OAuth/filter/parallel summaries), direct add/enable/disable/remove controls, common operator commands, and the scoped `mcp` config editor. The Plugins page remains the home for one-click connectors and discovery.
    - Model Providers: a settings page listing every configured model provider with its brand icon, auth state (`models.authStatus`), model availability (`models.list`), live plan/quota/billing data where the provider reports it (`usage.status`), and local session spend for the last 30 days (`sessions.usage`). A Refresh action re-reads credential state and provider usage.
    - Connection: a settings page (under **Connections**) owning the dashboard's own gateway link — WebSocket URL, gateway token, password, and default session key — plus the latest handshake snapshot (status, uptime, tick interval, last channels refresh). The offline login gate handles the disconnected case; this page edits the connection while connected.
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
  <Accordion title="Automations panel notes">
    - Selecting a row opens a full-page detail view with an Active/Paused switch and Run now in the header (run-if-due, clone, and remove in its menu); the Settings tab edits the automation inline (prompt, details, frequency, advanced overrides) and the Run history tab shows that automation's runs.
    - Starter automations under the table prefill the create form with an editable prompt and schedule.
    - For isolated tasks, delivery defaults to announce summary; switch to none for internal-only runs.
    - Channel/target fields appear when announce is selected.
    - Webhook mode uses `delivery.mode = "webhook"` with `delivery.to` set to a valid HTTP(S) webhook URL.
    - For main-session tasks, webhook and none delivery modes are available.
    - Advanced edit controls include delete-after-run, clear agent override, cron exact/stagger options, agent model/thinking overrides, and best-effort delivery toggles.
    - Form validation is inline with field-level errors; invalid values disable the save button until fixed.
    - Set `cron.webhookToken` to send a dedicated bearer token; if omitted, the webhook is sent without an auth header.
    - `cron.webhook` is a retired legacy fallback rejected by current config validation. Run `openclaw doctor --fix` to migrate stored jobs that still use `notify: true` to explicit per-job webhook or completion delivery and remove the old key.

  </Accordion>
</AccordionGroup>

## Import assistant memory

Open **Settings** → **Import Memory** to bring local Codex or Claude Code memory
into an OpenClaw agent. The Gateway discovers supported local memory on its own
host, so a remote Control UI imports from the Gateway computer rather than the
browser computer.

1. Choose the destination agent.
2. Review the detected source collections and Markdown filenames. File contents
   are not sent in the plan response or displayed in the page.
3. Select the collections to import and confirm. Apply rebuilds the plan before
   writing so stale selections fail safely.
4. If files already exist, enable **Replace existing imports**, refresh the
   preview, and confirm the replacement.

Codex imports only its consolidated `MEMORY.md` and `memory_summary.md`. Claude
Code imports Markdown from project auto-memory directories and a configured
`autoMemoryDirectory`; it does not import sessions, settings, instructions, or
credentials through this page. Files are copied below `memory/imports/` in the
selected workspace, where the active memory plugin can index them. Sources are
never changed.

Planning and applying require `operator.admin`. Every apply creates a verified
OpenClaw backup when state exists, writes a redacted migration report, and keeps
item-level backups before replacing existing destination files. See
[Memory overview](/concepts/memory#import-from-coding-assistants) for paths and
recall behavior.

## MCP page

The dedicated MCP page is an operator view for OpenClaw-managed MCP servers under `mcp.servers`. It does not start MCP transports by itself; use it to inspect and edit saved config, then use `openclaw mcp doctor --probe` when you need live server proof.

Typical workflow:

1. Open **MCP** from the sidebar.
2. Check the summary cards for total, enabled, OAuth, and filtered server counts.
3. Review each server row for transport, enablement, auth, filters, timeouts, and command hints.
4. Add, enable, disable, or remove servers directly on the MCP page. Choose Streamable HTTP, SSE, or stdio explicitly; stdio command lines accept quoted arguments such as paths with spaces. Use the **Plugins** page for one-click connectors and discovery.
5. Edit the scoped `mcp` config section for advanced server fields such as environment variables, working directories, headers, TLS/mTLS paths, OAuth metadata, tool filters, and Codex projection metadata.
6. Use **Save** for a config write, or **Save & Publish** when the running Gateway should apply the changed config.
7. Run `openclaw mcp status --verbose`, `openclaw mcp doctor --probe`, or `openclaw mcp reload` from a terminal for static diagnostics, live proof, or cached-runtime disposal.

The page redacts credential-bearing URL-like values before rendering and quotes server names in command snippets so copied commands still work with spaces or shell metacharacters. Full CLI and config reference: [MCP](/cli/mcp).

## Activity tab

The Activity tab lives in **Settings › System**, next to Logs and Debug. It is an ephemeral browser-local observer for live tool activity, derived from the same Gateway `session.tool` / tool event stream that powers Chat tool cards. It does not add another Gateway event family, endpoint, durable activity store, metrics feed, or external observer stream.

Activity entries keep only sanitized summaries and redacted, truncated output previews. Tool argument values are not stored in Activity state; the UI shows that arguments are hidden and records only the argument field count. The in-memory list follows the current browser tab, survives navigation within the Control UI, and resets on page reload, session switch, or **Clear**.

## Operator terminal

The dockable operator terminal is disabled by default. To enable it, set `gateway.terminal.enabled: true` and restart the Gateway. The terminal requires an `operator.admin` connection and opens a host PTY in the active agent workspace. New tabs follow the currently selected chat agent.

<Warning>
The terminal is an unconfined host shell and inherits the Gateway process environment. Enable it only for trusted operator deployments. OpenClaw refuses terminal sessions for agents with `sandbox.mode: "all"`; changing an active agent to that mode closes its existing and in-flight terminal sessions.
</Warning>

Use **Ctrl + backtick** to toggle the dock. The layout supports bottom and right docking, resizes with the browser viewport, and keeps multiple shell tabs. See [Gateway configuration](/gateway/configuration-reference#gateway) for `gateway.terminal.enabled` and the optional `gateway.terminal.shell` override.

Owner-authorized, unsandboxed agents can use the `terminal` tool for long or interactive work that the operator should watch. Each tool call can open, read, write, resize, close, or list the agent's own gateway PTYs. New sessions open a co-attached Control UI tab by default, so the agent and operator share output and either can type or resize. Agent access is exact-session scoped: an agent cannot read or control operator-created terminals or terminals opened by another agent session.

Drag one or more files onto the active terminal, or use the paperclip button to choose files. OpenClaw stages each file on the machine that owns the PTY and pastes shell-quoted absolute paths at the cursor; it never presses Enter or executes the input. A compact batch indicator shows the current file and completed count. Cancel stops the remaining batch without pasting paths; a failed transfer stays visible so you can retry from that file without re-uploading completed files. Images, PDFs, archives, and other file types are accepted up to 16 MiB per file. Staged files use a private system-temporary directory on POSIX hosts (directory mode `0700`, file mode `0600`) or a directory under the user-profile ACL boundary on Windows, plus a 24-hour cleanup timer, so move or copy anything you need to keep.

Path insertion supports PowerShell, `cmd.exe`, and recognized POSIX shells (`sh`, Bash, Dash, Ash, Ksh, Zsh, and Fish), including Git Bash on Windows. Other shell overrides are refused because their quoting rules cannot be inferred safely; run the Gateway inside WSL for a native WSL terminal and Linux upload paths. `cmd.exe` paths containing `%` or `!` are also refused because that shell expands those characters even inside double quotes.

Codex and Claude Code sessions discovered in the sessions sidebar can open in their native CLI inside the same terminal panel. In **Settings › Chat**, set **Open Codex/Claude threads in** to **Terminal** to make a normal row click open `codex resume` or `claude --resume`; the default remains the read-only OpenClaw viewer. A row's right-click or kebab menu always offers both choices, and the viewer header includes **Open in terminal** when that session is eligible.

Eligibility is per session and per host. Gateway-local sessions start the provider-owned resume command on the Gateway host. Paired-node sessions start an allowlisted provider command on the owning node and relay only that PTY's output, input, and resize events; this does not expose a general node shell or accept browser-supplied commands. File uploads use the separate, size-bounded `terminal.upload` node command and remain bound to the already-open terminal session. Approve the node pairing upgrade when that command first appears. Nodes that do not advertise the matching terminal-resume command, including embedded worker bridges without duplex streaming, keep the viewer available and show terminal opening as unavailable; older nodes can still run a terminal but cannot receive dragged files.

Connection-owned sessions survive disconnects: a page reload, laptop sleep, or network blip detaches the session on the Gateway instead of killing it, and the same browser tab reattaches on reconnect with recent output replayed. Detached connection-owned sessions are killed after `gateway.terminal.detachedSessionTimeoutSeconds` (default 300 seconds; `0` restores kill-on-disconnect). Attaching one of these sessions remains tmux-style take-over.

Agent-owned sessions are not bound to a browser connection. `terminal.attach` adds each browser as a viewer without taking ownership, and closing a viewer tab detaches only that browser. The PTY remains until the owning agent closes it, its process exits, policy disables it, or the Gateway shuts down. `terminal.list` marks each entry as connection- or agent-owned, and `terminal.text` lets an admin connection read recent plain-text output without attaching.

The terminal is also available as a full-screen, terminal-only document at `/?view=terminal`. The iOS and Android apps embed this page in their Terminal screens, reusing the stored gateway credentials; availability follows the same `gateway.terminal.enabled` and `operator.admin` gate, and the page shows a notice when the connected Gateway does not offer the terminal.

## Browser panel

The Control UI ships a dockable browser panel that renders the Gateway-controlled browser (the same one agents drive through the [browser tool](/tools/browser-control)) in any regular web browser - no native webview required. It appears when the connected Gateway advertises `browser.request` to an `operator.admin` connection; the globe button in the thread workspace rail toggles it. The panel shows a live page snapshot with tabs, an editable URL bar, back/forward/reload, and open-in-your-browser, docks right or bottom, and forwards clicks, wheel scrolling, and basic typing to the remote page.

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
    - The sidebar lists every loaded active session by agent section and pinned/channel/work/custom/Chats buckets with a single New Session action that opens the draft dialog. Opening a visible row moves only the highlight. Sessions can be dropped onto Pinned to pin them, or onto a custom group or Chats to move them; custom groups are collapsible and drag-reorderable, group names and order sync through the gateway, and collapsed state stays in the browser. A new dashboard session asynchronously gets a concise generated title from its first non-command message; explicit names and authenticated sender identity remain separate, so account names are never used as generated titles. Set `agents.defaults.utilityModel` (or `agents.entries.*.utilityModel`) to route this separate model call to a lower-cost model; if that distinct model fails, title generation retries once with the primary model. Expanding another agent section browses that agent's sessions without leaving the open chat.
    - Thread search lives in the command palette (⌘K, or the search button in the top-left control cluster): typing a query follows a bounded number of matching pages across agents, filters internal child/cron rows, and lists visible matches next to navigation commands. The Threads page keeps the exhaustive searchable list with filters.
    - Each sidebar row keeps direct pin access plus a full context menu for unread state, rename, fork, grouping, archive, and delete. Multi-selected rows (Cmd/Ctrl-click, Shift-click for ranges) get a batch menu covering unread state, grouping, archive, and delete; batch archive/delete stays disabled unless every selected session is archivable. An active run and an agent's main session cannot be archived. Archiving or deleting the currently selected session switches Chat back to that agent's main session.
    - In the macOS app, the OpenClaw mark uses the otherwise-empty native titlebar strip next to the window controls instead of consuming a sidebar row.
    - On desktop widths, chat controls stay on one compact row and collapse while scrolling down the transcript; scrolling up, returning to the top, or reaching the bottom restores the controls.
    - The session header shows a small facepile beside the workspace chip when other people are viewing the same session; it lists up to four viewer avatars with an overflow count and disappears when you are alone.
    - Consecutive duplicate text-only messages render as one bubble with a count badge. Messages that carry images, attachments, tool output, or canvas previews are left uncollapsed.
    - User-message bubbles carry transcript actions: a hover rewind button (confirm popover with a "Don't ask again" option) plus right-click **Rewind to here** and **Fork from here**. Rewind repoints the session to the state just before that message and returns its text to the composer for edit and resend (`sessions.rewind`, `operator.admin`); fork creates a new session from the active-path prefix before the message, opens it, and seeds its composer with the same text (`sessions.fork`, `operator.write`). Both actions disable with an explanatory tooltip while the agent is working, apply only to persisted user messages, and are rejected for sessions whose conversation is owned by an external agent harness. Rewind moves chat context only — files and other tool side effects are not reverted — and the pre-rewind transcript remains preserved in the append-only session store. When that store contains multiple transcript branches, the chat title bar shows a branch menu with each branch's latest message, message count, and recency; selecting an inactive branch switches the current session back to that preserved path (`sessions.branches.list`, `operator.read`; `sessions.branches.switch`, `operator.admin`). Branch switching is also unavailable while the agent is working, and selecting the already-active branch is a typed no-op error at the RPC boundary. The separate hide action on user bubbles hides a message in the current browser only; the message stays in the transcript and the agent still sees it.
    - When a session's checkout sits on a non-default branch of a GitHub repository, the chat view pins pull request chips above the composer: PR number, repo, branch, diff counts, a CI pill, and draft/merged/closed state, each linking to the PR. The row shows at most two chips — live (open/draft) PRs first — and a "Show more" button reveals collapsed merged/closed history. The CI pill opens a small CI monitoring popover with passed/failed/running/skipped check counts and a link to the PR's checks page. Detection runs server-side through `controlUi.sessionPullRequests`, which reuses the Gateway's `GH_TOKEN`/`GITHUB_TOKEN` when set. When the GitHub API rate limit is hit, chips keep the last known status and show a warning that the status may be out of date; dismissing a chip hides it for that session in the current browser profile. Before any PR exists, the row shows the branch itself — repo, branch name, and the +/− size of the diff against the default-branch merge base (committed and uncommitted work). Once the pushed branch has commits to compare, the row adds a Create PR button that opens GitHub's new-pull-request page; before that, a session with changed files (committed, uncommitted, or untracked) still gets the row without the button. The row hides itself while an open or draft PR exists. The branch row comes from local git only, so it stays available while GitHub is rate limited and carries the same stale-status warning, since "no PR found" cannot be trusted until the limit resets.
    - The session diff panel shows what a session's checkout actually changed: the branch button in the workspace rail or chat title bar opens the detail panel with a per-file diff of branch, uncommitted, and untracked work against the checkout's default-branch merge base — status dot, rename arrow, per-file +/− counts, collapsible files, and "N unmodified lines" markers between hunks. Diffs are computed server-side through the `sessions.diff` Gateway method (`operator.read` scope); binary and oversized files degrade to stats-only entries, and the button only appears when the connected Gateway advertises `sessions.diff`.
    - Every Chat pane has a title bar. Click the session title to rename it; the workspace chip copies the checkout path or branch and can reveal local Gateway workspaces in the host file manager. Remote and exec-node sessions keep copy actions but hide reveal.
    - The thread workspace rail in each Chat pane lists thread files, project files, and artifacts. It docks to the pane's right edge by default; drag its header (or use the dock button) to move it to the bottom, and the choice is stored in the current browser profile. A collapsed rail takes no space at all: reopen it with ⇧⌘B or the files toggle in the title bar, which carries a changed-file count badge. The separate file, tool, and Canvas detail panel is unaffected.
    - Clicking a file reference in chat, a file path in an expanded read/edit/write tool card, or a file row in the workspace rail opens the file detail panel: a CodeMirror-based code view with syntax highlighting, line numbers, jump-to-line, in-file search, copy actions, and an open-in-external-editor menu. When the Gateway advertises `sessions.files.set` to an `operator.admin` connection, the panel adds an Edit mode with dirty tracking and Cmd/Ctrl-S save; unsaved drafts survive file, panel, and session navigation in the current browser tab until explicitly saved or discarded. Saves are compare-and-swap on a content hash returned by `sessions.files.get`: if the file changed on disk since it was loaded (for example because the agent kept working), the panel shows a conflict notice with Reload (take the latest content) and Overwrite (keep the local edit) actions. Writes go through the same fs-safe workspace guards as reads — path containment, symlink/hardlink rejection, and a 256 KB UTF-8 cap — and only overwrite existing files; the editor never creates or deletes them.
    - The background tasks rail in each Chat pane lists the current agent's background tasks and subagents (`tasks.list` scoped by agent, kept live by `task` events): running work shows a live elapsed timer, tool-use count, the tool currently in use, and a stop control; the collapsible finished section adds run durations; and a View transcript link opens the task's child session in the pane. Open it with the title-bar activity toggle; the task snapshot loads eagerly, so it carries a running-count badge without opening the rail first. The Tasks page remains the full cross-agent ledger.
    - The workspace rail, background tasks rail, and detail panel adapt to each pane's own width rather than the window: in a narrow pane or compact window both rails present as bottom strips (side-dock controls hide until the pane widens; the workspace rail keeps first claim on the side slot when only one column fits), and the detail panel stacks below the thread with a horizontal resize handle instead of sharing the row with it. Phone-sized viewports still open the detail panel full-screen.
    - The chat header model and thinking pickers patch the active session immediately through `sessions.patch`; they are persistent session overrides, not one-turn-only send options.
    - **Split view:** open it from the chat title bar (beside the thread diff, background tasks, and thread files toggles), then split the active pane right or down for as many panes as fit. Each pane has its own thread, transcript, composer, and tool stream.
    - Agents with the `screen` tool can request the same pane, sidebar, terminal, browser, focus, and navigation changes while a capable Control UI is connected. Protocol v1 applies the command to every connected capable Control UI; see [Screen](/tools/screen).
    - Drag a session from the sidebar into chat to open it in a pane. An animated drop preview glides between zones and labels the outcome — "Split" over the exact half a new pane will occupy, "Open here" over a whole pane — and drops also work from single-pane mode.
    - The active split pane drives the sidebar selection and URL. Its title bar adds split and close controls; dividers resize columns and stacked panes, and the browser stores the layout locally across reloads.
    - On narrow screens, split view keeps the layout but renders only the active pane, including its header with the close control.
    - If you send a message while a model picker change for the same session is still saving, the composer waits for that session patch before calling `chat.send` so the send uses the selected model.
    - Typing `/new` creates and switches to the same fresh dashboard session as New Chat, except when `session.dmScope: "main"` is configured and the current parent is the agent's main session; then it resets the main session in place. Typing `/reset` keeps the Gateway's explicit in-place reset for the current session.
    - The chat model picker requests the Gateway's configured model view. If `agents.defaults.modelPolicy.allow` is non-empty, that policy drives the picker, including `provider/*` entries that keep provider-scoped catalogs dynamic. Otherwise the picker shows configured entries plus providers with usable auth; aliases and settings under `agents.defaults.models` do not restrict it. The full catalog stays available through the debug `models.list` RPC with `view: "all"`.
    - When fresh Gateway session usage reports include current context tokens, the chat composer toolbar shows a small context usage ring with the used percentage. Open the ring for the current context window, latest-run token counts and estimated total cost, provider/model identity, and the latest provider response's input/output/cache cost breakdown when reported. The ring switches to warning styling at high context pressure and, at recommended compaction levels, shows a compact button that runs the normal session compaction path. Stale token snapshots are hidden until the Gateway reports fresh usage again.

  </Accordion>
  <Accordion title="Talk mode (browser realtime)">
    Talk mode uses a registered realtime voice provider. Configure OpenAI with `talk.realtime.provider: "openai"` plus an `openai` API-key profile, `talk.realtime.providers.openai.apiKey`, or `OPENAI_API_KEY`. OpenAI Realtime uses the public Platform API and requires a Platform API key; a Codex OAuth login does not satisfy this surface. Configure Google with `talk.realtime.provider: "google"` plus `talk.realtime.providers.google.apiKey`. The browser never receives a standard provider API key: OpenAI receives an ephemeral Realtime client secret for WebRTC, and Google Live receives a one-use constrained Live API auth token for a browser WebSocket session, with instructions and tool declarations locked into the token by the Gateway. Providers that only expose a backend realtime bridge run through the Gateway relay transport, so credentials and vendor sockets stay server-side while browser audio moves through authenticated Gateway RPCs. The Realtime session prompt is assembled by the Gateway; `talk.client.create` does not accept caller-provided instruction overrides.

    Persistent provider, model, voice, transport, reasoning effort, exact VAD threshold, silence duration, and prefix padding defaults live in **Settings → Communications → Talk**; changing them requires `operator.admin` access. Configuring Gateway relay forces the backend relay path; configuring WebRTC keeps the session client-owned and fails instead of silently falling back to relay if the provider cannot create a browser session.

    The Talk control itself is the microphone button in the composer toolbar. Its caret lists **System default** and every microphone exposed by the browser, including USB, Bluetooth, and virtual inputs. The selected device ID stays browser-local and is never sent to the Gateway; if that exact device disappears, Talk asks you to choose another input instead of silently recording from a different microphone. While Talk is live, the microphone button becomes a pill showing the live input-level meter; clicking it stops voice input, and hovering it reveals the stop glyph. Screen readers announce `Connecting voice input...`, `Listening...`, or `Asking OpenClaw...` while a realtime tool call is consulting the configured larger model through `talk.client.toolCall`. Stopping a running agent response stays a separate square **Stop** control next to the pill.

    **Video Talk** is available for OpenAI Realtime WebRTC and Google Live browser sessions. Click the camera button, allow camera and microphone access, and confirm the local preview. OpenAI sends one bounded JPEG frame over its browser data channel when `describe_view` requests visual context. Google Live sends bounded JPEG frames directly from the browser to the provider at the supported maximum of one frame per second and answers `describe_view` function calls with the camera-stream state. Camera frames never pass through the Gateway. Stopping Talk closes the preview and releases both media tracks. See Google's [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities#video) and [function-calling guide](https://ai.google.dev/gemini-api/docs/live-api/tools) for the provider wire contracts.

    Maintainer live smoke: `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts` verifies the OpenAI backend WebSocket bridge, OpenAI browser WebRTC SDP exchange, Google Live constrained-token browser setup with a JPEG frame and `describe_view` function roundtrip, and the Gateway relay browser adapter with fake microphone media. The command prints provider status only and does not log secrets.

  </Accordion>
  <Accordion title="Stop and abort">
    - Click **Stop**. Runs with an exact local run ID call `chat.abort`; when selected-session state reports active work but the Control UI has no local run ID, it calls `sessions.abort` instead. For non-global sessions, that selected-session path also discards queued follow-ups so they cannot restart work after the stop.
    - While a run is active, normal follow-ups use the Gateway's effective `messages.queue` mode. `steer` injects into the running turn; other modes keep the browser's durable queued delivery. Steering rejection also falls back to that queue. Click **Steer** on a queued message to inject it manually.
    - **Settings → Appearance → Chat → Follow-ups while the agent is working** can override that server default for the current browser. The page marks an override explicitly and offers **Reset to server default**. `Steer into the active run` sends follow-ups immediately, while `Queue until the run ends` holds them until the run finishes.
    - Type `/stop` (or standalone abort phrases like `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`) to abort out-of-band.
    - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session. The Control UI uses `sessions.abort` when it has no local run ID.

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
offline, except that **Stop** can queue an exact local run ID for replay. A session-only stop
is not replayed because newer work may start in that session before the connection returns.

When this browser already holds credentials (a configured token/password or an approved device
token), first opens and reloads show a small animated OpenClaw mark while the connection is
established instead of flashing the login gate. The login gate only appears when no credentials
are stored yet or when the Gateway actively rejects them (bad token/password, revoked pairing) —
states that need your input rather than waiting.

## PWA install and web push

The Control UI ships a `manifest.webmanifest` and a service worker, so modern browsers can install it as a standalone PWA. Web Push lets the Gateway wake the installed PWA with notifications even when the tab or browser window is not open.

Inside the macOS app, the Notifications settings page shows the app's native notification permission instead of browser push because the app delivers notifications natively.

If the page shows **Protocol mismatch** right after an OpenClaw update, first reopen the dashboard with `openclaw dashboard` and hard-refresh. If it still fails, clear site data for the dashboard origin or test in a private browser window; an old tab or browser service-worker cache can keep running a pre-update Control UI bundle against the newer Gateway.

| Surface                                            | What it does                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ui/public/manifest.webmanifest`                   | PWA manifest. Browsers offer "Install app" once it is reachable.             |
| `ui/public/sw.js`                                  | Service worker that handles `push` events and notification clicks.           |
| `state/openclaw.sqlite` → `web_push_vapid_keys`    | Auto-generated VAPID keypair used to sign Web Push payloads.                 |
| `state/openclaw.sqlite` → `web_push_subscriptions` | Persisted browser subscription endpoints, keys, and registration timestamps. |

Upgrades from the retired `push/vapid-keys.json` and `push/web-push-subscriptions.json` stores are imported by `openclaw doctor --fix`. Stop the Gateway before running that repair so an older process cannot recreate retired state during import. Run the repair before using Web Push after an upgrade; registration, delivery, deletion, and key resolution refuse to proceed while either retired source or an interrupted Doctor claim remains. The Gateway runtime reads and writes SQLite only.

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

The core [`show_widget`](/tools/show-widget) tool renders self-contained SVG or HTML directly from a tool call. The browser and supported native chat clients advertise the `inline-widgets` Gateway capability, and the resulting Canvas document remains available when chat history reloads. Discord Activities provide the same tool name on Discord; other channel-originated runs do not receive it.

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

## Chat transcript layout

The chat transcript uses a centered readable frame aligned with the composer. Assistant and tool output stay left-aligned while your own messages stay right-aligned inside that frame. In multi-user sessions (for example a group chat relayed from a channel plugin), messages from other attributed participants render left-aligned with the author's avatar, name, and a stable per-identity color, so only the signed-in viewer's messages read as "mine". When two or more attributed participants are present, assistant replies carry a small "Replying to name" marker naming the participant whose message triggered the turn. System entries such as local slash-command output render as centered notice rows without an avatar.

## Chat message width

Wide-monitor users can override the transcript width under **Settings → Chat →
Message width**. The preference stays in that browser's local storage. Supported
forms include plain lengths and percentages such as `960px` or `82%`, plus
constrained `min(...)`, `max(...)`, `clamp(...)`, `calc(...)`, and
`fit-content(...)` width expressions.

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

The supported device-less exception is successful operator Control UI auth
through `gateway.auth.mode: "trusted-proxy"`. There is no persistent config
switch that disables device identity.

**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally at `https://<magicdns>/` (Serve) or `http://127.0.0.1:18789/` (on the gateway host).

<AccordionGroup>
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

## Approval links

Operator approval notifications can deep-link to a standalone approval document served under the reserved `${controlUiBasePath}/approve/{approvalId}` namespace (for example `/approve/<approvalId>`, or `/openclaw/approve/<approvalId>` with a configured base path). The URL is stable for the lifetime of the approval and safe to forward between your own devices: it identifies the approval, never authorizes it.

- The one-segment `/approve/<approvalId>` namespace is reserved by the Gateway ahead of plugin HTTP routes for **all** HTTP methods, so a plugin route can never shadow or intercept an approval document.
- Opening an approval document requires the same gateway auth as the rest of the Control UI (token/password, Tailscale Serve identity, or trusted-proxy identity); credentials are never part of the approval URL.
- When Control UI serving is disabled, requests to the namespace return `404` instead of falling through to plugin handlers.
- Signing in on an approval document is ephemeral for that page: it does not overwrite the gateway selection or settings saved by the full Control UI in the same browser.

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
