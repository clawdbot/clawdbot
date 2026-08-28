---
summary: "Enable and test browser or macOS notifications from the Control UI"
title: "Notifications"
read_when:
  - Enabling notifications from Settings
  - Troubleshooting browser or macOS notification permission
  - Comparing Control UI notifications with mobile push
---

OpenClaw can ping you when something needs your attention — including an exec or plugin approval request — in the browser that runs the Control UI, or through native macOS notifications when you use the OpenClaw macOS app. Your first chat send may request permission automatically; **Settings → Notifications** remains the place to enable or repair the current device, check its status, and send yourself a test.

This page covers those two surfaces. It does not control channel reaction notifications, Android notification forwarding, or iOS background push — the mobile apps register for push through their own node paths; see [iOS](/platforms/ios) and [Nodes](/nodes).

## Which surface you get

What the Notifications page controls depends on where you opened it:

| Where Settings is open                            | Transport                                          | What you can do                                                                |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Supported web browser or installed Control UI PWA | Browser Push API via the Control UI service worker | Receive approval requests, manage this browser's subscription, and send a test |
| OpenClaw macOS app                                | Native macOS notifications                         | Grant app permission, jump to System Settings when blocked, send a local test  |
| Browser without Push API support                  | None                                               | Status only; enable and test stay unavailable                                  |

The macOS app deliberately uses the native permission flow instead of browser push — that is the notification system your Mac already respects.

## Enable browser notifications

The Control UI asks for notification permission automatically the first time you send a chat message, once per browser and origin. **Settings → Notifications** remains the manual path for enabling or repairing notifications, including after you deny the automatic prompt.

1. Open the Control UI in a browser that supports service workers, `PushManager`, and notifications.
2. Make sure the Control UI is connected to the Gateway.
3. Open **Settings → Notifications** and select **Enable notifications**.
4. Allow notifications when the browser asks.
5. Select **Send test** — a test notification should arrive within a few seconds.

Behind the scenes, enabling creates a push subscription in this browser and registers its endpoint and keys with the Gateway. The Gateway binds the subscription to the browser's paired device and, when operator roles are enabled, its authenticated user profile. The Gateway keeps browser subscriptions and its VAPID signing key in `state/openclaw.sqlite` — there is no `openclaw.json` key to edit. When the Control UI reconnects, existing subscriptions are reconciled with the Gateway automatically.

Approval notifications use generic lock-screen text; command, working-directory, prompt, and plugin details stay out of the push payload. Selecting the notification opens the authenticated `/approve/<approvalId>` page. Before each send, the Gateway rechecks the paired device's current approval scopes, operator role, user profile, and approval visibility. A revoked or downgraded browser stops receiving approval pushes without needing to unsubscribe first.

### Choose what reaches each device

After subscribing, **Settings → Notifications** exposes two preference layers:

- **Account defaults** follow a durable authenticated user profile across devices. They control approval requests and updates, agent completion, agent questions, scheduled-task failures, background-task failures, lock-screen detail, quiet hours, timezone, and an optional agent allowlist.
- **This browser or app** can mute one browser profile or installed Home Screen app, add a source label, or override individual categories without changing the account defaults. Native OpenClaw app notifications are configured separately.

Owner-style Gateways without a durable user profile keep the same controls, but store them only with the current browser subscription. Preferences never grant access: every delivery still rechecks the paired device, current role and scopes, authenticated profile, and session visibility. Multi-user events without an authoritative session owner are suppressed instead of being broadcast to every operator.

The default preserves the original behavior: approval request and resolution notifications are enabled, while newly added attention categories are opt-in. Quiet hours suppress matching sends rather than queueing stale alerts for later delivery.

The detail levels are:

- **Private** — generic attention text only.
- **Names only** — may include a sanitized device, agent, task, or automation label.
- **Detailed** — currently uses the same bounded, sanitized producer-owned labels; raw prompts, command arguments, output, environment values, and errors never enter the push payload.

On iPhone and iPad, Web Push is available only after installing the Control UI with **Share → Add to Home Screen** and opening that installed app. A normal Safari tab remains usable for the Control UI, but the Notifications page reports the install requirement and does not attempt to dereference an unavailable `PushManager`.

**Send test** asks the Gateway to push a test message to every registered browser subscription. Tests intentionally verify transport only; approval requests are targeted to authorized device bindings. **Unsubscribe** removes the current browser's endpoint from the Gateway, then unsubscribes locally.

The Gateway sends Web Push directly to the browser vendor's push service. This works with a self-hosted Gateway and does not use the OpenClaw-hosted iOS relay.

### Use more than one Gateway on one phone

The recommended self-hosted setup is one Control UI service-worker scope per Gateway. Open or install each Gateway's PWA from its own HTTPS origin or base path, enable notifications there, and reconnect once after upgrades. Each scope then owns an independent browser subscription, and approval links return to the Gateway that created them.

A single installed PWA can also switch among remote Gateways, but every Gateway behind that PWA must use the same VAPID keypair and set `gateway.publicOrigin` to its browser-reachable HTTPS origin. Reconnect the PWA to each Gateway once so each one registers the shared browser subscription and current device/profile binding. Approval notification links stay inside the installed PWA's scope and carry the owning Gateway URL in their fragment; the Control UI removes the fragment before authentication and uses the normal remote-Gateway handoff.

The browser Push API permits only one application-server key per service-worker registration. If a PWA subscription belongs to a different VAPID key, OpenClaw removes the unusable row from the current Gateway and shows an actionable error instead of silently registering a subscription that cannot receive its pushes. **Unsubscribe** remains available to reset that PWA scope. Unsubscribing deactivates the shared browser subscription for every Gateway registered through that scope; after re-enabling, reconnect to each Gateway once.

Sharing a private VAPID key and browser endpoint makes those Gateways one push-signing trust domain. Use that layout only for Gateways you trust equally. Configure VAPID values through each Gateway process's secure environment or secret manager; do not place private keys in URLs or command arguments.

## Enable notifications in the macOS app

The macOS app also asks automatically on your first chat send, but only while permission is **Not requested**. It never opens System Settings automatically after a denial; use **Settings → Notifications** to manage permission manually.

1. Open **Settings → Notifications** in the OpenClaw macOS app.
2. Select **Enable notifications** while the permission shows **Not requested**.
3. Approve the macOS permission prompt.
4. Select **Send test** to post a local OpenClaw notification.

If the permission shows **Denied**, macOS will not re-prompt: select **Open System Settings**, allow notifications for OpenClaw there, and switch back — the page rechecks permission when the app regains focus. This permission belongs to macOS, not to Gateway config.

## Troubleshooting

### Enable is unavailable

Either the browser lacks the required Web Push APIs or the Control UI is not connected to the Gateway. Try a current browser, confirm the Gateway connection, and reload the page.

### Browser permission is blocked

A denied browser permission cannot be reopened from the page. Allow notifications for the Control UI origin in the browser's site settings, then reload Settings.

### Service worker is not ready

The Control UI waits up to 10 seconds for its service worker. If that times out right after an update, hard-refresh the page. If an old worker sticks around, clear site data for the dashboard origin and reconnect.

### Web Push asks for a Doctor migration

Run `openclaw doctor --fix` with the Gateway stopped. Web Push refuses to use the retired JSON stores until Doctor imports them into SQLite.

### Tests arrive but approval requests do not

Reconnect or reload the Control UI once so an older subscription is bound to the current paired device. The device must still have `operator.approvals` and `operator.read`; when Gateway roles are enabled, the current user profile's role must allow those scopes too. Approval visibility and session-sharing rules can intentionally exclude a request that the same Gateway sends to another operator.

For a single PWA that switches among Gateways, also verify that every Gateway uses the same VAPID keypair and has a browser-reachable `gateway.publicOrigin`. Separate PWA origins or base-path scopes do not need to share VAPID keys.

## Related

- [Control UI PWA and Web Push](/web/control-ui#pwa-install-and-web-push)
- [iOS push delivery](/platforms/ios)
- [Node notification commands](/nodes)
