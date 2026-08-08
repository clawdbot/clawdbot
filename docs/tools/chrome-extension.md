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
- **Extension relay**: a small server the control service exposes on loopback
  for same-host and browser-node setups, or through the Gateway's relay-authenticated
  WebSocket route for direct remote setups. It presents a Chrome DevTools
  Protocol endpoint to OpenClaw and speaks to the extension.
- **OpenClaw Chrome extension** (MV3): attaches to tabs with `chrome.debugger`,
  forwards CDP traffic, and manages the **OpenClaw tab group**.

OpenClaw only sees and controls tabs that are in the **OpenClaw tab group**. The
group is the consent boundary: the relay advertises only grouped tabs, and the
extension rechecks current group membership before every authority-bearing
command for an existing tab. Drag a tab in to share it; drag it out (or click
the toolbar button) to revoke access instantly, even if a relay client still
has stale tab state.

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

The pairing key is a **per-host secret** created on first use and stored
under `credentials/` in the state directory (mode `0600`). Each machine that
runs a browser — the Gateway host and every browser node host — owns its own
key, so no credential has to travel between machines. To rotate it, delete the
`browser-extension-relay.secret` file and pair again.

The key stays in the pairing string fragment rather than the WebSocket URL sent
to the server. Browser Relay Authentication v2 uses it only as an HMAC key: the
extension first verifies the relay's signed, connection-bound challenge, then
sends a one-time proof. The key is never sent in a URL, header, WebSocket
subprotocol, or application frame. Still treat the complete pairing string as a
password.

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

### Authenticated external CDP clients

The relay supports Browser Relay Authentication v2 clients such as mcporter.
They use the same paired Chrome and the same tab-group consent boundary,
without Chrome's "Allow remote debugging?" prompt. Print the non-secret v2
endpoint metadata:

```bash
openclaw browser extension cdp
```

`openclaw browser extension cdp --json` emits the loopback endpoint, protocol
version, key ID, and fixed challenge/complete resource metadata. It never emits
the relay key or an authorization header. A v2 client must keep one raw
loopback TCP connection from challenge through `/json/version` and the `/cdp`
WebSocket upgrade; redirects, reconnects, and a second upstream socket are not
valid relay authentication.

During the migration window, an old external client can request the legacy
Bearer header explicitly:

```bash
openclaw browser extension cdp --legacy-bearer
```

This command warns because it reveals the relay key in a credential header. It
works only while `browser.extensionRelay.allowLegacyAuth` is `true`; when legacy
auth is disabled, the command fails without printing a credential.

[mcporter](https://github.com/openclaw/mcporter) is the supported external CDP
adapter. Use a release that supports Browser Relay Authentication v2; the
OpenClaw-side upgrade does not update mcporter. When a paired relay answers on
this host, a compatible mcporter release transparently rewrites
`chrome-devtools-mcp --autoConnect` server commands to the relay endpoint, so
agents calling Chrome DevTools through mcporter skip the remote-debugging
prompt automatically (set `MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY=1` there to
opt out).

## Migrate relay authentication

New OpenClaw extensions use Browser Relay Authentication v2 and never retry
legacy authentication after a bad proof, timeout, unsupported response, or
connection failure.

- Existing valid pairing strings migrate locally to `authVersion: 2`; you do
  not need to pair again for the protocol upgrade.
- Stored direct-Gateway pairings behind a path-prefix proxy are cleared during
  migration. Re-run `openclaw browser extension pair` with a Gateway URL that
  has no path prefix; v2 supports the exact `/browser/extension` route only.
- Upgrade OpenClaw before upgrading the extension. A v2 extension reports an
  old server as needing an upgrade instead of sending the old token.
- Old extensions and external CDP clients continue to work for one migration
  window while `browser.extensionRelay.allowLegacyAuth` keeps its default value
  of `true`.
- After every extension and external CDP client uses v2, set
  `browser.extensionRelay.allowLegacyAuth` to `false` and restart the Gateway or
  browser node host.
- Rotating `credentials/browser-extension-relay.secret` changes the key ID,
  closes authenticated relay sessions, clears pending and replay state, and
  requires extension re-pairing.

V2 external CDP access requires a client that implements the same-socket HTTP
challenge, completion, discovery, and WebSocket-upgrade sequence. Generic
Puppeteer or chrome-devtools-mcp clients do not implement that sequence by
themselves; use a v2-capable adapter, or the explicitly warned legacy escape
hatch only during the migration window.

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
per-agent session disk budget still applies (default `10gb`) and may evict the
oldest sessions under pressure; see [session maintenance](/reference/session-management-compaction#store-maintenance-and-disk-controls).

The side panel currently requires either a Gateway-hosted extension relay or a
direct remote Gateway relay. A loopback relay on a browser node cannot yet
provide the node route required by the typed tab binding, so the panel denies
that topology instead of falling back to browser-wide routing.

## Send a page to OpenClaw

Use **Send page to OpenClaw** in the toolbar popup to share readable page text
with your main OpenClaw session. You can add an optional note, use the page or
selection right-click menu, or press `Alt+Shift+S`. OpenClaw prefers your current
selection when one exists, enqueues the share as a system event, and wakes the
main session immediately.

The tab does not need to be in the OpenClaw tab group. This is a one-shot,
explicit share: nothing else on the page is exposed, and it grants no ongoing
access. Google Docs are exported as plain text with your signed-in browser
session, without Google API setup. X and Twitter threads are extracted without
the surrounding interface chrome.

Page text is wrapped in OpenClaw's external-content safety boundary. Your
optional note stays outside that boundary as your own instruction. Page text
and selections are capped at about 120,000 characters and include a truncation
marker when shortened.

Page sharing works when the extension relay is hosted by the Gateway, using
same-host pairing or direct `wss://` Gateway pairing. Node-hosted relays return
a clear error for now. To remap the keyboard shortcut, open
`chrome://extensions/shortcuts`.

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
  laptop. This is the managed-hosting path. The Gateway URL must expose
  `/browser/extension` without a path-rewriting proxy prefix because v2 binds
  the exact request path into every proof.
- **Via a browser node host** (Chrome on a machine already running an OpenClaw
  node): run `pair` on the node and pair locally; the Gateway proxies browser
  actions to the node over its existing authenticated node link.

The pairing secret is per host (the Gateway's, in the direct case), validated by
the Gateway's `/browser/extension` route. For the direct path, serve the Gateway
over TLS (`wss://`) so the proof exchange and CDP traffic are encrypted. The
secret remains in the pairing string's URL fragment and is never presented to
the server. The extension offers only the non-secret
`openclaw-extension-relay.v2` WebSocket subprotocol. Ensure any reverse proxy
preserves the standard `Sec-WebSocket-Protocol` header.

## Diagnostics

```bash
openclaw browser status --browser-profile chrome
openclaw browser doctor --browser-profile chrome
```

`doctor` reports the **Chrome extension relay** check as failing until the
extension popup shows **Connected**. `openclaw doctor` also warns while legacy
relay authentication remains enabled and tells you when to set
`browser.extensionRelay.allowLegacyAuth=false`.

## Security model

- Same-host and browser-node relays bind loopback; direct remote pairing uses
  the Gateway's `wss://` route. Both use connection-bound HMAC proofs derived
  from the per-host key, and the extension side is origin-checked to
  `chrome-extension://`.
- Before verifying the relay's server proof, the client sends only the
  non-secret key ID and a fresh nonce; it never sends an HMAC proof. Client
  proofs are short-lived, one-time, and bound to the exact socket, protocol
  version, role, transport, method, resource, flow, profile, and relay instance.
- In v2, the per-host key is never transmitted. Failed proof validation does
  not fall back to legacy Bearer, Basic, or token-subprotocol auth.
- The relay exposes only tabs in the **OpenClaw tab group**, and the extension
  independently rechecks group membership before each authority-bearing
  existing-tab command. Your other tabs stay private.
- Side-panel runs are scoped twice: Gateway delivery uses a per-session
  allowlist, and browser tools enforce the Chrome tab/target binding carried
  outside the prompt.
- Compared with the `user` (Chrome MCP) profile, which exposes your whole
  signed-in browser once you approve the remote-debugging prompt, the extension
  keeps the shared surface scoped to a tab group you control at a glance.

See also: [Browser](/tools/browser) for the full profile model and the
managed `openclaw` and Chrome MCP `user` profiles.
