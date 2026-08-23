---
summary: "Microsoft Teams meetings plugin: join work or consumer meetings as a Chrome browser guest"
doc-schema-version: 1
read_when:
  - You want an OpenClaw agent to join a Microsoft Teams meeting
  - You need Teams-specific guest policy or manual-action guidance
title: "Microsoft Teams meetings plugin"
---

The `teams-meetings` plugin joins work links under
`teams.microsoft.com/l/meetup-join/...` and consumer links under
`teams.live.com/meet/...` as a guest in the OpenClaw Chrome profile. It does not
create meetings, dial in, call Microsoft Graph, or capture audio/video
recordings.

Use [Meeting plugins](/plugins/meeting-plugins) for shared installation, modes,
Chrome and virtual-audio setup, transcripts, remote-node requirements, and
verification.

## Handle Teams policy and manual actions

The browser adapter dismisses the app interstitial, fills the guest name, turns
the camera off, configures the microphone for the selected mode, and clicks the
join button. It recognizes the consumer launcher and Chrome's
`BlackHole 2ch (Virtual)` labels. In-call state uses the hang-up control.

Tenant policy may require sign-in, email verification, organizer admission, or
a browser device-permission decision. The plugin reports these as
`manualAction`; complete the requested step in the same OpenClaw Chrome profile,
then retry status or speech. It does not bypass tenant policy.

The consumer web client has been live-validated through the interstitial,
guest-name entry, microphone/camera toggles, lobby admission, media permissions,
in-call detection, live captions, BlackHole routing, leave, and post-call
detection. Work tenants can impose additional admission or leave-confirmation
policy.

## Tool and Gateway surface

The `teams_meetings` tool supports `join`, `leave`, `status`, `transcript`, and
`speak`. Gateway methods use `teamsmeetings.*`; the node command is
`teamsmeetings.chrome`.

## Related

- [Meeting plugins](/plugins/meeting-plugins)
- [Microsoft Teams channel](/channels/msteams)
