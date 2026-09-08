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

`gateway.controlUi.enabled` hot-applies. Disable it to stop serving dashboard
pages and assets while bots and existing Gateway connections keep running.
Re-enable it to resume serving; missing assets are prepared in the background.
Changing the serving base path or asset root still requires a Gateway restart.

For unmatched HTTP paths, the app-shell fallback respects the request's `Accept` header. An explicit HTML rejection such as `text/html;q=0, */*` overrides the broader wildcard, so the request reaches the startup `503` or final `404` response. Headerless and wildcard-only requests retain the browser navigation fallback.

It speaks **directly to the Gateway WebSocket** on the same port.

While the initial connection or a route loads, shimmer placeholders reserve the chat layout. They respect your theme and reduced-motion preference; Gateway startup progress remains visible when available.

Closed Terminal, Browser, Desktop, and Home/Ask OpenClaw panels initialize when you open them rather than during initial navigation. Panels saved as open still restore after a reload.

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

Gateway auth runs before device pairing. A direct loopback connection does not bypass token or password auth. The login screen and **Settings → Gateway** use one **Gateway secret** field: paste the token or type the password. After a successful connection, the UI keeps the secret in session storage for the current browser tab and Gateway origin only when the Gateway reports token auth. Passwords stay in memory and are never persisted. After pairing, the browser can use its stored per-device token on later connections.

If you paste a setup code from **Devices → Pair device → Copy setup code** into **Gateway secret**, the UI shows an inline hint before you connect. Paste that code into **Settings → Gateway** in the OpenClaw mobile app. For the Control UI, run `openclaw gateway auth-token --show` in an interactive terminal on the Gateway host and paste the shared token instead. If a connection with a setup code is rejected for a token or password mismatch, the login screen repeats this guidance.

Onboarding usually configures a gateway token for shared-secret auth. If the Gateway starts in token mode without a configured token, it generates an ephemeral runtime token for that process instead. The runtime token is not written to config, so it cannot be recovered and a loopback browser without that token is rejected. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then run `openclaw gateway auth-token --show` in an interactive terminal and paste the output into Control UI settings. Password auth works instead when `gateway.auth.mode` is `"password"`.

## What each page covers

- [Connect and pair](/web/control-ui/connect-and-pair) — pair a browser or phone, reach the UI over Tailscale, and fix a blank page.
- [Sessions and sidebar](/web/control-ui/sessions-and-sidebar) — sidebar zones, session menus, and the New session page.
- [Chat](/web/control-ui/chat) — composer controls, the session rail, transcript rendering, and hosted embeds.
- [Panels and docks](/web/control-ui/panels) — Ask OpenClaw, the Home dock, the operator terminal, and the browser panel.
- [Settings](/web/control-ui/settings) — identity, appearance, plugins, updates, MCP, activity, and meetings.
- [Feature and RPC reference](/web/control-ui/feature-reference) — every capability with the Gateway RPC behind it.
- [Offline and reconnect](/web/control-ui/offline-and-reconnect) — what survives a dropped connection.
- [Security model](/web/control-ui/security-model) — content security policy, media route auth, and approval links.
- [Build and develop](/web/control-ui/development) — build the UI and run the dev server against a Gateway.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/web/control-ui#chat-behavior` still resolves. Each entry points at the page that now holds the content.

- <a id="session-rail-and-side-chat" />[Session rail and side chat](/web/control-ui/chat#session-rail-and-side-chat)
- <a id="session-links-in-messages" />[Session links in messages](/web/control-ui/chat#session-links-in-messages)
- <a id="composer-capability-menu" />[Composer capability menu](/web/control-ui/chat#composer-capability-menu)
- <a id="chat-behavior" />[Chat behavior](/web/control-ui/chat#chat-behavior)
- <a id="source-previews-and-copying-code" />[Source previews and copying code](/web/control-ui/chat#source-previews-and-copying-code)
- <a id="markdown-tables" />[Markdown tables](/web/control-ui/chat#markdown-tables)
- <a id="mermaid-diagrams" />[Mermaid diagrams](/web/control-ui/chat#mermaid-diagrams)
- <a id="hosted-embeds" />[Hosted embeds](/web/control-ui/chat#hosted-embeds)
- <a id="chat-transcript-layout" />[Chat transcript layout](/web/control-ui/chat#chat-transcript-layout)
- <a id="chat-message-width" />[Chat message width](/web/control-ui/chat#chat-message-width)
- <a id="send-and-history-semantics" />[send and history semantics](/web/control-ui/chat#send-and-history-semantics)
- <a id="talk-mode-browser-realtime" />[talk mode browser realtime](/web/control-ui/chat#talk-mode-browser-realtime)
- <a id="stop-and-abort" />[stop and abort](/web/control-ui/chat#stop-and-abort)
- <a id="abort-partial-retention" />[abort partial retention](/web/control-ui/chat#abort-partial-retention)
- <a id="strict" />[strict](/web/control-ui/chat#strict)
- <a id="scripts-default" />[scripts default](/web/control-ui/chat#scripts-default)
- <a id="trusted" />[trusted](/web/control-ui/chat#trusted)
- <a id="device-pairing-(first-connection)" />[device pairing (first connection)](</web/control-ui/connect-and-pair#device-pairing-(first-connection)>)
- <a id="pair-a-mobile-device" />[Pair a mobile device](/web/control-ui/connect-and-pair#pair-a-mobile-device)
- <a id="runtime-config-endpoint" />[Runtime config endpoint](/web/control-ui/connect-and-pair#runtime-config-endpoint)
- <a id="pwa-install-and-web-push" />[PWA install and web push](/web/control-ui/connect-and-pair#pwa-install-and-web-push)
- <a id="tailnet-access-(recommended)" />[tailnet access (recommended)](</web/control-ui/connect-and-pair#tailnet-access-(recommended)>)
- <a id="insecure-http" />[Insecure HTTP](/web/control-ui/connect-and-pair#insecure-http)
- <a id="blank-control-ui-page" />[Blank Control UI page](/web/control-ui/connect-and-pair#blank-control-ui-page)
- <a id="device-pairing-first-connection" />[Device pairing (first connection)](/web/control-ui/connect-and-pair#device-pairing-first-connection)
- <a id="tailnet-access-recommended" />[Tailnet access (recommended)](/web/control-ui/connect-and-pair#tailnet-access-recommended)
- <a id="list-pending-requests" />[list pending requests](/web/control-ui/connect-and-pair#list-pending-requests)
- <a id="approve-by-request-id" />[approve by request id](/web/control-ui/connect-and-pair#approve-by-request-id)
- <a id="open-mobile-pairing" />[open mobile pairing](/web/control-ui/connect-and-pair#open-mobile-pairing)
- <a id="connect-the-phone" />[connect the phone](/web/control-ui/connect-and-pair#connect-the-phone)
- <a id="confirm-the-connection" />[confirm the connection](/web/control-ui/connect-and-pair#confirm-the-connection)
- <a id="trusted-proxy-note" />[trusted proxy note](/web/control-ui/connect-and-pair#trusted-proxy-note)
- <a id="build-and-develop-the-ui" />[Build and develop the UI](/web/control-ui/development#build-and-develop-the-ui)
- <a id="debugging%2Ftesting%3A-dev-server-%2B-remote-gateway" />[debugging%2Ftesting%3A dev server %2B remote gateway](/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway)
- <a id="debugging/testing-dev-server-+-remote-gateway" />[debugging/testing dev server + remote gateway](/web/control-ui/development#debugging/testing-dev-server-+-remote-gateway)
- <a id="start-the-ui-dev-server" />[start the ui dev server](/web/control-ui/development#start-the-ui-dev-server)
- <a id="connect-the-remote-gateway" />[connect the remote gateway](/web/control-ui/development#connect-the-remote-gateway)
- <a id="origin-security-notes" />[origin security notes](/web/control-ui/development#origin-security-notes)
- <a id="feature-and-rpc-reference" />[Feature and RPC reference](/web/control-ui/feature-reference#feature-and-rpc-reference)
- <a id="chat-and-talk" />[chat and talk](/web/control-ui/feature-reference#chat-and-talk)
- <a id="channels-sessions-memory" />[channels sessions memory](/web/control-ui/feature-reference#channels-sessions-memory)
- <a id="cron-tasks-plugins-skills-devices-exec-approvals" />[cron tasks plugins skills devices exec approvals](/web/control-ui/feature-reference#cron-tasks-plugins-skills-devices-exec-approvals)
- <a id="config" />[config](/web/control-ui/feature-reference#config)
- <a id="usage" />[usage](/web/control-ui/feature-reference#usage)
- <a id="debug-logs-update" />[debug logs update](/web/control-ui/feature-reference#debug-logs-update)
- <a id="automations-panel-notes" />[automations panel notes](/web/control-ui/feature-reference#automations-panel-notes)
- <a id="connection-loss-and-reconnect" />[Connection loss and reconnect](/web/control-ui/offline-and-reconnect#connection-loss-and-reconnect)
- <a id="openclaw-system-care" />[OpenClaw system care](/web/control-ui/panels#openclaw-system-care)
- <a id="home-dock" />[Home dock](/web/control-ui/panels#home-dock)
- <a id="operator-terminal" />[Operator terminal](/web/control-ui/panels#operator-terminal)
- <a id="browser-panel" />[Browser panel](/web/control-ui/panels#browser-panel)
- <a id="content-security-policy" />[Content security policy](/web/control-ui/security-model#content-security-policy)
- <a id="avatar-route-auth" />[Avatar route auth](/web/control-ui/security-model#avatar-route-auth)
- <a id="assistant-media-route-auth" />[Assistant media route auth](/web/control-ui/security-model#assistant-media-route-auth)
- <a id="approval-links" />[Approval links](/web/control-ui/security-model#approval-links)
- <a id="new-session-names" />[New session names](/web/control-ui/sessions-and-sidebar#new-session-names)
- <a id="new-session-preferences-and-recents" />[New-session preferences and recents](/web/control-ui/sessions-and-sidebar#new-session-preferences-and-recents)
- <a id="sidebar-navigation" />[Sidebar navigation](/web/control-ui/sessions-and-sidebar#sidebar-navigation)
- <a id="session-menu" />[Session menu](/web/control-ui/sessions-and-sidebar#session-menu)
- <a id="session-placement" />[Session placement](/web/control-ui/sessions-and-sidebar#session-placement)
- <a id="session-icons" />[Session icons](/web/control-ui/sessions-and-sidebar#session-icons)
- <a id="session-colors" />[Session colors](/web/control-ui/sessions-and-sidebar#session-colors)
- <a id="new-session-page" />[New session page](/web/control-ui/sessions-and-sidebar#new-session-page)
- <a id="start-a-native-coding-cli" />[Start a native coding CLI](/web/control-ui/sessions-and-sidebar#start-a-native-coding-cli)
- <a id="openclaw-chat-workspace-startup" />[OpenClaw Chat workspace startup](/web/control-ui/sessions-and-sidebar#openclaw-chat-workspace-startup)
- <a id="environment-identity" />[Environment identity](/web/control-ui/settings#environment-identity)
- <a id="community-invitation" />[Community invitation](/web/control-ui/settings#community-invitation)
- <a id="personal-identity" />[Personal identity](/web/control-ui/settings#personal-identity)
- <a id="gateway-host-status" />[Gateway host status](/web/control-ui/settings#gateway-host-status)
- <a id="language-support" />[Language support](/web/control-ui/settings#language-support)
- <a id="appearance-themes" />[Appearance themes](/web/control-ui/settings#appearance-themes)
- <a id="manage-plugins" />[Manage plugins](/web/control-ui/settings#manage-plugins)
- <a id="updates" />[Updates](/web/control-ui/settings#updates)
- <a id="apps-and-extensions" />[Apps and extensions](/web/control-ui/settings#apps-and-extensions)
- <a id="side-panel-keyboard-shortcuts" />[Side panel keyboard shortcuts](/web/control-ui/settings#side-panel-keyboard-shortcuts)
- <a id="this-mac-(macos-app)" />[This device (macOS and iOS apps)](/web/control-ui/settings#this-mac-macos-app)
- <a id="custom-plugin-ui" />[Custom plugin UI](/web/control-ui/settings#custom-plugin-ui)
- <a id="import-assistant-memory" />[Import assistant memory](/web/control-ui/settings#import-assistant-memory)
- <a id="mcp-page" />[MCP page](/web/control-ui/settings#mcp-page)
- <a id="activity-tab" />[Activity tab](/web/control-ui/settings#activity-tab)
- <a id="meetings-page" />[Meetings page](/web/control-ui/settings#meetings-page)
- <a id="this-mac-macos-app" />[This Mac (macOS app)](/web/control-ui/settings#this-mac-macos-app)

## Related

- [Dashboard](/web/dashboard) — gateway dashboard
- [Health Checks](/gateway/health) — gateway health monitoring
- [TUI](/web/tui) — terminal user interface
- [WebChat](/web/webchat) — browser-based chat interface
