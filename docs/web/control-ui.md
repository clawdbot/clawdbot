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

While you watch a running session, the Gateway shows the model's latest safe preamble immediately as the session headline. When a utility model is available, it can replace that headline with a richer compact status digest after enough activity accumulates. Chat carries the result in a **session rail**: its compact pill shows the live digest, while the expanded rail shows the assessment, plan progress, pull requests, elapsed time, and a read-only companion thread. The rail can expand once when a run becomes stuck or needs input, and done or failed runs keep a frozen “finished” time based on the final digest. On wide chat panes the expanded rail docks as a 400 px right column; on narrower and mobile layouts it remains an overlay.

The companion answers questions about the selected session and its project without entering or interrupting the main agent run. On the first question, the Gateway lazily loads a bounded visible snapshot of the selected session before starting the utility model. If history is temporarily unavailable, the question stays visible with **Retry** instead of being treated as an empty session. The companion uses read-only access to the target session's history/search and agent workspace. Its bounded thread is held in Gateway memory, is restored when you switch sessions in the Control UI, and is cleared by the rail's trash button, a session reset, Gateway restart, or idle expiry. It never enters `chat.history`, and private reference context is not stored as operator dialogue. Type `/btw <question>` or `/side <question>` in the main Control UI composer to open the rail and ask there; other clients keep their existing BTW behavior.

Highlighting text in a chat message offers **More details**, which asks the companion immediately, and **Ask in side chat**, which opens the rail with a quoted draft ready to edit.

The headline owns that run's sidebar subtitle instead of heuristic live activity. It is shared with the official iOS and Android session lists. A final done or failed digest remains visible while the session is unread, then the row returns to its normal work subtitle.

Session observation is enabled by default. Safe preamble headlines do not require a utility model; the utility model only owns richer assessments and terminal summaries. In **Settings > Appearance > Sidebar**, you can turn observation off gateway-wide, inspect the resolved small model and its provenance, or choose automatic routing, disable utility tasks, or select an explicit `agents.defaults.utilityModel`. The equivalent config controls are `gateway.controlUi.sessionObserver: false` and `agents.defaults.utilityModel: ""`.

## Environment identity

When you run several Gateways, set `gateway.controlUi.environment` to distinguish their browser tabs and windows:

```json5
{
  gateway: {
    controlUi: {
      environment: { label: "edge", color: "amber" },
    },
  },
}
```

The environment adds a 2 px top stripe, an agent-avatar ring, label pills in the sidebar and narrow topbar, a browser-title suffix, and a matching favicon. The label is trimmed and must contain 1–24 characters. Available colors are `teal`, `amber`, `purple`, `coral`, `pink`, `blue`, `green`, `red`, and `gray`. The label and color are intentionally visible before sign-in; leave `environment` unset to keep the standard appearance unchanged.

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

Onboarding usually configures a gateway token for shared-secret auth. If the Gateway starts in token mode without a configured token, it generates an ephemeral runtime token for that process instead. The runtime token is not written to config, so it cannot be recovered and a loopback browser without that token is rejected. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then run `openclaw gateway auth-token --show` in an interactive terminal and paste the output into Control UI settings. Password auth works instead when `gateway.auth.mode` is `"password"`.

## Device pairing (first connection)

After gateway auth succeeds, connecting from a new browser or device usually requires a **one-time pairing approval**, shown as `disconnected (1008): pairing required`. On the Gateway host, `openclaw dashboard` is the preferred owner path: it opens a short-lived, single-use pairing link and leaves that exact signed browser with a durable administrator credential. Opening a fresh link in the same browser also repairs a previously limited credential; another browser profile cannot inherit or replay the grant.

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

Switching an already-paired browser from read access to write/admin access through ordinary stored or shared credentials is treated as an approval upgrade, not a silent reconnect: OpenClaw keeps the old approval active, blocks the broader reconnect, and asks you to approve the new scope set explicitly. The narrow exception is a fresh owner handoff issued on the Gateway host by `openclaw dashboard` or graphical onboarding; it can upgrade only the same signed browser that redeems that one-time handoff.

When the connected Control UI reports limited access, open **Inbox > System > Limited access**, then click **Request admin**. On mobile, open the sidebar to reach Inbox. The browser files the pending device scope-upgrade request over its existing connection; approve it with `openclaw devices` on the Gateway host or from **Devices** in another admin-capable browser that also has `operator.pairing`. Keep the requesting tab connected while approval completes so it can receive and store the freshly rotated device token before reconnecting. **Retry** reattaches to the pending request. **Cancel** stops the local wait but does not reject the device request; if you cancel or disconnect before approval, use the normal pairing repair path on the next connection.

Once approved, the device is remembered and won't require re-approval unless you revoke it with `openclaw devices revoke --device <id> --role <role>`. See [Devices CLI](/cli/devices) for token rotation, revocation, and the Paperclip / `openclaw_gateway` first-run approval flow.

If the Gateway denies the upgrade because it exceeds your assigned operator role, the access details show the administrator-change guidance without **Retry**. An administrator must change the role before the request can succeed; device approval cannot override that ceiling. **Retry** remains available for pending, rejected, or expired approval requests and retryable failures. **Cancel** clears the local request state so you can make a new request after the underlying problem is resolved.

<Note>
- Direct local Control UI connections from a loopback TCP peer (`127.0.0.1` or `::1`, typically reached as `localhost`) with no forwarded/proxy headers can auto-approve device pairing only after gateway auth succeeds and the browser presents device identity. In token/password mode, the first connection still needs the configured shared secret; this auto-approval is not a token bypass.
- Direct loopback needs no shared secret only when `gateway.auth.mode: "none"` is explicitly configured. That disables gateway auth and is not the recommended Control UI setup. Tailscale Serve and trusted-proxy modes can avoid a pasted shared secret only when their respective identity checks succeed.
- Tailscale Serve can skip the pairing round trip for Control UI operator sessions when `gateway.auth.allowTailscale: true`, Tailscale identity verifies, and the browser presents its device identity. Device-less browsers and node-role connections still follow the normal device checks.
- Direct Tailnet binds and LAN browser connects still require explicit approval. Browser profiles without device identity cannot use loopback auto-approval.
- Each browser profile generates a unique device ID, so switching browsers or clearing browser data requires re-pairing.
- Private windows and browser profiles that discard site data on exit, including Firefox Never remember history, also discard the stored device identity and per-device token. They will appear as a new browser after each restart; use a persistent browser profile to stay paired, and remove stale entries with `openclaw devices remove <deviceId>` when the paired-device list grows.

</Note>

## Pair a mobile device

An already paired administrator can create the iOS/Android connection QR without opening a terminal:

<Steps>
  <Step title="Open mobile pairing">
    Select **Devices**, then click **Pair device** in the **Devices** card.
  </Step>
  <Step title="Connect the phone">
    In the OpenClaw mobile app, open **Settings** → **Gateway** and scan the QR code. You can copy and paste the setup code instead.
  </Step>
  <Step title="Confirm the connection">
    The official iOS/Android app connects automatically. If **Pending approval** shows a request, review its role and scopes before approving it.
  </Step>
</Steps>

Creating a setup code requires `operator.admin`; the button is disabled for sessions without it. A setup code contains a short-lived bootstrap credential, so treat the QR and copied code like a password while they are valid. For remote pairing, the Gateway must resolve to `wss://` (for example, through Tailscale Serve/Funnel); plain `ws://` is limited to loopback and private LAN addresses. See [Pairing](/channels/pairing#pair-from-the-control-ui-recommended) for the full security and fallback details.

## New-session preferences and recents

For connections with a durable user profile, the Gateway stores each agent's latest folder, worktree, model, and thinking choices. The new-session picker also shows recent projects and folders derived only from sessions created by that profile. These conveniences follow the person across browsers; they do not grant access to a project or path.

On the first identified connection, the Control UI uploads existing browser-local new-session preferences only when the Gateway has no such preferences yet. Later changes write to the Gateway first and then update the browser mirror. Connections without a durable identity continue using browser-local preferences and the loaded session roster for recents.

When a remote project session starts before its repository finishes cloning, chat shows workspace preparation progress. If preparation fails, opening or reloading chat restores the session's failure summary. Correct the reported problem, then send a new message in the same session to retry preparation.

## Personal identity

Authenticated people have a durable Gateway profile with a display name, avatar, linked emails, and optional verified GitHub identity. Open **Settings → Profile → Identity** to update the editable fields. The profile follows the authenticated person across browsers; clearing browser site data does not delete it.

GitHub-backed sign-in through Cloudflare Access or Tailscale Serve fills the read-only **GitHub account** row with the verified public avatar and account link without replacing a custom OpenClaw avatar. **Git co-author credit** is a separate, default-off toggle for future commits from shared sessions. See [User model](/concepts/user-model#gateway-profile-and-github-credit) for verification, retry, account-change, noreply privacy, and eligibility rules.

Set an agent's display name, emoji, and avatar under **Agent settings → Overview → Identity**. The identity is stored with that agent and is shared by Control UI clients.

## Runtime config endpoint

The Control UI fetches its runtime settings from `/control-ui-config.json`, resolved relative to the gateway's Control UI base path (for example `/__openclaw__/control-ui-config.json` under base path `/__openclaw__/`). That endpoint is gated by gateway HTTP auth: unauthenticated browsers cannot fetch it, and a successful fetch requires a valid gateway token/password or trusted-proxy identity. Tailscale header auth applies to the Control UI WebSocket, not this HTTP endpoint.

## Gateway host status

Open **Settings → Connection** to see the **Gateway Host** card with the Gateway machine, LAN address, operating system, runtime, uptime, CPU load, memory, and state-volume disk space. The card refreshes every 10 seconds while visible through the `system.info` Gateway RPC, which requires the `operator.read` scope. Older Gateways and connections without that scope omit the card.

## Language support

The Control UI localizes itself on first load based on your browser locale. To override it later, open **Settings → Appearance → Language**.

- Supported locales: `en`, `ar`, `de`, `es`, `fa`, `fr`, `hi`, `id`, `it`, `ja-JP`, `ko`, `nl`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

Docs translations are generated for the same non-English locale set, but the docs site's built-in Mintlify language picker only lists locale codes Mintlify accepts. Thai (`th`) and Persian (`fa`) docs are still generated in the publish repo; they may not appear in that picker until Mintlify supports those codes.

## Appearance themes

The Appearance panel has the built-in Claw, Knot, Dash, Absolutely, Tide, Beacon, and Phosphor themes (Claw is default), plus one browser-local tweakcn import slot. Each theme ships its own self-hosted typeface, loaded only when selected or previewed: Claw uses Instrument Sans, Knot uses Geist, Dash pairs DM Sans with Fraunces for chat prose, Absolutely pairs Space Grotesk with Lora for chat prose, and Tide uses IBM Plex Sans. Beacon targets WCAG AAA (7:1) contrast with the Atkinson Hyperlegible Next typeface for low vision, bright sunlight, projectors, and low-quality panels; Phosphor sets the entire surface, chat prose included, in JetBrains Mono. To import a theme, open the [tweakcn editor](https://tweakcn.com/editor/theme), choose or create a theme, click **Share**, and paste the copied link into Appearance. The importer also accepts `https://tweakcn.com/r/themes/<id>` registry URLs, editor URLs like `https://tweakcn.com/editor/theme?theme=amethyst-haze`, relative `/themes/<id>` paths, raw theme IDs, and default theme names such as `amethyst-haze`.

Imported themes are stored only in the current browser profile; they are not written to gateway config and do not sync across devices. Replacing the imported theme updates the one local slot; clearing it switches back to Claw if the imported theme was active.

Choose an **Accent color** preset or custom color in Appearance to override the active theme's accent. For an authenticated Gateway profile, the accent precedence is the profile's `ui.accent` preference, the gateway-wide `ui.prefs.accent` setting, the operator-configured `ui.seamColor`, and finally the active theme's default. **Restore default** clears only that profile's preference, leaving the gateway-wide settings unchanged. Connections without an authenticated profile keep the existing gateway-wide preference behavior.

The **Typography** block lets you choose an **Interface** face and a separate **Chat prose** face. **Theme default** for Interface and **Match interface** for Chat prose restore the theme’s typography; Dash and Absolutely keep their own serif chat defaults. **System** uses the system sans-serif stack without loading a webfont. Code keeps its monospace stack. Opening either picker loads the self-hosted specimens on demand; startup loads only the active faces. Font overrides follow an authenticated Gateway profile, with a browser-local mirror for instant boot. Without a profile, they stay in that browser and are never written to `openclaw.json`.

Appearance also has a Text size setting. It applies to chat text, composer text, tool cards, and chat sidebars, and keeps text inputs at least 16px so mobile Safari does not auto-zoom on focus.

When your connection is bound to an authenticated Gateway profile, theme, theme mode, and accent color are saved to that profile instead of the gateway config. They follow you across devices without changing anyone else's appearance, override gateway-wide `ui.prefs` values, and update your connected clients live. Connections without an authenticated profile continue syncing these preferences through the gateway config exactly as before. Language and chat display preferences remain gateway-config preferences for every connection. Each browser keeps a local mirror for instant boot, and text size remains browser-local. An explicitly read-only connection applies preference changes only in that browser. Changes made while offline remain queued until a later connection can write their applicable preferences; on a read-only reconnect, they continue to behave as browser-local preferences. See [Configuration reference](/gateway/configuration-reference#ui).

## OpenClaw system care

Open **Settings → Ask OpenClaw** to talk to the system setup and repair agent. Toggle it from anywhere with the lobster button in the sidebar footer or the **Ask OpenClaw** command-palette action. The full page and dockable panel share one machine-wide conversation whose durable history lives on the Gateway. Closing the UI never cancels a turn; reopening Ask OpenClaw shows the completed conversation. The panel docks on the right or bottom, remembers its placement and size in the browser profile, and hides itself while the full page is open.

Each chat message carries the Control UI page you are currently viewing as an untrusted ambient hint, so requests like "configure this channel" or "why is this page empty?" resolve against the page you are looking at.

Guided channel setup, workspace skills setup, web-search provider setup, and local Gateway setup run as hosted wizards inside the chat. Wizard questions stay in the conversation, secret steps mask input in the browser, and successful config-backed flows are audited and re-validated. If a chosen web-search provider needs a plugin install and that install fails, setup stops and reports the failure instead of pretending the provider is configured.

For Gateway setup, say `configure gateway` to choose the port, bind address, token or password auth, and Tailscale exposure. Before the first question, the web surface warns that applying the saved settings requires a restart that may disconnect the chat or require a new Control UI sign-in. The wizard changes config only; say `restart gateway` when you are ready to apply it. It manages only a local Gateway, so remote mode changes stay in `openclaw onboard` or `openclaw configure`.

Say `import memory` to copy detected local memory into the existing default agent workspace. This flow does not change config or import credentials or skills, needs no Gateway restart, and distinguishes confirmed imports, nothing to import, provider failures, and failures where some files may already have been copied. Finish onboarding first if the default workspace does not exist. See [Import assistant memory](#import-assistant-memory) for the broader page that can target another agent or replace existing imports, and [`openclaw setup`](/cli/openclaw) for the operation and approval contract.

Outside onboarding, this page can show at most one dismissible event chip per visit. It stays silent for routine Gateway traffic and reacts only to health snapshots that report a disabled configuration reloader, a configured channel disconnect/degradation, a failed channel probe, or unavailable channel credentials. A newer event replaces the pending chip only when it is more severe; dismissing or using the chip silences event prompts for that visit. Clicking the chip sends its diagnosis question as a real `openclaw.chat` message, so the transcript records the request and OpenClaw performs the diagnosis. Onboarding never shows these event chips.

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
target the store directly with `/settings/plugins/discover`.

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

The sidebar organizes everything around the agent. The identity row at the top is the active agent; below it, the **Pages** section starts with **Home** — the agent's rolling main session, badged with its unread or running state — followed by the pinned destinations (**Automations** and **Plugins** by default). The customize control on the Pages header opens a menu with every other destination, including **Usage** and plugin-provided tabs, plus **Edit pinned items**; right-clicking the navigation area opens the pin editor directly. The session list below splits into zones: **Other** for the agent's ungrouped chat sessions (the main session stays behind Home; sessions it spawned appear here as top-level threads, and named threads show without a type prefix), **Groups** for group and room conversations, and **Coding** for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), ACP-backed harness sessions, and the Codex/Claude CLI catalogs. The **Other** heading is omitted when it is the only section. Coding starts collapsed on first run and remembers your choice; its collapsed header keeps the true count and shows a running indicator while contained sessions work. Custom groups (the session `category`) and **Pinned** rows sit above Other, and assigning a session to a custom group always wins over the automatic zone classification. The global **Sessions** toolbar holds the filter and sort control (Created, Last updated, or Owners when the loaded session roster contains multiple owners), **Group by** — **Custom groups** (the default zone layout above), **Project** to bucket sessions by their repo or workspace checkout (sessions without one keep their zones), **Person** to bucket by owner when the loaded roster has several, or **None** for a single flat list with no zone headers — a persisted **Status** filter for Active, Archived, or All, and the **+** that opens the New session page. The Owners sort mode orders owner groups by name and keeps Created order within each group. On multi-user gateways the same menu adds an **Owners** filter: **All owners**, one specific person or agent, or **Involving me** — sessions you own plus sessions you have prompted, evaluated by the Gateway against the full participant history (see [Multi-user mode](/concepts/multi-user#finding-sessions-by-owner)). Archived rows stay inline, dimmed with an archive glyph; they do not contribute unread or attention state and stay outside lineage promotion. Opening a session moves the selection highlight without reordering rows. Parent sessions with recent child runs show a disclosure and child count; expand it to inspect nested child sessions, live or terminal status, and runtime without leaving the sidebar. Selecting a child opens its chat and automatically reveals its ancestor path. Child rows stay outside root grouping, pinning, dragging, multi-select, and pagination; collapsed zones do not consume the visible page budget. Sessions with new activity since they were last read show an unread dot, and opening one marks it read. Admitted work that has not started shows **Queued** with an hourglass until execution starts. This state does not by itself mean every concurrency slot is occupied. A session holding composer text you typed but never sent shows a pencil badge until the draft is sent or cleared; the active session hides it because its composer is already in view. An agent can also publish a short expiring status line and optionally request attention with a curated amber icon; that declaration clears when you open the session, send the next message, clear it explicitly, or its TTL expires. Cloud-worker lifecycle states use a globe badge; local and reclaimed sessions omit a placement badge because local execution is the default. Each root session row has a context menu (kebab button or right-click) with Pin/Unpin, Mark as unread/read, Rename, Assign to me and Assign to… on multi-user gateways ([session ownership](/concepts/multi-user#assigning-an-owner)), Set icon, Fork, Copy session ID, Move to group (including New group and Remove from group), Archive or Unarchive, and Delete; touch layouts keep the direct pin and menu controls visible. The chat header composes the same single-session management actions with its pane-specific **Panels**, **Layout**, **View**, and **Continue in terminal** actions. Cmd/Ctrl-click opens a session in a new browser tab. Alt/Option-click toggles root rows into a multi-select and Shift-click extends it across the visible order; opening the menu on a selected row then offers batch actions (Mark N as unread/read, Move N to group, Archive N, Delete N) that apply to every selected session, with a single confirmation for batch delete. Drag a root session onto **Pinned** to pin it, or onto a custom group to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names, order, and New Session defaults live in the gateway (`sessions.groups.*`), so they follow you across browsers, while collapsed state stays in the browser profile. Each custom group header has a **+** that opens the normal New Session page and assigns the created session to that group. **New session defaults** in the group menu sets its working directory and Local or Worktree preference; the page prefills those values but leaves them editable. Leaving the directory empty uses the selected agent's workspace. The menu also has Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Other.

Session previews are hidden by default for compact, single-line rows. Enable **Show message preview** in the **Sessions** filter menu to restore routine status text and message previews. The browser remembers your choice. Errors and requests for attention remain visible with previews off.

**Mark as unread** creates a reminder that remains unread while the current chat stays open, including while a run streams or completes. Leave and reopen the session, or choose **Mark as read**, to clear it.

**Rename** in the sidebar, chat header, and Sessions page targets the session you started editing. If that session is deleted and recreated at the same key before you save, the edit is rejected instead of renaming the replacement. Reopen Rename on the current session to try again. Resetting the conversation keeps the same session identity and does not invalidate the edit.

**New group** from the sidebar, chat header, or Sessions page keeps the original session selection while the dialog is open and the group is being saved. A deleted or replaced session is not moved; an error is shown and the new group remains available. For a sidebar multi-selection, sessions that still exist can move even if another target fails. Paging a selected session out of the visible list does not cancel its move.

### Session placement

A selected session running on a worker shows a quiet **Runs on Cloud** chip in the chat header. Connections with `operator.write` can choose **Move session…** to continue on the Gateway or an eligible paired device, and can use **Stop cloud worker…** through the write-scoped `sessions.reclaim` lifecycle. Moving to a configured cloud profile requires `operator.admin`. Cloud rows are filtered against all execution modes advertised by each profile: the same bundled Crabbox profile is selectable for OpenClaw `worker-turn` and Codex `remote-exec`, while a genuinely single-mode profile stays disabled for the other runtime. Profiles with multiple machine classes show a machine picker; choosing the default omits an override, while choosing a different class on the current profile resizes the session. The confirmation explains that an active turn is interrupted and never replayed; OpenClaw reconciles the workspace before activating the destination. While the durable operation is in progress, the chip shows **Moving to…**. If recovery is blocked, the chip exposes the bounded error after reconnect so the action never fails silently.

### Session icons

Choose **Set icon** from a single session's context menu to give its sidebar row one persistent emoji or monochrome icon. The picker includes common emoji and six named icons: `braces`, `book`, `monitor`, `bot`, `kanban`, and `coins`. Choose **Custom emoji…** to enter any single emoji; on macOS, press Control-Command-Space to open the system emoji picker, or press Windows-period on Windows. The `sessions` agent tool can set the same `icon` field. An empty value removes it. This decoration replaces the owner avatar in the leading glyph slot, but temporary attention state always takes precedence so an operator request cannot be hidden.

## New session page

New session **+** controls are links: click to open the draft in the current browser tab, Command-click (macOS) or Ctrl-click (Windows/Linux) to open another tab, or right-click for the browser's **Open Link in New Tab/Window** menu. Middle-click works too. The smaller plus controls on group and catalog sections preserve their target in the new tab; your current conversation stays open.

The **+** in the sidebar's **Sessions** toolbar opens a full-page draft at `/new`: nothing is created until you send the first message. A unified **Place** picker chooses a Gateway project or folder and an execution destination. Connections with `operator.write` can choose **Gateway · local**, **Auto** (least-busy device), or any paired device returned by `environments.list`; administrators additionally see configured cloud profiles and **Connect a machine…**. A cloud profile is selectable when its advertised execution modes include the selected runtime, so one Crabbox **Cloud · profile** row supports both OpenClaw and Codex. Automatic selection chooses the eligible host with the most available worker slots, breaking ties by device ID; runtimes that do not consume worker slots use device ID order. Device eligibility remains authoritative to the environment catalog and the selected runtime: OpenClaw `worker-turn` requires an available current session host with valid worker capacity and at least one free slot; Codex `remote-exec` requires its currently invocable, explicitly authorized exec-server command and consumes no worker slot. Offline known hosts, connected non-hosts, incompatible or saturated hosts, hosts missing required capabilities, outdated hosts, and unavailable hosts remain visible with a reason and next step.

The folder defaults to the agent workspace. Write-scoped connections can browse, restore recent Gateway folders, and start sessions anywhere inside a configured agent workspace; another absolute Gateway path requires `operator.admin` but can run directly without being a Git checkout. Local placement keeps the optional **Worktree** control with a base-branch picker backed by `worktrees.branches` (no fetch) and an optional worktree name (the branch becomes `openclaw/<name>`). Choosing either a device or cloud profile forces a managed worktree from the selected Gateway source. **Start in terminal** is available only for local placement.

For local worktree sessions, sending the first message opens the admitted session before naming, checkout, and setup finish. The chat shows the submitted message and preparation stages. Setup failures remain visible in that session; send a retry there after correcting the problem. Stopping during setup cancels preparation without starting the agent.

For a remote target, the Control UI creates the managed-worktree session with an empty initial message and no `execNode`, dispatches it by exact `deviceId`, `autoDevice: true`, or `profileId` (plus an optional cloud machine class), waits for active placement, and then sends the first message and attachments with the same idempotency key used by recovery. Explicit and automatic device dispatch require `operator.write`; cloud profile dispatch requires `operator.admin`. The composer footer chooses the new session's model and reasoning level.

Model and **Effort** are separate adjacent composer controls in chat and New session, on desktop and mobile. The model picker never contains Effort or Fast-mode controls. Long model labels ellipsize to leave room for the other controls; the full name remains in the picker, accessible label, and tooltip. Mobile Effort uses a gauge whose needle reflects the current level, with a lightning badge when Fast mode is active. In chat, Fast mode stays in the Effort menu, or appears as the adjacent control when reasoning is unavailable. Models with neither available control omit it.

Once the session is created, chat opens immediately. Remote startup uses the same transcript progress indicator and elapsed timer as GitHub workspace preparation, showing provisioning, workspace preparation, startup, and first-message delivery as they happen. The composer stays disabled until the first message is accepted; normal startup is not an error. Startup failures remain visible in the session, with **Retry** when recovery is available.

Canceling or recovering an interrupted remote-placement startup reclaims the placement by session key. Cleanup archives a newly created draft before deleting it with the write-scoped archived-only contract, and any cleanup error remains visible for recovery.

Unsent text and staged attachments can be recovered only in the same browser profile and Gateway credential scope; they are never stored on the Gateway or synced across devices. The browser keeps the 20 most recently edited draft scopes per Gateway credential scope for up to seven days, with at most 25 MiB of attachment data per draft, but it can evict browser storage sooner. A successful send or New Session creation, explicit attachment removal, or confirmed session deletion retires the corresponding browser draft. If cleanup fails after deletion, clear site data for the Control UI origin to remove it. Clearing site data also removes every other browser draft. If a draft's attachments exceed the cap, the current tab keeps them and shows the existing storage warning, but only the text is restart-recoverable. OpenClaw **Incognito** drafts are never durable. In a private browser window, IndexedDB availability and lifetime are controlled by the browser and stored data is normally cleared when the private session ends. The **Incognito** toggle in the new-session page's top-right control rail retires that browser draft and creates a web-only thread whose session entry, transcript, and compaction state stay in memory until the Gateway restarts; OpenClaw also skips its automatic memory flush. The agent keeps its normal tools, so an explicit save request or tool-driven file write can still persist data. The model provider still processes messages, and content-free audit metadata is still recorded. Remote-placement starts persist their model and reasoning choices before dispatching the session to its worker.

**Projects.** The Place picker lists configured agent workspaces and repositories recorded with `projects.register`. Read-only connections receive project names and IDs; checkout paths and origin URLs are included only at `operator.write`. An admin can browse to a Git checkout and choose **Register as project**; write-only operators see a hint directing them to that flow. Choosing a project sends its ID through `sessions.create`, so it can run directly or supply the source for optional Worktree isolation without submitting a raw path. If an agent workspace was moved or removed, update that agent's configured workspace path. If a recorded checkout was moved or removed, re-register it before starting another session there.

**Projects from GitHub.** Search the same picker or paste a GitHub HTTPS or `git@github.com` repository URL to clone it into the Gateway-managed projects area and select it. Public repository search and cloning work anonymously. For affiliated and private repositories, prefer the explicit `gateway.controlUi.github.token` SecretRef so this service access has a clear runtime owner. When it is omitted, the Gateway still uses its shipped `GH_TOKEN` then `GITHUB_TOKEN` fallback from the shared process environment. When it is explicit, its exact environment or store name is excluded from agent execution without clearing unrelated native GitHub CLI variables. Search requires `operator.read`, cloning requires `operator.write`, and deleting a Gateway-managed cloned checkout requires `operator.admin`. Clone deletion refuses while a live session or managed worktree still references the checkout. SecretRef ownership is not an OS-user security boundary; use a sandbox, dedicated host, or dedicated OS user when same-account processes are not trusted.

For agent GitHub CLI identity and Git author setup, see [`tools.github`](/gateway/config-tools#tools-github).

On multi-user gateways, only admin-scope connections can create or view incognito threads, and other sessions cannot reach them through agent session tools or transcript search. Incognito protects against storage and other gateway-mediated users, not against the gateway owner or process operator, who can always observe live sessions.

**Browse folders** opens the Place picker's inline Gateway directory browser through `fs.listDir`. Write-scope browsing starts at the configured agent workspace and cannot navigate above it; realpath checks also reject symlinks that escape the workspace. Admin connections can browse arbitrary Gateway paths. Recent places restore only Gateway folders the current connection can submit; New Session does not browse or remember node filesystem paths. Local submission can call `sessions.create` with the first message in the same round-trip. Remote submission uses the create, dispatch, then send sequence described above. If the Gateway creates the session but rejects that first send, the chat preserves the prompt and error across reloads; **Retry** sends it through the already-created session instead of creating another one.

Inside **Settings**, the dedicated sidebar includes **Ask OpenClaw** and starts with a **Search settings** field for quickly finding settings sections.

On desktop web, a fixed control cluster at the top-left of the content area — the web counterpart of the macOS titlebar strip — holds the sidebar collapse toggle (⌘B) and the command-palette search button (⌘K). Clicking the agent identity row at the top of the sidebar opens the agent menu; **Home** opens the main session. When something needs action — failed or overdue cron jobs, expiring or expired model auth — compact attention chips appear above the sidebar footer and click through to the owning page. The identity row shows the agent's avatar (identity image or emoji), name, connection dot, and a live subtitle. Its agent-scoped menu contains the inline agent switcher (multi-agent setups), **New agent**, "What can this agent do?", and **Agent settings**. Rosters above ten agents get a filter field and list pinned agents first; pin or unpin agents from the Agents settings page, with the pinned set stored in the browser profile. Choosing an agent scopes Chat plus Usage, Automations, Tasks, Workboard, and Sessions to that agent. Each scoped page exposes an **Agent** control with **All agents** as an escape; this widens the shared page scope without changing the concrete chat agent, while direct session links still open their target. The Agents settings page keeps its own [URL selection](/web/urls#route-table) and does not follow the shared page scope. The footer is one full-width identity card that remains available offline and shows **Reconnecting…** beneath the last-known account name. It opens the app/account menu, whose profile identity header is followed by **Settings**, **Usage**, mobile pairing, **Get the apps**, **Help** (help, Discord, Docs, and the changelog), an offline retry action when needed, the version/build chip, and the color-mode toggle. The build chip opens the About page. When the gateway runs from a source checkout on a branch other than `main`, the footer also shows that branch name in red so a non-release gateway is obvious at a glance (release installs never show it). Shift-Command-Comma on Apple platforms or Ctrl-Shift-Comma elsewhere opens **Settings** without overriding the browser's plain Command-Comma shortcut. Collapsing the sidebar (⌘B or the cluster's toggle) hides it entirely for a full-width workspace; while collapsed, the top-left cluster keeps the expand toggle and search and gains a new-thread button — mirroring what the macOS app hosts natively in its titlebar. The sidebar is the only navigation chrome on desktop, with no top bar. Narrow viewports swap the sidebar for a slide-over drawer behind a compact header row holding the drawer toggle, brand, and command-palette search; on phones, Chat absorbs that navigation row into its title bar, with the menu and search controls beside the session title. In the macOS app the separate header row folds the titlebar clearance into a single compact strip beside the window controls. Navigation uses regular browser history, so the browser's back/forward buttons traverse it; the macOS app adds a native sidebar toggle next to the window controls plus trackpad swipe gestures, with back/forward buttons at the sidebar's right edge while it is expanded and native search (command palette) and new-session buttons while it is collapsed.

Sidebar visibility belongs to the current tab and is not remembered across tabs, windows, or reloads; the sidebar's width is still remembered. A chat session opened in a new browser tab from the sidebar starts with the sidebar collapsed; direct links and bookmarks keep it visible. Press ⌘B to reveal it.

Pending approvals also contribute an attention chip above the sidebar footer;
select it to open the owning Approvals page.

## What it can do (today)

<AccordionGroup>
  <Accordion title="Chat and Talk">
    - Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`). Archived sessions keep the composer disabled and show a banner with an **Unarchive** action before the conversation can continue.
    - Chat history refreshes request a bounded recent window with per-message text caps, so large sessions do not force the browser to render a full transcript payload before chat becomes usable.
    - Scroll up to read earlier messages without following incoming output. Use the down-arrow button to return to the latest message. Scrolling manually interrupts that movement or a restored scroll position; messages continue to reserve their space as full text, images, and tool output load.
    - Links to `github.com` in chat messages — yours and the agent's — carry a small GitHub mark before their text, whether the message wrote a bare URL, a `[#3434](…)` shorthand, or any other label. The mark is drawn from the bundled icon set, never fetched from the network, and is decorative only: it is skipped for image-only links such as badges, never appears inside code spans or code blocks, is not read by screen readers, and is not part of copied text.
    - Hovering or keyboard-focusing a public GitHub issue or pull request link shows its state, title, author, recent activity, comments, and change statistics. The connected Gateway fetches and caches public metadata without changing the link target, including when the UI uses a remote Gateway. It uses the explicit Control UI GitHub credential, then the shared Gateway process-environment fallback, after confirming the repository is public; without either, it uses GitHub's anonymous API with a longer cache. It never uses an agent GitHub identity.
    - Talk through browser realtime sessions. OpenAI supports browser WebRTC and Gateway-relayed provider WebSockets, Google Live uses a constrained one-use browser token over WebSocket, and backend-only realtime voice plugins use Gateway relay. Video-capable browser sessions can choose a device-local camera in Settings or flip cameras from the live preview; the browser captures JPEG frames for the realtime provider without streaming camera video through the Gateway. Client-owned provider sessions start with `talk.client.create`; Gateway relay sessions start with `talk.session.create`. The relay keeps provider credentials on the Gateway while the browser streams microphone PCM through `talk.session.appendAudio`, forwards provider delegations or `openclaw_agent_consult` tool calls through Gateway policy and the larger configured OpenClaw model, and routes active-run voice steering through `talk.client.steer` or `talk.session.steer`. Browser WebRTC GPT-Live delegates on the Gateway-owned sideband, but each delegation has the same spoken-confirmation gate and browser-owned `talk.client.steer` lifecycle; a newer spoken task can also supersede the running delegation. Gateway-relayed GPT-Live uses the normal relay consult and steering path. Configure the realtime provider, model, and speaker voice on **Settings → Talk**, whose pickers come from `talk.catalog` and show whether the selection is ready to use.
    - Stream tool calls and live tool output cards in Chat (agent events). Tool activity renders as kind-aware rows: shell commands show the syntax-highlighted command with terminal-style output; supported edit and write calls show bounded inline diffs with source syntax highlighting, line numbers when available, and `+added -removed` stats; and consecutive calls collapse into a summary such as "Ran 13 commands, read 6 files, edited 9 files". While a run is live, the newest running call names the group header. Expand a row to inspect its remaining arguments and raw output.
    - Tool activity counts distinct calls, not start/update/result events, repeated history or live projections, or Gateway observation RPCs. Nested calls count independently, even when their names and arguments match. File summaries count distinct file paths; expand the activity to see each call.
    - Optional AI purpose titles for complex tool calls (long shell commands, argument-heavy plugin tools), enabled with `gateway.controlUi.toolTitles: true` (default off). Titles come from the batched `chat.toolTitles` method through standard utility-model routing — an explicit `utilityModel` (operator-chosen provider, like other utility tasks), else the session provider's declared small-model default — and cache gateway-side per agent. When the opt-in is off or no cheap model is usable, rows keep their deterministic labels and no model call happens.
    - Start or dismiss ephemeral model-suggested follow-up tasks; accepted suggestions open a fresh managed-worktree session with the proposed prompt.
    - Activity tab with browser-local, redaction-first summaries of live tool activity from existing `session.tool` / tool event delivery.

  </Accordion>
  <Accordion title="Channels, sessions, memory">
    - Channels: built-in plus bundled/external plugin channels status, QR login, and per-channel config (`channels.status`, `web.login.*`, `config.patch`).
    - Channel probe refreshes keep the previous snapshot visible while slow provider checks finish, and label partial snapshots when a probe or audit exceeds its UI budget.
    - Threads (a workspace page at `/sessions`, with a **Worktrees** tab alongside it): list configured-agent sessions by default, pin frequent sessions, rename them, archive or restore sessions, fall back from stale unconfigured agent session keys, and apply per-session model/thinking/fast/verbose/trace/reasoning overrides (`sessions.list`, `sessions.patch`). A three-way **Active / Archived / All** filter controls both this page and the sidebar; All dims archived rows and labels them explicitly. Archived sessions keep their transcripts, are never auto-pruned, and remain shelved until explicitly unarchived or deleted. Rows show an unread dot for active sessions with activity since they were last read, with mark-unread/mark-read actions (`sessions.patch { unread }`), and a Fork action that branches the transcript into a new session (`sessions.create { parentSessionKey, fork: true }`). Overview tiles above the table summarize the loaded roster (session count, live runs, unread sessions, total tokens, and archived count when available), each row carries a kind glyph with a live-run dot, status renders as a plain dot plus label, and the Tokens column shows a context-window usage meter when the session reports token and context sizes. Row management actions live in a per-row menu (kebab button or right-click) mirroring the sidebar's session menu, and the row drawer carries the agent runtime and run duration alongside the other session details.
    - Native Claude and Codex sidebar catalogs stream one host at a time, then reconcile after node connectivity changes, on page focus, and at most every 30 seconds while visible. Catalog changes trigger a faster follow-up pass, so sessions created in the native tools appear without reloading the Control UI. Claude Desktop rows also retain their local custom-group label when present; OpenClaw reads that mapping from Desktop's local store and never writes it.
    - Session grouping: a Group by control organizes the sessions table into sections by custom groups, channel, kind, agent, or date. Custom groups persist per session via `sessions.patch` (`category`), so sessions started from message channels (Discord, Telegram, WhatsApp, ...) can be categorized too; assign groups by dragging rows onto a section, or with the per-row group selector, and create groups with the New group action.
    - Memory (a tab on the Agents page, scoped to the selected agent): dreaming status, enable/disable toggle, and Dream Diary reader (`doctor.memory.status`, `doctor.memory.dreamDiary`, `config.patch`). When the `memory-wiki` plugin is enabled, the Diary view adds **Imported Insights** and **Memory Wiki** sub-tabs that browse imported source chats and the compiled wiki — clustered synthesis, entity, and concept pages plus annotated sources and reports, with claims, open questions, contradictions, and inline page previews (`wiki.importInsights`, `wiki.overview`, `wiki.get`).
    - Import Memory (`/memory-import`, reached from the Agents page's Memory tab): preview and copy local Claude Code auto-memory, Codex consolidated memory, or Hermes memory files into the selected agent workspace (`migrations.memory.plan`, `migrations.memory.apply`).
    - Onboarding memory offer: when the Control UI opens in [onboarding mode](/web/urls#other-special-documents-and-startup-modes), a one-page dialog offers to import detected memories with the same plan/apply flow; skipping leaves the settings page as the later entry point.

  </Accordion>
  <Accordion title="Cron, tasks, plugins, skills, devices, exec approvals">
    - Automations (cron jobs): stat cards (automation count, failing count, scheduler state, next wake) above an Automations/Run history tab switch; the Automations tab lists jobs in a filterable table (All/Active/Paused, search, schedule and last-run filters, per-row action menu) with starter suggestions below, and the Run history tab shows recent runs across all automations (`cron.*`).
    - Tasks: live active and recent background task ledger with linked sessions and cancellation (`tasks.*`). Chat's Background tasks rail groups running and finished work; selecting a rail row opens that task's live status and transcript or prompt/output inspector in the detail sidebar.
    - Plugins: browse the installed inventory and curated store, search ClawHub, install and remove plugin code, and enable or disable installed plugins (`plugins.*`); MCP server rows edit `mcp.servers` through the config methods.
    - Skills: status, enable/disable, install, API key updates (`skills.*`).
    - Devices: one inventory joins paired device records, the node catalog, and live presence (`device.pair.list`, `node.list`, `system-presence`). The Gateway host is pinned first; paired clients show connection status, roles, tokens, capabilities, and commands. Duplicate pairings collapse into an expandable group, and **Clean up N stale** bulk-removes admin-confirmed offline duplicates that were auto-approved (silent local, trusted-CIDR, or SSH-verified) or predate approval provenance. Entries can be removed (`node.pair.remove`, `device.pair.remove`), device pairing and node re-approvals handled inline (`device.pair.*`, `node.pair.approve`/`reject`), and mobile setup codes created from the same card.
    - Exec approvals: edit gateway or node allowlists and ask policy for `exec host=gateway/node` (`exec.approvals.*`).

  </Accordion>
  <Accordion title="Config">
    - View/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`).
    - Settings navigation starts with Ask OpenClaw, Profile, Appearance, and Notifications up top; Connections (Connection, Channels, Communications, Talk, Devices); Agents & Tools (Agents, Labs, Models, MCP, Memory, Automation); Privacy & Security (Security, Secrets, Approvals); and System (Infrastructure, Advanced, Debug, Logs, About). Language leads the Appearance page, model defaults live on Models, and Gateway host details live on Connection.
    - Privacy & Security: curated rows for gateway auth, exec policy, browser enablement, tool profile, device auth, and mobile pairing, above the schema-backed `security`/`approvals` sections.
    - Secrets (`/settings/secrets`) manages team-scoped secret and environment entries through `secrets.store.*`. Environment values remain visible, secret values are never returned after saving, Bulk Add accepts quoted multiline dotenv values, and mutation actions are hidden when the connected Gateway does not advertise them.
    - Approvals includes newest-first, 30-day history for resolved exec, plugin, and system-agent requests. Filter by kind or page through older rows to review the decision, reason, source session, and resolver attribution recorded by the Gateway.
    - Labs exposes shipped experimental switches. Code Mode and Swarm are the current entries and save `tools.codeMode.enabled` and `tools.swarm.enabled` immediately; unshipped experiments do not appear or write speculative config keys.
    - Notifications: browser web-push status, subscribe/unsubscribe, and a test send.
    - Advanced: every config section without a curated home, plus the raw JSON5 editor (previously the General page's Advanced mode).
    - In **Advanced → Communication → Channels**, use **Channel settings** to show one messaging channel at a time, including custom channel plugins. **Other** groups shared channel defaults and model overrides. Switching groups does not change the saved configuration.
    - Model Setup (`/settings/model-setup`) is a subpage of Model Providers, launched from its header.
    - Agents: a settings page (**Settings → Agents**, `/settings/agents`) with an **Agent defaults** row for the shared template plus per-agent tabs (Overview, Files, Tools, Skills, Channels, Automations, Memory). The Overview tab edits the agent's identity — display name, emoji, and an avatar image that is downscaled and size-bounded in the browser before `agents.update`. Saving stores configured identity fields and mirrors them to the workspace `IDENTITY.md`; configured values take precedence over manual edits to the same file fields. The Tools tab connects a system or per-agent GitHub identity through a user-clicked device-authorization link, shows the one-time code and credential health, and keeps one-use PAT setup as an explicit fallback.
    - Profile: a settings page showing the default agent's identity with all-time usage stats — lifetime tokens, peak day, longest session, activity streaks, a year-long token heatmap, top tools, and channel highlights (`usage.cost`, `sessions.usage`).
    - MCP has a dedicated settings page with server rows (transport, enablement, OAuth/filter/parallel summaries), direct add/enable/disable/remove controls, common operator commands, and the scoped `mcp` config editor. The Plugins page remains the home for one-click connectors and discovery.
    - Model Providers: a settings page listing every configured model provider with its brand icon, auth state (`models.authStatus`), model availability (`models.list`), live plan/quota/billing data where the provider reports it (`usage.status`), and local session spend for the last 30 days (`sessions.usage`). The initial page reuses the Gateway's prepared model catalog. **Refresh** explicitly discovers the live provider catalog, then re-reads credential state and provider usage; discovery failures stay visible without discarding the last successful model list.
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
    - Incomplete session/cost totals stay readable while the visible, focused page checks for updates. Automatic checks are bounded; if they pause, select **Refresh** to check again.

  </Accordion>
  <Accordion title="Debug, logs, update">
    - Debug: status/health/models snapshots, event log, manual RPC calls, and a System busyness overlay with live CPU, memory, and event-loop delay graphs (`status`, `health`, `models.list`).
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

Open **Settings** → **Import Memory** to bring local Codex, Claude Code, or Hermes memory
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

For a narrower conversational path, open **Settings → Ask OpenClaw** and say
`import memory`. The chat wizard copies only new detected memory into the
existing default agent workspace; it does not choose another destination agent
or replace conflicts. It reports each source's confirmed copy count and warns
when a failure may have happened after a partial copy. Use the dedicated Import
Memory page when you need destination selection, a file preview, or replacement.

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

The Activity tab lives in **Settings › System**, next to Logs and Debug. It has two tabs plus a deep-link inspector:

- **Sessions** shows recent session activity grouped by day, with search, time, and people filters. Active rows offer **Inspect run** when the Gateway has recorded a run reference.
- **Live activity** is the existing ephemeral browser-local observer for tool activity. It is derived from the same Gateway `session.tool` and tool event stream that powers Chat tool cards. It does not add another Gateway event family, endpoint, durable activity store, metrics feed, or external observer stream.
- **Run inspector** is deep-link only and reads the Gateway's durable, immutable `audit.run.inspect` safe-only projection. The RPC contains required `decisionDisplays` and never a raw `decisions` field. Use **Inspect run** on an active session or the run ID link in Live activity, or open `/activity?view=run&run=<percent-encoded-run-id>` directly. Reloading or revisiting the link queries the Gateway again; it never reconstructs identity from Live activity.

Live activity entries keep only sanitized summaries and redacted, truncated output previews. Tool argument values are not stored in Activity state; the UI shows that arguments are hidden and records only the argument field count. The in-memory list follows the current browser tab, survives navigation within the Control UI, and resets on page reload, session switch, Gateway switch, or **Clear**.

The Run inspector shows the retained trust domain, ingress, invoker, represented subject, sponsor, agent definition and principal, runtime instance, applicable grants, assurance evidence, lineage, and a bounded decision-receipt list. Every fact has a text evidence state. **Absent** means the owning boundary explicitly recorded no value; **unattributed** means a supported path had no usable invoker; **unknown** means expected evidence is missing or unreadable; and **unsupported** means the path has no Phase 0 evidence contract. Color is supplemental only.

Select a receipt to see the Gateway's bounded safe-display projection: structural action and outcome fields, evidence limits, and verified display provenance. Fixed core summaries and next steps appear only when the Gateway knows the producer contract from the owning call path. Generic or otherwise unverified receipts show a structural `unknown` classification and omit their summary, remediation, and self-asserted owner metadata. Activity consumes the safe result directly: it performs no UI-side inference, post-receive stripping, or raw-receipt fallback. **Enforced** means the recorded owner changed the outcome after validating the exact context, execution, and run tuple. **Attribution only** records what happened without claiming authorization. **Unsupported** means that observation has no Phase 0 enforcement contract. The inspector displays these states as text badges as well as color and never infers a reason from another field.

Receipt requests are limited to 50 records. **Load more receipts** follows the Gateway's opaque cursor and keeps earlier pages visible. A later-page error does not discard receipts already shown. Each receipt link adds `receipt=<opaque-display-selector>` and, for a later page, `decision=<opaque-cursor>` to the selected run or execution URL. The Gateway-owned selector chooses the projected display row without exposing the stored receipt identifier in the URL or as page text. Reloading that link requests the same bounded page and selects the same projected row. An expired or invalid page cursor is an explicit inspection error; choose **Restart inspection** to keep the selected run or execution and restart from the first page.

Approval and message-delivery links use the `approval-decision:` and `message-decision:` selector namespaces. The owner query mints each selector from its row metadata in the same snapshot as the displayed receipt; private receipt, resolution, and event identifiers never become URL parameters.

Run inspection requires `operator.read` and a Gateway that advertises `audit.run.inspect`. Execution identity collection is off by default; enable `logging.audit.executionIdentity`, restart the Gateway, and record a new run when you need this evidence. Retained contexts are limited to 30 days and 100,000 rows. A known run can therefore report unavailable or expired identity evidence, and a run reference can be ambiguous when it correlates more than one execution. The UI does not guess between executions: choose a returned candidate to navigate to `/activity?view=run&execution=<percent-encoded-execution-id>` and query that exact execution.

The audit ledger is best-effort operational evidence, not a lossless compliance archive. A missing or expired record does not prove that a run or action did not occur. The inspector never displays prompt or message text, command bodies, arguments, file paths, credentials, environment values, raw source identifiers, or arbitrary plugin data. See [Audit history](/gateway/audit) for collection, privacy, retention, and CLI inspection details.

## Operator terminal

The operator terminal is enabled by default; set `gateway.terminal.enabled: false` and restart the Gateway to opt out. The terminal requires an `operator.admin` connection and opens a host PTY in the active agent workspace. New tabs follow the currently selected chat agent.

<Warning>
The terminal is an unconfined host shell and inherits the Gateway process environment. Disable it with `gateway.terminal.enabled: false` on deployments where admin operators should not get a host shell. OpenClaw refuses terminal sessions for agents with `sandbox.mode: "all"`; changing an active agent to that mode closes its existing and in-flight terminal sessions.
</Warning>

Use **Ctrl + backtick** to toggle the **Terminal** tab in the selected Chat pane's unified side panel. You can also open **Terminal** from the panel's **+** menu. The shared panel docks right or bottom, resizes with the browser viewport, can expand over the Chat pane, and keeps multiple shell tabs. Opening a Codex or Claude Code session from the catalog selects **Terminal** and expands the panel. See [Gateway configuration](/gateway/configuration-reference#gateway) for `gateway.terminal.enabled` and the optional `gateway.terminal.shell` override.

The unified panel also hosts **Browser**, **Files**, **Tasks**, **Review**, **Side chat**, and capability-dependent **Desktop** and **Discussion** tabs. Its open or minimized state, active tab, tab order, width, dock, and expanded state are stored per session in the current browser profile, so switching sessions restores each session's own working layout. Drag tabs to reorder them, close a tab without closing the other tools, or use the panel close button to minimize the whole panel.

Owner-authorized, unsandboxed agents can use the `terminal` tool to list, read, resize, or close terminals an operator already opened from the same Chat session's Terminal panel. Agents cannot open shells, and access remains exact-session scoped: an agent cannot inspect or control standalone operator terminals or terminals belonging to another session. Terminal input follows the effective session and host-exec permission policy: **Full access** (`full`, or YOLO) sends it immediately; **Guarded** (`guarded`) and **Workspace** (`workspace`, including accept-only or Guardian-reviewed flows) require an explicit, one-time approval for that exact input; **Read only** (`read-only`) or `tools.exec.mode: "deny"` forbids input entirely. Approving one input never grants unrestricted access to the terminal.

Drag one or more files onto the active terminal, or use the paperclip button to choose files. OpenClaw stages each file on the machine that owns the PTY and pastes shell-quoted absolute paths at the cursor; it never presses Enter or executes the input. A compact batch indicator shows the current file and completed count. Cancel stops the remaining batch without pasting paths; a failed transfer stays visible so you can retry from that file without re-uploading completed files. Images, PDFs, archives, and other file types are accepted up to 16 MiB per file. Staged files use a private system-temporary directory on POSIX hosts (directory mode `0700`, file mode `0600`) or a directory under the user-profile ACL boundary on Windows, plus a 24-hour cleanup timer, so move or copy anything you need to keep.

Path insertion supports PowerShell, `cmd.exe`, and recognized POSIX shells (`sh`, Bash, Dash, Ash, Ksh, Zsh, and Fish), including Git Bash on Windows. Other shell overrides are refused because their quoting rules cannot be inferred safely; run the Gateway inside WSL for a native WSL terminal and Linux upload paths. `cmd.exe` paths containing `%` or `!` are also refused because that shell expands those characters even inside double quotes.

Codex and Claude Code sessions discovered in the sessions sidebar can open in their native CLI inside the same terminal panel. In **Settings › Chat**, set **Open Codex/Claude threads in** to **Terminal** to make a normal row click open `codex resume` or `claude --resume`; the default remains the read-only OpenClaw viewer. A row's right-click or kebab menu always offers both choices, and the viewer header includes **Open in terminal** when that session is eligible.

Eligibility is per session and per host. Gateway-local sessions start the provider-owned resume command on the Gateway host. Paired-node sessions start an allowlisted provider command on the owning node and relay only that PTY's output, input, and resize events; this does not expose a general node shell or accept browser-supplied commands. File uploads use the separate, size-bounded `terminal.upload` node command and remain bound to the already-open terminal session. Approve the node pairing upgrade when that command first appears. Nodes that do not advertise the matching terminal-resume command, including embedded worker bridges without duplex streaming, keep the viewer available and show terminal opening as unavailable; older nodes can still run a terminal but cannot receive dragged files.

Standalone operator sessions, including the terminal focus presentation, are connection-owned. A page reload, laptop sleep, or network blip detaches one on the Gateway instead of killing it, and the same browser tab reattaches on reconnect with recent output replayed. Detached connection-owned sessions are killed after `gateway.terminal.detachedSessionTimeoutSeconds` (default 300 seconds; `0` restores kill-on-disconnect). Attaching one of these sessions remains tmux-style take-over.

Conversation-owned sessions opened from a Chat session's Terminal panel are not bound to a browser connection. `terminal.attach` adds each browser as a viewer without taking ownership, and closing an established viewer tab detaches only that browser. Conversation-owned PTYs remain until the exact-session agent closes them, their shell exits, the session is archived, policy disables them, or the Gateway shuts down. `terminal.list` marks each entry as connection- or agent-owned.

All Gateway terminal PTYs are process-local. A Gateway restart ends them; the
PTY sessions and their scrollback are not recovered after the new process starts.

The terminal is also available as a [focus presentation](/web/urls#focus-presentation-routes). The iOS and Android apps embed this page in their Terminal screens, reusing the stored gateway credentials; availability follows the same `gateway.terminal.enabled` and `operator.admin` gate, and the page shows a notice when the connected Gateway does not offer the terminal. Focus presentation removes the application chrome; it does not invoke browser fullscreen.

## Browser panel

The Control UI ships a **Browser** tab in the unified Chat side panel that renders the Gateway-controlled browser (the same one agents drive through the [browser tool](/tools/browser-control)) in any regular web browser - no native webview required. It appears in the panel's **+** menu when the connected Gateway advertises `browser.request` to an `operator.admin` connection; the globe action in **Files** toggles it. Choosing **Browser** again while its panel tab is already open creates another remote browser tab. The panel shows a live page snapshot with tabs, an editable URL bar, back/forward/reload, and open-in-your-browser, and forwards clicks, wheel scrolling, and basic typing to the remote page. The remote page follows the shared panel: opening it, resizing it, or switching tabs resizes the remote browser viewport to the panel's available space, so the snapshot fills the panel instead of rendering at whatever size an agent last used.

Enable **Open links in Control UI browser** under **Settings → Infrastructure → Browser** to route external HTTP(S) links into new tabs in this panel. The browser-local preference is off by default and appears only while the panel is available; it applies in regular browser-hosted and app-hosted Control UI. Same-origin links, links marked for download, Shift/Alt clicks, file/editor links, email and phone links, right-click actions, and explicit open-in-your-browser actions keep their existing behavior.

Each tab keeps one stable identity across in-place navigation and target replacement, so its selected state, keyboard focus, URL, page snapshot, and browser actions stay aligned even when the Gateway returns tabs in a different order.

Two capture modes package page context for the agent:

- **Annotate (pencil)**: draw freehand markup over the page. **Send to chat** composites the strokes into the screenshot and adds one structured annotation card to the active chat composer. The card keeps its generated page and region context with the image instead of inserting it into your editable draft.
- **Inspect (pointer)**: hover to see the element under the cursor (selector, accessible name, role, size); click to add those details and a highlighted screenshot through the same card flow. Removing an annotation card removes only that image and its generated context, preserves your draft and other attachments, and offers a short-lived **Undo**. Inspect, wheel scrolling, and back/forward need `browser.evaluateEnabled` (on by default).

One composer accepts up to four browser annotation cards and 8,000 total characters of generated annotation context. When it reaches either limit, the browser panel keeps the current capture so you can remove a card and retry; Undo also preserves the limit instead of evicting another card.

Staged images, files, pasted images, large pasted text, browser annotations, and mixed attachment packages stay with their composer and session across route changes, split-pane remounts, hard reloads, and application restarts. The browser-local retention, scope, and disposal rules described under [New session page](#new-session-page) also apply to existing-session composers. If attachments exceed the durable cap, the current tab keeps them and shows the storage warning; the text remains restart-recoverable, but those attachments do not. If the browser refuses storage entirely, the current tab keeps the live composer and shows the same warning, but that draft cannot be recovered after restart.

When this preference is off, the macOS app keeps its native link-browser sidebar for links clicked in the dashboard. The browser panel works there too, and is the way to annotate pages on every other platform.

## Composer capability menu

Select **+** beside the chat composer to open attachments and session capabilities in one menu:

- **Skills** enables or disables individual skills for this session.
- **Connectors** enables or disables configured MCP servers for this session. A **session** tag marks values that differ from the inherited configuration. **Browse connectors** opens the Plugins page on **Discover**.
- **Web search** enables or disables managed web search plus native OpenAI and Codex search for this session.
- **Manage plugins** opens the Plugins page.

These controls are sparse session overrides, like the model and thinking settings in the chat header. A capability with no override inherits the current agent or global configuration, and OpenClaw applies the resolved values when the next run materializes its tools and skills. The **N session overrides** pill in the composer footer reopens the menu; select its clear action to remove all capability overrides in one click.

In **Connectors**, administrators can select **Add MCP server…** and choose a scope. **This session** saves the server definition globally but disabled by default, then enables it only for the current session. **Everywhere** saves the definition enabled globally. Transport, authentication, and other server-definition fields are always global. Session policy can override server enablement and deny individual tools through **Tool access**.

**Tool access** lists a connector's tools once a run has discovered them. Before that, it explains why the list is empty rather than reporting zero tools: a newly added server has not connected yet, a connected server has not finished listing its tools, or the runtime catalog predates a config change. Sessions that run on the Codex harness keep their MCP connections inside Codex, so their tools do not appear here.

Capability toggles stay disabled until the Gateway, session, and runtime config are loaded, and read-only operators cannot change them. Adding a server requires administrator access. See [Connect MCP servers](/tools/mcp) for the Settings, CLI, and config paths.

## Chat behavior

Automatic session titles describe the topic or intended task in your first message.
They are generated separately from the agent's work, so a title is not a completion
status or a report of tool access. Existing titles and manual names are left
unchanged; click a title to rename it.

Chat error banners, including cloud runner failures, keep a compact preview. Open **Error details** to read and select the complete diagnostic received by the UI, then use **Copy error** to copy it. The disclosure works with Enter or Space; the expanded text wraps long lines and can be scrolled with the keyboard. Expanding or copying an error does not retry the failed operation.

<AccordionGroup>
  <Accordion title="Send and history semantics">
    - `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events. Trusted Control UI clients may also receive optional ACK timing metadata for local diagnostics.
    - Chat uploads accept images plus non-video files. Images keep the native image path; other files are stored as managed media and shown in history as attachment links.
    - Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.
    - `chat.history` responses are size-bounded for UI safety. When transcript entries are too large, Gateway may truncate long text fields, omit heavy metadata blocks, and replace oversized messages with a placeholder (`[chat.history omitted: message too large]`).
    - When a visible assistant message was truncated in `chat.history`, **Show more** fetches the full display-normalized transcript entry inline through `chat.message.get` by `sessionKey`, active `agentId` when needed, and transcript `messageId`. **Show less** restores the preview without discarding the fetched content. If the Gateway cannot return more, the message shows an explicit retryable error instead of silently repeating the truncated preview.
    - Assistant/generated images are persisted as managed media references. New clients resolve their stable artifact ids through authenticated `artifacts.download` and receive short-lived, exact-resource media URLs, so reloads do not depend on raw base64 payloads or reusable credentials in image URLs. The chat uses bounded thumbnails and provides Open, Download, and Copy actions for the full image.
    - When rendering `chat.history`, the Control UI strips display-only inline directive tags from visible assistant text (for example `[[reply_to_*]]` and `[[audio_as_voice]]`), plain-text tool-call XML payloads (including `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks), and leaked ASCII/full-width model control tokens. It omits assistant entries whose whole visible text is only the exact silent token `NO_REPLY` / `no_reply` or the heartbeat acknowledgement token `HEARTBEAT_OK`.
    - During an active send and the final history refresh, the chat view keeps local optimistic user/assistant messages visible if `chat.history` briefly returns an older snapshot; the canonical transcript replaces those local messages once the Gateway history catches up.
    - Live `chat` events are delivery state, while `chat.history` is rebuilt from the durable session transcript. After tool-final events the Control UI reloads history and merges only a small optimistic tail; the transcript boundary is documented in [WebChat](/web/webchat).
    - `chat.inject` appends an assistant note to the session transcript and broadcasts a `chat` event for UI-only updates (no agent run, no channel delivery).
    - The sidebar lists every loaded active session by agent section and pinned/channel/work/custom/Chats buckets with a single New Session action that opens the draft dialog. Opening a visible row moves only the highlight. Sessions can be dropped onto Pinned to pin them, or onto a custom group or Chats to move them; custom groups are collapsible and drag-reorderable, group names and order sync through the gateway, and collapsed state stays in the browser. A new dashboard session asynchronously gets a concise generated title from its first non-command message; explicit names and authenticated sender identity remain separate, so account names are never used as generated titles. When New Session creates a worktree without an explicit worktree name, OpenClaw also uses the session label or generated title for its branch name, falling back to a readable crustacean-themed name. Set `agents.defaults.utilityModel` (or `agents.entries.*.utilityModel`) to route this separate model call to a lower-cost model; if that distinct model fails, title generation retries once with the primary model. Expanding another agent section browses that agent's sessions without leaving the open chat.
    - Thread search lives in the command palette (⌘K, or the search button in the top-left control cluster): typing a query follows a bounded number of matching pages across agents, filters internal child/cron rows, and lists visible matches next to navigation commands. The Threads page keeps the exhaustive searchable list with filters.
    - Each sidebar row keeps direct pin access plus a full context menu for unread state, rename, fork, grouping, archive, and delete. Cmd/Ctrl-click opens the session in a new browser tab. Multi-selected rows (Alt/Option-click, Shift-click for ranges) get a batch menu covering unread state, grouping, archive, and delete; batch Archive reports per-session failures while archiving eligible rows, whereas batch Delete keeps its separate idle-or-already-archived eligibility. Archive stays disabled for agent main sessions (including `global` in global scope) and the `unknown` sentinel. For any other session, including one with active work, the Gateway stops and fully drains that session's work before archiving it. The selected archived session stays open with an archived notice and **Unarchive** action; deleting the selected session switches Chat back to that agent's main session.
    - In the macOS app, the OpenClaw mark uses the otherwise-empty native titlebar strip next to the window controls instead of consuming a sidebar row.
    - On desktop widths, chat controls stay on one compact row and collapse while scrolling down the transcript; scrolling up, returning to the top, or reaching the bottom restores the controls.
    - The session header shows a small facepile beside the workspace chip when other people are viewing the same session; it lists up to four viewer avatars with an overflow count and disappears when you are alone. On multi-user gateways the header also carries the permanent session owner chip and a facepile of up to four participants who have prompted the session (owner excluded); sidebar rows compress the same information into a pair-stack — owner in front, one peeking participant or a +N count behind (see [Multi-user mode](/concepts/multi-user#reading-the-avatars)).
    - Consecutive duplicate text-only messages render as one bubble with a count badge. Messages that carry images, attachments, tool output, or canvas previews are left uncollapsed.
    - User-message bubbles carry transcript actions: a hover rewind button (confirm popover with a "Don't ask again" option) plus right-click **Rewind to here** and **Fork from here**. Rewind repoints the session to the state just before that message and returns its text to the composer for edit and resend (`sessions.rewind`, `operator.admin`); fork creates a new session from the active-path prefix before the message, opens it, and seeds its composer with the same text (`sessions.fork`, `operator.write`). Both actions disable with an explanatory tooltip while the agent is working, apply only to persisted user messages, and are rejected for sessions whose conversation is owned by an external agent harness. Rewind moves chat context only — files and other tool side effects are not reverted — and the pre-rewind transcript remains preserved in the append-only session store. When that store contains multiple transcript branches, the chat title bar shows a branch menu with each branch's latest message, message count, and recency; selecting an inactive branch switches the current session back to that preserved path (`sessions.branches.list`, `operator.read`; `sessions.branches.switch`, `operator.admin`). Branch switching is also unavailable while the agent is working, and selecting the already-active branch is a typed no-op error at the RPC boundary.
    - When a session's checkout sits on a non-default branch of a GitHub repository, the chat view pins pull request chips above the composer: PR number, repo, branch, diff counts, a CI pill, and draft/merged/closed state, each linking to the PR. The row shows at most two chips — live (open/draft) PRs first — and a "Show more" button reveals collapsed merged/closed history. The CI pill opens a small CI monitoring popover with passed/failed/running/skipped check counts and a link to the PR's checks page. The Gateway polls only sessions visible in a connected Control UI and pushes changed snapshots through `controlUi.sessionPullRequests.changed`; it uses the explicit Control UI GitHub credential or the shared process-environment fallback for this read-only preview. When the GitHub API rate limit is hit, chips keep the last known status and show a warning that the status may be out of date; dismissing a chip hides it for that session in the current browser profile. Before any PR exists, the row shows the branch itself — repo, branch name, and the +/− size of the diff against the default-branch merge base (committed and uncommitted work). **Publish PR** sends only the session key and bounded presentation text to the Gateway-owned publication broker. The broker derives the repository and branch from session ownership, uses the effective agent GitHub identity rather than the preview credential, and returns the draft pull request URL or an actionable typed failure. The row hides itself while an open or draft PR exists; once the branch's PR is merged and the pushed tip still matches the merged head, the row disappears too. The branch row comes from local git, so it stays available while GitHub is rate limited and carries the same stale-status warning, since "no PR found" cannot be trusted until the limit resets.
    - The session diff panel shows what a session's checkout actually changed: the branch button in the workspace rail or chat title bar opens a dense per-file viewer with normalized added/deleted/modified counts, collapsible files, wrapping and unified/split layouts with source syntax highlighting, file copy/open/editor actions, and "N unmodified lines" markers between hunks. The footer switches between all changes, uncommitted work, and individual commits while showing how far the branch is ahead of its merge base; committed branches also provide a copyable local sync command. Diffs are computed server-side through the `sessions.diff` Gateway method (`operator.read` scope); binary and oversized files degrade to stats-only entries, and the button only appears when the connected Gateway advertises `sessions.diff`.
    - Every Chat pane has a title bar. Click the session title to rename it; the workspace chip copies the checkout path or branch and can reveal local Gateway workspaces in the host file manager. Remote and exec-node sessions keep copy actions but hide reveal.
    - The **Files** tab in each Chat pane's unified side panel lists thread files, project files, and artifacts. Reopen it with ⇧⌘B, the files toggle in the title bar, or the panel's **+** menu; the title-bar toggle carries a changed-file count badge.
    - File paths recognized in chat messages read as their basename with a small glyph for the file type in front — a Markdown page, a `package.json` manifest, a TypeScript source, a `.tsx` component, a config or data file, a shell script, and an image each get their own mark, and anything else falls back to a plain document. When two links in the same message share a basename, each keeps just enough of its trailing path to stay distinct. The full path stays on the link: it is what the tooltip shows, what opens in the file panel, and what the message's **Copy** action returns, since copy hands back the original Markdown. Labels you write yourself in a `[label](path)` link are never rewritten. The glyph is drawn from the bundled icon set, never fetched from the network, and is decorative only: it is not read by screen readers and is not part of copied text. Text that is not a recognizable path — anything carrying spaces, parentheses, a `#` fragment, or a `?` query — stays plain prose.
    - Clicking a file reference in chat, a file path in an expanded read/edit/write tool card, or a file row in **Files** opens the **Review** tab. UTF-8 text files use a CodeMirror-based code view with syntax highlighting, line numbers, jump-to-line, in-file search, copy actions, and an open-in-external-editor menu. AVIF, GIF, JPEG, PNG, and WebP images no larger than 256 KiB render inline; other binary files show metadata without lossy text decoding. When the Gateway advertises `sessions.files.set` to an `operator.admin` connection, the text panel adds an Edit mode with dirty tracking and Cmd/Ctrl-S save; unsaved drafts survive file, panel, and session navigation in the current browser tab until explicitly saved or discarded. Saves are compare-and-swap on a content hash returned by `sessions.files.get`: if the file changed on disk since it was loaded (for example because the agent kept working), the panel shows a conflict notice with Reload (take the latest content) and Overwrite (keep the local edit) actions. Writes go through the same fs-safe workspace guards as reads — path containment, symlink/hardlink rejection, and a 256 KiB UTF-8 cap — and only overwrite existing files; the editor never creates or deletes them.
    - The **Tasks** tab lists the current agent's background tasks and subagents (`tasks.list` scoped by agent, kept live by `task` events): running work shows a live elapsed timer, tool-use count, the tool currently in use, and a stop control, while the collapsible finished section adds run durations. Selecting a task from either a task row or an inline subagent activity row opens its live status and transcript in **Review** without replacing the main conversation; tasks whose session is the current conversation show their prompt and output inspector there instead. Open **Tasks** with the title-bar activity toggle or the panel's **+** menu; the task snapshot loads eagerly, so the title-bar toggle carries a running-count badge without opening the tab first. The Tasks page remains the full cross-agent ledger.
    - The unified side panel adapts to each pane's own width rather than the window: it can dock right or bottom in a wide pane, falls back to a bottom strip in a narrow pane or compact window, and hides its dock controls until the pane widens. Phone-sized viewports still open review content full-screen.
    - The chat header model and thinking pickers patch the active session immediately through `sessions.patch`; they are persistent session overrides, not one-turn-only send options.
    - Diff syntax highlighting uses each file's language and the current theme; unknown file types and oversized previews remain plain text. Inline and session diffs do not require the optional [Diffs plugin](/tools/diffs), which creates standalone viewer links and PNG/PDF attachments.
    - **Split view:** open it from the chat title bar (beside the thread diff, background tasks, and thread files toggles), then split the active pane right or down for as many panes as fit. Each pane has its own thread, transcript, composer, and tool stream.
    - Agents with the `screen` tool can request the same pane, sidebar, terminal, browser, focus, and navigation changes while a capable Control UI is connected. Protocol v1 applies the command to every connected capable Control UI; see [Screen](/tools/screen).
    - Drag a session from the sidebar into chat to open it in a pane. An animated drop preview glides between zones and labels the outcome — "Split" over the exact half a new pane will occupy, "Open here" over a whole pane — and drops also work from single-pane mode.
    - The active split pane drives the sidebar selection and URL. Its title bar adds split and close controls; dividers resize columns and stacked panes, and the browser stores the layout locally across reloads.
    - On narrow screens, split view keeps the layout but renders only the active pane, including its header with the close control.
    - If you send a message while a model picker change for the same session is still saving, the composer waits for that session patch before calling `chat.send` so the send uses the selected model.
    - Typing `/new` creates and switches to the same fresh dashboard session as New Chat, except when `session.dmScope: "main"` is configured and the current parent is the agent's main session; then it resets the main session in place. Typing `/reset` keeps the Gateway's explicit in-place reset for the current session.
    - The chat model picker requests the Gateway's configured model view. If `agents.defaults.modelPolicy.allow` is non-empty, that policy drives the picker, including `provider/*` entries that keep provider-scoped catalogs dynamic. Otherwise the picker shows configured entries plus providers with usable auth; aliases and settings under `agents.defaults.models` do not restrict it. The full catalog stays available through the debug `models.list` RPC with `view: "all"`.
    - When fresh Gateway session usage reports include current context tokens, the chat composer toolbar shows a small context usage ring with the used percentage. Open the ring for the current context window, latest-run token counts and estimated total cost, provider/model identity, and the latest provider response's input/output/cache cost breakdown when reported. The ring switches to warning styling at high context pressure. Stale token snapshots are hidden until the Gateway reports fresh usage again.

  </Accordion>
  <Accordion title="Talk mode (browser realtime)">
    Talk mode uses a registered realtime voice provider. Configure OpenAI with `talk.realtime.provider: "openai"`. GA `gpt-realtime-*` browser WebRTC uses Platform auth in this order: `talk.realtime.providers.openai.apiKey`, an `openai` API-key profile, then `OPENAI_API_KEY`. Native GPT-Live browser WebRTC uses `api.openai.com/v1/live` through the Gateway offer broker and prefers a ChatGPT OAuth subscription profile over Platform auth. GPT-Live also supports Gateway relay through a direct Frameless Bidi WebSocket with Platform API-key auth and no browser or WebRTC provider connection; Platform `/v1/live` access remains waitlist-gated. Configure Google with `talk.realtime.provider: "google"` plus `talk.realtime.providers.google.apiKey`. The browser never receives a standard provider API key or a ChatGPT OAuth token: Platform GA OpenAI receives an ephemeral Realtime client secret, native GPT-Live WebRTC receives a one-use Gateway reservation, and Google Live receives a one-use constrained Live API auth token for a browser WebSocket session. Gateway relay keeps provider credentials and vendor sockets server-side while browser audio moves through authenticated Gateway RPCs. Platform GA sessions use the Gateway's direct-tool prompt, while GPT-Live uses provider delegations. `talk.client.create` does not accept caller-provided instruction overrides.

    Persistent provider, model, voice, transport, reasoning effort, exact VAD threshold, silence duration, and prefix padding defaults live in **Settings → Communications → Talk**; changing them requires `operator.admin` access. Configuring Gateway relay forces the backend relay path; configuring WebRTC keeps the session client-owned and fails instead of silently falling back to relay if the provider cannot create a browser session.

    The Talk control itself is the microphone button in the composer toolbar. Its caret lists **System default** and every microphone exposed by the browser, including USB, Bluetooth, and virtual inputs. The selected device ID stays browser-local and is never sent to the Gateway; if that exact device disappears, Talk asks you to choose another input instead of silently recording from a different microphone. While Talk is live, the microphone button becomes a pill showing the live input-level meter; clicking it stops voice input, and hovering it reveals the stop glyph. Screen readers announce `Connecting voice input...`, `Listening...`, or `Asking OpenClaw...` while a realtime tool call is consulting the configured larger model through `talk.client.toolCall`. Stopping a running agent response stays a separate square **Stop** control next to the pill.

    **Video Talk** is available for OpenAI Platform Realtime WebRTC and Google Live browser sessions; GPT-Live is audio-only. Click the camera button, allow camera and microphone access, and confirm the local preview. OpenAI sends one bounded JPEG frame over its browser data channel when `describe_view` requests visual context. Google Live sends bounded JPEG frames directly from the browser to the provider at the supported maximum of one frame per second and answers `describe_view` function calls with the camera-stream state. Camera frames never pass through the Gateway. Stopping Talk closes the preview and releases both media tracks. See Google's [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities#video) and [function-calling guide](https://ai.google.dev/gemini-api/docs/live-api/tools) for the provider wire contracts.

    Maintainer live smoke: `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts` verifies the OpenAI backend WebSocket bridge, a synthesized PCM24 speech-to-response audio roundtrip, OpenAI browser WebRTC SDP exchange, Google Live constrained-token browser setup with a JPEG frame and `describe_view` function roundtrip, and the Gateway relay browser adapter with fake microphone media. Pass `--openai-audio-cycles 3` for a short repeated OpenAI connect, talkback, and close soak. The command prints provider status only and does not log secrets.

  </Accordion>
  <Accordion title="Stop and abort">
    - Click **Stop**. Runs with an exact local run ID call `chat.abort`; when selected-session state reports active work but the Control UI has no local run ID, it calls `sessions.abort` instead. For non-global sessions, that selected-session path also discards queued follow-ups so they cannot restart work after the stop.
    - While a run is active, normal follow-ups use the Gateway's effective `messages.queue` mode. `steer` injects into the running turn; other modes keep the browser's durable queued delivery. Steering rejection also falls back to that queue. Click **Steer** on a queued message to inject it manually. Text already streamed in an open chat stays before the steering message across history refreshes and reconnects; subsequent updates show only the continuation below it.
    - With **Settings → Appearance → Send shortcut** set to **Enter**, **Cmd/Ctrl+Enter** submits the opposite follow-up action while connected to an active run: queue when Enter steers, or steer when Enter queues (including inherited `collect` and `followup` modes). The send button tooltip shows both actions for the current follow-up setting. This affects only that message, not your saved preference. With the **Cmd/Ctrl+Enter** send shortcut selected, modified Enter remains the normal send action and plain Enter inserts a newline. Interrupt mode keeps its normal behavior.
    - Reorder the queue from the handle on the left of a queued message: drag it, or focus it and press the up and down arrow keys. The position is stored with the message, so it survives a reload and decides delivery order, not just what the list looks like. Rows already handed to a run — sending, steering, running a command, awaiting settings, or waiting on an uncertain delivery — hold their place and split the queue: a message moves only among the rows between two of them, so it can never reach the Gateway ahead of work already handed over.
    - Edit a queued message with the pencil on its row, or by double-clicking the row. The row becomes its own textarea and stays in place while the main composer remains independent, including any separate draft and attachments. Submit replaces the row in the same slot and preserves its attachments; Cancel or Escape discards the row-local draft and restores the queued message. A normal composer send remains a separate queued item even while a row edit is open. The queue behind an edited row waits rather than delivering a message you are still rewriting, so that row splits the queue for reordering the same way an in-flight row does. Queued slash commands keep the discard-and-retype flow.
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

If the connection drops before a send is acknowledged, reconnect checks the transcript and
the session's active or last run ID for delivery proof. A matching run confirms receipt even
before its transcript row appears. Without proof, an attempted message stays in the conversation
with an amber **Delivery unconfirmed** footer and **Retry**. Check the conversation and retry only
if the message did not arrive. Unconfirmed local commands keep their retry/discard queue controls.

First opens and reloads show a small animated OpenClaw mark while the Gateway resolves the initial
connection, including when authentication comes from a trusted proxy or Tailscale instead of a
browser-stored credential. The login gate appears only after the initial connection fails or the
Gateway actively rejects authentication (bad token/password, missing trusted identity, revoked
pairing) — states that need your input rather than waiting.

## PWA install and web push

The Control UI ships a `manifest.webmanifest` and a service worker, so modern browsers can install it as a standalone PWA. Web Push lets the Gateway wake the installed PWA with notifications even when the tab or browser window is not open.

Inside the macOS app, the Notifications settings page shows the app's native notification permission instead of browser push because the app delivers notifications natively.

See [Notifications](/web/notifications) for the browser and macOS setup steps.

If the page shows **Protocol mismatch** right after an OpenClaw update, first reopen the dashboard with `openclaw dashboard` and hard-refresh. If it still fails, clear site data for the dashboard origin or test in a private browser window; an old tab or browser service-worker cache can keep running a pre-update Control UI bundle against the newer Gateway.

| Surface                                                                | What it does                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ui/public/manifest.webmanifest`                                       | PWA manifest. Browsers offer "Install app" once it is reachable.             |
| `ui/public/sw.js`                                                      | Service worker that handles `push` events and notification clicks.           |
| `state/openclaw.sqlite` → `config_machine_state` (`webPush.vapidKeys`) | Auto-generated VAPID keypair used to sign Web Push payloads.                 |
| `state/openclaw.sqlite` → `web_push_subscriptions`                     | Persisted browser subscription endpoints, keys, and registration timestamps. |

Upgrades from the retired `push/vapid-keys.json` and `push/web-push-subscriptions.json` stores are imported by `openclaw doctor --fix`. Stop the Gateway before running that repair so an older process cannot recreate retired state during import. Run the repair before using Web Push after an upgrade; registration, delivery, deletion, and key resolution refuse to proceed while either retired source or an interrupted Doctor claim remains. The Gateway runtime reads and writes SQLite only.

Override the VAPID keypair through env vars on the Gateway process when you want to pin keys (multi-host deployments, secrets rotation, or tests):

- `OPENCLAW_VAPID_PUBLIC_KEY`
- `OPENCLAW_VAPID_PRIVATE_KEY`
- `OPENCLAW_VAPID_SUBJECT` (defaults to `https://openclaw.ai`)

The Control UI uses these scope-gated Gateway methods to register and test browser subscriptions:

- `push.web.vapidPublicKey` fetches the active VAPID public key.
- `push.web.subscribe` registers an `endpoint` plus `keys.p256dh`/`keys.auth`.
- `push.web.unsubscribe` removes a registered endpoint.
- `push.web.test` sends a test notification to registered browser subscriptions.

<Note>
Web Push is independent of the iOS APNS relay path (see [Configuration](/gateway/configuration) for relay-backed push) and the `push.test` method, which targets native mobile pairing.
</Note>

## Hosted embeds

Assistant messages can render hosted web content inline with the `[embed ...]` shortcode. The iframe sandbox policy is controlled by `gateway.controlUi.embedSandbox`:

The core [`show_widget`](/tools/show-widget) tool renders self-contained SVG or HTML directly from a tool call. The browser and supported native chat clients advertise the `inline-widgets` Gateway capability, and the resulting Canvas document remains available when chat history reloads. Channel plugins such as Discord Activities can register contextual presenters behind that same tool. Channel-originated runs without an eligible presenter or inline client do not receive it.

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

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
openclaw gateway --tailscale serve
```

Open `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`).

By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers (`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw verifies the identity by resolving the `x-forwarded-for` address with `tailscale whois` and matching it to the header, and only accepts these on its dedicated managed-Tailscale listener with Tailscale's `x-forwarded-*` headers. For Control UI operator sessions with browser device identity, this verified Serve path also skips the device-pairing round trip; device-less browsers and node-role connections still follow the normal device checks. Set `gateway.auth.allowTailscale: false` if you want to require explicit shared-secret credentials even for Serve traffic, then use `gateway.auth.mode: "token"` or `"password"`.

For that async Serve identity path, failed auth attempts for the same client IP and auth scope are serialized before rate-limit writes. Concurrent bad retries from the same browser can therefore show `retry later` on the second request instead of two plain mismatches racing in parallel.

<Warning>
Tokenless Serve auth assumes the gateway host is trusted. If untrusted local code may run on that host, require token/password auth.
</Warning>

## Insecure HTTP

Opening the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`) works: device identity is generated and signed with pure-JS Ed25519, so pairing does not depend on WebCrypto or a secure context. The signing key never leaves the browser, which makes it the one credential a plaintext transport cannot leak — unlike the shared token, which any on-path observer of an HTTP connection can read.

Plain HTTP remains a downgraded transport: an active attacker on the path can modify the page and capture anything in it. Prefer HTTPS wherever possible — Tailscale Serve gives you a real certificate with no configuration — and treat HTTP as a LAN-only convenience. Browsers also withhold secure-context features (for example passkeys) on HTTP, and Chrome's Local Network Access rules increasingly restrict plaintext local requests.

The supported device-less exception is successful operator Control UI auth
through `gateway.auth.mode: "trusted-proxy"`. There is no persistent config
switch that disables device identity.

**Recommended setup:** HTTPS via `https://<magicdns>/` (Tailscale Serve) or the UI locally at `http://127.0.0.1:18789/` (on the gateway host).

<AccordionGroup>
  <Accordion title="Trusted-proxy note">
    - Successful trusted-proxy auth can admit **operator** Control UI sessions without device identity.
    - This does **not** extend to node-role Control UI sessions.
    - A same-host loopback reverse proxy requires both loopback in `gateway.trustedProxies` and `gateway.auth.trustedProxy.allowLoopback: true`; see [Trusted proxy auth](/gateway/trusted-proxy-auth).

  </Accordion>
</AccordionGroup>

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Content security policy

The Control UI ships a tight `img-src` policy: **same-origin** assets, `data:` URLs, locally generated `blob:` URLs, and the fixed GitHub avatar and Gravatar hosts are allowed. Other remote `http(s)` and protocol-relative image URLs are rejected by the browser and never issue network fetches.

In practice:

- Avatars and images served under relative paths (for example `/avatars/<id>`) still render, including authenticated avatar routes the UI fetches and converts into local `blob:` URLs.
- Inline `data:image/...` URLs still render.
- Local `blob:` URLs created by the Control UI still render.
- Verified GitHub account avatars render from `avatars.githubusercontent.com`; arbitrary avatar hosts remain blocked.
- GitHub link preview avatars are fetched by the Gateway from GitHub's fixed avatar host and returned as bounded `data:` URLs; the operator browser never contacts the remote avatar host.
- Link favicons are on by default. The authenticated Control UI requests them through the Gateway; the browser never contacts link destinations directly. The Gateway requests only each public hostname's HTTPS `/favicon.ico`, with strict DNS-pinned SSRF checks on the original URL and every redirect plus bounded time, bytes, concurrency, and image validation. Private, internal, and IP-literal destinations are rejected. This discloses linked hostnames and the Gateway's network address to those sites. Set `gateway.controlUi.automaticallyFetchFavicons: false` to prevent all favicon route requests and destination fetches.
- Remote avatar URLs emitted by channel metadata are stripped at the Control UI's avatar helpers and replaced with the built-in logo/badge, so a compromised or malicious channel cannot force arbitrary remote image fetches from an operator browser.

The browser-side CSP restriction itself is always on and not configurable.

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

Generated images under `/api/chat/media/outgoing/...` use the same capability
principle through `artifacts.download`. The authenticated WebSocket request
authorizes the transcript artifact and returns a short-lived URL. The HTTP media
route rechecks that the artifact still belongs to the transcript before serving
bytes. The previous shared-owner bearer path remains available for older Control
UI clients during the compatibility window.

## Approval links

Operator approval notifications can deep-link to a [standalone approval document](/web/urls#other-special-documents-and-startup-modes). The URL is stable for the lifetime of the approval and safe to forward between your own devices: it identifies the approval, never authorizes it.

- The approval namespace is reserved by the Gateway ahead of plugin HTTP routes for **all** HTTP methods, so a plugin route can never shadow or intercept an approval document.
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

If the browser loads a blank dashboard and DevTools shows no useful error, an extension or early content script may have prevented the JavaScript module app from evaluating. The static page includes a plain HTML recovery panel that appears when `<openclaw-app>` does not complete its first render after startup.

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
  <Step title="Connect the remote Gateway">
    Follow the [remote Gateway URL handoff](/web/urls#remote-gateway-handoff)
    reference for the encoded Gateway URL and optional one-time credentials.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Origin security notes">
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
