---
summary: "Integrated browser control server + action commands"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why clawd is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
---

# Browser (clawd-managed)

Clawdbot can run a **dedicated Chrome/Chromium profile** that the agent controls.
It is isolated from your personal browser and is managed through a small local
control server.

Beginner view:
- Think of it as a **separate, agent-only browser**.
- It does **not** touch your personal Chrome profile.
- The agent can **open tabs, read pages, click, and type** in a safe lane.

## What you get

- A separate browser profile named **clawd** (orange accent by default).
- Deterministic tab control (list/open/focus/close).
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.
- Optional multi-profile support (`clawd`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## Quick start

```bash
clawdbot browser --browser-profile clawd status
clawdbot browser --browser-profile clawd start
clawdbot browser --browser-profile clawd open https://example.com
clawdbot browser --browser-profile clawd snapshot
```

If you get “Browser disabled”, enable it in config (see below) and restart the
Gateway.

## Configuration

Browser settings live in `~/.clawdbot/clawdbot.json`.

```json5
{
  browser: {
    enabled: true,                    // default: true
    controlUrl: "http://127.0.0.1:18791",
    cdpUrl: "http://127.0.0.1:18792", // defaults to controlUrl + 1
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    profiles: {
      clawd: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" }
    }
  }
}
```

Notes:
- `controlUrl` defaults to `http://127.0.0.1:18791`.
- If you override the Gateway port (`gateway.port` or `CLAWDBOT_GATEWAY_PORT`),
  the default browser ports shift to stay in the same “family” (control = gateway + 2).
- `cdpUrl` defaults to `controlUrl + 1` when unset.
- `attachOnly: true` means “never launch Chrome; only attach if it is already running.”
- `color` + per-profile `color` tint the browser UI so you can see which profile is active.

## Local vs remote control

- **Local control (default):** `controlUrl` is loopback (`127.0.0.1`/`localhost`).
  The Gateway starts the control server and can launch Chrome.
- **Remote control:** `controlUrl` is non-loopback. The Gateway **does not** start
  a local server; it assumes you are pointing at an existing server elsewhere.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chrome. In this case, Clawdbot will not launch a local browser.

## Remote browser (control server)

You can run the **browser control server** on another machine and point your
Gateway at it with a remote `controlUrl`. This lets the agent drive a browser
outside the host (lab box, VM, remote desktop, etc.).

Key points:
- The **control server** speaks to Chrome/Chromium via **CDP**.
- The **Gateway** only needs the HTTP control URL.
- Profiles are resolved on the **control server** side.

Example:
```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://10.0.0.42:18791",
    defaultProfile: "work"
  }
}
```

Use `profiles.<name>.cdpUrl` for **remote CDP** if you want the Gateway to talk
directly to a Chrome instance without a remote control server.

### Running the control server on the browser machine

Run a standalone browser control server (recommended when your Gateway is remote):

```bash
# on the machine that runs Chrome
clawdbot browser serve --bind <browser-host> --port 18791 --token <token>
```

Then point your Gateway at it:

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://<browser-host>:18791",

    // Option A (recommended): keep token in env on the Gateway
    // (avoid writing secrets into config files)
    // controlToken: "<token>"
  }
}
```

And set the auth token in the Gateway environment:

```bash
export CLAWDBOT_BROWSER_CONTROL_TOKEN="<token>"
```

Option B: store the token in the Gateway config instead (same shared token):

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://<browser-host>:18791",
    controlToken: "<token>"
  }
}
```

## Security

This section covers the **browser control server** (`browser.controlUrl`) used for agent browser automation.

Key ideas:
- Treat the browser control server like an admin API: **private network only**.
- Use **token auth** always when the server is reachable off-machine.
- Prefer **Tailnet-only** connectivity over LAN exposure.

### Tokens (what is shared with what?)

- `browser.controlToken` / `CLAWDBOT_BROWSER_CONTROL_TOKEN` is **only** for authenticating browser control HTTP requests to `browser.controlUrl`.
- It is **not** the Gateway token (`gateway.auth.token`) and **not** a node pairing token.
- You *can* reuse the same string value, but it’s better to keep them separate to reduce blast radius.

### Binding (don’t expose to your LAN by accident)

Recommended:
- Keep `clawdbot browser serve` bound to loopback (`127.0.0.1`) and publish it via Tailscale.
- Or bind to a Tailnet IP only (never `0.0.0.0`) and require a token.

Avoid:
- `--bind 0.0.0.0` (LAN-visible). Even with token auth, traffic is plain HTTP unless you also add TLS.

### TLS / HTTPS (recommended approach: terminate in front)

Best practice here: keep `clawdbot browser serve` on HTTP and terminate TLS in front.

If you’re already using Tailscale, you have two good options:

1) **Tailnet-only, still HTTP** (transport is encrypted by Tailscale):
- Keep `controlUrl` as `http://…` but ensure it’s only reachable over your tailnet.

2) **Serve HTTPS via Tailscale** (nice UX: `https://…` URL):

```bash
# on the browser machine
clawdbot browser serve --bind 127.0.0.1 --port 18791 --token <token>
tailscale serve https / http://127.0.0.1:18791
```

Then set your Gateway config `browser.controlUrl` to the HTTPS URL (MagicDNS/ts.net) and keep using the same token.

Notes:
- Do **not** use Tailscale Funnel for this unless you explicitly want to make the endpoint public.
- For Tailnet setup/background, see [Gateway web surfaces](/web/index) and the [Gateway CLI](/cli/gateway).

## Profiles (multi-browser)

Clawdbot supports multiple named profiles (routing configs). Profiles can be:
- **clawd-managed**: a dedicated Chrome instance with its own user data directory + CDP port
- **remote**: an explicit CDP URL (Chrome running elsewhere)
- **extension relay**: your existing Chrome tab(s) via the local relay + Chrome extension

Defaults:
- The `clawd` profile is auto-created if missing.
- The `chrome` profile is built-in for the Chrome extension relay (points at `http://127.0.0.1:18792` by default).
- Local CDP ports allocate from **18800–18899** by default.
- Deleting a profile moves its local data directory to Trash.

All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.

## Chrome extension relay (use your existing Chrome)

Clawdbot can also drive **your existing Chrome tabs** (no separate “clawd” Chrome instance) via a local CDP relay + a Chrome extension.

Full guide: [Chrome extension](/tools/chrome-extension)

Flow:
- You run a **browser control server** (Gateway on the same machine, or `clawdbot browser serve`).
- A local **relay server** listens at a loopback `cdpUrl` (default: `http://127.0.0.1:18792`).
- You click the **Clawdbot Browser Relay** extension icon on a tab to attach (it does not auto-attach).
- The agent controls that tab via the normal `browser` tool, by selecting the right profile.

If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need `clawdbot browser serve`.
Use `browser serve` only when the Gateway runs elsewhere (remote mode).

### Sandboxed sessions

If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).
Chrome extension relay takeover requires host browser control, so either:
- run the session unsandboxed, or
- set `agents.defaults.sandbox.browser.allowHostControl: true` and use `target="host"` when calling the tool.

### Setup

1) Load the extension (dev/unpacked):

```bash
clawdbot browser extension install
```

- Chrome → `chrome://extensions` → enable “Developer mode”
- “Load unpacked” → select the directory printed by `clawdbot browser extension path`
- Pin the extension, then click it on the tab you want to control (badge shows `ON`).

2) Use it:
- CLI: `clawdbot browser --browser-profile chrome tabs`
- Agent tool: `browser` with `profile="chrome"`

Optional: if you want a different name or relay port, create your own profile:

```bash
clawdbot browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notes:
- This mode relies on Playwright-on-CDP for most operations (screenshots/snapshots/actions).
- Detach by clicking the extension icon again.

## Isolation guarantees

- **Dedicated user data dir**: never touches your personal Chrome profile.
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.
- **Deterministic tab control**: target tabs by `targetId`, not “last tab”.

## Browser selection

When launching locally, Clawdbot picks the first available:
1. Chrome Canary
2. Chromium
3. Chrome

You can override with `browser.executablePath`.

Platforms:
- macOS: checks `/Applications` and `~/Applications`.
- Linux: looks for `google-chrome`, `chromium`, etc.
- Windows: checks common install locations.

## Control API (optional)

If you want to integrate directly, the browser control server exposes a small
HTTP API:

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

### Playwright requirement

Some features (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) require
Playwright. If Playwright isn’t installed, those endpoints return a clear 501
error. ARIA snapshots and basic screenshots still work for clawd-managed Chrome.
For the Chrome extension relay driver, ARIA snapshots and screenshots require Playwright.

## How it works (internal)

High-level flow:
- A small **control server** accepts HTTP requests.
- It connects to Chrome/Chromium via **CDP**.
- For advanced actions (click/type/snapshot/PDF), it uses **Playwright** on top
  of CDP.
- When Playwright is missing, only non-Playwright operations are available.

This design keeps the agent on a stable, deterministic interface while letting
you swap local/remote browsers and profiles.

## CLI quick reference

All commands accept `--browser-profile <name>` to target a specific profile.
All commands also accept `--json` for machine-readable output (stable payloads).

Basics:
- `clawdbot browser status`
- `clawdbot browser start`
- `clawdbot browser stop`
- `clawdbot browser tabs`
- `clawdbot browser tab`
- `clawdbot browser tab new`
- `clawdbot browser tab select 2`
- `clawdbot browser tab close 2`
- `clawdbot browser open https://example.com`
- `clawdbot browser focus abcd1234`
- `clawdbot browser close abcd1234`

Inspection:
- `clawdbot browser screenshot`
- `clawdbot browser screenshot --full-page`
- `clawdbot browser screenshot --ref 12`
- `clawdbot browser screenshot --ref e12`
- `clawdbot browser snapshot`
- `clawdbot browser snapshot --format aria --limit 200`
- `clawdbot browser snapshot --interactive --compact --depth 6`
- `clawdbot browser snapshot --efficient`
- `clawdbot browser snapshot --labels`
- `clawdbot browser snapshot --selector "#main" --interactive`
- `clawdbot browser snapshot --frame "iframe#main" --interactive`
- `clawdbot browser console --level error`
- `clawdbot browser errors --clear`
- `clawdbot browser requests --filter api --clear`
- `clawdbot browser pdf`
- `clawdbot browser responsebody "**/api" --max-chars 5000`

Actions:
- `clawdbot browser navigate https://example.com`
- `clawdbot browser resize 1280 720`
- `clawdbot browser click 12 --double`
- `clawdbot browser click e12 --double`
- `clawdbot browser type 23 "hello" --submit`
- `clawdbot browser press Enter`
- `clawdbot browser hover 44`
- `clawdbot browser scrollintoview e12`
- `clawdbot browser drag 10 11`
- `clawdbot browser select 9 OptionA OptionB`
- `clawdbot browser download e12 /tmp/report.pdf`
- `clawdbot browser waitfordownload /tmp/report.pdf`
- `clawdbot browser upload /tmp/file.pdf`
- `clawdbot browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `clawdbot browser dialog --accept`
- `clawdbot browser wait --text "Done"`
- `clawdbot browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `clawdbot browser evaluate --fn '(el) => el.textContent' --ref 7`
- `clawdbot browser highlight e12`
- `clawdbot browser trace start`
- `clawdbot browser trace stop`

State:
- `clawdbot browser cookies`
- `clawdbot browser cookies set session abc123 --url "https://example.com"`
- `clawdbot browser cookies clear`
- `clawdbot browser storage local get`
- `clawdbot browser storage local set theme dark`
- `clawdbot browser storage session clear`
- `clawdbot browser set offline on`
- `clawdbot browser set headers --json '{"X-Debug":"1"}'`
- `clawdbot browser set credentials user pass`
- `clawdbot browser set credentials --clear`
- `clawdbot browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `clawdbot browser set geo --clear`
- `clawdbot browser set media dark`
- `clawdbot browser set timezone America/New_York`
- `clawdbot browser set locale en-US`
- `clawdbot browser set device "iPhone 14"`

Notes:
- `upload` and `dialog` are **arming** calls; run them before the click/press
  that triggers the chooser/dialog.
- `upload` can also set file inputs directly via `--input-ref` or `--element`.
- `snapshot`:
  - `--format ai` (default when Playwright is installed): returns an AI snapshot with numeric refs (`aria-ref="<n>"`).
  - `--format aria`: returns the accessibility tree (no refs; inspection only).
  - `--efficient` (or `--mode efficient`): compact role snapshot preset (interactive + compact + depth + lower maxChars).
  - Role snapshot options (`--interactive`, `--compact`, `--depth`, `--selector`) force a role-based snapshot with refs like `ref=e12`.
  - `--frame "<iframe selector>"` scopes role snapshots to an iframe (pairs with role refs like `e12`).
  - `--interactive` outputs a flat, easy-to-pick list of interactive elements (best for driving actions).
  - `--labels` adds a viewport-only screenshot with overlayed ref labels (prints `MEDIA:<path>`).
- `click`/`type`/etc require a `ref` from `snapshot` (either numeric `12` or role ref `e12`).
  CSS selectors are intentionally not supported for actions.

## Snapshots and refs

Clawdbot supports two “snapshot” styles:

- **AI snapshot (numeric refs)**: `clawdbot browser snapshot` (default; `--format ai`)
  - Output: a text snapshot that includes numeric refs.
  - Actions: `clawdbot browser click 12`, `clawdbot browser type 23 "hello"`.
  - Internally, the ref is resolved via Playwright’s `aria-ref`.

- **Role snapshot (role refs like `e12`)**: `clawdbot browser snapshot --interactive` (or `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: a role-based list/tree with `[ref=e12]` (and optional `[nth=1]`).
  - Actions: `clawdbot browser click e12`, `clawdbot browser highlight e12`.
  - Internally, the ref is resolved via `getByRole(...)` (plus `nth()` for duplicates).
  - Add `--labels` to include a viewport screenshot with overlayed `e12` labels.

Ref behavior:
- Refs are **not stable across navigations**; if something fails, re-run `snapshot` and use a fresh ref.
- If the role snapshot was taken with `--frame`, role refs are scoped to that iframe until the next role snapshot.

## Wait power-ups

You can wait on more than just time/text:

- Wait for URL (globs supported by Playwright):
  - `clawdbot browser wait --url "**/dash"`
- Wait for load state:
  - `clawdbot browser wait --load networkidle`
- Wait for a JS predicate:
  - `clawdbot browser wait --fn "window.ready===true"`
- Wait for a selector to become visible:
  - `clawdbot browser wait "#main"`

These can be combined:

```bash
clawdbot browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

When an action fails (e.g. “not visible”, “strict mode violation”, “covered”):

1. `clawdbot browser snapshot --interactive`
2. Use `click <ref>` / `type <ref>` (prefer role refs in interactive mode)
3. If it still fails: `clawdbot browser highlight <ref>` to see what Playwright is targeting
4. If the page behaves oddly:
   - `clawdbot browser errors --clear`
   - `clawdbot browser requests --filter api --clear`
5. For deep debugging: record a trace:
   - `clawdbot browser trace start`
   - reproduce the issue
   - `clawdbot browser trace stop` (prints `TRACE:<path>`)

## JSON output

`--json` is for scripting and structured tooling.

Examples:

```bash
clawdbot browser status --json
clawdbot browser snapshot --interactive --json
clawdbot browser requests --filter api --json
clawdbot browser cookies --json
```

Role snapshots in JSON include `refs` plus a small `stats` block (lines/chars/refs/interactive) so tools can reason about payload size and density.

## State and environment knobs

These are useful for “make the site behave like X” workflows:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (or `--clear`)
- HTTP basic auth: `set credentials user pass` (or `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (or `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Security & privacy

- The clawd browser profile may contain logged-in sessions; treat it as sensitive.
- For logins and anti-bot notes (X/Twitter, etc.), see [Browser login + X/Twitter posting](/tools/browser-login).
- Keep control URLs loopback-only unless you intentionally expose the server.
- Remote CDP endpoints are powerful; tunnel and protect them.

## Troubleshooting

For Linux-specific issues (especially snap Chromium), see
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Agent tools + how control works

The agent gets **one tool** for browser automation:
- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

How it maps:
- `browser snapshot` returns a stable UI tree (AI or ARIA).
- `browser act` uses the snapshot `ref` IDs to click/type/drag/select.
- `browser screenshot` captures pixels (full page or element).
- `browser` accepts:
  - `profile` to choose a named browser profile (host or remote control server).
  - `target` (`sandbox` | `host` | `custom`) to select where the browser lives.
  - `controlUrl` sets `target: "custom"` implicitly (remote control server).
  - In sandboxed sessions, `target: "host"` requires `agents.defaults.sandbox.browser.allowHostControl=true`.
  - If `target` is omitted: sandboxed sessions default to `sandbox`, non-sandbox sessions default to `host`.
  - Sandbox allowlists can restrict `target: "custom"` to specific URLs/hosts/ports.
  - Defaults: allowlists unset (no restriction), and sandbox host control is disabled.

This keeps the agent deterministic and avoids brittle selectors.
