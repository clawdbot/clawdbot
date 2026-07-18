---
summary: "Chrome extension: let OpenClaw drive your signed-in Chrome with no remote-debugging prompt"
read_when:
  - You want an agent to drive your real signed-in Chrome from your phone
  - You keep hitting the Chrome "Allow remote debugging?" prompt with nobody at the desk
  - You want to understand the security model of browser takeover via the extension
title: "Chrome Extension"
---

# Chrome extension

The OpenClaw Chrome extension lets an agent control your **signed-in Chrome
tabs** without launching a separate managed browser, and **without** Chrome's
blocking "Allow remote debugging?" prompt.

This matters when you drive OpenClaw from a phone (Telegram, WhatsApp, etc.):
the [`user` profile](/tools/browser#profiles-openclaw-user-chrome) attaches over
Chrome's remote-debugging port, which pops a desktop consent dialog nobody can
click when you are away. The extension uses the `chrome.debugger` API instead,
so the only in-page hint is Chrome's dismissible "OpenClaw started debugging
this browser" banner.

This is the same shape used by Anthropic's Claude in Chrome and OpenAI's Codex
Chrome extensions.

## How it works

Three parts:

- **Browser control service** (Gateway or node host): the API the `browser`
  tool calls.
- **Extension relay** (loopback WebSocket): a small server the control service
  starts on `127.0.0.1`. It presents a Chrome DevTools Protocol endpoint to
  OpenClaw and speaks to the extension. Both sides authenticate with a
  host-local token (see below).
- **OpenClaw Chrome extension** (MV3): attaches to tabs with `chrome.debugger`,
  forwards CDP traffic, and manages the **OpenClaw tab group**.

OpenClaw only sees and controls tabs that are in the **OpenClaw tab group**. The
group is the consent boundary: drag a tab in to share it, drag it out (or click
the toolbar button) to revoke access instantly.

## Install and pair

1. Print the unpacked extension path:

   ```bash
   openclaw browser extension path
   ```

2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select the printed directory.

3. Print the pairing string:

   ```bash
   openclaw browser extension pair
   ```

4. Click the OpenClaw toolbar icon and paste the pairing string into the popup.
   The badge turns **ON** when the extension connects to the relay.

The pairing token is a **host-local secret** created on first use and stored
under `credentials/` in the state directory (mode `0600`). Each machine that
runs a browser — the Gateway host and every browser node host — owns its own
token, so no credential has to travel between machines. To rotate it, delete the
`browser-extension-relay.secret` file and pair again.

## Use it

Select the built-in `chrome` profile in a `browser` tool call, or make it the
default:

```bash
openclaw config set browser.defaultProfile chrome
```

```json5
{
  browser: {
    profiles: {
      chrome: { driver: "extension", color: "#FF4500" },
    },
  },
}
```

- Share a tab: click the OpenClaw toolbar button on that tab (it joins the
  OpenClaw tab group), or drag any tab into the group.
- The agent can also open new tabs; those land in the group automatically.
- Revoke: click the button again, drag the tab out of the group, or dismiss
  Chrome's debugging banner. The agent loses access to that tab immediately.

### Tab copilot side panel

After pairing the extension, click **Open tab copilot** in its toolbar popup.
OpenClaw configures `sidepanel.html` for that exact Chrome tab; the manifest has
no global side-panel path. Each tab therefore gets a separate panel document,
Gateway session, message subscription, and typed browser-tool binding.

The panel does not place the page URL, title, DOM, or visible text in your
message. It sends only the text you type. Browser actions carry a separate
Gateway-authenticated binding containing the Chrome tab and CDP target, and the
browser tool rejects attempts to replace that target or use browser-wide
actions. Replies stay in the panel (`deliver: false`); they do not inherit a
Telegram, Discord, or other channel route.

The copilot is a dedicated paired Gateway device with `operator.read` and
`operator.write` scopes. On first use, inspect and approve its request:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

The extension retains that device identity and the Gateway-issued device token,
scoped to the canonical Gateway endpoint that issued them. Pairing a different
Gateway creates separate identity, token, and session custody; credentials and
sessions are never reused across endpoints. The extension does not persist the
Gateway shared secret. A panel can subscribe only to its own tab sessions, and
the Gateway filters those events before delivery.

If the Gateway connection drops during a run, the extension keeps durable
custody of that run ID. On reconnect it aborts the unresolved run before
re-enabling any panel, then reloads transcript history. This fail-closed step
prevents browser actions from continuing unseen across a delivery gap.

Closing a tab immediately removes its live subscription, aborts any visible
run, and marks that tab's session archived. If the Gateway is temporarily
offline, the extension persists the pending archive and retries only when that
same Gateway endpoint reconnects; it never sends an archive request to a
different Gateway. After a browser crash, the next launch archives sessions
left by the previous browser instance. Archived sessions reject new work, while
their transcripts remain available in session history. Browser-copilot keys are
thread sessions, so normal age and entry-count maintenance preserves them. The
per-agent session disk budget still applies (default `2gb`) and may evict the
oldest sessions under pressure; see [session maintenance](/reference/session-management-compaction#store-maintenance-and-disk-controls).

The side panel currently requires either a Gateway-hosted extension relay or a
direct remote Gateway relay. A loopback relay on a browser node cannot yet
provide the node route required by the typed tab binding, so the panel denies
that topology instead of falling back to browser-wide routing.

## Remote / cross-machine

Chrome does not have to run on the Gateway host. Three topologies work:

- **Same host** (Gateway + Chrome on one machine): pair on that machine with
  `openclaw browser extension pair`. The relay is loopback-only.
  If the local Gateway uses TLS, pass its certificate hostname explicitly with
  `--gateway-url wss://gateway-host.example`; pairing never substitutes a loopback IP.
- **Direct to a remote Gateway** (Chrome on your laptop, Gateway on a VPS, and
  **nothing else on the laptop**): on the Gateway, run
  `openclaw browser extension pair --gateway-url wss://your-gateway.example.com`.
  It prints a `wss://…/browser/extension#<secret>` string; load and pair the
  extension on the laptop. The extension connects **straight to the Gateway**
  over `wss://` — no OpenClaw install, Node, CLI, or open inbound port on the
  laptop. This is the managed-hosting path.
- **Via a browser node host** (Chrome on a machine already running an OpenClaw
  node): run `pair` on the node and pair locally; the Gateway proxies browser
  actions to the node over its existing authenticated node link.

The pairing secret is per host (the Gateway's, in the direct case), validated by
the Gateway's `/browser/extension` route. For the direct path, serve the Gateway
over TLS (`wss://`) so the pairing secret and CDP traffic are encrypted.
The secret remains in the pairing string's URL fragment and is presented during
the WebSocket handshake as a subprotocol credential, so normal proxy access
logs do not receive it in the request URL. Ensure any reverse proxy preserves
the standard `Sec-WebSocket-Protocol` header.

## Diagnostics

```bash
openclaw browser status --browser-profile chrome
openclaw browser doctor --browser-profile chrome
```

`doctor` reports the **Chrome extension relay** check as failing until the
extension popup shows **Connected**.

## Security model

- The relay binds loopback only; both WebSocket sides are authenticated with the
  derived token, and the extension side is origin-checked to `chrome-extension://`.
- Direct Gateway pairing does not accept the relay token in the request URL;
  the bundled extension carries it in the WebSocket subprotocol list instead.
- The agent can only see and drive tabs in the **OpenClaw tab group**. Your
  other tabs stay private.
- Side-panel runs are scoped twice: Gateway delivery uses a per-session
  allowlist, and browser tools enforce the Chrome tab/target binding carried
  outside the prompt.
- Compared with the `user` (Chrome MCP) profile, which exposes your whole
  signed-in browser once you approve the remote-debugging prompt, the extension
  keeps the shared surface scoped to a tab group you control at a glance.

See also: [Browser](/tools/browser) for the full profile model and the
managed `openclaw` and Chrome MCP `user` profiles.
