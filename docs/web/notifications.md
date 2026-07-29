---
summary: "Enable and test browser or macOS notifications from the Control UI"
title: "Notifications"
read_when:
  - Enabling notifications from Settings
  - Troubleshooting browser or macOS notification permission
  - Comparing Control UI notifications with mobile push
---

OpenClaw can notify the browser that runs the Control UI or the native macOS app that embeds it. Open **Settings → Notifications** to configure the current device and send a test. This page does not control channel reaction notifications, Android notification forwarding, or iOS background push.

## Choose your notification surface

| Where Settings is open                            | What OpenClaw uses                                 | What the page controls                                                                    |
| ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Supported web browser or installed Control UI PWA | Browser Push API and the Control UI service worker | Browser permission, the current browser subscription, unsubscribe, and test delivery      |
| OpenClaw macOS app                                | macOS native notifications                         | App permission, a shortcut to System Settings when blocked, and a local test notification |
| Browser without Push API support                  | No notification transport                          | Status only; enable and test actions stay unavailable                                     |

The macOS app intentionally shows the native permission flow instead of browser push. Mobile apps use their own node and push-registration paths; see [iOS](/platforms/ios) and [Nodes](/nodes).

## Enable browser notifications

1. Open the Control UI in a browser that supports service workers, `PushManager`, and notifications.
2. Connect the Control UI to the Gateway.
3. Open **Settings → Notifications** and select **Enable notifications**.
4. Allow notifications in the browser prompt.
5. Select **Send test**.

Enabling creates a browser push subscription and registers its endpoint and keys with the Gateway. The Gateway stores browser subscriptions and its VAPID signing key in `state/openclaw.sqlite`; Settings does not add an `openclaw.json` key. Existing browser subscriptions are reconciled with the Gateway after reconnect.

**Send test** asks the Gateway to send a Web Push test to its registered browser subscriptions. **Unsubscribe** removes the current browser endpoint from the Gateway and then unsubscribes it locally.

## Enable notifications in the macOS app

1. Open **Settings → Notifications** in the OpenClaw macOS app.
2. Select **Enable notifications** when the permission is **Not requested**.
3. Approve the macOS permission prompt.
4. Select **Send test** to post a local OpenClaw notification.

If permission is **Denied**, select **Open System Settings**, allow notifications for OpenClaw, and return to the app. The page refreshes permission state when the app regains focus. This permission belongs to macOS and is not stored in Gateway config.

## Troubleshooting

### Enable is unavailable

The browser either lacks the required Web Push APIs or the Control UI is disconnected from the Gateway. Try a current browser, confirm the Gateway connection, and reload the page.

### Browser permission is blocked

Allow notifications for the Control UI origin in the browser's site settings, then reload Settings. A denied browser permission cannot be reopened programmatically.

### Service worker is not ready

The Control UI waits up to 10 seconds for its service worker. If that times out after an update, hard-refresh the dashboard. If the old worker remains, clear site data for the dashboard origin and reconnect.

### Web Push asks for a Doctor migration

Run `openclaw doctor --fix` with the Gateway stopped. Web Push refuses to use the retired JSON stores until Doctor imports them into SQLite.

## Related

- [Control UI PWA and Web Push](/web/control-ui#pwa-install-and-web-push)
- [iOS push delivery](/platforms/ios)
- [Node notification commands](/nodes)
