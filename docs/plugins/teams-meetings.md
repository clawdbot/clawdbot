---
summary: "Microsoft Teams meetings plugin: join work or consumer meetings as a Chrome browser guest"
read_when:
  - You want an OpenClaw agent to join a Microsoft Teams meeting
  - You are configuring Chrome, BlackHole, or SoX for Teams meeting talk-back
title: "Microsoft Teams meetings plugin"
---

The `teams-meetings` plugin joins Microsoft Teams links as a guest in the OpenClaw Chrome profile. It accepts work links under `teams.microsoft.com/l/meetup-join/...` and consumer links under `teams.live.com/meet/...`. It does not create meetings, dial in, call Microsoft Graph, or capture audio/video recordings.

## Setup

Talk-back uses the same local audio prerequisites as the [Google Meet plugin](/plugins/google-meet): macOS, the `BlackHole 2ch` virtual audio device, and SoX.

```bash
brew install blackhole-2ch sox
sudo reboot
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

The plugin is included and enabled by default. Add an entry only to customize it, then check setup:

```json5
{
  plugins: {
    entries: {
      "teams-meetings": {
        config: {
          defaultMode: "agent",
          chrome: { guestName: "OpenClaw Agent" },
        },
      },
    },
  },
}
```

Run `openclaw plugins disable teams-meetings` if you do not want the plugin active.

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
| `transcribe` | Observe-only join with live-caption transcript snapshots.                   |

Teams live captions are enabled after admission in every mode so OpenClaw can
persist speaker-attributed notes. The `transcript` action still returns the
bounded live buffer only for `transcribe` sessions. On leave, OpenClaw stores
the durable transcript and derived summary in the shared state database; list
or export them with [`openclaw transcripts`](/cli/transcripts).

Automatic notes are enabled by default. Set `transcripts.enabled: false` to
disable durable notes globally; explicit `transcribe` mode still exposes only
its bounded live tail.

## Guest join limits

The browser adapter dismisses the app interstitial, fills the guest name, turns the camera off, configures the microphone for the selected mode, and clicks the join button. In-call state uses the hang-up control; lobby, tenant sign-in, and device-permission states return explicit manual-action reasons. Consumer meeting launcher redirects and the `BlackHole 2ch (Virtual)` labels shown by Chrome are supported.

Teams tenant policy can require sign-in, email verification, or organizer admission. Complete that step in the OpenClaw Chrome profile, then retry status or speech. The plugin does not bypass tenant policy.

The consumer Teams web client has been live-validated for the app interstitial, guest-name entry, prejoin microphone/camera toggles, join, lobby admission, media permissions, in-call detection, live captions, BlackHole input/output routing, leave, and post-call detection. Work tenants can impose different sign-in, email-verification, admission, and leave-confirmation policy; complete any reported manual action in the OpenClaw Chrome profile.

## Tool and gateway surface

The `teams_meetings` agent tool supports `join`, `leave`, `status`, `transcript`, and `speak`. Gateway methods use the `teamsmeetings.*` prefix. The node command is `teamsmeetings.chrome`.

## Related

- [Meeting plugins overview](/plugins/meeting-plugins)
- [Microsoft Teams channel](/channels/msteams)
