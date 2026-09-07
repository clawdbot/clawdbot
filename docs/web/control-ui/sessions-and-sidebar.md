---
summary: "Sidebar zones, session menus, and the New session page"
read_when:
  - Finding, grouping, or renaming sessions
  - Starting a session on a device, worktree, or cloud profile
  - Starting a native Codex or Claude Code terminal
title: "Sessions and sidebar"
sidebarTitle: "Sessions and sidebar"
---

The sidebar organizes every session, and the New session page starts new ones.

## New session names

In **New session**, pausing typing for one second prepares a session name in the
background using only the selected agent's utility model. Preparation sends unsent
draft text to that provider before submission. It starts after at least 12 characters
and sends at most the first 1,000 characters; it does not send attachments.

Preparation is disabled in incognito and for slash commands. Edits replace stale
prepared names, and only one request runs at a time. A missing or failed utility model
does not fall back to the primary model or prevent you from starting the session.

An explicit personal account selection waits for account confirmation before
preparing a title. A utility model on the same provider uses that account unless
the utility model specifies its own auth profile. Changing the model or account
discards the old suggestion; neither action changes your saved account default.
With **Automatic**, title preparation uses the agent's utility-model auth, which
can differ from the personal default selected when the actual chat starts.

**Start session** uses a matching prepared name if it is ready. Otherwise, normal
initial naming runs after submission; Start never waits for the speculative call.
This is creation-only: later messages do not regenerate an existing session's
name. Explicit worktree names are preserved, and typing never creates a worktree
or runs setup.

## New-session preferences and recents

For connections with a durable user profile, the Gateway stores each agent's latest folder, worktree, model, and thinking choices. The new-session picker also shows recent projects and folders derived only from sessions created by that profile. These conveniences follow the person across browsers; they do not grant access to a project or path.

On the first identified connection, the Control UI uploads existing browser-local new-session preferences only when the Gateway has no such preferences yet. Later changes write to the Gateway first and then update the browser mirror. Connections without a durable identity continue using browser-local preferences and the loaded session roster for recents.

When a remote project session starts before its repository finishes cloning, chat shows workspace preparation progress. If preparation fails, opening or reloading chat restores the session's failure summary. Correct the reported problem, then send a new message in the same session to retry preparation.

Accepted browser messages, including initial prompts waiting for workspace
preparation and follow-ups during a run, remain visible as normal message bubbles
until their own turn starts, without an additional receipt notice. Inputs accepted through `sessions_send` or the
Gateway `agent` method use the same display. They are stored separately from the active model transcript. If
cancellation or a Gateway restart interrupts that wait,
the message stays readable with its recorded disposition and is never resent
automatically. Copy it into the composer to start a new attempt. **Show earlier
messages** pages through messages that are still waiting or were stopped before
processing; **Show latest messages** returns to the newest page. A long message
uses the normal full-message reader without becoming a transcript reply, fork,
or rewind target.

Browser drafts and unsent messages remain in the local queue. Once the Gateway
accepts an ordinary browser message, it owns the approved input in durable
custody. Collect mode consumes the accepted sources with their combined
transcript entry. Acceptance does not imply that a transcript row already
exists; the accepted input replaces its local pending copy and later becomes
one canonical message, including its attachments.

## Sidebar navigation

The sidebar organizes everything around the agent. The identity row at the top is the active agent; below it, the **Pages** section starts with **Home** — the agent's rolling main session, badged with its unread or running state — followed by the pinned destinations (**Automations** and **Plugins** by default). The customize control on the Pages header opens a menu with every other destination, including **Usage** and plugin-provided tabs, plus **Edit pinned items**; right-clicking the navigation area opens the pin editor directly. The session list below splits into zones: **Other** for the agent's ungrouped chat sessions (the main session stays behind Home; sessions it spawned appear here as top-level threads, and named threads show without a type prefix), **Groups** for group and room conversations, and **Coding** for sessions bound to a managed worktree or exec node (rows show a `repo ⎇ branch` line plus the node host), ACP-backed harness sessions, and the Codex/Claude CLI catalogs. The **Other** heading is omitted when it is the only section. Coding starts collapsed on first run and remembers your choice; its collapsed header keeps the true count and shows a running indicator while contained sessions work. Custom groups (the session `category`) and **Pinned** rows sit above Other, and assigning a session to a custom group always wins over the automatic zone classification. The global **Sessions** toolbar holds the filter and sort control (Created, Last updated, or Owners when the loaded session roster contains multiple owners), **Group by** — **Custom groups** (the default zone layout above), **Project** to bucket sessions by their repo or workspace checkout (sessions without one keep their zones), **Person** to bucket by owner when the loaded roster has several, or **None** for a single flat list with no zone headers — a persisted **Status** filter for Active, Archived, or All, and the **+** that opens the New session page. The Owners sort mode orders owner groups by name and keeps Created order within each group. On multi-user gateways the same menu adds an **Owners** filter: **All owners**, one specific person or agent, or **Involving me** — sessions you own plus sessions you have prompted, evaluated by the Gateway against the full participant history (see [Multi-user mode](/concepts/multi-user#finding-sessions-by-owner)). Archived rows stay inline, dimmed with an archive glyph; they do not contribute unread or attention state and stay outside lineage promotion. Opening a session moves the selection highlight without reordering rows. Parent sessions with recent child runs show a disclosure and child count; expand it to inspect nested child sessions, live or terminal status, and runtime without leaving the sidebar. Selecting a child opens its chat and automatically reveals its ancestor path. Child rows stay outside root grouping, pinning, dragging, multi-select, and pagination; collapsed zones do not consume the visible page budget. Sessions with new activity since they were last read show an unread dot, and opening one marks it read. Accepted work immediately shows an activity ring. It spins during startup and execution, pauses with **Queued** only during a scheduler-confirmed concurrency-slot wait, and resumes when a slot is granted. With reduced motion enabled, the ring stays still. A session holding composer text you typed but never sent shows a pencil badge until the draft is sent or cleared; the active session hides it because its composer is already in view. An agent can also publish a short expiring status line and optionally request attention with a curated amber icon; that declaration clears when you open the session, send the next message, clear it explicitly, or its TTL expires. Cloud-worker lifecycle states use a globe badge; local and reclaimed sessions omit a placement badge because local execution is the default. Each root session row has a [session menu](#session-menu), opened with its kebab button or right-click; touch layouts keep the direct pin and menu controls visible. The chat header composes the same single-session management actions with its pane-specific **Panels**, **Layout**, and **View** actions. Cmd/Ctrl-click opens a session in a new browser tab. Alt/Option-click toggles root rows into a multi-select and Shift-click extends it across the visible order; opening the menu on a selected row then offers batch actions (Mark N as unread/read, Move N to group, Archive N, Delete N) that apply to every selected session, with a single confirmation for batch delete. Drag a root session onto **Pinned** to pin it, or onto a custom group to move it. Custom group headers can be collapsed, expanded, or dragged to reorder them; group names, order, and New Session defaults live in the gateway (`sessions.groups.*`), so they follow you across browsers, while collapsed state stays in the browser profile. Each custom group header has a **+** that opens the normal New Session page and assigns the created session to that group. **New session defaults** in the group menu sets its working directory and Local or Worktree preference; the page prefills those values but leaves them editable. Leaving the directory empty uses the selected agent's workspace. The menu also has Rename group, New group, and Delete group; renaming or deleting a group updates every member session server-side, including archived ones, and deleting a group keeps its sessions and moves them back to Other.

Switching agents refreshes the session list even while other conversations are active. A confirmed permission change remains visible if its follow-up list refresh fails.

Session previews are hidden by default for compact, single-line rows. Enable **Show message preview** in the **Sessions** filter menu to restore routine status text and message previews. The browser remembers your choice. Errors and requests for attention remain visible with previews off.

Enable **Hide empty groups** in the same menu to hide custom groups with no sessions in the current sidebar view. It is off by default, and the browser remembers your choice. Collapsed groups with sessions stay visible. Hidden groups keep their membership and order and remain available in **Move to group**; turn the setting off to use their headers as drag targets again.

**Mark as unread** creates a reminder that remains unread while the current chat stays open, including while a run streams or completes. Leave and reopen the session, or choose **Mark as read**, to clear it.

**Delete** removes the confirmed selection from loaded session lists immediately and leaves any deleted conversation that is open. The Gateway finishes deletion in the background, safely stopping and reclaiming an attached cloud worker first. If deletion fails, the affected session can reappear with an error; other successful deletions and any navigation you made in the meantime are preserved. Browser drafts are retired only after deletion is confirmed, not while the request is pending.

**Rename** in the sidebar, chat header, and Sessions page starts with your custom name or the generated dashboard title. Edit the text, then save or press Enter. Saving an unchanged generated title leaves automatic naming intact; clearing a custom name restores the generated title. Channel and account decorations stay outside the editable name. Rename targets the session you started editing. If that session is deleted and recreated at the same key before you save, the edit is rejected instead of renaming the replacement. Reopen Rename on the current session to try again. Resetting the conversation keeps the same session identity and does not invalidate the edit.

**New group** from the sidebar, chat header, or Sessions page keeps the original session selection while the dialog is open and the group is being saved. A deleted or replaced session is not moved; an error is shown and the new group remains available. For a sidebar multi-selection, sessions that still exist can move even if another target fails. Paging a selected session out of the visible list does not cancel its move.

### Session menu

The menu groups routine actions first: **Pin/Unpin**, **Rename**, **Mark as unread/read**, and **Archive/Unarchive**. **Delete** stays separate at the bottom.

- **Icon & color** opens one picker with color swatches, an icon grid, and **Reset to default**. It stays open while you change both; the sidebar reflects your changes.
- **Move to group** includes **New group** and **Remove from group**. Multi-user gateways also offer **Assign to** ([session ownership](/concepts/multi-user#assigning-an-owner)).
- **Fork conversation** creates a separate conversation; while a run is active, it forks from the last completed message.
- **Copy** offers a session link, conversation text as Markdown, and the session ID. The link requires normal Gateway authentication and session access; copying it does not grant access. Markdown loads the available conversation history, not just the messages currently visible. Both copied Markdown and `/export` downloads retain the conversation's sender labels, so messages from different participants remain distinguishable.
- **Open in** offers a new browser tab or window. Desktop chat also offers **Split right** and **Split below**. Eligible local workspaces expose native editor destinations, and the chat header includes **Continue in terminal** in this submenu.

### Session placement

A selected session running on a worker shows a quiet **Runs on Cloud** chip in the chat header. Connections with `operator.write` can choose **Move session…** to continue on the Gateway or an eligible paired device, and can use **Stop cloud worker…** through the write-scoped `sessions.reclaim` lifecycle. Moving to a configured cloud profile requires `operator.admin`. Cloud rows are filtered against all execution modes advertised by each profile: the same bundled Crabbox profile is selectable for OpenClaw `worker-turn` and Codex `remote-exec`, while a genuinely single-mode profile stays disabled for the other runtime. Profiles with multiple machine classes show a machine picker; choosing the default omits an override, while choosing a different class on the current profile resizes the session. The confirmation explains that an active turn is interrupted and never replayed; OpenClaw reconciles the workspace before activating the destination. While the durable operation is in progress, the chip shows **Moving to…**. If recovery is blocked, the chip exposes the bounded error after reconnect so the action never fails silently.

During the initial handoff, the chat placement menu and stop confirmation use the selected destination: **Stop device worker…** for explicit or automatic paired-device placement, **Stop cloud worker…** for a cloud profile, or neutral **Stop worker…** when the target is unknown; all use `sessions.reclaim`. A destination retained for retry after a failed startup does not label a later restart.

### Session icons

Choose **Icon & color** from a single session's context menu to give its sidebar row one persistent emoji or monochrome icon. The picker includes common emoji and six named icons: `braces`, `book`, `monitor`, `bot`, `kanban`, and `coins`. Choose **Custom emoji…** to enter any single emoji; on macOS, press Control-Command-Space to open the system emoji picker, or press Windows-period on Windows. The `sessions` agent tool can set the same `icon` field. An empty value removes it. This decoration replaces the owner avatar in the leading glyph slot, but temporary attention state always takes precedence so an operator request cannot be hidden.

## Session colors

Choose **Icon & color** from a session menu and select a color swatch to add a narrow color stripe to its sidebar row and a matching dot beside the chat title. Pick one of eight colors, or choose **Default** to clear only the color. **Reset to default** clears both the icon and color. The colors match Claude Code’s `/color` names, so imported Claude Code sessions keep the same color. Imported catalog rows show their color without offering color editing.

## New session page

New session **+** controls are links: click to open the draft in the current browser tab, Command-click (macOS) or Ctrl-click (Windows/Linux) to open another tab, or right-click for the browser's **Open Link in New Tab/Window** menu. Middle-click works too. The smaller plus controls on group and catalog sections preserve their target in the new tab; your current conversation stays open.

The **+** in the sidebar's **Sessions** toolbar opens a full-page draft at `/new`: nothing is created until you send the first message. A unified **Place** picker chooses a Gateway project or folder and an execution destination. Connections with `operator.write` can choose **Gateway · local**, **Auto** (least-busy device), or any paired device returned by `environments.list`; administrators additionally see configured cloud profiles and **Connect a machine…**. A cloud profile is selectable when its advertised execution modes include the selected runtime, so one Crabbox **Cloud · profile** row supports both OpenClaw and Codex. Automatic selection chooses the eligible host with the most available worker slots, breaking ties by device ID; runtimes that do not consume worker slots use device ID order. Device eligibility remains authoritative to the environment catalog and the selected runtime: OpenClaw `worker-turn` requires an available current session host with valid worker capacity and at least one free slot; Codex `remote-exec` requires its currently invocable, explicitly authorized exec-server command and consumes no worker slot. When that command is unavailable, the picker distinguishes a node that did not declare it, a declaration that awaits pairing approval, and a declaration blocked by Gateway command policy. Offline known hosts, connected non-hosts, incompatible or saturated hosts, hosts missing required capabilities, outdated hosts, and unavailable hosts remain visible with a reason and next step.

The folder defaults to the agent workspace. Write-scoped connections can browse, restore recent Gateway folders, and start sessions anywhere inside a configured agent workspace; another absolute Gateway path requires `operator.admin` but can run directly without being a Git checkout. Local placement keeps the optional **Worktree** control with a base-branch picker backed by `worktrees.branches` (no fetch) and an optional worktree name (the branch becomes `openclaw/<name>`). Choosing a device or cloud profile with a Gateway folder selected uses a managed worktree. With a GitHub repository selected, **Remote checkout** sends its URL and optional ref directly to the runner without creating a Gateway checkout.

### Start a native coding CLI

The **+** beside **Codex** or **Claude Code** opens a native CLI draft, not an
OpenClaw Chat. Choose the machine and folder, optionally enter a first prompt,
and press **Start in terminal** or Enter (or your configured submit shortcut).
The terminal opens with keyboard focus. The CLI uses that
machine's native account, model, and configuration; OpenClaw does not translate
model or authentication settings or automatically adopt the native session.
Native draft text is not sent to OpenClaw for automatic title preparation.
Ordinary **New Chat** and explicit catalog continuation remain separate flows.

Native starts require `operator.admin`, `gateway.cliAgents.enabled`,
an enabled catalog plugin, and its installed CLI. Terminals are on by default;
`gateway.terminal.enabled: false` blocks native starts.
No matching OpenClaw model route is required. The host picker lists only local
CLI sources and connected nodes with the exact fresh-start command currently
invocable. Resume-only nodes are not eligible. After installing a CLI or approving
a node capability change, reconnect the node and refresh the host picker.

On the Gateway, the folder/worktree controls still provision the selected managed
worktree before launching. On a node, enter an existing absolute directory on
that node; create a worktree there first if needed. Native starts do not use
OpenClaw worker placement, cloud/Auto selection, attachment submission, model
controls, or Incognito. Add files and change native CLI settings in the terminal.
A missing directory, disabled capability, or disconnected host produces an error;
OpenClaw never starts a Chat or substitutes another host or home directory.

### OpenClaw Chat workspace startup

On a normal foreground OpenClaw Chat send, the submitted text and attachments appear immediately with a **Starting** indicator while the Gateway creates or adopts the session. This is a pending submission, not a Gateway acknowledgment. If creation is rejected, your prompt and attachments remain available to correct and retry. Once creation succeeds, the UI opens the session's chat.

The project picker refreshes after sign-in and reconnects. Gateway reconnects and Git verification retries preserve your edited base branch and worktree name. Choosing another folder or project clears those repository-specific details.

For local worktree sessions, sending the first message opens the admitted session before naming, checkout, and setup finish. The chat shows the submitted message and preparation stages. A generated title is saved as soon as naming completes, independently of checkout and setup. Setup failures remain visible in that session; send a retry there after correcting the problem. The retry reuses the saved title. If naming itself fails, another attempt uses the original first prompt, including text attachments. Stopping during setup cancels preparation without starting the agent. Steering an active run keeps its progress visible, and delayed history cannot replace a newer startup stage or restore startup labels after activity begins.

For a remote target, the Control UI creates the repository or managed-worktree session with an empty initial message and no `execNode`, dispatches it by exact `deviceId`, `autoDevice: true`, or `profileId` (plus an optional cloud machine class), waits for active placement, and then sends the first message and attachments with the same idempotency key used by recovery. Explicit and automatic device dispatch require `operator.write`; cloud profile dispatch requires `operator.admin`. The composer footer chooses the new session's model and reasoning level.

Model and **Effort** are separate adjacent composer controls in chat and New session, on desktop and mobile. The model picker never contains Effort or Fast-mode controls. Long model labels ellipsize to leave room for the other controls; the full name remains in the picker, accessible label, and tooltip. Mobile Effort uses a gauge whose needle reflects the current level, with a lightning badge when Fast mode is active. In chat, Fast mode stays in the Effort menu, or appears as the adjacent control when reasoning is unavailable. Models with neither available control omit it.

When you switch sessions, the composer keeps the session's known model name visible while refreshing the model options available for that session. If the model is not yet known, the control shows a loading placeholder. Locked chats also show the selected model, or **Session model** when it is not known. The lock prevents model selection changes; it does not indicate that a native runtime owns the model.

Once the session is created, chat opens immediately. Remote startup uses the same transcript progress indicator and elapsed timer as GitHub workspace preparation, showing provisioning, workspace preparation, startup, and first-message delivery as they happen. The composer stays disabled until the first message is accepted; normal startup is not an error. Startup failures remain visible in the session, with **Retry** when recovery is available.

If startup recovery cannot load after a page reload, the session keeps the loading error and **Retry** available across session switches. Switching sessions does not restart recovery or reset its elapsed time. The saved first message continues holding later input until recovery loads and confirms its delivery state. While this page is responsive and unsaved starts await the recovery code, automatic in-app reloads are blocked and **Retry** is replaced by a warning. This includes Incognito starts and paused starts whose recovery could not be saved. Reload controls elsewhere in the app explain the same restriction. Choose **Discard unsaved starts and reload** to resume saved starts and discard the unsaved starts. The same action is available in the warning shown by other blocked Reload controls. This protection is limited to the open, responsive page; closing it or browser-managed navigation can still discard unsaved input. Incognito input is never saved to browser storage.

If remote startup fails before the first message is sent, chat retains the submitted text, attachments, selected destination, and a bounded error in the same browser tab and Gateway credential scope. Reloading shows the paused submission without provisioning another worker. **Retry** retains the repository URL/ref or Gateway worktree choice and uses the already-created session and the original profile and machine class, device, or Auto selection; it waits for active placement before sending. The session keeps its model and reasoning settings, including any later changes you make in that session. This tab-local startup recovery uses the tab's existing session-storage lifetime, separately from the ordinary browser draft limits below. Incognito startup recovery remains in memory only. A disconnect hides the retained content until the same credential scope is verified again, but does not release its first-turn hold: later input stays in the composer instead of entering the ordinary offline queue. Sessions without an unresolved initial turn keep normal offline queuing.

If the Gateway explicitly rejects the first send, **Retry** creates a new send attempt on that same session and destination. If delivery is uncertain, **Check delivery** looks for the original user message or an exact Gateway receipt showing that the input was retained or consumed. It never resends the prompt, provisions a worker, or treats missing history as proof that delivery failed. A matching receipt clears the browser startup hold without implying that the run has finished. Retained inputs keep their Gateway-owned status, including interrupted or cancelled inputs, without another optimistic message. Without a receipt, the prompt and attachments remain accessible and normal sending stays disabled. Inspect the conversation, or copy the retained prompt if you choose to start a separate attempt. This recovery does not promise exactly-once delivery across Gateway restarts. If browser storage rejects a recovery update, keep the current page open to preserve its in-memory input.

When an interrupted remote-placement draft needs deletion, cleanup reclaims the placement by session key, archives it with its expected session identity, then uses the write-scoped archived-only delete contract. Cleanup errors remain visible. Restoring paused or unconfirmed recovery does not itself request deletion.

Unsent text and staged attachments can be recovered only in the same browser profile and Gateway credential scope; they are never stored on the Gateway or synced across devices. The browser keeps the 20 most recently edited draft scopes per Gateway credential scope for up to seven days, with at most 25 MiB of attachment data per draft, but it can evict browser storage sooner. A successful send or New Session creation, explicit attachment removal, or confirmed session deletion retires the corresponding browser draft. If cleanup fails after deletion, clear site data for the Control UI origin to remove it. Clearing site data also removes every other browser draft. If a draft's attachments exceed the cap, the current tab keeps them and shows the existing storage warning, but only the text is restart-recoverable. OpenClaw **Incognito** drafts are never durable. In a private browser window, IndexedDB availability and lifetime are controlled by the browser and stored data is normally cleared when the private session ends. The **Incognito** toggle in the new-session page's top-right control rail retires that browser draft and creates a web-only thread whose session entry, transcript, and compaction state stay in memory until the Gateway restarts; OpenClaw also skips its automatic memory flush. The agent keeps its normal tools, so an explicit save request or tool-driven file write can still persist data. The model provider still processes messages, and content-free audit metadata is still recorded. Remote-placement starts persist their model and reasoning choices before dispatching the session to its worker.

**Projects.** The Place picker lists configured agent workspaces and repositories recorded with `projects.register`. Read-only connections receive project names and IDs; checkout paths and origin URLs are included only at `operator.write`. An admin can browse to a Git checkout and choose **Register as project**; write-only operators see a hint directing them to that flow. Choosing a project sends its ID through `sessions.create`, so it can run directly or supply the source for optional Worktree isolation without submitting a raw path. If an agent workspace was moved or removed, update that agent's configured workspace path. If a recorded checkout was moved or removed, re-register it before starting another session there.

**Projects from GitHub.** Search the same picker or paste a GitHub HTTPS or `git@github.com` repository URL. For a remote destination, creation records that source and the runner fetches it during dispatch; no Gateway project clone is required. For Gateway execution, the picker clones into the Gateway-managed projects area. Recent repository sources retain their URL without inventing a local path. Public repository search and cloning work anonymously. Private remote checkout uses the effective shared `tools.github` identity; the discovery credential below only grants picker access. For affiliated and private repositories, prefer the explicit `gateway.controlUi.github.token` SecretRef so this service access has a clear runtime owner. When it is omitted, the Gateway still uses its shipped `GH_TOKEN` then `GITHUB_TOKEN` fallback from the shared process environment. When it is explicit, its exact environment or store name is excluded from agent execution without clearing unrelated native GitHub CLI variables. Search requires `operator.read`, cloning requires `operator.write`, and deleting a Gateway-managed cloned checkout requires `operator.admin`. Clone deletion refuses while a live session or managed worktree still references the checkout. SecretRef ownership is not an OS-user security boundary; use a sandbox, dedicated host, or dedicated OS user when same-account processes are not trusted.

Use the Effort menu to choose Fast Mode before creating a session. New Session persists that choice before the first local or remote turn starts.

For agent GitHub CLI identity and Git author setup, see [`tools.github`](/gateway/config-tools#tools-github).

On multi-user gateways, only admin-scope connections can create or view incognito threads, and other sessions cannot reach them through agent session tools or transcript search. Incognito protects against storage and other gateway-mediated users, not against the gateway owner or process operator, who can always observe live sessions.

**Browse folders** opens the Place picker's inline Gateway directory browser through `fs.listDir`. Typing in the path field filters the current folder's subfolders as you type (exact and prefix matches first, and hidden folders match only when the text starts with a dot); typing a new directory prefix lists that directory. Up/Down highlight a folder, Enter opens it, and Tab completes its name. Write-scope browsing starts at the configured agent workspace and cannot navigate above it; realpath checks also reject symlinks that escape the workspace. Admin connections can browse arbitrary Gateway paths. Recent places restore only Gateway folders the current connection can submit; New Session does not browse or remember node filesystem paths. Local submission can call `sessions.create` with the first message in the same round-trip. Remote submission uses the create, dispatch, then send sequence described above. If the Gateway creates the session but rejects that first send, the chat preserves the prompt and error across reloads; **Retry** sends it through the already-created session instead of creating another one.
