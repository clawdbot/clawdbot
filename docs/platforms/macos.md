---
summary: "Install and use the OpenClaw macOS menu bar app"
read_when:
  - Installing the macOS app
  - Deciding between local and remote Gateway mode on macOS
  - Looking for macOS app release downloads
title: "macOS app"
---

The macOS app is the OpenClaw **menu bar companion**: native tray UI, macOS
permission prompts, notifications, WebChat, voice input, Canvas, and
Mac-hosted node tools such as `system.run`.

Only need the CLI and Gateway? Start with [Getting started](/start/getting-started).

## Download

Get macOS app builds from [OpenClaw GitHub releases](https://github.com/openclaw/openclaw/releases).
When a release ships macOS app assets, look for:

- `OpenClaw-<version>.dmg` (preferred)
- `OpenClaw-<version>.zip`

Some releases only ship CLI, evidence, or Windows assets. If the newest release
has no macOS app asset, use the newest one that does, or build from source with
[macOS dev setup](/platforms/mac/dev-setup).

## First run

1. Install and launch **OpenClaw.app**.
2. Pick **This Mac** for a local Gateway, or connect to a remote Gateway.
3. Wait while the app installs the matching CLI runtime. In local mode it also
   installs and starts the Gateway.
4. Establish inference with a live model check. After it passes, OpenClaw
   handles the remaining setup.
5. Complete the macOS permission checklist and send the onboarding test message.

If the app reaches an existing Gateway whose default agent has a configured
model, it treats that Gateway as already set up, skips provider onboarding and
OpenClaw, and opens the dashboard. If the Gateway cannot connect or its
default agent has no model, inference onboarding remains available for
recovery.

For the CLI/Gateway setup path, use [Getting started](/start/getting-started).
For permission recovery, use [macOS permissions](/platforms/mac/permissions).

## Updates

The dashboard update card names what the app will update:

- **Update Mac app + Gateway** means the signed app owns the local launchd
  Gateway. Sparkle updates the app first; after relaunch, the app automatically
  updates and restarts its Gateway at the matching version, then verifies the
  connection.
- **Update Gateway** means the app is connected to a remote Gateway, a manually
  managed local Gateway, or another install the app does not own. The button
  runs that Gateway's normal update flow instead of changing the Mac app.

A failed coordinated update stays in its setup-style window with retry,
[update guide](/install/updating), and Discord actions. Automatic repair never
downgrades a newer Gateway or overrides an `extended-stable` channel pin.

After a successful update, the app finds the most recently human-used,
top-level direct session and gives that agent a one-time update event. Heartbeat
and cron activity do not affect this choice. The agent can then welcome you back
from the conversation you were most likely using. In remote mode, the app
updates only the local Mac node runtime and skips the notification when the
remote Gateway is older than the app.

Sparkle follows the Gateway's `update.channel` setting. `beta` and `dev` opt in
to beta app builds; `stable`, `extended-stable`, and missing or unknown values
stay on stable app builds.

## Open dashboard links

In the macOS app's embedded dashboard, clicking an external web link opens it in a resizable browser sidebar at half the window width while keeping the dashboard navigation visible. Drag the divider to choose another width; the app remembers it. Each link opens in its own tab, the tab strip appears when multiple pages are open, and clicking the same link again reuses its existing tab. Drag tabs to reorder them, close them with the tab close button or a middle-click, and right-click a tab for **Open in Default Browser**, **Copy Link**, **Reload**, **Close Tab**, and **Close Other Tabs**. The window's titlebar back/forward controls and trackpad swipes navigate dashboard history; the sidebar's own back/forward controls navigate the active tab's history. The sidebar also has reload, open-in-default-browser, and close controls.

The titlebar controls follow the app sidebar: while it is expanded, back/forward sit at its right edge next to the sidebar toggle; while it is collapsed, they make way for a search button (opens the command palette) and a new-session button.

Right-click an external link to choose **Open in Sidebar**, **Open in Default Browser**, or **Copy Link**. Modified clicks and user-activated new-window links from the dashboard continue to open in the default browser; new-window links inside the sidebar open as new sidebar tabs. Regular browser-hosted Control UI pages keep the browser's normal link and context-menu behavior.

## Import browser logins

The first time the browser sidebar opens while the app runs against a local Gateway, the dashboard shows a dismissible banner when a Chrome-family profile with cookies exists on the Mac. The banner offers to copy those cookies into an isolated managed profile that agents use for browsing. Choose a profile from its **Import** control (Touch ID may be required); progress and the imported-cookie count appear inline, and only cookies are copied — passwords never leave the source browser. Dismissing the banner records the choice; **Settings → General → Browser login → Import…** re-offers it at any time. See [Browser](/cli/browser) for the underlying import flow and the `browser.allowSystemProfileImport` gate.

## Choose a Gateway mode

| Mode   | Use it when                                                                    | Detail page                                        |
| ------ | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Local  | This Mac should run the Gateway and keep it alive with launchd.                | [Gateway on macOS](/platforms/mac/bundled-gateway) |
| Remote | Another host runs the Gateway; this Mac controls it over SSH, LAN, or Tailnet. | [Remote control](/platforms/mac/remote)            |

Both modes need an installed `openclaw` CLI because the app reuses its node-host
runtime. On a fresh Mac, the app installs the matching CLI automatically; local
mode then starts the Gateway wizard, while remote mode connects to the selected
Gateway without starting a second local Gateway.
See [Gateway on macOS](/platforms/mac/bundled-gateway) for manual recovery.

## What the app owns

- Menu bar status, notifications, health, and WebChat.
- macOS permission prompts for screen, microphone, speech, automation, and accessibility.
- One Mac node that combines native Canvas, camera/screen capture, notifications,
  location, and computer control with the CLI node host's system, browser,
  plugin, skill, and MCP commands.
- Exec approval prompts for Mac-hosted commands.
- App-context execution for approved shell commands, preserving the app's macOS
  permission attribution while the CLI runtime owns shared node policy.
- Remote-mode SSH tunnels or direct Gateway connections.

The app does **not** replace the Gateway or general CLI docs. Gateway
configuration, providers, plugins, channels, tools, and security live in their
own docs.

## macOS detail pages

| Task                                     | Read                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Install or debug the CLI/Gateway service | [Gateway on macOS](/platforms/mac/bundled-gateway)                                          |
| Keep state out of cloud-synced folders   | [Gateway on macOS](/platforms/mac/bundled-gateway#state-directory-on-macos)                 |
| Debug app discovery and connectivity     | [Gateway on macOS](/platforms/mac/bundled-gateway#debug-app-connectivity)                   |
| Understand launchd behavior              | [Gateway lifecycle](/platforms/mac/child-process)                                           |
| Fix permissions or signing/TCC issues    | [macOS permissions](/platforms/mac/permissions)                                             |
| Detect the Mac you most recently used    | [Active computer presence](/nodes/presence)                                                 |
| Connect to a remote Gateway              | [Remote control](/platforms/mac/remote)                                                     |
| Read menu bar status and health checks   | [Menu bar](/platforms/mac/menu-bar), [Health checks](/platforms/mac/health)                 |
| Use the embedded chat UI                 | [WebChat](/platforms/mac/webchat)                                                           |
| Use voice wake or push-to-talk           | [Voice wake](/platforms/mac/voicewake)                                                      |
| Use Canvas and Canvas deep links         | [Canvas](/platforms/mac/canvas)                                                             |
| Host PeekabooBridge for UI automation    | [Peekaboo bridge](/platforms/mac/peekaboo)                                                  |
| Configure command approvals              | [Exec approvals](/tools/exec-approvals), [advanced details](/tools/exec-approvals-advanced) |
| Inspect Mac node commands and app IPC    | [macOS IPC](/platforms/mac/xpc)                                                             |
| Capture logs                             | [macOS logging](/platforms/mac/logging)                                                     |
| Build from source                        | [macOS dev setup](/platforms/mac/dev-setup)                                                 |

## Related

- [Platforms](/platforms)
- [Getting started](/start/getting-started)
- [Gateway](/gateway)
- [Exec approvals](/tools/exec-approvals)
