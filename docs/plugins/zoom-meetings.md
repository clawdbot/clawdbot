---
summary: "Zoom meetings plugin: join meetings as a Chrome browser guest"
read_when:
  - You want an OpenClaw agent to join a Zoom meeting
  - You are configuring Chrome, BlackHole, or SoX for Zoom meeting talk-back
title: "Zoom meetings plugin"
---

The `zoom-meetings` plugin joins Zoom meeting links as a guest through the Zoom Web App in the OpenClaw Chrome profile. It accepts meeting links under `zoom.us/j/...` and account subdomains such as `example.zoom.us/j/...`. It does not create meetings, dial in, use the Zoom Meeting SDK, or record meetings.

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
      "zoom-meetings": {
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
openclaw zoommeetings setup
openclaw zoommeetings join 'https://zoom.us/j/1234567890'
```

Use `chromeNode.node` to run Chrome, BlackHole, and SoX on a paired macOS node. The node must allow `zoommeetings.chrome` and `browser.proxy`.

## Modes

| Mode         | Behavior                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| `agent`      | Realtime transcription consults the configured OpenClaw agent; TTS replies. |
| `bidi`       | A realtime voice model listens and replies directly.                        |
| `transcribe` | Observe-only join with live-caption transcript snapshots.                   |

Transcribe mode enables Zoom live captions after admission and captures the bounded caption display. The `transcript` action returns the caption buffer for the active OpenClaw meeting session.

## Guest join limits

The browser adapter chooses **Join from browser**, fills the guest name, turns the camera off, configures the microphone for the selected mode, and clicks **Join**. Zoom Web App runs under `app.zoom.us`; the plugin grants that origin microphone and speaker-selection permissions before navigation. In-call state uses Zoom's Leave control. Lobby, sign-in, passcode, CAPTCHA, and device-permission states return explicit manual-action reasons.

Zoom host and account policy can disable browser join, require authentication or email verification, show a CAPTCHA, or require host admission. Complete that step in the OpenClaw Chrome profile, then retry status or speech. The plugin does not bypass Zoom policy.

The Zoom Web App has been live-validated with an official Zoom test meeting for the app interstitial, iframe guest-name entry, prejoin microphone and camera controls, join, browser and macOS media permissions, in-call detection, live-caption enablement, and host-ended detection. Lobby and authentication states depend on host policy and retain text fallbacks when no stable DOM identifier is available.

## Tool and gateway surface

The `zoom_meetings` agent tool supports `join`, `leave`, `status`, `transcript`, and `speak`. Gateway methods use the `zoommeetings.*` prefix. The node command is `zoommeetings.chrome`.

## Related

- [Meeting plugins overview](/plugins/meeting-plugins)
