---
summary: "Chrome extension: let Clawdbot drive your existing Chrome tab"
read_when:
  - You want the agent to drive an existing Chrome tab (toolbar button)
  - You need remote Gateway + local browser automation via Tailscale
  - You want to understand the security implications of browser takeover
---

# Chrome extension (browser relay)

The Clawdbot Chrome extension lets the agent control your **existing Chrome tabs** (your normal Chrome window) instead of launching a separate clawd-managed Chrome profile.

Attach/detach happens via a **single Chrome toolbar button**.

## What it is (concept)

There are three parts:
- **Browser control server** (HTTP): the API the agent/tool calls (`browser.controlUrl`)
- **Local relay server** (loopback CDP): bridges between the control server and the extension (`http://127.0.0.1:18792` by default)
- **Chrome MV3 extension**: attaches to the active tab using `chrome.debugger` and pipes CDP messages to the relay

Clawdbot then controls the attached tab through the normal `browser` tool surface (selecting the right profile).

## Install / load (unpacked)

1) Install the extension to a stable local path:

```bash
clawdbot browser extension install
```

2) Print the installed extension directory path:

```bash
clawdbot browser extension path
```

3) Chrome → `chrome://extensions`
- Enable “Developer mode”
- “Load unpacked” → select the directory printed above

4) Pin the extension.

## Updates (no build step)

The extension ships inside the Clawdbot release (npm package) as static files. There is no separate “build” step.

After upgrading Clawdbot:
- Re-run `clawdbot browser extension install` to refresh the installed files under your Clawdbot state directory.
- Chrome → `chrome://extensions` → click “Reload” on the extension.

## Use it (no extra config)

Clawdbot ships with a built-in browser profile named `chrome` that targets the extension relay on the default port.

Use it:
- CLI: `clawdbot browser --browser-profile chrome tabs`
- Agent tool: `browser` with `profile="chrome"`

If you want a different name or a different relay port, create your own profile:

```bash
clawdbot browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Attach / detach (toolbar button)

- Open the tab you want Clawdbot to control.
- Click the extension icon.
  - Badge shows `ON` when attached.
- Click again to detach.

## Which tab does it control?

- It does **not** automatically control “whatever tab you’re looking at”.
- It controls **only the tab(s) you explicitly attached** by clicking the toolbar button.
- To switch: open the other tab and click the extension icon there.

## Badge + common errors

- `ON`: attached; Clawdbot can drive that tab.
- `…`: connecting to the local relay.
- `!`: relay not reachable (most common: browser relay server isn’t running on this machine).

If you see `!`:
- Make sure the Gateway is running locally (default setup), or run `clawdbot browser serve` on this machine (remote gateway setup).
- Open the extension Options page; it shows whether the relay is reachable.

## Do I need `clawdbot browser serve`?

### Local Gateway (same machine as Chrome) — usually **no**

If the Gateway is running on the same machine as Chrome and your `browser.controlUrl` is loopback (default),
you typically **do not** need `clawdbot browser serve`.

The Gateway’s built-in browser control server will start on `http://127.0.0.1:18791/` and Clawdbot will
auto-start the local relay server on `http://127.0.0.1:18792/`.

### Remote Gateway (Gateway runs elsewhere) — **yes**

If your Gateway runs on another machine, run `clawdbot browser serve` on the machine that runs Chrome
(and publish it via Tailscale Serve / TLS). See the section below.

## Sandboxing (tool containers)

If your agent session is sandboxed (`agents.defaults.sandbox.mode != "off"`), the `browser` tool can be restricted:

- By default, sandboxed sessions often target the **sandbox browser** (`target="sandbox"`), not your host Chrome.
- Chrome extension relay takeover requires controlling the **host** browser control server.

Options:
- Easiest: use the extension from a **non-sandboxed** session/agent.
- Or allow host browser control for sandboxed sessions:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true
        }
      }
    }
  }
}
```

Then ensure the tool isn’t denied by tool policy, and (if needed) call `browser` with `target="host"`.

Debugging: `clawdbot sandbox explain`

## Remote Gateway (recommended: Tailscale Serve)

Goal: Gateway runs on one machine, but Chrome runs somewhere else.

On the **browser machine**:

```bash
clawdbot browser serve --bind 127.0.0.1 --port 18791 --token <token>
tailscale serve https / http://127.0.0.1:18791
```

On the **Gateway machine**:
- Set `browser.controlUrl` to the HTTPS Serve URL (MagicDNS/ts.net).
- Provide the token (prefer env):

```bash
export CLAWDBOT_BROWSER_CONTROL_TOKEN="<token>"
```

Then the agent can drive the browser by calling the remote `browser.controlUrl` API, while the extension + relay stay local on the browser machine.

## How “extension path” works

`clawdbot browser extension path` prints the **installed** on-disk directory containing the extension files.

The CLI intentionally does **not** print a `node_modules` path. Always run `clawdbot browser extension install` first to copy the extension to a stable location under your Clawdbot state directory.

If you move or delete that install directory, Chrome will mark the extension as broken until you reload it from a valid path.

## Security implications (read this)

This is powerful and risky. Treat it like giving the model “hands on your browser”.

- The extension uses Chrome’s debugger API (`chrome.debugger`). When attached, the model can:
  - click/type/navigate in that tab
  - read page content
  - access whatever the tab’s logged-in session can access
- **This is not isolated** like the dedicated clawd-managed profile.
  - If you attach to your daily-driver profile/tab, you’re granting access to that account state.

Recommendations:
- Prefer a dedicated Chrome profile (separate from your personal browsing) for extension relay usage.
- Keep the browser control server tailnet-only (Tailscale) and require a token.
- Avoid exposing browser control over LAN (`0.0.0.0`) and avoid Funnel (public).

Related:
- Browser tool overview: [Browser](/tools/browser)
- Security audit: [Security](/gateway/security)
- Tailscale setup: [Tailscale](/gateway/tailscale)
