---
summary: "Microsoft Teams meetings plugin: join work or consumer meetings as a Chrome browser guest"
read_when:
  - You want an OpenClaw agent to join a Microsoft Teams meeting
  - You are configuring Chrome, BlackHole, or SoX for Teams meeting talk-back
title: "Microsoft Teams meetings plugin"
---

The `teams-meetings` plugin joins Microsoft Teams links as a guest in the OpenClaw Chrome profile. It accepts work links under `teams.microsoft.com/l/meetup-join/...` and consumer links under `teams.live.com/meet/...`. It does not create meetings, dial in, call Microsoft Graph, or record meetings.

## Setup

Talk-back uses the same local audio prerequisites as the [Google Meet plugin](/plugins/google-meet): macOS, the `BlackHole 2ch` virtual audio device, and SoX.

```bash
brew install blackhole-2ch sox
sudo reboot
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

Enable the plugin, then check setup:

```json5
{
  plugins: {
    entries: {
      "teams-meetings": {
        enabled: true,
        config: {
          defaultMode: "agent",
          chrome: { guestName: "OpenClaw Agent" },
        },
      },
    },
  },
}
```

```bash
openclaw teamsmeetings setup
openclaw teamsmeetings join 'https://teams.microsoft.com/l/meetup-join/...'
```

Use `chromeNode.node` to run Chrome, BlackHole, and SoX on a paired macOS node. The node must allow `teamsmeetings.chrome` and `browser.proxy`.

## Modes

| Mode         | Behavior                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| `agent`      | Realtime transcription consults the configured OpenClaw agent; TTS replies. |
| `bidi`       | A realtime voice model listens and replies directly.                        |
| `transcribe` | Observe-only join. Caption snapshots are currently empty.                   |

Caption scraping is disabled by default. Teams live-caption DOM selectors need validation across live work and consumer tenants before the plugin can promise transcript capture.

## Guest join limits

The browser adapter dismisses the app interstitial, fills the guest name, turns the camera off, configures the microphone for the selected mode, and clicks the join button. In-call state uses the hang-up control; lobby, tenant sign-in, and device-permission states return explicit manual-action reasons.

Teams tenant policy can require sign-in, email verification, or organizer admission. Complete that step in the OpenClaw Chrome profile, then retry status or speech. The plugin does not bypass tenant policy.

All in-page selectors are best-effort pending live validation. Work and consumer Teams UI changes can require selector updates. Validate these flows before unattended use: app interstitial, guest-name entry, prejoin microphone/camera toggles, join, lobby admission, tenant sign-in/email verification, media permissions, in-call detection, BlackHole output routing, leave confirmation, and consumer-meeting behavior.

## Tool and gateway surface

The `teams_meetings` agent tool supports `join`, `leave`, `status`, `transcript`, and `speak`. Gateway methods use the `teamsmeetings.*` prefix. The node command is `teamsmeetings.chrome`.
