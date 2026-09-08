---
summary: "Ask OpenClaw, the Home dock, the operator terminal, and the browser panel"
read_when:
  - Opening a terminal or browser beside a conversation
  - Using Ask OpenClaw for setup and repair
  - Using the Home dock
title: "Panels and docks"
sidebarTitle: "Panels and docks"
---

Surfaces that dock beside the current page instead of replacing it.

## OpenClaw system care

Open **Settings → Ask OpenClaw** to talk to the system setup and repair agent. To open it alongside your current page, click **Home** in the sidebar footer and select the **Ask OpenClaw** tab, or use the **Ask OpenClaw** command-palette action. The full page and dockable panel share one machine-wide conversation whose durable history lives on the Gateway. Closing the UI never cancels a turn; reopening Ask OpenClaw shows the completed conversation. The panel docks on the right or bottom, remembers its placement and size in the browser profile, and hides itself while the full page is open.

If no AI provider is configured, Ask OpenClaw offers **Connect an AI provider**. If a configured runtime fails to start or verify, the conversation stays visible with the actual error and **Retry**. Sending stays disabled until verification succeeds. Retry checks the runtime without resending your earlier message or clearing your draft.

Each chat message carries the Control UI page you are currently viewing as an untrusted ambient hint, so requests like "configure this channel" or "why is this page empty?" resolve against the page you are looking at.

Guided channel setup, workspace skills setup, web-search provider setup, and local Gateway setup run as hosted wizards inside the chat. Wizard questions stay in the conversation, secret steps mask input in the browser, and successful config-backed flows are audited and re-validated. If a chosen web-search provider needs a plugin install and that install fails, setup stops and reports the failure instead of pretending the provider is configured.

For Gateway setup, say `configure gateway` to choose the port, bind address, token or password auth, and Tailscale exposure. Before the first question, the web surface warns that applying the saved settings requires a restart that may disconnect the chat or require a new Control UI sign-in. The wizard changes config only; say `restart gateway` when you are ready to apply it. It manages only a local Gateway, so remote mode changes stay in `openclaw onboard` or `openclaw configure`.

Say `import memory` to copy detected local memory into the existing default agent workspace. This flow does not change config or import credentials or skills, needs no Gateway restart, and distinguishes confirmed imports, nothing to import, provider failures, and failures where some files may already have been copied. Finish onboarding first if the default workspace does not exist. See [Import assistant memory](/web/control-ui/settings#import-assistant-memory) for the broader page that can target another agent or replace existing imports, and [`openclaw setup`](/cli/openclaw) for the operation and approval contract.

Outside onboarding, this page can show at most one dismissible event chip per visit. It stays silent for routine Gateway traffic and reacts only to health snapshots that report a disabled configuration reloader, a configured channel disconnect/degradation, a failed channel probe, or unavailable channel credentials. A newer event replaces the pending chip only when it is more severe; dismissing or using the chip silences event prompts for that visit. Clicking the chip sends its diagnosis question as a real `openclaw.chat` message, so the transcript records the request and OpenClaw performs the diagnosis. Onboarding never shows these event chips.

## Home dock

Use the **Home** button in the sidebar footer to open the selected agent's main conversation alongside your current page. Home and Ask OpenClaw share the dock. When the same Home conversation is already open as the page, the dock stays hidden rather than showing it twice.

Home can include a bounded, quoted work-context reference with your message. That reference belongs to the page's agent and session, not merely the Home conversation receiving it, and stays current when session titles or visible files change. It is reference data, not permission to access another conversation; you can remove it before sending.

## Operator terminal

The operator terminal is enabled by default; set `gateway.terminal.enabled: false` to opt out. The terminal requires an `operator.admin` connection and opens a host PTY in the active agent workspace. New tabs follow the currently selected chat agent.

On Linux and macOS, a Gateway running on Bun uses a Node helper for terminal
I/O. Keep Node available on the Gateway's `PATH`; an unavailable Node executable
produces a startup error with installation guidance.

Enablement changes hot-apply without restarting the Gateway. Disabling closes
attached, detached, and conversation-owned terminals and cancels pending opens.
Re-enabling allows fresh sessions; closed sessions do not return. Reload the
Control UI page to pick up the updated content security policy.

<Warning>
The terminal is an unconfined host shell and inherits the Gateway process environment. Disable it with `gateway.terminal.enabled: false` on deployments where admin operators should not get a host shell. OpenClaw refuses terminal sessions for agents with `sandbox.mode: "all"`; changing an active agent to that mode closes its existing and in-flight terminal sessions.
</Warning>

Use **Ctrl + backtick** to toggle the **Terminal** tab in the selected Chat pane's unified side panel. You can also open **Terminal** from the panel's **+** menu. The shared panel docks right or bottom, resizes with the browser viewport, can expand over the Chat pane, and keeps multiple shell tabs. Opening a Codex or Claude Code session from the catalog selects **Terminal** and expands the panel. See [Gateway configuration](/gateway/configuration-reference#gateway) for `gateway.terminal.enabled` and the optional `gateway.terminal.shell` override.

The unified panel also hosts **Browser**, **Files**, **Tasks**, **Review**, **Side chat**, and capability-dependent **Desktop** and **Discussion** tabs. Its open or minimized state, active tab, tab order, width, dock, and expanded state are stored per session in the current browser profile, so switching sessions restores each session's own working layout. Drag tabs to reorder them, close a tab without closing the other tools, or use the panel close button to minimize the whole panel.

Owner-authorized, unsandboxed agents can use the `terminal` tool to list, read, resize, or close terminals an operator already opened from the same Chat session's Terminal panel. Agents cannot open shells, and access remains exact-session scoped: an agent cannot inspect or control standalone operator terminals or terminals belonging to another session. Terminal input follows the effective session and host-exec permission policy: **Full access** (`full`, or YOLO) sends it immediately; **Guarded** (`guarded`) and **Workspace** (`workspace`, including accept-only or Guardian-reviewed flows) require an explicit, one-time approval for that exact input; **Read only** (`read-only`) or `tools.exec.mode: "deny"` forbids input entirely. Approving one input never grants unrestricted access to the terminal.

Drag one or more files onto the active terminal, or use the paperclip button to choose files. OpenClaw stages each file on the machine that owns the PTY and pastes shell-quoted absolute paths at the cursor; it never presses Enter or executes the input. A compact batch indicator shows the current file and completed count. Cancel stops the remaining batch without pasting paths; a failed transfer stays visible so you can retry from that file without re-uploading completed files. Choose **Insert uploaded paths** to finish a failed batch using only its completed files, then select any remaining files separately. If the batch stays open until its early uploads may have expired, cancel it and choose the files again.

Images, PDFs, archives, and other file types are accepted up to 16 MiB per file. New uploads must fit within shared limits of 256 MiB and 64 files per staging directory, including files from other terminal tabs and previous processes. When either limit is reached, move or remove staged files, or wait for cleanup, then retry. Existing unexpired files are not evicted to make room, including uploads retained above these limits after an upgrade. Staged files use a private system-temporary directory on POSIX hosts (directory mode `0700`, file mode `0600`) or a directory under the user-profile ACL boundary on Windows, plus a 24-hour cleanup timer, so move or copy anything you need to keep.

Renaming staged files or retrying failed cleanup does not restart an already scheduled cleanup deadline.

If staging stays locked after a process crash, locate the relative lock directory named in the error on the machine that owns the terminal: the Gateway host for a local terminal or the paired node for a node terminal. On Windows, resolve it under the home directory of the account running that Gateway or node host. On POSIX hosts, resolve it under that process's system temporary directory; check its service environment because `TMPDIR`, `TMP`, or `TEMP` can differ from your shell's settings. Then stop all Gateway and node-host processes using that staging root, remove only the named lock directory, and restart them. This leaves staged files intact. An incomplete lock record is never cleared automatically because it cannot prove that another writer has stopped.

Path insertion supports PowerShell, `cmd.exe`, and recognized POSIX shells (`sh`, Bash, Dash, Ash, Ksh, Zsh, and Fish), including Git Bash on Windows. Other shell overrides are refused because their quoting rules cannot be inferred safely; run the Gateway inside WSL for a native WSL terminal and Linux upload paths. `cmd.exe` paths containing `%` or `!` are also refused because that shell expands those characters even inside double quotes.

Codex and Claude Code sessions discovered in the sessions sidebar can open in their native CLI inside the same terminal panel. In **Settings › Chat**, set **Open Codex/Claude threads in** to **Terminal** to make a normal row click open `codex resume` or `claude --resume`; the default remains the read-only OpenClaw viewer. A row's right-click or kebab menu always offers both choices, and the viewer header includes **Open in terminal** when that session is eligible.

Eligibility is per session and per host. Gateway-local sessions start the provider-owned resume command on the Gateway host. Paired-node sessions start an allowlisted provider command on the owning node and relay only that PTY's output, input, and resize events; this does not expose a general node shell or accept browser-supplied commands. File uploads use the separate, size-bounded `terminal.upload` node command and remain bound to the already-open terminal session. Approve the node pairing upgrade when that command first appears. Nodes that do not advertise the matching terminal-resume command, including embedded worker bridges without duplex streaming, keep the viewer available and show terminal opening as unavailable; older nodes can still run a terminal but cannot receive dragged files.

Standalone operator sessions, including the terminal focus presentation, are connection-owned. A page reload, laptop sleep, or network blip detaches one on the Gateway instead of killing it, and the same browser tab reattaches on reconnect with recent output replayed. Detached connection-owned sessions are killed after `gateway.terminal.detachedSessionTimeoutSeconds` (default 300 seconds; `0` restores kill-on-disconnect). Attaching one of these sessions remains tmux-style take-over.

Conversation-owned sessions opened from a Chat session's Terminal panel are not bound to a browser connection. `terminal.attach` adds each browser as a viewer without taking ownership, and closing an established viewer tab detaches only that browser. Conversation-owned PTYs remain until the exact-session agent closes them, their shell exits, the session is archived, policy disables them, or the Gateway shuts down. `terminal.list` marks each entry as connection- or agent-owned.

All Gateway terminal PTYs are process-local. A Gateway restart ends them; the
PTY sessions and their scrollback are not recovered after the new process starts.

The terminal is also available as a [focus presentation](/web/urls#focus-presentation-routes). The iOS and Android apps embed this page in their Terminal screens, reusing the stored gateway credentials; availability follows the same `gateway.terminal.enabled` and `operator.admin` gate, and the page shows a notice when the connected Gateway does not offer the terminal. Focus presentation removes the application chrome; it does not invoke browser fullscreen.

## Browser panel

The Control UI ships a **Browser** tab in the unified Chat side panel that renders the Gateway-controlled browser (the same one agents drive through the [browser tool](/tools/browser-control)) in any regular web browser - no native webview required. It appears in the panel's **+** menu when the connected Gateway advertises `browser.request` to an `operator.admin` connection; the globe action in **Files** toggles it. In a regular web browser, choosing **Browser** again while its panel tab is already open creates another Agent browser tab. The panel shows a live screencast, with screenshot fallback when streaming is unavailable, plus tabs, an editable URL bar, back/forward/reload, and open-in-your-browser, and forwards clicks, wheel scrolling, and basic typing to the remote page. The remote page follows the shared panel: opening it, resizing it, or switching tabs resizes the remote browser viewport to the panel's available space, so the snapshot fills the panel instead of rendering at whatever size an agent last used.

In the macOS app, the same panel also hosts **Mac tabs**, rendered natively by WebKit, alongside **Agent browser tabs** from the Gateway. Mac tabs are available without `browser.request`; Agent browser tabs retain the Gateway and operator-access requirements above. External links clicked in the dashboard open as Mac tabs in the chat side panel, or in the shell-level Browser dock on non-chat routes. While Settings is open, external links open in the default browser because the Browser panel is hidden. Mac tabs have a tab strip, URL bar, back/forward/reload/stop, open-in-default-browser, and close controls. They belong to the window and survive chat session switches. Opening the same link reuses its existing tab, including a retained original URL after a redirect. Selecting another tab while a link is opening keeps your selection when the open request completes.

Outside the macOS app, enable **Open links in Control UI browser** under **Settings → Infrastructure → Browser** to route external HTTP(S) links into new Agent browser tabs in this panel. The browser-local preference is off by default and appears only while the panel is available. It is hidden in the macOS app because unmodified external dashboard links open as Mac tabs outside Settings. Older Control UI bundles that send legacy `inline` requests open the default browser. Same-origin links, links marked for download, Shift/Alt clicks, file/editor links, email and phone links, right-click actions, and explicit open-in-your-browser actions keep their existing behavior.

In the macOS app, modified clicks open the default browser; right-click an external dashboard link for **Open in Browser Panel**, **Open in Default Browser**, or **Copy Link**. New-window links inside a Mac tab open another Mac tab, while pointer-activated downloads hand off to the default browser. Non-displayable responses hand off only for pointer-activated main-frame navigation; other non-displayable responses are cancelled silently.

Each Agent browser tab keeps one stable identity across in-place navigation and target replacement, so its selected state, keyboard focus, URL, page snapshot, and browser actions stay aligned even when the Gateway returns tabs in a different order.

Two capture modes package page context for the agent. For Mac tabs, either mode captures a one-shot snapshot of the live WebKit page. Navigating the captured tab to a different URL exits capture mode and restores its live view:

- **Annotate (pencil)**: draw freehand markup over the page. **Send to chat** composites the strokes into the screenshot and adds one structured annotation card to the active chat composer. The card keeps its generated page and region context with the image instead of inserting it into your editable draft.
- **Inspect (pointer)**: hover to see the element under the cursor (selector, accessible name, role, size); click to add those details and a highlighted screenshot through the same card flow. Removing an annotation card removes only that image and its generated context, preserves your draft and other attachments, and offers a short-lived **Undo**. For Agent browser tabs, Inspect, wheel scrolling, and back/forward need `browser.evaluateEnabled` (on by default).

One composer accepts up to four browser annotation cards and 8,000 total characters of generated annotation context. When it reaches either limit, the browser panel keeps the current capture so you can remove a card and retry; Undo also preserves the limit instead of evicting another card.

Staged images, files, pasted images, large pasted text, browser annotations, and mixed attachment packages stay with their composer and session across route changes, split-pane remounts, hard reloads, and application restarts. The browser-local retention, scope, and disposal rules described under [New session page](/web/control-ui/sessions-and-sidebar#new-session-page) also apply to existing-session composers. If attachments exceed the durable cap, the current tab keeps them and shows the storage warning; the text remains restart-recoverable, but those attachments do not. If the browser refuses storage entirely, the current tab keeps the live composer and shows the same warning, but that draft cannot be recovered after restart.
