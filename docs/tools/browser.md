---
summary: "Integrated browser control service + action commands"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why openclaw is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
title: "Browser (OpenClaw-managed)"
---

OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls. It runs through a small local control service inside the Gateway (loopback only) and is isolated from your personal browser.

- Think of it as a **separate, agent-only browser**. The `openclaw` profile never touches your personal browser profile.
- The agent opens tabs, reads pages, clicks, and types in this isolated lane.
- The built-in `user` profile attaches to your real signed-in Chrome session instead, via Chrome DevTools MCP.

## What you get

- A separate browser profile named **openclaw** (orange accent by default).
- Deterministic tab control (list/open/focus/close).
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.
- Playwright-backed profiles save direct attachment navigations under the managed downloads directory and return `{ url, suggestedFilename, path }` metadata after final-URL policy validation.
- Playwright-backed agent actions return a `downloads` array with the same managed metadata when the action immediately starts one or more downloads.
- A bundled `browser-automation` skill that teaches agents the snapshot,
  stable-tab, stale-ref, and manual-blocker recovery loop when the browser
  plugin is enabled.
- Optional multi-profile support (`openclaw`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

On macOS, you can explicitly copy cookies from a Chrome-family system profile into a separate managed profile. The managed browser still uses its own user data directory; only the selected cookies are copied, and local storage and IndexedDB stay behind. See [Profiles](#profiles-multi-browser) or the [`openclaw browser` CLI reference](/cli/browser) for import commands and limitations.

## Quick start

```bash
openclaw browser --browser-profile openclaw doctor
openclaw browser --browser-profile openclaw doctor --deep
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

"Browser disabled" means the plugin or `browser.enabled` is off; see
[Configuration](#configuration) and [Plugin control](#plugin-control).

If `openclaw browser` is missing entirely, or the agent says the browser tool
is unavailable, jump to [Missing browser command or tool](#missing-browser-command-or-tool).

## Plugin control

The default `browser` tool is a bundled plugin. Disable it to replace it with another plugin that registers the same `browser` tool name:

```json5
{
  plugins: {
    entries: {
      browser: {
        enabled: false,
      },
    },
  },
}
```

Defaults need both `plugins.entries.browser.enabled` **and** `browser.enabled=true`. Disabling only the plugin removes the `openclaw browser` CLI, `browser.request` gateway method, agent tool, and control service as one unit; your `browser.*` config stays intact for a replacement.

Browser config changes require a Gateway restart so the plugin can re-register its service.

## Agent guidance

Tool-profile note: `tools.profile: "coding"` includes `web_search` and
`web_fetch`, but not the full `browser` tool. To let the agent or a
spawned sub-agent use browser automation, add browser at the profile
stage:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["browser"],
  },
}
```

For a single agent, use `agents.list[].tools.alsoAllow: ["browser"]`.
`tools.subagents.tools.allow: ["browser"]` alone is not enough because sub-agent
policy is applied after profile filtering.

The browser plugin ships two levels of agent guidance:

- The `browser` tool description carries the compact always-on contract: pick
  the right profile, keep refs on the same tab, use `tabId`/labels for tab
  targeting, and load the browser skill for multi-step work.
- The bundled `browser-automation` skill carries the longer operating loop:
  check status/tabs first, label task tabs, snapshot before acting, resnapshot
  after UI changes, recover stale refs once, and report login/2FA/captcha or
  camera/microphone blockers as manual action instead of guessing.

Plugin-bundled skills are listed in the agent's available skills when the
plugin is enabled. The full skill instructions load on demand, so routine
turns do not pay the full token cost.

## Missing browser command or tool

If `openclaw browser` is unknown after an upgrade, `browser.request` is missing, or the agent reports the browser tool as unavailable, the usual cause is a `plugins.allow` list that omits `browser` and no root `browser` config block exists. Add it:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

An explicit root `browser` block (any key under `browser`, such as
`browser.enabled=true` or `browser.profiles.<name>`) activates the bundled
browser plugin even under a restrictive `plugins.allow`, matching bundled
channel config behavior. `plugins.entries.browser.enabled=true` and
`tools.alsoAllow: ["browser"]` do not substitute for allowlist membership by
themselves. Removing `plugins.allow` entirely also restores the default.

## Profiles: `openclaw`, `user`, `chrome`

- `openclaw`: managed, isolated browser (no extension required).
- `user`: built-in Chrome DevTools MCP attach profile for your **real
  signed-in Chrome** session. Chrome shows a blocking "Allow remote debugging?"
  prompt the first time OpenClaw attaches, so someone must be at the computer.
- `chrome`: built-in [Chrome extension](/tools/chrome-extension) profile for
  your **real signed-in Chrome** session. Works from a phone with nobody at the
  desk because it drives tabs through the OpenClaw browser extension instead of
  the remote-debugging port, so there is no "Allow remote debugging?" prompt.

For agent browser tool calls:

- Default: use the isolated `openclaw` browser.
- Prefer `profile="chrome"` (extension) when existing logged-in sessions matter
  and the user is **away from the computer** (Telegram, WhatsApp, etc.).
- Prefer `profile="user"` (Chrome MCP) when existing logged-in sessions matter
  and the user is **at the computer** to approve the attach prompt.
- `profile` is the explicit override when you want a specific browser mode.

Set `browser.defaultProfile: "openclaw"` if you want managed mode by default.

## Configuration

Browser settings live in `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    evaluateEnabled: true, // default: true; false disables act:evaluate (arbitrary JS)
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    tabCleanup: {
      enabled: true, // default: true
    },
    // snapshotDefaults: { mode: "efficient" }, // default snapshot mode when the caller omits one
    defaultProfile: "openclaw",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: {
        cdpPort: 18801,
        color: "#0066CC",
        headless: true,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      user: {
        driver: "existing-session",
        attachOnly: true,
        color: "#00AA00",
      },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

`browser.snapshotDefaults.mode: "efficient"` changes the default `snapshot`
extraction mode when a caller does not pass an explicit `snapshotFormat` or
`mode`; see [Browser control API](/tools/browser-control) for per-call
snapshot options.

### Tab cleanup ownership

Session tab cleanup applies only to tabs created by the OpenClaw browser tool
with `action: "open"`. OpenClaw does not adopt tabs that were already open,
opened by the user, or otherwise have unknown ownership. The
`browser.tabCleanup` block controls periodic idle and cap sweeps for primary
sessions; disabling it does not disable explicit session lifecycle cleanup.

For host-local opens, ownership with a stable native CDP target and browser
identity is stored in the shared SQLite state. Those records survive a Gateway
restart and remain eligible for `/new` and other session lifecycle cleanup;
session lifecycle cleanup includes subagent, cron, and ACP session endings.
Records whose tool-facing target is the native CDP target also remain eligible
for idle and per-session cap sweeps after restart. Chrome MCP target handles are
process-local, so cold existing-session records wait for lifecycle cleanup
rather than risking an idle sweep against activity that cannot be attributed
safely after restart. This durable path can cover OpenClaw-managed profiles,
regular remote CDP profiles, and existing-session profiles with an explicit
`cdpUrl`, provided OpenClaw can resolve both the native target and a stable
browser identity. Before closing a durable record, OpenClaw verifies that the
configured profile and browser instance still match.

Chrome MCP `--autoConnect`, CDP endpoints whose `/json/version` response lacks
a stable browser identity, and opens whose native target cannot be resolved
remain process-local best-effort tracking. They can be cleaned up while that
Gateway process is running, but they are not automatically closed after a
Gateway restart. Tabs left open before durable tracking was available are not
retroactively adopted; close those tabs manually.

Cleanup is best-effort, not a guarantee that every eligible tab closes
immediately. A transient ownership check or close failure leaves durable
cleanup pending for a later retry. Retries are not unbounded: when the browser
stays unreachable and the tab has gone unused for over a day, the tracking row
is retired so the durable store cannot fill up with tabs that can never be
verified again.

### Screenshot vision (text-only model support)

When the main model is text-only (no vision/multimodal support), browser
screenshots return image blocks that the model cannot read. Browser screenshots
reuse the existing image-understanding configuration, so an image model
configured for media understanding can describe screenshots as text without any
browser-specific model settings.

```json5
{
  tools: {
    media: {
      image: {
        models: [
          { provider: "bytedance", model: "doubao-seed-2.0-pro" },
          // Add fallback candidates; first success wins
          { provider: "openai", model: "gpt-4o" },
        ],
      },
      // Shared media models also work when tagged for image support.
      // models: [{ provider: "openai", model: "gpt-4o", capabilities: ["image"] }],
    },
  },
  agents: {
    defaults: {
      // Existing image-model defaults are also honored.
      // imageModel: { primary: "openai/gpt-4o" },
    },
  },
}
```

**How it works:**

1. Agent calls `browser screenshot` and an image is captured to disk as usual.
2. The browser tool asks the existing image-understanding runtime whether it
   can describe the screenshot using configured media image models, shared media
   models, image-model defaults, or an auth-backed image provider.
3. The vision model returns a text description, which is wrapped with
   `wrapExternalContent` (prompt injection guard) and returned to the agent
   as a text block instead of an image block.
4. If image understanding is unavailable, skipped, or fails, the browser falls
   back to returning the original image block.

Screenshot image blocks are private tool results: the agent can inspect them,
but OpenClaw does not automatically attach them to channel replies. To share a
screenshot, ask the agent to send it explicitly with the message tool.

Use the existing `tools.media.image` / `tools.media.models` fields for model
fallbacks, timeouts, byte limits, profiles, and provider request settings.

If the active main model already supports vision and no explicit image
understanding model is configured, OpenClaw keeps the normal image result so the
main model can read the screenshot directly.

<AccordionGroup>

<Accordion title="Ports and reachability">

- Control service binds to loopback on a port derived from `gateway.port` (default `18791` = gateway + 2). `OPENCLAW_GATEWAY_PORT` takes priority over `gateway.port`; either shifts the derived ports in the same family.
- Local `openclaw` profiles auto-assign `cdpPort`/`cdpUrl` from a range starting 9 ports above the control port (default `18800`-`18899`); set those only for
  remote CDP profiles or existing-session endpoint attach. `cdpUrl` defaults to
  the managed local CDP port when unset.
- Remote and `attachOnly` CDP reachability, WebSocket handshakes, and local
  managed-Chrome startup use built-in deadlines.
- Repeated managed Chrome launch/readiness failures are circuit-broken per
  profile. After several consecutive failures, OpenClaw pauses new launch
  attempts briefly instead of spawning Chromium on every browser tool call. Fix
  the startup problem, disable the browser if it is not needed, or restart the
  Gateway after repair.

</Accordion>

<Accordion title="SSRF policy">

- Browser navigation and open-tab requests are preflight checked. During the action and bounded post-action grace, guarded Playwright interactions (click, coordinate click, hover, drag, scroll, select, press, type, form fill, and evaluate) intercept policy-denied top-level and subframe document loads before HTTP request bytes, then best-effort re-check the final `http(s)` URL.
- Before each fresh OpenClaw-managed Chrome launch, OpenClaw best-effort disables network prediction, suppressing Chromium's observed speculative preconnect for those denied loads. This is defense in depth, not a policy boundary: a browser reused across a control-service restart and other browser backends may not share the hardening. Playwright routing is still not a network firewall and does not intercept redirect hops, a popup's first request, Service Worker traffic, page code that runs after the bounded guard window, or every background/subresource path. Complete egress isolation requires owner-side isolation or a policy-enforcing proxy.
- In strict SSRF mode, remote CDP endpoint discovery and `/json/version` probes (`cdpUrl`) are checked too.
- Gateway/provider `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables do not automatically proxy the OpenClaw-managed browser. Managed Chrome launches direct by default so provider proxy settings do not weaken browser SSRF checks.
- OpenClaw-managed local CDP readiness probes and DevTools WebSocket connections bypass the managed network proxy for the exact launched loopback endpoint, so `openclaw browser start` still works when an operator proxy blocks loopback egress.
- To proxy the managed browser itself, pass explicit Chrome proxy flags through `browser.extraArgs`, such as `--proxy-server=...` or `--proxy-pac-url=...`. Strict SSRF mode blocks explicit browser proxy routing unless private-network browser access is intentionally enabled.
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` is off by default; enable only when private-network browser access is intentionally trusted.
- `browser.ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.

</Accordion>

<Accordion title="Profile behavior">

- `attachOnly: true` means never launch a local browser; only attach if one is already running.
- `headless` can be set globally or per local managed profile. Per-profile values override `browser.headless`, so one locally launched profile can stay headless while another remains visible.
- `POST /start?headless=true` and `openclaw browser start --headless` request a
  one-shot headless launch for local managed profiles without rewriting
  `browser.headless` or profile config. Existing-session, attach-only, and
  remote CDP profiles reject the override because OpenClaw does not launch those
  browser processes.
- On Linux hosts without `DISPLAY` or `WAYLAND_DISPLAY`, local managed profiles
  default to headless automatically when neither the environment nor profile/global
  config explicitly chooses headed mode. Use the unambiguous browser-level form
  `openclaw browser --json status`; trailing `openclaw browser status --json`
  also works because `status` does not define its own `--json`. The command reports
  `headlessSource` as `env`, `profile`, `config`,
  `request`, `linux-display-fallback`, or `default`.
- `OPENCLAW_BROWSER_HEADLESS=1` forces local managed launches headless for the
  current process. `OPENCLAW_BROWSER_HEADLESS=0` forces headed mode for ordinary
  starts and returns an actionable error on Linux hosts without a display server;
  an explicit `start --headless` request still wins for that one launch.
- The browser-control route and programmatic client keep the no-display error's
  human-readable `error` and expose the stable reason
  `no_display_for_headed_profile`. Its `details` contain only `profile`,
  `requestedHeadless`, `headlessSource`, and `displayPresent`, so API clients can
  choose the correct remediation without matching message text.
- For a running local managed profile, status and doctor query Chrome's
  browser-level CDP endpoint for renderer, backend, device/driver, feature
  status, driver workarounds, and accelerated video capabilities. The result is
  cached for that browser process and exposed in full by
  `openclaw browser --json status`. A passive status call does not launch Chrome.
  Existing-session, extension, remote CDP, and sandbox browsers remain separate
  and are not inspected through this managed-host path.
- Headless managed Chrome still uses the conservative `--disable-gpu` default.
  The diagnostics do not enable acceleration, add a global acceleration setting,
  or grant sandbox browser device access.
- `executablePath` can be set globally or per local managed profile. Per-profile values override `browser.executablePath`, so different managed profiles can launch different Chromium-based browsers. Both forms accept `~` for your OS home directory.
- `color` (top-level and per-profile) tints the browser UI so you can see which profile is active.
- Default profile is `openclaw` (managed standalone). Use `defaultProfile: "user"` to opt into the signed-in user browser.
- Auto-detect order: system default browser if Chromium-based; otherwise Chrome, Brave, Edge, Chromium, Chrome Canary.
- `driver: "existing-session"` uses Chrome DevTools MCP instead of raw CDP. It can attach through Chrome MCP auto-connect, or through `cdpUrl` when you already have a DevTools endpoint for the running browser.
- `driver: "extension"` drives your signed-in Chrome through the [OpenClaw Chrome extension](/tools/chrome-extension). The relay owns its loopback endpoint, so these profiles do not accept `cdpUrl`. This is the only signed-in-browser mode that works with nobody at the computer.
- Set `browser.profiles.<name>.userDataDir` when an existing-session profile should attach to a non-default Chromium user profile (Brave, Edge, etc.). This path also accepts `~` for your OS home directory.

</Accordion>

</AccordionGroup>

## Use Brave or another Chromium-based browser

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection. Top-level and per-profile `executablePath` values accept `~`
for your OS home directory:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set browser.profiles.work.executablePath "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Or set it in config, per platform:

<Tabs>
  <Tab title="macOS">
```json5
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
}
```
  </Tab>
  <Tab title="Windows">
```json5
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  },
}
```
  </Tab>
  <Tab title="Linux">
```json5
{
  browser: {
    executablePath: "/usr/bin/brave-browser",
  },
}
```
  </Tab>
</Tabs>

Per-profile `executablePath` only affects local managed profiles that OpenClaw
launches. `existing-session` profiles attach to an already-running browser
instead, and remote CDP profiles use the browser behind `cdpUrl`.

## Local vs remote control

- **Local control (default):** the Gateway starts the loopback control service and can launch a local browser.
- **Remote control (node host):** run a node host on the machine that has the browser; the Gateway proxies browser actions to it.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.
- For externally managed CDP services on loopback (for example Browserless in
  Docker published to `127.0.0.1`), also set `attachOnly: true`. Loopback CDP
  without `attachOnly` is treated as a local OpenClaw-managed browser profile.
- `headless` only affects local managed profiles that OpenClaw launches. It does not restart or change existing-session or remote CDP browsers.
- `executablePath` follows the same local managed profile rule. Changing it on a
  running local managed profile marks that profile for restart/reconcile so the
  next launch uses the new binary.

Stopping behavior differs by profile mode:

- local managed profiles: `openclaw browser stop` stops the browser process that
  OpenClaw launched
- attach-only and remote CDP profiles: `openclaw browser stop` closes the active
  control session and releases Playwright/CDP emulation overrides (viewport,
  color scheme, locale, timezone, offline mode, and similar state), even
  though no browser process was launched by OpenClaw

Remote CDP URLs can include auth:

- Query tokens (e.g., `https://provider.example?token=<token>`)
- HTTP Basic auth (e.g., `https://user:pass@provider.example`)

OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting
to the CDP WebSocket. Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node browser proxy (zero-config default)

If you run a **node host** on the machine that has your browser, OpenClaw can
auto-route browser tool calls to that node without any extra browser config.
This is the default path for remote gateways.

Notes:

- The node host exposes its local browser control server via a **proxy command**.
- Profiles come from the node's own `browser.profiles` config (same as local).
- The proxy command never allows persistent profile mutations (`create-profile`, `delete-profile`, `reset-profile`) regardless of `allowProfiles`; make those changes on the node directly.
- `nodeHost.browserProxy.allowProfiles` is optional. Leave it empty for the legacy/default behavior: all configured profiles remain reachable through the proxy.
- If you set `nodeHost.browserProxy.allowProfiles`, OpenClaw treats it as a least-privilege boundary limiting which profile names the proxy will target.
- Disable if you don't want it:
  - On the node: `nodeHost.browserProxy.enabled=false`
  - On the gateway: `gateway.nodes.browser.mode="off"` (also accepts `"auto"` to pick a single connected browser node, or `"manual"` to require an explicit node param)

## Browserless (hosted remote CDP)

[Browserless](https://browserless.io) is a hosted Chromium service that exposes
CDP connection URLs over HTTPS and WebSocket. OpenClaw can use either form, but
for a remote browser profile the simplest option is the direct WebSocket URL
from Browserless' connection docs.

Example:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    profiles: {
      browserless: {
        cdpUrl: "wss://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Notes:

- Replace `<BROWSERLESS_API_KEY>` with your real Browserless token.
- Choose the region endpoint that matches your Browserless account (see their docs).
- If Browserless gives you an HTTPS base URL, you can either convert it to
  `wss://` for a direct CDP connection or keep the HTTPS URL and let OpenClaw
  discover `/json/version`.

### Browserless Docker on the same host

When Browserless is self-hosted in Docker and OpenClaw runs on the host, treat
Browserless as an externally managed CDP service:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    profiles: {
      browserless: {
        cdpUrl: "ws://127.0.0.1:3000",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

The address in `browser.profiles.browserless.cdpUrl` must be reachable from the
OpenClaw process. Browserless must also advertise a matching reachable endpoint;
set Browserless `EXTERNAL` to that same public-to-OpenClaw WebSocket base, such
as `ws://127.0.0.1:3000`, `ws://browserless:3000`, or a stable private Docker
network address. If `/json/version` returns `webSocketDebuggerUrl` pointing at
an address OpenClaw cannot reach, CDP HTTP can look healthy while the WebSocket
attach still fails.

Do not leave `attachOnly` unset for a loopback Browserless profile. Without
`attachOnly`, OpenClaw treats the loopback port as a local managed browser
profile and may report that the port is in use but not owned by OpenClaw.

## Direct WebSocket CDP providers

Some hosted browser services expose a **direct WebSocket** endpoint rather than
the standard HTTP-based CDP discovery (`/json/version`). OpenClaw accepts three
CDP URL shapes and picks the right connection strategy automatically:

- **HTTP(S) discovery** - `http://host[:port]` or `https://host[:port]`.
  OpenClaw calls `/json/version` to discover the WebSocket debugger URL, then
  connects. No WebSocket fallback.
- **Direct WebSocket endpoints** - `ws://host[:port]/devtools/<kind>/<id>` or
  `wss://...` with a `/devtools/browser|page|worker|shared_worker|service_worker/<id>`
  path. OpenClaw connects directly via a WebSocket handshake and skips
  `/json/version` entirely.
- **Bare WebSocket roots** - `ws://host[:port]` or `wss://host[:port]` with no
  `/devtools/...` path (e.g. [Browserless](https://browserless.io),
  [Browserbase](https://www.browserbase.com)). OpenClaw tries HTTP
  `/json/version` discovery first (normalising the scheme to `http`/`https`);
  if discovery returns a `webSocketDebuggerUrl` it is used, otherwise OpenClaw
  falls back to a direct WebSocket handshake at the bare root. If the advertised
  WebSocket endpoint rejects the CDP handshake but the configured bare root
  accepts it, OpenClaw falls back to that root as well. This lets a bare `ws://`
  pointed at a local Chrome still connect, since Chrome only accepts WebSocket
  upgrades on the specific per-target path from `/json/version`, while hosted
  providers can still use their root WebSocket endpoint when their discovery
  endpoint advertises a short-lived URL that is not suitable for Playwright CDP.

`openclaw browser doctor` uses the same discovery-first, WebSocket-fallback
logic as runtime attach, so a bare-root URL that connects successfully is not
reported as unreachable by diagnostics.

### Browserbase

[Browserbase](https://www.browserbase.com) is a cloud platform for running
headless browsers with built-in CAPTCHA solving, stealth mode, and residential
proxies.

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    profiles: {
      browserbase: {
        cdpUrl: "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>",
        color: "#F97316",
      },
    },
  },
}
```

Notes:

- [Sign up](https://www.browserbase.com/sign-up) and copy your **API Key**
  from the [Overview dashboard](https://www.browserbase.com/overview).
- Replace `<BROWSERBASE_API_KEY>` with your real Browserbase API key.
- Browserbase auto-creates a browser session on WebSocket connect, so no
  manual session creation step is needed.
- See [pricing](https://www.browserbase.com/pricing) for current free-tier limits and paid plans.
- See the [Browserbase docs](https://docs.browserbase.com) for full API
  reference, SDK guides, and integration examples.

### Notte

[Notte](https://www.notte.cc) is a cloud platform for running headless
browsers with built-in stealth, residential proxies, and a CDP-native
WebSocket gateway.

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "notte",
    profiles: {
      notte: {
        cdpUrl: "wss://us-prod.notte.cc/sessions/connect?token=<NOTTE_API_KEY>",
        color: "#7C3AED",
      },
    },
  },
}
```

Notes:

- [Sign up](https://console.notte.cc) and copy your **API Key** from the
  console settings page.
- Replace `<NOTTE_API_KEY>` with your real Notte API key.
- Notte auto-creates a browser session on WebSocket connect, so no manual
  session creation step is needed. The session is destroyed when the
  WebSocket disconnects.
- See [pricing](https://www.notte.cc/#pricing) for current free-tier limits and paid plans.
- See the [Notte docs](https://docs.notte.cc) for full API reference, SDK
  guides, and integration examples.

## Security

Key ideas:

- Browser control is loopback-only; access flows through the Gateway's auth or node pairing.
- The standalone loopback browser HTTP API uses **shared-secret auth only**:
  gateway token bearer auth, `x-openclaw-password`, or HTTP Basic auth with the
  configured gateway password.
- Tailscale Serve identity headers and `gateway.auth.mode: "trusted-proxy"` do
  **not** authenticate this standalone loopback browser API.
- If browser control is enabled and no shared-secret auth is configured, OpenClaw
  auto-generates and persists a browser-control credential at startup:
  a token when `gateway.auth.mode` is `none`, or a password when it is
  `trusted-proxy` (persisted through `gateway.auth.password` so out-of-process
  loopback clients can resolve it). Auto-generation is skipped when an explicit
  string credential is already configured for that mode, or when
  `gateway.auth.mode` is `password`.
- Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or
  `OPENCLAW_GATEWAY_PASSWORD` explicitly if you want a stable secret you control
  instead of the generated one.

Remote CDP tips:

- Prefer encrypted endpoints (HTTPS or WSS) and short-lived tokens where possible.
- Avoid embedding long-lived tokens directly in config files.
- Keep the Gateway and any node hosts on a private network (Tailscale); avoid public exposure.
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.

## Profiles (multi-browser)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: a dedicated Chromium-based browser instance with its own user data directory + CDP port
- **remote**: an explicit CDP URL (Chromium-based browser running elsewhere)
- **existing session**: your existing Chrome profile via Chrome DevTools MCP auto-connect

Defaults:

- The `openclaw` profile is auto-created if missing.
- The `user` profile is built-in for Chrome MCP existing-session attach.
- Existing-session profiles are opt-in beyond `user`; create them with `--driver existing-session`.
- Local CDP ports allocate from **18800-18899** by default.
- Deleting a profile moves its local data directory to Trash.

All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.

## Existing session via Chrome DevTools MCP

OpenClaw can also attach to a running Chromium-based browser profile through the
official Chrome DevTools MCP server. This reuses the tabs and login state
already open in that browser profile.

Official background and setup references:

- [Chrome for Developers: Use Chrome DevTools MCP with your browser session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp)

Built-in profile: `user`. Create your own custom existing-session profile if
you want a different name, color, or browser data directory.

By default the built-in `user` profile uses Chrome MCP auto-connect, which
targets the default local Google Chrome profile. Use `userDataDir` for Brave,
Edge, Chromium, or a non-default Chrome profile. `~` expands to your OS home
directory:

```json5
{
  browser: {
    profiles: {
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
    },
  },
}
```

Then in the matching browser:

1. Open that browser's inspect page for remote debugging.
2. Enable remote debugging.
3. Keep the browser running and approve the connection prompt when OpenClaw attaches.

Common inspect pages:

- Chrome: `chrome://inspect/#remote-debugging`
- Brave: `brave://inspect/#remote-debugging`
- Edge: `edge://inspect/#remote-debugging`

Live attach smoke test:

```bash
openclaw browser --browser-profile user start
openclaw browser --browser-profile user status
openclaw browser --browser-profile user tabs
openclaw browser --browser-profile user snapshot --format ai
```

What success looks like:

- `status` shows `driver: existing-session`
- `status` shows `transport: chrome-mcp`
- `status` shows `running: true`
- `tabs` lists your already-open browser tabs
- `snapshot` returns refs from the selected live tab

What to check if attach does not work:

- the target Chromium-based browser is version `144+`
- remote debugging is enabled in that browser's inspect page
- the browser showed and you accepted the attach consent prompt
- if Chrome was started with an explicit `--remote-debugging-port`, set
  `browser.profiles.<name>.cdpUrl` to that DevTools endpoint instead of relying
  on Chrome MCP auto-connect
- `openclaw doctor` migrates old extension-based browser config and checks that
  Chrome is installed locally for default auto-connect profiles, but it cannot
  enable browser-side remote debugging for you

Agent use:

- Use `profile="user"` when you need the user's logged-in browser state.
- If you use a custom existing-session profile, pass that explicit profile name.
- Only choose this mode when the user is at the computer to approve the attach
  prompt.
- The Gateway or node host can spawn `npx chrome-devtools-mcp@latest --autoConnect`.

Notes:

- This path is higher-risk than the isolated `openclaw` profile because it can
  act inside your signed-in browser session.
- OpenClaw does not launch the browser for this driver; it only attaches.
- OpenClaw uses the official Chrome DevTools MCP `--autoConnect` flow here. If
  `userDataDir` is set, it is passed through to target that user data directory.
- Existing-session can attach on the selected host or through a connected
  browser node. If Chrome lives elsewhere and no browser node is connected, use
  remote CDP or a node host instead.
- Chrome MCP targets and snapshot refs are scoped to one MCP subprocess. After
  that process restarts, run `browser tabs` again, explicitly select a fresh
  target before target-specific work, and take a new snapshot before using refs.
  Each ref is valid only for its target and latest snapshot. Old aliases are not
  transferred to a replacement tab, even when its URL matches.
- Chrome DevTools MCP currently routes page tools by a process-local numeric page
  ID. Process-scoped handles prevent reuse across subprocess replacement, but an
  in-process browser-context replacement between adjacent tool calls can still
  retarget an action. Fully atomic routing requires upstream page-tool support
  for stable target IDs.

### Custom Chrome MCP launch

Override the spawned Chrome DevTools MCP server per profile when the default
`npx chrome-devtools-mcp@latest` flow is not what you want (offline hosts,
pinned versions, vendored binaries):

| Field        | What it does                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `mcpCommand` | Executable to spawn instead of `npx`. Resolved as-is; absolute paths are honored.                                          |
| `mcpArgs`    | Argument array passed verbatim to `mcpCommand`. Replaces the default `chrome-devtools-mcp@latest --autoConnect` arguments. |

When `cdpUrl` is set on an existing-session profile, OpenClaw skips
`--autoConnect` and forwards the endpoint to Chrome MCP automatically:

- `http(s)://...` → `--browserUrl <url>` (DevTools HTTP discovery endpoint).
- `ws(s)://...` → `--wsEndpoint <url>` (direct CDP WebSocket).

Endpoint flags and `userDataDir` cannot be combined: when `cdpUrl` is set,
`userDataDir` is ignored for Chrome MCP launch, since Chrome MCP attaches to
the running browser behind the endpoint rather than opening a profile
directory.

<Accordion title="Existing-session feature limitations">

Compared to the managed `openclaw` profile, existing-session drivers are more constrained:

- **Screenshots** - page captures and `--ref` element captures work; CSS `--element` selectors do not. Playwright is not required for page or ref-based element screenshots. (`--full-page` cannot combine with `--ref` or `--element` on any profile, not just existing-session.)
- **Actions** - `click`, `type`, `hover`, `scrollIntoView`, `drag`, and `select` require snapshot refs (no CSS selectors). `click-coords` clicks visible viewport coordinates and does not require a snapshot ref. `click` is left-button only (no button overrides or modifiers). `type` does not support `slowly=true`; use `fill` or `press`. `press` does not support `delayMs`. `type`, `hover`, `scrollIntoView`, `drag`, `select`, and `fill` do not support per-call `timeoutMs` overrides; `evaluate` does. `select` accepts a single value. `batch` is not supported; send actions individually.
- **Wait / upload / dialog** - `wait --url` supports exact, substring, and glob patterns (same as managed); `wait --load networkidle` is not supported on existing-session profiles (it works on managed and raw/remote CDP profiles). Upload hooks require `ref` or `inputRef`, one file at a time, no CSS `element`. Dialog hooks do not support timeout overrides or `dialogId`.
- **Dialog visibility** - Managed browser action responses include `blockedByDialog` and `browserState.dialogs.pending` when an action opens a modal dialog; snapshots also include pending dialog state. Respond with `browser dialog --accept/--dismiss --dialog-id <id>` while a dialog is pending. Dialogs handled outside OpenClaw appear under `browserState.dialogs.recent`.
- **Managed-only features** - PDF export, download interception, and `responsebody` still require the managed browser path.

</Accordion>

## Isolation guarantees

- **Dedicated user data dir**: never touches your personal browser profile.
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.
- **Deterministic tab control**: `tabs` returns `suggestedTargetId` first, then
  stable `tabId` handles such as `t1`, optional labels, and the raw `targetId`.
  Agents should reuse `suggestedTargetId`; raw ids remain available for
  debugging and compatibility.

## Browser selection

When launching locally, OpenClaw picks the first available:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

You can override with `browser.executablePath`.

Platforms:

- macOS: checks `/Applications` and `~/Applications`.
- Linux: checks common Chrome/Brave/Edge/Chromium locations under `/usr/bin`,
  `/snap/bin`, `/opt/google`, `/opt/brave.com`, `/usr/lib/chromium`, and
  `/usr/lib/chromium-browser`, plus Playwright-managed Chromium under
  `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`.
- Windows: checks common install locations.

## Control API (optional)

For scripting and debugging, the Gateway exposes a small **loopback-only HTTP
control API** plus a matching `openclaw browser` CLI (snapshots, refs, wait
power-ups, JSON output, debug workflows). See
[Browser control API](/tools/browser-control) for the full reference.

## Troubleshooting

For Linux-specific issues (especially snap Chromium), see
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

For WSL2 Gateway + Windows Chrome split-host setups, see
[WSL2 + Windows + remote Chrome CDP troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting).

### CDP startup failure vs navigation SSRF block

These are different failure classes and they point to different code paths.

- **CDP startup or readiness failure** means OpenClaw cannot confirm that the browser control plane is healthy.
- **Navigation SSRF block** means the browser control plane is healthy, but a page navigation target is rejected by policy.

Common examples:

- CDP startup or readiness failure:
  - `Chrome CDP websocket for profile "openclaw" is not reachable after start`
  - `Remote CDP for profile "<name>" is not reachable at <cdpUrl>`
  - `Port <port> is in use for profile "<name>" but not by openclaw` when a
    loopback external CDP service is configured without `attachOnly: true`
- Navigation SSRF block:
  - `open`, `navigate`, snapshot, or tab-opening flows fail with a browser/network policy error while `start` and `tabs` still work

Use this minimal sequence to separate the two:

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile openclaw open https://example.com
```

How to read the results:

- If `start` fails with `not reachable after start`, troubleshoot CDP readiness first.
- If `start` succeeds but `tabs` fails, the control plane is still unhealthy. Treat this as a CDP reachability problem, not a page-navigation problem.
- If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is up and the failure is in navigation policy or the target page.
- If `start`, `tabs`, and `open` all succeed, the basic managed-browser control path is healthy.

Important behavior details:

- Browser config defaults to a fail-closed SSRF policy object even when you do not configure `browser.ssrfPolicy`.
- For the local loopback `openclaw` managed profile, CDP health checks intentionally skip browser SSRF reachability enforcement for OpenClaw's own local control plane.
- Navigation protection is separate. A successful `start` or `tabs` result does not mean a later `open` or `navigate` target is allowed.

Security guidance:

- Do **not** relax browser SSRF policy by default.
- Prefer narrow host exceptions such as `hostnameAllowlist` or `allowedHostnames` over broad private-network access.
- Use `dangerouslyAllowPrivateNetwork: true` only in intentionally trusted environments where private-network browser access is required and reviewed.

## Agent tools + how control works

The agent gets **one tool** for browser automation:

- `browser` - doctor/status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

How it maps:

- `browser snapshot` returns a stable UI tree (AI or ARIA).
- `browser act` uses the snapshot `ref` IDs to click/type/drag/select.
- `browser screenshot` captures pixels (full page, element, or labeled refs).
- `browser doctor` checks Gateway, plugin, profile, browser, and tab readiness.
- `browser` accepts:
  - `profile` to choose a named browser profile (openclaw, chrome, or remote CDP).
  - `target` (`sandbox` | `host` | `node`) to select where the browser lives.
  - In sandboxed sessions, `target: "host"` requires `agents.defaults.sandbox.browser.allowHostControl=true`.
  - If `target` is omitted: sandboxed sessions default to `sandbox`, non-sandbox sessions default to `host`.
  - If a browser-capable node is connected, the tool may auto-route to it unless you pin `target="host"` or `target="node"`.

This keeps the agent deterministic and avoids brittle selectors.

## Related

- [Tools Overview](/tools) - all available agent tools
- [Sandboxing](/gateway/sandboxing) - browser control in sandboxed environments
- [Security](/gateway/security) - browser control risks and hardening
