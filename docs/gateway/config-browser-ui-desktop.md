---
summary: "Browser automation, Control UI presentation, and desktop or paired-node config"
read_when:
  - Configuring browser automation or profiles
  - Adjusting Control UI presentation
  - Setting up desktop or paired node desktops
title: "Configuration — browser, UI, and desktop"
---

Client-facing surfaces: `browser.*`, `ui.*`, and `desktop.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Browser

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "user",
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // allowPrivateNetwork: true, // legacy alias
      // allowedHostnames: ["*.example.com", "example.com", "localhost"],
      // blockedHostnames: ["tracker.example.com", "*.ads.example.com"],
    },
    tabCleanup: {
      enabled: true,
    },
    extensionRelay: {
      allowLegacyAuth: true,
    },
    profiles: {
      openclaw: { cdpPort: 18800 },
      work: {
        cdpPort: 18801,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      chrome: { driver: "extension" },
      user: { driver: "existing-session", attachOnly: true },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222" },
    },
    // headless: false,
    // noSandbox: false,
    // extraArgs: [],
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false` disables `act:evaluate` and `wait --fn`.
- `extensionRelay.allowLegacyAuth` defaults to `true` for one Browser Relay
  Authentication migration window. It permits old extension and external CDP
  Bearer, Basic, and token-subprotocol clients. Set it to `false`
  after all relay clients use auth v2; v2 clients never downgrade.
- `tabCleanup` controls best-effort periodic cleanup for tracked primary-agent
  tabs after idle time or when a session exceeds its cap. Tracking applies only
  to tabs created by browser tool `action: "open"`; tabs opened by the user or
  with unknown ownership are never adopted. Disabling `tabCleanup` does not disable explicit session lifecycle cleanup.
- Host-local opens with a stable native CDP target and browser identity are
  stored in shared SQLite state and remain eligible across Gateway restarts for
  `/new` and session lifecycle cleanup. Native tool-facing CDP targets also
  remain eligible for idle and cap cleanup after restart. Chrome MCP uses
  process-local target handles, so cold existing-session records wait for
  lifecycle cleanup rather than risking an idle sweep against unattributable
  post-restart activity. OpenClaw verifies the profile and browser instance
  before closing. Chrome MCP auto-connect, missing `/json/version` browser
  identity, and unresolved native targets remain fully process-local, so they
  are not automatically closed after a restart. Older untracked tabs require
  manual closure. Transient failures stay pending for a later retry. See
  [Tab cleanup ownership](/tools/browser#tab-cleanup-ownership).
- `ssrfPolicy.dangerouslyAllowPrivateNetwork` is disabled when unset, so browser navigation stays strict by default.
- Set `ssrfPolicy.dangerouslyAllowPrivateNetwork: true` only when you intentionally trust private-network browser navigation.
- In strict mode, remote CDP profile endpoints (`profiles.*.cdpUrl`) are subject to the same private-network blocking during reachability/discovery checks.
- `ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.
- In strict mode, use the wildcard-aware `ssrfPolicy.allowedHostnames` for exact-host and pattern exceptions.
- `ssrfPolicy.blockedHostnames` denies exact hosts and `*.example.com` subdomains before DNS and allow rules, including private-network exceptions. Wildcards exclude the apex; add `example.com` separately to block it. Empty or unset adds no denials.
- Remote profiles are attach-only (start/stop/reset disabled).
- `profiles.*.cdpUrl` accepts `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) when you want OpenClaw to discover `/json/version`; use WS(S)
  when your provider gives you a direct DevTools WebSocket URL.
- If an externally managed CDP service is reachable through loopback, set that
  profile's `attachOnly: true`; otherwise OpenClaw treats the loopback port as a
  local managed browser profile and may report local port ownership errors.
- `existing-session` profiles use Chrome MCP instead of CDP and can attach on
  the selected host or through a connected browser node.
- `extension` profiles use the authenticated OpenClaw Chrome extension relay.
  The relay owns its loopback endpoint, so these profiles do not accept
  `cdpUrl`. See [Chrome extension](/tools/chrome-extension).
- `existing-session` profiles can set `userDataDir` to target a specific
  Chromium-based browser profile such as Brave or Edge.
- `existing-session` profiles can set `cdpUrl` when Chrome is already running
  behind a DevTools HTTP(S) discovery endpoint or direct WS(S) endpoint. In that
  mode OpenClaw passes the endpoint to Chrome MCP instead of using auto-connect;
  `userDataDir` is ignored for Chrome MCP launch arguments.
  Valid endpoint arguments in `mcpArgs` take precedence over `cdpUrl`; see
  [Custom Chrome MCP launch](/tools/browser#custom-chrome-mcp-launch).
- `existing-session` profiles keep the current Chrome MCP route limits:
  snapshot/ref-driven actions instead of CSS-selector targeting, one-file upload
  hooks, no dialog timeout overrides, no `wait --load networkidle`, and no
  `responsebody`, PDF export, download interception, or batch actions.
- Local managed `openclaw` profiles get a `cdpPort` allocated from the managed
  range when OpenClaw creates the profile. A profile you declare by hand must
  set `cdpPort` itself, or `cdpUrl` for a remote CDP endpoint; the schema
  rejects an `openclaw` or `clawd` profile that sets neither.
- Local managed profiles can set `executablePath` to override the global
  `browser.executablePath` for that profile. Use this to run one profile in
  Chrome and another in Brave.
- Auto-detect order: default browser if Chromium-based → Chrome → Brave → Edge → Chromium → Chrome Canary.
- `browser.executablePath` and `browser.profiles.<name>.executablePath` both
  accept `~` and `~/...` for your OS home directory before Chromium launch.
  Per-profile `userDataDir` on `existing-session` profiles is also tilde-expanded.
- Control service: loopback only (port derived from `gateway.port`, default `18791`).
- `extraArgs` appends extra launch flags to local Chromium startup (for example
  `--disable-gpu`, window sizing, or debug flags).
- Browser profiles, the default profile, global launch settings,
  `snapshotDefaults`, and `tabCleanup` hot-reload.
  Changed launch settings replace affected managed browsers on their next use;
  externally attached browsers stay running. Enablement, evaluation, SSRF policy,
  and extension relay require a Gateway restart.

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    prefs: {
      theme: "claw", // claw | knot | dash | absolutely | tide | beacon | phosphor | crt | manuscript | rose | miami | custom
      themeMode: "system", // light | dark | system
      locale: "en",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: true, // Keep commentary after runs in Control UI; does not deliver it to channels
      chatSendShortcut: "enter", // enter | modifier-enter
      chatFollowUpMode: "steer", // steer | queue; omit to use the server queue mode
    },
  },
}
```

Agent display names, emoji, and avatars belong to each agent's `identity` block under `agents.entries`; see [Agent configuration](/gateway/config-agents/entries-and-multi-agent#agentsentries-per-agent-overrides).

- `seamColor`: operator accent color for native app UI chrome (Talk Mode bubble
  tint, etc.). The Control UI user accent (`ui.prefs.accent`) takes precedence in
  `talk.config` payloads and the macOS app's config snapshot. If neither is set,
  the theme default applies.
- `prefs`: cross-device operator preferences. This is the canonical home so agents can
  change them through the approval gate and every Control UI client stays in
  sync; browsers mirror the values into local storage for instant boot. An
  explicitly read-only connection keeps edits in that browser without attempting
  a config write. Offline edits remain queued for a later writable connection and
  continue as browser-local preferences while reconnected read-only.
  `chatPersistCommentary` defaults to `true`. Setting it to `false` keeps live
  commentary visible during a run but removes it at completion and prevents new
  Codex commentary from entering the durable transcript mirror. Messaging-channel
  delivery remains separate and unchanged.
  Presentation-only preferences such as advanced-tier visibility, text scale,
  chat width, and live sidebar activity stay browser-local and are configured in Settings.
  Connected clients apply server-side changes live: the gateway broadcasts a
  hash-only `config.changed` event after every persisted config write and
  clients refresh their snapshot (skipped while a local settings draft has
  unsaved edits). Reconnecting clients reconcile on connect.

---

## Desktop

The host desktop source lets the Control UI Desktop panel connect to the Gateway
machine. It can attach to an existing loopback RFB server, or supervise a
headless TigerVNC/XFCE desktop on Linux. It is a Labs feature and is off by
default.

Observer tokens and observer connections are bound to the Gateway connection
that requested them. Ending or revoking that connection refuses unused tokens
and closes its observers with `4006 authority_revoked`. Internal callers without
a Gateway connection keep TTL-only tokens.

```json5
{
  desktop: {
    host: {
      enabled: true,
      managed: true,
      // port: 5900, // Setting a port selects attach mode instead.
      // passwordFile: "/path/to/vnc-password.txt",
    },
  },
}
```

- `desktop.host.enabled`: advertises **This machine** as a desktop source after
  the Gateway restarts.
- `desktop.host.managed`: Linux only. Starts a gateway-supervised, loopback-only
  TigerVNC/XFCE desktop lazily on the first observation and stops it after the
  desktop session's linger period. Default: `false`.
- `desktop.host.port`: loopback RFB port on `127.0.0.1` (default: `5900`).
- `desktop.host.passwordFile`: optional UTF-8 VNC password file for attach mode.
  Without it, the Control UI prompts for a VNC password and keeps it in browser
  memory for that connection. Managed mode always creates its own ephemeral
  password.

OpenClaw connects only through loopback. An explicit `port` always selects
attach mode, and an existing RFB listener on port `5900` takes precedence over
managed mode. Managed mode requires `Xtigervnc`, `tigervncpasswd`, and
`startxfce4`; on Debian/Ubuntu, install
`tigervnc-standalone-server tigervnc-tools xfce4-session`. The Gateway creates a
fresh temporary VNC password for each managed session, never persists it, and
supervises both the VNC server and XFCE session.

If desktop teardown fails, the Gateway retains the session's cleanup owner and
reports the failure in its logs. A new observation retries cleanup before
starting a replacement. For SSH-backed worker desktops, temporary connection
files remain until the transport has closed; a late process exit triggers
another cleanup attempt. Check the reported process or filesystem error before
retrying an observation that cannot finish cleanup.

Without managed mode, configure third-party servers to listen on loopback when
they support it. On Linux, use loopback-only TigerVNC or `x11vnc`; GNOME Remote
Desktop's VeNCrypt mode is not supported. On Windows, enable VNC authentication
and loopback access in the VNC server.

On macOS, enable **System Settings → General → Sharing → Screen Sharing**.
Modern Screen Sharing uses ARD account authentication, so the Gateway performs
that handshake and gives the browser an already-authenticated no-auth RFB
stream. The macOS account password is not returned in the observe result, URL,
or logs. `openclaw doctor` can offer an explicitly confirmed `sudo launchctl`
repair when Screen Sharing is off; enabling the macOS system service may expose
it on other network interfaces according to macOS Sharing settings.

### Paired node desktops

A paired macOS, Windows, or Linux node can expose its own desktop in the same
Control UI Desktop panel. This path is intentionally off by default and always
uses an existing node-local RFB server on `127.0.0.1`; the Gateway never asks a
node to connect to a caller-selected host or port.

On the node machine, enable the desktop source and configure attach mode:

```json5
{
  desktop: {
    host: {
      enabled: true,
      port: 5900,
      // passwordFile: "/path/to/vnc-password.txt",
    },
  },
}
```

Restart the node host after changing this config. `managed: true` is a Gateway
host feature and does not start a managed desktop inside a node host; paired
nodes must already have a loopback RFB server.

On the Gateway, explicitly arm the dangerous command:

```json5
{
  gateway: {
    nodes: {
      commands: {
        allow: ["desktop.stream"],
        // deny: ["desktop.stream"], // deny always wins
      },
    },
  },
}
```

The node reconnect advertises `desktop.stream` as a pairing-surface upgrade.
Inspect `openclaw nodes pending`, then approve the new request with
`openclaw nodes approve <requestId>`. The node appears in the Desktop picker
only while it is connected and the effective approved command remains allowed.

The visible picker updates as nodes connect or disconnect. A desktop opened
for a session or a specific source connects when its assigned node becomes
available; opening the picker yourself keeps source selection manual.

For VncAuth, `desktop.host.passwordFile` stays on the node and is delivered only
to the Gateway's authenticated relay. Without a password file, the Control UI
prompts for the VNC password. macOS ARD asks for account credentials when you
first connect to a node in the Desktop panel. The panel keeps them in memory
for reconnects to the same node. Closing the panel, selecting another desktop,
or losing the Gateway connection clears them; an authentication rejection asks
for the password again. The Gateway completes ARD or VNC authentication before
exposing a no-auth RFB handshake to the browser, so credentials are not returned
in URLs, logs, or RPC results.

Desktop bytes use a dedicated outbound binary WebSocket from the node. The
normal node invoke remains only as the cancellable lifecycle handle and never
carries framebuffer data. Reconnecting or changing the node's pairing
generation closes active relays. To disarm the feature, remove
`desktop.stream` from `commands.allow` or add it to `commands.deny`. With the
default hybrid reload mode, Gateway command-policy changes apply to connected
nodes without a Gateway restart or node reconnect.

If the node is missing from the picker, verify all four gates: the node-local
desktop config, the loopback RFB listener, the approved pairing update, and the
Gateway allow/deny policy. Restart the node host after changing its desktop
config, then check `openclaw nodes pending` for a widened declaration. Gateway
policy changes apply within the existing pairing approval.

---
