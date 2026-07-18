# Wear OS behavior contract

The watch is a paired-phone companion. It never asks for, receives, or stores Gateway credentials, TLS pins, or device-signing identity.

- Given a reachable paired phone and connected Gateway, opening the watch app lists recent non-global sessions. Selecting one shows the latest bounded text transcript.
- Given multiple reachable phones, RPC responses and events are accepted only from the currently preferred phone. A preferred-phone change reloads canonical state before replaying live events.
- Given an unavailable phone or offline Gateway, the app shows one clear recovery state and a refresh action. It does not fall back to direct Gateway access.
- Given a paired phone that advertises agent and Gateway controls, the watch can select the phone's active agent and connect or disconnect its Gateway. Older phones omit those controls and continue serving the original companion surface.
- Given a selected session, text input or Wear speech recognition sends one idempotent, non-delivering chat request through the phone. An ambiguous retry reuses its request identity. An active run can be aborted.
- Given a selected session and microphone permission, Real-Time Talk streams bounded PCM audio over one temporary bidirectional Data Layer channel to that session on the selected phone. One watch owns the relay at a time. Stopping Talk, changing phones, losing the Gateway, or losing the channel closes capture and playback without exposing Gateway credentials to the watch.
- Given ordered chat events, the transcript shows the phone's bounded canonical stream projection. Given a missing sequence or changed phone-process epoch, the app discards uncertain stream state and reloads canonical history. Events racing that snapshot replay only when they share its epoch and are newer than its response watermark, and stream text reconciles without duplication or a reload loop. A legacy phone without response watermarks lets the next event establish its live baseline.
- Given a final assistant message while the app is not visible and notifications are allowed, the watch shows one local-only notification with direct reply. Phone-process recreation rediscovers the reachable watch before delivery. If the preferred phone changes before a notification reply, recovery opens the app to reload the session instead of retrying the stale phone.
- Given Android 13 or newer without notification permission, Controls offers both an explicit request action and direct access to the watch's app-notification settings. Granting or revoking permission outside the app is reflected when the app resumes, and denying it leaves the rest of the companion usable.
- Given a theme or automatic-speech selection, the watch persists that local UI preference without sending it to the phone or Gateway.
- Given the OpenClaw Tile, tapping anywhere opens the watch app. Tile rendering performs no phone or network work and persists no cache.
