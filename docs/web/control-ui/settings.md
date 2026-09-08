---
summary: "Identity, appearance, plugins, updates, MCP, activity, and meetings"
read_when:
  - Changing appearance, language, or accent color
  - Managing plugins, MCP servers, or updates
  - Editing your profile or importing assistant memory
title: "Settings"
sidebarTitle: "Settings"
---

Everything under Settings, plus the settings-owned pages the sidebar links to.

Model menus with more than eight choices include search. Filter by model name or provider/model reference, then choose a result to apply it. Typing or dismissing the menu leaves the current selection unchanged. Short menus stay compact, and custom model entry remains available where the setting supports it.

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

## Community invitation

The sidebar shows a Discord community invitation by default. Its first appearance waits until sidebar interaction finishes, so it does not move session controls while you use them. Its close button dismisses it for the current browser origin. To hide the invitation for everyone using a Control UI deployment, run this on the Gateway serving that UI:

```bash
openclaw config set gateway.controlUi.communityInvite false
```

After the Gateway applies the change, reload the browser page or reconnect to pick it up. The setting belongs to the Gateway serving the UI, including when that UI connects to a different remote Gateway. Setting it to `false` hides the card even in new browser profiles. Re-enabling it with `true` preserves existing browser-local dismissals.

## Personal identity

Authenticated people have a durable Gateway profile with a display name, avatar, linked emails, and optional verified GitHub identity. Open **Settings → Profile → Identity** to update the editable fields. The profile follows the authenticated person across browsers; clearing browser site data does not delete it.

Profile photos load through authenticated Gateway routes in the online roster, person cards, and chat. Paired browsers use their approved read scopes. When the Mac app connects through an SSH tunnel to a trusted-proxy Gateway, image requests can use the connection's saved password if its paired credential is rejected. Credentials stay in request headers; profiles without an available image show initials.

On a single-user Gateway, unidentified operators share one durable owner profile across devices, including device-token reconnects. Its unset display name is seeded from the Gateway host account's full name, never its login name; saved names are never overwritten. Without a full name, the sidebar shows **Owner**. With `gateway.roles` configured, only token/password connections receive this owner profile; other unidentified connections see an explanation in Identity instead of editing controls. The owner profile has no email and grants no additional permissions.

On macOS, the owner's avatar defaults to the Gateway host account's user picture when no OpenClaw avatar is saved. This uses the Mac running the Gateway, including when you connect from another device. A saved avatar always takes priority. OpenClaw reads the picture locally and serves a resized copy through the authenticated avatar route; other people's profiles never inherit it. Restart the Gateway to pick up a changed macOS picture. If the picture cannot be read, initials remain visible.

**Settings → Profile → Connected accounts** shows the selected **Gateway**, saved **Person**, and **Scope: Personal**. Choose **Add account**, then a provider and sign-in method from the Gateway's catalog. Browser/device sign-in, protected credential inputs, progress, and cancellation use one guided flow. These are the same personal accounts managed by `openclaw models accounts login`, not the machine-local system/agent credentials managed by `models auth`. Account controls follow the Gateway-assigned profile, including the shared owner profile on a single-user Gateway. If the connection has no profile, the section explains the missing identity and offers **Connection settings** without showing provider credential inputs. Shared Gateway tokens and device pairing alone do not distinguish people on a multi-user Gateway. See [Per-person model accounts](/concepts/multi-user#per-person-model-accounts).

GitHub-backed sign-in through Cloudflare Access or Tailscale Serve fills the read-only **GitHub account** row with the verified public avatar and account link without replacing a custom OpenClaw avatar. **Git co-author credit** is a separate toggle, on by default for verified accounts, that controls future commits from shared sessions. See [User model](/concepts/user-model#gateway-profile-and-github-credit) for verification, retry, account-change, noreply privacy, and eligibility rules.

**Settings → Profile → GitHub connections** separately shows **My GitHub** and **System GitHub**. Identified people, including read-scoped operators, can connect and disconnect only their own account; administrators can also change the shared System account. Connecting defaults to **For me** for identified users and never changes their sign-in identity, co-author preference, or shared execution defaults. Personal credentials support explicit Gateway-brokered **Publish PR** actions, not ordinary agent shell commands. See [GitHub connections](/concepts/user-model#github-connections).

Administrators also see the default agent's effective GitHub account and verification status here. **View agent account** opens **Agent settings → Tools → GitHub account**, where any agent's account source, credential type, OAuth expiry, and refresh state are available. Authenticated [GitHub Actions widgets](/tools/show-widget#read-github-actions-runs) use this effective agent account. **Verified** confirms the account with GitHub; repository permissions are checked on each data request.

Credentials reserved for Control UI link previews are excluded from both agent authentication and its displayed status, including when the preview credential uses a SecretRef.

Set an agent's display name, emoji, and avatar under **Agent settings → Overview → Identity**. The identity is stored with that agent and is shared by Control UI clients. Where the transcript shows avatars, saved and streaming assistant replies use the configured agent image or text avatar. Agents without a configured avatar omit the repeated fallback icon.

## Gateway host status

The connection settings use one **Gateway secret** field for the configured
token or password. The Gateway accepts either wire field; its auth mode selects
the configured secret. After a successful token-mode connection, the UI remembers
the secret in session storage for the current browser tab and Gateway only.
Passwords stay in memory and are never persisted.

Open **Settings → Gateway** to see the **Gateway Host** card with the Gateway machine, LAN address, operating system, runtime, uptime, CPU load, memory, and space for each mounted local disk. The card refreshes every 10 seconds while visible through the `system.info` Gateway RPC, which requires the `operator.read` scope. If mounted-disk discovery is unavailable, the card retains the state-directory disk reading when available. Connections without the required scope omit the card.

## Language support

The Control UI localizes itself on first load based on your browser locale. To override it later, open **Settings → Appearance → Language**.

- Supported locales: `en`, `ar`, `de`, `es`, `fa`, `fr`, `hi`, `id`, `it`, `ja-JP`, `ko`, `nl`, `pl`, `pt-BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

Docs translations are generated for the same non-English locale set, but the docs site's built-in Mintlify language picker only lists locale codes Mintlify accepts. Thai (`th`) and Persian (`fa`) docs are still generated in the publish repo; they may not appear in that picker until Mintlify supports those codes.

## Appearance themes

The Appearance panel has the built-in Claw, Knot, Dash, Absolutely, Tide, Beacon, Phosphor, CRT, Manuscript, Rosé, and Miami themes (Claw is default), plus one browser-local tweakcn import slot. Each theme ships its own self-hosted typeface, loaded only when selected or previewed: Claw uses Instrument Sans, Knot uses Geist, Dash pairs DM Sans with Fraunces for chat prose, Absolutely pairs Space Grotesk with Lora for chat prose, Tide uses IBM Plex Sans, Rosé uses DM Sans, and Miami uses Space Grotesk. Beacon targets WCAG AAA (7:1) contrast with the Atkinson Hyperlegible Next typeface for low vision, bright sunlight, projectors, and low-quality panels. Phosphor and CRT set the entire surface, chat prose included, in JetBrains Mono — Phosphor as green-on-glass, CRT as a white-on-black console with squared corners. Manuscript is the one light-first theme: parchment and iron-gall ink with a lapis accent, set entirely in the Lora serif, with a candlelit dark mode. To import a theme, open the [tweakcn editor](https://tweakcn.com/editor/theme), choose or create a theme, click **Share**, and paste the copied link into Appearance. The importer also accepts `https://tweakcn.com/r/themes/<id>` registry URLs, editor URLs like `https://tweakcn.com/editor/theme?theme=amethyst-haze`, relative `/themes/<id>` paths, raw theme IDs, and default theme names such as `amethyst-haze`.

Imported themes are stored only in the current browser profile; they are not written to gateway config and do not sync across devices. Replacing the imported theme updates the one local slot; clearing it switches back to Claw if the imported theme was active.

The mounted UI keeps a live display-preference snapshot for its connected Gateway. Local changes and same-Gateway browser-tab edits update open composers without a reload. Selecting a different Gateway in another tab does not retarget the current tab. Credentials remain owned by the connection, separate from this display snapshot.

Choose an **Accent color** preset or custom color in Appearance to override the active theme's accent. For an authenticated Gateway profile, the accent precedence is the profile's `ui.accent` preference, the gateway-wide `ui.prefs.accent` setting, the operator-configured `ui.seamColor`, and finally the active theme's default. **Restore default** clears only that profile's preference, leaving the gateway-wide settings unchanged. Connections without an authenticated profile keep the existing gateway-wide preference behavior.

The **Typography** block lets you choose an **Interface** face and a separate **Chat prose** face. **Theme default** for Interface and **Match interface** for Chat prose restore the theme’s typography; Dash and Absolutely keep their own serif chat defaults. **System** uses the system sans-serif stack without loading a webfont. Code keeps its monospace stack. Opening either picker loads the self-hosted specimens on demand; startup loads only the active faces. Font overrides follow an authenticated Gateway profile, with a browser-local mirror for instant boot. Without a profile, they stay in that browser and are never written to `openclaw.json`.

Appearance also has a Text size setting. It applies to chat text, composer text, tool cards, and chat sidebars, and keeps text inputs at least 16px so mobile Safari does not auto-zoom on focus.

When your connection is bound to an authenticated Gateway profile, theme, theme mode, and accent color are saved to that profile instead of the gateway config. They follow you across devices without changing anyone else's appearance, override gateway-wide `ui.prefs` values, and update your connected clients live. Connections without an authenticated profile continue syncing these preferences through the gateway config exactly as before. Language and chat display preferences remain gateway-config preferences for every connection. Each browser keeps a local mirror for instant boot, and text size remains browser-local. An explicitly read-only connection applies preference changes only in that browser. Changes made while offline remain queued until a later connection can write their applicable preferences; on a read-only reconnect, they continue to behave as browser-local preferences. See [Configuration reference](/gateway/configuration-reference#ui).

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

## Updates

Open **Settings → Updates** (`/settings/updates`) to check the installed version,
update policy, and active or most recent update. **Update now** opens a
confirmation showing the target and restart impact. Choose **Update and restart**
to start; canceling leaves the Gateway untouched.

After confirmation, one update view shows the ordered phases, current or last
step details, and verification results for the service, version, plugins,
channels, and inference. The details area follows new lines until you scroll up.
The dialog stays open with **Gateway restarting…** while the connection is down.
After reconnecting, it reads the same run from the Gateway; reloading the page
also restores the active or latest run in Settings.

Every completed run keeps a report, including success. Failed runs retain
**Check status**, **Retry update**, and Triage recovery actions. The sidebar update
card shows the active phase and opens the same view. A completed run can appear
there for up to 24 hours until you acknowledge it in that browser.

The report is shared with chat and the CLI. See [Updating](/install/updating)
for installation-specific behavior and [Run history and reports](/cli/update#run-history-and-reports)
for inspecting a run from the Gateway host. In the signed macOS app, an app-owned
local Gateway still uses **Update Mac app + Gateway** and the native update flow.

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

## Settings

Inside **Settings**, the dedicated sidebar includes **Ask OpenClaw** and starts with a **Search settings** field for quickly finding settings sections.

**Native embed mode.** Native hosts can inject `window.__OPENCLAW_NATIVE_EMBED__ = { platform: "ios", formFactor: "phone" }` at document start to show settings without Dashboard navigation chrome. Supported platforms are `ios`, `macos`, and `android`; form factors are `phone`, `pad`, and `desktop`. In this mode, `/settings` lists the same visible groups and destinations as the settings sidebar. Every embedded route outside the settings root provides a Back button and title, including pages reached through links or tabs such as Memory import, Plugins, and Skill Workshop. Back follows app navigation history; direct links fall back to the nearest settings parent (Memory for Memory import) or `/settings`. Layouts respect device safe areas and use touch controls at phone widths. The flag changes presentation only: Gateway scopes and the existing native device-settings capability still determine which settings are available. Ordinary browser loads keep their existing navigation.

Choice fields that accept an explicit `null` value show it as a dropdown option. For optional fields, `null` remains distinct from clearing the setting or selecting its default. Rejected choices, such as a duplicate in a unique-value list, leave the previous selection in place.

On desktop web, the expanded sidebar header places the agent identity beside the sidebar collapse toggle (⌘B), command-palette search button (⌘K), and new-session button. Clicking the identity opens the agent menu; **Home** opens the main session. When something needs action — failed or overdue cron jobs, expiring or expired model auth — compact attention chips appear above the sidebar footer and click through to the owning page. The identity shows the agent's avatar (identity image or emoji), name, optional environment pill, and unread dot; active-run status appears on the owning session row instead of beneath the agent name. Its agent-scoped menu contains the inline agent switcher (multi-agent setups), **New agent**, "What can this agent do?", and **Agent settings**. Rosters above ten agents get a filter field and list pinned agents first; pin or unpin agents from the Agents settings page, with the pinned set stored in the browser profile. Choosing an agent scopes Chat plus Usage, Automations, Tasks, Workboard, and Sessions to that agent. Each scoped page exposes an **Agent** control with **All agents** as an escape; this widens the shared page scope without changing the concrete chat agent, while direct session links still open their target. The Agents settings page keeps its own [URL selection](/web/urls#route-table) and does not follow the shared page scope. The footer is one full-width identity card that remains available offline and shows **Reconnecting…** beneath the last-known account name. It opens the app/account menu, whose profile identity header is followed by **Settings**, **Usage**, mobile pairing, **Get the apps**, **Help** (help, Discord, Docs, and the changelog), an offline retry action when needed, the version/build chip, and the color-mode toggle. The build chip opens the About page. When the gateway runs from a source checkout on a branch other than `main`, the footer also shows that branch name in red so a non-release gateway is obvious at a glance (release installs never show it). Shift-Command-Comma on Apple platforms or Ctrl-Shift-Comma elsewhere opens **Settings** without overriding the browser's plain Command-Comma shortcut. Collapsing the sidebar (⌘B) hides it entirely for a full-width workspace; the top-left content cluster then provides expand, search, and new-session controls — mirroring what the macOS app hosts natively in its titlebar. The sidebar is the only navigation chrome on desktop, with no top bar. Narrow viewports swap the sidebar for a slide-over drawer behind a compact header row holding the drawer toggle, brand, and command-palette search; on phones, Chat absorbs that navigation row into its title bar, with the menu and search controls beside the session title. In the macOS app the separate header row folds the titlebar clearance into a single compact strip beside the window controls, while the sidebar header retains the agent identity and right-aligned new-session button. Navigation uses regular browser history, so the browser's back/forward buttons traverse it; the macOS app adds a native sidebar toggle next to the window controls plus trackpad swipe gestures, with back/forward buttons at the sidebar's right edge while it is expanded and native search (command palette) and new-session buttons while it is collapsed.

The bottom-left account footer, including the Settings sidebar, shows **Suspending…** while the Gateway prepares or drains work and **Suspended** once suspension is ready. Restart status takes precedence. During reconnect, fresh suspension reports from the Gateway keep that state visible; unexplained disconnects show **Offline**. The suspension indicator clears when the Gateway accepts work again or its last suspension report expires.

Sidebar visibility belongs to the current tab and is not remembered across tabs, windows, or reloads; the sidebar's width is still remembered. A chat session opened in a new browser tab from the sidebar starts with the sidebar collapsed; direct links and bookmarks keep it visible. Press ⌘B to reveal it.

Pending approvals also contribute an attention chip above the sidebar footer;
select it to open the owning Approvals page.

When an approval appears inline in a different session, **Approval requested by session**
uses the requesting session's loaded title, not the open conversation's title. If that
metadata is unavailable, the normal session-name fallback remains until it loads.
This label does not change which request the approval buttons resolve.

### Side panel keyboard shortcuts

The side panel **+** menu and the keyboard shortcut overview (⌘/ on Apple
platforms, Ctrl+/ elsewhere) show the same panel shortcuts. A shortcut opens its
panel, activates an existing hidden tab, or closes the panel when it is visible.
Only the active, presented chat pane responds, including while the composer has
focus. Availability follows the menu: Terminal, Browser, Desktop, and Discussion
need their corresponding capabilities; Dashboard needs an available session board
and is omitted in compact panes. Conversation has no shortcut.

| Panel      | macOS | Windows / Linux  |
| ---------- | ----- | ---------------- |
| Terminal   | ⌃\`   | Ctrl+\`          |
| Browser    | ⌘⌥⇧U  | Ctrl+Alt+Shift+U |
| Files      | ⌘⇧B   | Ctrl+Shift+B     |
| Side chat  | ⌘⇧S   | Ctrl+Shift+S     |
| Tasks      | ⌘⌥⇧K  | Ctrl+Alt+Shift+K |
| Desktop    | ⌘⌥⇧D  | Ctrl+Alt+Shift+D |
| Discussion | ⌘⌥⇧J  | Ctrl+Alt+Shift+J |
| Dashboard  | ⌘⌥⇧G  | Ctrl+Alt+Shift+G |
| Review     | ⌘⌥⇧E  | Ctrl+Alt+Shift+E |

Command+Option chords accept Option symbols through the physical key; Ctrl+Alt chords require the matching ASCII letter to preserve non-ASCII AltGr text. Dead keys and composition are ignored.

The new panel chords include Option/Alt to avoid browser actions such as developer
tools, Read Aloud, and find previous, and OpenClaw's existing debug-overlay shortcut.
The existing Terminal, Files, and Side chat bindings are unchanged.

<a id="this-mac-macos-app" />

### This device (macOS and iOS apps)

Inside the [macOS app](/platforms/macos), Settings includes a **This Mac** group
for settings on that Mac. **This Mac** (`/settings/device`) contains app behavior,
device capabilities, browser login import and cookie sync, and developer tools.
**Permissions** (`/settings/device/permissions`) shows macOS permission status
and actions, location preferences, and active computer presence.

**Talk** adds a **This Mac** section for Voice Wake, push-to-talk, sounds,
microphone, and languages. **Updates** adds the app version, automatic update
preference, and **Check for Updates**. These device settings appear only inside
the OpenClaw app; ordinary browsers keep the Gateway settings. Talk trigger words
are Gateway settings and remain available in every browser.

On iOS, the group is **This iPhone** or **This iPad**. The device page shows
appearance, notifications, camera, keep awake, and health summaries when
available, plus actions to open Diagnostics, Licenses, About, and Apple Watch.
Only settings published by the app appear; iOS does not show Mac browser or
app-update controls. Permissions include the access published by the device,
including limited access to contacts or photos. Precise location is read-only
on iOS; **Open Settings** opens the system setting. Talk shows the device's
Voice Wake, Talk mode, Talk button, background Talk, and speakerphone controls.

## Custom plugin UI

**Settings → Labs → Custom plugin UI** enables native pages, widgets, actions,
and view replacements from user-installed plugins. It defaults to off and
writes `gateway.controlUi.experimental.customPlugins`. Restart the Gateway and
reload connected browser tabs after changing it.

Only enable it for plugin authors you trust: native UI runs in the Control UI
origin with the signed-in operator's Gateway authority. Native UI from enabled
bundled plugins, including Workboard, remains available with the lab off.
Backend plugin APIs, ordinary plugin loading, sandboxed dashboard widgets, and
MCP Apps are unaffected. All plugin APIs are experimental; see
[Feature plugins](/plugins/feature-plugins) for authoring and the trust model.

Authenticated native UI requires HTTPS or a browser-trusted loopback URL.
On non-local plain HTTP, plugin pages explain how to open a supported URL;
dashboard pairing and backend plugin operations remain available.

## Import assistant memory

Open **Settings** → **Import Memory** to bring local Codex, Claude Code, or Hermes memory
into an OpenClaw agent. The Gateway discovers supported local memory on its own
host, so a remote Control UI imports from the Gateway computer rather than the
browser computer.

If the agent list fails to load, the page shows the Gateway error. Select
**Refresh** to try again; **Settings → Memory** provides **Retry** for the same failure.

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

Open **Activity** from the sidebar's page picker, or visit `/activity` under the Control UI's base path. It has two tabs plus a deep-link inspector:

- **Sessions** shows recent session activity grouped by day, with search, time, and people filters. Active rows offer **Inspect run** when the Gateway has recorded a run reference.
- **Live activity** shows running and queued sessions above the ephemeral browser-local tool stream. The session snapshot comes from the Gateway; the tool stream uses the same `session.tool` and tool events that power Chat tool cards.
- **Run inspector** is deep-link only and reads the Gateway's durable, immutable `audit.run.inspect` safe-only projection. The RPC contains required `decisionDisplays` and never a raw `decisions` field. Use **Inspect run** on an active session or the run ID link in Live activity, or open `/activity?view=run&run=<percent-encoded-run-id>` directly. Reloading or revisiting the link queries the Gateway again; it never reconstructs identity from Live activity.

The Sessions view owns its query independently of the sidebar. Its people filter uses the Gateway's full visible-session associations before pagination, not the four-avatar participant preview. `sessions.list` accepts `involvingProfileId` and `includePeople`; the response reports the canonical selected profile ID, bounded people counts, and `peopleIncomplete`. Only Gateway profiles appear as people. Remote, agent, and unresolved identities cannot acquire profile names or links through an equal raw ID. Counts and dates describe associated sessions, not a person's last input; recorded participation, verified creation, and assigned responsibility remain distinct from permission to see a session. Old profile links follow profile merges. A limit notice identifies incomplete participant history or truncated results.

The Sessions view batches bursts of session-change events into a refresh. Event-driven refreshes pause while the browser tab is hidden and catch up once when you return. Changing filters or retrying a failed request still loads immediately.

To find an older archived conversation, choose **Sessions**, **All time**, and **Everyone** in the people filter, then enter its name or label in **Search session titles…**. This metadata search includes archived sessions and applies across the complete caller-visible store before the 100-result window. Narrow the query if results are truncated. Open an archived match to read its retained history, then select **Unarchive** to continue the same conversation.

**Active sessions** loads when you open Live activity and refreshes after reconnecting, so sessions already running or queued appear before new tool events arrive. It shows up to 100 sessions you are allowed to see, including work on other agents and agent-owned global sessions. A limit notice appears when more sessions match. Select a linked row to open that session. Reserved `unknown` sessions show status without a conversation link; raw `global` sessions do the same outside global session scope, where the Home URL addresses a different session. Changes update this snapshot while the view is open; disconnected or failed reads show a visible status instead of claiming that sessions are idle. **Clear** only clears the received-event list. It does not clear or stop active sessions.

Live activity keeps up to 100 sanitized summaries with redacted, truncated output previews. Tool argument values are not stored in Activity state; the UI shows that arguments are hidden and records only the argument field count.

The current browser tab collects permitted incoming activity across sessions and agents while you visit other Control UI pages, including before you first open Live activity. Navigation and chat selection preserve this bounded list. Use the visible search, tool, and status filters to narrow the displayed entries. Page reload, Gateway or authentication-context change, and **Clear** reset the list. Ordinary reconnects preserve the list and expanded entries. This browser-local feed covers received events; it is not a durable record of work performed while the browser was closed or disconnected.

The Run inspector shows the retained trust domain, ingress, invoker, represented subject, sponsor, agent definition and principal, runtime instance, applicable grants, assurance evidence, lineage, and a bounded decision-receipt list. Every fact has a text evidence state. **Absent** means the owning boundary explicitly recorded no value; **unattributed** means a supported path had no usable invoker; **unknown** means expected evidence is missing or unreadable; and **unsupported** means the path has no Phase 0 evidence contract. Color is supplemental only.

Select a receipt to see the Gateway's bounded safe-display projection: structural action and outcome fields, evidence limits, and verified display provenance. Fixed core summaries and next steps appear only when the Gateway knows the producer contract from the owning call path. Generic or otherwise unverified receipts show a structural `unknown` classification and omit their summary, remediation, and self-asserted owner metadata. Activity consumes the safe result directly: it performs no UI-side inference, post-receive stripping, or raw-receipt fallback. **Enforced** means the recorded owner changed the outcome after validating the exact context, execution, and run tuple. **Attribution only** records what happened without claiming authorization. **Unsupported** means that observation has no Phase 0 enforcement contract. The inspector displays these states as text badges as well as color and never infers a reason from another field.

Receipt requests are limited to 50 records. **Load more receipts** follows the Gateway's opaque cursor and keeps earlier pages visible. A later-page error does not discard receipts already shown. Each receipt link adds `receipt=<opaque-display-selector>` and, for a later page, `decision=<opaque-cursor>` to the selected run or execution URL. The Gateway-owned selector chooses the projected display row without exposing the stored receipt identifier in the URL or as page text. Reloading that link requests the same bounded page and selects the same projected row. An expired or invalid page cursor is an explicit inspection error; choose **Restart inspection** to keep the selected run or execution and restart from the first page.

Approval and message-delivery links use the `approval-decision:` and `message-decision:` selector namespaces. The owner query mints each selector from its row metadata in the same snapshot as the displayed receipt; private receipt, resolution, and event identifiers never become URL parameters.

Run inspection requires `operator.read` and a Gateway that advertises `audit.run.inspect`. Execution identity collection is off by default; enable `logging.audit.executionIdentity`, restart the Gateway, and record a new run when you need this evidence. Retained contexts are limited to 30 days and 100,000 rows. A known run can therefore report unavailable or expired identity evidence, and a run reference can be ambiguous when it correlates more than one execution. The UI does not guess between executions: choose a returned candidate to navigate to `/activity?view=run&execution=<percent-encoded-execution-id>` and query that exact execution.

The audit ledger is best-effort operational evidence, not a lossless compliance archive. A missing or expired record does not prove that a run or action did not occur. The inspector never displays prompt or message text, command bodies, arguments, file paths, credentials, environment values, raw source identifiers, or arbitrary plugin data. See [Audit history](/gateway/audit) for collection, privacy, retention, and CLI inspection details.

## Meetings page

Open the sidebar's pencil menu (**Edit pinned items**) and choose **Meetings**
to read saved meeting notes at `/meetings`. Choose **Edit pinned items** inside
that menu to pin Meetings; it is not a default pinned item.
Meeting transcripts are separate from agent chat-history search in **Sessions**.

Each page contains up to 50 meetings, grouped by local day with newest first.
Rows show participant previews, duration, an overview when available, and distinct
**In progress** and **No speech captured** states. Search by title or session/source ID, then
select a meeting. Existing `/meetings?selector=...` links open its saved summary. Meeting URLs are
not searched. Open **Filters** for
provider, account, agent, and date controls; the disclosure opens automatically
when those filters are active. Provider, account, and agent IDs match
exactly. Date filters use UTC session start times, with an inclusive lower bound
and exclusive upper bound. **Next page** continues the ordered results;
**First page**, a filter change, or **Refresh** starts a new pagination pass.
The reader opens **Summary** first. Select **Transcript** for timestamped speaker
text alongside the list on desktop or in a single column on mobile. Its URL
preserves the selected meeting and tab.

**Search within this transcript** searches the full stored transcript in bounded
server pages. **Load more** continues through utterances or matches; only the
latest five loaded pages stay in the browser's reading window. **Read from
beginning** returns to the first page. **Summary** renders the stored Markdown
notes, including their speaker-labeled transcript, and labels model-generated or
heuristic provenance when available. Opening this tab does not run a summary job.
Missing summaries and empty transcripts have distinct empty states.
Saved summaries load independently of speech pages. If a transcript page exceeds
its transfer limit, you can still read the saved notes and download an export
within the export limit below.

**Download Markdown** downloads the transcript and any stored summary;
**Download JSONL** downloads the reader's public utterance projection, including
full text, sequence, utterance and speaker identity, source timestamps, and
finality when available. Provider-private metadata and local filesystem paths
are excluded; local CLI exports retain their existing raw format. Browser exports are limited to
4 MiB and fail visibly rather than downloading a partial file. For larger exports,
use the [Transcripts CLI](/cli/transcripts). Archive access requires `operator.read`
or its write/admin implication and a profile allowed to read the shared archive;
an agent filter does not bypass that restriction.

If a library read or download reports denied access, the browser clears its
cached library and reader pages. **Retry** keeps those notes hidden until a fresh
authorized response arrives and starts the reader from its first page. Temporary
network errors alone do not remove already loaded reader pages. Files already
downloaded remain yours.

Configure capture in **Settings → Communications → Meeting capture**, which also
links back to the library. Administrators can change the existing
`transcripts.enabled` setting and add, edit, or remove `transcripts.autoStart`
sources. Edits preserve account and source locators, titles, and custom session
IDs through the shared config draft. Form changes auto-save through the standard
Settings coordinator, including validation and conflict handling. If a restart
interrupts a pending draft, the footer shows **Autosave paused after reconnect**;
review the retained draft and select **Save** to submit it on the new connection.
**Messages** remains the default Communications section. The full transcript schema editor
is available under **Meeting capture → Advanced settings**.

Title-only edits keep the current capture running and apply the new title to
future captures; current and saved notes are not renamed. Continuous capture
supports an optional custom session ID. Leave it empty for generated IDs and
avoid reusing IDs from the same day, which can collide with existing archive
entries. Occupancy mode chooses session IDs automatically and ignores the custom
ID field. The editor disables that field in occupancy mode while preserving its
saved value. Health distinguishes startup retries from capture attempts that
cannot safely retry. See [capture configuration](/cli/transcripts#configuration).

Enabled plugin manifests with explicit auto-start setup metadata are offered for
new sources even before runtime loads. An observed runtime `canStart: false`
prevents new setup. The manifest declares which
locator fields are supported and required. Existing entries remain editable
without losing fields when metadata is unavailable. Providers that only attach
to an already-active meeting bot are not offered as boot auto-start sources.

Capture is opt-in for voice channels: joining voice does not record, and recording
participants does not grant command or agent permissions. **Enabled** permits
capture; **Armed** reports a registered subscription, not confirmed recording.
**Not active** and **Unknown** remain distinct. Configured URL sources remain
unknown when the retained sanitized URL cannot prove the original invitation
identity. Saved utterance counts come from
durable rows. The latest saved transcript is the most recently updated session
containing utterances, not an exact last-ingestion ordering. Source speech times
are labeled explicitly; ingestion timestamps are not recorded. Continuous sources may span several room occupations. With occupancy mode
enabled, capture saves notes when the room empties and may continue a recently
stopped capture from the same source and agent within ten minutes when its stored
ID origin is known to be generated. A supplied or unknown origin starts a fresh
capture, leaving the existing notes unchanged.
Speech-to-text may use your configured provider and incur provider usage. The UI
does not play raw audio, generate summaries on demand, or delete transcripts.

Meetings reads the same shared SQLite records as `openclaw transcripts`.
Discord voice and the Google Meet, Microsoft Teams, and Zoom meeting plugins
populate this store. See the [Transcripts CLI](/cli/transcripts) for capture setup,
agent reads, and exports.
