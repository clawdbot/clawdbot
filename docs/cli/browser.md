---
summary: "CLI reference for `openclaw browser` (lifecycle, profiles, tabs, actions, state, and debugging)"
read_when:
  - You use `openclaw browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to attach to your local signed-in Chrome via Chrome MCP
title: "Browser"
---

# `openclaw browser`

Manage OpenClaw's browser control surface and run browser actions: lifecycle, profiles, tabs, snapshots, screenshots, navigation, input, state emulation, and debugging.

Related: [Browser tool](/tools/browser)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout in ms (default: `30000`).
- `--expect-final`: wait for a final Gateway response.
- `--browser-profile <name>`: choose a browser profile (default: `openclaw`, or `browser.defaultProfile`).
- `--json`: machine-readable output (where supported). This is a browser-level option, so
  place it before the subcommand for an unambiguous form, such as
  `openclaw browser --json status`. Trailing placement such as
  `openclaw browser status --json` also works when the selected child command does not
  define its own `--json`.

## Quick start (local)

```bash
openclaw browser profiles
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Agents can run the same readiness check with `browser({ action: "doctor" })`.

## Quick troubleshooting

If `start` fails with `not reachable after start`, troubleshoot CDP readiness first. If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is healthy and the failure is usually a navigation SSRF policy block.

Minimal sequence:

```bash
openclaw browser --browser-profile openclaw doctor
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile openclaw open https://example.com
```

Detailed guidance: [Browser troubleshooting](/tools/browser#cdp-startup-failure-vs-navigation-ssrf-block)

## Lifecycle

```bash
openclaw browser status
openclaw browser doctor
openclaw browser doctor --deep
openclaw browser start
openclaw browser start --headless
openclaw browser stop
openclaw browser --browser-profile openclaw reset-profile
```

- `doctor --deep` adds a live snapshot probe: useful when basic CDP readiness is green but you want proof the current tab can be inspected.
- For a running local managed profile, `status` and `doctor` report cached
  graphics diagnostics from Chrome: hardware/software classification, renderer,
  backend, device/driver, feature and disabled-status details, and accelerated
  video capabilities. `openclaw browser --json status` returns the full structured payload.
  Passive status never launches Chrome just to collect these facts.
- `stop` closes the active control session and clears temporary emulation overrides even for `attachOnly` and remote CDP profiles where OpenClaw did not launch the browser process itself. For local managed profiles, `stop` also stops the spawned browser process.
- `start --headless` applies only to that start request, and only when OpenClaw launches a local managed browser. It does not rewrite `browser.headless` or profile config, and is a no-op for an already-running browser.
- On Linux hosts without `DISPLAY` or `WAYLAND_DISPLAY`, local managed profiles run headless automatically unless `OPENCLAW_BROWSER_HEADLESS=0`, `browser.headless=false`, or `browser.profiles.<name>.headless=false` explicitly requests a visible browser.

## If the command is missing

If `openclaw browser` is an unknown command, check `plugins.allow` in `~/.openclaw/openclaw.json`. When `plugins.allow` is present, list the bundled browser plugin explicitly unless the config already has a root `browser` block:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

An explicit root `browser` block (for example `browser.enabled=true` or `browser.profiles.<name>`) also activates the bundled browser plugin under a restrictive plugin allowlist.

Related: [Browser tool](/tools/browser#missing-browser-command-or-tool)

## Profiles

Profiles are named browser routing configs:

- `openclaw` (default): launches or attaches to a dedicated OpenClaw-managed Chrome instance (isolated user data dir).
- `user`: controls your existing signed-in Chrome session via Chrome DevTools MCP.
- custom CDP profiles: point at a local or remote CDP endpoint.

```bash
openclaw browser profiles
openclaw browser system-profiles
openclaw browser system-profiles --browser brave
openclaw browser import-profile --browser chrome --system Default --into imported
openclaw browser import-profile --system "Profile 1" --into work --domains google.com,youtube.com
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser create-profile --name chrome-live --driver existing-session
openclaw browser create-profile --name remote --cdp-url https://browser-host.example.com
openclaw browser delete-profile --name work
```

Use a specific profile with `--browser-profile <name>` on any subcommand, for example `openclaw browser --browser-profile work tabs`.

On macOS, `system-profiles` lists real Chrome, Brave, Edge, or Chromium profiles available on the host. `import-profile` decrypts their cookies after one macOS Keychain/Touch ID consent prompt and injects them into a fresh OpenClaw-managed profile. It imports cookies only; local storage and IndexedDB are unchanged. Some Google sessions use device-bound session credentials (DBSC) and can still require re-authentication after import.

When the macOS app uses a local Gateway, it can offer this import once and make the isolated imported profile the default for agent browsing. Import always requires an explicit click; successful import or dismissal suppresses later automatic prompts, and **Settings → General → Browser login** remains available for re-import.

System-profile import is enabled by default. Set `browser.allowSystemProfileImport=false` to disable both CLI and agent-triggered imports. Import is host-local and cannot run through the browser node proxy.

### Cookie sync to a remote Gateway

`import-profile` targets a managed profile on the same host. When your OpenClaw Gateway and agent browser run on a separate computer, use `cookie-sync` to decrypt cookies on this Mac and push them into a managed profile on that remote Gateway over the operator connection:

```bash
openclaw browser cookie-sync --domains github.com,news.ycombinator.com --into work
openclaw browser --url wss://gateway.example.com cookie-sync --domains github.com --into work --watch
```

- `--domains` is required. Cookie sync copies live session cookies, so it never sends an unrestricted cookie jar; a missing or empty allowlist is a hard error.
- `--into` selects the target managed profile on the Gateway (default `imported`); `--gateway`/`--url` selects a remote Gateway (default is the configured/local one).
- `--watch` keeps the command running and re-pushes when the source Cookies database changes. The macOS Keychain secret is read once per watch session, so you approve a single consent prompt rather than one per change.
- Decryption is host-local (macOS only) and reuses the same allowlist and Keychain path as `import-profile`. Cookies are decrypted on this Mac and shipped over the existing TLS-pinned Gateway connection; no cookie values are printed.
- Some Google sessions use device-bound session credentials (DBSC) that stay tied to this Mac and can still require re-authentication after sync. For those sites, prefer driving the browser on the Mac itself through the [browser node proxy](#remote-browser-control-node-host-proxy).

The macOS app exposes the same capability under **Dashboard → Settings → This Mac → Browser**: an off-by-default toggle, an editable domain allowlist, and a target-profile field. When enabled in remote mode it supervises `cookie-sync --watch` for you against the connected Gateway and shows a live status row.

## Chrome extension relay

```bash
openclaw browser extension path
openclaw browser extension install
openclaw browser extension install --no-store
openclaw browser extension install --json --wait-ms 60000
openclaw browser extension status
openclaw browser extension status --json
openclaw browser extension uninstall-host
openclaw browser extension uninstall-store
openclaw browser extension pair
openclaw browser extension pair --gateway-url wss://gateway.example.com
openclaw browser extension cdp
openclaw browser extension cdp --json
```

- `extension install` pre-registers the origin-locked native bootstrap host in
  existing Chrome-family user-data roots. On macOS, it then requests the official
  Store installation in Google Chrome for all profiles in its user-data directory.
  Chrome discovers this at startup; fully quit and reopen Chrome when convenient,
  then approve or enable OpenClaw. The command never restarts Chrome or bypasses
  approval. For other browsers and platforms,
  [add OpenClaw from the Chrome Web Store](https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig).
  Linux supports automatic native pairing; Windows retains manual pairing.
- `extension install --no-store` copies the stable development extension and
  registers the native host without creating a Store request. Existing requests
  are unchanged. Use the printed path for **Load unpacked**.
- `extension status` reports `storeInstallRequests` states (`requested`,
  `missing`, `foreign`, `invalid`) separately from `storeDiscovered` approval
  fields (`enabled`, `awaitingApproval`), approved unpacked IDs and paths, and
  native-host registration health. Local installation status does not prove a
  live relay connection. JSON output never includes a pairing string or relay key.
- `extension uninstall-host` removes only verified OpenClaw-owned native-host
  manifests and launchers. It does not remove the extension from Chrome.
- `extension uninstall-store` removes only OpenClaw-owned macOS Chrome Store
  requests. Chrome may remove an externally installed extension at its next
  startup. Native-host registration and the development copy remain intact.
- `extension path` is read-only. It prints the stable installed copy when
  present and the bundled source directory otherwise.
- `extension pair` remains the advanced manual flow. `--gateway-url` creates a
  direct remote-Gateway pairing URL; non-loopback URLs must use `wss://`.
- `extension cdp` prints non-secret Browser Relay Authentication v2 metadata:
  the loopback browser/CDP endpoints, protocol version, key ID, and fixed
  challenge/complete binding. It never prints the relay key or an authorization
  header by default.

Automatic local bootstrap connects through the local Gateway's exact
`/browser/extension` route so the first authenticated extension connection
starts the lazy browser-control service. Keep `openclaw gateway run` or the
managed Gateway service running; no separate browser request or prewarm is
needed. Local OpenClaw and mcporter calls still use the profile relay port
reported by `extension pair` or `extension cdp` after that wakeup. Browser-node
pairings continue to use the relay on the browser-node host, while explicit
`--gateway-url` pairings remain direct-remote and manual-only.

The advanced manual `extension pair` command without `--gateway-url` retains
the host-local `/extension` relay URL. With the native host installed,
**Automatic local setup** enabled, and an extension build that supports relay
wake-up, reconnecting can start a standalone relay on the saved pairing's
configured port. This does not start Gateway browser control: authenticated CDP
clients can use the standalone relay without a Gateway, but `openclaw browser`
actions still require one. For source-checkout testing, load the managed unpacked
copy from the same OpenClaw installation.

`extension cdp --legacy-bearer` is a temporary migration escape hatch. It
prints the old Bearer header with a warning only while
`browser.extensionRelay.allowLegacyAuth=true`; otherwise it exits with an error
without printing a credential. Use `--json` for machine output; warnings remain
on stderr so stdout stays valid JSON.

Setup, security model, and recovery steps: [Chrome extension](/tools/chrome-extension).

Run installation on the machine hosting Chrome. In the macOS app,
**Dashboard → Settings → This Mac → Browser → Set up Chrome on this Mac** invokes
the local CLI even when connected to a remote Gateway. The browser-based
dashboard offers Store and documentation links instead.

If the extension already attempted automatic setup before the native host
existed, Chromium retains that miss for the running browser process. Restart
Chrome once, run `extension install`, then reopen the Store extension; popup
retries alone cannot recover that existing process.

## Tabs

```bash
openclaw browser tabs
openclaw browser tab new --label docs
openclaw browser tab label t1 docs
openclaw browser tab select 2
openclaw browser tab close 2
openclaw browser open https://docs.openclaw.ai --label docs
openclaw browser focus docs
openclaw browser close t1
```

`tabs` returns `suggestedTargetId` first, then the stable `tabId` (such as `t1`), the optional label, and the raw `targetId`. Pass `suggestedTargetId` back into `focus`, `close`, snapshots, and actions. Assign a label with `open --label`, `tab new --label`, or `tab label`; labels, tab ids, raw target ids, and unique target-id prefixes are all accepted. The request field is still named `targetId` for compatibility, but it accepts any of these tab references.

Raw target ids are volatile diagnostic handles, not durable agent memory: when Chromium replaces the underlying raw target during a navigation or form submit, OpenClaw keeps the stable `tabId`/label attached to the replacement tab when it can prove the match. Prefer `suggestedTargetId`.

## Snapshot / screenshot / actions

Snapshot:

```bash
openclaw browser snapshot
openclaw browser snapshot --urls
```

Screenshot:

```bash
openclaw browser screenshot
openclaw browser screenshot --full-page
openclaw browser screenshot --ref e12
openclaw browser screenshot --labels
```

- `--full-page` is for page captures only; it cannot be combined with `--ref` or `--element`.
- `existing-session` / `user` profiles support page screenshots and `--ref` screenshots from snapshot output, but not CSS `--element` screenshots.
- `--labels` overlays current snapshot refs on the screenshot. On Playwright-backed profiles it works with `--full-page` (full-page overlay), `--ref` (element-clip overlay by ARIA ref), and `--element` (element-clip overlay by CSS selector); in element-clip modes labels are projected relative to the element. The response also includes an `annotations` array (omitted when empty) with each ref's bounding box: `ref`, `number`, `role`, optional `name`, and `box: {x, y, width, height}` in the captured image's coordinate space (viewport / fullpage / element-relative).
  `existing-session` profiles render a chrome-mcp overlay on page screenshots but do not use the Playwright projection helper and do not include `annotations`; CSS `--element` screenshots are unsupported there. Without Playwright or chrome-mcp, labeled screenshots are not available.
- `snapshot --urls` appends discovered link destinations to AI snapshots so agents can choose direct navigation targets instead of guessing from link text alone.

Navigate/click/type (ref-based UI automation):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser click-coords 120 340
openclaw browser type <ref> "hello"
openclaw browser press Enter
openclaw browser hover <ref>
openclaw browser scrollintoview <ref>
openclaw browser drag <startRef> <endRef>
openclaw browser select <ref> OptionA OptionB
openclaw browser fill --fields '[{"ref":"1","value":"Ada"}]'
openclaw browser wait --text "Done"
openclaw browser evaluate --fn '(el) => el.textContent' --ref <ref>
openclaw browser evaluate --fn 'const title = document.title; return title;'
openclaw browser evaluate --timeout-ms 30000 --fn 'async () => { await window.ready; return true; }'
```

`press` accepts named keys and shortcuts such as `Escape`, `Control+Shift+T`, and `Control++`; common `Esc`, `Return`, `Del`, `Ctrl`, and `Cmd` aliases are normalized.

For managed browser profiles, `select` preserves option values exactly. Quote empty or whitespace-sensitive values, such as `openclaw browser select <ref> ""` or `openclaw browser select <ref> " padded "`.

`evaluate --fn` accepts a function source, an expression, or a statement body. Statement bodies are wrapped as async functions, so use `return` for the value you want back. Use `--timeout-ms` when the page-side function may need longer than the default evaluate timeout. `browser.evaluateEnabled=false` (default: `true`) disables both `evaluate` and `wait --fn`.

Action responses return the current raw `targetId` after action-triggered page replacement when OpenClaw can prove the replacement tab. Scripts should still store and pass `suggestedTargetId`/labels for long-lived workflows.

File + dialog helpers:

```bash
openclaw browser upload /tmp/openclaw/uploads/file.pdf --ref <ref>
openclaw browser upload media://inbound/file.pdf --ref <ref>
openclaw browser waitfordownload
openclaw browser download <ref> report.pdf
openclaw browser dialog --accept
openclaw browser dialog --dismiss --dialog-id d1
```

Managed Chrome profiles save ordinary click-triggered downloads into the OpenClaw downloads directory (`/tmp/openclaw/downloads` by default, or the configured temp root). Use `waitfordownload` or `download` when the agent needs to wait for a specific file and return its path; those explicit waiters own the next download. Uploads accept files from the OpenClaw temp uploads root and OpenClaw-managed inbound media, including `media://inbound/<id>` and sandbox-relative `media/inbound/<id>` references. Nested media refs, traversal, and arbitrary local paths are rejected.

If saving a download fails, OpenClaw requests cancellation of the transfer and reports the original save error. Correct the output path or filesystem problem before starting a new download.

When an action opens a modal dialog, the action response returns `blockedByDialog` with `browserState.dialogs.pending`; pass `--dialog-id` to answer it directly. Dialogs handled outside OpenClaw appear under `browserState.dialogs.recent`.

Batch actions:

```bash
openclaw browser batch --actions '[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]'
openclaw browser batch --actions-file plan.json
openclaw browser batch --actions-file - --continue
```

`openclaw browser batch` sends a `kind="batch"` `/act` request with nested `BrowserActRequest` actions (`wait`, `click`, `type`, `evaluate`, ...) — not `open`/`navigate`/`snapshot`/`screenshot`, which are CLI subcommands, not `/act` kinds. `--continue` sets `stopOnError=false` (default stops on first error); `--target-id` scopes the whole batch to one tab. A failed nested action makes the command exit nonzero; use `--json` to retain the ordered `results` response. See [Browser batch CLI](/tools/browser-control#browser-batch-cli) for the full contract (ref lifecycle, target id conflicts, error summary). `batch` is not supported on `profile="user"` / existing-session profiles.

`--actions-file` and `--actions-file -` stdin input are capped at 1,000,000 bytes. Split larger plans into multiple `openclaw browser batch` commands.

## State and storage

Viewport + emulation:

```bash
openclaw browser resize 1280 720
openclaw browser set viewport 1280 720
openclaw browser set offline on
openclaw browser set media dark
openclaw browser set timezone Europe/London
openclaw browser set locale en-GB
openclaw browser set geo 51.5074 -0.1278 --accuracy 25
openclaw browser set device "iPhone 14"
openclaw browser set headers '{"x-test":"1"}'
openclaw browser set credentials myuser mypass
```

Cookies + storage:

```bash
openclaw browser cookies
openclaw browser cookies set session abc123 --url https://example.com
openclaw browser cookies clear
openclaw browser storage local get
openclaw browser storage local set token abc123
openclaw browser storage session clear
```

## Debugging

```bash
openclaw browser console --level error
openclaw browser pdf
openclaw browser responsebody "**/api"
openclaw browser highlight <ref>
openclaw browser errors --clear
openclaw browser requests --filter api
openclaw browser trace start
openclaw browser trace stop --out trace.zip
```

## Existing Chrome via MCP

Use the built-in `user` profile, or create your own `existing-session` profile:

```bash
openclaw browser --browser-profile user tabs
openclaw browser create-profile --name chrome-live --driver existing-session
openclaw browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
openclaw browser create-profile --name chrome-port --driver existing-session --cdp-url http://127.0.0.1:9222
openclaw browser --browser-profile chrome-live tabs
```

The default existing-session path is host-only Chrome MCP auto-connect. If the browser is already running with a DevTools endpoint, pass `--cdp-url` so Chrome MCP attaches to that endpoint instead. For Docker, Browserless, or other remote setups where Chrome MCP semantics are not needed, use a CDP profile instead.

Current existing-session limits:

- Snapshot-driven actions use refs, not CSS selectors.
- Supported `act` requests use a built-in 60000 ms default when callers omit `timeoutMs`; per-call `timeoutMs` still wins.
- `click` is left-click only.
- `type` does not support `slowly=true`.
- `press` does not support `delayMs`.
- `hover`, `scrollintoview`, `drag`, `select`, and `fill` reject per-call timeout overrides; `evaluate` accepts `--timeout-ms`.
- `select` supports one value only.
- `wait --load networkidle` is not supported (works on managed and raw/remote CDP profiles).
- File uploads require `--ref` / `--input-ref` and do not support CSS `--element`. Pass multiple paths when the page's file input accepts multiple files.
- Dialog hooks do not support `--timeout`.
- Screenshots support page captures and `--ref`, but not CSS `--element`.
- `responsebody`, download interception, PDF export, and batch actions still require a managed browser or raw CDP profile.

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway proxies browser actions to that node; no separate browser control server is required.

Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)

## Related

- [CLI reference](/cli)
- [Browser](/tools/browser)
