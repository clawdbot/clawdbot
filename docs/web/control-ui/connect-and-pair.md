---
summary: "Pair browsers and phones with the Gateway and reach the Control UI over Tailscale"
read_when:
  - Connecting a new browser or phone for the first time
  - Reaching the Control UI from outside the Gateway host
  - The dashboard loads blank or reports a protocol mismatch
title: "Connect and pair"
sidebarTitle: "Connect and pair"
---

Reach the Control UI from a new browser, phone, or network, and fix the connection when it fails.

## Device pairing (first connection)

After gateway auth succeeds, connecting from a new browser or device usually requires a **one-time pairing approval**, shown as `disconnected (1008): pairing required`. On the Gateway host, `openclaw dashboard` is the preferred owner path: it opens a short-lived, single-use pairing link and leaves that exact signed browser with a durable administrator credential. Opening a fresh link in the same browser also repairs a previously limited credential; another browser profile cannot inherit or replay the grant.

<Steps>
  <Step title="List pending requests">
    ```bash
    openclaw devices list
    ```
  </Step>
  <Step title="Approve by request ID">
    ```bash
    openclaw devices approve <requestId>
    ```
  </Step>
</Steps>

If the browser retries pairing with changed auth details (role/scopes/public key), the previous pending request is superseded and a new `requestId` is created; re-run `openclaw devices list` before approving.

Switching an already-paired browser from read access to write/admin access through ordinary stored or shared credentials is treated as an approval upgrade, not a silent reconnect: OpenClaw keeps the old approval active, blocks the broader reconnect, and asks you to approve the new scope set explicitly. The narrow exception is a fresh owner handoff issued on the Gateway host by `openclaw dashboard` or graphical onboarding; it can upgrade only the same signed browser that redeems that one-time handoff.

When the connected Control UI reports limited access, open **Inbox > System > Limited access**, then click **Request admin**. On mobile, open the sidebar to reach Inbox. The browser files the pending device scope-upgrade request over its existing connection; approve it with `openclaw devices` on the Gateway host or from **Devices** in another admin-capable browser that also has `operator.pairing`. Keep the requesting tab connected while approval completes so it can receive and store the freshly rotated device token before reconnecting. **Retry** reattaches to the pending request. **Cancel** stops the local wait but does not reject the device request; if you cancel or disconnect before approval, use the normal pairing repair path on the next connection.

Once approved, the device is remembered and won't require re-approval unless you revoke it with `openclaw devices revoke --device <id> --role <role>`. See [Devices CLI](/cli/devices) for token rotation, revocation, and the Paperclip / `openclaw_gateway` first-run approval flow.

If the Gateway denies the upgrade because it exceeds your assigned operator role, the access details show the administrator-change guidance without **Retry**. An administrator must change the role before the request can succeed; device approval cannot override that ceiling. **Retry** remains available for pending, rejected, or expired approval requests and retryable failures. **Cancel** clears the local request state so you can make a new request after the underlying problem is resolved.

<Note>
- Direct local Control UI connections from a loopback TCP peer (`127.0.0.1` or `::1`, typically reached as `localhost`) with no forwarded/proxy headers can auto-approve device pairing only after gateway auth succeeds and the browser presents device identity. In token/password mode, the first connection still needs the configured shared secret; this auto-approval is not a token bypass.
- Direct loopback needs no shared secret only when `gateway.auth.mode: "none"` is explicitly configured. That disables gateway auth and is not the recommended Control UI setup. Tailscale Serve and trusted-proxy modes can avoid a pasted shared secret only when their respective identity checks succeed.
- Tailscale Serve can skip the pairing round trip for Control UI operator sessions when `gateway.auth.allowTailscale: true`, Tailscale identity verifies, and the browser presents its device identity. Device-less browsers and node-role connections still follow the normal device checks.
- Direct Tailnet binds and LAN browser connects still require explicit approval. Browser profiles without device identity cannot use loopback auto-approval.
- Each browser profile generates a unique device ID, so switching browsers or clearing browser data requires re-pairing.
- Private windows and browser profiles that discard site data on exit, including Firefox Never remember history, also discard the stored device identity and per-device token. They will appear as a new browser after each restart; use a persistent browser profile to stay paired, and remove stale entries with `openclaw devices remove <deviceId>` when the paired-device list grows.

</Note>

## Pair a mobile device

An already paired administrator can create the iOS/Android connection QR without opening a terminal:

<Steps>
  <Step title="Open mobile pairing">
    Select **Devices**, then click **Pair device** in the **Devices** card.
  </Step>
  <Step title="Connect the phone">
    In the OpenClaw mobile app, open **Settings** → **Gateway** and scan the QR code. You can copy and paste the setup code instead.
  </Step>
  <Step title="Confirm the connection">
    The official iOS/Android app connects automatically. If **Pending approval** shows a request, review its role and scopes before approving it.
  </Step>
</Steps>

Creating a setup code requires `operator.admin`; the button is disabled for sessions without it. A setup code contains a short-lived bootstrap credential, so treat the QR and copied code like a password while they are valid. For remote pairing, the Gateway must resolve to `wss://` (for example, through Tailscale Serve/Funnel); plain `ws://` is limited to loopback and private LAN addresses. See [Pairing](/channels/pairing#pair-from-the-control-ui-recommended) for the full security and fallback details.

## Runtime config endpoint

The Control UI fetches its runtime settings from `/control-ui-config.json`, resolved relative to the gateway's Control UI base path (for example `/__openclaw__/control-ui-config.json` under base path `/__openclaw__/`). That endpoint is gated by gateway HTTP auth: unauthenticated browsers cannot fetch it, and a successful fetch requires a valid gateway token/password or trusted-proxy identity. Tailscale header auth applies to the Control UI WebSocket, not this HTTP endpoint.

Local and data-URL agent avatars use [authenticated avatar URLs](/web/control-ui/security-model#avatar-route-auth) in this response and in browser identity RPCs, keeping startup JSON small. Native and CLI RPC clients retain their inline avatar representation.

## PWA install and web push

The Control UI ships a `manifest.webmanifest` and a service worker, so modern browsers can install it as a standalone PWA. Web Push lets the Gateway wake the installed PWA with notifications even when the tab or browser window is not open.

Inside the macOS app, the Notifications settings page shows the app's native notification permission instead of browser push because the app delivers notifications natively.

See [Notifications](/web/notifications) for the browser and macOS setup steps.

If the page shows **Protocol mismatch** right after an OpenClaw update, first reopen the dashboard with `openclaw dashboard` and hard-refresh. If it still fails, clear site data for the dashboard origin or test in a private browser window; an old tab or browser service-worker cache can keep running a pre-update Control UI bundle against the newer Gateway.

| Surface                                                                | What it does                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ui/public/manifest.webmanifest`                                       | PWA manifest. Browsers offer "Install app" once it is reachable.            |
| `ui/public/sw.js`                                                      | Service worker that handles `push` events and notification clicks.          |
| `state/openclaw.sqlite` → `config_machine_state` (`webPush.vapidKeys`) | Auto-generated VAPID keypair used to sign Web Push payloads.                |
| `state/openclaw.sqlite` → `web_push_subscriptions`                     | Persisted browser endpoints, keys, device/profile bindings, and timestamps. |

Upgrades from the retired `push/vapid-keys.json` and `push/web-push-subscriptions.json` stores are imported by `openclaw doctor --fix`. Stop the Gateway before running that repair so an older process cannot recreate retired state during import. Run the repair before using Web Push after an upgrade; registration, delivery, deletion, and key resolution refuse to proceed while either retired source or an interrupted Doctor claim remains. The Gateway runtime reads and writes SQLite only.

Override the VAPID keypair through env vars on the Gateway process when you want to pin keys (multi-host deployments, secrets rotation, or tests):

- `OPENCLAW_VAPID_PUBLIC_KEY`
- `OPENCLAW_VAPID_PRIVATE_KEY`
- `OPENCLAW_VAPID_SUBJECT` (defaults to `https://openclaw.ai`)

One service-worker registration scope has one browser push subscription and therefore one application-server key. If one installed PWA switches among multiple logical Gateways, configure the same public/private VAPID pair on every Gateway and set each Gateway's `gateway.publicOrigin`; otherwise registration fails closed with a VAPID-identity mismatch. Sharing the private VAPID key and browser endpoint creates one push-signing trust domain, so do this only among mutually trusted Gateways. PWAs installed from separate HTTPS origins or base-path scopes have separate registrations and do not need to share keys.

The Control UI uses these scope-gated Gateway methods to register and test browser subscriptions:

- `push.web.vapidPublicKey` fetches the active VAPID public key.
- `push.web.subscribe` registers an `endpoint` plus `keys.p256dh`/`keys.auth`; the Gateway binds it to the authenticated browser device and current user profile.
- `push.web.unsubscribe` removes a registered endpoint.
- `push.web.test` sends a test notification to registered browser subscriptions.

Pending exec and plugin approvals also trigger Web Push. Approval delivery is narrower than `push.web.test`: the Gateway targets only bound subscriptions whose paired device, current operator token, profile role, and approval visibility still authorize the request. Legacy unbound subscriptions stay test-only until the Control UI reconnects and reconciles them. Push payloads contain generic text and an authenticated `/approve/<approvalId>` link, not approval details.

<Note>
Web Push is independent of the iOS APNS relay path (see [Configuration](/gateway/configuration) for relay-backed push) and the `push.test` method, which targets native mobile pairing.
</Note>

## Tailnet access (recommended)

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
openclaw gateway --tailscale serve
```

Open `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`).

By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers (`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw verifies the identity by resolving the `x-forwarded-for` address with `tailscale whois` and matching it to the header, and only accepts these on its dedicated managed-Tailscale listener with Tailscale's `x-forwarded-*` headers. For Control UI operator sessions with browser device identity, this verified Serve path also skips the device-pairing round trip; device-less browsers and node-role connections still follow the normal device checks. Set `gateway.auth.allowTailscale: false` if you want to require explicit shared-secret credentials even for Serve traffic, then use `gateway.auth.mode: "token"` or `"password"`.

For that async Serve identity path, failed auth attempts for the same client IP and auth scope are serialized before rate-limit writes. Concurrent bad retries from the same browser can therefore show `retry later` on the second request instead of two plain mismatches racing in parallel.

<Warning>
Tokenless Serve auth assumes the gateway host is trusted. If untrusted local code may run on that host, require token/password auth.
</Warning>

## Insecure HTTP

Opening the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`) works: device identity is generated and signed with pure-JS Ed25519, so pairing does not depend on WebCrypto or a secure context. The signing key never leaves the browser, which makes it the one credential a plaintext transport cannot leak — unlike the shared token, which any on-path observer of an HTTP connection can read.

Plain HTTP remains a downgraded transport: an active attacker on the path can modify the page and capture anything in it. Prefer HTTPS wherever possible — Tailscale Serve gives you a real certificate with no configuration — and treat HTTP as a LAN-only convenience. Browsers also withhold secure-context features (for example passkeys) on HTTP, and Chrome's Local Network Access rules increasingly restrict plaintext local requests.

The supported device-less exception is successful operator Control UI auth
through `gateway.auth.mode: "trusted-proxy"`. There is no persistent config
switch that disables device identity.

**Recommended setup:** HTTPS via `https://<magicdns>/` (Tailscale Serve) or the UI locally at `http://127.0.0.1:18789/` (on the gateway host).

<AccordionGroup>
  <Accordion title="Trusted-proxy note">
    - Successful trusted-proxy auth can admit **operator** Control UI sessions without device identity.
    - This does **not** extend to node-role Control UI sessions.
    - A same-host loopback reverse proxy requires both loopback in `gateway.trustedProxies` and `gateway.auth.trustedProxy.allowLoopback: true`; see [Trusted proxy auth](/gateway/trusted-proxy-auth).

  </Accordion>
</AccordionGroup>

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Blank Control UI page

If the browser loads a blank dashboard and DevTools shows no useful error, an extension or early content script may have prevented the JavaScript module app from evaluating. The static page includes a plain HTML recovery panel that appears when `<openclaw-app>` does not complete its first render after startup.

Use the panel's **Try again** action after changing the browser environment, or reload manually after these checks:

- Disable extensions that inject into all pages, especially extensions with `<all_urls>` content scripts.
- Try a private window, a clean browser profile, or another browser.
- Keep the Gateway running and verify the same dashboard URL after the browser change.
