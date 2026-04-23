---
summary: "Integrated browser control service + action commands"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why openclaw is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
title: "Browser (OpenClaw-managed)"
---

OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls.
It is isolated from your personal browser and is managed through a small local
control service inside the Gateway (loopback only).

Beginner view:

- Think of it as a **separate, agent-only browser**.
- The `openclaw` profile does **not** touch your personal browser profile.
- The agent can **open tabs, read pages, click, and type** in a safe lane.
- The built-in `user` profile attaches to your real signed-in Chrome session via Chrome MCP.

## What you get

- A separate browser profile named **openclaw** (orange accent by default).
- Deterministic tab control (list/open/focus/close).
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.
- Optional multi-profile support (`openclaw`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## Quick start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

If you get “Browser disabled”, enable it in config (see below) and restart the
Gateway.

If `openclaw browser` is missing entirely, or the agent says the browser tool
is unavailable, jump to [Missing browser command or tool](/tools/browser#missing-browser-command-or-tool).

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

## Missing browser command or tool

If `openclaw browser` is unknown after an upgrade, `browser.request` is missing, or the agent reports the browser tool as unavailable, the usual cause is a `plugins.allow` list that omits `browser`. Add it:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

`browser.enabled=true`, `plugins.entries.browser.enabled=true`, and `tools.alsoAllow: ["browser"]` do not substitute for allowlist membership — the allowlist gates plugin loading, and tool policy only runs after load. Removing `plugins.allow` entirely also restores the default.

## Profiles: `openclaw` vs `user`

- `openclaw`: managed, isolated browser (no extension required).
- `user`: built-in Chrome MCP attach profile for your **real signed-in Chrome**
  session.

For agent browser tool calls:

- Default: use the isolated `openclaw` browser.
- Prefer `profile="user"` when existing logged-in sessions matter and the user
  is at the computer to click/approve any attach prompt.
- `profile` is the explicit override when you want a specific browser mode.

Set `browser.defaultProfile: "openclaw"` if you want managed mode by default.

## Configuration

Browser settings live in `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // allowPrivateNetwork: true, // legacy alias
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "openclaw",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
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

<AccordionGroup>

<Accordion title="Ports and reachability">

- Control service binds to loopback on a port derived from `gateway.port` (default `18791` = gateway + 2). Overriding `gateway.port` or `OPENCLAW_GATEWAY_PORT` shifts the derived ports in the same family.
- Local `openclaw` profiles auto-assign `cdpPort`/`cdpUrl`; set those only for remote CDP. `cdpUrl` defaults to the managed local CDP port when unset.
- `remoteCdpTimeoutMs` applies to remote (non-loopback) CDP HTTP reachability checks; `remoteCdpHandshakeTimeoutMs` applies to remote CDP WebSocket handshakes.

</Accordion>

<Accordion title="SSRF policy">

- Browser navigation and open-tab are SSRF-guarded before navigation and best-effort re-checked on the final `http(s)` URL afterwards.
- In strict SSRF mode, remote CDP endpoint discovery and `/json/version` probes (`cdpUrl`) are checked too.
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` is off by default; enable only when private-network browser access is intentionally trusted.
- `browser.ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.

</Accordion>

<Accordion title="Profile behavior">

- `attachOnly: true` means never launch a local browser; only attach if one is already running.
- `color` (top-level and per-profile) tints the browser UI so you can see which profile is active.
- Default profile is `openclaw` (managed standalone). Use `defaultProfile: "user"` to opt into the signed-in user browser.
- Auto-detect order: system default browser if Chromium-based; otherwise Chrome → Brave → Edge → Chromium → Chrome Canary.
- `driver: "existing-session"` uses Chrome DevTools MCP instead of raw CDP. Do not set `cdpUrl` for that driver.
- Set `browser.profiles.<name>.userDataDir` when an existing-session profile should attach to a non-default Chromium user profile (Brave, Edge, etc.).

</Accordion>

</AccordionGroup>

## Use Brave (or another Chromium-based browser)

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
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

## Local vs remote control

- **Local control (default):** the Gateway starts the loopback control service and can launch a local browser.
- **Remote control (node host):** run a node host on the machine that has the browser; the Gateway proxies browser actions to it.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.

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
- Profiles come from the node’s own `browser.profiles` config (same as local).
- `nodeHost.browserProxy.allowProfiles` is optional. Leave it empty for the legacy/default behavior: all configured profiles remain reachable through the proxy, including profile create/delete routes.
- If you set `nodeHost.browserProxy.allowProfiles`, OpenClaw treats it as a least-privilege boundary: only allowlisted profiles can be targeted, and persistent profile create/delete routes are blocked on the proxy surface.
- Disable if you don’t want it:
  - On the node: `nodeHost.browserProxy.enabled=false`
  - On the gateway: `gateway.nodes.browser.mode="off"`

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
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
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

## Direct WebSocket CDP providers

Some hosted browser services expose a **direct WebSocket** endpoint rather than
the standard HTTP-based CDP discovery (`/json/version`). OpenClaw accepts three
CDP URL shapes and picks the right connection strategy automatically:

- **HTTP(S) discovery** — `http://host[:port]` or `https://host[:port]`.
  OpenClaw calls `/json/version` to discover the WebSocket debugger URL, then
  connects. No WebSocket fallback.
- **Direct WebSocket endpoints** — `ws://host[:port]/devtools/<kind>/<id>` or
  `wss://...` with a `/devtools/browser|page|worker|shared_worker|service_worker/<id>`
  path. OpenClaw connects directly via a WebSocket handshake and skips
  `/json/version` entirely.
- **Bare WebSocket roots** — `ws://host[:port]` or `wss://host[:port]` with no
  `/devtools/...` path (e.g. [Browserless](https://browserless.io),
  [Browserbase](https://www.browserbase.com)). OpenClaw tries HTTP
  `/json/version` discovery first (normalising the scheme to `http`/`https`);
  if discovery returns a `webSocketDebuggerUrl` it is used, otherwise OpenClaw
  falls back to a direct WebSocket handshake at the bare root. This lets a
  bare `ws://` pointed at a local Chrome still connect, since Chrome only
  accepts WebSocket upgrades on the specific per-target path from
  `/json/version`.

### Browserbase

[Browserbase](https://www.browserbase.com) is a cloud platform for running
headless browsers with built-in CAPTCHA solving, stealth mode, and residential
proxies.

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    remoteCdpTimeoutMs: 3000,
    remoteCdpHandshakeTimeoutMs: 5000,
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
- The free tier allows one concurrent session and one browser hour per month.
  See [pricing](https://www.browserbase.com/pricing) for paid plan limits.
- See the [Browserbase docs](https://docs.browserbase.com) for full API
  reference, SDK guides, and integration examples.

## Security

Key ideas:

- Browser control is loopback-only; access flows through the Gateway’s auth or node pairing.
- The standalone loopback browser HTTP API uses **shared-secret auth only**:
  gateway token bearer auth, `x-openclaw-password`, or HTTP Basic auth with the
  configured gateway password.
- Tailscale Serve identity headers and `gateway.auth.mode: "trusted-proxy"` do
  **not** authenticate this standalone loopback browser API.
- If browser control is enabled and no shared-secret auth is configured, OpenClaw
  auto-generates `gateway.auth.token` on startup and persists it to config.
- OpenClaw does **not** auto-generate that token when `gateway.auth.mode` is
  already `password`, `none`, or `trusted-proxy`.
- Keep the Gateway and any node hosts on a private network (Tailscale); avoid public exposure.
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.

Remote CDP tips:

- Prefer encrypted endpoints (HTTPS or WSS) and short-lived tokens where possible.
- Avoid embedding long-lived tokens directly in config files.

## Profiles (multi-browser)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: a dedicated Chromium-based browser instance with its own user data directory + CDP port
- **remote**: an explicit CDP URL (Chromium-based browser running elsewhere)
- **existing session**: your existing Chrome profile via Chrome DevTools MCP auto-connect

Defaults:

- The `openclaw` profile is auto-created if missing.
- The `user` profile is built-in for Chrome MCP existing-session attach.
- Existing-session profiles are opt-in beyond `user`; create them with `--driver existing-session`.
- Local CDP ports allocate from **18800–18899** by default.
- Deleting a profile moves its local data directory to Trash.

All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.

## Existing-session via Chrome DevTools MCP

OpenClaw can also attach to a running Chromium-based browser profile through the
official Chrome DevTools MCP server. This reuses the tabs and login state
already open in that browser profile.

Official background and setup references:

- [Chrome for Developers: Use Chrome DevTools MCP with your browser session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp)

Built-in profile:

- `user`

Optional: create your own custom existing-session profile if you want a
different name, color, or browser data directory.

Default behavior:

- The built-in `user` profile uses Chrome MCP auto-connect, which targets the
  default local Google Chrome profile.

Use `userDataDir` for Brave, Edge, Chromium, or a non-default Chrome profile:

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
- `openclaw doctor` migrates old extension-based browser config and checks that
  Chrome is installed locally for default auto-connect profiles, but it cannot
  enable browser-side remote debugging for you

Agent use:

- Use `profile="user"` when you need the user’s logged-in browser state.
- If you use a custom existing-session profile, pass that explicit profile name.
- Only choose this mode when the user is at the computer to approve the attach
  prompt.
- the Gateway or node host can spawn `npx chrome-devtools-mcp@latest --autoConnect`

Notes:

- This path is higher-risk than the isolated `openclaw` profile because it can
  act inside your signed-in browser session.
- OpenClaw does not launch the browser for this driver; it only attaches.
- OpenClaw uses the official Chrome DevTools MCP `--autoConnect` flow here. If
  `userDataDir` is set, it is passed through to target that user data directory.
- Existing-session can attach on the selected host or through a connected
  browser node. If Chrome lives elsewhere and no browser node is connected, use
  remote CDP or a node host instead.

<Accordion title="Existing-session feature limitations">

Compared to the managed `openclaw` profile, existing-session drivers are more constrained:

- **Screenshots** — page captures and `--ref` element captures work; CSS `--element` selectors do not. `--full-page` cannot combine with `--ref` or `--element`. Playwright is not required for page or ref-based element screenshots.
- **Actions** — `click`, `type`, `hover`, `scrollIntoView`, `drag`, and `select` require snapshot refs (no CSS selectors). `click` is left-button only. `type` does not support `slowly=true`; use `fill` or `press`. `press` does not support `delayMs`. `hover`, `scrollIntoView`, `drag`, `select`, `fill`, and `evaluate` do not support per-call timeouts. `select` accepts a single value.
- **Wait / upload / dialog** — `wait --url` supports exact, substring, and glob patterns; `wait --load networkidle` is not supported. Upload hooks require `ref` or `inputRef`, one file at a time, no CSS `element`. Dialog hooks do not support timeout overrides.
- **Managed-only features** — batch actions, PDF export, download interception, and `responsebody` still require the managed browser path.

</Accordion>

## Isolation guarantees

- **Dedicated user data dir**: never touches your personal browser profile.
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.
- **Deterministic tab control**: target tabs by `targetId`, not “last tab”.

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
- Linux: looks for `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows: checks common install locations.

## Control API (optional)

For local integrations only, the Gateway exposes a small loopback HTTP API:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Actions: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Network: `POST /response/body`
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

All endpoints accept `?profile=<name>`.

If shared-secret gateway auth is configured, browser HTTP routes require auth too:

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` or HTTP Basic auth with that password

Notes:

- This standalone loopback browser API does **not** consume trusted-proxy or
  Tailscale Serve identity headers.
- If `gateway.auth.mode` is `none` or `trusted-proxy`, these loopback browser
  routes do not inherit those identity-bearing modes; keep them loopback-only.

### `/act` error contract

`POST /act` uses a structured error response for route-level validation and
policy failures:

```json
{ "error": "<message>", "code": "ACT_*" }
```

Current `code` values:

- `ACT_KIND_REQUIRED` (HTTP 400): `kind` is missing or unrecognized.
- `ACT_INVALID_REQUEST` (HTTP 400): action payload failed normalization or validation.
- `ACT_SELECTOR_UNSUPPORTED` (HTTP 400): `selector` was used with an unsupported action kind.
- `ACT_EVALUATE_DISABLED` (HTTP 403): `evaluate` (or `wait --fn`) is disabled by config.
- `ACT_TARGET_ID_MISMATCH` (HTTP 403): top-level or batched `targetId` conflicts with request target.
- `ACT_EXISTING_SESSION_UNSUPPORTED` (HTTP 501): action is not supported for existing-session profiles.

Other runtime failures may still return `{ "error": "<message>" }` without a
`code` field.

### Playwright requirement

Some features (navigate/act/AI snapshot/role snapshot, element screenshots,
PDF) require Playwright. If Playwright isn’t installed, those endpoints return
a clear 501 error.

What still works without Playwright:

- ARIA snapshots
- Page screenshots for the managed `openclaw` browser when a per-tab CDP
  WebSocket is available
- Page screenshots for `existing-session` / Chrome MCP profiles
- `existing-session` ref-based screenshots (`--ref`) from snapshot output

What still needs Playwright:

- `navigate`
- `act`
- AI snapshots / role snapshots
- CSS-selector element screenshots (`--element`)
- full browser PDF export

Element screenshots also reject `--full-page`; the route returns `fullPage is
not supported for element screenshots`.

If you see `Playwright is not available in this gateway build`, repair the
bundled browser plugin runtime dependencies so `playwright-core` is installed,
then restart the gateway. For packaged installs, run `openclaw doctor --fix`.
For Docker, also install the Chromium browser binaries as shown below.

#### Docker Playwright install

If your Gateway runs in Docker, avoid `npx playwright` (npm override conflicts).
Use the bundled CLI instead:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

To persist browser downloads, set `PLAYWRIGHT_BROWSERS_PATH` (for example,
`/home/node/.cache/ms-playwright`) and make sure `/home/node` is persisted via
`OPENCLAW_HOME_VOLUME` or a bind mount. See [Docker](/install/docker).

## How it works (internal)

A small loopback control server accepts HTTP requests and connects to Chromium-based browsers via CDP. Advanced actions (click/type/snapshot/PDF) go through Playwright on top of CDP; when Playwright is missing, only non-Playwright operations are available. The agent sees one stable interface while local/remote browsers and profiles swap freely underneath.

## CLI quick reference

All commands accept `--browser-profile <name>` to target a specific profile, and `--json` for machine-readable output.

<AccordionGroup>

<Accordion title="Basics: status, tabs, open/focus/close">

```bash
openclaw browser status
openclaw browser start
openclaw browser stop            # also clears emulation on attach-only/remote CDP
openclaw browser tabs
openclaw browser tab             # shortcut for current tab
openclaw browser tab new
openclaw browser tab select 2
openclaw browser tab close 2
openclaw browser open https://example.com
openclaw browser focus abcd1234
openclaw browser close abcd1234
```

</Accordion>

<Accordion title="Inspection: screenshot, snapshot, console, errors, requests">

```bash
openclaw browser screenshot
openclaw browser screenshot --full-page
openclaw browser screenshot --ref 12        # or --ref e12
openclaw browser snapshot
openclaw browser snapshot --format aria --limit 200
openclaw browser snapshot --interactive --compact --depth 6
openclaw browser snapshot --efficient
openclaw browser snapshot --labels
openclaw browser snapshot --selector "#main" --interactive
openclaw browser snapshot --frame "iframe#main" --interactive
openclaw browser console --level error
openclaw browser errors --clear
openclaw browser requests --filter api --clear
openclaw browser pdf
openclaw browser responsebody "**/api" --max-chars 5000
```

</Accordion>

<Accordion title="Actions: navigate, click, type, drag, wait, evaluate">

```bash
openclaw browser navigate https://example.com
openclaw browser resize 1280 720
openclaw browser click 12 --double           # or e12 for role refs
openclaw browser type 23 "hello" --submit
openclaw browser press Enter
openclaw browser hover 44
openclaw browser scrollintoview e12
openclaw browser drag 10 11
openclaw browser select 9 OptionA OptionB
openclaw browser download e12 report.pdf
openclaw browser waitfordownload report.pdf
openclaw browser upload /tmp/openclaw/uploads/file.pdf
openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'
openclaw browser dialog --accept
openclaw browser wait --text "Done"
openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"
openclaw browser evaluate --fn '(el) => el.textContent' --ref 7
openclaw browser highlight e12
openclaw browser trace start
openclaw browser trace stop
```

</Accordion>

<Accordion title="State: cookies, storage, offline, headers, geo, device">

```bash
openclaw browser cookies
openclaw browser cookies set session abc123 --url "https://example.com"
openclaw browser cookies clear
openclaw browser storage local get
openclaw browser storage local set theme dark
openclaw browser storage session clear
openclaw browser set offline on
openclaw browser set headers --headers-json '{"X-Debug":"1"}'
openclaw browser set credentials user pass            # --clear to remove
openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"
openclaw browser set media dark
openclaw browser set timezone America/New_York
openclaw browser set locale en-US
openclaw browser set device "iPhone 14"
```

</Accordion>

</AccordionGroup>

Notes:

- `upload` and `dialog` are **arming** calls; run them before the click/press that triggers the chooser/dialog.
- `click`/`type`/etc require a `ref` from `snapshot` (numeric `12` or role ref `e12`). CSS selectors are intentionally not supported for actions.
- Download, trace, and upload paths are constrained to OpenClaw temp roots: `/tmp/openclaw{,/downloads,/uploads}` (fallback: `${os.tmpdir()}/openclaw/...`).
- `upload` can also set file inputs directly via `--input-ref` or `--element`.

Snapshot flags at a glance:

- `--format ai` (default with Playwright): AI snapshot with numeric refs (`aria-ref="<n>"`).
- `--format aria`: accessibility tree, no refs; inspection only.
- `--efficient` (or `--mode efficient`): compact role snapshot preset. Set `browser.snapshotDefaults.mode: "efficient"` to make this the default (see [Gateway configuration](/gateway/configuration-reference#browser)).
- `--interactive`, `--compact`, `--depth`, `--selector` force a role snapshot with `ref=e12` refs. `--frame "<iframe>"` scopes role snapshots to an iframe.
- `--labels` adds a viewport-only screenshot with overlayed ref labels (prints `MEDIA:<path>`).

## Snapshots and refs

OpenClaw supports two “snapshot” styles:

- **AI snapshot (numeric refs)**: `openclaw browser snapshot` (default; `--format ai`)
  - Output: a text snapshot that includes numeric refs.
  - Actions: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internally, the ref is resolved via Playwright’s `aria-ref`.

- **Role snapshot (role refs like `e12`)**: `openclaw browser snapshot --interactive` (or `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: a role-based list/tree with `[ref=e12]` (and optional `[nth=1]`).
  - Actions: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internally, the ref is resolved via `getByRole(...)` (plus `nth()` for duplicates).
  - Add `--labels` to include a viewport screenshot with overlayed `e12` labels.

Ref behavior:

- Refs are **not stable across navigations**; if something fails, re-run `snapshot` and use a fresh ref.
- If the role snapshot was taken with `--frame`, role refs are scoped to that iframe until the next role snapshot.

## Wait power-ups

You can wait on more than just time/text:

- Wait for URL (globs supported by Playwright):
  - `openclaw browser wait --url "**/dash"`
- Wait for load state:
  - `openclaw browser wait --load networkidle`
- Wait for a JS predicate:
  - `openclaw browser wait --fn "window.ready===true"`
- Wait for a selector to become visible:
  - `openclaw browser wait "#main"`

These can be combined:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

When an action fails (e.g. “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Use `click <ref>` / `type <ref>` (prefer role refs in interactive mode)
3. If it still fails: `openclaw browser highlight <ref>` to see what Playwright is targeting
4. If the page behaves oddly:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. For deep debugging: record a trace:
   - `openclaw browser trace start`
   - reproduce the issue
   - `openclaw browser trace stop` (prints `TRACE:<path>`)

## JSON output

`--json` is for scripting and structured tooling.

Examples:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Role snapshots in JSON include `refs` plus a small `stats` block (lines/chars/refs/interactive) so tools can reason about payload size and density.

## State and environment knobs

These are useful for “make the site behave like X” workflows:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --headers-json '{"X-Debug":"1"}'` (legacy `set headers --json '{"X-Debug":"1"}'` remains supported)
- HTTP basic auth: `set credentials user pass` (or `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (or `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Security and privacy

- The openclaw browser profile may contain logged-in sessions; treat it as sensitive.
- `browser act kind=evaluate` / `openclaw browser evaluate` and `wait --fn`
  execute arbitrary JavaScript in the page context. Prompt injection can steer
  this. Disable it with `browser.evaluateEnabled=false` if you do not need it.
- For logins and anti-bot notes (X/Twitter, etc.), see [Browser login + X/Twitter posting](/tools/browser-login).
- Keep the Gateway/node host private (loopback or tailnet-only).
- Remote CDP endpoints are powerful; tunnel and protect them.

Strict-mode example (block private/internal destinations by default):

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"], // optional exact allow
    },
  },
}
```

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

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

How it maps:

- `browser snapshot` returns a stable UI tree (AI or ARIA).
- `browser act` uses the snapshot `ref` IDs to click/type/drag/select.
- `browser screenshot` captures pixels (full page or element).
- `browser` accepts:
  - `profile` to choose a named browser profile (openclaw, chrome, or remote CDP).
  - `target` (`sandbox` | `host` | `node`) to select where the browser lives.
  - In sandboxed sessions, `target: "host"` requires `agents.defaults.sandbox.browser.allowHostControl=true`.
  - If `target` is omitted: sandboxed sessions default to `sandbox`, non-sandbox sessions default to `host`.
  - If a browser-capable node is connected, the tool may auto-route to it unless you pin `target="host"` or `target="node"`.

This keeps the agent deterministic and avoids brittle selectors.

## Related

- [Tools Overview](/tools) — all available agent tools
- [Sandboxing](/gateway/sandboxing) — browser control in sandboxed environments
- [Security](/gateway/security) — browser control risks and hardening
