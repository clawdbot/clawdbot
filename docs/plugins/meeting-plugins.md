---
summary: "Choose and configure Google Meet, Microsoft Teams, or Zoom meeting participation"
read_when:
  - You want an OpenClaw agent to join a video meeting
  - You are choosing between the Google Meet, Microsoft Teams meetings, and Zoom meetings plugins
  - You need the shared Chrome, BlackHole, SoX, or meeting-mode setup
title: "Meeting plugins"
---

OpenClaw has separate plugins for Google Meet, Microsoft Teams meetings, and Zoom. All three can join through Chrome, use the same participation modes, and run Chrome either on the Gateway host or on a paired node. Their platform URLs, installation model, and extra capabilities differ.

These plugins participate in meetings. They are separate from messaging channels such as the [Microsoft Teams channel](/channels/msteams) and from the [Voice call plugin](/plugins/voice-call).

## Choose a plugin

| Platform        | Plugin                                      | Accepted meeting links                                                                                      | Installation                             | Participation paths                                      | Platform-specific capabilities                                                                                |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Google Meet     | [`google-meet`](/plugins/google-meet)       | `meet.google.com/...`                                                                                       | Install from npm or ClawHub, then enable | Local Chrome, Chrome on a paired node, or Twilio dial-in | Can create meetings through the Meet API or a signed-in browser; can read supported Meet artifacts with OAuth |
| Microsoft Teams | [`teams-meetings`](/plugins/teams-meetings) | Work links under `teams.microsoft.com/l/meetup-join/...` and consumer links under `teams.live.com/meet/...` | Included; enable it                      | Local Chrome or Chrome on a paired node                  | Guest join for work and consumer meetings                                                                     |
| Zoom            | [`zoom-meetings`](/plugins/zoom-meetings)   | `zoom.us/j/...` and account subdomains such as `example.zoom.us/j/...`                                      | Included; enable it                      | Local Chrome or Chrome on a paired node                  | Guest join through the Zoom Web App                                                                           |

Choose Google Meet when you need meeting creation, Google API artifacts, or a Twilio phone path. Choose Teams or Zoom for direct browser guest participation on those platforms. The Teams and Zoom plugins do not create meetings, dial in, call the vendor API, or record meetings.

## Choose a mode

The three plugins share the same modes:

| Mode         | Behavior                                                                                              | Audio requirements                                      |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent`      | Realtime transcription goes to the configured OpenClaw agent; regular OpenClaw TTS speaks the reply.  | Chrome talk-back requires the BlackHole and SoX bridge. |
| `bidi`       | A realtime voice model listens and replies directly.                                                  | Chrome talk-back requires the BlackHole and SoX bridge. |
| `transcribe` | Joins observe-only and exposes a bounded live-caption transcript when the platform provides captions. | No BlackHole or SoX talk-back bridge.                   |

Use `transcribe` when the agent only needs meeting text. Use `agent` for normal OpenClaw reasoning and tools. Use `bidi` when low-latency direct voice is more important than routing each turn through the regular agent.

Caption transcripts are session-scoped runtime data, not durable meeting recordings. Caption availability still depends on the meeting platform, account, language, and host policy. See the platform guide for its transcript limits and status fields.

## Prepare Chrome and audio

Chrome can run on the Gateway host or on a paired node. A remote Chrome node must allow `browser.proxy` plus the platform command:

| Plugin          | Node command           |
| --------------- | ---------------------- |
| Google Meet     | `googlemeet.chrome`    |
| Microsoft Teams | `teamsmeetings.chrome` |
| Zoom            | `zoommeetings.chrome`  |

For `agent` or `bidi` mode through Chrome, run Chrome on macOS and install the shared audio dependencies on that same host:

```bash
brew install blackhole-2ch sox
sudo reboot
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

The Gateway host still owns the OpenClaw agent and model credentials when Chrome runs on a paired node. Configure a realtime transcription provider and OpenClaw TTS for `agent` mode, or a realtime voice provider for `bidi` mode. The platform guides contain the provider and audio-command options.

## Enable the plugin

Install Google Meet before enabling it. Teams meetings and Zoom are included with OpenClaw and only need to be enabled:

```bash
# Google Meet only
openclaw plugins install npm:@openclaw/google-meet

# Enable only the meeting plugins you use
openclaw plugins enable google-meet
openclaw plugins enable teams-meetings
openclaw plugins enable zoom-meetings
```

Restart the Gateway if your plugin-management path does not restart it automatically. Then run the platform setup check before joining.

## Verify and join

| Platform        | Setup check                    | Join command                                                                  |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| Google Meet     | `openclaw googlemeet setup`    | `openclaw googlemeet join 'https://meet.google.com/abc-defg-hij'`             |
| Microsoft Teams | `openclaw teamsmeetings setup` | `openclaw teamsmeetings join 'https://teams.microsoft.com/l/meetup-join/...'` |
| Zoom            | `openclaw zoommeetings setup`  | `openclaw zoommeetings join 'https://zoom.us/j/1234567890'`                   |

Treat any failed setup check as a blocker for that transport and mode. For an observe-only smoke test, select `transcribe` mode and confirm that status reports an in-call session before expecting caption text.

## Handle platform policy prompts

Browser automation handles the normal guest-name, prejoin camera and microphone, join, in-call, and leave controls. It does not bypass platform or organizer policy.

- Google Meet may require Google sign-in, host admission, or a browser permission decision.
- Microsoft Teams may require tenant sign-in, email verification, or organizer admission.
- Zoom may require authentication, email verification, a passcode, CAPTCHA completion, or host admission; an account can also disable browser join.

When a join or status result reports `manualActionRequired`, complete the reported step in the same OpenClaw Chrome profile before retrying. Repeatedly opening new tabs does not resolve an account, tenant, lobby, or CAPTCHA gate.

Only join meetings where the operator is authorized to add an agent. Tell participants when local policy or consent rules require disclosure of automated participation, transcription, or synthesized speech.

## Discord voice chat

[Discord voice channels](/channels/discord#voice-channels) provide native, audio-only realtime conversation without browser meeting automation. OpenClaw can join a voice channel, listen, route turns through an OpenClaw agent or realtime voice model, and speak replies. It does not send or receive camera video or screen sharing, even when people use video in the same Discord channel, so Discord voice is a related live-conversation surface rather than a fourth browser meeting plugin.

## Platform guides

- [Google Meet plugin](/plugins/google-meet)
- [Microsoft Teams meetings plugin](/plugins/teams-meetings)
- [Zoom meetings plugin](/plugins/zoom-meetings)
- [Manage plugins](/plugins/manage-plugins)
- [Browser control](/tools/browser)
