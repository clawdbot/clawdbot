---
summary: "Enable and test browser or native desktop notifications from the Control UI"
title: "Notifications"
read_when:
  - Enabling notifications from Settings
  - Troubleshooting browser or native desktop notification permission
  - Comparing Control UI notifications with mobile push
---

OpenClaw can notify you about exec or plugin approval requests, agent completion, agent questions, and task failures. The Gateway decides which events each authorized device may receive, applies your notification preferences, and prepares the notification text and destination. Browsers use Web Push; the native macOS and Tauri desktop apps use the operating system notification service.

**Settings → Notifications** is the place to enable the current device, change preferences, check permission, and send a test. Approval requests are enabled in the default preferences; the other categories are opt-in. Delivery still requires browser registration or an authorized, connected native app.

This page does not control channel reaction notifications, node `system.notify`, Android notification forwarding, pairing notices, or iOS background push. The mobile apps register for push through their own node paths; see [iOS](/platforms/ios) and [Nodes](/nodes). The native exec approval dialog also remains separate.

## Which surface you get

What the Notifications page controls depends on where you opened it:

| Where Settings is open                            | Transport                                               | Delivery lifetime                                                                    |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Supported web browser or installed Control UI PWA | Browser Push API via the Control UI service worker      | Can receive pushes without an open dashboard, subject to browser and OS restrictions |
| OpenClaw macOS app                                | Gateway connection to macOS UserNotifications           | While the app is running and connected; the dashboard need not be open               |
| OpenClaw Tauri desktop app                        | Gateway connection to the platform notification backend | While the app is running and connected; the dashboard need not be open               |
| Browser without Push API support                  | None                                                    | Status only; enable and test stay unavailable                                        |

Inside a native app, Settings uses the native bridge exclusively. An outdated app or Gateway shows update guidance; it does not silently switch to Web Push. Native subscriptions belong to the exact authenticated Gateway connection and are cleared when that connection or its identity changes.

## Enable browser notifications

The Control UI asks for notification permission automatically the first time you send a chat message, once per browser and origin. **Settings → Notifications** remains the manual path for enabling or repairing notifications, including after you deny the automatic prompt.

1. Open the Control UI in a browser that supports service workers, `PushManager`, and notifications.
2. Make sure the Control UI is connected to the Gateway.
3. Open **Settings → Notifications** and select **Enable notifications**.
4. Allow notifications when the browser asks.
5. Select **Send test**, then check the browser or operating system notification center.

Behind the scenes, enabling creates a push subscription in this browser and registers its endpoint and keys with the Gateway. The Gateway binds the subscription to the browser's paired device and, when operator roles are enabled, its authenticated user profile. The Gateway keeps browser subscriptions and its VAPID signing key in `state/openclaw.sqlite` — there is no `openclaw.json` key to edit. When the Control UI reconnects, existing subscriptions are reconciled with the Gateway automatically.

Approval notifications use generic lock-screen text by default; command, working-directory, prompt, and plugin details stay out of the push payload. Selecting the notification opens the authenticated `/approve/<approvalId>` page. Before each send, the Gateway rechecks the paired device's current approval scopes, operator role, user profile, and approval visibility. A revoked or downgraded browser stops receiving approval pushes without needing to unsubscribe first.

### Choose what reaches each device

After subscribing, **Settings → Notifications** exposes two preference layers:

- **Account defaults** follow a durable authenticated user profile across browser and native devices. They control approval requests, agent completion, agent questions, scheduled-task failures, background-task failures, lock-screen detail, quiet hours, timezone, and an optional agent allowlist.
- **This browser or app** can disable one device, add a source label, or override individual preferences without changing the account defaults. Native app overrides remain separate from a browser subscription on the same computer.

With a durable authenticated user profile, account defaults and device overrides are saved in the Gateway's existing preference store. Without that profile, browser overrides belong to the current browser subscription; native overrides last only for **this connection** and reset when the app reconnects. Settings reports whether it can save account defaults and whether native device changes are temporary.

Preferences never grant access: every delivery still rechecks the paired device, current role and scopes, authenticated profile, and session visibility. Multi-user events without an authoritative session owner are suppressed instead of being broadcast to every operator. Quiet hours suppress matching alerts rather than queueing them for later delivery. Approval terminal updates still replace the existing browser alert without re-alerting; native apps remove the corresponding notification. This cleanup continues when new alerts are disabled or quiet.

The detail levels are:

- **Private** — generic attention text only.
- **Names only** — may include a sanitized device, agent, task, or automation label.
- **Detailed** — currently uses the same bounded, sanitized producer-owned labels; raw prompts, command arguments, output, environment values, and errors never enter the push payload.

On iPhone and iPad, Web Push is available only after installing the Control UI with **Share → Add to Home Screen** and opening that installed app. A normal Safari tab remains usable for the Control UI, but the Notifications page reports the install requirement and does not attempt to dereference an unavailable `PushManager`.

**Send test** asks the Gateway to push a test message to every registered browser subscription. A successful request means the transport accepted the send, not that an OS banner appeared. Approval requests are targeted to authorized device bindings. **Unsubscribe** removes the current browser's endpoint from the Gateway only when its paired device and user profile still own the subscription, then unsubscribes locally. Reconnecting under another profile can transfer the browser subscription only with its existing subscription keys; knowing an endpoint alone cannot change its owner or remove it.

The Gateway sends Web Push directly to the browser vendor's push service. This works with a self-hosted Gateway and does not use the OpenClaw-hosted iOS relay.

### Use more than one Gateway on one phone

The recommended self-hosted setup is one Control UI service-worker scope per Gateway. Open or install each Gateway's PWA from its own HTTPS origin or base path, enable notifications there, and reconnect once after upgrades. Each scope then owns an independent browser subscription, and approval links return to the Gateway that created them.

A single installed PWA can also switch among remote Gateways, but every Gateway behind that PWA must use the same VAPID keypair and set `gateway.publicOrigin` to its browser-reachable HTTPS origin. Reconnect the PWA to each Gateway once so each one registers the shared browser subscription and current device/profile binding. Approval notification links stay inside the installed PWA's scope and carry the owning Gateway URL in their fragment; the Control UI removes the fragment before authentication and uses the normal remote-Gateway handoff.

The browser Push API permits only one application-server key per service-worker registration. If a PWA subscription belongs to a different VAPID key, OpenClaw removes the unusable row from the current Gateway and shows **Unavailable** and **Not subscribed**, with an error explaining the mismatch. To switch that PWA scope to the current Gateway, select **Unsubscribe**, then **Enable notifications** and **Send test**. Unsubscribing deactivates the shared browser subscription for every Gateway registered through that scope; after re-enabling, reconnect to each Gateway once.

Sharing a private VAPID key and browser endpoint makes those Gateways one push-signing trust domain. Use that layout only for Gateways you trust equally. Configure VAPID values through each Gateway process's secure environment or secret manager; do not place private keys in URLs or command arguments.

## Enable notifications in a native desktop app

Native Gateway notifications never prompt on the first chat send or when an incoming event arrives. Enable them explicitly in Settings. If the operating system has already granted OpenClaw notification permission, the app can subscribe without prompting again.

1. Connect the OpenClaw desktop app to the Gateway.
2. Open **Settings → Notifications** and select **Enable notifications**.
3. Allow notifications if the operating system asks.
4. Choose account defaults or device overrides, then select **Send test**.

On macOS, a denied permission cannot be re-prompted: select **Open System Settings**, allow notifications for OpenClaw there, and switch back. Settings rechecks permission when the app regains focus. Permission belongs to the operating system, not to Gateway config. Disabling notifications in OpenClaw changes the current device preference without revoking OS permission; enabling again restores that device preference.

A native test is sent through the Gateway to the exact app connection that requested it. **Test notification requested** confirms Gateway dispatch, not OS presentation. Platform delivery failures appear separately in Settings and do not change the reported permission. Focus modes, notification settings, and platform support can still prevent a banner.

Native notification clicks use the Gateway connection that owns the notification. They open the matching approval, question, chat, task, or automation page. The macOS app routes clicks to the corresponding primary or saved-profile Dashboard. Tauri keeps clicks inside its captured Dashboard origin and base path. JavaScript cannot supply a different Gateway, arbitrary notification text, or an external click destination through the Settings bridge.

Tauri native notifications currently follow the app's configured primary Gateway. Secondary windows opened through Gateway discovery do not expose native notification controls; use the main Dashboard to manage them. The macOS app also supports its saved Gateway profiles.

On reconnect, the Gateway may replay up to 32 recent, still-pending approvals without alerting again. The macOS app can place these quietly in Notification Center; Tauri skips passive presentation because its platform backends cannot all guarantee a quiet notification. The Dashboard retains the full pending approval list. Native apps remove their owned notifications on terminal events, expiry, disconnect, or identity changes where the platform supports removal; an old item never retains authority to navigate after its connection is retired.

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
