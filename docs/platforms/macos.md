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
3. Local mode: wait while the app installs its user-space runtime and Gateway.
4. Establish inference with a live model check. After it passes, Crestodian
   handles the remaining setup.
5. Complete the macOS permission checklist and send the onboarding test message.

If the app reaches an existing Gateway whose default agent has a configured
model, it treats that Gateway as already set up, skips provider onboarding and
Crestodian, and opens the dashboard. If the Gateway cannot connect or its
default agent has no model, inference onboarding remains available for
recovery.

For the CLI/Gateway setup path, use [Getting started](/start/getting-started).
For permission recovery, use [macOS permissions](/platforms/mac/permissions).

## Updates

The dashboard update card updates the signed macOS app through Sparkle first.
After the app relaunches, it automatically updates and restarts the matching
app-managed local Gateway. Homebrew and other user-managed CLI installs keep
the normal Gateway update flow (the card runs the Gateway update directly),
and the automatic repair never downgrades a newer Gateway or overrides an
`extended-stable` channel pin.

Sparkle follows the Gateway's `update.channel` setting. `beta` and `dev` opt in
to beta app builds; `stable`, `extended-stable`, and missing or unknown values
stay on stable app builds.

## Open dashboard links

In the macOS app's embedded dashboard, clicking an external web link opens it in a resizable browser sidebar. Each link opens in its own tab; clicking the same link again reuses its existing tab. Drag tabs to reorder them, close them with the tab close button or a middle-click, and right-click a tab for **Open in Default Browser**, **Copy Link**, **Reload**, **Close Tab**, and **Close Other Tabs**. The window's titlebar back/forward controls and trackpad swipes navigate dashboard history; the sidebar's own back/forward controls navigate the active tab's history. The sidebar also has reload, open-in-default-browser, and close controls, and it remembers its width.

Right-click an external link to choose **Open in Sidebar**, **Open in Default Browser**, or **Copy Link**. Modified clicks and user-activated new-window links from the dashboard continue to open in the default browser; new-window links inside the sidebar open as new sidebar tabs. Regular browser-hosted Control UI pages keep the browser's normal link and context-menu behavior.

## Choose a Gateway mode

| Mode   | Use it when                                                                    | Detail page                                        |
| ------ | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Local  | This Mac should run the Gateway and keep it alive with launchd.                | [Gateway on macOS](/platforms/mac/bundled-gateway) |
| Remote | Another host runs the Gateway; this Mac controls it over SSH, LAN, or Tailnet. | [Remote control](/platforms/mac/remote)            |

Local mode needs an installed `openclaw` CLI. On a fresh Mac, the app installs
the matching CLI and runtime automatically before starting the Gateway wizard.
See [Gateway on macOS](/platforms/mac/bundled-gateway) for manual recovery.

## What the app owns

- Menu bar status, notifications, health, and WebChat.
- macOS permission prompts for screen, microphone, speech, automation, and accessibility.
- Local node tools: Canvas, camera/screen capture, notifications, and `system.run`.
- Exec approval prompts for Mac-hosted commands.
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
