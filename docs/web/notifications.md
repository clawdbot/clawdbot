---
summary: "Enable and test browser or macOS notifications from the Control UI"
title: "Notifications"
read_when:
  - Enabling notifications from Settings
  - Troubleshooting browser or macOS notification permission
  - Comparing Control UI notifications with mobile push
---

OpenClaw can ping you when something needs your attention — in the browser that runs the Control UI, or through native macOS notifications when you use the OpenClaw macOS app. Your first chat send may request permission automatically; **Settings → Notifications** remains the place to enable or repair the current device, check its status, and send yourself a test.

This page covers those two surfaces. It does not control channel reaction notifications, Android notification forwarding, or iOS background push — the mobile apps register for push through their own node paths; see [iOS](/platforms/ios) and [Nodes](/nodes).

## Which surface you get

What the Notifications page controls depends on where you opened it:

| Where Settings is open                            | Transport                                          | What you can do                                                               |
| ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Supported web browser or installed Control UI PWA | Browser Push API via the Control UI service worker | Grant permission, subscribe or unsubscribe this browser, send a test          |
| OpenClaw macOS app                                | Native macOS notifications                         | Grant app permission, jump to System Settings when blocked, send a local test |
| Browser without Push API support                  | None                                               | Status only; enable and test stay unavailable                                 |

The macOS app deliberately uses the native permission flow instead of browser push — that is the notification system your Mac already respects.

## Enable browser notifications

The Control UI asks for notification permission automatically the first time you send a chat message, once per browser and origin. **Settings → Notifications** remains the manual path for enabling or repairing notifications, including after you deny the automatic prompt.

1. Open the Control UI in a browser that supports service workers, `PushManager`, and notifications.
2. Make sure the Control UI is connected to the Gateway.
3. Open **Settings → Notifications** and select **Enable notifications**.
4. Allow notifications when the browser asks.
5. Select **Send test** — a test notification should arrive within a few seconds.

Behind the scenes, enabling creates a push subscription in this browser and registers its endpoint and keys with the Gateway. The Gateway keeps browser subscriptions and its VAPID signing key in `state/openclaw.sqlite` — there is no `openclaw.json` key to edit. When the Control UI reconnects, existing subscriptions are reconciled with the Gateway automatically.

**Send test** asks the Gateway to push a test message to every registered browser subscription. **Unsubscribe** removes the current browser's endpoint from the Gateway, then unsubscribes locally.

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

## Related

- [Control UI PWA and Web Push](/web/control-ui#pwa-install-and-web-push)
- [iOS push delivery](/platforms/ios)
- [Node notification commands](/nodes)
